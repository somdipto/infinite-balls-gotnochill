import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { maskSecret } from '../vault/store.js';

export interface FailureEvent { stage: string; cause: string; screenshot: string | null; retry: { decision: 'retry' | 'wait' | 'abort' | 'none'; afterMs?: number }; platform?: string }
export type EventFields = Record<string, unknown>;

export class Events {
  private readonly secrets = new Set<string>();
  constructor(private readonly file: string, private readonly emitStdout = true) {}
  registerSecret(secret: string): void { if (secret) this.secrets.add(secret); }

  async emit(stage: string, cause: string, fields: EventFields = {}): Promise<void> {
    const sanitize = (value: unknown, key = ''): unknown => {
      if (/^(apiKey|key|password|secret|clientSecret|token|accessToken|refreshToken|idToken|authorization|cookie|setCookie|otp|link)$/i.test(key.replaceAll(/[_-]/g, ''))) return typeof value === 'string' ? maskSecret(value) : '[redacted]';
      if (typeof value === 'string') {
        let output = value;
        for (const secret of this.secrets) output = output.replaceAll(secret, maskSecret(secret));
        return output;
      }
      if (Array.isArray(value)) return value.map(item => sanitize(item));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, name)]));
      return value;
    };
    const event = { ts: new Date().toISOString(), stage, cause, screenshot: null, retry: { decision: 'none' }, ...sanitize(fields) as EventFields };
    const line = JSON.stringify(event);
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await appendFile(this.file, `${line}\n`, { mode: 0o600 });
    if (this.emitStdout) process.stdout.write(`${line}\n`);
  }
}
