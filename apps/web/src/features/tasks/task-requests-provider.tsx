import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Type } from 'typebox';
import { InboxItemSchema, InboxListSchema, InboxStateSchema, type InboxItem, type InboxList, type InboxState, HumanRequestSchema, HumanRequestListSchema, type HumanRequestList, type HumanRequest, type DecideHumanRequest } from '@multivac/contracts';
import { fetchJson } from '../../data/assistant-api.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';

const ResponseSchema = Type.Object({ request: HumanRequestSchema }, { additionalProperties: false });
interface RequestState { items: readonly InboxItem[]; inboxError: string; loaded: boolean; pendingCount: number; unseenCount: number; error: string; requests: readonly HumanRequest[]; drafts: Readonly<Record<string, string>>; pending: ReadonlySet<string>; errors: Readonly<Record<string, string>> }
const EMPTY: RequestState = { items: [], inboxError: '', loaded: false, pendingCount: 0, unseenCount: 0, error: '', requests: [], drafts: {}, pending: new Set(), errors: {} };
export class TaskRequestsStore {
  private state: RequestState = EMPTY;
  private readonly listeners = new Set<() => void>();
  private read = 0;
  private inboxRead = 0;
  private dirty = new Set<string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private saving = new Map<string, Promise<void>>();
  private commands = new Map<string, { fingerprint: string; commandId: string }>();
  private command(id: string, input: unknown): string {
    const fingerprint = JSON.stringify(input);
    const previous = this.commands.get(id);
    if (previous?.fingerprint === fingerprint) return previous.commandId;
    const commandId = crypto.randomUUID();
    this.commands.set(id, { fingerprint, commandId });
    return commandId;
  }
  applyInbox = (item: InboxItem) => {
    const existing = this.state.items.find((value) => value.id === item.id);
    const state = existing && existing.state.revision > item.state.revision ? existing.state : item.state;
    const current = existing && (existing.revision > item.revision || (existing.status !== 'pending' && item.status === 'pending')) ? existing : item;
    const merged = { ...current, state };
    if (merged.human) this.apply(merged.human);
    this.replace({ ...this.state, items: [...this.state.items.filter((value) => value.id !== item.id), merged],
      drafts: this.dirty.has(item.id) ? this.state.drafts : { ...this.state.drafts, [item.id]: state.draft } });
  };
  refreshInbox = async () => {
    const read = ++this.inboxRead;
    try {
      let offset: number | null = 0;
      const items: InboxItem[] = [];
      let counts = { pendingCount: 0, unseenCount: 0 };
      do {
        const page: InboxList = await fetchJson(`/api/inbox?status=all&limit=100&offset=${offset}`, undefined, InboxListSchema);
        if (read !== this.inboxRead) return;
        items.push(...page.items); offset = page.nextOffset;
        counts = { pendingCount: page.pendingCount, unseenCount: page.unseenCount };
      } while (offset !== null);
      for (const item of items) this.applyInbox(item);
      this.replace({ ...this.state, ...counts, loaded: true, inboxError: '' });
    } catch (error) {
      if (read === this.inboxRead) this.replace({ ...this.state, inboxError: error instanceof Error ? error.message : 'Inbox 未读取。' });
      throw error;
    }
  };
  private stateWrite = async (id: string, input: { seen?: true; draft?: string }) => {
    const item = this.state.items.find((value) => value.id === id);
    if (!item) return;
    const result = await fetchJson<{ state: InboxState }>(`/api/inbox/${encodeURIComponent(id)}/state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: item.state.revision, ...input }) }, Type.Object({ state: InboxStateSchema }));
    const fresh = this.state.items.find((value) => value.id === id) ?? item;
    this.applyInbox({ ...fresh, state: result.state });
  };
  saveDraft = (id: string): Promise<void> => {
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    if (!this.state.items.some((item) => item.id === id)) return Promise.resolve();
    if (this.saving.has(id)) return this.saving.get(id)!;
    const save = async () => {
      try {
        while (this.dirty.has(id)) {
          const draft = this.state.drafts[id] ?? '';
          await this.stateWrite(id, { draft });
          if (this.state.drafts[id] === draft) { this.dirty.delete(id); this.backup(); }
        }
        this.replace({ ...this.state, errors: { ...this.state.errors, [id]: '' } });
      } catch (error) {
        this.replace({ ...this.state, errors: { ...this.state.errors, [id]: error instanceof Error ? error.message : '草稿未保存，请重试。' } });
        await this.refreshInbox().catch(() => undefined);
      } finally { this.saving.delete(id); }
    };
    const result = save(); this.saving.set(id, result); return result;
  };
  seen = async (id: string) => {
    if (this.state.items.find((item) => item.id === id)?.state.seen) return;
    await this.saveDraft(id);
    if (this.dirty.has(id)) return;
    try { await this.stateWrite(id, { seen: true }); await this.refreshInbox(); }
    catch { /* 查看写入失败仍保留未查看点，下次打开详情重试。 */ }
  };
  decideItem = async (item: InboxItem, decision: DecideHumanRequest['decision']) => {
    if (item.human && !item.authorization) { await this.decide(item.human, decision); await this.refreshInbox().catch(() => undefined); return; }
    if (this.state.pending.has(item.id)) return;
    const input = { revision: item.revision, decision, answer: this.state.drafts[item.id] ?? '' };
    this.replace({ ...this.state, pending: new Set([...this.state.pending, item.id]), errors: { ...this.state.errors, [item.id]: '' } });
    try {
      const result = await fetchJson<{ item: InboxItem }>(`/api/inbox/${encodeURIComponent(item.id)}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, commandId: this.command(item.id, input) }) }, Type.Object({ item: InboxItemSchema }));
      this.applyInbox(result.item);
    } catch (error) {
      this.replace({ ...this.state, errors: { ...this.state.errors, [item.id]: error instanceof Error ? error.message : '决定结果未知，请核对。' } });
    } finally {
      await this.refreshInbox().catch(() => undefined);
      this.replace({ ...this.state, pending: new Set([...this.state.pending].filter((id) => id !== item.id)) });
    }
  };
  constructor() {
    try {
      const saved: unknown = typeof sessionStorage === 'undefined' ? null : JSON.parse(sessionStorage.getItem('inbox-drafts') ?? 'null');
      if (saved && typeof saved === 'object') for (const [id, draft] of Object.entries(saved)) {
        if (typeof draft === 'string' && draft.length <= 4000) { this.dirty.add(id); this.state = { ...this.state, drafts: { ...this.state.drafts, [id]: draft } }; }
      }
    } catch { /* 本地恢复不可用时仍从服务端恢复已保存草稿。 */ }
  }
  private backup() {
    try { if (typeof sessionStorage !== 'undefined') sessionStorage.setItem('inbox-drafts', JSON.stringify(Object.fromEntries([...this.dirty].map((id) => [id, this.state.drafts[id]])))); }
    catch { /* 服务端保存失败会在请求卡明确提示。 */ }
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private replace(state: RequestState) { this.state = state; for (const listener of this.listeners) listener(); }
  apply = (request: HumanRequest) => {
    const existing = this.state.requests.find((item) => item.requestId === request.requestId);
    if (existing && (existing.revision > request.revision || (existing.status !== 'pending' && request.status === 'pending'))) return;
    const merged = existing?.stopConfirmed && !request.stopConfirmed ? { ...request, stopConfirmed: true } : request;
    this.replace({ ...this.state, requests: [...this.state.requests.filter((item) => item.requestId !== request.requestId), merged] });
  };
  refresh = async () => {
    const read = ++this.read;
    try {
      const requests: HumanRequest[] = [];
      let offset: number | null = 0;
      do {
        const result: HumanRequestList = await fetchJson(`/api/task-requests?limit=100&offset=${offset}`, undefined, HumanRequestListSchema);
        if (read !== this.read) return;
        requests.push(...result.requests);
        offset = result.nextOffset;
      } while (offset !== null);
      for (const request of requests) this.apply(request);
      this.replace({ ...this.state, error: '' });
    } catch (error) {
      if (read === this.read) this.replace({ ...this.state, error: error instanceof Error ? error.message : '人工请求未读取，请重试。' });
      throw error;
    }
  };
  draft = (id: string, answer: string) => {
    this.dirty.add(id);
    this.replace({ ...this.state, drafts: { ...this.state.drafts, [id]: answer } });
    this.backup();
    if (!this.state.items.some((item) => item.id === id)) return;
    clearTimeout(this.timers.get(id));
    this.timers.set(id, setTimeout(() => { void this.saveDraft(id); }, 300));
  };
  decide = async (request: HumanRequest, decision: DecideHumanRequest['decision']) => {
    if (this.state.pending.has(request.requestId)) return;
    this.replace({ ...this.state, pending: new Set([...this.state.pending, request.requestId]), errors: { ...this.state.errors, [request.requestId]: '' } });
    try {
      const result = await fetchJson<{ request: HumanRequest }>(`/api/task-requests/${encodeURIComponent(request.requestId)}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: this.command(request.requestId, { revision: request.revision, decision, answer: this.state.drafts[request.requestId] ?? '' }), revision: request.revision, decision, answer: this.state.drafts[request.requestId] ?? '' }) }, ResponseSchema);
      this.apply(result.request);
    } catch (error) {
      this.replace({ ...this.state, errors: { ...this.state.errors, [request.requestId]: error instanceof Error ? error.message : '回应未提交。' } });
      await this.refresh().catch(() => undefined);
    } finally { this.replace({ ...this.state, pending: new Set([...this.state.pending].filter((id) => id !== request.requestId)) }); }
  };
}
const Context = createContext<TaskRequestsStore | null>(null);
const noSubscription = () => () => undefined;
export function TaskRequestsProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new TaskRequestsStore());
  useEffect(() => { void store.refresh().catch(() => undefined); void store.refreshInbox().catch(() => undefined); }, [store]);
  useWorkbenchEvents((event) => {
    if (event.type === 'request.changed') store.apply(event.request);
    if (['inbox.changed', 'request.changed', 'workbench.connected', 'task.changed'].includes(event.type)) void store.refreshInbox().catch(() => undefined);
    if (event.type === 'workbench.connected' || event.type === 'task.changed') void store.refresh().catch(() => undefined);
  });
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useTaskRequests() {
  const store = useContext(Context);
  const state = useSyncExternalStore(store?.subscribe ?? noSubscription, store?.snapshot ?? (() => EMPTY));
  return { ...state, store };
}
