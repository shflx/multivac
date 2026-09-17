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

export const AssistantMessageViewSchema = Type.Object(
  {
    id: NonEmptyString,
    piSessionId: EntryId,
    piEntryId: EntryId,
    role: Type.Union([Type.Literal('user'), Type.Literal('assistant')]),
    text: NonEmptyString,
    createdAt: NonEmptyString,
    runtimeMessageId: Type.Optional(EntryId),
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
  },
  { additionalProperties: false },
);
export type AssistantStreamingMessageView = Type.Static<typeof AssistantStreamingMessageViewSchema>;

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
