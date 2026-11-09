import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import {
  ConfigFileHarness,
  EnvHarness,
  ZroCliHarness,
  ZroCommandError,
} from '../adapters/harness/index.js';
import type { HarnessSettings } from '../adapters/harness/index.js';

const execute = promisify(execFile);
const settings: HarnessSettings = {
  baseUrl: 'http://127.0.0.1:4318/v1',
  apiKey: 'local-proxy-client-token',
  model: 'authorized-model',
};

async function sandbox(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'freeapi-harness-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function zroFixture(t: TestContext): Promise<{ directory: string; script: string; logPath: string }> {
  const directory = await sandbox(t);
  const script = join(directory, 'fixture.mjs');
  const logPath = join(directory, 'commands.jsonl');
  await writeFile(script, `
import { appendFile } from 'node:fs/promises';
await appendFile(process.env.FIXTURE_LOG, JSON.stringify({
  args: process.argv.slice(2),
  home: process.env.HOME,
  config: process.env.XDG_CONFIG_HOME,
  openai: process.env.OPENAI_BASE_URL,
  key: process.env.OPENAI_API_KEY,
  anthropic: process.env.ANTHROPIC_BASE_URL,
}) + '\\n');
if (process.env.FIXTURE_FAIL === '1') {
  console.error(process.argv.join(' ') + process.env.OPENAI_API_KEY);
  process.exit(23);
}
process.stdout.write(process.env.FIXTURE_RESPONSE ?? '{"remainingPercent":62,"resetsAt":"2030-01-01T00:00:00Z"}');
`, { mode: 0o600 });
  return { directory, script, logPath };
}

test('environment export shell-quotes secrets, uses a bare Anthropic origin, and changes no parent environment', { skip: process.platform === 'win32' }, async (t) => {
  const directory = await sandbox(t);
  const path = join(directory, 'proxy.env');
  const marker = join(directory, 'should-not-exist');
  const secret = `token'\"; $(touch ${marker}) \`touch ${marker}\` \\ $HOME\nsecond line`;
  const before = process.env.OPENAI_API_KEY;
  const adapter = new EnvHarness({ path });
  await adapter.set_api_key({ ...settings, apiKey: secret });
  const program = 'process.stdout.write(JSON.stringify({key:process.env.OPENAI_API_KEY,token:process.env.ANTHROPIC_AUTH_TOKEN,anthropicKey:process.env.ANTHROPIC_API_KEY,base:process.env.OPENAI_BASE_URL,anthropic:process.env.ANTHROPIC_BASE_URL,model:process.env.OPENAI_MODEL,anthropicModel:process.env.ANTHROPIC_MODEL}))';
  const result = await execute('/bin/sh', ['-c', '. "$1"; exec "$2" -e "$3"', 'fixture', path, process.execPath, program]);
  assert.deepEqual(JSON.parse(result.stdout), {
    key: secret, token: secret, anthropicKey: secret,
    base: settings.baseUrl, anthropic: 'http://127.0.0.1:4318',
    model: settings.model, anthropicModel: settings.model,
  });
  await assert.rejects(access(marker));
  assert.equal(process.env.OPENAI_API_KEY, before);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(await adapter.get_usage(), null);
  assert.equal(adapter.detect_limit(402), true);
  assert.equal(adapter.detect_limit(429), true);
  assert.equal(adapter.detect_limit(403), false);
  await assert.rejects(adapter.reload(), /Source the export/);
});

test('Continue JSON merges managed model settings and preserves other models and keys', async (t) => {
  const directory = await sandbox(t);
  const path = join(directory, 'config.json');
  const unrelated = { title: 'Keep me', provider: 'ollama', model: 'local-model', apiBase: 'http://localhost:11434' };
  await writeFile(path, JSON.stringify({
    models: [unrelated, { title: 'Authorized local proxy', provider: 'openai', apiKey: 'old-local-token', completionOptions: { temperature: 0.2 } }],
    tabAutocompleteModel: { provider: 'ollama', model: 'other' },
    customCommands: [{ name: 'keep', prompt: 'untouched' }],
  }), { mode: 0o644 });
  const adapter = new ConfigFileHarness({ path, format: 'continue' });
  await adapter.set_api_key(settings);
  await adapter.set_api_key({ ...settings, model: 'updated-model' });
  const config = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(config.models[0], unrelated);
  assert.equal(config.models.length, 2);
  assert.deepEqual(config.models[1], {
    title: 'Authorized local proxy', provider: 'openai', apiKey: settings.apiKey,
    model: 'updated-model', apiBase: settings.baseUrl, completionOptions: { temperature: 0.2 },
  });
  assert.deepEqual(config.tabAutocompleteModel, { provider: 'ollama', model: 'other' });
  assert.deepEqual(config.customCommands, [{ name: 'keep', prompt: 'untouched' }]);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(adapter.reload(), /through its UI/);
});

test('Continue YAML preserves comments, unrelated mappings, model roles, and YAML-sensitive credentials', async (t) => {
  const directory = await sandbox(t);
  const path = join(directory, 'config.yaml');
  await writeFile(path, `# Keep this explanatory comment\nname: Existing name\nversion: 2.0.0\nschema: v1\nrules:\n  - Keep this rule\nmodels:\n  - name: Other model\n    provider: ollama\n    model: local\n  - name: Authorized local proxy\n    provider: openai\n    roles: [chat, edit]\n`);
  const adapter = new ConfigFileHarness({ path, format: 'continue' });
  const secret = 'token: # quoted " value\nnext';
  await adapter.set_api_key({ ...settings, apiKey: secret });
  const source = await readFile(path, 'utf8');
  assert.match(source, /# Keep this explanatory comment/);
  const config = parse(source);
  assert.equal(config.name, 'Existing name');
  assert.equal(config.version, '2.0.0');
  assert.deepEqual(config.rules, ['Keep this rule']);
  assert.deepEqual(config.models[0], { name: 'Other model', provider: 'ollama', model: 'local' });
  assert.deepEqual(config.models[1], {
    name: 'Authorized local proxy', provider: 'openai', roles: ['chat', 'edit'],
    model: settings.model, apiBase: settings.baseUrl, apiKey: secret,
  });
});

test('new Continue YAML has required metadata and serialized concurrent JSON updates preserve all models', async (t) => {
  const directory = await sandbox(t);
  const yamlPath = join(directory, 'nested', 'config.yaml');
  await new ConfigFileHarness({ path: yamlPath, format: 'continue' }).set_api_key(settings);
  const yaml = parse(await readFile(yamlPath, 'utf8'));
  assert.equal(yaml.schema, 'v1');
  assert.equal(yaml.models[0].apiBase, settings.baseUrl);
  const path = join(directory, 'config.json');
  await Promise.all(['one', 'two', 'three'].map((modelName) =>
    new ConfigFileHarness({ path, format: 'continue', modelName }).set_api_key(settings),
  ));
  const config = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(config.models.map((entry: { title: string }) => entry.title).sort(), ['one', 'three', 'two']);
});

test('malformed Continue settings and duplicate managed entries are not overwritten', async (t) => {
  const directory = await sandbox(t);
  for (const [name, source] of [
    ['config.json', '{ not JSON'],
    ['array.json', '{"models":{}}'],
    ['duplicate.json', '{"models":[{"title":"Authorized local proxy"},{"title":"Authorized local proxy"}]}'],
    ['config.yaml', 'models: {}\n'],
    ['duplicate.yaml', 'models:\n  - name: Authorized local proxy\n  - name: Authorized local proxy\n'],
  ] as const) {
    const path = join(directory, name);
    await writeFile(path, source);
    await assert.rejects(new ConfigFileHarness({ path, format: 'continue' }).set_api_key(settings));
    assert.equal(await readFile(path, 'utf8'), source);
  }
});

test('Cline, Roo and Cursor never invent native secret settings; fallback is explicit and preserves native files', async (t) => {
  const directory = await sandbox(t);
  for (const format of ['cline', 'roo', 'cursor'] as const) {
    const path = join(directory, `${format}.json`);
    const source = '{"unrelated":{"theme":"keep"}}\n';
    await writeFile(path, source);
    await assert.rejects(new ConfigFileHarness({ path, format }).set_api_key(settings), /unsupported|no supported file API/);
    assert.equal(await readFile(path, 'utf8'), source);
    const envLaunchPath = join(directory, `${format}.env`);
    await new ConfigFileHarness({ path, format, envLaunchPath }).set_api_key(settings);
    assert.equal(await readFile(path, 'utf8'), source);
    assert.match(await readFile(envLaunchPath, 'utf8'), /OPENAI_BASE_URL='http:\/\/127\.0\.0\.1:4318\/v1'/);
    assert.throws(() => new ConfigFileHarness({ path, format, envLaunchPath: path }), /must not overwrite/);
  }
});

test('all configured endpoints must be local and Anthropic must be a bare origin', async (t) => {
  const directory = await sandbox(t);
  const adapter = new EnvHarness({ path: join(directory, 'proxy.env') });
  for (const baseUrl of ['https://api.openai.com/v1', 'http://127.0.0.1.evil.test/v1', 'http://user:secret@localhost/v1', 'http://localhost/v1?key=secret']) {
    await assert.rejects(adapter.set_api_key({ ...settings, baseUrl }));
  }
  await assert.rejects(adapter.set_api_key({ ...settings, anthropicBaseUrl: 'http://localhost:4318/v1' }), /bare local proxy origin/);
  await assert.rejects(adapter.set_api_key({ ...settings, apiKey: 'nul\0token' }));
  await assert.rejects(access(join(directory, 'proxy.env')));
});

test('zro uses literal argv, explicit provider authorization, isolated home, and proxy-only child environment', async (t) => {
  const fixture = await zroFixture(t);
  const homeDir = join(fixture.directory, 'isolated-home');
  const adapter = new ZroCliHarness({
    cwd: fixture.directory, homeDir, executable: process.execPath, prefixArgs: [fixture.script],
    env: { ...process.env, FIXTURE_LOG: fixture.logPath, OPENAI_API_KEY: 'inherited-provider-secret' },
  });
  const before = process.env.OPENAI_API_KEY;
  await adapter.set_api_key(settings);
  await assert.rejects(access(fixture.logPath));
  assert.deepEqual(await adapter.get_usage(), { remainingPercent: 62, resetsAt: '2030-01-01T00:00:00Z' });
  const marker = join(fixture.directory, 'should-not-exist');
  const providerKey = `authorized provider' ; $(touch ${marker})`;
  await assert.rejects(adapter.loginProvider(providerKey, { userAuthorized: false } as never), /Explicit user authorization/);
  await adapter.loginProvider(providerKey, { userAuthorized: true });
  const records = (await readFile(fixture.logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.deepEqual(records[0].args, ['status', '--json']);
  assert.equal(records[0].key, settings.apiKey);
  assert.equal(records[0].openai, settings.baseUrl);
  assert.equal(records[0].anthropic, 'http://127.0.0.1:4318');
  assert.equal(records[0].home, homeDir);
  assert.equal(records[0].config, join(homeDir, '.config'));
  assert.deepEqual(records[1].args, ['login', '--api-key', providerKey]);
  assert.equal(records[1].key, undefined);
  await assert.rejects(access(marker));
  assert.equal(process.env.OPENAI_API_KEY, before);
  await assert.rejects(adapter.reload(), /no documented reload command/);
});

test('zro failures are propagated without leaking key-bearing command output', async (t) => {
  const fixture = await zroFixture(t);
  const adapter = new ZroCliHarness({
    cwd: fixture.directory, homeDir: join(fixture.directory, 'home'), executable: process.execPath,
    prefixArgs: [fixture.script], env: { ...process.env, FIXTURE_LOG: fixture.logPath, FIXTURE_FAIL: '1' },
  });
  await adapter.set_api_key(settings);
  await assert.rejects(adapter.get_usage(), (error: unknown) => {
    assert.ok(error instanceof ZroCommandError);
    assert.equal(error.code, 23);
    assert.equal(String(error).includes(settings.apiKey), false);
    assert.equal('cause' in error, false);
    return true;
  });
  const providerKey = 'authorized-secret-not-for-errors';
  await assert.rejects(adapter.loginProvider(providerKey, { userAuthorized: true }), (error: unknown) => {
    assert.ok(error instanceof ZroCommandError);
    assert.equal(String(error).includes(providerKey), false);
    return true;
  });
});

test('zro unknown usage is null, while invalid JSON and invalid percentages are errors', async (t) => {
  const fixture = await zroFixture(t);
  for (const [response, expected] of [['{"loggedIn":true}', 'null'], ['not json', 'error'], ['{"remainingPercent":-1}', 'error']]) {
    const adapter = new ZroCliHarness({
      cwd: fixture.directory, homeDir: join(fixture.directory, 'home'), executable: process.execPath,
      prefixArgs: [fixture.script], env: { ...process.env, FIXTURE_LOG: fixture.logPath, FIXTURE_RESPONSE: response },
    });
    if (expected === 'null') assert.equal(await adapter.get_usage(), null);
    else await assert.rejects(adapter.get_usage());
  }
});
