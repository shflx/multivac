import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { runInTransaction } from './sqlite-transaction.js';
import type { AssistantPageState, AssistantQuote, CoordinatorSessionBinding } from '@multivac/contracts';
import { AssistantQuoteSchema } from '@multivac/contracts';
import { Check } from 'typebox/value';
import {
  AssistantPageStateRevisionConflictError,
  type AssistantPageStateRepository,
  type AssistantSessionBindingRepository,
} from '../modules/sessions/assistant-session.js';

interface BindingRow {
  assistant_id: string;
  harness: string;
  runtime_session_id: string;
  runtime_session_ref: string;
  updated_at: string;
  model_provider: string | null;
  model_id: string | null;
  model_protocol: string | null;
  model_endpoint: string | null;
  model_resolved_endpoint: string | null;
  model_profile_id: string | null;
  model_source: 'base' | 'controlled' | null;
  model_endpoint_mode: 'fixed' | 'pi-native-dynamic' | null;
}

interface PageStateRow {
  draft: string;
  agent_id: string | null;
  anchor_entry_id: string | null;
  anchor_offset_px: number;
  quote_json: string | null;
  revision: number;
}

function bindingFromRow(row: BindingRow): CoordinatorSessionBinding {
  return {
    assistantSessionId: row.assistant_id,
    harness: row.harness,
    runtimeSessionId: row.runtime_session_id,
    runtimeSessionRef: row.runtime_session_ref,
    updatedAt: row.updated_at,
    ...(row.model_provider && row.model_id
      ? { modelProvider: row.model_provider, modelId: row.model_id }
      : {}),
    ...(row.model_protocol
      ? { modelProtocol: row.model_protocol as NonNullable<CoordinatorSessionBinding['modelProtocol']> }
      : {}),
    ...(row.model_protocol ? { modelEndpoint: row.model_endpoint } : {}),
    ...(row.model_resolved_endpoint || row.model_endpoint_mode === 'pi-native-dynamic'
      ? { modelResolvedEndpoint: row.model_resolved_endpoint } : {}),
    ...(row.model_profile_id ? { modelProfileId: row.model_profile_id } : {}),
    ...(row.model_source ? { modelSource: row.model_source } : {}),
    ...(row.model_endpoint_mode ? { modelEndpointMode: row.model_endpoint_mode } : {}),
  };
}

/** 旧记录没有 quote 列，损坏或不符合契约的内容同样按空引用读取，不阻断现场恢复。 */
function quoteFromColumn(value: string | null): AssistantQuote | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Check(AssistantQuoteSchema, parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sameQuote(left: AssistantQuote | null, right: AssistantQuote | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.sourceKind === 'book' || right.sourceKind === 'book') return left.sourceKind === 'book' && right.sourceKind === 'book' && left.text === right.text && JSON.stringify([left.sourceBook, left.sourceMessage ?? null, left.sourceNote ?? null]) === JSON.stringify([right.sourceBook, right.sourceMessage ?? null, right.sourceNote ?? null]);
  if (left.sourceKind === 'file' || right.sourceKind === 'file') return left.sourceKind === 'file' && right.sourceKind === 'file' &&
    (left.quoteKind ?? 'selection') === (right.quoteKind ?? 'selection') && left.text === right.text &&
    left.sourceSessionId === right.sourceSessionId && left.sourceTitle === right.sourceTitle &&
    left.sourceFile.root === right.sourceFile.root && left.sourceFile.path === right.sourceFile.path &&
    left.sourceFile.line === right.sourceFile.line && left.sourceFile.endLine === right.sourceFile.endLine && left.sourceFile.section === right.sourceFile.section;
  return left.sourceRuntimeSessionId === right.sourceRuntimeSessionId &&
    left.sourceRuntimeEntryId === right.sourceRuntimeEntryId &&
    left.sourceRole === right.sourceRole &&
    left.text === right.text &&
    left.sourceSessionId === right.sourceSessionId &&
    left.sourceTitle === right.sourceTitle;
}

function pageStateFromRow(row: PageStateRow | undefined): AssistantPageState {
  if (!row) {
    return { draft: '', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: 0 };
  }
  return {
    draft: row.draft,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    anchorEntryId: row.anchor_entry_id,
    anchorOffsetPx: row.anchor_offset_px,
    quote: quoteFromColumn(row.quote_json),
    revision: row.revision,
  };
}

/**
 * 会话与执行器会话的绑定、以及会话页面状态（草稿、阅读锚点、引用）的 SQLite 实现。
 * 表结构与迁移由 SqliteAssistantStore 维护。
 */
export class SqliteAssistantBindingRepository implements AssistantSessionBindingRepository {
  constructor(private readonly database: DatabaseSync) {}

  get(assistantSessionId: string): CoordinatorSessionBinding | undefined {
    const row = this.database.prepare(`
      SELECT assistant_id, harness, runtime_session_id, runtime_session_ref, updated_at,
             model_provider, model_id, model_protocol, model_endpoint,
             model_resolved_endpoint, model_profile_id, model_source, model_endpoint_mode
      FROM assistant_session_binding
      WHERE assistant_id = ?
    `).get(assistantSessionId) as unknown as BindingRow | undefined;
    return row ? bindingFromRow(row) : undefined;
  }

  insertIfAbsent(binding: CoordinatorSessionBinding): {
    binding: CoordinatorSessionBinding;
    inserted: boolean;
  } {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO assistant_session_binding (
        assistant_id, harness, runtime_session_id, runtime_session_ref, updated_at,
        model_provider, model_id, model_protocol, model_endpoint,
        model_resolved_endpoint, model_profile_id, model_source, model_endpoint_mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      binding.assistantSessionId,
      binding.harness,
      binding.runtimeSessionId,
      binding.runtimeSessionRef,
      binding.updatedAt,
      binding.modelProvider ?? null,
      binding.modelId ?? null,
      binding.modelProtocol ?? null,
      binding.modelEndpoint ?? null,
      binding.modelResolvedEndpoint ?? null,
      binding.modelProfileId ?? null,
      binding.modelSource ?? null,
      binding.modelEndpointMode ?? null,
    );
    const winner = this.get(binding.assistantSessionId);
    if (!winner) {
      throw new Error('Multivac binding 写入后未能读取。');
    }
    return { binding: winner, inserted: result.changes === 1 };
  }
}

export class SqliteAssistantPageStateRepository implements AssistantPageStateRepository {
  constructor(private readonly database: DatabaseSync, private readonly now: () => string) {}

  get(assistantSessionId: string): AssistantPageState {
    const row = this.database.prepare(`
      SELECT draft, agent_id, anchor_entry_id, anchor_offset_px, quote_json, revision
      FROM assistant_page_state
      WHERE assistant_id = ?
    `).get(assistantSessionId) as unknown as PageStateRow | undefined;
    return pageStateFromRow(row);
  }

  save(assistantSessionId: string, state: AssistantPageState): AssistantPageState {
    return runInTransaction(this.database, () => {
      const current = this.get(assistantSessionId);
      if (current.revision !== state.revision) {
        throw new AssistantPageStateRevisionConflictError(current);
      }
      if (
        current.draft === state.draft &&
        (current.agentId ?? null) === (state.agentId ?? null) &&
        current.anchorEntryId === state.anchorEntryId &&
        current.anchorOffsetPx === state.anchorOffsetPx &&
        sameQuote(current.quote, state.quote)
      ) {
        return current;
      }

      const next: AssistantPageState = { ...state, revision: state.revision + 1 };
      const values: SQLInputValue[] = [
        assistantSessionId,
        next.draft,
        next.agentId ?? null,
        next.anchorEntryId,
        next.anchorOffsetPx,
        next.quote ? JSON.stringify(next.quote) : null,
        next.revision,
        this.now(),
      ];
      this.database.prepare(`
        INSERT INTO assistant_page_state (
          assistant_id, draft, agent_id, anchor_entry_id, anchor_offset_px, quote_json, revision, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (assistant_id) DO UPDATE SET
          draft = excluded.draft,
          agent_id = excluded.agent_id,
          anchor_entry_id = excluded.anchor_entry_id,
          anchor_offset_px = excluded.anchor_offset_px,
          quote_json = excluded.quote_json,
          revision = excluded.revision,
          updated_at = excluded.updated_at
      `).run(...values);
      return next;
    });
  }
}
