import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { detectLimit, proxyEnvironment, validateSettings } from './settings.js';
import type { Harness, HarnessSettings, Usage } from './types.js';

const execute = promisify(execFile);

export interface ZroCliHarnessOptions {
  /** Required isolated working directory, never an inferred user directory. */
  cwd: string;
  /** Required isolated home for zro's own state. */
  homeDir: string;
  executable?: string;
  /** Literal executable-prefix arguments, e.g. a Node fixture script path. */
  prefixArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface ProviderLoginAuthorization {
  /** Explicit consent to send this provider credential to zro's login command. */
  userAuthorized: true;
}

/** Deliberately omits stdout, stderr, argv and causes, which may contain secrets. */
export class ZroCommandError extends Error {
  readonly code: string | number | null;
  readonly signal: string | null;

  constructor(code: string | number | null, signal: string | null) {
    super(`zro command failed (code ${code ?? 'unknown'}, signal ${signal ?? 'none'}).`);
    this.name = 'ZroCommandError';
    this.code = code;
    this.signal = signal;
  }
}

export class ZroCliHarness implements Harness {
  private readonly cwd: string;
  private readonly homeDir: string;
  private readonly executable: string;
  private readonly prefixArgs: readonly string[];
  private readonly environment: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private settings: HarnessSettings | undefined;

  constructor(options: ZroCliHarnessOptions) {
    if (!options.cwd || !options.homeDir) throw new Error('Explicit zro cwd and isolated homeDir are required.');
    this.cwd = resolve(options.cwd);
    this.homeDir = resolve(options.homeDir);
    this.executable = options.executable ?? 'zro';
    this.prefixArgs = [...(options.prefixArgs ?? [])];
    this.environment = { ...(options.env ?? process.env) };
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('zro timeoutMs must be positive and finite.');
  }

  /** Configures only future child processes with local proxy credentials; never runs login. */
  async set_api_key(settings: HarnessSettings): Promise<void> {
    this.settings = validateSettings(settings);
  }

  /** The only operation that passes a provider credential to zro, with explicit consent. */
  async loginProvider(apiKey: string, authorization: ProviderLoginAuthorization): Promise<void> {
    if (authorization?.userAuthorized !== true) throw new Error('Explicit user authorization is required for provider login.');
    if (!apiKey || apiKey.includes('\0')) throw new Error('A nonempty provider key without NUL bytes is required.');
    await this.run(['login', '--api-key', apiKey], false);
  }

  async get_usage(): Promise<Usage | null> {
    const output = await this.run(['status', '--json'], true);
    let status: unknown;
    try {
      status = JSON.parse(output);
    } catch {
      throw new Error('zro status did not return valid JSON.');
    }
    if (typeof status !== 'object' || status === null || !('remainingPercent' in status)) return null;
    const remainingPercent = status.remainingPercent;
    if (typeof remainingPercent !== 'number' || !Number.isFinite(remainingPercent) || remainingPercent < 0 || remainingPercent > 100) {
      throw new Error('zro remainingPercent must be a finite percentage between 0 and 100.');
    }
    if ('resetsAt' in status) {
      if (typeof status.resetsAt !== 'string') throw new Error('zro resetsAt must be a string.');
      return { remainingPercent, resetsAt: status.resetsAt };
    }
    return { remainingPercent };
  }

  detect_limit(status: number): boolean {
    return detectLimit(status);
  }

  async reload(): Promise<void> {
    throw new Error('zro has no documented reload command. Proxy settings apply to the next child process; restart any separately running client explicitly.');
  }

  private async run(args: readonly string[], useProxy: boolean): Promise<string> {
    await mkdir(this.homeDir, { recursive: true, mode: 0o700 });
    const env = { ...this.environment };
    for (const key of ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL']) {
      delete env[key];
    }
    Object.assign(env, {
      HOME: this.homeDir,
      USERPROFILE: this.homeDir,
      XDG_CONFIG_HOME: join(this.homeDir, '.config'),
      XDG_DATA_HOME: join(this.homeDir, '.local', 'share'),
      XDG_STATE_HOME: join(this.homeDir, '.local', 'state'),
      XDG_CACHE_HOME: join(this.homeDir, '.cache'),
      APPDATA: join(this.homeDir, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(this.homeDir, 'AppData', 'Local'),
      ...(useProxy && this.settings ? proxyEnvironment(this.settings) : {}),
    });
    try {
      const result = await execute(this.executable, [...this.prefixArgs, ...args], {
        cwd: this.cwd,
        env,
        shell: false,
        timeout: this.timeoutMs,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
      });
      return result.stdout;
    } catch (error) {
      const code = error instanceof Error && 'code' in error && (typeof error.code === 'number' || typeof error.code === 'string')
        ? error.code : null;
      const signal = error instanceof Error && 'signal' in error && typeof error.signal === 'string' ? error.signal : null;
      throw new ZroCommandError(code, signal);
    }
  }
}

export function createZroCliHarness(options: ZroCliHarnessOptions): ZroCliHarness {
  return new ZroCliHarness(options);
}
