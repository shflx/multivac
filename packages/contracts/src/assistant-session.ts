import { Type } from 'typebox';

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
export const AssistantQuoteSchema = Type.Object(
  {
    sourcePiSessionId: EntryId,
    sourcePiEntryId: EntryId,
    sourceRole: Type.Union([Type.Literal('user'), Type.Literal('assistant')]),
    text: Type.String({ minLength: 1 }),
    sourceSessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' })),
    sourceTitle: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  },
  { additionalProperties: false },
);

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
    text: NonEmptyString,
    createdAt: NonEmptyString,
    runtimeMessageId: Type.Optional(EntryId),
    /** 旧消息没有引用字段；缺省即视为无引用。 */
    quote: Type.Optional(AssistantQuoteSchema),
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

export const AssistantToolExecutionStatusSchema = Type.Union([
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

export function assistantToolDisplayName(toolName: string): string {
  return TOOL_DISPLAY_NAMES[toolName] ?? toolName;
}

export function assistantToolSummary(
  toolName: string,
  status: AssistantToolExecutionStatus,
): string {
  const displayName = assistantToolDisplayName(toolName);
  if (status === 'running') return `正在${displayName}`;
  return status === 'failed' ? `${displayName}失败` : `${displayName}完成`;
}

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
  'COMMAND_ID_CONFLICT',
  'SESSION_ID_CONFLICT',
  'COMMAND_STATE_MISMATCH',
  'COMMAND_INTERRUPTED',
  'EVENT_CURSOR_EXPIRED',
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
