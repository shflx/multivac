import { useEffect, useState } from 'react';
import { MessageSquare, BookOpen } from 'lucide-react';
import type { BookSummary, ReadingDiscussion, WorkspaceSession } from '@multivac/contracts';
import { listBooks, listReadingDiscussions } from '../../data/reading-api.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { useWorkspaceSessions } from '../workspace/workspace-sessions-provider.js';

export function ConversationsPage({ active, openReading, openWork }: { active: boolean; openReading: (bookId: string, sessionId: string) => void; openWork: (session: WorkspaceSession) => void }) {
  const work = useWorkspaceSessions();
  const [discussions, setDiscussions] = useState<ReadingDiscussion[]>([]);
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [error, setError] = useState('');
  async function refresh() {
    try { const library = await listBooks(); setBooks(library.books); const all = await listReadingDiscussions(); setDiscussions(all.discussions); setError(''); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { if (active) { void refresh(); void work.ensureLoaded().catch(e => setError((e as Error).message)); } }, [active]);
  useWorkbenchEvents(event => { if (active && (event.type === 'reading.changed' || event.type === 'workbench.connected')) void refresh(); });
  const sessions = work.sessions?.filter(s => !s.archivedAt && !s.host) ?? [];
  return <section className="reading-conversations">{error && <p role="alert">{error}</p>}<table><thead><tr><th>会话</th><th>类型</th><th>来源</th><th>创建时间</th></tr></thead><tbody>
    {sessions.map(s => <tr key={s.sessionId}><td><button onClick={() => openWork(s)}><MessageSquare size={16} />{s.title}</button></td><td>工作</td><td>{s.workspaceId === 'default' ? '默认工作区' : '项目工作区'}</td><td>{new Date(s.createdAt).toLocaleDateString()}</td></tr>)}
    {discussions.map(d => { const book = books.find(b => b.id === d.bookId); return <tr key={d.sessionId}><td><button disabled={!book} onClick={() => openReading(d.bookId, d.sessionId)}><BookOpen size={16} />{d.title}</button></td><td>伴随</td><td>{book?.title ?? '书籍已失效'}{d.parentSessionId && ' · 独立讨论'}</td><td>{new Date(d.createdAt).toLocaleDateString()}</td></tr>; })}
  </tbody></table>{!sessions.length && !discussions.length && <p>暂无会话</p>}</section>;
}
