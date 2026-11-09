import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, rm, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';

export async function atomicWrite(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function withLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(path, {
    realpath: false,
    stale: 5000,
    update: 1000,
    retries: { retries: 60, minTimeout: 100, maxTimeout: 200, factor: 1 },
  });
  try {
    return await action();
  } finally {
    await release();
  }
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
