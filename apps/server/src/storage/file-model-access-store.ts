import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { ModelAccessReceiptSchema, ModelConnectionCheckSchema } from '@multivac/contracts';
import type { ModelAccessState, ModelAccessStore } from '../modules/model-settings/model-access.js';

const Schema = Type.Object({
  version: Type.Literal(1), accessRevision: Type.Integer({ minimum: 0 }), credentialRevision: Type.Integer({ minimum: 0 }),
  commands: Type.Array(Type.Object({ ...ModelAccessReceiptSchema.properties,
    provider: Type.String(), baselineAccessRevision: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false })),
  checks: Type.Array(Type.Object({ ...ModelConnectionCheckSchema.properties,
    provider: Type.String(), configRevision: Type.Integer({ minimum: 0 }), credentialRevision: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

/** 此文件只有安全元数据；秘密及其 hash 没有可序列化字段。 */
export class FileModelAccessStore implements ModelAccessStore {
  constructor(private readonly path: string) {}
  async load(): Promise<ModelAccessState> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      if (!Check(Schema, value)) throw new Error('invalid access metadata');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { version: 1, accessRevision: 0, credentialRevision: 0, commands: [], checks: [] };
    }
  }
  async save(state: ModelAccessState, beforeCommit?: () => void): Promise<void> {
    if (!Check(Schema, state)) throw new Error('invalid access metadata');
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
      beforeCommit?.();
      await rename(temporary, this.path);
      const parent = await open(directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    } finally { await unlink(temporary).catch(() => {}); }
  }
}
