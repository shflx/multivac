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
 * 异常指任务自身出了问题、值得看一眼现场：恢复待确认、执行失败、长时间无进展、被环境停止。
 * 等待用户处理的状态（澄清、验收、授权）已经由 Inbox 计数，这里不算异常。
 */
export const ANOMALY_STATUSES = new Set(['recovery', 'failed', 'stalled', 'env-stopped']);

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

/**
 * 原型里 Multivac 对一句话的粗粒度意图判断（真实实现由模型完成）。
 *
 * - project：“把 ~/code/notes 作为项目”，一句话创建项目并挂载目录；
 * - output：“把昨天那份调研报告给我”，在对话里直接取回成果；
 * - task：出现整理、成文等交付意图，给出任务确认卡；
 * - chat：其余都按讨论处理，不自动变成待办。
 */
export function parseAssistantIntent(prompt) {
  const text = prompt.trim();
  const project = text.match(/把\s*(\S+?)\s*(?:作为|设为|当作)项目/u);
  if (project) return { kind: 'project', path: project[1] };
  if (!/整理/u.test(text) && /(给我|找出|找一下|发我|拿来)/u.test(text) && /(报告|成果|文档|说明|结论|变更)/u.test(text)) return { kind: 'output' };
  if (/整理|文档/u.test(text)) return { kind: 'task' };
  return { kind: 'chat' };
}

/** 按标题与提问的重合字词挑出最相关的成果；都不沾边时给最近的一份。 */
export function matchOutput(outputs, prompt) {
  if (!outputs.length) return null;
  const pairs = (text) => new Set([...text].slice(0, -1).map((char, index) => char + text[index + 1]));
  const asked = pairs(prompt);
  const scored = outputs.map((output) => ({ output, score: [...pairs(output.title)].filter((pair) => asked.has(pair)).length }));
  const best = scored.reduce((top, item) => item.score > top.score ? item : top, scored[0]);
  if (best.score > 0) return best.output;
  return [...outputs].sort((left, right) => new Date(right.at) - new Date(left.at))[0];
}
