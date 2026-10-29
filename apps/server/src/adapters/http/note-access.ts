import type { IncomingMessage, ServerResponse } from 'node:http';
import { NOTE_GRANTS_HEADER, NOTE_WINDOW_HEADER, type NoteAccess, type AssistantPublicEvent, type WorkbenchEvent } from '@multivac/contracts';
import type { NoteRecordCodec } from '../../storage/note-record-codec.js';
import type { NoteSecurityService } from '../../application/note-security-service.js';
import { NotesError } from '../../modules/notes/note.js';
import { noteRequestAccess } from './note-security-routes.js';

/** 请求资格与事件连接资格分别固定，发布者的异步调用上下文不能授权订阅者。 */
export class NoteHttpAccess {
  private readonly streamGrants = new WeakMap<IncomingMessage, ReadonlyMap<string, NoteAccess>>();
  constructor(private readonly codec: NoteRecordCodec, private readonly security: NoteSecurityService) {}
  private grants(request: IncomingMessage): ReadonlyMap<string, NoteAccess> {
    const cached = this.streamGrants.get(request); if (cached) return cached;
    const result = new Map<string, NoteAccess>();
    const raw = request.headers[NOTE_GRANTS_HEADER], window = request.headers[NOTE_WINDOW_HEADER];
    if (raw !== undefined) {
      if (typeof raw !== 'string' || raw.length > 12_000 || typeof window !== 'string') throw new NotesError('事件流解锁凭证无效。');
      let value: unknown; try { value = JSON.parse(raw); } catch { throw new NotesError('事件流解锁凭证无效。'); }
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 64) throw new NotesError('事件流解锁凭证无效。');
      for (const [noteId, token] of Object.entries(value)) {
        if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(noteId) || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new NotesError('事件流解锁凭证无效。');
        result.set(noteId, { token, window });
      }
    }
    this.streamGrants.set(request, result); return result;
  }
  private noteId(path: string): string | undefined {
    const note = /^\/api\/notes\/([^/]+)(?:\/|$)/u.exec(path);
    if (note) return decodeURIComponent(note[1]!);
    const session = /^\/api\/sessions\/([^/]+)(?:\/|$)/u.exec(path);
    return session ? this.codec.owner(decodeURIComponent(session[1]!)) : undefined;
  }
  private deleted(noteId: string): boolean {
    return !!this.codec.database.prepare("SELECT id FROM app_note WHERE id=? AND json_extract(record_json,'$.deleted')=1").get(noteId);
  }
  async run(request: IncomingMessage, response: ServerResponse, operation: () => Promise<void>): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/api/events') return this.codec.runMany(this.grants(request), operation);
    const noteId = this.noteId(path);
    if (noteId && this.deleted(noteId) && !(request.method === 'DELETE' && /^\/api\/notes\/[^/]+$/u.test(path))) throw new NotesError('笔记已删除。', 404);
    const securityPath = /^\/api\/notes\/[^/]+\/(?:unlock|lock|activity|access|protection)$/u.test(path);
    return this.codec.run(noteId ? noteRequestAccess(request) : undefined, async () => {
      if (noteId && !securityPath) this.codec.assert(noteId);
      const writeHead = response.writeHead;
      // 异步操作返回前重查当前状态，不能把早先算好的明文交给已失效的窗口。
      if (noteId && !securityPath) response.writeHead = function (this: ServerResponse, ...args: Parameters<ServerResponse['writeHead']>) {
        response.writeHead = writeHead;
        if (Number(args[0]) < 400) {
          if (thisAccess.deleted(noteId) && request.method !== 'DELETE') throw new NotesError('笔记已删除。', 404);
          thisAccess.codec.assert(noteId);
        }
        return writeHead.apply(this, args);
      } as ServerResponse['writeHead'];
      const thisAccess = this;
      await operation();
    });
  }
  allowEvent(request: IncomingMessage, event: AssistantPublicEvent): boolean {
    const owner = this.codec.owner(event.assistantSessionId);
    if (owner && this.deleted(owner)) return false;
    if (!owner || !this.codec.state(owner)) return true;
    try { this.security.assertAccess(owner, this.grants(request).get(owner)); return this.codec.state(owner) === 'encrypted'; }
    catch { return false; }
  }
  allowWorkbench(event: WorkbenchEvent): boolean {
    return event.type !== 'session.changed' || !this.codec.state(this.codec.owner(event.session.sessionId) ?? '');
  }
  bindStream(request: IncomingMessage, close: () => void): () => void {
    const grants = this.grants(request);
    return this.security.onRevoke((noteId, token) => { if (grants.get(noteId)?.token === token) close(); });
  }
}
