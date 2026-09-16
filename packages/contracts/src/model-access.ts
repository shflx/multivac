import { Type } from 'typebox';
import { ModelAvailabilitySchema } from './model-settings.js';

export const MODEL_ACCESS_BODY_LIMIT_BYTES = 12 * 1024;
export const MODEL_CHECK_TTL_MS = 5 * 60 * 1000;
export const MODEL_CHECK_TIMEOUT_MS = 20 * 1000;
const Id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' });
const Revision = Type.Integer({ minimum: 0 });
export const MODEL_ACCESS_ERROR_CODES = [
  'INVALID_REQUEST', 'ACCESS_CONFLICT', 'COMMAND_ID_CONFLICT', 'ACCESS_UNAVAILABLE',
  'CREDENTIAL_UNSUPPORTED', 'CREDENTIAL_RESULT_UNKNOWN', 'CHECK_AUTH_MISSING',
  'CHECK_MODEL_UNAVAILABLE', 'CHECK_FAILED', 'CHECK_TIMEOUT', 'CHECK_CANCELLED',
  'CHECK_INVALIDATED', 'CHECK_BUSY', 'NOT_FOUND',
] as const;
export type ModelAccessErrorCode = (typeof MODEL_ACCESS_ERROR_CODES)[number];
export const ModelAccessErrorCodeSchema = Type.Enum(MODEL_ACCESS_ERROR_CODES);
export const ModelAccessErrorSchema = Type.Object({
  error: Type.Object({ code: ModelAccessErrorCodeSchema }, { additionalProperties: false }),
}, { additionalProperties: false });
const CommandFields = { commandId: Id, profileId: Id, revision: Revision, accessRevision: Revision };
/** 仅用于一次性秘密传输，不能作为模型配置或命令持久化对象。 */
export const ConfigureModelApiKeySchema = Type.Object({
  ...CommandFields, apiKey: Type.String({ minLength: 1, maxLength: 8192, pattern: '^[^\\x00-\\x20\\x7f]+$' }),
}, { additionalProperties: false });
export type ConfigureModelApiKey = Type.Static<typeof ConfigureModelApiKeySchema>;
export const ModelAccessCommandSchema = Type.Object(CommandFields, { additionalProperties: false });
export type ModelAccessCommand = Type.Static<typeof ModelAccessCommandSchema>;
export const ModelAccessReceiptSchema = Type.Object({
  replayed: Type.Boolean(),
  commandId: Id, profileId: Id, action: Type.Union([
    Type.Literal('configure-key'), Type.Literal('revoke-key'), Type.Literal('check'),
  ]),
  state: Type.Union([Type.Literal('begun'), Type.Literal('committed'), Type.Literal('unconfirmed'), Type.Literal('failed')]),
  revision: Revision, accessRevision: Revision,
  errorCode: Type.Union([ModelAccessErrorCodeSchema, Type.Null()]),
}, { additionalProperties: false });
export type ModelAccessReceipt = Type.Static<typeof ModelAccessReceiptSchema>;
export const ModelConnectionCheckSchema = Type.Object({
  profileId: Id, checkId: Id,
  status: Type.Enum(['checking', 'passed', 'failed', 'cancelled', 'timed-out', 'invalidated', 'expired']),
  checkedAt: Type.Union([Type.String(), Type.Null()]),
  expiresAt: Type.Union([Type.String(), Type.Null()]),
  errorCode: Type.Union([ModelAccessErrorCodeSchema, Type.Null()]),
}, { additionalProperties: false });
export type ModelConnectionCheck = Type.Static<typeof ModelConnectionCheckSchema>;
export const ModelAccessSnapshotSchema = Type.Object({
  revision: Revision, accessRevision: Revision, credentialRevision: Revision,
  availability: Type.Array(ModelAvailabilitySchema),
  credentials: Type.Array(Type.Object({
    profileId: Id, provider: Id, storedApiKey: Type.Boolean(), configurable: Type.Boolean(),
    lastCommand: Type.Union([ModelAccessReceiptSchema, Type.Null()]),
  }, { additionalProperties: false })),
  checks: Type.Array(ModelConnectionCheckSchema),
}, { additionalProperties: false });
export type ModelAccessSnapshot = Type.Static<typeof ModelAccessSnapshotSchema>;
export const CancelModelCheckSchema = Type.Object({ checkId: Id }, { additionalProperties: false });
