import { createServer, request as forwardRequest } from 'node:http';
import type { OutgoingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';

export interface OriginProxy {
  server: string;
  close(): Promise<void>;
}

/**
 * Chromium/Playwright does not route redirect hops through context.route handlers.
 * Enforce a browser egress policy before HTTP requests and HTTPS connections.
 * HTTPS is tunneled unchanged: no TLS interception or credential/header rewriting.
 * This is not an OS network sandbox for hostile browser code or native extensions.
 */
export async function createOriginProxy(origins: Set<string>): Promise<OriginProxy> {
  const sockets = new Set<Duplex>();
  const server = createServer((incoming, outgoing) => {
    let target: URL;
    try {
      target = new URL(incoming.url ?? '');
      if (target.protocol !== 'http:' || target.username || target.password || !origins.has(target.origin)) {
        throw new Error('Origin denied');
      }
    } catch {
      outgoing.writeHead(403, { 'content-type': 'text/plain', connection: 'close' }).end('Browser origin not allowed');
      incoming.resume();
      return;
    }
    const headers: OutgoingHttpHeaders = { ...incoming.headers, host: target.host };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = forwardRequest(target, { method: incoming.method, headers }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
      response.on('error', () => outgoing.destroy());
    });
    upstream.on('socket', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    upstream.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.on('aborted', () => upstream.destroy());
    outgoing.on('close', () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', (request, downstream, head) => {
    let target: URL;
    try {
      target = new URL(`https://${request.url ?? ''}`);
      if (target.username || target.password || target.pathname !== '/' || target.search || target.hash || !origins.has(target.origin)) {
        throw new Error('Origin denied');
      }
    } catch {
      downstream.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = connect({
      host: target.hostname.replace(/^\[|\]$/g, ''),
      port: Number(target.port || 443),
    });
    sockets.add(upstream);
    upstream.once('close', () => sockets.delete(upstream));
    upstream.once('connect', () => {
      downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      downstream.pipe(upstream);
      upstream.pipe(downstream);
    });
    upstream.on('error', () => downstream.destroy());
    downstream.on('error', () => upstream.destroy());
    downstream.once('close', () => upstream.destroy());
    upstream.once('close', () => downstream.destroy());
  });
  // WebSocket upgrade forwarding is deliberately unsupported; there is no silent
  // direct-network fallback around this policy boundary.
  server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  const ready = Promise.withResolvers<void>();
  server.once('error', ready.reject);
  server.listen(0, '127.0.0.1', ready.resolve);
  await ready.promise;
  server.removeListener('error', ready.reject);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Browser origin proxy did not bind a loopback port.');
  let closed = false;
  return {
    server: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const stopped = Promise.withResolvers<void>();
      server.close((error) => error ? stopped.reject(error) : stopped.resolve());
      for (const socket of sockets) socket.destroy();
      await stopped.promise;
    },
  };
}
