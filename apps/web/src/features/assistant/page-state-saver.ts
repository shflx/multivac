import { ASSISTANT_DRAFT_MAX_UTF8_BYTES, type AssistantPageState, type AssistantQuote } from '@multivac/contracts';
import { AssistantApiError } from '../../data/assistant-api.js';
import { sameQuote } from './message-quote.js';

/**
 * 会话页面现场（草稿、智能体选择、引用与阅读锚点）的本地副本与保存队列。
 *
 * 保存按顺序串行：退出时的 keepalive 保存也排在在途保存之后。远端版本冲突时不自动覆盖，
 * 等待用户重试或实际修改草稿；唯一的例外是命令结算后的清稿，远端仍是本次已发送内容时可直接重试。
 */

export type SavePhase = 'saved' | 'pending' | 'saving' | 'error';

export interface SaveFeedback {
  phase: SavePhase;
  message: string;
}

/** 本地修改的来源：只有草稿意图会解除冲突阻断；阅读锚点不推进草稿版本。 */
export type LocalChangeKind = 'draft-intent' | 'command-settlement' | 'view-anchor';

/** 命令结算后用于自动重试保存冲突的提交快照：正文、智能体与引用必须同时匹配才可覆盖远端。 */
export interface SubmittedPageContent {
  draft: string;
  agentId: string | null;
  quote: AssistantQuote | null;
}

export const INITIAL_PAGE_STATE: AssistantPageState = {
  draft: '',
  anchorEntryId: null,
  anchorOffsetPx: 0,
  quote: null,
  revision: 0,
};

const SAVE_DELAY_MS = 450;
const SAVED: SaveFeedback = { phase: 'saved', message: '草稿已保存' };
const PENDING: SaveFeedback = { phase: 'pending', message: '草稿有尚未保存的更改' };
const CONFLICT: SaveFeedback = { phase: 'error', message: '其他页面更新了保存版本；当前草稿已保留，请重试保存。' };
const OVERSIZED: SaveFeedback = {
  phase: 'error',
  message: `草稿超过 ${ASSISTANT_DRAFT_MAX_UTF8_BYTES / 1024} KB 保存上限，正文已保留。`,
};

const textEncoder = new TextEncoder();

export function draftSizeBytes(draft: string): number {
  return textEncoder.encode(draft).byteLength;
}

export function sameContent(left: AssistantPageState, right: AssistantPageState): boolean {
  return left.draft === right.draft &&
    (left.agentId ?? null) === (right.agentId ?? null) &&
    left.anchorEntryId === right.anchorEntryId &&
    left.anchorOffsetPx === right.anchorOffsetPx &&
    sameQuote(left.quote, right.quote);
}

/** 读取失败时给用户的说明。 */
export function readErrorMessage(error: unknown): string {
  if (error instanceof AssistantApiError) return error.message;
  return '无法读取 Multivac 会话，请稍后重试。';
}

function saveErrorMessage(error: unknown): string {
  if (error instanceof AssistantApiError) {
    if (error.code === 'BODY_TOO_LARGE') return '草稿超过可保存的大小限制，请缩短后重试。';
    return `草稿保存失败：${error.message}`;
  }
  return '草稿保存失败：网络连接不可用，请重试。';
}

/** 保存冲突后补读到远端版本时的处理。 */
export type ConflictResolution =
  /** 远端仍是本次已发送的内容，本地是同版本的清稿：按新版本再写一次。 */
  | 'retry'
  /** 远端已经是同样的清稿：视为已保存。 */
  | 'saved'
  /** 其他情况都保留本地草稿，等待用户处理。 */
  | 'blocked';

/**
 * 冲突补读后的判定。只有命令结算的清稿可以自动处理（submitted 存在）；
 * 补读期间发生了新编辑（版本前进或内容变化）时同样阻断。
 */
export function conflictResolution(input: {
  submitted: SubmittedPageContent | undefined;
  candidate: AssistantPageState;
  remote: AssistantPageState;
  current: AssistantPageState;
  draftVersionUnchanged: boolean;
  localVersionUnchanged: boolean;
}): ConflictResolution {
  const { submitted, candidate, remote, current } = input;
  if (!submitted || candidate.draft !== '' || candidate.quote !== null) return 'blocked';
  if (
    remote.draft === submitted.draft &&
    (remote.agentId ?? null) === submitted.agentId &&
    (candidate.agentId ?? null) === submitted.agentId &&
    sameQuote(remote.quote, submitted.quote) &&
    input.draftVersionUnchanged &&
    current.draft === '' && (current.agentId ?? null) === submitted.agentId && current.quote === null
  ) return 'retry';
  if (
    remote.draft === '' && (remote.agentId ?? null) === (candidate.agentId ?? null) && remote.quote === null &&
    input.localVersionUnchanged &&
    sameContent(current, { ...candidate, revision: remote.revision })
  ) return 'saved';
  return 'blocked';
}

export interface Timers {
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(handle: number | undefined): void;
}

export interface PageStateSaverOptions {
  read(): Promise<AssistantPageState>;
  write(state: AssistantPageState, keepalive: boolean): Promise<AssistantPageState>;
  timers: Timers;
  /** 当前生命周期；队列在卸载后仍会推进 revision，但只为当前生命周期更新保存反馈。 */
  lifecycle(): number;
  isActive(lifecycle: number): boolean;
  persistDraftVersion(version: number): void;
  /** 页面现场或保存反馈变化。 */
  changed(): void;
}

export class PageStateSaver {
  page: AssistantPageState = INITIAL_PAGE_STATE;
  feedback: SaveFeedback = SAVED;
  /** 页面现场版本，用于保存队列判断保存的是否为最新内容。 */
  private localVersion: number;
  /** 草稿版本只随正文变化；滚动不能阻止成功命令清稿。 */
  private currentDraftVersion: number;
  private initialized = false;
  private dirty = false;
  private needsRevisionRefresh = false;
  /** 冲突补读只同步 revision，不授权后台保存覆盖远端；需等待用户重试或实际修改草稿。 */
  private conflictBlocked = false;
  private exitFlushVersion = -1;
  private chain: Promise<void> = Promise.resolve();
  private timer: number | undefined;

  constructor(private readonly options: PageStateSaverOptions, draftVersion: number) {
    this.localVersion = draftVersion;
    this.currentDraftVersion = draftVersion;
  }

  get draftVersion(): number {
    return this.currentDraftVersion;
  }

  get blocked(): boolean {
    return this.conflictBlocked;
  }

  /** 重新读取会话期间不保存。 */
  suspend(): void {
    this.initialized = false;
  }

  /** 待对账命令的草稿版本可能领先于本页（来自更早的页面）：本地版本不得落后于它。 */
  adoptDraftVersion(version: number): void {
    this.currentDraftVersion = Math.max(this.currentDraftVersion, version);
    this.localVersion = Math.max(this.localVersion, this.currentDraftVersion);
  }

  /** 没有待对账命令时重新进入：服务端草稿开始新的版本，旧命令的回执不能再清除它。 */
  advanceVersions(): void {
    this.localVersion += 1;
    this.currentDraftVersion += 1;
  }

  /** 读取会话完成：以服务端（或恢复后的）现场为准重新开始保存。 */
  reset(page: AssistantPageState, dirty: boolean): void {
    this.options.persistDraftVersion(this.currentDraftVersion);
    this.page = page;
    this.dirty = dirty;
    this.needsRevisionRefresh = false;
    this.conflictBlocked = false;
    this.exitFlushVersion = -1;
    this.initialized = true;
    this.feedback = dirty ? PENDING : SAVED;
    this.options.changed();
    if (dirty) this.schedule();
  }

  /** 本地修改：立即进入页面现场，稍后保存。 */
  change(next: AssistantPageState, kind: LocalChangeKind): void {
    this.page = next;
    this.dirty = true;
    this.localVersion += 1;
    if (kind !== 'view-anchor') {
      this.currentDraftVersion += 1;
      this.options.persistDraftVersion(this.currentDraftVersion);
    }
    this.exitFlushVersion = -1;
    if (kind === 'draft-intent') this.conflictBlocked = false;

    // 阅读锚点仍保留在本地待恢复快照中，但不能代表用户决定覆盖冲突的远端草稿。
    if (this.conflictBlocked) return this.options.changed();
    if (draftSizeBytes(next.draft) > ASSISTANT_DRAFT_MAX_UTF8_BYTES) {
      this.options.timers.clearTimeout(this.timer);
      this.feedback = OVERSIZED;
      return this.options.changed();
    }
    this.feedback = PENDING;
    this.options.changed();
    this.schedule();
  }

  /** 事件流恢复后以服务端现场核对本地副本。 */
  reconcileRemote(remote: AssistantPageState, lifecycle: number): void {
    const conflictWasBlocked = this.conflictBlocked;
    this.updateRevision(remote.revision);
    if (!conflictWasBlocked && sameContent(remote, this.page)) {
      this.markSaved();
    } else if (!conflictWasBlocked && !this.dirty) {
      this.page = remote;
      this.markSaved();
    } else {
      this.conflictBlocked = true;
      this.setFeedback(lifecycle, CONFLICT);
    }
    this.options.changed();
  }

  /** 排入保存队列。userInitiated 表示用户点了重试，解除冲突阻断。 */
  enqueue(keepalive = false, userInitiated = false, submitted?: SubmittedPageContent): Promise<void> {
    this.options.timers.clearTimeout(this.timer);
    if (userInitiated) this.conflictBlocked = false;
    const lifecycle = this.options.lifecycle();
    const task = this.chain.catch(() => {}).then(() => this.saveLatest(keepalive, lifecycle, submitted));
    this.chain = task.catch(() => {
      this.setFeedback(lifecycle, { phase: 'error', message: '草稿保存失败，保存队列已恢复，请重试。' });
    });
    return this.chain;
  }

  /** 离开页面或页面隐藏：同一版本只排一次 keepalive 保存，不能绕过在途保存。 */
  flushOnExit(): void {
    this.options.timers.clearTimeout(this.timer);
    if (!this.pendingSave()) return;
    if (this.exitFlushVersion === this.localVersion) return;
    this.exitFlushVersion = this.localVersion;
    void this.enqueue(true);
  }

  /** 网络恢复后同步尚未保存的草稿。 */
  online(): void {
    if (!this.pendingSave()) return;
    this.setFeedback(this.options.lifecycle(), { phase: 'pending', message: '网络已恢复，正在同步草稿' });
    void this.enqueue();
  }

  dispose(): void {
    this.options.timers.clearTimeout(this.timer);
  }

  private pendingSave(): boolean {
    return this.initialized && this.dirty && !this.conflictBlocked;
  }

  private schedule(): void {
    this.options.timers.clearTimeout(this.timer);
    this.timer = this.options.timers.setTimeout(() => void this.enqueue(), SAVE_DELAY_MS);
  }

  private updateRevision(revision: number): void {
    this.page = { ...this.page, revision };
    this.options.changed();
  }

  private markSaved(): void {
    this.dirty = false;
    this.needsRevisionRefresh = false;
    this.conflictBlocked = false;
    this.feedback = SAVED;
  }

  private setFeedback(lifecycle: number, feedback: SaveFeedback): void {
    if (!this.options.isActive(lifecycle)) return;
    this.feedback = feedback;
    this.options.changed();
  }

  private async saveLatest(keepalive: boolean, lifecycle: number, submitted?: SubmittedPageContent): Promise<void> {
    if (!this.pendingSave()) return;
    if (draftSizeBytes(this.page.draft) > ASSISTANT_DRAFT_MAX_UTF8_BYTES) return this.setFeedback(lifecycle, OVERSIZED);

    if (this.needsRevisionRefresh) {
      try {
        this.updateRevision((await this.options.read()).revision);
        this.needsRevisionRefresh = false;
      } catch (error) {
        this.conflictBlocked = true;
        return this.setFeedback(lifecycle, { phase: 'error', message: `草稿尚未保存，最新版本读取失败：${readErrorMessage(error)}` });
      }
    }

    let retrySubmitted = submitted;
    while (true) {
      const candidate = this.page;
      const candidateVersion = this.localVersion;
      const candidateDraftVersion = this.currentDraftVersion;
      this.setFeedback(lifecycle, { phase: 'saving', message: '正在保存草稿' });

      try {
        const saved = await this.options.write(candidate, keepalive);
        this.updateRevision(saved.revision);
        if (this.localVersion === candidateVersion && sameContent(this.page, candidate)) {
          this.dirty = false;
          this.needsRevisionRefresh = false;
          this.conflictBlocked = false;
          this.setFeedback(lifecycle, SAVED);
        } else if (this.options.isActive(lifecycle) && this.feedback.phase !== 'error') {
          // 旧版本保存成功不能清除新输入产生的错误（例如草稿超限）。
          this.setFeedback(lifecycle, PENDING);
        }
        return;
      } catch (error) {
        if (!(error instanceof AssistantApiError && error.code === 'PAGE_STATE_CONFLICT')) {
          return this.setFeedback(lifecycle, { phase: 'error', message: saveErrorMessage(error) });
        }
        this.conflictBlocked = true;
        try {
          const remote = await this.options.read();
          this.updateRevision(remote.revision);
          this.needsRevisionRefresh = false;
          const resolution = conflictResolution({
            submitted: retrySubmitted, candidate, remote, current: this.page,
            draftVersionUnchanged: this.currentDraftVersion === candidateDraftVersion,
            localVersionUnchanged: this.localVersion === candidateVersion,
          });
          if (resolution === 'retry') {
            // 自动结算只在远端仍为本次已提交正文时重试一次；远端已空则无需再次写入。
            retrySubmitted = undefined;
            this.conflictBlocked = false;
            continue;
          }
          if (resolution === 'saved') {
            this.markSaved();
            return this.setFeedback(lifecycle, SAVED);
          }
          // 补读期间发生的编辑也不能绕过“补读完成后等待用户处理”的冲突状态。
          this.conflictBlocked = true;
          this.setFeedback(lifecycle, CONFLICT);
        } catch (refreshError) {
          this.needsRevisionRefresh = true;
          this.conflictBlocked = true;
          this.setFeedback(lifecycle, { phase: 'error', message: `保存版本冲突，且最新版本读取失败：${readErrorMessage(refreshError)}` });
        }
        return;
      }
    }
  }
}
