import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Type } from 'typebox';
import { HumanRequestSchema, type HumanRequest, type DecideHumanRequest } from '@multivac/contracts';
import { fetchJson } from '../../data/assistant-api.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';

const ListSchema = Type.Object({ requests: Type.Array(HumanRequestSchema, { maxItems: 100 }) }, { additionalProperties: false });
const ResponseSchema = Type.Object({ request: HumanRequestSchema }, { additionalProperties: false });
interface RequestState { requests: readonly HumanRequest[]; drafts: Readonly<Record<string, string>>; pending: ReadonlySet<string>; errors: Readonly<Record<string, string>> }
const EMPTY: RequestState = { requests: [], drafts: {}, pending: new Set(), errors: {} };
export class TaskRequestsStore {
  private state: RequestState = EMPTY;
  private readonly listeners = new Set<() => void>();
  private read = 0;
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
    const result = await fetchJson<{ requests: HumanRequest[] }>('/api/task-requests', undefined, ListSchema);
    if (read !== this.read) return;
    for (const request of result.requests) this.apply(request);
  };
  draft = (id: string, answer: string) => this.replace({ ...this.state, drafts: { ...this.state.drafts, [id]: answer } });
  decide = async (request: HumanRequest, decision: DecideHumanRequest['decision']) => {
    if (this.state.pending.has(request.requestId)) return;
    this.replace({ ...this.state, pending: new Set([...this.state.pending, request.requestId]), errors: { ...this.state.errors, [request.requestId]: '' } });
    try {
      const result = await fetchJson<{ request: HumanRequest }>(`/api/task-requests/${encodeURIComponent(request.requestId)}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: crypto.randomUUID(), revision: request.revision, decision, answer: this.state.drafts[request.requestId] ?? '' }) }, ResponseSchema);
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
  useEffect(() => { void store.refresh().catch(() => undefined); }, [store]);
  useWorkbenchEvents((event) => {
    if (event.type === 'request.changed') store.apply(event.request);
    if (event.type === 'workbench.connected' || event.type === 'task.changed') void store.refresh().catch(() => undefined);
  });
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useTaskRequests() {
  const store = useContext(Context);
  const state = useSyncExternalStore(store?.subscribe ?? noSubscription, store?.snapshot ?? (() => EMPTY));
  return { ...state, store };
}
