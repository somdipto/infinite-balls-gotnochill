import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { Platform } from '../skill/platform.js';
import { nextReset } from '../skill/platform.js';
import { atomicWrite, isMissing, readJson } from '../skill/files.js';
import type { Events } from '../skill/events.js';

const StateSchema = z.object({
  blockedUntil: z.number().finite().nonnegative(),
  remainingPercent: z.number().min(0).max(100).optional(),
  resetsAt: z.number().finite().positive().optional(),
  requests: z.array(z.number().finite().positive()),
}).strict();
export type QuotaState = z.infer<typeof StateSchema>;

export class CapacityError extends Error {
  constructor(readonly availableAt: number, readonly upstreamStatus?: number) { super('Authorized account capacity is unavailable within the configured wait budget'); }
}

export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const ms = Number(value) * 1000;
    return Number.isFinite(ms) ? ms : undefined;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(0, time - now) : undefined;
}

export class QuotaGate {
  private state: QuotaState = { blockedUntil: 0, requests: [] };
  private pendingSave = Promise.resolve();
  private lastStatus?: number;
  constructor(private readonly path: string, private readonly platform: Platform, private readonly threshold: number, private readonly events: Events) {}

  async load(): Promise<void> {
    try { this.state = StateSchema.parse(await readJson(this.path)); } catch (error) { if (!isMissing(error)) throw error; }
  }

  snapshot(): QuotaState { return { ...this.state, requests: [...this.state.requests] }; }

  async update(remainingPercent: number, resetsAt: number): Promise<void> {
    if (!Number.isFinite(remainingPercent) || remainingPercent < 0 || remainingPercent > 100 || !Number.isFinite(resetsAt) || resetsAt <= Date.now()) throw new Error('Invalid quota measurement');
    this.state.remainingPercent = remainingPercent;
    this.state.resetsAt = resetsAt;
    if (remainingPercent <= this.threshold) {
      this.state.blockedUntil = Math.max(this.state.blockedUntil, resetsAt);
      await this.events.emit('quota', 'threshold_wait', { remainingPercent, resetsAt: new Date(resetsAt).toISOString(), retry: { decision: 'wait', afterMs: resetsAt - Date.now() } });
    }
    await this.save();
  }

  async blocked(status: number, headers: Headers): Promise<void> {
    const now = Date.now();
    const retry = retryAfterMs(headers.get('retry-after'), now);
    const reset = this.state.resetsAt && this.state.resetsAt > now ? this.state.resetsAt : nextReset(this.platform, now);
    const until = status === 402 ? Math.max(reset, now + (retry ?? 0)) : now + (retry ?? 1000);
    this.state.blockedUntil = Math.max(this.state.blockedUntil, until);
    this.lastStatus = status;
    await this.save();
    await this.events.emit('proxy', 'upstream_capacity', { upstreamStatus: status, availableAt: new Date(until).toISOString(), retry: { decision: 'wait', afterMs: until - now } });
  }

  async wait(deadline: number, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const now = Date.now();
      if (this.state.resetsAt && this.state.resetsAt <= now) {
        this.state.remainingPercent = undefined;
        this.state.resetsAt = undefined;
      }
      this.state.requests = this.state.requests.filter(time => time > now - 60000);
      let availableAt = this.state.blockedUntil;
      const rpm = this.platform.limits.requestsPerMinute;
      if (rpm && this.state.requests.length >= rpm) availableAt = Math.max(availableAt, this.state.requests[0]! + 60000);
      if (availableAt <= now) {
        if (rpm) { this.state.requests.push(now); await this.save(); }
        return;
      }
      if (availableAt > deadline) throw new CapacityError(availableAt, this.lastStatus);
      await delay(Math.min(availableAt - now, 250), undefined, { signal });
    }
  }

  private async save(): Promise<void> {
    // Serialize durable snapshots so concurrent requests cannot overwrite newer cooldowns.
    this.pendingSave = this.pendingSave.then(() => atomicWrite(this.path, JSON.stringify(this.state)));
    await this.pendingSave;
  }
}
