import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { createDriver } from '../adapters/driver/index.js';
import type { Driver, DriverKind } from '../adapters/driver/index.js';

const fixture = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorized browser driver smoke</title>
  <style>
    body { font: 18px system-ui, sans-serif; background: #f3f6fa; color: #172334; padding: 60px; }
    main { background: white; border: 1px solid #ccd5e0; border-radius: 12px; padding: 36px; max-width: 720px; }
    label, input, button, output { display: block; margin: 16px 0; }
    input, button { font: inherit; padding: 12px; }
    button { background: #125941; color: white; border: 0; border-radius: 6px; cursor: pointer; }
    output { white-space: pre-wrap; font-family: monospace; }
  </style>
</head>
<body>
  <main>
    <h1>Real Chromium interaction proof</h1>
    <p>Local synthetic fixture only. No accounts, credentials, or external services.</p>
    <form id="form">
      <label for="message">Synthetic message</label>
      <input id="message" name="message" value="replace-this-original-value" autocomplete="off">
      <button id="submit" type="submit">Record interaction</button>
    </form>
    <output id="result" aria-live="polite">Waiting for browser input</output>
    <output id="events">pointer=0; keyboard=0; submitted=0</output>
  </main>
  <script>
    let pointer = 0;
    let keyboard = 0;
    let submitted = 0;
    document.addEventListener('pointerdown', () => { pointer += 1; });
    document.addEventListener('keydown', () => { keyboard += 1; });
    document.querySelector('#form').addEventListener('submit', (event) => {
      event.preventDefault();
      submitted += 1;
      document.querySelector('#result').textContent = 'Recorded: ' + document.querySelector('#message').value;
      document.querySelector('#events').textContent = 'pointer=' + pointer + '; keyboard=' + keyboard + '; submitted=' + submitted;
    });
  </script>
</body>
</html>`;

export interface BrowserSmokeOptions { headless?: boolean; timeoutMs?: number; paceMs?: number; driver?: DriverKind }
/** Executes both backends against a temporary loopback HTTP fixture, never a real account. */
export async function browserSmoke(outputDir: string, options: BrowserSmokeOptions = {}): Promise<{ screenshot: string; driverKinds: string[] }> {
  let forbiddenRequests = 0;
  const server = createServer((request, response) => {
    // A redirect to localhost is deliberately outside the sole allowed 127.0.0.1 origin.
    if (request.headers.host?.startsWith('localhost:')) {
      forbiddenRequests += 1;
      response.writeHead(500).end('Origin policy failed');
      return;
    }
    if (request.url === '/redirect-safe') {
      response.writeHead(302, { location: '/fixture' }).end();
      return;
    }
    if (request.url === '/redirect-denied') {
      const address = server.address();
      assert(address !== null && typeof address !== 'string');
      response.writeHead(302, { location: `http://localhost:${address.port}/fixture` }).end();
      return;
    }
    if (request.url !== '/fixture' && request.url !== '/favicon.ico') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    });
    response.end(fixture);
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  server.removeListener('error', listening.reject);
  const address = server.address();
  assert(address !== null && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const driverKinds: DriverKind[] = options.driver === 'playwright' ? ['playwright', 'computer-use'] : ['computer-use', 'playwright'];
  const output = resolve(outputDir);
  let screenshot = '';
  try {
    for (const kind of driverKinds) {
      let driver: Driver | undefined;
      try {
        driver = await createDriver(kind, { allowedOrigins: [origin], headless: options.headless ?? true, paceMs: options.paceMs ?? 15, timeoutMs: options.timeoutMs ?? 10_000 });
        await assert.rejects(driver.goto('file:///etc/passwd'), /outside allowedOrigins/);
        await assert.rejects(driver.goto(`http://user:secret@127.0.0.1:${address.port}/fixture`), /outside allowedOrigins/);
        await driver.goto(`${origin}/redirect-safe`);
        const value = `Authorized ${kind} browser proof`;
        await driver.fill('#message', value);
        await driver.click('#submit');
        assert.equal(await driver.read('#result'), `Recorded: ${value}`, `${kind} must replace existing input and submit it`);
        const events = await driver.read('#events');
        const counters = /^pointer=(\d+); keyboard=(\d+); submitted=(\d+)$/.exec(events);
        assert(counters !== null, `${kind} must report actual fixture event counters`);
        assert(Number(counters[1]) > 0, `${kind} must generate real pointer events`);
        assert.equal(Number(counters[3]), 1, `${kind} must submit exactly once`);
        if (kind === 'computer-use') assert(Number(counters[2]) > 0, 'Computer-use must generate real keyboard events');
        const imagePath = await driver.screenshot(join(output, `${kind}.png`));
        const image = await readFile(imagePath);
        assert.deepEqual(image.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), `${kind} must capture a real PNG`);
        assert(image.length > 1000, `${kind} screenshot must contain rendered page pixels`);
        if (kind === 'computer-use') screenshot = imagePath;
        await assert.rejects(driver.goto(`${origin}/redirect-denied`), /origin policy blocked/);
        assert.equal(forbiddenRequests, 0, 'Disallowed redirect must be aborted before any request reaches its origin');
      } finally {
        await driver?.close();
      }
    }
    return { screenshot, driverKinds };
  } finally {
    const stopped = Promise.withResolvers<void>();
    server.close((error) => error ? stopped.reject(error) : stopped.resolve());
    server.closeAllConnections();
    await stopped.promise;
  }
}
