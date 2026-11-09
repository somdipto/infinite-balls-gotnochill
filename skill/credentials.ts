import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { Vault } from '../vault/store.js';
import { EnvHarness } from '../adapters/harness/index.js';
import type { HarnessSettings } from '../adapters/harness/types.js';
import type { LoadedConfig } from './config.js';
import type { Platform } from './platform.js';
import type { Events } from './events.js';
import { atomicWrite, withLock, isMissing, readJson } from './files.js';

const CheckpointSchema = z.object({ version: z.literal(1), stage: z.enum(['key_saved', 'ready']), platform: z.string(), generation: z.number().int().positive(), fingerprint: z.string(), updatedAt: z.string().datetime() }).strict();
export type ImportStage = 'key_saved' | 'ready';

export async function proxyToken(workspace: string): Promise<string> {
  const path = join(workspace, 'proxy.token');
  return withLock(path, async () => {
    try { return z.string().regex(/^local-freeapi-[A-Za-z0-9_-]{43}$/).parse(await readFile(path, 'utf8')); }
    catch (error) {
      if (!isMissing(error)) throw error;
      const token = `local-freeapi-${randomBytes(32).toString('base64url')}`;
      await atomicWrite(path, token);
      return token;
    }
  });
}

export async function harnessSettings(loaded: LoadedConfig, platform: Platform, baseUrl?: string): Promise<HarnessSettings> {
  return { baseUrl: baseUrl ?? `http://127.0.0.1:${loaded.config.proxy.port}/v1`, apiKey: await proxyToken(loaded.workspace), model: platform.defaultModel };
}

export async function exportHarness(loaded: LoadedConfig, platform: Platform, baseUrl?: string): Promise<string> {
  const path = resolve(loaded.workspace, loaded.config.harness.path);
  const settings = await harnessSettings(loaded, platform, baseUrl);
  await new EnvHarness({ path }).set_api_key(settings);
  await atomicWrite(join(loaded.workspace, 'proxy.json'), JSON.stringify({ platform: platform.name, baseUrl: settings.baseUrl, model: settings.model, envFile: path, tokenFile: join(loaded.workspace, 'proxy.token') }, null, 2));
  return path;
}

export async function importCredential(loaded: LoadedConfig, platform: Platform, accountId: string, apiKey: string, events: Events, onCheckpoint?: (stage: ImportStage) => Promise<void>): Promise<void> {
  if (platform.keyPrefix && !apiKey.startsWith(platform.keyPrefix)) throw new Error('Credential does not match the recipe key prefix');
  events.registerSecret(apiKey);
  await withLock(join(loaded.workspace, 'imports', platform.name), async () => {
    const vault = await Vault.open(join(loaded.workspace, 'vault'));
    const metadata = await vault.put(platform.name, accountId, apiKey);
    const checkpoint = { version: 1 as const, stage: 'key_saved' as const, platform: platform.name, generation: metadata.generation, fingerprint: metadata.fingerprint, updatedAt: new Date().toISOString() };
    const path = join(loaded.workspace, 'checkpoints', `${platform.name}.json`);
    await atomicWrite(path, JSON.stringify(checkpoint));
    await events.emit('import', 'key_saved', { platform: platform.name, generation: metadata.generation });
    await onCheckpoint?.('key_saved');
    await exportHarness(loaded, platform);
    await atomicWrite(path, JSON.stringify({ ...checkpoint, stage: 'ready' }));
    await onCheckpoint?.('ready');
    await events.emit('import', 'ready', { platform: platform.name, generation: metadata.generation });
  });
}

export async function resumeImport(loaded: LoadedConfig, platform: Platform, events: Events): Promise<void> {
  await withLock(join(loaded.workspace, 'imports', platform.name), async () => {
    const path = join(loaded.workspace, 'checkpoints', `${platform.name}.json`);
    const checkpoint = CheckpointSchema.parse(await readJson(path));
    if (checkpoint.platform !== platform.name) throw new Error('Checkpoint platform mismatch');
    const vault = await Vault.open(join(loaded.workspace, 'vault'));
    const metadata = (await vault.inventory()).find(item => item.platform === platform.name);
    if (!metadata || metadata.generation !== checkpoint.generation || metadata.fingerprint !== checkpoint.fingerprint) throw new Error('Checkpoint no longer matches the committed credential; import it again');
    await exportHarness(loaded, platform);
    await atomicWrite(path, JSON.stringify({ ...checkpoint, stage: 'ready', updatedAt: new Date().toISOString() }));
    await events.emit('import', 'resumed', { platform: platform.name, generation: metadata.generation });
  });
}
