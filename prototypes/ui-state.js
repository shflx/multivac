export const MIN_PANE_WIDTH = 320;

// 只调整分隔线相邻的两列，保留总宽度与其他会话的现场。
export function resizePair(widths, index, delta) {
  if (index < 0 || index >= widths.length - 1) return widths;
  const total = widths[index] + widths[index + 1];
  const minimum = Math.min(MIN_PANE_WIDTH, total / 2);
  const left = Math.max(minimum, Math.min(total - minimum, widths[index] + delta));
  return widths.map((width, position) => position === index ? left : position === index + 1 ? total - left : width);
}

/**
 * 调整第 index 与 index + 1 栏之间的分隔线。
 * 放得下时两栏此消彼长、总宽不变；放不下（网格已横向滚动）时只调整左侧这一栏，
 * 右侧各栏随之平移，否则所有栏都卡在最小宽度上无法调整。
 */
export function resizeColumns(widths, index, delta, overflowing) {
  if (!overflowing) return resizePair(widths, index, delta);
  if (index < 0 || index >= widths.length - 1) return widths;
  return widths.map((width, position) => position === index ? Math.max(MIN_PANE_WIDTH, width + delta) : width);
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

/**
 * 并排栏位：slots[k] 是第 k + 1 栏的会话 id，长度等于并排数。
 *
 * 先校验已保存的栏位（去掉已不在工作区的会话与重复项），
 * 再把空栏按工作区顺序补上尚未展示的会话；会话不够时留空。
 */
export function resolveSlots(stored, members, count) {
  const slots = Array.from({ length: count }, (_, index) => {
    const id = stored?.[index];
    return members.includes(id) ? id : null;
  });
  slots.forEach((id, index) => {
    if (id && slots.indexOf(id) !== index) slots[index] = null;
  });
  const spare = members.filter((id) => !slots.includes(id));
  return slots.map((id) => id ?? spare.shift() ?? null);
}

/** 把会话放进第 slot + 1 栏：已在另一栏则两栏互换，否则替换这一栏原来的会话。 */
export function placeInSlot(slots, id, slot) {
  const next = [...slots];
  const from = next.indexOf(id);
  if (from === slot) return next;
  if (from >= 0) next[from] = next[slot];
  next[slot] = id;
  return next;
}

/** 并排数的可选值；工作区默认并排两栏。 */
export const PARALLEL_OPTIONS = [2, 3, 4];
export const DEFAULT_PARALLEL = 2;

/**
 * 调整并排数时的栏位：多出的栏退出显示（会话本身不关闭，仍在会话列表里）；
 * 当前会话若落在被去掉的栏，就放进保留下来的最后一栏，保证它始终在显示中。
 */
export function resizeSlots(slots, count, currentId) {
  const kept = slots.slice(0, count);
  while (kept.length < count) kept.push(null);
  if (currentId && slots.includes(currentId) && !kept.includes(currentId)) kept[count - 1] = currentId;
  return kept;
}

/** 栈式深入的层级：{ 根会话 id: [{ quote, title }, …] }，只保留格式正确的非空层级。 */
function normalizeStacks(stacks) {
  const result = {};
  for (const [rootId, nodes] of Object.entries(stacks && typeof stacks === 'object' ? stacks : {})) {
    const valid = Array.isArray(nodes) ? nodes.filter((node) => typeof node?.quote === 'string' && typeof node?.title === 'string') : [];
    if (valid.length) result[rootId] = valid;
  }
  return result;
}

/**
 * 读取工作区现场：{ count, slots, widths, viewMode, focusedId, stacks }。
 * widths 按并排数分别记住各栏宽度；stacks 记录每个会话当前深入到的层级，深入不改变栏位。
 * 兼容旧版只保存栏位数组的两栏现场（legacy），会话顺序原样沿用。
 */
export function normalizeScenes(stored, legacy) {
  const scenes = {};
  for (const [workspaceId, slots] of Object.entries(legacy || {})) {
    if (Array.isArray(slots)) scenes[workspaceId] = { count: DEFAULT_PARALLEL, slots, widths: {} };
  }
  for (const [workspaceId, scene] of Object.entries(stored || {})) {
    if (!scene || !Array.isArray(scene.slots)) continue;
    scenes[workspaceId] = {
      count: PARALLEL_OPTIONS.includes(scene.count) ? scene.count : DEFAULT_PARALLEL,
      slots: scene.slots,
      widths: scene.widths && typeof scene.widths === 'object' ? scene.widths : {},
      viewMode: scene.viewMode === 'focus' ? 'focus' : 'parallel',
      focusedId: typeof scene.focusedId === 'string' ? scene.focusedId : null,
      stacks: normalizeStacks(scene.stacks),
    };
  }
  return scenes;
}
