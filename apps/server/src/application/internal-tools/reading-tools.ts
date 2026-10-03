import { Type } from 'typebox';
import { BookPositionSchema, multivacObjectLink, positionRank } from '@multivac/contracts';
import { defineInternalTool } from './internal-tool-service.js';
import { InternalToolError } from '../../modules/internal-tools/internal-tool.js';

const Id = Type.String({ minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' });
export const listBooksTool = defineInternalTool({ name: 'list_books', effect: 'query', description: '列出真实书架的书籍身份、标题、作者和版本，不读取正文，不改变资料权限。', parameters: Type.Object({}, { additionalProperties: false }), async execute(_input, { services }) {
  if (!services.reading) throw new InternalToolError('书架查询不可用。');
  const books = services.reading.list().slice(0, 50);
  return { content: books.map(b => `${JSON.stringify(b)} [打开书籍](${multivacObjectLink('book', b.id)})`).join('\n') || '书架为空。', result: { summary: `${books.length} 本书籍（最多列出 50 本）`, refs: [] } };
} });
export const getBookTool = defineInternalTool({ name: 'get_book', effect: 'query', description: '核对书籍身份、版本和目录信息，不提供正文。书籍来源只能随用户引用传入，不能借查询自动读入整书。', parameters: Type.Object({ bookId: Id }, { additionalProperties: false }), async execute(input, { services }) {
  if (!services.reading) throw new InternalToolError('书架查询不可用。');
  let book; try { book = services.reading.get(input.bookId); } catch { throw new InternalToolError('书籍不存在或已失效。'); }
  return { content: JSON.stringify({ id: book.id, version: book.version, title: book.title, author: book.author, chapters: book.chapters.slice(0, 50).map(c => ({ id: c.id, title: c.title, paragraphCount: c.paragraphs.length })), chapterCount: book.chapters.length }), result: { summary: `已核对书籍「${book.title}」`.slice(0, 120), refs: [] } };
} });
export const openBookTool = defineInternalTool({ name: 'open_book', effect: 'manage', changesView: true, description: '只在用户明确要求打开书籍或定位原文时，切换发起窗口到读书应用。可带已核对版本和位置；不推进已读范围，不发送模型消息，不改变其他窗口或项目权限。', parameters: Type.Object({ bookId: Id, version: Type.Optional(Type.String()), position: Type.Optional(BookPositionSchema) }, { additionalProperties: false }), async execute(input, context) {
  const { services, originWindowId, origin } = context;
  if (!services.reading) throw new InternalToolError('书籍导航不可用。');
  let book; try { book = services.reading.get(input.bookId); } catch { throw new InternalToolError('书籍不存在或已失效。'); }
  if (input.position && (input.version !== book.version || positionRank(book, input.position) < 0)) throw new InternalToolError('原文位置或版本已失效，未打开错误位置。');
  const selection = { kind: 'book' as const, bookId: book.id, ...(input.position ? { position: input.position, version: book.version } : {}) };
  if (!originWindowId || !services.windows.navigate(originWindowId, { kind: 'management', page: 'reading', selection }, origin)) throw new InternalToolError('发起窗口不可达，书籍未打开。');
  context.noteOriginView({ ...(context.originView ?? { narrow: false, workspace: null }), panel: 'management', management: { page: 'reading', selection } });
  return { content: `已请求发起窗口打开 [书籍](${multivacObjectLink('book', book.id)})，未推进已读范围。`, result: { summary: `已打开书籍「${book.title}」`.slice(0, 120), refs: [] } };
} });
export const READING_TOOLS = [listBooksTool, getBookTool, openBookTool];
