import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, opendirSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AssistantMessageView, ProjectTerminal } from '@multivac/contracts';
import { SessionTranscriptUnavailableError } from './session-transcripts.js';

// 所有磁盘工作都有界；超限明确失败，不将截断记录当作完整历史。
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 8;
type Json = Record<string, unknown>;
function object(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
}
function unavailable(message: string): never { throw new SessionTranscriptUnavailableError(message); }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

/** 仅识别完整的 Codex 启动包装；相同前缀的普通 Markdown 或未闭合标签仍是正文。 */
function codexBootstrap(text: string): boolean {
  const value = text.trim();
  if (/^# AGENTS\.md instructions for [^\n]+\n\s*<INSTRUCTIONS>\n[\s\S]+\n<\/INSTRUCTIONS>$/u.test(value)) return true;
  if (/^<environment_context>\n[\s\S]+\n<\/environment_context>$/u.test(value)) {
    return /<cwd>[^<\n]+<\/cwd>/u.test(value) && /<shell>[^<\n]+<\/shell>/u.test(value);
  }
  return /^<permissions instructions>\n[\s\S]+\n<\/permissions instructions>$/u.test(value) ||
    /^<user_instructions>\n[\s\S]+\n<\/user_instructions>$/u.test(value);
}

/** 只允许固定用户目录内的普通路径，不跟随文件或目录链接。 */
function checkedPath(path: string): string {
  const absolute = resolve(path);
  if (realpathSync(absolute) !== absolute) unavailable('CLI 记录路径包含链接，不能读取。');
  return absolute;
}

/** 只从受管理终端解析身份；home 仅供服务端装配和隔离 fixture 使用，不是工具参数。 */
export class TerminalTranscriptReader {
  constructor(private readonly options: { getTerminal(id: string): ProjectTerminal | undefined; home?: string }) {}

  readMessages(terminalId: string): AssistantMessageView[] { return this.readSnapshot(terminalId).messages; }

  readSnapshot(terminalId: string) {
    const terminal = this.options.getTerminal(terminalId);
    if (!terminal) return unavailable('没有这个受管理终端。');
    const kind = terminal.preset.kind;
    if (kind !== 'codex' && kind !== 'claude') return unavailable('此工具只支持已跟踪的 Codex 或 Claude Code 可见正文。');
    const id = terminal.agentSessionId;
    if (!id) return unavailable('终端没有已跟踪的 CLI 会话 ID，不能推断最近会话。');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(id)) return unavailable('终端记录中的 CLI 会话 ID 无效。');
    try {
      const path = this.locate(kind, id);
      return this.parse(path, kind, id);
    } catch (error) {
      if (error instanceof SessionTranscriptUnavailableError) throw error;
      // 不将磁盘路径、原始行或 CLI 记录中的其他字段带入错误。
      return unavailable('CLI 会话文件不可读取或不可解析。');
    }
  }

  private locate(kind: 'codex' | 'claude', id: string): string {
    const home = resolve(this.options.home ?? homedir());
    const roots = kind === 'codex' ? [join(home, '.codex', 'sessions'), join(home, '.codex', 'archived_sessions')] : [join(home, '.claude', 'projects')];
    const matches: string[] = [];
    let visited = 0;
    const walk = (directory: string, depth: number) => {
      let dir;
      try { dir = opendirSync(checkedPath(directory)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      try {
        for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
          if (++visited > MAX_ENTRIES) unavailable('CLI 会话目录超过扫描预算，不能可靠定位来源。');
          const path = join(directory, entry.name);
          if (entry.isDirectory()) {
            if (depth < (kind === 'claude' ? 1 : MAX_DEPTH)) walk(path, depth + 1);
            else if (kind === 'codex') unavailable('CLI 会话目录层级超过扫描预算。');
          } else if ((entry.name === `${id}.jsonl` && kind === 'claude' && depth === 1) ||
            (kind === 'codex' && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${id}.jsonl`))) {
            if (!entry.isFile()) unavailable('CLI 会话来源不是普通文件，不能读取。');
            matches.push(checkedPath(path));
            if (matches.length > 1) unavailable('CLI 会话存在多个文件来源，不能混拼；请核对来源后重新定位。');
          }
        }
      } finally { dir.closeSync(); }
    };
    for (const root of roots) walk(root, 0);
    if (!matches.length) unavailable('没有找到已跟踪 CLI 会话的 JSONL 文件，CLI 可能尚未保存记录。');
    return matches[0]!;
  }

  private parse(path: string, kind: 'codex' | 'claude', id: string) {
    const fd = openSync(checkedPath(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      if (!before.isFile()) unavailable('CLI 会话来源不是普通文件。');
      if (before.size > MAX_FILE_BYTES) unavailable('CLI 会话文件超过读取预算。');
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
        if (!count) unavailable('CLI 会话文件在读取时被截断，请重新定位。');
        offset += count;
      }
      const messages: AssistantMessageView[] = [];
      const branchEntryIds: string[] = [];
      const bootstrapEntries = new Set<string>();
      const userEventTexts = new Set<string>();
      let bootstrapPhase = true;
      let start = 0, lines = 0, identified = false;
      const runtimeSessionId = digest(`${kind}:${id}:${path}:${before.dev}:${before.ino}:${before.birthtimeMs}`);
      while (start < bytes.length) {
        if (++lines > MAX_ENTRIES) unavailable('CLI 会话记录条数超过读取预算。');
        const newline = bytes.indexOf(10, start);
        const end = newline < 0 ? bytes.length : newline;
        if (end - start > MAX_LINE_BYTES) unavailable('CLI 会话单条记录超过读取预算。');
        let raw: string;
        let entry: Json | null;
        try {
          raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, end));
          start = end + 1;
          if (!raw.trim()) continue;
          entry = object(JSON.parse(raw));
        } catch {
          // CLI 正在追加时，只忽略末尾尚未写完的一行；已完成行损坏时拒绝整次读取。
          if (newline < 0) break;
          return unavailable('CLI 会话 JSONL 存在不可解析的完整记录。');
        }
        if (!entry) unavailable('CLI 会话记录格式不可解析。');
        branchEntryIds.push(digest(raw));
        let role: 'user' | 'assistant' | null = null, text = '';
        if (kind === 'codex') {
          if (!identified) {
            if (lines !== 1 || entry.type !== 'session_meta' || object(entry.payload)?.id !== id) unavailable('Codex 首行 session_meta.id 与受管理会话不匹配。');
            identified = true;
          }
          if (entry.type === 'session_meta' && object(entry.payload)?.id !== id) unavailable('Codex 会话身份发生变化，请重新定位。');
          const payload = object(entry.payload);
          // event 只佐证用户来源，不作为正文来源，也不重复收集镜像。
          if (entry.type === 'event_msg' && payload?.type === 'user_message' && typeof payload.message === 'string') {
            userEventTexts.add(payload.message);
            bootstrapPhase = false;
          }
          // response_item 是唯一正文来源；event_msg 的镜像文本不重复收集。
          if (entry.type === 'response_item' && payload?.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
            role = payload.role;
            if (Array.isArray(payload.content)) text = payload.content.flatMap(block => {
              const item = object(block);
              return item?.type === (role === 'user' ? 'input_text' : 'output_text') && typeof item.text === 'string' ? [item.text] : [];
            }).join('\n');
            // 启动阶段的完整包装可能由 CLI 注入；末尾再结合 user_message 佐证决定是否排除。
            if (role === 'user' && bootstrapPhase && codexBootstrap(text)) bootstrapEntries.add(`line-${lines}`);
            else if (text) bootstrapPhase = false;
          }
        } else {
          if (entry.sessionId !== undefined && entry.sessionId !== id) unavailable('Claude Code sessionId 与受管理会话不匹配。');
          const message = object(entry.message);
          if ((entry.type === 'user' || entry.type === 'assistant') && entry.sessionId === id && message?.role === entry.type) {
            identified = true;
            if (entry.isMeta !== true && entry.isSidechain !== true) {
              role = entry.type;
              if (typeof message.content === 'string') text = message.content;
              else if (Array.isArray(message.content)) text = message.content.flatMap(block => {
                const item = object(block);
                return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
              }).join('\n');
            }
          }
        }
        if (role && text) messages.push({ id: `line-${lines}`, runtimeEntryId: `line-${lines}`, runtimeSessionId, role, text,
          createdAt: typeof entry.timestamp === 'string' ? entry.timestamp.slice(0, 80) || 'unknown' : 'unknown' });
      }
      if (!identified) unavailable('CLI 会话尚无可核对身份的受支持记录，文件为空、写入未完成或格式不可解析。');
      const after = fstatSync(fd);
      const current = statSync(checkedPath(path));
      if (after.size < before.size || after.dev !== current.dev || after.ino !== current.ino ||
        (after.size === before.size && after.mtimeMs !== before.mtimeMs)) unavailable('CLI 会话文件在读取时发生变化，请重新定位。');
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        // 追加允许继续，但已采样的前缀必须仍然逐字节相同。
        const chunk = Buffer.alloc(64 * 1024);
        for (let position = 0; position < bytes.length;) {
          const count = readSync(fd, chunk, 0, Math.min(chunk.length, bytes.length - position), position);
          if (!count || !chunk.subarray(0, count).equals(bytes.subarray(position, position + count))) unavailable('CLI 会话文件在读取时发生变化，请重新定位。');
          position += count;
        }
      }
      return { runtimeSessionId, leafEntryId: null,
        messages: messages.filter(message => !bootstrapEntries.has(message.id) || userEventTexts.has(message.text)), branchEntryIds };
    } finally { closeSync(fd); }
  }
}
