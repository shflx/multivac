export const TASK_COLUMNS = [
  { id: 'idle', label: '未开始' },
  { id: 'running', label: '执行中' },
  { id: 'waiting', label: '阻塞' },
  { id: 'paused', label: '已暂停' },
  { id: 'done', label: '已完成' },
];

const EXCEPTIONS = new Set(['recovery', 'failed', 'stalled', 'env-stopped', 'scheduler-paused']);
const WAITING = { 澄清: '澄清', 工具授权: '授权', 外发授权: '授权', 验收: '验收', 恢复确认: '恢复确认' };
const EXCEPTION_LABELS = { recovery: '恢复待确认', failed: '执行失败', stalled: '无新进展', 'env-stopped': '环境停止', 'scheduler-paused': '恢复待确认' };

/** 未处理请求优先于普通执行状态；异常保留独立标记，不归为用户暂停。 */
export function presentTask(task, requests) {
  const request = requests.find((item) => item.taskId === task.id && item.state !== 'done');
  const abnormal = EXCEPTIONS.has(task.status);
  const waitLabel = request ? WAITING[request.type] : { clarification: '澄清', authorization: '授权', acceptance: '验收', recovery: '恢复确认', 'scheduler-paused': '恢复确认' }[task.status];
  const column = waitLabel || task.status === 'failed' ? 'waiting' : task.status === 'done' ? 'done' : task.status === 'paused' ? 'paused' : ['idle', 'queued'].includes(task.status) ? 'idle' : 'running';
  const label = waitLabel ? waitLabel === '恢复确认' ? waitLabel : `待${waitLabel}` : abnormal ? EXCEPTION_LABELS[task.status] : TASK_COLUMNS.find((item) => item.id === column).label;
  const tone = abnormal ? 'danger' : column === 'waiting' ? 'warn' : column === 'running' ? 'info' : column === 'done' ? 'success' : 'muted';
  return { column, label, tone, abnormal, waitLabel, request, summary: waitLabel || abnormal || column === 'paused' ? task.reason : task.next };
}

export function filterPanelTasks(tasks, requests, { query = '', project = 'all', status = 'unfinished' } = {}) {
  const text = query.trim().toLowerCase();
  return tasks.filter((task) => {
    const state = presentTask(task, requests);
    const matchesStatus = status === 'all' || (status === 'unfinished' ? state.column !== 'done' : status === 'exception' ? state.abnormal : status === 'running' ? state.column === 'running' && !state.abnormal : state.column === status);
    return matchesStatus && (project === 'all' || (task.projectId || 'daily') === project) && (!text || [task.title, task.goal, task.reason, task.next, task.session].filter(Boolean).join(' ').toLowerCase().includes(text));
  });
}

export function splitCompleted(tasks, now = Date.now()) {
  const completed = tasks.filter((task) => task.status === 'done').sort((a, b) => Date.parse(b.completedAt || '') - Date.parse(a.completedAt || ''));
  const recent = completed.filter((task) => Date.parse(task.completedAt || '') >= now - 7 * 86400000).slice(0, 5);
  return { recent, older: completed.filter((task) => !recent.includes(task)) };
}

export function visibleSelectedId(selectedId, tasks) {
  return tasks.some((task) => task.id === selectedId) ? selectedId : null;
}

/** 拖动触发现有业务动作；请求与验收不能通过改标签绕过。 */
export function taskDropAction(task, requests, target) {
  const state = presentTask(task, requests);
  if (target === state.column) return { kind: 'reorder', label: '调整任务顺序' };
  if (state.request) {
    if ((target === 'running' && state.waitLabel !== '验收') || (target === 'done' && state.waitLabel === '验收')) return { kind: 'request', label: state.waitLabel === '验收' ? '打开成果验收' : `处理${state.waitLabel}请求` };
    return { kind: 'blocked', label: `先处理${state.waitLabel}请求` };
  }
  if (state.abnormal) return { kind: 'blocked', label: '先进入现场处理执行异常' };
  if (target === 'running' && ['idle', 'paused'].includes(state.column)) return { kind: 'start', label: state.column === 'paused' ? '继续执行' : '启动任务' };
  if (target === 'paused' && state.column === 'running') return { kind: 'pause', label: '暂停任务' };
  return { kind: 'blocked', label: target === 'done' ? '完成状态需要成果或验收确认' : '该状态不能直接变更' };
}

export function orderTasks(tasks, order) {
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...tasks].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
}

export function reorderTasks(order, members, id, beforeId = null) {
  const all = [...new Set([...order.filter((item) => members.includes(item)), ...members])];
  if (!members.includes(id) || beforeId === id) return all;
  const next = all.filter((item) => item !== id);
  const index = beforeId ? next.indexOf(beforeId) : -1;
  next.splice(index < 0 ? next.length : index, 0, id);
  return next;
}

/** 决策恢复实际推进，不经过排队；拒绝恢复保留为停止异常。 */
export function taskAfterDecision(request, action, answer = '') {
  if (request.type === '澄清') return { status: 'running', reason: action === 'deny' ? '已确认不使用个人笔记，按项目资料继续' : action === 'custom' ? `已收到补充范围：${answer.trim()}` : '本次引用范围已确认', next: '根据确认范围整理资料' };
  if (request.type === '验收') return action === 'accept' ? { status: 'done', reason: '成果已验收', next: '查看并使用成果' } : { status: 'running', reason: `已收到修改意见：${answer.trim()}`, next: '根据反馈修改成果并重新提交验收' };
  if (request.type === '工具授权') return { status: 'running', reason: action === 'deny' ? `已拒绝 ${request.capability}，改用已授权方式` : `已授权 ${request.capability}`, next: action === 'deny' ? '调整方案，保留本地成果' : '继续执行已确认的工具步骤' };
  if (request.type === '恢复确认') return action === 'stop' ? { status: 'env-stopped', reason: '你选择保持停止，未恢复旧命令', next: '进入现场检查环境与遗留命令' } : { status: 'running', reason: action === 'restart' ? '你已确认从安全起点重新执行' : '你已确认继续上次执行', next: '核对工作区变更并继续代码修改' };
  return { status: 'done', reason: action === 'allow' ? '已授权发布并完成' : '成果已完成，外发已拒绝', next: '查看成果' };
}

export function taskWithEvent(task, patch, title = patch.reason, at = new Date().toISOString()) {
  return { ...task, ...patch, ...(patch.status === 'done' ? { completedAt: at } : {}), events: title ? [...(task.events || []), { at, title }] : task.events || [] };
}

const DEMO_FACTS = {
  prototype: ['整理核心交互、页面状态和不实现范围，形成可验收的原型说明。', '已读取 MVP 需求文档', '已完成主导航与 Inbox 状态梳理'],
  recovery: ['修复服务重启后的会话恢复状态，并验证恢复测试。', '已复现落盘顺序问题', '恢复测试已通过，已发起推送授权请求'],
  permissions: ['明确验收、外发和资料传输的授权边界。', '已读取项目权限约束', '已区分三类授权'],
  isolation: ['核对命令隔离的文件系统、网络和子进程边界。', '已执行隔离探针', '已收集文件系统与网络拦截结果'],
  'agent-sdk': ['对比指定 Agent SDK 的会话、工具调用和恢复能力。', '已选定调研资料目录'],
  'project-doc': ['根据当前实现更新项目说明和维护约束。', '已读取现有项目说明', '你已主动暂停文档更新'],
  scope: ['在已确认范围内整理个人笔记与项目资料。', '已整理项目资料', '已提交个人笔记引用范围澄清'],
  review: ['审阅本次实现的关键交互和验收边界。', '已完成 3 项自检', '已提交交互原型说明供验收'],
  publish: ['发布已经完成的变更说明到外部仓库。', '已生成变更说明摘要', '已提交本次外发授权请求'],
  report: ['比较 Coding Agent SDK 并保留证据与不确定性。', '已核对 12 个公开来源', '已生成调研报告并通过自检'],
  index: ['重建项目知识库索引并验证检索结果。', '已启动索引进程', '监测到索引进程 25 分钟无新进展'],
  interrupted: ['恢复隔离工作区内中断的代码修改。', '已保存工作区变更', '检测到上次命令状态不明确，已提交恢复确认'],
  'failed-check': ['验证构建脚本在当前环境可重复执行。', '已执行构建命令', '构建失败：缺少演示环境的 TypeScript 配置'],
  'old-doc': ['整理上一轮目录约束说明。', '已生成目录约束文档', '已完成验收'],
  'old-release': ['完成上一轮原型变更说明。', '已核对变更列表', '已生成并确认变更说明'],
};

export function seedTaskFacts(task) {
  const [goal, ...events] = DEMO_FACTS[task.id] || [task.title];
  const old = task.id.startsWith('old-');
  const age = { scope: 8, review: 24, recovery: 2, publish: 60, interrupted: 12 }[task.id] || 30;
  const end = Date.now() - (old ? 14 : 0) * 86400000 - age * 60000;
  return { ...task, goal, events: events.map((title, index) => ({ title, at: new Date(end - (events.length - index - 1) * 8 * 60000).toISOString() })), ...(task.status === 'done' ? { completedAt: new Date(end).toISOString() } : {}) };
}
