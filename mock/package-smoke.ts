import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { chromium } from 'playwright';
import { atomicWrite } from '../skill/files.js';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'freeapi-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
try {
  const env = { ...process.env, HOME: temporary, FREEAPI_VAULT_KEY: undefined };
  const packed = await execute(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], { cwd: root, env, timeout: 60000 });
  const result = z.array(z.object({ filename: z.string(), name: z.string(), version: z.string() })).nonempty().parse(JSON.parse(packed.stdout))[0]!;
  const prefix = join(temporary, 'installed');
  await execute(npm, ['install', '--prefix', prefix, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, result.filename)], { cwd: temporary, env, timeout: 120000 });
  const binary = join(prefix, 'node_modules', result.name, 'bin', 'skill.mjs');
  const workspace = join(temporary, 'workspace');
  const installed = await execute(process.execPath, [binary, 'install', '--dir', workspace], { cwd: temporary, env, timeout: 30000 });
  assert.ok(installed.stdout.includes('"cause":"ready"'));
  for (const platform of ['zro', 'apinex']) {
    const dry = await execute(process.execPath, [binary, 'run', '--platform', platform, '--dry'], { cwd: workspace, env, timeout: 30000 });
    const event: unknown = JSON.parse(dry.stdout);
    assert.ok(event && typeof event === 'object' && 'platform' in event && event.platform === platform);
  }
  // Reuse only the installed browser binaries, never a personal browser profile/home.
  const executable = chromium.executablePath();
  const cacheBoundary = executable.search(/[/\\]chromium-\d+[/\\]/);
  if (cacheBoundary < 0) throw new Error('Cannot locate installed Playwright browser cache');
  const browserEnv = { ...env, PLAYWRIGHT_BROWSERS_PATH: executable.slice(0, cacheBoundary) };
  const browser = await execute(process.execPath, [binary, 'browser-check', '--output', join(root, 'artifacts', 'packaged-browser')], { cwd: workspace, env: browserEnv, timeout: 60000 });
  const proof = z.object({ screenshot: z.string(), driverKinds: z.array(z.string()) }).parse(JSON.parse(browser.stdout));
  assert.deepEqual(proof.driverKinds, ['computer-use', 'playwright']);
  const evidence = { ok: true, package: `${result.name}@${result.version}`, checks: ['actual tarball installed without devDependencies', 'installed CLI initializes a fresh workspace', 'both shipped recipes validate from the installed package', 'installed CLI exercises both real Chromium backends'], browser: proof, providerAccountsUsed: false };
  await atomicWrite(join(root, 'artifacts', 'package-smoke.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }
