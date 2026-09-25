import { Type } from 'typebox';
import { COORDINATOR_THINKING_LEVELS } from './coordinator-runtime.js';
import { ModelAvailabilitySchema } from './model-settings.js';
import { ModelConnectionCheckSchema } from './model-access.js';

export const SessionThinkingLevelSchema = Type.Enum(COORDINATOR_THINKING_LEVELS);
const ProfileId = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' });
const CommandId = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' });
const Revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
/** 选模按会话进行：全局协调会话与各工作会话各有一份选择。 */
const SessionId = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' });
export const SessionModelSelectionSchema = Type.Object({
  sessionId: SessionId,
  profileId: Type.Union([ProfileId, Type.Null()]),
  thinkingLevel: SessionThinkingLevelSchema,
  revision: Revision,
  provider: Type.String(),
  modelId: Type.String(),
  source: Type.Union([Type.Literal('base'), Type.Literal('controlled')]),
  availableThinkingLevels: Type.Array(SessionThinkingLevelSchema),
  availability: Type.Object({
    available: Type.Boolean(),
    reason: Type.Union([Type.String(), Type.Null()]),
    message: Type.Union([Type.String(), Type.Null()]),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
export type SessionModelSelection = Type.Static<typeof SessionModelSelectionSchema>;

export const SessionModelOptionsSchema = Type.Object({
  selection: SessionModelSelectionSchema,
  running: Type.Boolean(),
  disabledReason: Type.Union([Type.String(), Type.Null()]),
  options: Type.Array(Type.Object({
    profileId: ProfileId, displayName: Type.String(), provider: Type.String(), modelId: Type.String(),
    availability: ModelAvailabilitySchema,
    connection: Type.Union([ModelConnectionCheckSchema, Type.Null()]),
  }, { additionalProperties: false })),
}, { additionalProperties: false });
export type SessionModelOptions = Type.Static<typeof SessionModelOptionsSchema>;

const command = { commandId: CommandId, sessionId: SessionId, revision: Revision };
export const SetSessionModelSchema = Type.Object({ ...command, profileId: ProfileId }, { additionalProperties: false });
export type SetSessionModel = Type.Static<typeof SetSessionModelSchema>;
export const SetSessionThinkingLevelSchema = Type.Object({ ...command, thinkingLevel: SessionThinkingLevelSchema }, { additionalProperties: false });
export type SetSessionThinkingLevel = Type.Static<typeof SetSessionThinkingLevelSchema>;
export const SessionModelCommandResultSchema = Type.Object({
  commandId: CommandId, replayed: Type.Boolean(),
  status: Type.Union([Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('unknown')]),
  error: Type.Union([Type.String(), Type.Null()]),
  selection: SessionModelSelectionSchema,
  effectiveFrom: Type.Literal('next-turn'),
}, { additionalProperties: false });
export type SessionModelCommandResult = Type.Static<typeof SessionModelCommandResultSchema>;
