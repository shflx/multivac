import type { DatabaseSync } from 'node:sqlite';
import type { SessionSelectionRepository, StoredSelectionCommand, StoredSessionSelection } from '../modules/sessions/session-model-selection.js';
import { runInTransaction } from './sqlite-transaction.js';

/**
 * 会话选模的 SQLite 实现：选模意图与命令在同一事务中登记，确认完成时与会话绑定的模型一起更新。
 * 表结构与迁移由 SqliteAssistantStore 维护。
 */
export class SqliteSessionSelectionRepository implements SessionSelectionRepository {
  constructor(private readonly database: DatabaseSync, private readonly now: () => string) {}

  getSelection(sessionId: string): StoredSessionSelection | undefined {
    const row = this.database.prepare('SELECT selection_json FROM assistant_model_selection WHERE assistant_id = ?')
      .get(sessionId) as { selection_json: string } | undefined;
    return row ? JSON.parse(row.selection_json) as StoredSessionSelection : undefined;
  }

  saveSelection(selection: StoredSessionSelection): void {
    this.database.prepare('INSERT INTO assistant_model_selection VALUES (?, ?) ON CONFLICT(assistant_id) DO UPDATE SET selection_json = excluded.selection_json')
      .run(selection.sessionId, JSON.stringify(selection));
  }

  getSelectionCommand(commandId: string): StoredSelectionCommand | undefined {
    const row = this.database.prepare('SELECT command_json FROM assistant_model_command WHERE command_id = ?')
      .get(commandId) as { command_json: string } | undefined;
    return row ? JSON.parse(row.command_json) as StoredSelectionCommand : undefined;
  }

  beginSelection(selection: StoredSessionSelection, command: StoredSelectionCommand): void {
    runInTransaction(this.database, () => {
      this.database.prepare('INSERT INTO assistant_model_command VALUES (?, ?)').run(command.commandId, JSON.stringify(command));
      this.saveSelection(selection);
    });
  }

  finishSelection(selection: StoredSessionSelection, command: StoredSelectionCommand): void {
    runInTransaction(this.database, () => {
      this.saveSelection(selection);
      if (!selection.pending) {
        const model = selection.model;
        this.database.prepare(`UPDATE assistant_session_binding SET
          model_provider = ?, model_id = ?, model_protocol = ?, model_endpoint = ?,
          model_resolved_endpoint = ?, model_profile_id = ?, model_source = ?, model_endpoint_mode = ?, updated_at = ?
          WHERE assistant_id = ? AND runtime_session_id = ? AND runtime_session_ref = ?`)
          .run(model.provider, model.modelId, model.protocol ?? null, model.endpoint ?? null,
            model.resolvedEndpoint ?? null, model.profileId ?? null, model.source ?? 'base', model.endpointMode ?? null,
            this.now(), selection.sessionId, selection.runtimeSessionId, selection.runtimeSessionRef);
      }
      this.database.prepare('UPDATE assistant_model_command SET command_json = ? WHERE command_id = ?')
        .run(JSON.stringify(command), command.commandId);
    });
  }
}
