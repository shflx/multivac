import { Type } from 'typebox';

export const WebSettingsSchema = Type.Object({
  revision: Type.Integer({ minimum: 0 }), enabled: Type.Boolean(), provider: Type.Literal('deepseek'),
  configured: Type.Boolean(), source: Type.Union([Type.Literal('environment'), Type.Literal('settings')]),
  lastCommandId: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });
export type WebSettings = Type.Static<typeof WebSettingsSchema>;
export const UpdateWebSettingsSchema = Type.Object({
  commandId: Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' }),
  revision: Type.Integer({ minimum: 0 }), enabled: Type.Boolean(), provider: Type.Literal('deepseek'),
  apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, pattern: '^[^\\s]+$' })),
  clearKey: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export type UpdateWebSettings = Type.Static<typeof UpdateWebSettingsSchema>;
