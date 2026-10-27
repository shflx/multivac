import { Type } from 'typebox';
import { ProjectIdSchema } from './project.js';

export const TERMINAL_LIMITS = {
  minCols: 10, maxCols: 240, minRows: 4, maxRows: 100,
  scrollback: 1000, frameBytes: 16 * 1024, pauseBytes: 256 * 1024,
  // 单窗口未确认输出上限：超过后暂停向该窗口发送，等它追上再补发当前画面，控制渲染延迟。
  resumeBytes: 64 * 1024, unacknowledgedBytes: 256 * 1024, snapshotTimeoutMillis: 2500,
} as const;
/**
 * 终端配色（浅色）：网页画面与服务端权威画面共用。服务端据此应答 CLI 的前景/背景色查询，
 * CLI 才会按浅色背景选择配色；两处必须一致。
 */
export const TERMINAL_THEME = {
  background: '#ffffff', foreground: '#1b2023', cursor: '#1b2023', cursorAccent: '#ffffff', selectionBackground: '#cfdae6',
  black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#7d4e00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
  brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
} as const;
export const TERMINAL_BODY_LIMIT_BYTES = 32 * 1024;
export const TERMINAL_TITLE_MAX_LENGTH = 80;
const Id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' });
const Timestamp = Type.String({ minLength: 1 });
const TextArgument = Type.String({ maxLength: 4096, pattern: '^[^\u0000]*$' });
const Argv = Type.Array(TextArgument, { maxItems: 64 });
const Title = Type.String({ minLength: 1, maxLength: TERMINAL_TITLE_MAX_LENGTH, pattern: '\\S' });
const Watermark = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const NullableText = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);
const Uuid = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });

/** 预设决定启动图标；不依据前台程序更新身份。argv 始终逐项保存，不能拼成未转义的 shell 文本。 */
export const TerminalPresetSchema = Type.Union([
  Type.Object({ kind: Type.Literal('blank') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('claude'), argv: Argv }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('codex'), argv: Argv }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal('custom'),
    executable: Type.String({ minLength: 1, maxLength: 4096, pattern: '^[^\u0000]*\\S[^\u0000]*$' }),
    argv: Argv,
  }, { additionalProperties: false }),
]);
export type TerminalPreset = Type.Static<typeof TerminalPresetSchema>;
export const TerminalCommandPresetsSchema = Type.Array(Type.Object({
  presetId: Id, title: Title,
  command: Type.Object({
    kind: Type.Literal('custom'), executable: Type.String({ minLength: 1, maxLength: 4096, pattern: '^[^\u0000]*\\S[^\u0000]*$' }), argv: Argv,
  }, { additionalProperties: false }),
}, { additionalProperties: false }), { maxItems: 32 });
export type TerminalCommandPresets = Type.Static<typeof TerminalCommandPresetsSchema>;

export const TerminalSizeSchema = Type.Object({
  cols: Type.Integer({ minimum: TERMINAL_LIMITS.minCols, maximum: TERMINAL_LIMITS.maxCols }),
  rows: Type.Integer({ minimum: TERMINAL_LIMITS.minRows, maximum: TERMINAL_LIMITS.maxRows }),
}, { additionalProperties: false });
export type TerminalSize = Type.Static<typeof TerminalSizeSchema>;

export const TerminalExitSchema = Type.Object({
  instanceId: Id,
  code: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  signal: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  reason: Type.Union([
    Type.Literal('process-exit'), Type.Literal('user-ended'), Type.Literal('project-removed'),
    Type.Literal('directory-removed'), Type.Literal('service-shutdown'), Type.Literal('multivac-restarted'), Type.Literal('spawn-failed'),
  ]),
  occurredAt: Timestamp,
}, { additionalProperties: false });
export type TerminalExit = Type.Static<typeof TerminalExitSchema>;
export const TerminalStatusSchema = Type.Union([
  Type.Literal('starting'), Type.Literal('running'), Type.Literal('stopping'),
  Type.Literal('stop-unconfirmed'), Type.Literal('exited'), Type.Literal('failed'),
]);
export type TerminalStatus = Type.Static<typeof TerminalStatusSchema>;

/** SQLite 仅保存这份元数据。无 PID、连接、正文、画面、输入或 ACK 水位。 */
export const ProjectTerminalSchema = Type.Object({
  terminalId: Id, projectId: ProjectIdSchema, instanceId: Id, title: Title,
  directory: Type.String({ minLength: 1, maxLength: 4096, pattern: '^/[^\u0000]*$' }),
  preset: TerminalPresetSchema, status: TerminalStatusSchema,
  lastExit: Type.Union([TerminalExitSchema, Type.Null()]),
  createdAt: Timestamp, instanceStartedAt: Timestamp, lastActivityAt: Timestamp,
  closedAt: Type.Union([Timestamp, Type.Null()]),
  unread: Type.Boolean(), notificationCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  /**
   * coding agent 的会话 ID，重开时据此接回同一会话；只是元数据，不读取会话内容。
   * Claude Code 由 Multivac 生成并以 --session-id 传入；Codex 由 Multivac 管理的 app-server 创建后取得。
   * 其他预设与自带会话参数的命令为 null（旧记录可缺省）。
   */
  agentSessionId: Type.Optional(Type.Union([Uuid, Type.Null()])),
}, { additionalProperties: false });
export type ProjectTerminal = Type.Static<typeof ProjectTerminalSchema>;
export const TerminalResponseSchema = Type.Object({ terminal: ProjectTerminalSchema }, { additionalProperties: false });
export const TerminalListResponseSchema = Type.Object({ terminals: Type.Array(ProjectTerminalSchema) }, { additionalProperties: false });

export const CreateTerminalSchema = Type.Object({
  projectId: ProjectIdSchema, directory: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, pattern: '^/[^\u0000]*$' })),
  preset: TerminalPresetSchema, title: Type.Optional(Title), size: TerminalSizeSchema,
}, { additionalProperties: false });
export type CreateTerminal = Type.Static<typeof CreateTerminalSchema>;
/** 浏览器同源 GET 可能不携带 Origin；终端读取也用带 JSON 正文的 POST，仍严格拒绝缺 Origin。 */
export const ListTerminalsSchema = Type.Object({
  projectId: ProjectIdSchema, includeClosed: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export const GetTerminalSchema = Type.Object({}, { additionalProperties: false });
export const RenameTerminalSchema = Type.Object({ title: Title }, { additionalProperties: false });
export const EndTerminalSchema = Type.Object({ instanceId: Id }, { additionalProperties: false });
export const CloseTerminalSchema = Type.Object({ instanceId: Id, confirmRunning: Type.Boolean() }, { additionalProperties: false });
/** resume：接回记录的 coding agent 会话（缺省）；new：开始新会话。不跟踪会话的终端忽略该项。 */
export const ReopenTerminalSchema = Type.Object({ instanceId: Id, size: TerminalSizeSchema, mode: Type.Optional(Type.Union([Type.Literal('resume'), Type.Literal('new')])) }, { additionalProperties: false });
export const ReadTerminalSchema = Type.Object({ instanceId: Id }, { additionalProperties: false });

/** HTTP/upgrade 通过本机守卫后才能读取列表或附着。每条客户端消息还必须绑定当前连接及进程实例。 */
const Connection = { instanceId: Id, connectionId: Id };
export const TerminalClientMessageSchema = Type.Union([
  Type.Object({ type: Type.Literal('input'), ...Connection, data: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('resize'), ...Connection, size: TerminalSizeSchema }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('takeover'), ...Connection, size: TerminalSizeSchema }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('ack'), ...Connection, watermark: Watermark }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('read'), ...Connection }, { additionalProperties: false }),
]);
export type TerminalClientMessage = Type.Static<typeof TerminalClientMessageSchema>;
const Base64 = Type.String({ maxLength: 12 * 1024, pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' });
export const TerminalServerMessageSchema = Type.Union([
  Type.Object({ type: Type.Literal('attached'), ...Connection, ownerConnectionId: NullableText }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('snapshot-begin'), ...Connection, snapshotId: Id, size: TerminalSizeSchema, watermark: Watermark, historyTrimmed: Type.Boolean() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('snapshot-data'), ...Connection, snapshotId: Id, offset: Watermark, data: Base64 }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('snapshot-end'), ...Connection, snapshotId: Id, watermark: Watermark }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('output'), ...Connection, from: Watermark, watermark: Watermark, data: Base64 }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('owner'), ...Connection, ownerConnectionId: NullableText, size: TerminalSizeSchema }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('exit'), ...Connection, exit: TerminalExitSchema }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('error'), ...Connection, code: Type.Union([Type.Literal('SNAPSHOT_TIMEOUT'), Type.Literal('SLOW_WINDOW'), Type.Literal('INVALID_MESSAGE'), Type.Literal('NOT_OWNER'), Type.Literal('STALE_INSTANCE')]), message: Type.String({ maxLength: 512 }) }, { additionalProperties: false }),
]);
export type TerminalServerMessage = Type.Static<typeof TerminalServerMessageSchema>;

/** 仅 process-exit、code 0 且无信号表示正常成功，重启/主动结束不据此推断成功。 */
export function terminalExitedSuccessfully(exit: TerminalExit): boolean {
  return exit.reason === 'process-exit' && exit.code === 0 && exit.signal === null;
}
export function terminalIsActive(status: TerminalStatus): boolean {
  return !['exited', 'failed'].includes(status);
}

/** 用户参数已自行指定会话（恢复、继续、指定 ID、分叉或非交互输出）时，Multivac 不再注入或跟踪会话 ID。 */
const CLAUDE_SESSION_FLAGS = new Set(['--resume', '-r', '--continue', '-c', '--session-id', '--fork-session', '--print', '-p']);
/** Codex 参数中出现子命令（恢复、分叉、非交互执行、管理命令等）时不跟踪会话。 */
const CODEX_SUBCOMMANDS = new Set(['resume', 'fork', 'exec', 'e', 'review', 'apply', 'a', 'login', 'logout', 'mcp', 'mcp-server', 'app-server', 'completion', 'sandbox', 'debug', 'cloud', 'features', 'agents', 'archive', 'unarchive', 'delete', 'queue', 'remote-control', 'migrate-rollouts', 'help']);

/** 是否由 Multivac 跟踪这个终端里 coding agent 的会话 ID，以便重开时接回同一会话。 */
export function agentSessionTrackable(preset: TerminalPreset): boolean {
  if (preset.kind === 'claude') return !preset.argv.some(arg => CLAUDE_SESSION_FLAGS.has(arg.split('=')[0]!));
  if (preset.kind === 'codex') return !preset.argv.some(arg => CODEX_SUBCOMMANDS.has(arg));
  return false;
}
