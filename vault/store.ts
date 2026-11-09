import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { readFile, mkdir, open, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWrite, withLock, readJson, isMissing } from '../skill/files.js';

const CredentialSchema = z.object({
  platform: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  accountId: z.string().regex(/^[a-zA-Z0-9@._+-]{1,128}$/),
  apiKey: z.string().min(8).max(4096).regex(/^[\x21-\x7e]+$/),
  generation: z.number().int().positive(),
  updatedAt: z.string().datetime(),
}).strict();
const DataSchema = z.object({ version: z.literal(1), credentials: z.array(CredentialSchema) }).strict();
const EnvelopeSchema = z.object({
  version: z.literal(1), iv: z.string(), tag: z.string(), ciphertext: z.string(),
}).strict();
export type Credential = z.infer<typeof CredentialSchema>;
export interface CredentialMetadata { platform: string; accountId: string; generation: number; updatedAt: string; maskedKey: string; fingerprint: string }

export function maskSecret(value: string): string {
  return value.length <= 8 ? '[redacted]' : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export class Vault {
  private readonly path: string;
  constructor(readonly directory: string, private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('Vault key must contain exactly 32 bytes');
    this.path = join(directory, 'credentials.enc');
  }

  static async open(directory: string): Promise<Vault> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const supplied = process.env.FREEAPI_VAULT_KEY;
    let key: Buffer;
    if (supplied) {
      if (!/^[A-Za-z0-9+/]{43}=$/.test(supplied)) throw new Error('FREEAPI_VAULT_KEY must be a base64-encoded 32-byte key');
      key = Buffer.from(supplied, 'base64');
    } else {
      const keyPath = join(directory, 'master.key');
      key = await withLock(keyPath, async () => {
        try {
          const current = await readFile(keyPath);
          await chmod(keyPath, 0o600);
          return current;
        } catch (error) {
          if (!isMissing(error)) throw error;
          const fresh = randomBytes(32);
          const file = await open(keyPath, 'wx', 0o600);
          try { await file.writeFile(fresh); await file.sync(); } finally { await file.close(); }
          return fresh;
        }
      });
    }
    return new Vault(directory, key);
  }

  private async load(): Promise<z.infer<typeof DataSchema>> {
    let raw: unknown;
    try { raw = await readJson(this.path); } catch (error) {
      if (isMissing(error)) return { version: 1, credentials: [] };
      throw new Error('Credential vault is unreadable; no credentials were discarded');
    }
    try {
      const envelope = EnvelopeSchema.parse(raw);
      const iv = Buffer.from(envelope.iv, 'base64');
      const tag = Buffer.from(envelope.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid vault envelope');
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(Buffer.from('freeapi-vault:v1'));
      decipher.setAuthTag(tag);
      const clear = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
      return DataSchema.parse(JSON.parse(clear.toString('utf8')));
    } catch {
      throw new Error('Credential vault authentication failed; check its key and integrity');
    }
  }

  async get(platform: string): Promise<Credential | undefined> {
    return (await this.load()).credentials.find(item => item.platform === platform);
  }

  async put(platform: string, accountId: string, apiKey: string): Promise<CredentialMetadata> {
    return withLock(this.path, async () => {
      const data = await this.load();
      const previous = data.credentials.find(item => item.platform === platform);
      if (previous && previous.accountId !== accountId) throw new Error('One account per platform: import a replacement key for the same account');
      const record = CredentialSchema.parse({ platform, accountId, apiKey, generation: previous?.generation ?? 1, updatedAt: previous?.updatedAt ?? new Date().toISOString() });
      if (previous?.apiKey !== apiKey) {
        record.generation = (previous?.generation ?? 0) + 1;
        record.updatedAt = new Date().toISOString();
        data.credentials = data.credentials.filter(item => item.platform !== platform);
        data.credentials.push(record);
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.key, iv);
        cipher.setAAD(Buffer.from('freeapi-vault:v1'));
        const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
        await atomicWrite(this.path, JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') }));
      }
      await this.writeInventory(data.credentials);
      return this.metadata(record);
    });
  }

  async inventory(): Promise<CredentialMetadata[]> {
    return (await this.load()).credentials.map(item => this.metadata(item));
  }

  private metadata(record: Credential): CredentialMetadata {
    return {
      platform: record.platform, accountId: record.accountId, generation: record.generation,
      updatedAt: record.updatedAt, maskedKey: maskSecret(record.apiKey),
      fingerprint: createHash('sha256').update(record.apiKey).digest('hex').slice(0, 16),
    };
  }

  private async writeInventory(records: Credential[]): Promise<void> {
    const lines = records.map(record => { const info = this.metadata(record); return `| ${info.platform} | ${info.accountId} | ${info.maskedKey} | ${info.generation} | ${info.updatedAt} |`; });
    await atomicWrite(join(this.directory, 'credentials.md'), `# Credential inventory\n\nMasked metadata only. Provider keys are encrypted in credentials.enc.\n\n| Platform | Account | Key | Generation | Updated |\n| --- | --- | --- | --- | --- |\n${lines.join('\n')}\n`);
  }
}
