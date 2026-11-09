import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { Config } from '../skill/config.js';
import type { Platform } from '../skill/platform.js';
import type { Vault } from '../vault/store.js';
import type { Events } from '../skill/events.js';
import { CapacityError, QuotaGate } from './quota.js';
import { join } from 'node:path';

const RequestSchema = z.object({ model: z.string().optional() }).passthrough();
const HOP_HEADERS: Record<string, true> = { connection: true, 'keep-alive': true, 'proxy-authenticate': true, 'proxy-authorization': true, te: true, trailer: true, 'transfer-encoding': true, upgrade: true, host: true, 'content-length': true };
const POST_ROUTES: Record<string, true> = { '/v1/chat/completions': true, '/v1/messages': true, '/v1/responses': true, '/v1/embeddings': true };

interface Waiter { resolve: (release: () => void) => void; reject: (error: Error) => void; signal: AbortSignal; abort: () => void }
class RequestGate {
  private active = 0;
  private readonly queue: Waiter[] = [];
  constructor(private readonly limit: number, private readonly maxQueued: number) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active < this.limit) { this.active++; return () => this.release(); }
    if (this.queue.length >= this.maxQueued) throw new CapacityError(Date.now() + 1000);
    const { promise, resolve, reject } = Promise.withResolvers<() => void>();
    const waiter: Waiter = { resolve, reject, signal, abort: () => {
      const index = this.queue.indexOf(waiter);
      if (index >= 0) this.queue.splice(index, 1);
      reject(new Error('Request aborted while queued'));
    } };
    this.queue.push(waiter);
    signal.addEventListener('abort', waiter.abort, { once: true });
    return promise;
  }

  private release(): void {
    const waiter = this.queue.shift();
    if (waiter) {
      waiter.signal.removeEventListener('abort', waiter.abort);
      waiter.resolve(() => this.release());
    } else this.active--;
  }
}

export interface ProxyOptions { platform: Platform; config: Config; workspace: string; vault: Vault; token: string; events: Events }
export class ApiProxy {
  private readonly server: Server;
  private readonly quota: QuotaGate;
  private readonly requests: RequestGate;
  private readonly controllers = new Set<AbortController>();
  private probeTask?: Promise<void>;
  private port = 0;
  private stopped = false;
  constructor(private readonly options: ProxyOptions) {
    this.server = createServer((request, response) => { void this.handle(request, response); });
    this.quota = new QuotaGate(join(options.workspace, 'proxy', `${options.platform.name}.quota.json`), options.platform, options.config.thresholdRemainingPercent, options.events);
    this.requests = new RequestGate(options.config.request.concurrency, options.config.request.maxQueuedRequests);
    this.server.headersTimeout = options.config.request.timeoutMs;
    this.server.requestTimeout = options.config.request.timeoutMs;
  }

  get baseUrl(): string { return `http://127.0.0.1:${this.port}/v1`; }

  async start(): Promise<void> {
    await this.quota.load();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.server.once('error', reject);
    this.server.listen(this.options.config.proxy.port, '127.0.0.1', () => { this.server.removeListener('error', reject); resolve(); });
    await promise;
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Proxy did not bind a TCP port');
    this.port = address.port;
    this.probeTask = this.probeLoop();
    await this.options.events.emit('proxy', 'listening', { baseUrl: this.baseUrl, platform: this.options.platform.name });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort();
    this.server.closeAllConnections();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.server.close(error => error ? reject(error) : resolve());
    await promise;
    await this.probeTask;
  }

  private authorized(request: IncomingMessage): boolean {
    const provided = request.headers.authorization?.replace(/^Bearer /i, '') ?? request.headers['x-api-key'];
    if (typeof provided !== 'string') return false;
    const actual = Buffer.from(provided);
    const expected = Buffer.from(this.options.token);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private json(response: ServerResponse, status: number, error: string, extra: Record<string, unknown> = {}): void {
    if (response.destroyed || response.headersSent) return;
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ error: { type: error, ...extra } }));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.options.config.request.timeoutMs)]);
    request.once('aborted', () => controller.abort());
    response.once('close', () => { if (!response.writableEnded) controller.abort(); });
    const started = Date.now();
    const waitDeadline = started + this.options.config.request.maxWaitMs;
    let release: (() => void) | undefined;
    try {
      if (!this.authorized(request)) { request.resume(); this.json(response, 401, 'local_proxy_auth_required'); return; }
      if (request.method === 'GET' && request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, platform: this.options.platform.name, ready: Boolean(await this.options.vault.get(this.options.platform.name)), quota: this.quota.snapshot() }));
        return;
      }
      const route = request.url?.split('?')[0] ?? '';
      if (!((request.method === 'POST' && POST_ROUTES[route]) || (request.method === 'GET' && route === '/v1/models')) || request.url?.includes('?')) {
        request.resume(); this.json(response, 404, 'unsupported_api_route'); return;
      }
      release = await this.requests.acquire(signal);
      let body: string | undefined;
      if (request.method === 'POST') {
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) { request.resume(); this.json(response, 415, 'json_required'); return; }
        const parts: Buffer[] = [];
        let size = 0;
        const abortBody = (): void => { request.destroy(); };
        signal.addEventListener('abort', abortBody, { once: true });
        try {
          for await (const chunk of request.iterator({ destroyOnReturn: false })) {
            signal.throwIfAborted();
            const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > this.options.config.request.maxBodyBytes) { request.resume(); this.json(response, 413, 'request_too_large'); return; }
            parts.push(bytes);
          }
        } finally { signal.removeEventListener('abort', abortBody); }
        let payload: z.infer<typeof RequestSchema>;
        try { payload = RequestSchema.parse(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch { this.json(response, 400, 'invalid_request_json'); return; }
        payload.model ??= this.options.platform.defaultModel;
        const prefix = this.options.platform.requiredModelPrefix;
        if ((prefix && !payload.model.startsWith(prefix)) || !this.options.platform.freeModelIds.includes(payload.model)) {
          this.json(response, 400, 'free_model_required', { allowedModels: this.options.platform.freeModelIds }); return;
        }
        body = JSON.stringify(payload);
      }
      for (let attempt = 0; attempt <= this.options.config.request.retryBudget; attempt++) {
        await this.quota.wait(waitDeadline, signal);
        const credential = await this.options.vault.get(this.options.platform.name);
        if (!credential) { this.json(response, 503, 'credential_missing'); return; }
        this.options.events.registerSecret(credential.apiKey);
        const headers = new Headers();
        const connectionHeaders = new Set((request.headers.connection ?? '').toLowerCase().split(',').map(value => value.trim()));
        for (const [name, value] of Object.entries(request.headers)) {
          if (value === undefined || HOP_HEADERS[name] || connectionHeaders.has(name) || ['authorization', 'x-api-key', 'cookie', 'accept-encoding'].includes(name)) continue;
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        headers.set('authorization', `Bearer ${credential.apiKey}`);
        headers.set('accept-encoding', 'identity');
        const suffix = route.slice('/v1'.length);
        const upstream = await fetch(`${this.options.platform.apiBaseUrl.replace(/\/$/, '')}${suffix}`, { method: request.method, headers, body, signal, redirect: 'manual' });
        if (upstream.status === 402 || upstream.status === 429) {
          await upstream.body?.cancel();
          await this.quota.blocked(upstream.status, upstream.headers);
          if (attempt === this.options.config.request.retryBudget) throw new CapacityError(this.quota.snapshot().blockedUntil, upstream.status);
          continue;
        }
        if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel(); this.json(response, 502, 'upstream_redirect_refused'); return; }
        upstream.headers.forEach((value, name) => { if (!HOP_HEADERS[name] && !['content-encoding', 'set-cookie'].includes(name)) response.setHeader(name, value); });
        response.statusCode = upstream.status;
        response.flushHeaders();
        if (upstream.body) {
          const reader = upstream.body.getReader();
          try {
            for (;;) {
              const item = await reader.read();
              if (item.done) break;
              if (!response.write(item.value)) await once(response, 'drain', { signal });
            }
          } finally { reader.releaseLock(); }
        }
        response.end();
        return;
      }
    } catch (error) {
      if (error instanceof CapacityError) {
        const seconds = Math.max(1, Math.ceil((error.availableAt - Date.now()) / 1000));
        if (!response.headersSent) response.setHeader('retry-after', String(seconds));
        this.json(response, 503, 'capacity_unavailable', { upstreamStatus: error.upstreamStatus, availableAt: new Date(error.availableAt).toISOString() });
      } else {
        await this.options.events.emit('proxy', signal.aborted ? 'request_aborted' : 'request_failed', { retry: { decision: 'abort' } });
        if (response.headersSent) response.destroy(); else this.json(response, signal.aborted ? 504 : 502, signal.aborted ? 'request_timeout' : 'upstream_unavailable');
      }
    } finally {
      release?.();
      this.controllers.delete(controller);
    }
  }

  private async probeLoop(): Promise<void> {
    const probe = this.options.platform.quotaProbe;
    if (!probe) return;
    while (!this.stopped) {
      const controller = new AbortController();
      this.controllers.add(controller);
      try {
        const credential = await this.options.vault.get(this.options.platform.name);
        if (credential) {
          this.options.events.registerSecret(credential.apiKey);
          const response = await fetch(probe.url, { headers: { authorization: `Bearer ${credential.apiKey}` }, redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
          if (!response.ok) { await response.body?.cancel(); throw new Error('Quota probe rejected'); }
          const data: unknown = await response.json();
          const getPath = (path: string): unknown => path.split('.').reduce<unknown>((value, name) => value && typeof value === 'object' && !Array.isArray(value) ? Reflect.get(value, name) : undefined, data);
          const remaining = z.number().min(0).max(100).parse(getPath(probe.remainingPath));
          const resetsAt = Date.parse(z.string().datetime({ offset: true }).parse(getPath(probe.resetsAtPath)));
          await this.quota.update(remaining, resetsAt);
          await this.options.events.emit('quota', 'measured', { remainingPercent: remaining, resetsAt: new Date(resetsAt).toISOString() });
        }
      } catch { if (!this.stopped) await this.options.events.emit('quota', 'probe_unavailable', { retry: { decision: 'wait', afterMs: this.options.config.quotaPollMs } }); }
      finally { this.controllers.delete(controller); }
      if (this.stopped) break;
      const sleepController = new AbortController();
      this.controllers.add(sleepController);
      try { await delay(this.options.config.quotaPollMs, undefined, { signal: sleepController.signal }); }
      catch (error) { if (!this.stopped) throw error; }
      finally { this.controllers.delete(sleepController); }
    }
  }
}
