import { parseArgs } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { loadPlatform } from './platform.js';
import { install } from './install.js';
import { importCredential, resumeImport, proxyToken, exportHarness, harnessSettings } from './credentials.js';
import { Events } from './events.js';
import { withLock } from './files.js';
import { Vault } from '../vault/store.js';
import { ApiProxy } from '../proxy/server.js';
import { ConfigFileHarness } from '../adapters/harness/index.js';
import { browserSmoke } from '../mock/browser-smoke.js';
import { rsiSmoke } from '../rsi/smoke.js';

const HELP = `freeapi — authorized credentials, local proxy, bounded harness improvement

skill install [--dir PATH]
skill import-key --platform NAME --account LABEL --stdin [--config PATH]
skill resume --platform NAME [--config PATH]
skill run --platform NAME [--dry] [--config PATH]
skill status [--config PATH]
skill export --platform NAME --format continue|cline|roo|cursor --path FILE [--env-launch FILE]
skill browser-check [--output DIR]
skill self-improve --demo [--output DIR]
skill logs [--config PATH]

Use one authorized account per platform. Keys enter via stdin, not argv.
402/429 trigger bounded waiting, never disposable accounts or quota evasion.
`;

export async function main(args = process.argv.slice(2)): Promise<void> {
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      config: { type: 'string', default: 'skill.config.yaml' }, platform: { type: 'string' },
      account: { type: 'string' }, stdin: { type: 'boolean' }, dir: { type: 'string', default: '.' },
      output: { type: 'string', default: 'artifacts' }, dry: { type: 'boolean' }, demo: { type: 'boolean' },
      format: { type: 'string' }, path: { type: 'string' }, 'env-launch': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    } });
    const command = positionals[0];
    if (values.help || !command) { process.stdout.write(HELP); return; }
    if (positionals.length !== 1) throw new Error('Supply exactly one command');
    if (command === 'install') {
      const assets = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
      const config = await install(values.dir, assets);
      process.stdout.write(`${JSON.stringify({ stage: 'install', cause: 'ready', config, next: 'Import an authorized key via import-key --stdin; no signup is automated' })}\n`);
      return;
    }
    const loaded = await loadConfig(values.config);
    if (command === 'browser-check') { process.stdout.write(`${JSON.stringify(await browserSmoke(resolve(values.output), loaded.config.browser), null, 2)}\n`); return; }
    if (command === 'self-improve') {
      if (!values.demo) throw new Error('Use --demo for the isolated browser eval; custom evaluations use the typed runCycle API');
      process.stdout.write(`${JSON.stringify(await rsiSmoke(resolve(values.output), { ...loaded.config.rsi, headless: loaded.config.browser.headless }), null, 2)}\n`);
      return;
    }
    const events = new Events(join(loaded.workspace, 'runs', 'events.jsonl'));
    if (command === 'status') {
      const vault = await Vault.open(join(loaded.workspace, 'vault'));
      process.stdout.write(`${JSON.stringify({ credentials: await vault.inventory(), proxy: 'Use the authenticated /health endpoint to inspect a running proxy; a config file does not prove liveness' }, null, 2)}\n`);
      return;
    }
    if (command === 'logs') { process.stdout.write(await readFile(join(loaded.workspace, 'runs', 'events.jsonl'), 'utf8')); return; }
    const name = z.string().min(1).parse(values.platform);
    const platform = await loadPlatform(loaded.platformsDir, name);
    if (command === 'import-key') {
      if (!values.stdin || process.stdin.isTTY) throw new Error('Pipe an authorized key with --stdin; keys in argv are not accepted');
      const account = z.string().min(1).parse(values.account);
      const parts: Buffer[] = []; let size = 0;
      for await (const chunk of process.stdin) { const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += data.length; if (size > 4096) throw new Error('Credential input too large'); parts.push(data); }
      const key = Buffer.concat(parts).toString('utf8').trim();
      await importCredential(loaded, platform, account, key, events);
      return;
    }
    if (command === 'resume') { await resumeImport(loaded, platform, events); return; }
    if (command === 'export') {
      const format = z.enum(['continue', 'cline', 'roo', 'cursor']).parse(values.format);
      const path = z.string().min(1).parse(values.path);
      await new ConfigFileHarness({ path: resolve(path), format, envLaunchPath: values['env-launch'] ? resolve(values['env-launch']) : undefined }).set_api_key(await harnessSettings(loaded, platform));
      await events.emit('harness', 'exported', { format, path: resolve(path), reload: 'Explicit client import required; running processes are unchanged' });
      return;
    }
    if (command !== 'run') throw new Error('Unknown command; use --help');
    if (values.dry) { process.stdout.write(`${JSON.stringify({ stage: 'validate', cause: 'ready', platform: platform.name, model: platform.defaultModel, quota: platform.quotaProbe ? 'probe-configured' : 'unknown', mutations: false })}\n`); return; }
    const vault = await Vault.open(join(loaded.workspace, 'vault'));
    if (!await vault.get(platform.name)) {
      await events.emit('precondition', 'authorized_key_required', { platform: platform.name, keysUrl: platform.keysUrl, retry: { decision: 'abort' } });
      process.exitCode = 1; return;
    }
    await withLock(join(loaded.workspace, 'proxy', 'instance'), async () => {
      const proxy = new ApiProxy({ platform, config: loaded.config, workspace: loaded.workspace, vault, token: await proxyToken(loaded.workspace), events });
      await proxy.start();
      try {
        const envFile = await exportHarness(loaded, platform, proxy.baseUrl);
        await events.emit('harness', 'configured', { envFile, baseUrl: proxy.baseUrl });
        const { promise, resolve: stop } = Promise.withResolvers<void>();
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
        try { await promise; } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
      } finally { await proxy.stop(); }
    });
  } catch (error) {
    // No raw argv, input, upstream bodies, or untrusted error messages enter logs.
    const cause = error instanceof z.ZodError ? 'invalid_configuration_or_input' : 'operation_failed';
    process.stderr.write(`${JSON.stringify({ stage: 'cli', cause, screenshot: null, retry: { decision: 'abort' }, guidance: 'Check --help and docs/troubleshooting.md; provider credentials are never printed' })}\n`);
    process.exitCode = 1;
  }
}
