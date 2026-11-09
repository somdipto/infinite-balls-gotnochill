import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FileHandle } from 'node:fs/promises';

const markerName = '.freeapi-browser-profile';
const markerValue = 'freeapi-owned-browser-profile-v1\n';
const lockName = '.freeapi-browser-lock';

export interface OwnedProfile {
  path: string;
  release(): Promise<void>;
}

// Only empty directories or directories explicitly created by this driver are eligible.
// Existing personal browser profiles are never adopted, opened, or removed.
export async function acquireProfile(requestedPath?: string): Promise<OwnedProfile> {
  const temporary = requestedPath === undefined;
  const path = temporary
    ? await mkdtemp(join(tmpdir(), 'freeapi-browser-'))
    : resolve(requestedPath);
  let lock: FileHandle | undefined;
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Browser profile must be a real, driver-owned directory, not a symlink.');
    }
    const entries = await readdir(path);
    const markerPath = join(path, markerName);
    if (entries.length === 0) {
      const marker = await open(markerPath, 'wx', 0o600);
      try {
        await marker.writeFile(markerValue);
      } finally {
        await marker.close();
      }
    } else if (!entries.includes(markerName) || await readFile(markerPath, 'utf8') !== markerValue) {
      throw new Error('Refusing to open a non-owned browser profile; choose a new empty directory.');
    }
    await chmod(path, 0o700);
    try {
      lock = await open(join(path, lockName), 'wx', 0o600);
    } catch (cause) {
      throw new Error('Browser profile is already locked; no personal or active profile will be reused.', { cause });
    }
    await lock.writeFile(String(process.pid));
    let released = false;
    return {
      path: await realpath(path),
      async release(): Promise<void> {
        if (released) return;
        released = true;
        try {
          await lock?.close();
        } finally {
          await rm(join(path, lockName), { force: true });
          if (temporary) await rm(path, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    if (lock !== undefined) {
      await lock.close();
      await rm(join(path, lockName), { force: true });
    }
    if (temporary) await rm(path, { recursive: true, force: true });
    throw error;
  }
}
