import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { isMap, isSeq, parseDocument } from 'yaml';
import { atomicWrite, withLock } from '../../skill/files.js';
import { EnvHarness } from './env.js';
import { detectLimit, validateSettings } from './settings.js';
import type { Harness, HarnessSettings, Usage } from './types.js';

export type ConfigFormat = 'cline' | 'roo' | 'continue' | 'cursor';

export interface ConfigFileHarnessOptions {
  path: string;
  format: ConfigFormat;
  /** Explicit opt-in fallback; the native settings file is left untouched. */
  envLaunchPath?: string;
  /** Continue model title/name owned by this adapter; other entries are preserved. */
  modelName?: string;
}

/** No private editor databases, VS Code SecretStorage, or undocumented settings are edited. */
export const HARNESS_LIMITATIONS: Readonly<Record<ConfigFormat, string>> = {
  cline: 'Direct Cline credential storage is unsupported. Configure its provider through the editor UI. An explicit envLaunchPath exports local-proxy environment variables only; it does not configure Cline or reload the editor.',
  roo: 'Direct Roo credential storage is unsupported. Import an authorized profile or configure its provider through the editor UI. An explicit envLaunchPath exports local-proxy environment variables only; it does not configure Roo or reload the editor.',
  continue: 'Continue JSON and YAML model configuration is supported. Select the generated model in Continue and reload the configuration through its UI; this adapter does not control a running editor.',
  cursor: 'Cursor has no supported file API for provider-key settings. Use its documented Models UI. An explicit envLaunchPath exports local-proxy environment variables only, not Cursor provider settings. Cursor does not document consuming these variables, and server-routed requests cannot reach your loopback proxy.',
};

function object(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be an object; configuration was not modified.`);
  }
  return value as Record<string, unknown>;
}

export class ConfigFileHarness implements Harness {
  readonly path: string;
  readonly format: ConfigFormat;
  private readonly envLaunchPath: string | undefined;
  private readonly modelName: string;

  constructor(options: ConfigFileHarnessOptions) {
    if (!options.path) throw new Error('An explicit configuration path is required.');
    if (!Object.hasOwn(HARNESS_LIMITATIONS, options.format)) throw new Error('Unsupported configuration format.');
    if (options.envLaunchPath && resolve(options.path) === resolve(options.envLaunchPath)) {
      throw new Error('The environment export must not overwrite the native configuration file.');
    }
    this.path = options.path;
    this.format = options.format;
    this.envLaunchPath = options.envLaunchPath;
    this.modelName = options.modelName ?? 'Authorized local proxy';
    if (!this.modelName) throw new Error('Continue model name must not be empty.');
  }

  async set_api_key(settings: HarnessSettings): Promise<void> {
    const checked = validateSettings(settings);
    if (this.format !== 'continue') {
      if (!this.envLaunchPath) throw new Error(HARNESS_LIMITATIONS[this.format]);
      await new EnvHarness({ path: this.envLaunchPath }).set_api_key(checked);
      return;
    }
    await withLock(this.path, async () => {
      let source: string;
      try {
        source = await readFile(this.path, 'utf8');
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
        source = '';
      }
      const yaml = ['.yaml', '.yml'].includes(extname(this.path).toLowerCase());
      const modelSettings = {
        provider: 'openai',
        model: checked.model,
        apiBase: checked.baseUrl,
        apiKey: checked.apiKey,
      };
      if (yaml) {
        const document = parseDocument(source);
        if (document.errors.length) throw new Error('Invalid Continue YAML; configuration was not modified.');
        if (document.contents === null) document.set('name', 'Authorized local proxy');
        if (!isMap(document.contents)) throw new Error('Continue YAML root must be a mapping.');
        if (!document.has('name')) document.set('name', 'Authorized local proxy');
        if (!document.has('version')) document.set('version', '1.0.0');
        if (!document.has('schema')) document.set('schema', 'v1');
        if (!document.has('models')) document.set('models', document.createNode([]));
        const models = document.get('models', true);
        if (!isSeq(models)) throw new Error('Continue models must be an array; configuration was not modified.');
        const matches = models.items.filter((item) => isMap(item) && item.get('name') === this.modelName);
        if (matches.length > 1) throw new Error('Duplicate managed Continue model names; configuration was not modified.');
        const existing = matches[0];
        if (isMap(existing)) {
          for (const [key, value] of Object.entries(modelSettings)) existing.set(key, value);
        } else {
          models.add(document.createNode({ name: this.modelName, ...modelSettings }));
        }
        await atomicWrite(this.path, document.toString());
      } else {
        let parsed: unknown;
        try {
          parsed = source.trim() ? JSON.parse(source) : {};
        } catch {
          throw new Error('Invalid Continue JSON; configuration was not modified.');
        }
        const config = object(parsed, 'Continue configuration');
        if (config.models !== undefined && !Array.isArray(config.models)) {
          throw new Error('Continue models must be an array; configuration was not modified.');
        }
        const models: unknown[] = config.models ?? [];
        let found = false;
        const mergedModels = models.map((entry) => {
          if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry;
          const model = object(entry, 'Continue model');
          if (model.title !== this.modelName) return entry;
          if (found) throw new Error('Duplicate managed Continue model titles; configuration was not modified.');
          found = true;
          return { ...model, ...modelSettings };
        });
        if (!found) mergedModels.push({ title: this.modelName, ...modelSettings });
        config.models = mergedModels;
        await atomicWrite(this.path, `${JSON.stringify(config, null, 2)}\n`);
      }
    });
  }

  async get_usage(): Promise<Usage | null> {
    return null;
  }

  detect_limit(status: number): boolean {
    return detectLimit(status);
  }

  async reload(): Promise<void> {
    throw new Error(HARNESS_LIMITATIONS[this.format]);
  }
}

export function createConfigFileHarness(options: ConfigFileHarnessOptions): ConfigFileHarness {
  return new ConfigFileHarness(options);
}
