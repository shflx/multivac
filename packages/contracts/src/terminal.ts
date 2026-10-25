import { Type } from 'typebox';
import { ProjectIdSchema } from './project.js';

export const TERMINAL_LIMITS = {
  minCols: 10, maxCols: 240, minRows: 4, maxRows: 100,
  scrollback: 1000, frameBytes: 16 * 1024, pauseBytes: 256 * 1024,
  resumeBytes: 64 * 1024, unacknowledgedBytes: 256 * 1024, snapshotTimeoutMillis: 2500,
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
export const ReopenTerminalSchema = Type.Object({ instanceId: Id, size: TerminalSizeSchema }, { additionalProperties: false });
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
