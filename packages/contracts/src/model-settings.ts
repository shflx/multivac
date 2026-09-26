import { Type } from 'typebox';

export const MODEL_SETTINGS_BODY_LIMIT_BYTES = 32 * 1024;
export const MODEL_PROFILE_ID_MAX_LENGTH = 128;
export const MODEL_SETTINGS_COMMAND_ID_MAX_LENGTH = 128;

const NonEmptyString = Type.String({ minLength: 1 });
const ProfileId = Type.String({
  minLength: 1,
  maxLength: MODEL_PROFILE_ID_MAX_LENGTH,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
});
const CommandId = Type.String({
  minLength: 1,
  maxLength: MODEL_SETTINGS_COMMAND_ID_MAX_LENGTH,
  pattern: '^[A-Za-z0-9._:-]+$',
});
const ProviderId = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
});

export const ModelProtocolSchema = Type.Union([
  Type.Literal('openai-completions'),
  Type.Literal('openai-responses'),
  Type.Literal('anthropic-messages'),
  Type.Literal('google-generative-ai'),
]);
export type ModelProtocol = Type.Static<typeof ModelProtocolSchema>;

/**
 * 推理能力：auto 按 Pi 目录判断；enabled / disabled 为手动设置，覆盖目录中的能力。
 * 只决定能否启用推理（推理等级是否可选），不保证模型一定返回可展示的思考内容。
 */
export const ModelReasoningModeSchema = Type.Union([
  Type.Literal('auto'),
  Type.Literal('enabled'),
  Type.Literal('disabled'),
]);
export type ModelReasoningMode = Type.Static<typeof ModelReasoningModeSchema>;

/** 手动设置时的推理能力；auto 返回 undefined，由 Pi 目录决定。 */
export function modelReasoningOverride(mode: ModelReasoningMode | undefined): boolean | undefined {
  if (mode === 'enabled') return true;
  if (mode === 'disabled') return false;
  return undefined;
}

export const ModelProfileInputSchema = Type.Object(
  {
    profileId: ProfileId,
    displayName: Type.String({ minLength: 1, maxLength: 160 }),
    provider: ProviderId,
    modelId: Type.String({ minLength: 1, maxLength: 256 }),
    protocol: ModelProtocolSchema,
    endpoint: Type.Union([
      Type.String({ minLength: 1, maxLength: 2_048 }),
      Type.Null(),
    ]),
    /** 缺省视为 auto；旧版配置文件没有该字段。 */
    reasoning: Type.Optional(ModelReasoningModeSchema),
  },
  { additionalProperties: false },
);
export type ModelProfileInput = Type.Static<typeof ModelProfileInputSchema>;

export const ModelCapabilitiesSchema = Type.Object(
  {
    source: Type.Union([
      Type.Literal('pi-catalog'),
      Type.Literal('pi-default'),
    ]),
    input: Type.Array(Type.Union([Type.Literal('text'), Type.Literal('image')])),
    contextWindow: Type.Integer({ minimum: 1 }),
    maxOutputTokens: Type.Integer({ minimum: 1 }),
    reasoning: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ModelCapabilities = Type.Static<typeof ModelCapabilitiesSchema>;

export const ModelProfileSchema = Type.Object(
  {
    profileId: ProfileId,
    displayName: Type.String({ minLength: 1, maxLength: 160 }),
    provider: ProviderId,
    modelId: Type.String({ minLength: 1, maxLength: 256 }),
    protocol: ModelProtocolSchema,
    endpoint: Type.Union([
      Type.String({ minLength: 1, maxLength: 2_048 }),
      Type.Null(),
    ]),
    reasoning: ModelReasoningModeSchema,
    /** 生效后的能力；手动设置的推理能力已计入 capabilities.reasoning。 */
    capabilities: Type.Union([ModelCapabilitiesSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type ModelProfile = Type.Static<typeof ModelProfileSchema>;

export const ModelAvailabilityReasonSchema = Type.Union([
  Type.Literal('CONFIGURATION_INVALID'),
  Type.Literal('MODEL_NOT_FOUND'),
  Type.Literal('AUTH_MISSING'),
  Type.Literal('MODEL_UNAVAILABLE'),
  Type.Literal('RUNTIME_ERROR'),
]);
export type ModelAvailabilityReason = Type.Static<typeof ModelAvailabilityReasonSchema>;

export const ModelAvailabilitySchema = Type.Object(
  {
    profileId: ProfileId,
    authenticated: Type.Boolean(),
    available: Type.Boolean(),
    authenticationType: Type.Union([
      Type.Literal('api_key'),
      Type.Literal('oauth'),
      Type.Null(),
    ]),
    reason: Type.Union([ModelAvailabilityReasonSchema, Type.Null()]),
    message: Type.Union([NonEmptyString, Type.Null()]),
  },
  { additionalProperties: false },
);
export type ModelAvailability = Type.Static<typeof ModelAvailabilitySchema>;

export const ModelSettingsSnapshotSchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 0 }),
    profiles: Type.Array(ModelProfileSchema),
    defaultProfileId: Type.Union([ProfileId, Type.Null()]),
    availability: Type.Array(ModelAvailabilitySchema),
  },
  { additionalProperties: false },
);
export type ModelSettingsSnapshot = Type.Static<typeof ModelSettingsSnapshotSchema>;

export const SaveModelSettingsSchema = Type.Object(
  {
    commandId: CommandId,
    revision: Type.Integer({ minimum: 0 }),
    profile: ModelProfileInputSchema,
  },
  { additionalProperties: false },
);
export type SaveModelSettings = Type.Static<typeof SaveModelSettingsSchema>;

export const SetDefaultModelSchema = Type.Object(
  {
    commandId: CommandId,
    revision: Type.Integer({ minimum: 0 }),
    profileId: ProfileId,
  },
  { additionalProperties: false },
);
export type SetDefaultModel = Type.Static<typeof SetDefaultModelSchema>;

export const MODEL_SETTINGS_API_ERROR_CODES = [
  'INVALID_REQUEST',
  'BODY_TOO_LARGE',
  'MODEL_SETTINGS_CONFLICT',
  'MODEL_SETTINGS_COMMAND_ID_CONFLICT',
  'MODEL_SETTINGS_CANDIDATE_INVALID',
  'DEFAULT_MODEL_UNAVAILABLE',
  'MODEL_SETTINGS_UNAVAILABLE',
  'RESULT_UNKNOWN',
  'HOST_NOT_ALLOWED',
  'ORIGIN_NOT_ALLOWED',
  'NOT_FOUND',
  'INTERNAL_ERROR',
] as const;

export type ModelSettingsApiErrorCode = (typeof MODEL_SETTINGS_API_ERROR_CODES)[number];

export const ModelSettingsApiErrorCodeSchema = Type.Union(
  MODEL_SETTINGS_API_ERROR_CODES.map((code) => Type.Literal(code)),
);

export const ModelSettingsApiErrorResponseSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: ModelSettingsApiErrorCodeSchema,
        message: NonEmptyString,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export interface ModelSettingsApiErrorResponse {
  error: {
    code: ModelSettingsApiErrorCode;
    message: string;
  };
}
