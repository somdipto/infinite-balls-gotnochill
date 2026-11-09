import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { ConfigSchema } from '../skill/config.js';
import { PlatformSchema } from '../skill/platform.js';
import { Vault } from '../vault/store.js';
import { ApiProxy } from '../proxy/server.js';
import { QuotaGate, CapacityError, retryAfterMs } from '../proxy/quota.js';
import { Events } from '../skill/events.js';
import { atomicWrite } from '../skill/files.js';
import { upstreamFixture } from '../mock/upstream.js';

const TOKEN = 'local-test-proxy-token';
const recipe = (origin: string) => PlatformSchema.parse({ version: 1, name: 'local', authClass: 'existing-key', signupUrl: origin, keysUrl: origin, apiBaseUrl: `${origin}/v1`, defaultModel: 'free/fixture', freeModelIds: ['free/fixture'], requiredModelPrefix: 'free/', quotaProbe: null, limits: { resetUtcHour: 0 } });

async function fixture(maxWaitMs = 2500, maxBodyBytes = 10000, timeoutMs = 10000) {
  const workspace = await mkdtemp(join(tmpdir(), 'freeapi-proxy-'));
  const upstream = await upstreamFixture();
  const vault = new Vault(join(workspace, 'vault'), Buffer.alloc(32, 3));
  await vault.put('local', 'same-owner', upstream.acceptedKey);
  const events = new Events(join(workspace, 'events.jsonl'), false);
  const config = ConfigSchema.parse({ version: 1, proxy: { port: 0 }, request: { maxWaitMs, maxBodyBytes, timeoutMs } });
  const proxy = new ApiProxy({ platform: recipe(upstream.baseUrl), config, workspace, vault, token: TOKEN, events });
  return { workspace, upstream, vault, proxy, cleanup: async () => { await proxy.stop(); await upstream.close(); await rm(workspace, { recursive: true, force: true }); } };
}

async function complete(baseUrl: string, model = 'free/fixture') {
  return fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', cookie: 'private-browser-cookie', 'x-api-key': 'wrong-local-client-key' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }] }) });
}

test('model and local auth reject before egress; same-account keys hot-load with auth isolation', async () => {
  const f = await fixture();
  await f.proxy.start();
  try {
    assert.equal((await fetch(`${f.proxy.baseUrl}/models`)).status, 401);
    assert.equal((await complete(f.proxy.baseUrl, 'paid/fixture')).status, 400);
    assert.equal(f.upstream.observations.length, 0);
    const first = await complete(f.proxy.baseUrl); assert.equal(first.status, 200); await first.text();
    assert.equal(f.upstream.observations[0]?.authorization, `Bearer ${f.upstream.acceptedKey}`);
    assert.equal(f.upstream.observations[0]?.clientCookie, undefined);
    assert.equal(f.upstream.observations[0]?.clientKey, undefined);
    f.upstream.acceptedKey = 'sk-fixture-authorized-0002';
    await f.vault.put('local', 'same-owner', f.upstream.acceptedKey);
    const second = await complete(f.proxy.baseUrl); assert.equal(second.status, 200); await second.text();
    assert.equal(f.upstream.observations[1]?.authorization, `Bearer ${f.upstream.acceptedKey}`);
  } finally { await f.cleanup(); }
});

test('429 waits for Retry-After on the same key, then succeeds; no account cycling', async () => {
  const f = await fixture();
  f.upstream.responses.push({ status: 429, retryAfter: '1' });
  await f.proxy.start();
  try {
    const response = await complete(f.proxy.baseUrl); assert.equal(response.status, 200); await response.text();
    const [first, second] = f.upstream.observations;
    assert.ok(first && second);
    assert.ok(second.at - first.at >= 990, 'retry must honor the upstream one-second cooldown');
    assert.equal(first.authorization, second.authorization);
    assert.equal((await f.vault.inventory())[0]?.generation, 1);
  } finally { await f.cleanup(); }
});

test('402 replays only after a known reset within the wait budget; a long reset reports truthful capacity', async () => {
  const f = await fixture();
  await atomicWrite(join(f.workspace, 'proxy', 'local.quota.json'), JSON.stringify({ blockedUntil: 0, requests: [], remainingPercent: 100, resetsAt: Date.now() + 350 }));
  f.upstream.responses.push({ status: 402 });
  await f.proxy.start();
  try {
    const response = await complete(f.proxy.baseUrl); assert.equal(response.status, 200); await response.text();
    assert.equal(f.upstream.observations.length, 2);
    assert.equal(f.upstream.observations[0]?.authorization, f.upstream.observations[1]?.authorization);
  } finally { await f.cleanup(); }
  const g = await fixture(0);
  g.upstream.responses.push({ status: 402 });
  await g.proxy.start();
  try {
    const response = await complete(g.proxy.baseUrl);
    assert.equal(response.status, 503);
    const body: unknown = await response.json();
    assert.deepEqual(typeof body, 'object');
    assert.ok(JSON.stringify(body).includes('capacity_unavailable'));
    assert.ok(JSON.stringify(body).includes('402'));
    assert.ok(Number(response.headers.get('retry-after')) > 0);
    assert.equal(g.upstream.observations.length, 1);
  } finally { await g.cleanup(); }
});

test('request-size bound blocks egress; SSE arrives before upstream completion', async () => {
  const f = await fixture(1000, 160);
  await f.proxy.start();
  try {
    const oversized = await fetch(`${f.proxy.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'free/fixture', messages: ['x'.repeat(200)] }) });
    assert.equal(oversized.status, 413); await oversized.text();
    assert.equal(f.upstream.observations.length, 0);
    f.upstream.stream = true;
    const response = await complete(f.proxy.baseUrl);
    const reader = response.body?.getReader(); assert.ok(reader);
    const first = await reader.read();
    const firstText = new TextDecoder().decode(first.value);
    assert.ok(firstText.includes('first'));
    assert.ok(!firstText.includes('[DONE]'));
    const rest: string[] = [];
    for (;;) { const next = await reader.read(); if (next.done) break; rest.push(new TextDecoder().decode(next.value)); }
    assert.ok(rest.join('').includes('[DONE]'));
  } finally { await f.cleanup(); }
});

test('proactive threshold and persisted cooldown/RPM state survive gate restarts', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'freeapi-quota-'));
  try {
    const path = join(workspace, 'quota.json'); const platform = recipe('http://127.0.0.1:12345');
    const gate = new QuotaGate(path, platform, 25, new Events(join(workspace, 'events'), false));
    const reset = Date.now() + 10000;
    await gate.update(20, reset);
    const reopened = new QuotaGate(path, platform, 25, new Events(join(workspace, 'events'), false));
    await reopened.load();
    await assert.rejects(reopened.wait(Date.now(), new AbortController().signal), CapacityError);
    assert.equal(reopened.snapshot().blockedUntil, reset);
    assert.equal(retryAfterMs('2', 0), 2000);
    assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:00:03 GMT', 1000), 2000);
    assert.equal(retryAfterMs('not-a-delay', 0), undefined);
    platform.limits.requestsPerMinute = 1;
    await atomicWrite(path, JSON.stringify({ blockedUntil: 0, requests: [Date.now()] }));
    const rpm = new QuotaGate(path, platform, 25, new Events(join(workspace, 'events'), false));
    await rpm.load();
    await assert.rejects(rpm.wait(Date.now(), new AbortController().signal), CapacityError);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('total deadline closes a stalled request body without upstream traffic', { timeout: 5000 }, async () => {
  const f = await fixture(1000, 10000, 100);
  await f.proxy.start();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const request = httpRequest(`${f.proxy.baseUrl}/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  });
  request.once('error', error => {
    if ('code' in error && error.code === 'ECONNRESET') resolve();
    else reject(error);
  });
  request.once('response', response => {
    response.resume();
    response.once('end', () => response.statusCode === 504 ? resolve() : reject(new Error('Unexpected stalled-body response')));
  });
  try {
    request.write('{"model":');
    await promise;
    assert.equal(f.upstream.observations.length, 0);
  } finally { request.destroy(); await f.cleanup(); }
});
