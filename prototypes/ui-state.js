export const MIN_PANE_WIDTH = 320;

// 只调整分隔线相邻的两列，保留总宽度与其他会话的现场。
export function resizePair(widths, index, delta) {
  if (index < 0 || index >= widths.length - 1) return widths;
  const total = widths[index] + widths[index + 1];
  const minimum = Math.min(MIN_PANE_WIDTH, total / 2);
  const left = Math.max(minimum, Math.min(total - minimum, widths[index] + delta));
  return widths.map((width, position) => position === index ? left : position === index + 1 ? total - left : width);
}

export function canSubmitDecision(type, action, answer = '') {
  if (type === '澄清') return ['allow', 'deny'].includes(action) || (action === 'custom' && Boolean(answer.trim()));
  if (type === '验收') return action === 'accept' || (action === 'revise' && Boolean(answer.trim()));
  return type === '外发授权' && ['allow', 'deny'].includes(action);
}

export function decisionLabel(type, action) {
  if (type === '澄清') return action === 'deny' ? '已按现有资料继续' : action === 'custom' ? '范围说明已提交' : '已确认本次使用范围';
  if (type === '验收') return action === 'accept' ? '成果已验收' : '修改意见已提交';
  return action === 'allow' ? '本次发布已授权' : '已拒绝本次外发';
}
