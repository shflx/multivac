import { Type } from 'typebox';

/** 微信专有状态只供本机设置；二维码内容走本机图片接口，不进入公开 DTO。 */
export const WechatNotificationStatusSchema = Type.Object({
  state: Type.Union([Type.Literal('unbound'), Type.Literal('qr'), Type.Literal('scanned'), Type.Literal('verify-code'),
    Type.Literal('waiting-context'), Type.Literal('ready'), Type.Literal('expired'), Type.Literal('failed')]),
  qrAvailable: Type.Boolean(), diagnostic: Type.Union([Type.String(), Type.Null()]),
  contextObservedAt: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });
export type WechatNotificationStatus = Type.Static<typeof WechatNotificationStatusSchema>;
export const WechatVerifyCodeSchema = Type.Object({
  commandId: Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' }),
  version: Type.Integer({ minimum: 1 }), code: Type.String({ pattern: '^\\d{4,12}$' }),
}, { additionalProperties: false });
