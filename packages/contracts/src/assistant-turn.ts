import { Type, type TProperties } from 'typebox';

export const ASSISTANT_TURN_BODY_LIMIT_BYTES = 80 * 1024;
export const ASSISTANT_COMMAND_ID_MAX_LENGTH = 128;
export const ASSISTANT_EVENT_REPLAY_MAX_LIMIT = 500;
export const ASSISTANT_SSE_EVENT_NAME = 'assistant-event';

const NonEmptyString = Type.String({ minLength: 1 });
const OpaqueReference = Type.String({ minLength: 1, maxLength: 512 });
const NullableReference = Type.Union([OpaqueReference, Type.Null()]);
const CommandId = Type.String({
  minLength: 1,
  maxLength: ASSISTANT_COMMAND_ID_MAX_LENGTH,
  pattern: '^[A-Za-z0-9._:-]+$',
});
const AssistantSessionId = Type.String({ minLength: 1, maxLength: 128 });
const EventCursor = Type.String({ minLength: 1, pattern: '^(0|[1-9][0-9]*)$' });
const ContextRefs = Type.Tuple([]);

export const AssistantStreamingBehaviorSchema = Type.Union([
  Type.Literal('steer'),
  Type.Literal('followUp'),
]);
export type AssistantStreamingBehavior = Type.Static<typeof AssistantStreamingBehaviorSchema>;

export const SendAssistantMessageCommandSchema = Type.Object(
  {
    commandId: CommandId,
    assistantSessionId: AssistantSessionId,
    text: Type.String({ minLength: 1, maxLength: 12 * 1024 }),
    contextRefs: ContextRefs,
    streamingBehavior: Type.Optional(AssistantStreamingBehaviorSchema),
  },
  { additionalProperties: false },
);
export type SendAssistantMessageCommand = Type.Static<typeof SendAssistantMessageCommandSchema>;

export const CancelAssistantTurnCommandSchema = Type.Object(
  {
    commandId: CommandId,
    assistantSessionId: AssistantSessionId,
  },
  { additionalProperties: false },
);
export type CancelAssistantTurnCommand = Type.Static<typeof CancelAssistantTurnCommandSchema>;

export const AssistantCommandStatusSchema = Type.Union([
  Type.Literal('unknown'),
  Type.Literal('accepted'),
  Type.Literal('handed_to_pi'),
  Type.Literal('running'),
  Type.Literal('terminal'),
]);
export type AssistantCommandStatus = Type.Static<typeof AssistantCommandStatusSchema>;

export const AssistantCommandTerminalOutcomeSchema = Type.Union([
  Type.Literal('accepted'),
  Type.Literal('succeeded'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
  Type.Literal('rejected'),
]);
export type AssistantCommandTerminalOutcome = Type.Static<
  typeof AssistantCommandTerminalOutcomeSchema
>;

export const AssistantCommandKindSchema = Type.Union([
  Type.Literal('send'),
  Type.Literal('cancel'),
]);
export type AssistantCommandKind = Type.Static<typeof AssistantCommandKindSchema>;

export const AssistantCommandErrorSchema = Type.Object(
  {
    code: NonEmptyString,
    message: NonEmptyString,
  },
  { additionalProperties: false },
);
export type AssistantCommandError = Type.Static<typeof AssistantCommandErrorSchema>;

export const AssistantCommandReceiptSchema = Type.Object(
  {
    commandId: CommandId,
    assistantSessionId: AssistantSessionId,
    kind: AssistantCommandKindSchema,
    status: AssistantCommandStatusSchema,
    terminalOutcome: Type.Union([AssistantCommandTerminalOutcomeSchema, Type.Null()]),
    error: Type.Union([AssistantCommandErrorSchema, Type.Null()]),
    piSessionId: NullableReference,
    piEntryId: NullableReference,
    piTurnRef: NullableReference,
    createdAt: NonEmptyString,
    updatedAt: NonEmptyString,
  },
  { additionalProperties: false },
);
export type AssistantCommandReceipt = Type.Static<typeof AssistantCommandReceiptSchema>;

export const AssistantCommandReconciliationResponseSchema = Type.Object(
  {
    commandId: CommandId,
    status: AssistantCommandStatusSchema,
    receipt: Type.Union([AssistantCommandReceiptSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type AssistantCommandReconciliationResponse = Type.Static<
  typeof AssistantCommandReconciliationResponseSchema
>;

const PublicEventBase = {
  cursor: EventCursor,
  eventId: NonEmptyString,
  assistantSessionId: AssistantSessionId,
  commandId: Type.Union([CommandId, Type.Null()]),
  occurredAt: NonEmptyString,
};

function publicEvent<TType extends string, T extends TProperties>(type: TType, data: T) {
  return Type.Object(
    { ...PublicEventBase, type: Type.Literal(type), data: Type.Object(data, { additionalProperties: false }) },
    { additionalProperties: false },
  );
}

export const AssistantPublicEventSchema = Type.Union([
  publicEvent('assistant.command.accepted', { kind: AssistantCommandKindSchema }),
  publicEvent('assistant.command.handed_to_pi', {
    kind: AssistantCommandKindSchema,
    dispatchMode: Type.Union([
      Type.Literal('prompt'),
      Type.Literal('steer'),
      Type.Literal('followUp'),
      Type.Literal('abort'),
    ]),
  }),
  publicEvent('assistant.command.rejected', { error: AssistantCommandErrorSchema }),
  publicEvent('assistant.command.reconciled', {
    status: AssistantCommandStatusSchema,
    terminalOutcome: Type.Union([AssistantCommandTerminalOutcomeSchema, Type.Null()]),
    error: Type.Union([AssistantCommandErrorSchema, Type.Null()]),
  }),
  publicEvent('assistant.run.processing', {}),
  publicEvent('assistant.turn.started', { turnRef: NullableReference }),
  publicEvent('assistant.turn.ended', {}),
  publicEvent('assistant.message.delta', {
    piSessionId: OpaqueReference,
    messageId: OpaqueReference,
    delta: Type.String(),
  }),
  publicEvent('assistant.message.changed', {
    messageId: OpaqueReference,
    role: Type.Union([Type.Literal('user'), Type.Literal('assistant'), Type.Literal('tool')]),
  }),
  publicEvent('assistant.tool.started', {
    toolCallId: OpaqueReference,
    toolName: NonEmptyString,
  }),
  publicEvent('assistant.tool.updated', {
    toolCallId: OpaqueReference,
    toolName: NonEmptyString,
  }),
  publicEvent('assistant.tool.ended', {
    toolCallId: OpaqueReference,
    toolName: NonEmptyString,
    isError: Type.Boolean(),
  }),
  publicEvent('assistant.queue.updated', {
    steeringCount: Type.Integer({ minimum: 0 }),
    followUpCount: Type.Integer({ minimum: 0 }),
  }),
  publicEvent('assistant.retry.started', {
    scope: Type.Union([Type.Literal('run'), Type.Literal('summarization')]),
    attempt: Type.Integer({ minimum: 0 }),
    maxAttempts: Type.Integer({ minimum: 0 }),
  }),
  publicEvent('assistant.retry.ended', {
    scope: Type.Union([Type.Literal('run'), Type.Literal('summarization')]),
    attempt: Type.Integer({ minimum: 0 }),
    outcome: Type.Union([
      Type.Literal('succeeded'),
      Type.Literal('failed'),
      Type.Literal('cancelled'),
      Type.Literal('unknown'),
    ]),
  }),
  publicEvent('assistant.compaction.started', {
    reason: Type.Union([Type.Literal('manual'), Type.Literal('threshold'), Type.Literal('overflow')]),
  }),
  publicEvent('assistant.compaction.ended', {
    reason: Type.Union([Type.Literal('manual'), Type.Literal('threshold'), Type.Literal('overflow')]),
    status: Type.Union([
      Type.Literal('succeeded'),
      Type.Literal('failed'),
      Type.Literal('cancelled'),
    ]),
    willRetry: Type.Boolean(),
    errorCode: Type.Optional(NonEmptyString),
  }),
  publicEvent('assistant.run.succeeded', {}),
  publicEvent('assistant.run.failed', {}),
  publicEvent('assistant.run.cancelled', {}),
]);
export type AssistantPublicEvent = Type.Static<typeof AssistantPublicEventSchema>;

export const AssistantEventsQuerySchema = Type.Object(
  { after: Type.Optional(EventCursor) },
  { additionalProperties: false },
);
export type AssistantEventsQuery = Type.Static<typeof AssistantEventsQuerySchema>;

export const AssistantEventReplayResponseSchema = Type.Object(
  {
    events: Type.Array(AssistantPublicEventSchema),
    latestCursor: EventCursor,
  },
  { additionalProperties: false },
);
export type AssistantEventReplayResponse = Type.Static<typeof AssistantEventReplayResponseSchema>;
