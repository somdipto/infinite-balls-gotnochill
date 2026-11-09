import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

export const ConfigSchema = z.object({
  version: z.literal(1),
  workspace: z.string().min(1).default('.freeapi'),
  thresholdRemainingPercent: z.number().min(0).max(100).default(25),
  quotaPollMs: z.number().int().min(100).default(30000),
  proxy: z.object({
    host: z.literal('127.0.0.1').default('127.0.0.1'),
    port: z.number().int().min(0).max(65535).default(5101),
  }).strict().default({}),
  request: z.object({
    timeoutMs: z.number().int().min(100).max(3600000).default(120000),
    maxWaitMs: z.number().int().min(0).max(3600000).default(30000),
    maxBodyBytes: z.number().int().positive().default(10485760),
    retryBudget: z.number().int().min(0).max(10).default(2),
    concurrency: z.number().int().positive().max(256).default(4),
    maxQueuedRequests: z.number().int().min(0).max(10000).default(32),
  }).strict().default({}),
  browser: z.object({
    headless: z.boolean().default(true),
    timeoutMs: z.number().int().positive().default(30000),
    paceMs: z.number().int().min(0).max(1000).default(40),
    driver: z.enum(['computer-use', 'playwright']).default('computer-use'),
  }).strict().default({}),
  harness: z.object({
    adapter: z.literal('env').default('env'),
    path: z.string().default('harness.env'),
  }).strict().default({}),
  rsi: z.object({
    historyLimit: z.number().int().positive().default(20),
    maxMutations: z.number().int().min(1).max(5).default(5),
  }).strict().default({}),
}).strict();

export type Config = z.infer<typeof ConfigSchema>;
export interface LoadedConfig { config: Config; path: string; workspace: string; platformsDir: string }

export async function loadConfig(path: string): Promise<LoadedConfig> {
  const absolute = resolve(path);
  const config = ConfigSchema.parse(parse(await readFile(absolute, 'utf8')));
  return {
    config, path: absolute,
    workspace: resolve(dirname(absolute), config.workspace),
    platformsDir: resolve(dirname(absolute), 'platforms'),
  };
}
