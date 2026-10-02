import { Type } from 'typebox';
import { SessionFileReferenceSchema } from './session-files.js';
import { AssistantToolResultSchema, internalToolDisplay } from './internal-tools.js';
import { ToolAuthorizationApprovalSchema, ToolAuthorizationStatusSchema } from './tool-authorization-status.js';

export const GLOBAL_ASSISTANT_SESSION_ID = 'global-coordinator';
export const ASSISTANT_SESSION_DEFAULT_LIMIT = 30;
export const ASSISTANT_SESSION_MAX_LIMIT = 100;
export const ASSISTANT_PAGE_STATE_BODY_LIMIT_BYTES = 16 * 1024;
export const ASSISTANT_DRAFT_MAX_UTF8_BYTES = 12 * 1024;

const NonEmptyString = Type.String({ minLength: 1 });
const EntryId = Type.String({ minLength: 1, maxLength: 512 });
const NullableEntryId = Type.Union([EntryId, Type.Null()]);
const Draft = Type.String({ maxLength: ASSISTANT_DRAFT_MAX_UTF8_BYTES });

export const PiMessageReferenceSchema = Type.Object(
  {
    piSessionId: EntryId,
    piEntryId: EntryId,
  },
  { additionalProperties: false },
);

export type PiMessageReference = Type.Static<typeof PiMessageReferenceSchema>;

export const ASSISTANT_QUOTE_MAX_UTF8_BYTES = 4 * 1024;

const quoteEncoder = new TextEncoder();

/**
 * 引用快照同时携带来源身份与当时的可见文本。
 * 正文按用户所见原样保存，保留换行与有意义空白；来源身份用于服务端校验归属。
 *
 * 跨会话引用（例如把工作会话中的内容交给 Multivac）额外携带来源会话：
 * sourceSessionId 由服务端核对归属，sourceTitle 只用于展示，发送时以注册表中的名称为准。
 */
const AssistantMessageQuoteSchema = Type.Object(
  {
    sourcePiSessionId: EntryId,
    sourcePiEntryId: EntryId,
    sourceRole: Type.Union([Type.Literal('user'), Type.Literal('assistant')]),
    text: Type.String({ minLength: 1 }),
    sourceSessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' })),
    sourceTitle: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    sourceKind: Type.Optional(Type.Literal('message')),
    sourceFile: Type.Optional(Type.Never()),
  },
  { additionalProperties: false },
);

export const FileQuoteSourceSchema = Type.Object({
  root: Type.String({ minLength: 1, maxLength: 4096 }), path: Type.String({ minLength: 1, maxLength: 4096 }),
  line: Type.Optional(Type.Integer({ minimum: 1, maximum: 20000 })), endLine: Type.Optional(Type.Integer({ minimum: 1, maximum: 20000 })), section: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
}, { additionalProperties: false });
export type FileQuoteSource = Type.Static<typeof FileQuoteSourceSchema>;
export const AssistantFileQuoteSchema = Type.Object({
  sourceKind: Type.Literal('file'), sourceFile: FileQuoteSourceSchema, text: Type.String({ minLength: 1 }),
  sourceSessionId: Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' }), sourceTitle: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  sourcePiSessionId: Type.Optional(Type.Never()), sourcePiEntryId: Type.Optional(Type.Never()), sourceRole: Type.Optional(Type.Never()),
}, { additionalProperties: false });
export type AssistantFileQuote = Type.Static<typeof AssistantFileQuoteSchema>;
export const AssistantQuoteSchema = Type.Union([AssistantMessageQuoteSchema, AssistantFileQuoteSchema]);

export type AssistantQuote = Type.Static<typeof AssistantQuoteSchema>;

export function assistantQuoteSizeBytes(text: string): number {
  return quoteEncoder.encode(text).byteLength;
}

/** 超限引用一律拒绝，不静默截断：用户必须知道送给模型的内容与所见一致。 */
export function assistantQuoteWithinLimit(quote: AssistantQuote): boolean {
  return assistantQuoteSizeBytes(quote.text) <= ASSISTANT_QUOTE_MAX_UTF8_BYTES;
}

export const AssistantMessageViewSchema = Type.Object(
  {
    id: NonEmptyString,
    piSessionId: EntryId,
    piEntryId: EntryId,
    role: Type.Union([Type.Literal('user'), Type.Literal('assistant')]),
    text: Type.String(),
    imageIds: Type.Optional(Type.Array(Type.String(), { maxItems: 4 })),
    createdAt: NonEmptyString,
    runtimeMessageId: Type.Optional(EntryId),
    /** 旧消息没有引用字段；缺省即视为无引用。 */
    quote: Type.Optional(AssistantQuoteSchema),
    fileReferences: Type.Optional(Type.Array(SessionFileReferenceSchema, { maxItems: 20 })),
  },
  { additionalProperties: false },
);

export type AssistantMessageView = Type.Static<typeof AssistantMessageViewSchema>;

/** 在途正文尚无 Pi entry；只携带可与最终历史校准的 runtime 消息身份。 */
export const AssistantStreamingMessageViewSchema = Type.Object(
  {
    piSessionId: EntryId,
    messageId: EntryId,
    text: NonEmptyString,
    createdAt: NonEmptyString,
    commandId: Type.Optional(Type.Union([EntryId, Type.Null()])),
  },
  { additionalProperties: false },
);
export type AssistantStreamingMessageView = Type.Static<typeof AssistantStreamingMessageViewSchema>;

export const ASSISTANT_TOOL_SNAPSHOT_MAX_ITEMS = 50;
export const ASSISTANT_TOOL_LIST_DEFAULT_LIMIT = 50;
export const ASSISTANT_TOOL_LIST_MAX_LIMIT = 50;
export const ASSISTANT_TOOL_INPUT_MAX_BYTES = 1024;
export const ASSISTANT_THINKING_DELTA_MAX_BYTES = 4 * 1024;
export const ASSISTANT_THINKING_TRACE_MAX_BYTES = 32 * 1024;

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maxBytes) {
    return { text: value, truncated: false };
  }

  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

/** 输入正文按 UTF-8 字节截断；边界落在多字节字符中时舍弃该字符。 */
export function truncateAssistantToolInput(value: string): { text: string; truncated: boolean } {
  return truncateUtf8(value, ASSISTANT_TOOL_INPUT_MAX_BYTES);
}

export function truncateAssistantThinkingDelta(value: string): { text: string; truncated: boolean } {
  return truncateUtf8(value, ASSISTANT_THINKING_DELTA_MAX_BYTES);
}

export function truncateAssistantThinkingTrace(value: string): { text: string; truncated: boolean } {
  return truncateUtf8(value, ASSISTANT_THINKING_TRACE_MAX_BYTES);
}

/**
 * 工具执行状态。越界的文件工具在 tool_execution_start 之后、实际执行之前等待用户授权：
 * 这段时间是 awaiting_authorization，不算执行中；批准后才转为 running。
 * 授权未获批准（拒绝、取消、过期、失效）的调用没有执行，记为 failed，原因见 authorization。
 */
export const AssistantToolExecutionStatusSchema = Type.Union([
  Type.Literal('awaiting_authorization'),
  Type.Literal('running'),
  Type.Literal('succeeded'),
  Type.Literal('failed'),
]);
export type AssistantToolExecutionStatus = Type.Static<typeof AssistantToolExecutionStatusSchema>;

/** 工具展示名称与摘要由契约统一提供，避免服务端与前端各写一份口径。 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  read: '读取文件',
  bash: '执行命令',
  edit: '修改文件',
  write: '写入文件',
  grep: '搜索内容',
  find: '查找文件',
  ls: '列出目录',
};

/** 内置工具按上表，全局 Multivac 的内部工具按其登记的展示口径（见 internal-tools.ts）。 */
export function assistantToolDisplayName(toolName: string): string {
  if (Object.hasOwn(TOOL_DISPLAY_NAMES, toolName)) return TOOL_DISPLAY_NAMES[toolName]!;
  return internalToolDisplay(toolName)?.displayName ?? toolName;
}

export function assistantToolSummary(
  toolName: string,
  status: AssistantToolExecutionStatus,
): string {
  const displayName = assistantToolDisplayName(toolName);
  if (status === 'awaiting_authorization') return `${displayName}等待授权`;
  if (status === 'running') return `正在${displayName}`;
  return status === 'failed' ? `${displayName}失败` : `${displayName}完成`;
}

/**
 * 各工具最能说明本次调用的入参与对应动作；入参顺序由模型决定，不能直接取首行。
 * 工具行据此写成“动作 + 对象”，例如 read 的 path 显示为“读取 a.ts”。
 */
const TOOL_KEY_ARGUMENTS: Record<string, { argument: string; action: string }> = {
  read: { argument: 'path', action: '读取' },
  edit: { argument: 'path', action: '修改' },
  write: { argument: 'path', action: '写入' },
  ls: { argument: 'path', action: '列出' },
  bash: { argument: 'command', action: '运行' },
  grep: { argument: 'pattern', action: '搜索' },
  find: { argument: 'pattern', action: '查找' },
};

function toolKeyArgument(toolName: string): { argument: string; action: string } | undefined {
  return Object.hasOwn(TOOL_KEY_ARGUMENTS, toolName)
    ? TOOL_KEY_ARGUMENTS[toolName]
    : internalToolDisplay(toolName)?.keyArgument;
}

export function assistantToolKeyArgument(toolName: string): string | undefined {
  return toolKeyArgument(toolName)?.argument;
}

const TOOL_INPUT_SUMMARY_MAX_CHARS = 120;

function capSummary(text: string): string {
  return text.length > TOOL_INPUT_SUMMARY_MAX_CHARS ? `${text.slice(0, TOOL_INPUT_SUMMARY_MAX_CHARS)}…` : text;
}

/**
 * 工具行单行摘要：已登记的工具写成“动作 + 关键参数”，关键参数在入参投影中按
 * `key: value` 行查找，与参数顺序无关；多行取值（如多行命令）只取首行并以省略号示意。
 * 未登记的工具或缺少关键参数时回退为入参首个非空行；内部工具例外，缺少关键参数时不给摘要，
 * 工具行直接写展示名（如“列出会话”），不把 `status: archived` 这类筛选参数当作对象。
 * 摘要只用于展示，完整入参经明细接口读取。
 */
export function assistantToolInputSummary(toolName: string, inputText: string | null): string | null {
  const lines = (inputText ?? '').split('\n');
  const key = toolKeyArgument(toolName);
  if (key) {
    const prefix = `${key.argument}: `;
    const index = lines.findIndex((line) => line.startsWith(prefix));
    const value = index >= 0 ? lines[index]!.slice(prefix.length).trim() : '';
    if (value) {
      // 取值换行后的续行不以 `参数名: ` 开头；有续行时说明取值被截成了首行。
      const continued = /^(?![A-Za-z_][\w-]*: )./u.test(lines[index + 1] ?? '');
      return capSummary(`${key.action} ${value}${continued ? ' …' : ''}`);
    }
  }
  if (internalToolDisplay(toolName)) return null;
  const line = lines.map((candidate) => candidate.trim()).find((candidate) => candidate.length > 0);
  return line ? capSummary(line) : null;
}

/** 工具调用最近一次授权请求的摘要；完整请求（目标路径、工作目录）经授权查询接口读取。 */
export const AssistantToolExecutionAuthorizationSchema = Type.Object(
  {
    requestId: EntryId,
    status: ToolAuthorizationStatusSchema,
    /** 批准的范围与来源；运行轨迹据此区分“仅这一次 / 本会话内 / 本项目内”与按已记住的授权放行。 */
    approval: Type.Union([ToolAuthorizationApprovalSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type AssistantToolExecutionAuthorization = Type.Static<typeof AssistantToolExecutionAuthorizationSchema>;

/**
 * 会话快照只携带总结层：工具名、状态与单行摘要。
 * 输入正文经明细接口按需读取，历史分页不会被工具入参撑大。
 */
export const AssistantToolExecutionViewSchema = Type.Object(
  {
    toolCallId: EntryId,
    toolName: NonEmptyString,
    displayName: NonEmptyString,
    /** 触达该工具调用的命令；为空表示事件早于命令账本记录。 */
    commandId: Type.Union([EntryId, Type.Null()]),
    /** 工具调用时的事件水位，用于把记录放回会话时间线。 */
    cursor: Type.String({ minLength: 1, pattern: '^(0|[1-9][0-9]*)$' }),
    status: AssistantToolExecutionStatusSchema,
    summary: NonEmptyString,
    detail: Type.Union([Type.String(), Type.Null()]),
    isError: Type.Boolean(),
    startedAt: NonEmptyString,
    endedAt: Type.Union([Type.String(), Type.Null()]),
    /** 目录外访问的授权；没有请求授权的调用为 null。 */
    authorization: Type.Union([AssistantToolExecutionAuthorizationSchema, Type.Null()]),
    /** 内部工具成功时公开的结果摘要与涉及的对象；内置工具与失败的调用没有这一项。 */
    result: Type.Optional(AssistantToolResultSchema),
  },
  { additionalProperties: false },
);
export type AssistantToolExecutionView = Type.Static<typeof AssistantToolExecutionViewSchema>;

export const AssistantToolExecutionDetailSchema = Type.Object(
  {
    ...AssistantToolExecutionViewSchema.properties,
    inputText: Type.String(),
    inputTruncated: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type AssistantToolExecutionDetail = Type.Static<typeof AssistantToolExecutionDetailSchema>;

export const AssistantRunTraceStatusSchema = Type.Union([
  Type.Literal('running'),
  Type.Literal('succeeded'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
]);
export type AssistantRunTraceStatus = Type.Static<typeof AssistantRunTraceStatusSchema>;

export const AssistantRunTraceEntrySchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('thinking'),
      cursor: Type.String({ minLength: 1, pattern: '^(0|[1-9][0-9]*)$' }),
      text: Type.String(),
      truncated: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('tool'),
      cursor: Type.String({ minLength: 1, pattern: '^(0|[1-9][0-9]*)$' }),
      toolCallId: EntryId,
    },
    { additionalProperties: false },
  ),
  /**
   * 助手正文在本轮中开始输出的位置（该消息首个正文增量）。正文本身不进轨迹，
   * 前端据此把最终回复之前的过程正文放回思考与工具之间的准确位置。
   */
  Type.Object(
    {
      kind: Type.Literal('message'),
      cursor: Type.String({ minLength: 1, pattern: '^(0|[1-9][0-9]*)$' }),
      messageId: NonEmptyString,
    },
    { additionalProperties: false },
  ),
]);
export type AssistantRunTraceEntry = Type.Static<typeof AssistantRunTraceEntrySchema>;

export const AssistantRunTraceViewSchema = Type.Object(
  {
    commandId: EntryId,
    cursor: Type.String({ minLength: 1, pattern: '^(0|[1-9][0-9]*)$' }),
    status: AssistantRunTraceStatusSchema,
    entries: Type.Array(AssistantRunTraceEntrySchema),
    thinkingTruncated: Type.Boolean(),
    startedAt: NonEmptyString,
    endedAt: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type AssistantRunTraceView = Type.Static<typeof AssistantRunTraceViewSchema>;

export const AssistantToolExecutionQuerySchema = Type.Object(
  {
    before: Type.Optional(Type.String({ minLength: 1, pattern: '^(0|[1-9][0-9]*)$' })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: ASSISTANT_TOOL_LIST_MAX_LIMIT })),
  },
  { additionalProperties: false },
);
export type AssistantToolExecutionQuery = Type.Static<typeof AssistantToolExecutionQuerySchema>;

export const AssistantToolExecutionListResponseSchema = Type.Object(
  {
    assistantSessionId: NonEmptyString,
    tools: Type.Array(AssistantToolExecutionViewSchema),
    hasMore: Type.Boolean(),
    nextBefore: Type.Union([
      Type.String({ minLength: 1, pattern: '^(0|[1-9][0-9]*)$' }),
      Type.Null(),
    ]),
    latestCursor: Type.String({ minLength: 1, pattern: '^(0|[1-9][0-9]*)$' }),
  },
  { additionalProperties: false },
);
export type AssistantToolExecutionListResponse = Type.Static<
  typeof AssistantToolExecutionListResponseSchema
>;

export const AssistantSessionQuerySchema = Type.Object(
  {
    before: Type.Optional(EntryId),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: ASSISTANT_SESSION_MAX_LIMIT }),
    ),
  },
  { additionalProperties: false },
);

export type AssistantSessionQuery = Type.Static<typeof AssistantSessionQuerySchema>;

export const AssistantCommandAnchorSchema = Type.Object(
  {
    commandId: EntryId,
    piEntryId: EntryId,
  },
  { additionalProperties: false },
);
export type AssistantCommandAnchor = Type.Static<typeof AssistantCommandAnchorSchema>;

export const AssistantSessionPageResponseSchema = Type.Object(
  {
    assistantSessionId: NonEmptyString,
    piSessionId: NonEmptyString,
    messages: Type.Array(AssistantMessageViewSchema),
    hasMore: Type.Boolean(),
    nextBefore: NullableEntryId,
    cursor: NonEmptyString,
    eventCursor: Type.String({ minLength: 1, pattern: '^(0|[1-9][0-9]*)$' }),
    streamingMessages: Type.Optional(Type.Array(AssistantStreamingMessageViewSchema)),
    toolExecutions: Type.Optional(Type.Array(AssistantToolExecutionViewSchema)),
    runTraces: Type.Optional(Type.Array(AssistantRunTraceViewSchema)),
    /** 命令终结时的 Pi entry 锚点，用于把工具记录放回所属 Turn。 */
    commandAnchors: Type.Optional(Type.Array(AssistantCommandAnchorSchema)),
  },
  { additionalProperties: false },
);

export type AssistantSessionPageResponse = Type.Static<
  typeof AssistantSessionPageResponseSchema
>;

export const AssistantPageStateSchema = Type.Object(
  {
    draft: Draft,
    anchorEntryId: NullableEntryId,
    anchorOffsetPx: Type.Number(),
    /** 未发送引用与草稿同属页面现场；旧记录没有该字段时按空引用读取。 */
    quote: Type.Union([AssistantQuoteSchema, Type.Null()]),
    revision: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type AssistantPageState = Type.Static<typeof AssistantPageStateSchema>;

export const AssistantPageStatePutSchema = Type.Object(
  {
    draft: Draft,
    anchorEntryId: NullableEntryId,
    anchorOffsetPx: Type.Number(),
    quote: Type.Optional(Type.Union([AssistantQuoteSchema, Type.Null()])),
    revision: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type AssistantPageStatePut = Type.Static<typeof AssistantPageStatePutSchema>;

export const ASSISTANT_API_ERROR_CODES = [
  'INVALID_REQUEST',
  'INVALID_CURSOR',
  'BODY_TOO_LARGE',
  'ASSISTANT_SESSION_RECOVERY_FAILED',
  'ASSISTANT_SESSION_BINDING_MISMATCH',
  'ASSISTANT_SESSION_UNAVAILABLE',
  'DEFAULT_MODEL_UNAVAILABLE',
  'PAGE_STATE_CONFLICT',
  'WORKSPACE_SCENE_CONFLICT',
  'COMMAND_ID_CONFLICT',
  'SESSION_ID_CONFLICT',
  'COMMAND_STATE_MISMATCH',
  'COMMAND_INTERRUPTED',
  'EVENT_CURSOR_EXPIRED',
  'AUTHORIZATION_CONFLICT',
  'AUTHORIZATION_NOT_PENDING',
  'PROPOSAL_CONFLICT',
  'TASK_CONFLICT',
  'HOST_NOT_ALLOWED',
  'ORIGIN_NOT_ALLOWED',
  'NOT_FOUND',
  'INTERNAL_ERROR',
] as const;

export type AssistantApiErrorCode = (typeof ASSISTANT_API_ERROR_CODES)[number];

export const AssistantApiErrorCodeSchema = Type.Union(
  ASSISTANT_API_ERROR_CODES.map((code) => Type.Literal(code)),
);

export const AssistantApiErrorResponseSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: AssistantApiErrorCodeSchema,
        message: NonEmptyString,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export interface AssistantApiErrorResponse {
  error: {
    code: AssistantApiErrorCode;
    message: string;
  };
}
