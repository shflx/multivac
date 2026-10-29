import { protectedNote, sessionNoteOwner } from '../../data/note-access.js';
import { noteVaultStorage } from '../notes/note-vault.js';
import { Check } from 'typebox/value';
import { AssistantPageStateSchema, type AssistantPageState, GLOBAL_ASSISTANT_SESSION_ID } from '@multivac/contracts';
import {
  isCommandId, isGeneration, parsePendingCommand,
  type CommandIdentity, type PendingCommand, type StoredPendingCommand,
} from './pending-command.js';
import {
  readFailedSubmissions, readReadingDraftQuote, writeFailedSubmissions, writeReadingDraftQuote,
  type FailedSubmission, type ReadingDraftQuote,
} from './submission-recovery.js';

export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * 会话在本浏览器中的现场：待对账命令、运行中的命令、命令代数与草稿版本保存在会话存储（随标签页），
 * 阅读引用保存在本地存储（跨标签页）。各会话分键保存。
 */
export class SessionPersistence {
  private readonly keys: {
    readingQuote: string;
    failedSubmissions: string;
    pendingCommand: string;
    activePrompt: string;
    commandGeneration: string;
    draftVersion: string;
  };

  constructor(
    private readonly sessionId: string,
    private readonly ordinarySession: KeyValueStorage = sessionStorage,
    private readonly ordinaryLocal: KeyValueStorage = localStorage,
  ) {
    // 全局会话沿用原有键名，已有的浏览器现场无需迁移；其他会话在键名后追加会话 id。
    const suffix = sessionId === GLOBAL_ASSISTANT_SESSION_ID ? '' : `:${sessionId}`;
    this.keys = {
      readingQuote: `multivac.assistant.reading-draft-quote${suffix}`,
      failedSubmissions: `multivac.assistant.failed-submissions${suffix}`,
      pendingCommand: `multivac.assistant.pending-command${suffix}`,
      activePrompt: `multivac.assistant.active-prompt-command${suffix}`,
      commandGeneration: `multivac.assistant.command-generation${suffix}`,
      draftVersion: `multivac.assistant.draft-version${suffix}`,
    };
  }

  private get session(): KeyValueStorage { const owner = sessionNoteOwner(this.sessionId); return owner && protectedNote(owner) ? noteVaultStorage(owner, 'session') : this.ordinarySession; }
  private get local(): KeyValueStorage { const owner = sessionNoteOwner(this.sessionId); return owner && protectedNote(owner) ? noteVaultStorage(owner, 'local') : this.ordinaryLocal; }

  readProtectedPage(): AssistantPageState | null {
    const owner = sessionNoteOwner(this.sessionId); if (!owner || !protectedNote(owner)) return null;
    const raw = this.session.getItem(`multivac.assistant.protected-page:${this.sessionId}`); if (!raw) return null;
    const value: unknown = JSON.parse(raw); if (!Check(AssistantPageStateSchema, value)) throw new Error('讨论的加密草稿无法恢复，原密文已保留。');
    return value;
  }
  writeProtectedPage(page: AssistantPageState): void {
    const owner = sessionNoteOwner(this.sessionId); if (!owner || !protectedNote(owner)) return;
    const key = `multivac.assistant.protected-page:${this.sessionId}`, raw = JSON.stringify(page);
    if (this.session.getItem(key) !== raw) this.session.setItem(key, raw);
  }

  readPendingCommand(): StoredPendingCommand | null {
    const stored = this.session.getItem(this.keys.pendingCommand);
    return stored ? parsePendingCommand(stored) : null;
  }

  writePendingCommand(command: PendingCommand | null): void {
    if (command) this.session.setItem(this.keys.pendingCommand, JSON.stringify(command));
    else this.session.removeItem(this.keys.pendingCommand);
  }

  readActivePrompt(): CommandIdentity | null {
    const value = this.session.getItem(this.keys.activePrompt);
    if (!value) return null;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (
        typeof parsed === 'object' && parsed !== null &&
        'commandId' in parsed && isCommandId(parsed.commandId) &&
        'generation' in parsed && isGeneration(parsed.generation)
      ) {
        return { commandId: parsed.commandId, generation: parsed.generation };
      }
    } catch {
      // 兼容 CR1 已写入的裸 commandId；下一次更新会迁移为带 generation 的结构。
    }
    return isCommandId(value) ? { commandId: value, generation: 0 } : null;
  }

  writeActivePrompt(prompt: CommandIdentity | null): void {
    if (prompt) this.session.setItem(this.keys.activePrompt, JSON.stringify(prompt));
    else this.session.removeItem(this.keys.activePrompt);
  }

  readCommandGeneration(): number {
    const value = Number(this.session.getItem(this.keys.commandGeneration) ?? '0');
    return isGeneration(value) ? value : 0;
  }

  writeCommandGeneration(generation: number): void {
    this.session.setItem(this.keys.commandGeneration, String(generation));
  }

  readDraftVersion(): number {
    const value = Number(this.session.getItem(this.keys.draftVersion) ?? '0');
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  writeDraftVersion(version: number): void {
    this.session.setItem(this.keys.draftVersion, String(version));
  }

  readReadingQuote(): ReadingDraftQuote | null {
    return readReadingDraftQuote(this.keys.readingQuote, this.local);
  }

  writeReadingQuote(quote: ReadingDraftQuote | null): void {
    writeReadingDraftQuote(this.keys.readingQuote, quote, this.local);
  }

  readFailedSubmissions(): FailedSubmission[] {
    return readFailedSubmissions(this.keys.failedSubmissions, this.session);
  }

  writeFailedSubmissions(submissions: readonly FailedSubmission[]): void {
    writeFailedSubmissions(this.keys.failedSubmissions, submissions, this.session);
  }
}
