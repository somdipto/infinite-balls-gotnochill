import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

export interface Observation { authorization: string; model: unknown; path: string; at: number; clientCookie: string | undefined; clientKey: string | undefined }
export interface Fixture {
  baseUrl: string; observations: Observation[]; acceptedKey: string;
  responses: { status: number; retryAfter?: string }[];
  stream: boolean; close(): Promise<void>;
}

export async function upstreamFixture(): Promise<Fixture> {
  const fixture: Fixture = { baseUrl: '', observations: [], acceptedKey: 'sk-fixture-authorized-0001', responses: [], stream: false, close: async () => close(server) };
  const server = createServer((request, response) => {
    void (async () => {
      let body = '';
      for await (const part of request) body += String(part);
      const payload: unknown = body ? JSON.parse(body) : {};
      const model: unknown = payload && typeof payload === 'object' && 'model' in payload ? payload.model : undefined;
      fixture.observations.push({ authorization: request.headers.authorization ?? '', model, path: request.url ?? '', at: Date.now(), clientCookie: request.headers.cookie, clientKey: typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : undefined });
      if (request.headers.authorization !== `Bearer ${fixture.acceptedKey}`) { response.writeHead(401).end('{"error":"unauthorized"}'); return; }
      const forced = fixture.responses.shift();
      if (forced) {
        response.writeHead(forced.status, { 'content-type': 'application/json', ...(forced.retryAfter ? { 'retry-after': forced.retryAfter } : {}) });
        response.end(JSON.stringify({ error: 'fixture-capacity' })); return;
      }
      if (fixture.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        response.write('data: {"text":"first"}\n\n');
        await delay(150);
        response.end('data: [DONE]\n\n'); return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'fixture-completion', object: 'chat.completion', model, choices: [{ message: { role: 'assistant', content: 'fixture-ok' }, finish_reason: 'stop', index: 0 }] }));
    })().catch(() => { response.writeHead(500).end(); });
  });
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
  await promise;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture failed to listen');
  fixture.baseUrl = `http://127.0.0.1:${address.port}`;
  return fixture;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.close(error => error ? reject(error) : resolve());
  await promise;
}
