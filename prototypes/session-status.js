/** 会话状态独立于任务状态：处理是否结束、最新回复是否已查看。 */
export function sessionStatus(state = {}, awaitingAuthorization = false) {
  const messages = state.messages || [];
  const trace = messages.filter((message) => message.trace).at(-1);
  if (awaitingAuthorization || trace?.status === 'running') return { kind: 'processing', label: '处理中', detail: awaitingAuthorization ? '本轮尚未结束，等待你的授权' : '正在处理本轮消息' };
  if (messages.length > (state.readCount || 0)) return { kind: 'unread', label: '未查看', detail: '本轮处理已结束，有尚未查看的回复或结果' };
  return { kind: 'viewed', label: '已查看', detail: '暂无未查看的回复' };
}
