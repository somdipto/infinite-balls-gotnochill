import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const SafeUrlSchema = z.string().url().superRefine((value, ctx) => {
  const url = new URL(value);
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.hash || url.search || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Use HTTPS (or loopback HTTP) without credentials, query, or fragment' });
  }
});

export const PlatformSchema = z.object({
  version: z.literal(1),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  authClass: z.enum(['email-otp', 'oauth-google', 'existing-key']),
  signupUrl: SafeUrlSchema,
  keysUrl: SafeUrlSchema,
  apiBaseUrl: SafeUrlSchema,
  defaultModel: z.string().min(1),
  freeModelIds: z.array(z.string().min(1)).nonempty(),
  requiredModelPrefix: z.string().min(1).optional(),
  keyPrefix: z.string().min(1).optional(),
  quotaProbe: z.object({
    url: SafeUrlSchema,
    remainingPath: z.string().min(1),
    resetsAtPath: z.string().min(1),
  }).strict().nullable(),
  limits: z.object({
    requestsPerMinute: z.number().int().positive().optional(),
    resetUtcHour: z.number().int().min(0).max(23),
  }).strict(),
  riskNotes: z.array(z.string()).default([]),
}).strict().superRefine((recipe, ctx) => {
  if (!recipe.freeModelIds.includes(recipe.defaultModel)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'defaultModel must be an allowed freeModelId' });
  if (recipe.requiredModelPrefix && recipe.freeModelIds.some(model => !model.startsWith(recipe.requiredModelPrefix!))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Every free model must match requiredModelPrefix' });
  }
  if (recipe.quotaProbe && new URL(recipe.quotaProbe.url).origin !== new URL(recipe.apiBaseUrl).origin) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Quota probe must share the API origin; keys are never sent cross-origin' });
  }
});

export type Platform = z.infer<typeof PlatformSchema>;

export async function loadPlatform(directory: string, name: string): Promise<Platform> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('Invalid platform name');
  const recipe = PlatformSchema.parse(parse(await readFile(resolve(directory, `${name}.yaml`), 'utf8')));
  if (recipe.name !== name) throw new Error('Recipe name does not match its filename');
  return recipe;
}

export function nextReset(platform: Platform, now = Date.now()): number {
  const date = new Date(now);
  date.setUTCHours(platform.limits.resetUtcHour, 0, 0, 0);
  if (date.getTime() <= now) date.setUTCDate(date.getUTCDate() + 1);
  return date.getTime();
}
