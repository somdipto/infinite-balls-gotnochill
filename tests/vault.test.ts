import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault, maskSecret } from '../vault/store.js';
import { atomicWrite } from '../skill/files.js';
import { Events } from '../skill/events.js';

test('vault encrypts, persists, detects tampering and keeps one idempotent account', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freeapi-vault-'));
  try {
    const vault = new Vault(directory, Buffer.alloc(32, 42));
    const first = await vault.put('local', 'owner', 'sk-fixture-owner-secret-1111');
    const duplicate = await vault.put('local', 'owner', 'sk-fixture-owner-secret-1111');
    assert.equal(first.generation, 1);
    assert.deepEqual(duplicate, first);
    const reopened = new Vault(directory, Buffer.alloc(32, 42));
    assert.equal((await reopened.get('local'))?.apiKey, 'sk-fixture-owner-secret-1111');
    await assert.rejects(vault.put('local', 'different-owner', 'sk-fixture-other-secret-2222'), /One account per platform/);
    const replacement = await vault.put('local', 'owner', 'sk-fixture-owner-secret-3333');
    assert.equal(replacement.generation, 2);
    assert.equal((await reopened.get('local'))?.apiKey, 'sk-fixture-owner-secret-3333');
    const ciphertext = await readFile(join(directory, 'credentials.enc'), 'utf8');
    const inventory = await readFile(join(directory, 'credentials.md'), 'utf8');
    assert.ok(!ciphertext.includes('sk-fixture-owner-secret-3333'));
    assert.ok(!inventory.includes('sk-fixture-owner-secret-3333'));
    assert.ok(inventory.includes(maskSecret('sk-fixture-owner-secret-3333')));
    if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'credentials.enc'))).mode & 0o777, 0o600);
    const envelope: unknown = JSON.parse(ciphertext);
    assert.ok(envelope && typeof envelope === 'object' && 'tag' in envelope);
    await atomicWrite(join(directory, 'credentials.enc'), JSON.stringify({ ...envelope, tag: Buffer.alloc(16).toString('base64') }));
    await assert.rejects(reopened.get('local'), /authentication failed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('events redact registered secrets in messages, arrays and nested objects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freeapi-events-'));
  try {
    const file = join(directory, 'events.jsonl');
    const events = new Events(file, false);
    events.registerSecret('supersecret-provider-0123');
    await events.emit('fixture', 'failed', { message: 'upstream echoed supersecret-provider-0123', nested: { authorization: 'Bearer private-credential-9999', api_key: 'unregistered-private-api-1111', 'refresh-token': 'unregistered-refresh-2222', retry: ['supersecret-provider-0123'] } });
    const output = await readFile(file, 'utf8');
    assert.ok(!output.includes('supersecret-provider-0123'));
    assert.ok(!output.includes('Bearer private-credential-9999'));
    assert.ok(!output.includes('unregistered-private-api-1111'));
    assert.ok(!output.includes('unregistered-refresh-2222'));
    assert.ok(output.includes('supe…0123'));
    assert.equal(maskSecret('shortkey'), '[redacted]');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
