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

export function groupToolMessages(messages) {
  const entries = [];
  for (const message of messages) {
    const last = entries.at(-1);
    if (message.tool && message.groupId) {
      if (last?.kind === 'tools' && last.id === message.groupId) last.messages.push(message);
      else entries.push({ kind: 'tools', id: message.groupId, label: message.groupLabel || '工具执行', messages: [message] });
    } else {
      entries.push({ kind: 'message', message });
    }
  }
  return entries;
}

/**
 * 运行指示只回答“后台是否正常”，不给数字。
 *
 * 异常指任务自身出了问题、值得看一眼现场：恢复待确认、执行失败、长时间无进展。
 * 等待用户处理的状态（澄清、验收、授权）已经由 Inbox 计数，这里不算异常。
 */
export const ANOMALY_STATUSES = new Set(['recovery', 'failed', 'stalled']);

export const RUN_INDICATOR_LABELS = { idle: '空闲', ok: '运行中', attention: '需要留意' };

export function deriveRunIndicator(tasks) {
  const running = tasks.filter((task) => task.status === 'running');
  const queued = tasks.filter((task) => task.status === 'queued');
  const anomalies = tasks.filter((task) => ANOMALY_STATUSES.has(task.status));
  const state = anomalies.length ? 'attention' : running.length || queued.length ? 'ok' : 'idle';
  return { state, running, queued, anomalies };
}

/** 悬停摘要：只列非零项，例如“3 个执行中 · 1 个排队 · 1 个异常”。 */
export function describeRunIndicator({ running, queued, anomalies }) {
  const parts = [
    [running.length, '个执行中'],
    [queued.length, '个排队'],
    [anomalies.length, '个异常'],
  ].filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
  return parts.length ? parts.join(' · ') : '没有执行中或排队的任务';
}

/**
 * 成果抽屉的列表：按时间倒序，并标出未查看与待验收。
 *
 * at 是可排序的时间（ISO 字符串或时间戳）；viewedIds 是已打开过的成果 id 集合。
 * 待验收以来源任务的状态为准，验收动作只在 Inbox 里做。
 */
export function listRecentOutputs(outputs, tasks, viewedIds) {
  return [...outputs]
    .sort((left, right) => new Date(right.at) - new Date(left.at))
    .map((output) => {
      const task = tasks.find((item) => item.id === output.taskId);
      return {
        ...output,
        taskTitle: task?.title || '',
        unviewed: !viewedIds.has(output.id),
        awaitingAcceptance: task?.status === 'acceptance',
      };
    });
}
