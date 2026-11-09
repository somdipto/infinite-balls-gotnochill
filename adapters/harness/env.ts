import { atomicWrite, withLock } from '../../skill/files.js';
import { detectLimit, proxyEnvironment } from './settings.js';
import type { Harness, HarnessSettings, Usage } from './types.js';

export interface EnvHarnessOptions {
  /** Explicit destination; no home-directory discovery is performed. */
  path: string;
}

/** Writes a POSIX-shell source file. It cannot modify an existing parent process. */
export class EnvHarness implements Harness {
  readonly path: string;

  constructor(options: EnvHarnessOptions) {
    if (!options.path) throw new Error('An explicit environment export path is required.');
    this.path = options.path;
  }

  async set_api_key(settings: HarnessSettings): Promise<void> {
    const environment = proxyEnvironment(settings);
    const lines = Object.entries(environment).map(([name, value]) =>
      `export ${name}='${value.replaceAll("'", "'\"'\"'")}'`,
    );
    await withLock(this.path, () => atomicWrite(this.path, [
      '# Local proxy credentials. Source this file explicitly in a POSIX shell.',
      '# Existing processes are unchanged; restart clients after sourcing.',
      ...lines,
      '',
    ].join('\n')));
  }

  async get_usage(): Promise<Usage | null> {
    return null;
  }

  detect_limit(status: number): boolean {
    return detectLimit(status);
  }

  /** No process is signaled: the shell/client must explicitly import the export. */
  async reload(): Promise<void> {
    throw new Error('Automatic environment reload is unavailable. Source the export file and restart the client explicitly.');
  }
}

export function createEnvHarness(options: EnvHarnessOptions): EnvHarness {
  return new EnvHarness(options);
}
