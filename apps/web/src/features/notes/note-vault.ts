import { newCommandId } from '../../data/command-id.js';
import { noteSecurityRequest } from '../../data/note-security-api.js';
import type { KeyValueStorage } from '../assistant/session-persistence.js';

interface Contents { local: Record<string, string>; session: Record<string, string> }
interface Vault { id: string; key: string; contents: Contents; pending: Promise<void>; error: string; writing: number; revision: number }
const vaults = new Map<string, Vault>();
const prefix = (id: string) => `multivac:note-vault:${id}:`;
const pointer = (id: string) => `multivac:note-vault-pointer:${id}`;
export const protectionMarker = (id: string) => `multivac:note-protected:${id}`;
export const vaultReady = (id: string) => vaults.has(id);

async function transform(noteId: string, id: string, action: 'seal' | 'open', content: unknown): Promise<unknown> {
  return (await noteSecurityRequest<{ content: unknown }>(`/api/notes/${encodeURIComponent(noteId)}/vault`, 'POST', { id, action, content })).content;
}
export async function prepareNoteVault(noteId: string) {
  if (vaults.has(noteId)) return;
  const previous = sessionStorage.getItem(pointer(noteId));
  let contents: Contents = { local: {}, session: {} };
  if (previous) {
    const raw = localStorage.getItem(prefix(noteId) + previous);
    if (!raw) throw new Error('加密草稿记录缺失，请保持其他窗口打开并核对浏览器存储。');
    if (raw) {
      const decoded = JSON.parse(String(await transform(noteId, previous, 'open', JSON.parse(raw)))) as Contents;
      if (!decoded || !decoded.local || !decoded.session || Object.values({ ...decoded.local, ...decoded.session }).some(value => typeof value !== 'string')) throw new Error('加密草稿格式无效，原密文已保留。');
      contents = decoded;
    }
  }
  const id = newCommandId();
  const vault: Vault = { id, key: prefix(noteId) + id, contents, pending: Promise.resolve(), error: '', writing: 0, revision: 0 };
  vaults.set(noteId, vault);
  try {
    persist(noteId, vault); await flushNoteVault(noteId); sessionStorage.setItem(pointer(noteId), id);
    // 复制标签页仍可能引用旧包；只追加当前窗口的新包，不删除其他窗口的恢复来源。
  } catch (error) { vaults.delete(noteId); throw error; }
}
function notifyVault() { if (typeof window !== 'undefined') window.dispatchEvent(new Event('note-vault-changed')); }
export function noteVaultStatus(id: string) { const vault = vaults.get(id); return vault?.error ? `加密草稿未保存：${vault.error}` : vault?.writing ? '加密草稿保存中…' : '加密草稿已保存'; }
function persist(noteId: string, vault: Vault) {
  vault.revision++;
  if (vault.writing) return;
  vault.writing = 1; notifyVault();
  vault.pending = (async () => {
    let written = -1;
    while (written !== vault.revision) {
      const revision = vault.revision, content = JSON.stringify(vault.contents);
      const cipher = await transform(noteId, vault.id, 'seal', content);
      localStorage.setItem(vault.key, JSON.stringify(cipher)); vault.error = ''; written = revision;
    }
  })().catch(error => { vault.error = (error as Error).message; }).finally(() => { vault.writing = 0; notifyVault(); });
}
export async function flushNoteVault(noteId: string) {
  const vault = vaults.get(noteId); if (!vault) return;
  await vault.pending;
  if (vault.error) throw new Error(`加密草稿尚未保存：${vault.error}。请保持页面打开。`);
}
export async function retryNoteVault(noteId: string) { const vault = vaults.get(noteId); if (vault) persist(noteId, vault); await flushNoteVault(noteId); }
export async function flushAllNoteVaults() { await Promise.all([...vaults.keys()].map(flushNoteVault)); }
export function noteVaultStorage(noteId: string, kind: 'local' | 'session'): KeyValueStorage {
  const vault = vaults.get(noteId);
  if (!vault) throw new Error('请先解锁并恢复加密草稿。');
  return {
    getItem: key => vault.contents[kind][key] ?? null,
    setItem: (key, value) => { vault.contents[kind][key] = value; persist(noteId, vault); },
    removeItem: key => { if (key in vault.contents[kind]) { delete vault.contents[kind][key]; persist(noteId, vault); } },
  };
}
export function clearNoteVaultMemory(noteId: string) {
  const vault = vaults.get(noteId);
  if (vault && !vault.writing && !vault.error) { vault.contents = { local: {}, session: {} }; vaults.delete(noteId); }
}

/** 转换前拒绝丢弃其他挂载的未保存正文；旧控制器同时通过共享标记停止明文写回。 */
export function assertNoOrdinaryDrafts(noteId: string) {
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith('multivac:note-draft:')) continue;
    let draft: any; try { draft = JSON.parse(localStorage.getItem(key)!); } catch { throw new Error('存在无法核对的本机草稿，请先处理浏览器存储。'); }
    if (draft?.base?.id === noteId && (draft.pending || draft.title !== draft.base.title || draft.body !== draft.base.body)) throw new Error('本机还有此笔记的未保存草稿，请在对应窗口保存或核对后再加密。');
  }
}
export async function migrateOrdinaryDrafts(noteId: string, sessionIds: string[]) {
  const local = noteVaultStorage(noteId, 'local'), session = noteVaultStorage(noteId, 'session');
  const localKeys: string[] = [], sessionKeys: string[] = [];
  for (const key of Object.keys(localStorage)) {
    if (sessionIds.some(id => key.endsWith(`:${id}`)) || key.startsWith(`multivac:note-plain-vault:${noteId}:`)) { local.setItem(key, localStorage.getItem(key)!); localKeys.push(key); continue; }
    if (!key.startsWith('multivac:note-draft:')) continue;
    const raw = localStorage.getItem(key)!; const value = JSON.parse(raw);
    if (value?.base?.id === noteId) { local.setItem(key, raw); localKeys.push(key); }
  }
  for (const key of Object.keys(sessionStorage)) {
    if (key === `multivac:note-draft-pointer:${noteId}` || sessionIds.some(id => key.endsWith(`:${id}`))) {
      session.setItem(key, sessionStorage.getItem(key)!); sessionKeys.push(key);
    }
  }
  await flushNoteVault(noteId);
  for (const key of localKeys) localStorage.removeItem(key);
  for (const key of sessionKeys) sessionStorage.removeItem(key);
}
export async function restoreOrdinaryDrafts(noteId: string) {
  for (const key of Object.keys(localStorage).filter(key => key.startsWith(prefix(noteId)))) {
    const id = key.slice(prefix(noteId).length), raw = localStorage.getItem(key)!;
    const content = JSON.parse(String(await transform(noteId, id, 'open', JSON.parse(raw)))) as Contents;
    // 各窗口只恢复自己当前指针引用的包，历史密文不能重新变成活动的旧草稿。
    localStorage.setItem(`multivac:note-plain-vault:${noteId}:${id}`, JSON.stringify(content));
  }
  restoreOwnOrdinaryVault(noteId);
}
export function restoreOwnOrdinaryVault(noteId: string) {
  const id = sessionStorage.getItem(pointer(noteId)); if (!id) return;
  const key = `multivac:note-plain-vault:${noteId}:${id}`, raw = localStorage.getItem(key); if (!raw) return;
  const content = JSON.parse(raw) as Contents;
  const currentDraft = content.session[`multivac:note-draft-pointer:${noteId}`];
  for (const [name, value] of Object.entries(content.local)) if (!name.startsWith('multivac:note-draft:') || name === currentDraft) localStorage.setItem(name, value);
  for (const [name, value] of Object.entries(content.session)) sessionStorage.setItem(name, value);
  sessionStorage.removeItem(pointer(noteId)); localStorage.removeItem(key);
}
if (typeof window !== 'undefined') window.addEventListener('beforeunload', event => {
  if ([...vaults.values()].some(vault => vault.writing || vault.error)) { event.preventDefault(); event.returnValue = ''; }
});

interface PeerDraft { window: string; id: string; contents: Contents; keys: string[] }
const pageId = newCommandId();
const windowPrefix = 'multivac:note-browser-window:';
const channel = typeof window === 'undefined' || typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('multivac-note-conversion');
const requests = new Map<string, (value: PeerDraft) => void>();
const peerCleanups = new Map<string, { noteId: string; id: string; keys: string[] }>();
let pageLockReady = Promise.resolve();
let releasePageLock: (() => void) | undefined;
if (typeof window !== 'undefined') {
  const register = () => {
    if (navigator.locks) {
      pageLockReady = new Promise<void>((resolve, reject) => {
        void navigator.locks.request(windowPrefix + pageId, async () => {
          resolve(); await new Promise<void>(release => { releasePageLock = release; });
        }).catch(reject);
      });
    } else localStorage.setItem(windowPrefix + pageId, 'active');
  };
  register();
  window.addEventListener('pageshow', event => { if (event.persisted) register(); });
  window.addEventListener('pagehide', () => { releasePageLock?.(); releasePageLock = undefined; localStorage.removeItem(windowPrefix + pageId); });
  if (channel) channel.onmessage = event => {
    const value = event.data;
    if (value?.type === 'collect' && value.window !== pageId && typeof value.request === 'string' && Array.isArray(value.sessions)) {
      window.dispatchEvent(new CustomEvent('note-security-freeze', { detail: value.noteId }));
      setTimeout(() => {
        const existing = vaults.get(value.noteId);
        const contents: Contents = existing ? JSON.parse(JSON.stringify(existing.contents)) as Contents : { local: {}, session: {} };
        const keys: string[] = [];
        for (const key of Object.keys(sessionStorage)) {
          if (key === `multivac:note-draft-pointer:${value.noteId}` || value.sessions.some((id: string) => key.endsWith(`:${id}`))) { contents.session[key] = sessionStorage.getItem(key)!; keys.push(key); }
        }
        // 各窗口的正文草稿使用独立键；复制进独立密文包，保留它自己的指针。
        for (const key of Object.keys(localStorage)) if (value.sessions.some((id: string) => key.endsWith(`:${id}`))) contents.local[key] = localStorage.getItem(key)!;
        for (const key of Object.keys(localStorage)) if (key.startsWith('multivac:note-draft:')) {
          const raw = localStorage.getItem(key)!; try { if (JSON.parse(raw)?.base?.id === value.noteId) contents.local[key] = raw; } catch {}
        }
        const id = newCommandId(); peerCleanups.set(value.request, { noteId: value.noteId, id, keys });
        channel.postMessage({ type: 'collected', request: value.request, draft: { window: pageId, id, contents, keys } });
      }, 0);
    } else if (value?.type === 'collected') requests.get(value.request)?.(value.draft);
    else if (value?.type === 'sealed' && value.window === pageId) {
      const pending = peerCleanups.get(value.request);
      if (!pending || !localStorage.getItem(prefix(pending.noteId) + pending.id)) return;
      sessionStorage.setItem(pointer(pending.noteId), pending.id);
      for (const key of pending.keys) sessionStorage.removeItem(key);
      peerCleanups.delete(value.request);
      channel.postMessage({ type: 'cleaned', request: value.request, draft: { window: pageId } });
    } else if (value?.type === 'cleaned') requests.get(value.request)?.(value.draft);
  };
}
export async function collectPeerDrafts(noteId: string, sessions: string[]): Promise<{ request: string; drafts: PeerDraft[] }> {
  await pageLockReady;
  // Web Locks 随真实页面生命周期释放；后台暂停的窗口仍持有锁，不能因心跳变旧而跳过。
  const windows = navigator.locks ? (await navigator.locks.query()).held?.map(lock => lock.name ?? '') ?? [] : Object.keys(localStorage);
  const peers = windows.filter(key => key.startsWith(windowPrefix) && key !== windowPrefix + pageId).map(key => key.slice(windowPrefix.length));
  const request = newCommandId();
  if (!peers.length) return { request, drafts: [] };
  if (!channel) throw new Error('当前浏览器无法协调其他窗口，请关闭其他笔记窗口后再加密。');
  const drafts = await new Promise<PeerDraft[]>((resolve, reject) => {
    const received = new Map<string, PeerDraft>();
    const timer = setTimeout(() => { requests.delete(request); reject(new Error('其他窗口尚未完成草稿核对，请先激活对应窗口再重试。')); }, 5000);
    requests.set(request, draft => { if (!peers.includes(draft.window)) return; received.set(draft.window, draft); if (received.size === peers.length) { clearTimeout(timer); requests.delete(request); resolve([...received.values()]); } });
    channel.postMessage({ type: 'collect', request, window: pageId, noteId, sessions });
  });
  return { request, drafts };
}
export async function protectPeerDrafts(noteId: string, peers: { request: string; drafts: PeerDraft[] }) {
  if (!peers.drafts.length || !channel) return;
  for (const draft of peers.drafts) {
    const cipher = await transform(noteId, draft.id, 'seal', JSON.stringify(draft.contents));
    localStorage.setItem(prefix(noteId) + draft.id, JSON.stringify(cipher));
  }
  await new Promise<void>((resolve, reject) => {
    const remaining = new Set(peers.drafts.map(draft => draft.window));
    const timer = setTimeout(() => { requests.delete(peers.request); reject(new Error('密文草稿已保存，其他窗口尚未确认清理。请保持窗口打开并重试核对。')); }, 5000);
    requests.set(peers.request, draft => { remaining.delete(draft.window); if (!remaining.size) { clearTimeout(timer); requests.delete(peers.request); resolve(); } });
    for (const draft of peers.drafts) channel.postMessage({ type: 'sealed', request: peers.request, window: draft.window });
  });
}
