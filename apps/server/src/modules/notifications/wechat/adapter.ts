import type { NotificationChannel, NotificationContent } from '@multivac/contracts';
import type { ChannelReadiness, ChannelSendContext, ChannelSendResult, NotificationChannelAdapter } from '../channel.js';
import { ilinkSucceeded, invalidCredentials, stringField, type IlinkClient } from './client.js';

/** 微信适配器只取得发送所需的私有资料端口，不依赖应用服务实现。 */
interface WechatBindingAccess {
  readonly client: IlinkClient;
  readiness(channel: NotificationChannel): ChannelReadiness;
  binding(channel: NotificationChannel): { apiBase: string; userId: string; token: string; contextToken: string | null } | null;
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** 计划时间按提醒自身时区的本地时间展示，如“10月15日 周三 19:37”；跨年时补年份。 */
function plannedTime(content: NotificationContent): string {
  const [date = '', time = ''] = content.localTime.split('T');
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) return content.localTime;
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  const sameYear = content.createdAt.startsWith(String(year));
  return `${sameYear ? '' : `${year}年`}${month}月${day}日 周${weekday} ${time.slice(0, 5)}`;
}

/** 微信文本：首行是提醒内容，末行是计划时间与来源；超长时截断正文，总长不超过 1000 个字符。 */
export function formatWechatNotification(content: NotificationContent): string {
  // 测试消息不是提醒，没有计划时间。
  if (content.notificationId.startsWith('test:')) return content.text;
  const footer = `\n\n${plannedTime(content)} · Multivac`;
  const head = '⏰ ';
  const text = Array.from(content.text), budget = 1000 - Array.from(head).length - Array.from(footer).length;
  if (text.length <= budget) return head + content.text + footer;
  const truncated = '…\n（全文见 Multivac Inbox）';
  return head + text.slice(0, Math.max(0, budget - Array.from(truncated).length)).join('') + truncated + footer;
}

/** 首版不声明远端幂等或送达查询；HTTP接受不等于本人手机收到。 */
export class WechatNotificationAdapter implements NotificationChannelAdapter {
  readonly type = 'wechat';
  readonly capabilities = { idempotency: false, resultQuery: false } as const;
  constructor(private readonly bindings: WechatBindingAccess) {}
  readiness(channel: NotificationChannel): ChannelReadiness { return this.bindings.readiness(channel); }
  format(content: NotificationContent): string { return formatWechatNotification(content); }
  async send(text: string, context: ChannelSendContext): Promise<ChannelSendResult> {
    const binding = this.bindings.binding(context.channel);
    if (!binding?.contextToken || context.signal.aborted) return { outcome: 'not-sent', diagnostic: '本地尚未就绪，未请求微信发送接口。' };
    if (Array.from(text).length > 1000) return { outcome: 'rejected', diagnostic: '微信文本超过1000个Unicode字符，未请求发送接口。' };
    try {
      const reply = await this.bindings.client.request(binding.apiBase, 'sendmessage', {
        token: binding.token, signal: context.signal,
        body: { msg: { from_user_id: '', to_user_id: binding.userId, client_id: context.localMessageId,
          message_type: 2, message_state: 2, context_token: binding.contextToken,
          item_list: [{ type: 1, text_item: { text } }] } },
      });
      if (invalidCredentials(reply)) return { outcome: 'rejected', diagnostic: '微信凭据已失效，请重新绑定。', credentialsInvalid: true };
      if (ilinkSucceeded(reply)) return { outcome: 'accepted', serverMessageId: stringField(reply.body.message_id) };
      if (typeof reply.body.ret === 'number' && reply.body.ret !== 0 || typeof reply.body.errcode === 'number' && reply.body.errcode !== 0) {
        return { outcome: 'rejected', diagnostic: '微信接口明确拒绝了此次发送。' };
      }
      return { outcome: 'unknown', diagnostic: '微信响应没有同时给出HTTP与业务明确成功，结果未知，不会自动重发。' };
    } catch {
      // 超时、响应中断、解析失败和HTTP跳转均可能发生在远端处理后。
      return { outcome: 'unknown', diagnostic: '微信发送未取得完整明确结果，可能已被处理，不会自动重发。' };
    }
  }
}
