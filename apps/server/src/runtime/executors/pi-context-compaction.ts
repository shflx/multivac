import { syncDirectorySync } from '../../storage/file-durability.js';
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentSession, SessionEntry } from '@earendil-works/pi-coding-agent';
import type { ContextCompactionOperation } from '@multivac/contracts';
import type { CoordinatorSessionRecoveryIdentity } from '../../modules/sessions/coordinator-adapter.js';

interface CompactionEvidence {
  version: 1;
  runtimeSessionId: string;
  bytes: number;
  hash: string;
  leaf: string | null;
  operation: ContextCompactionOperation;
}
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const evidencePath = (path: string, id: string) => `${path}.compact-${hash(id)}.json`;

/** 严格读取；Pi 的宽松解析会跳过损坏行，不能用它证明追加完整或历史未变。 */
function transcript(path: string, sessionId: string) {
  const bytes = readFileSync(path);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes) || !text.endsWith('\n')) throw new Error('不完整的会话文件。');
  const [header, ...entries] = text.trimEnd().split('\n').map(line => JSON.parse(line));
  if (header?.type !== 'session' || header.id !== sessionId) throw new Error('会话身份不一致。');
  const ids = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.id !== 'string' || ids.has(entry.id) || (entry.parentId !== null && !ids.has(entry.parentId))) throw new Error('会话树不完整。');
    ids.add(entry.id);
  }
  return { bytes, entries: entries as SessionEntry[] };
}
function syncFile(path: string) {
  const fd = openSync(path, process.platform === 'win32' ? 'r+' : 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function saveEvidence(path: string, evidence: unknown) {
  // 独占创建，完整写入并同步文件及目录后才允许调用模型；残缺证据只会保持待核对。
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(evidence)); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectorySync(dirname(path));
}
export function unknownCompaction(operation: ContextCompactionOperation): ContextCompactionOperation {
  return { ...operation, status: 'reconciliation-required', commitState: 'unknown', finishedAt: null,
    error: { code: 'COMPACTION_RESULT_UNKNOWN', message: '原压缩的持久记录或运行状态尚不可核对，保持占用；不会自动重发。' } };
}

/** 只读核对原操作。原文件前缀和唯一追加记录共同关联操作，不靠摘要正文猜测。 */
export function reconcilePiCompaction(identity: CoordinatorSessionRecoveryIdentity, operation: ContextCompactionOperation): ContextCompactionOperation {
  try {
    if (identity.harness !== 'pi') return unknownCompaction(operation);
    const evidence = JSON.parse(readFileSync(evidencePath(identity.runtimeSessionRef, operation.operationId), 'utf8')) as CompactionEvidence;
    if (evidence.version !== 1 || evidence.runtimeSessionId !== identity.runtimeSessionId ||
      evidence.operation.operationId !== operation.operationId || evidence.operation.sessionId !== operation.sessionId ||
      JSON.stringify(evidence.operation.model) !== JSON.stringify(operation.model) ||
      evidence.operation.before.revision !== operation.before.revision || !Number.isSafeInteger(evidence.bytes) || evidence.bytes < 1) return unknownCompaction(operation);
    const current = transcript(identity.runtimeSessionRef, identity.runtimeSessionId);
    if (current.bytes.length < evidence.bytes || hash(current.bytes.subarray(0, evidence.bytes)) !== evidence.hash) return unknownCompaction(operation);
    const suffix = current.bytes.subarray(evidence.bytes).toString('utf8').trim();
    const appended = suffix ? suffix.split('\n').map(line => JSON.parse(line) as SessionEntry) : [];
    const now = new Date().toISOString();
    try {
      const receipt = JSON.parse(readFileSync(evidencePath(identity.runtimeSessionRef, operation.operationId) + '.outcome', 'utf8')) as ContextCompactionOperation;
      if (receipt.operationId !== operation.operationId || receipt.sessionId !== operation.sessionId || receipt.before.revision !== operation.before.revision ||
        receipt.commitState !== 'not-committed' || !['failed', 'cancelled', 'no-content'].includes(receipt.status)) return unknownCompaction(operation);
      return { ...operation, status: receipt.status, commitState: 'not-committed', finishedAt: receipt.finishedAt,
        updatedAt: receipt.updatedAt, error: receipt.error };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return unknownCompaction(operation); }
    if (appended[0]?.type === 'compaction' && appended[0].parentId === evidence.leaf &&
      typeof appended[0].summary === 'string' && current.entries.some(entry => entry.id === (appended[0] as { firstKeptEntryId: string }).firstKeptEntryId)) {
      return { ...operation, status: 'succeeded', commitState: 'committed', runtimeCommitRef: appended[0].id,
        finishedAt: appended[0].timestamp, updatedAt: appended[0].timestamp, error: null };
    }
    if (appended.length !== 0) return unknownCompaction(operation);
    return { ...operation, status: 'failed', commitState: 'not-committed', finishedAt: now, updatedAt: now,
      error: { code: 'COMPACTION_INTERRUPTED', message: '原压缩未留下持久提交，原上下文已保留；可以重新发起新的操作。' } };
  } catch { return unknownCompaction(operation); }
}

/** 只在严格核对文件后重建消息；不写摘要、不修改历史，也不重建模型或工具配置。 */
function restore(session: AgentSession) {
  transcript(session.sessionFile!, session.sessionId);
  session.sessionManager.setSessionFile(session.sessionFile!);
  session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
}

/** 使用 SDK 原生摘要链路。异常后丢弃受污染的内存分支，以已核对的磁盘为准。 */
export async function compactPiContext(session: AgentSession, operation: ContextCompactionOperation): Promise<ContextCompactionOperation> {
  const identity = { harness: 'pi', runtimeSessionId: session.sessionId, runtimeSessionRef: session.sessionFile! };
  let prepared = false;
  let error: unknown;
  try {
    const before = transcript(identity.runtimeSessionRef, identity.runtimeSessionId);
    if (JSON.stringify(before.entries) !== JSON.stringify(session.sessionManager.getEntries())) throw new Error('内存与持久记录不一致。');
    syncFile(identity.runtimeSessionRef);
    saveEvidence(evidencePath(identity.runtimeSessionRef, operation.operationId), { version: 1, runtimeSessionId: identity.runtimeSessionId,
      bytes: before.bytes.length, hash: hash(before.bytes), leaf: session.sessionManager.getLeafId(), operation });
    prepared = true;
    try { await session.compact(); } catch (cause) { error = cause; }
    // 同步原生追加；仅 SDK 返回成功不足以证明记录可靠落盘。
    syncFile(identity.runtimeSessionRef);
    restore(session);
    const result = reconcilePiCompaction(identity, operation);
    if (result.status === 'failed') {
      const message = error instanceof Error ? error.message : '';
      const status = message === 'Compaction cancelled' || (error instanceof Error && error.name === 'AbortError') ? 'cancelled'
        : message === 'Already compacted' || message.startsWith('Nothing to compact') ? 'no-content' : 'failed';
      const completed: ContextCompactionOperation = { ...result, status, error: status === 'no-content' ? null : { code: status === 'cancelled' ? 'COMPACTION_CANCELLED' : 'COMPACTION_FAILED',
        message: status === 'cancelled' ? '原生压缩已取消，原上下文已恢复。' : '原生压缩失败，已核对并恢复原上下文。' } };
      saveEvidence(evidencePath(identity.runtimeSessionRef, operation.operationId) + '.outcome', completed);
      return completed;
    }
    return result;
  } catch {
    if (!prepared) return { ...operation, status: 'unavailable', commitState: 'not-committed', finishedAt: new Date().toISOString(),
      error: { code: 'COMPACTION_PREPARATION_FAILED', message: '压缩前持久证据无法可靠保存，未调用原生压缩。' } };
    return unknownCompaction(operation);
  }
}
