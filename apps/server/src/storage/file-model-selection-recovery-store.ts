import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { ModelProtocol } from '@multivac/contracts';
import type {
  ModelSelectionRecoveryRecord,
  ModelSelectionRecoveryRepository,
} from '../modules/sessions/model-selection-recovery.js';
import {
  equalModelEndpoints,
  safeModelEndpoint,
  safeModelProtocol,
  isPiNativeDynamicEndpoint,
} from '../modules/sessions/model-selection-recovery.js';

const PROTOCOLS = new Set<ModelProtocol>([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
]);

function recordPath(root: string, piSessionId: string): string {
  const digest = createHash('sha256').update(piSessionId).digest('hex');
  return join(root, `${digest}.json`);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function parseRecord(value: unknown): ModelSelectionRecoveryRecord {
  if (typeof value !== 'object' || value === null) {
    throw new Error('模型选择恢复记录结构无效。');
  }
  const record = value as Record<string, unknown>;
  const fields = new Set([
    'version', 'phase', 'selectionKind', 'assistantSessionId', 'piSessionId', 'piSessionPath',
    'provider', 'modelId', 'profileId', 'protocol', 'endpoint', 'endpointMode', 'resolvedEndpoint', 'createdAt',
  ]);
  if (
    Object.keys(record).some((field) => !fields.has(field)) ||
    record.version !== 1 ||
    record.phase !== 'initialization-intent' ||
    !['base', 'controlled'].includes(String(record.selectionKind)) ||
    typeof record.assistantSessionId !== 'string' || !record.assistantSessionId ||
    typeof record.piSessionId !== 'string' || !record.piSessionId ||
    typeof record.piSessionPath !== 'string' || !isAbsolute(record.piSessionPath) ||
    typeof record.provider !== 'string' || !record.provider ||
    typeof record.modelId !== 'string' || !record.modelId ||
    !nullableString(record.profileId) ||
    !safeModelProtocol(record.protocol) ||
    !nullableString(record.endpoint) ||
    !nullableString(record.resolvedEndpoint) ||
    !(record.endpointMode === undefined || record.endpointMode === 'fixed' || record.endpointMode === 'pi-native-dynamic') ||
    typeof record.createdAt !== 'string' || !record.createdAt
  ) {
    throw new Error('模型选择恢复记录字段无效。');
  }
  if (
    (record.profileId !== null && !String(record.profileId).trim()) ||
    (record.selectionKind === 'base' && record.profileId !== null) ||
    (record.selectionKind === 'controlled' && record.profileId === null) ||
    (record.selectionKind === 'controlled' && !PROTOCOLS.has(record.protocol as ModelProtocol)) ||
    (record.endpointMode === 'pi-native-dynamic'
      ? record.selectionKind !== 'base' ||
        !isPiNativeDynamicEndpoint(record.protocol) || record.resolvedEndpoint !== null
      : !safeModelEndpoint(record.resolvedEndpoint)) ||
    (record.endpoint !== null && !safeModelEndpoint(record.endpoint)) ||
    (record.selectionKind === 'controlled' && typeof record.endpoint === 'string' &&
      (typeof record.resolvedEndpoint !== 'string' ||
        !equalModelEndpoints(record.endpoint, record.resolvedEndpoint)))
  ) {
    throw new Error('模型选择恢复记录关联字段无效。');
  }
  return {
    version: 1,
    phase: 'initialization-intent',
    selectionKind: record.selectionKind as 'base' | 'controlled',
    assistantSessionId: record.assistantSessionId,
    piSessionId: record.piSessionId,
    piSessionPath: record.piSessionPath,
    provider: record.provider,
    modelId: record.modelId,
    profileId: record.profileId,
    protocol: record.protocol,
    endpoint: record.endpoint,
    ...(record.endpointMode !== undefined ? { endpointMode: record.endpointMode } : {}),
    resolvedEndpoint: record.resolvedEndpoint,
    createdAt: record.createdAt,
  };
}

function sameSelection(
  left: ModelSelectionRecoveryRecord,
  right: ModelSelectionRecoveryRecord,
): boolean {
  return left.version === right.version &&
    left.phase === right.phase && left.selectionKind === right.selectionKind &&
    left.assistantSessionId === right.assistantSessionId &&
    left.piSessionId === right.piSessionId &&
    left.piSessionPath === right.piSessionPath &&
    left.provider === right.provider &&
    left.modelId === right.modelId &&
    left.profileId === right.profileId &&
    left.protocol === right.protocol &&
    left.endpoint === right.endpoint &&
    (left.endpointMode ?? 'fixed') === (right.endpointMode ?? 'fixed') &&
    left.resolvedEndpoint === right.resolvedEndpoint;
}

/** 不可变恢复文件只保存模型选择元数据，不保存任何认证材料。 */
export class FileModelSelectionRecoveryRepository implements ModelSelectionRecoveryRepository {
  constructor(private readonly root: string) {}

  private async syncDirectory(): Promise<void> {
    const directory = await open(this.root, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  async get(piSessionId: string): Promise<ModelSelectionRecoveryRecord | undefined> {
    try {
      const record = parseRecord(JSON.parse(await readFile(recordPath(this.root, piSessionId), 'utf8')) as unknown);
      if (record.piSessionId !== piSessionId) throw new Error('模型选择恢复记录 sessionId 不匹配。');
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async saveIfAbsent(record: ModelSelectionRecoveryRecord): Promise<ModelSelectionRecoveryRecord> {
    const validated = parseRecord(record);
    await mkdir(this.root, { recursive: true });
    const target = recordPath(this.root, validated.piSessionId);
    const temporary = join(this.root, `.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(temporary, target);
      await this.syncDirectory();
      return validated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await this.get(validated.piSessionId);
      if (!existing || !sameSelection(existing, validated)) {
        throw new Error('模型选择恢复记录与既有不可变记录冲突。');
      }
      await this.syncDirectory();
      return existing;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
}
