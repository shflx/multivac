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
  if (type === '工具授权') return ['deny', 'once', 'session', 'project'].includes(action);
  return type === '外发授权' && ['allow', 'deny'].includes(action);
}

export function decisionLabel(type, action) {
  if (type === '澄清') return action === 'deny' ? '已按现有范围继续' : action === 'custom' ? '范围说明已提交' : '已确认本次使用范围';
  if (type === '验收') return action === 'accept' ? '成果已验收' : '修改意见已提交';
  if (type === '工具授权') return { deny: '已拒绝这次调用', once: '已允许这一次', session: '本会话内已允许', project: '本项目内始终允许' }[action];
  return action === 'allow' ? '本次发布已授权' : '已拒绝本次外发';
}

/**
 * 记住的授权：{ id, kind: 'tool' | 'directory', subject, scope: 'session' | 'project', sessionId?, projectId?, at }。
 * 授权总有范围，所以只在对应的项目（权限区块）或会话（工作目录浮层、会话页）里查看和撤销。
 */
export const GRANT_SCOPE_LABELS = { session: '本会话内允许', project: '本项目内始终允许' };
export const GRANT_KIND_LABELS = { tool: '工具', directory: '目录' };

/** 按项目或会话筛选记住的授权：项目只看项目级，会话只看会话级。 */
export function grantsOf(grants, { projectId, sessionId }) {
  if (projectId) return grants.filter((grant) => grant.scope === 'project' && grant.projectId === projectId);
  if (sessionId) return grants.filter((grant) => grant.scope === 'session' && grant.sessionId === sessionId);
  return [];
}

/** 撤销授权：之后同类操作重新需要你确认。 */
export function revokeGrant(grants, grantId) {
  return grants.filter((grant) => grant.id !== grantId);
}

/**
 * 授权卡或 Inbox 上选“记住”后生成的授权；只允许这一次、拒绝都不记。
 * 不属于项目的会话没有“本项目内”这一档，按本会话记。
 */
export function grantFromDecision({ action, subject, sessionId, projectId, kind = 'tool', at, id }) {
  if (action !== 'session' && action !== 'project') return null;
  const scope = action === 'project' && projectId ? 'project' : 'session';
  return scope === 'project' ? { id, kind, subject, scope, projectId, at } : { id, kind, subject, scope, sessionId, at };
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
 * - connect：“接入 GitHub”，给出接入确认卡；
 * - manage：“先做这个”“暂停 X”“并发调到 3”“X 不用验收了”“打开待办”等管理动作；
 * - output：“把昨天那份调研报告给我”，在对话里直接取回成果；
 * - task：出现整理、成文等交付意图，给出任务确认卡；
 * - chat：其余都按讨论处理，不自动变成待办。
 */
export function parseAssistantIntent(prompt) {
  const text = prompt.trim();
  const project = text.match(/把\s*(\S+?)\s*(?:作为|设为|当作)项目/u);
  if (project) return { kind: 'project', path: project[1] };
  const connect = text.match(/^(?:帮我)?接入\s*(\S+)/u);
  if (connect) return { kind: 'connect', name: connect[1] };
  const manage = parseManagementIntent(text);
  if (manage) return { kind: 'manage', ...manage };
  // “/Skill 名”显式调用 Skill：在 Multivac 中生成使用该 Skill 的任务。
  const skill = text.match(/^\/(\S+)/u);
  if (skill) return { kind: 'task', skill: skill[1] };
  const open = parseOpenIntent(text);
  if (open) return { kind: 'open', ...open };
  if (/整理|文档/u.test(text)) return { kind: 'task' };
  return { kind: 'chat' };
}

/**
 * 打开工作对象：取回成果、继续读某本书、打开某篇笔记共用一套意图。
 * 返回对象类型与去掉动词、类型词后的名称线索；带“整理”的是交付意图，不算打开。
 */
export function parseOpenIntent(text) {
  if (/整理/u.test(text)) return null;
  const query = text.replace(/(继续读|接着读|打开|翻开|给我|找出|找一下|发我|拿来|一下|那篇|这篇|的|把|笔记|《|》)/gu, '').trim();
  if (/(继续读|接着读|翻开)/u.test(text) || /(打开|给我).*《[^》]+》/u.test(text)) return { type: 'book', query };
  if (/(打开|给我|找一下)/u.test(text) && /笔记/u.test(text)) return { type: 'note', query };
  if (/(给我|找出|找一下|发我|拿来)/u.test(text) && /(报告|成果|文档|说明|结论|变更)/u.test(text)) return { type: 'output', query };
  return null;
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
      // 在工作区打开的应用对象（如 output:mvp-doc），以及各对象伴随会话的展开状态。
      objects: Array.isArray(scene.objects) ? scene.objects.filter((id) => typeof id === 'string') : [],
      companions: scene.companions && typeof scene.companions === 'object' ? scene.companions : {},
    };
  }
  return scenes;
}

/** 推理等级从低到高；“关闭”永远可选。 */
export const THINKING_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
// 手动设为“支持”、但 Pi 目录没有给出等级时使用的通用等级。
const MANUAL_REASONING_LEVELS = ['off', 'low', 'medium', 'high'];

export const REASONING_MODES = [
  { value: 'auto', label: '自动（按 Pi 目录）' },
  { value: 'supported', label: '支持' },
  { value: 'unsupported', label: '不支持' },
];

/**
 * 模型的推理能力：保存校验、新会话启动、重启恢复、可用性检查与发送都只用这一处判断。
 *
 * model.reasoning 是用户设置（缺省视为 auto）；model.catalog 是 Pi 模型目录中的条目，
 * 不在目录里（如自建地址的 Responses 模型）时为 null，自动模式下按 Pi 默认视为不支持。
 */
export function resolveReasoning(model) {
  const mode = model?.reasoning === 'supported' || model?.reasoning === 'unsupported' ? model.reasoning : 'auto';
  const catalog = model?.catalog || null;
  if (mode === 'supported') {
    return { mode, supported: true, source: '手动设置', levels: catalog?.reasoning ? catalog.levels : MANUAL_REASONING_LEVELS };
  }
  if (mode === 'unsupported') return { mode, supported: false, source: '手动设置', levels: ['off'] };
  if (catalog) return { mode, supported: Boolean(catalog.reasoning), source: 'Pi 目录', levels: catalog.reasoning ? catalog.levels : ['off'] };
  return { mode, supported: false, source: 'Pi 默认', levels: ['off'] };
}

/**
 * 发送时实际使用的推理等级：会话保存的是用户偏好，按模型当前能力取不超过偏好的最高可用等级。
 * 所以已开着的会话改了模型设置后，下一次发送自动按新能力生效。
 */
export function effectiveThinking(preferred, model) {
  const { levels } = resolveReasoning(model);
  if (levels.includes(preferred)) return preferred;
  const ceiling = THINKING_ORDER.indexOf(preferred);
  const allowed = levels.filter((level) => THINKING_ORDER.indexOf(level) <= ceiling);
  return allowed.at(-1) || 'off';
}


/** 模型协议（与 Pi 支持的四种一致）。 */
export const MODEL_PROTOCOLS = [
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'openai-completions', label: 'OpenAI Chat Completions' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'google-generative-ai', label: 'Google Generative AI' },
];

// 官方提供方的协议是确定的；“OpenAI 兼容”的服务各自实现不同，协议必须手选，所以没有默认值。
const PROVIDER_PROTOCOLS = { openai: 'openai-responses', anthropic: 'anthropic-messages', google: 'google-generative-ai' };

/** 按提供方给出协议默认值；OpenAI 兼容返回空字符串，表示需要手选。 */
export function defaultProtocol(provider) {
  return PROVIDER_PROTOCOLS[provider] || '';
}

/** 模型配置能否保存：返回不能保存的原因；可以保存时返回空字符串。 */
export function modelConfigError(model) {
  const compatible = model.provider === 'openai-compatible';
  if (!model.name.trim()) return '显示名称不能为空。';
  if (!model.modelId.trim()) return '模型 ID 不能为空。';
  if (!model.protocol) return compatible ? 'OpenAI 兼容的模型需要手动选择协议。' : '请选择协议。';
  if (compatible && !model.endpoint.trim()) return 'OpenAI 兼容的模型需要填写 API 端点。';
  return '';
}

// 这些字段决定连到哪里、怎么连；改了之后上一次的连接检查不再算数。
const CONNECTION_FIELDS = ['provider', 'protocol', 'modelId', 'endpoint'];

/** 保存编辑：连接相关的字段有变化时，清掉上一次的检查结果。 */
export function applyModelEdit(model, draft) {
  const changed = CONNECTION_FIELDS.some((field) => field in draft && draft[field] !== model[field]);
  return { ...model, ...draft, check: changed ? null : model.check };
}

/**
 * 模拟一次连接检查（原型没有真实请求）：配置有误、没有 API Key 时直接失败；
 * 指向本机的端点按“本地服务没启动”失败，其余视为连接成功。
 */
export function simulateModelCheck(model, at = '刚刚') {
  const configError = modelConfigError(model);
  if (configError) return { status: 'failed', message: configError, at };
  if (!model.keyStored) return { status: 'failed', message: '没有可用于检查的 API Key。', at };
  const local = model.endpoint.match(/\/\/((?:127\.0\.0\.1|localhost)(?::\d+)?)/u);
  if (local) return { status: 'failed', message: `无法连接 ${local[1]}，请确认本地服务已经启动。`, at };
  return { status: 'passed', message: '连接成功', at };
}

/**
 * 模型是否可用，以及原因：配置 → API Key → 连接检查，逐项往下判断。
 * 只有最近一次检查通过才算可用；会话、智能体与模型页共用这一处判断。
 */
export function modelAvailability(model) {
  const configError = modelConfigError(model);
  if (configError) return { available: false, state: 'invalid', label: '配置需修复', message: configError };
  if (!model.keyStored) return { available: false, state: 'auth', label: '未认证', message: '还没有配置 API Key。' };
  if (!model.check) return { available: false, state: 'unchecked', label: '待检查', message: '配置已就绪，检查一次连接后即可使用。' };
  if (model.check.status === 'failed') return { available: false, state: 'failed', label: '连接失败', message: model.check.message };
  return { available: true, state: 'ok', label: '可用', message: '最近一次连接检查通过。' };
}


/**
 * 快速跳转的文字搜索：按空格分词，每个词都要命中标题、说明或关键词（不分大小写）；
 * 标题以第一个词开头的排最前，其次是标题含有它的，其余保持原来的顺序。
 */
export function searchJumpItems(items, query) {
  const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (!terms.length) return items;
  const textOf = (item) => [item.label, item.hint, ...(item.keywords || [])].filter(Boolean).join(' ').toLowerCase();
  const rankOf = (item) => {
    const label = item.label.toLowerCase();
    if (label.startsWith(terms[0])) return 0;
    return label.includes(terms[0]) ? 1 : 2;
  };
  return items
    .filter((item) => terms.every((term) => textOf(item).includes(term)))
    .map((item, index) => ({ item, index, rank: rankOf(item) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ item }) => item);
}

/** 效果等级从低到高；项目与智能体的效果上限按此比较。 */
export const EFFECT_ORDER = ['read', 'local', 'external', 'egress'];
export const EFFECT_LABELS = { read: '只读', local: '本地写', external: '外部副作用', egress: '数据外传' };

/** 工具没有标注效果等级时一律按“外部副作用”处理。 */
export function toolEffect(tool) {
  return EFFECT_ORDER.includes(tool?.effect) ? tool.effect : 'external';
}

/** 一项能力的效果等级取其中最高的工具（Skill 自带等级）。 */
export function capabilityEffect(capability) {
  if (!capability.tools?.length) return EFFECT_ORDER.includes(capability.effect) ? capability.effect : 'read';
  return capability.tools.map(toolEffect).reduce((top, effect) => EFFECT_ORDER.indexOf(effect) > EFFECT_ORDER.indexOf(top) ? effect : top, 'read');
}

export function withinEffectCap(effect, cap) {
  return EFFECT_ORDER.indexOf(effect) <= EFFECT_ORDER.indexOf(cap);
}

/** 项目与智能体的效果上限取更严的一档；不属于项目时按保守默认，只到“只读”。 */
export function effectiveCap(project, agent) {
  // 不属于项目的会话在自己的临时目录里工作，可以本地写，但不对外。
  const caps = [project ? project.effectCap : 'local', agent?.effectCap || 'egress'];
  return caps.reduce((low, cap) => EFFECT_ORDER.indexOf(cap) < EFFECT_ORDER.indexOf(low) ? cap : low, 'egress');
}

/**
 * 能力默认可用、按例外排除：登记即可用，只有下面几种情况不可用，并逐项写明原因。
 *
 * - 服务与工具：本项目已排除；超出效果上限（项目与智能体取更严的一档）；服务未连接。
 * - Skill：不标效果等级。本项目已隐藏；缺少依赖（它会用到的服务在这里不可用）。
 *   项目自带的 Skill 只在所属项目里出现。
 */
export function resolveAvailability({ registry, project, agent }) {
  const cap = effectiveCap(project, agent);
  const excluded = project?.excluded || [];
  const serviceReason = (capability) => {
    if (excluded.includes(capability.id)) return '本项目已排除';
    if (!withinEffectCap(capabilityEffect(capability), cap)) return '超出效果上限';
    if (capability.kind === 'mcp' && capability.status !== 'connected') return '服务未连接';
    return '';
  };
  const byId = Object.fromEntries(registry.map((capability) => [capability.id, capability]));
  const available = [];
  const unavailable = [];
  for (const capability of registry) {
    if (capability.kind === 'skill') {
      if (capability.projectId && capability.projectId !== project?.id) continue;
      const missing = (capability.uses || []).filter((id) => !byId[id] || serviceReason(byId[id]));
      const reason = project?.hiddenSkills?.includes(capability.id) ? '本项目已隐藏'
        : missing.length ? `缺少依赖：${missing.map((id) => byId[id]?.name || id).join('、')}` : '';
      (reason ? unavailable : available).push(reason ? { capability, reason } : capability);
      continue;
    }
    const reason = serviceReason(capability);
    (reason ? unavailable : available).push(reason ? { capability, reason } : capability);
  }
  return { cap, available, unavailable };
}

/**
 * 会话标题行的异常标记：平时不显示能力；只有本会话临时关闭了能力，或本该可用的服务连接异常时才标出。
 * usable / unavailable 来自 resolveAvailability，paused 是本会话临时关闭的能力 id。
 */
export function sessionAlerts({ usable = [], unavailable = [], paused = [] }) {
  const alerts = [];
  const pausedNames = usable.filter((capability) => paused.includes(capability.id)).map((capability) => capability.name);
  if (pausedNames.length) {
    alerts.push({ kind: 'paused', label: pausedNames.length === 1 ? `已暂停 ${pausedNames[0]}` : `已暂停 ${pausedNames.length} 项能力`, detail: pausedNames.join('、') });
  }
  // 被项目排除、超出效果上限的是有意的边界，不算异常；只有“服务未连接”才提示。
  for (const { capability, reason } of unavailable) {
    if (reason === '服务未连接') alerts.push({ kind: 'disconnected', label: `${capability.name} 连接异常`, detail: capability.lastError || reason });
  }
  return alerts;
}

/**
 * 一个任务将用到的能力：智能体需要的服务与常用 Skill，加上任务临时增加的，去掉临时不用的。
 * 冲突时项目优先并说清原因：不可用的列进 blocked，不静默降级也不静默越权。
 */
export function resolveCapabilities({ registry, project, agent, added = [], removed = [] }) {
  const { available, unavailable } = resolveAvailability({ registry, project, agent });
  const wanted = [...new Set([...(agent.requiredServices || []), ...(agent.preferredSkills || []), ...added])].filter((id) => !removed.includes(id));
  return {
    usable: available.filter((capability) => wanted.includes(capability.id)),
    blocked: unavailable.filter(({ capability }) => wanted.includes(capability.id)),
  };
}

/**
 * “为本项目放开”：取消排除或隐藏；超出上限时把项目上限提到这项能力所需的档位；
 * Skill 缺少依赖时一并放开它用到的服务。返回项目的新设置。
 */
export function releaseForProject(project, capability, registry) {
  const targets = [capability, ...(capability.uses || []).map((id) => registry.find((item) => item.id === id)).filter(Boolean)];
  let { effectCap } = project;
  for (const target of targets) {
    if (target.kind !== 'skill' && !withinEffectCap(capabilityEffect(target), effectCap)) effectCap = capabilityEffect(target);
  }
  const ids = targets.map((target) => target.id);
  return {
    ...project,
    effectCap,
    excluded: (project.excluded || []).filter((id) => !ids.includes(id)),
    hiddenSkills: (project.hiddenSkills || []).filter((id) => !ids.includes(id)),
  };
}

/**
 * 输入区的两个入口：行首的“/”调用 Skill，任意位置的“@”引用对象。
 * 返回光标前正在输入的触发词（kind、已输入的查询、触发符位置），没有则为 null。
 */
export function composerTrigger(text, caret = text.length) {
  const before = text.slice(0, caret);
  const skill = before.match(/^\/(\S*)$/u);
  if (skill) return { kind: 'skill', query: skill[1], start: 0 };
  const reference = before.match(/(^|\s)@(\S*)$/u);
  if (reference) return { kind: 'reference', query: reference[2], start: before.length - reference[2].length - 1 };
  return null;
}

/** 选中候选后替换触发词，并补一个空格便于继续输入。 */
export function applyComposerPick(text, trigger, token, caret = text.length) {
  return `${text.slice(0, trigger.start)}${token} ${text.slice(caret).replace(/^\s+/u, '')}`;
}

// 管理页的口语名称 → 页面 id。
const MANAGEMENT_PAGES = { 待办: 'tasks', 运行: 'runs', inbox: 'inbox', 成果: 'outputs', 设置: 'settings' };

/**
 * 管理动作的自然语言入口：效果与管理中的操作一致。
 * target 为空或是“这个 / 它”时，指当前焦点会话对应的任务。
 */
export function parseManagementIntent(text) {
  const value = text.trim();
  const concurrency = value.match(/并发(?:上限)?(?:调到|调成|改成|改为|设为|设成)\s*(\d+)/u);
  if (concurrency) return { action: 'concurrency', value: Number(concurrency[1]) };
  const page = value.match(/^(?:打开|看看|去)\s*(待办|运行|inbox|成果|设置)\s*$/iu);
  if (page) return { action: 'open-page', page: MANAGEMENT_PAGES[page[1].toLowerCase()] };
  const doNow = value.match(/^先做\s*(.*)$/u);
  if (doNow) return { action: 'do-now', target: doNow[1].trim() };
  const pause = value.match(/^暂停\s*(.+)$/u);
  if (pause) return { action: 'pause', target: pause[1].trim() };
  const noAcceptance = value.match(/^(.+?)\s*(?:不用|不需要)验收了?$/u);
  if (noAcceptance) return { action: 'no-acceptance', target: noAcceptance[1].trim() };
  return null;
}

/** 按标题重合的字词挑出最相关的一项；一点都不沾边时返回 null。 */
export function matchByTitle(items, query) {
  const pairs = (text) => new Set([...text].slice(0, -1).map((char, index) => char + text[index + 1]));
  const asked = pairs(query);
  let best = null;
  let bestScore = 0;
  for (const item of items) {
    const score = [...pairs(item.title)].filter((pair) => asked.has(pair)).length;
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

/** “这个 / 它 / 空”指当前焦点，不按标题匹配。 */
export function refersToFocus(target) {
  return !target || /^(这个|它|这项|这个任务)$/u.test(target);
}

/**
 * 笔记是你亲手写的内容，Agent 只以差异建议的形式修改：接受时把 before 原样替换为 after；
 * before 已经不在正文里（你先改过了）时不动正文，返回 null 交由界面提示。
 */
export function applySuggestion(content, suggestion) {
  if (!suggestion.before) return `${content.replace(/\s+$/u, '')}\n\n${suggestion.after}`;
  if (!content.includes(suggestion.before)) return null;
  return content.replace(suggestion.before, suggestion.after);
}

/** 收进笔记：选中内容以引用块追加到笔记末尾，并注明出处。 */
export function appendExcerpt(content, text, source) {
  const quoted = text.trim().split('\n').map((line) => `> ${line}`).join('\n');
  // 出处已带「」或《》（如 成果「X」、《书名》）时不再套一层引号；空笔记不留开头空行。
  const cite = /[「《]/u.test(source) ? source : `「${source}」`;
  const body = content.replace(/\s+$/u, '');
  return `${body ? `${body}\n\n` : ''}${quoted}\n> —— 摘自${cite}\n`;
}

/**
 * 书伴默认不剧透：问题里提到你还没读到的章节内容时，只说明会在读到后再聊。
 * chapters 按顺序排列，每章带 keywords；readIndex 是当前读到的章节下标。
 */
export function spoilerChapter(question, chapters, readIndex) {
  return chapters.find((chapter, index) => index > readIndex && chapter.keywords.some((keyword) => question.includes(keyword))) || null;
}

/** 安排类意图（创建任务、管理动作、接入能力等）应交给 Multivac，伴随会话只讨论当前对象。 */
export function isArrangementIntent(text) {
  const { kind, skill } = parseAssistantIntent(text);
  // “整理结构”“润色”是对当前对象的讨论；“整理成文档 / 报告”才是要交付新成果的安排。
  return ['manage', 'project', 'connect'].includes(kind) || Boolean(skill) || /(安排|提醒我|创建任务|建个任务|排个期|整理成\S*(文档|报告))/u.test(text);
}

/**
 * 每个会话都有工作目录（设计 5.8），授权按目录类型区分：
 * 不属于项目 → 会话专用的临时目录；项目没有挂载目录 → 项目托管目录；
 * 有挂载目录 → 挂载目录，需要隔离的代码修改在其中的 worktree 里进行。
 */
export const DIR_KINDS = {
  temp: { label: '临时目录', rule: '会话专用，目录内可以自由读写；会话归档后到期清理，要留的文件先收进成果。' },
  managed: { label: '项目托管目录', rule: '由 Multivac 创建并托管，目录内的修改自动执行。' },
  mounted: { label: '挂载目录', rule: '你已有的目录，目录内的修改自动执行，目录外的修改需要确认。' },
  worktree: { label: 'worktree', rule: '在独立的 worktree 里修改，不动主目录；合并回主分支需要确认。' },
};

/** 无论哪类目录都要确认的操作。 */
export const IRREVERSIBLE_RULE = '不可撤回的删除或覆盖，在任何目录里都需要确认。';

export function workingDirOf({ sessionId, project, worktree = false }) {
  if (!project) return { kind: 'temp', path: `~/.multivac/tmp/${sessionId}` };
  // 项目中的会话在主目录工作；需要隔离的代码修改在挂载目录的 worktree 里进行。
  const primary = primaryDirectory(project) || { kind: 'managed', path: managedDirectoryPath(project.name) };
  if (worktree && primary.kind === 'mounted') return { kind: 'worktree', path: `${trimTrailingSlash(primary.path)}/.worktrees/${sessionId}` };
  return { kind: primary.kind, path: primary.path };
}

/*
 * 项目目录：project.directories 是 [{ kind: 'managed' | 'mounted', path }]，第一个是主目录，
 * 项目中新建的会话在主目录中工作。托管目录由 Multivac 创建，挂载目录是你已有的目录；
 * 项目至少保留一个目录。修改目录只影响之后新建的会话。
 */

/** 修改目录的影响：设置页与确认卡共用这句说明。 */
export const DIRECTORY_CHANGE_NOTE = '修改目录只影响之后新建的会话；已有会话继续使用创建时的工作目录。';

/** 只剩一个目录时不能卸载，给出换目录的办法。 */
export const LAST_DIRECTORY_NOTE = '项目至少保留一个目录；要换目录，先挂载新目录再卸载这个。';

const trimTrailingSlash = (path) => path.trim().replace(/\/+$/u, '') || '/';
const samePath = (left, right) => trimTrailingSlash(left) === trimTrailingSlash(right);

/** 新建项目不选目录时创建的托管目录。 */
export function managedDirectoryPath(name) {
  return `~/Multivac/projects/${name.trim()}/`;
}

/** 新建项目的目录：选了目录就挂载它，不选则创建一条托管目录。 */
export function initialDirectories(name, directory = '') {
  const path = directory.trim();
  return [path ? { kind: 'mounted', path } : { kind: 'managed', path: managedDirectoryPath(name) }];
}

/** 主目录：目录列表中的第一个。 */
export function primaryDirectory(project) {
  return project?.directories?.[0] || null;
}

export function hasDirectory(directories, path) {
  return directories.some((directory) => samePath(directory.path, path));
}

/** 挂载：新目录排在已有目录之后，不改变主目录；空路径与重复挂载被拒绝。 */
export function mountDirectory(directories, path) {
  const trimmed = path.trim();
  if (!trimmed) return { ok: false, reason: '请输入要挂载的目录。', directories };
  if (hasDirectory(directories, trimmed)) return { ok: false, reason: '这个目录已经在项目里了。', directories };
  return { ok: true, directories: [...directories, { kind: 'mounted', path: trimmed }] };
}

/** 卸载：至少保留一个目录；卸载主目录时由下一个目录接替（顺序即主次）。 */
export function unmountDirectory(directories, path) {
  if (!hasDirectory(directories, path)) return { ok: false, reason: '项目里没有这个目录。', directories };
  if (directories.length <= 1) return { ok: false, reason: LAST_DIRECTORY_NOTE, directories };
  return { ok: true, directories: directories.filter((directory) => !samePath(directory.path, path)) };
}

/** 设为主目录：把它移到最前，其余顺序不变；不在列表里时原样返回。 */
export function setPrimaryDirectory(directories, path) {
  const target = directories.find((directory) => samePath(directory.path, path));
  return target ? [target, ...directories.filter((directory) => directory !== target)] : directories;
}

/** 目录摘要：主目录的类型与路径，多个目录时注明数量（项目列表与工作区切换菜单共用）。 */
export function directorySummary(project) {
  const primary = primaryDirectory(project);
  if (!primary) return '项目目录缺失';
  const more = project.directories.length > 1 ? ` 等 ${project.directories.length} 个目录` : '';
  return `${DIR_KINDS[primary.kind].label} · ${primary.path}${more}`;
}

/**
 * 知识库条目的使用范围：'personal'（个人，不在任何项目里自动检索），或 { projects: [...] }。
 * 纳入的是引用，不复制内容；@ 引用不受使用范围限制，只有 Agent 自动检索按范围来。
 */

/**
 * 纳入知识库时的默认范围，按“知识与记忆”里的默认规则：
 * 'current-project' 表示纳入时所在的项目；不在项目里（默认工作区、应用）时按个人。
 */
export function defaultKnowledgeScope(rule, projectId) {
  return rule === 'current-project' && projectId ? { projects: [projectId] } : 'personal';
}

/** 使用范围是否包含某个项目；个人条目不包含任何项目。 */
export function knowledgeScopeIncludes(scope, projectId) {
  return scope !== 'personal' && Boolean(scope?.projects?.includes(projectId));
}

/** 某项目可自动检索的知识库条目：使用范围包含该项目，且没有被这个项目排除。 */
export function retrievableKnowledgeFor(entries, project) {
  const excluded = project.knowledgeExcluded || [];
  return entries.filter((entry) => knowledgeScopeIncludes(entry.scope, project.id) && !excluded.includes(entry.id));
}

/** “从知识库添加”到项目：使用范围加上这个项目；个人条目改为指定这个项目。 */
export function addProjectToScope(scope, projectId) {
  if (knowledgeScopeIncludes(scope, projectId)) return scope;
  return { projects: [...(scope === 'personal' ? [] : scope.projects), projectId] };
}

/**
 * 项目改名的校验：名字不能为空，也不能与其他项目重名（同名工作区跟着项目名走，重名会分不清）。
 * 返回不能保存的原因；可以保存时返回空字符串。
 */
export function projectNameError(name, projects, projectId) {
  const trimmed = name.trim();
  if (!trimmed) return '项目名不能为空。';
  if (projects.some((project) => project.id !== projectId && project.name === trimmed)) return '已有同名项目，换一个名字。';
  return '';
}

/**
 * 会话的元数据：你改的名字、是否已归档、归入的项目（null 表示明确不属于项目）。
 * 与工作区现场分开保存，管理中的会话页与工作区共用一份。
 */
export function normalizeSessionMeta(stored) {
  if (!stored || typeof stored !== 'object') return {};
  const meta = {};
  for (const [id, item] of Object.entries(stored)) {
    if (!item || typeof item !== 'object') continue;
    const next = {};
    if (typeof item.title === 'string' && item.title.trim()) next.title = item.title.trim();
    if (item.archived === true) next.archived = true;
    if (typeof item.projectId === 'string' || item.projectId === null) next.projectId = item.projectId;
    if (Object.keys(next).length) meta[id] = next;
  }
  return meta;
}

/**
 * 会话页的筛选：项目（all / default / 项目 id）、状态（active 进行中 / archived 已归档 / all）、
 * 类型（all / 任务 / 探索 / 伴随），按标题与内容搜索。
 */
export function filterSessions(sessions, { projectId = 'all', status = 'active', kind = 'all', query = '' } = {}) {
  const words = query.trim().toLowerCase();
  return sessions.filter((session) => {
    if (projectId === 'default' ? session.projectId : projectId !== 'all' && session.projectId !== projectId) return false;
    if (status !== 'all' && (status === 'archived') !== Boolean(session.archived)) return false;
    if (kind !== 'all' && session.kind !== kind) return false;
    return !words || `${session.title}\n${session.text || ''}`.toLowerCase().includes(words);
  });
}
