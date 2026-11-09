import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicWrite, isMissing } from './files.js';
import { Vault } from '../vault/store.js';
import { proxyToken } from './credentials.js';
import { loadConfig } from './config.js';

export async function install(directory: string, assets: string): Promise<string> {
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const configPath = join(root, 'skill.config.yaml');
  try { await access(configPath); } catch (error) {
    if (!isMissing(error)) throw error;
    await atomicWrite(configPath, await readFile(join(assets, 'skill.config.yaml')));
  }
  await mkdir(join(root, 'platforms'), { recursive: true, mode: 0o700 });
  for (const file of (await readdir(join(assets, 'platforms'))).filter(name => name.endsWith('.yaml'))) {
    const target = join(root, 'platforms', file);
    try { await access(target); } catch (error) {
      if (!isMissing(error)) throw error;
      await atomicWrite(target, await readFile(join(assets, 'platforms', file)));
    }
  }
  const loaded = await loadConfig(configPath);
  await Vault.open(join(loaded.workspace, 'vault'));
  await proxyToken(loaded.workspace);
  return configPath;
}
