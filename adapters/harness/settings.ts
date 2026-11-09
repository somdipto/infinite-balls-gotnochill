import type { HarnessSettings } from './types.js';

function localUrl(value: string): URL {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash
  ) {
    throw new Error('Harness endpoints must be loopback HTTP(S) proxy URLs without credentials, query, or fragment.');
  }
  return url;
}

export function validateSettings(settings: HarnessSettings): HarnessSettings {
  const base = localUrl(settings.baseUrl);
  if (!settings.apiKey || !settings.model || settings.apiKey.includes('\0') || settings.model.includes('\0')) {
    throw new Error('A nonempty local proxy token and model without NUL bytes are required.');
  }
  const anthropic = localUrl(settings.anthropicBaseUrl ?? base.origin);
  if (anthropic.pathname !== '/') {
    throw new Error('anthropicBaseUrl must be the bare local proxy origin, without /v1.');
  }
  return {
    baseUrl: base.href.replace(/\/$/, ''),
    apiKey: settings.apiKey,
    model: settings.model,
    anthropicBaseUrl: anthropic.origin,
  };
}

export function proxyEnvironment(settings: HarnessSettings): Record<string, string> {
  const checked = validateSettings(settings);
  return {
    OPENAI_BASE_URL: checked.baseUrl,
    OPENAI_API_KEY: checked.apiKey,
    OPENAI_MODEL: checked.model,
    ANTHROPIC_BASE_URL: checked.anthropicBaseUrl ?? new URL(checked.baseUrl).origin,
    ANTHROPIC_AUTH_TOKEN: checked.apiKey,
    ANTHROPIC_API_KEY: checked.apiKey,
    ANTHROPIC_MODEL: checked.model,
  };
}

export function detectLimit(status: number): boolean {
  return status === 402 || status === 429;
}
