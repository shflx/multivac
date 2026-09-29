import assert from 'node:assert/strict';
import test from 'node:test';
import { applyModelEdit, defaultProtocol, modelAvailability, modelConfigError, simulateModelCheck, directorySummary, knowledgeBlockReason, projectNameError, retrievableKnowledge, initialDirectories, mountDirectory, setPrimaryDirectory, unmountDirectory, filterSessions, normalizeSessionMeta, workingDirOf, isArrangementIntent, spoilerChapter, appendExcerpt, applySuggestion, matchByTitle, parseManagementIntent, refersToFocus, applyComposerPick, composerTrigger, capabilityEffect, releaseForProject, resolveAvailability, resolveCapabilities, toolEffect, canSubmitDecision, effectiveThinking, resolveReasoning, decisionLabel, deriveRunIndicator, describeRunIndicator, groupToolMessages, listRecentOutputs, matchOutput, normalizeScenes, parseAssistantIntent, placeInSlot, resizeColumns, resizePair, resizeSlots, resolveSlots } from './ui-state.js';

test('分隔线只调整相邻会话，保持总宽度和最小宽度', () => {
  const original = [480, 480, 480];
  assert.deepEqual(resizePair(original, 0, 80), [560, 400, 480]);
  assert.deepEqual(resizePair(original, 0, 1000), [640, 320, 480]);
  assert.deepEqual(resizePair(original, 1, -1000), [480, 320, 640]);
  assert.deepEqual(original, [480, 480, 480]);
  assert.deepEqual(resizePair([320, 320], 0, 20), [320, 320]);
});

test('澄清必须明确选择，自定义范围必须填写内容', () => {
  for (const choice of ['', 'other', 'custom']) assert.equal(canSubmitDecision('澄清', choice), false);
  assert.equal(canSubmitDecision('澄清', 'custom', '   '), false);
  assert.equal(canSubmitDecision('澄清', 'custom', '只使用公开摘要'), true);
  assert.equal(canSubmitDecision('澄清', 'allow'), true);
  assert.equal(canSubmitDecision('澄清', 'deny'), true);
});

test('验收和外发分别判断，不接受空修改意见或跨类型操作', () => {
  assert.equal(canSubmitDecision('验收', 'allow'), false);
  assert.equal(canSubmitDecision('验收', 'revise', ''), false);
  assert.equal(canSubmitDecision('验收', 'revise', '补齐失败状态'), true);
  assert.equal(canSubmitDecision('验收', 'accept'), true);
  assert.equal(canSubmitDecision('外发授权', 'accept'), false);
  assert.equal(canSubmitDecision('外发授权', 'deny'), true);
  assert.notEqual(decisionLabel('澄清', 'deny'), decisionLabel('外发授权', 'deny'));
});

test('同一次连续工具步骤归入一层，其他消息保持原顺序', () => {
  const messages = [
    { who: 'user', text: '检查代码' },
    { id: 'a', tool: true, groupId: 'run-1', groupLabel: '运行检查', status: 'running' },
    { id: 'b', tool: true, groupId: 'run-1', groupLabel: '运行检查', status: 'done' },
    { who: 'assistant', text: '检查完成' },
    { id: 'c', tool: true, groupId: 'run-2', status: 'cancelled' },
  ];
  const grouped = groupToolMessages(messages);
  assert.deepEqual(grouped.map(({ kind }) => kind), ['message', 'tools', 'message', 'tools']);
  assert.deepEqual(grouped[1].messages.map(({ id }) => id), ['a', 'b']);
  assert.equal(grouped[1].label, '运行检查');
  assert.deepEqual(grouped[3].messages.map(({ id }) => id), ['c']);
  assert.deepEqual(messages.map(({ id }) => id), [undefined, 'a', 'b', undefined, 'c']);
});

const task = (id, status) => ({ id, status });

test('运行指示：没有执行中或排队的任务时为空闲', () => {
  assert.equal(deriveRunIndicator([]).state, 'idle');
  const indicator = deriveRunIndicator([task('a', 'done'), task('b', 'paused'), task('c', 'scheduler-paused')]);
  assert.equal(indicator.state, 'idle');
  assert.deepEqual([indicator.running.length, indicator.queued.length, indicator.anomalies.length], [0, 0, 0]);
  assert.equal(describeRunIndicator(indicator), '没有执行中或排队的任务');
});

test('运行指示：有执行中或排队且无异常时为正常', () => {
  assert.equal(deriveRunIndicator([task('a', 'queued')]).state, 'ok');
  const indicator = deriveRunIndicator([task('a', 'running'), task('b', 'running'), task('c', 'queued'), task('d', 'done')]);
  assert.equal(indicator.state, 'ok');
  assert.deepEqual(indicator.running.map(({ id }) => id), ['a', 'b']);
  assert.deepEqual(indicator.queued.map(({ id }) => id), ['c']);
  assert.equal(describeRunIndicator(indicator), '2 个执行中 · 1 个排队');
});

test('运行指示：恢复待确认、执行失败、长时间无进展、环境停止都算异常', () => {
  for (const status of ['recovery', 'failed', 'stalled', 'env-stopped']) {
    const indicator = deriveRunIndicator([task('a', 'running'), task('b', status)]);
    assert.equal(indicator.state, 'attention');
    assert.deepEqual(indicator.anomalies.map(({ id }) => id), ['b']);
  }
  // 没有任务在跑时，异常依然要提示。
  assert.equal(deriveRunIndicator([task('a', 'stalled')]).state, 'attention');
  const indicator = deriveRunIndicator([task('a', 'running'), task('b', 'running'), task('c', 'running'), task('d', 'queued'), task('e', 'failed')]);
  assert.equal(describeRunIndicator(indicator), '3 个执行中 · 1 个排队 · 1 个异常');
});

test('运行指示：只有等待用户处理的任务时不算异常', () => {
  const waiting = [task('a', 'clarification'), task('b', 'acceptance'), task('c', 'authorization')];
  assert.equal(deriveRunIndicator(waiting).state, 'idle');
  assert.equal(deriveRunIndicator(waiting).anomalies.length, 0);
  assert.equal(deriveRunIndicator([...waiting, task('d', 'running')]).state, 'ok');
});

const outputFixtures = [
  { id: 'old', taskId: 't1', title: '旧报告', at: '2026-09-23T19:10:00' },
  { id: 'new', taskId: 't2', title: '新文档', at: '2026-09-24T14:32:00' },
  { id: 'mid', taskId: 't3', title: '中间的变更', at: '2026-09-24T09:00:00' },
];
const outputTasks = [
  { id: 't1', title: '调研', status: 'done' },
  { id: 't2', title: '审阅', status: 'acceptance' },
  { id: 't3', title: '修复', status: 'running' },
];

test('成果列表按时间倒序，不改动原数组', () => {
  const list = listRecentOutputs(outputFixtures, outputTasks, new Set());
  assert.deepEqual(list.map(({ id }) => id), ['new', 'mid', 'old']);
  assert.deepEqual(outputFixtures.map(({ id }) => id), ['old', 'new', 'mid']);
  assert.equal(list[0].taskTitle, '审阅');
});

test('成果列表的未查看标记只看是否打开过', () => {
  const list = listRecentOutputs(outputFixtures, outputTasks, new Set(['mid']));
  assert.deepEqual(list.map(({ id, unviewed }) => [id, unviewed]), [['new', true], ['mid', false], ['old', true]]);
});

test('成果列表按来源任务判断待验收', () => {
  const list = listRecentOutputs(outputFixtures, outputTasks, new Set());
  assert.deepEqual(list.filter(({ awaitingAcceptance }) => awaitingAcceptance).map(({ id }) => id), ['new']);
  // 来源任务缺失时不算待验收，也不报错。
  const orphan = listRecentOutputs([{ id: 'x', taskId: 'missing', at: '2026-09-24T10:00:00' }], outputTasks, new Set());
  assert.deepEqual([orphan[0].awaitingAcceptance, orphan[0].taskTitle], [false, '']);
});

test('一句话意图：创建项目、取回成果、交代任务与讨论各自区分', () => {
  assert.deepEqual(parseAssistantIntent('把 ~/code/notes 作为项目'), { kind: 'project', path: '~/code/notes' });
  assert.deepEqual([parseAssistantIntent('把昨天那份调研报告给我').kind, parseAssistantIntent('把昨天那份调研报告给我').type], ['open', 'output']);
  assert.equal(parseAssistantIntent('把这个整理成文档').kind, 'task');
  // 带“整理”的是交付意图，即使提到了成果也不是取回。
  assert.equal(parseAssistantIntent('把调研报告整理一下给我').kind, 'task');
  assert.equal(parseAssistantIntent('先把界面原型的核心体验走通').kind, 'chat');
});

test('打开工作对象与取回成果共用一套意图，并给出名称线索', () => {
  assert.deepEqual(parseAssistantIntent('继续读《数据密集型应用系统设计》'), { kind: 'open', type: 'book', query: '数据密集型应用系统设计' });
  assert.deepEqual(parseAssistantIntent('打开周报笔记'), { kind: 'open', type: 'note', query: '周报' });
  assert.equal(parseAssistantIntent('继续读').type, 'book');
  // 页面名仍按管理动作处理，不当成打开对象。
  assert.equal(parseAssistantIntent('打开待办').kind, 'manage');
  assert.equal(parseAssistantIntent('把笔记整理成文档').kind, 'task');
});

test('取回成果按标题重合挑选，没有线索时给最近的一份', () => {
  const outputs = [
    { id: 'sdk', title: 'Coding Agent SDK 调研报告', at: '2026-09-23T19:10:00' },
    { id: 'mvp', title: 'MVP 交互原型说明', at: '2026-09-24T14:32:00' },
  ];
  assert.equal(matchOutput(outputs, '把昨天那份调研报告给我').id, 'sdk');
  assert.equal(matchOutput(outputs, '原型说明发我一下').id, 'mvp');
  assert.equal(matchOutput(outputs, '随便给我一份成果').id, 'mvp');
  assert.equal(matchOutput([], '报告给我'), null);
});

test('并排栏位：校验保存的栏位，空栏按工作区顺序补位', () => {
  const members = ['a', 'b', 'c'];
  assert.deepEqual(resolveSlots(undefined, members, 2), ['a', 'b']);
  assert.deepEqual(resolveSlots(['c', 'a'], members, 2), ['c', 'a']);
  // 已不在工作区的会话被移除，空栏补上未展示的会话。
  assert.deepEqual(resolveSlots(['gone', 'b'], members, 2), ['a', 'b']);
  // 重复项只保留第一栏。
  assert.deepEqual(resolveSlots(['b', 'b'], members, 2), ['b', 'a']);
  // 会话不够时留空；栏数跟随并排数。
  assert.deepEqual(resolveSlots([], ['a'], 2), ['a', null]);
  assert.deepEqual(resolveSlots(['a', 'b'], members, 3), ['a', 'b', 'c']);
});

test('并排栏位：放进指定栏会替换原会话，已在另一栏则互换', () => {
  const slots = ['a', 'b'];
  assert.deepEqual(placeInSlot(slots, 'c', 0), ['c', 'b']);
  assert.deepEqual(placeInSlot(slots, 'c', 1), ['a', 'c']);
  assert.deepEqual(placeInSlot(slots, 'b', 0), ['b', 'a']);
  assert.deepEqual(placeInSlot(slots, 'a', 0), ['a', 'b']);
  assert.deepEqual(slots, ['a', 'b']);
});

test('调小并排数：多出的栏退出显示，当前会话始终留在显示中', () => {
  assert.deepEqual(resizeSlots(['a', 'b', 'c', 'd'], 2, 'b'), ['a', 'b']);
  // 当前会话在被去掉的栏里，放进保留下来的最后一栏。
  assert.deepEqual(resizeSlots(['a', 'b', 'c', 'd'], 2, 'd'), ['a', 'd']);
  // 调大时补出空栏，由补位规则填充。
  assert.deepEqual(resizeSlots(['a', 'b'], 4, 'a'), ['a', 'b', null, null]);
  // 当前会话不在任何栏（聚焦查看未展示会话）时不强行放入。
  assert.deepEqual(resizeSlots(['a', 'b', 'c'], 2, 'x'), ['a', 'b']);
});

test('工作区现场：沿用旧版两栏栏位，并校验新格式', () => {
  const scenes = normalizeScenes(null, { multivac: ['recovery', 'prototype'] });
  assert.deepEqual(scenes.multivac, { count: 2, slots: ['recovery', 'prototype'], widths: {} });
  const stored = normalizeScenes({ multivac: { count: 3, slots: ['a', 'b', 'c'], widths: { 3: [300, 400, 500] } }, bad: { count: 9, slots: ['a'] } }, { multivac: ['x', 'y'] });
  // 新格式优先于旧版；非法并排数回到默认值。
  assert.deepEqual(stored.multivac, { count: 3, slots: ['a', 'b', 'c'], widths: { 3: [300, 400, 500] }, viewMode: 'parallel', focusedId: null, stacks: {}, objects: [], companions: {} });
  assert.equal(stored.bad.count, 2);
});

test('列宽：放得下时相邻两栏此消彼长，放不下时单独调整左侧一栏', () => {
  assert.deepEqual(resizeColumns([500, 500], 0, 80, false), [580, 420]);
  // 四栏都在最小宽度、网格已横向滚动：左侧一栏单独变宽，其余不变。
  assert.deepEqual(resizeColumns([320, 320, 320, 320], 2, 100, true), [320, 320, 420, 320]);
  assert.deepEqual(resizeColumns([320, 420, 320], 1, -300, true), [320, 320, 320]);
  assert.deepEqual(resizeColumns([320, 320], 1, 50, true), [320, 320]);
});

test('工作区现场：恢复视图模式、当前会话与栈式深入层级', () => {
  const scenes = normalizeScenes({
    multivac: {
      count: 2,
      slots: ['a', 'b'],
      viewMode: 'focus',
      focusedId: 'b',
      stacks: { a: [{ quote: '选中内容', title: '子会话' }], b: [], c: [{ quote: 1 }] },
    },
  });
  assert.equal(scenes.multivac.viewMode, 'focus');
  assert.equal(scenes.multivac.focusedId, 'b');
  // 空层级与格式不对的层级被丢弃。
  assert.deepEqual(scenes.multivac.stacks, { a: [{ quote: '选中内容', title: '子会话' }] });
  assert.equal(normalizeScenes({ x: { slots: [], viewMode: 'weird' } }).x.viewMode, 'parallel');
});

const inCatalog = { catalog: { reasoning: true, levels: ['off', 'low', 'medium', 'high', 'xhigh'] } };
const noReasoningCatalog = { catalog: { reasoning: false, levels: ['off'] } };
const custom = { catalog: null };

test('推理能力：自动模式按 Pi 目录，不在目录时按 Pi 默认视为不支持', () => {
  assert.deepEqual(resolveReasoning(inCatalog), { mode: 'auto', supported: true, source: 'Pi 目录', levels: ['off', 'low', 'medium', 'high', 'xhigh'] });
  assert.deepEqual(resolveReasoning(noReasoningCatalog), { mode: 'auto', supported: false, source: 'Pi 目录', levels: ['off'] });
  assert.deepEqual(resolveReasoning(custom), { mode: 'auto', supported: false, source: 'Pi 默认', levels: ['off'] });
  // 已有配置没有该字段，视为自动。
  assert.equal(resolveReasoning({ ...custom, reasoning: undefined }).mode, 'auto');
});

test('推理能力：手动设置覆盖目录判断，来源标为手动设置', () => {
  const supported = resolveReasoning({ ...custom, reasoning: 'supported' });
  assert.equal(supported.supported, true);
  assert.equal(supported.source, '手动设置');
  assert.ok(supported.levels.some((level) => level !== 'off'));
  // 目录里有等级时沿用目录等级。
  assert.deepEqual(resolveReasoning({ ...inCatalog, reasoning: 'supported' }).levels, inCatalog.catalog.levels);
  assert.deepEqual(resolveReasoning({ ...inCatalog, reasoning: 'unsupported' }), { mode: 'unsupported', supported: false, source: '手动设置', levels: ['off'] });
});

test('发送时的推理等级跟随模型当前能力，改设置后下次发送即生效', () => {
  // 会话偏好“高”：模型不支持时实际为关闭，改成支持后恢复为“高”。
  assert.equal(effectiveThinking('high', custom), 'off');
  assert.equal(effectiveThinking('high', { ...custom, reasoning: 'supported' }), 'high');
  // 偏好超出可用等级时取不超过偏好的最高等级。
  assert.equal(effectiveThinking('xhigh', { ...custom, reasoning: 'supported' }), 'high');
  assert.equal(effectiveThinking('off', inCatalog), 'off');
});

test('工作区现场：恢复打开的应用对象与伴随会话的展开状态', () => {
  const scenes = normalizeScenes({ multivac: { slots: ['a'], objects: ['output:doc', 3], companions: { 'output:doc': false } } });
  assert.deepEqual(scenes.multivac.objects, ['output:doc']);
  assert.deepEqual(scenes.multivac.companions, { 'output:doc': false });
});

const registry = [
  { id: 'files', kind: 'builtin', tools: [{ name: 'read', effect: 'read' }, { name: 'edit', effect: 'local' }] },
  { id: 'github', kind: 'mcp', status: 'connected', name: 'GitHub', tools: [{ name: 'list_issues', effect: 'read' }, { name: 'create_pull_request', effect: 'external' }] },
  { id: 'calendar', kind: 'mcp', status: 'disconnected', tools: [{ name: 'create_event' }] },
  { id: 'search', kind: 'mcp', status: 'connected', tools: [{ name: 'search', effect: 'read' }] },
  { id: 'prd', kind: 'skill', uses: ['files'] },
  { id: 'paper', kind: 'skill', uses: ['search'] },
  { id: 'release', kind: 'skill', uses: ['files', 'github'], projectId: 'p1' },
];

test('能力效果等级：取最高的工具，未标注的工具按外部副作用', () => {
  assert.equal(toolEffect({ name: 'x' }), 'external');
  assert.equal(capabilityEffect(registry[0]), 'local');
  assert.equal(capabilityEffect(registry[2]), 'external');
});

test('能力默认可用、按例外排除，并逐项写明不可用的原因', () => {
  const project = { id: 'p1', effectCap: 'external', excluded: ['search'], hiddenSkills: [] };
  const { available, unavailable } = resolveAvailability({ registry, project, agent: { effectCap: 'external' } });
  assert.deepEqual(available.map(({ id }) => id), ['files', 'github', 'prd', 'release']);
  assert.deepEqual(unavailable.map(({ capability, reason }) => [capability.id, reason]), [
    ['calendar', '服务未连接'],
    ['search', '本项目已排除'],
    ['paper', '缺少依赖：search'],
  ]);
  // 项目与智能体取更严的上限：研究类智能体最高只读。
  const readOnly = resolveAvailability({ registry, project, agent: { effectCap: 'read' } });
  assert.equal(readOnly.cap, 'read');
  assert.deepEqual(readOnly.unavailable.find(({ capability }) => capability.id === 'files').reason, '超出效果上限');
  assert.ok(readOnly.unavailable.find(({ capability }) => capability.id === 'prd').reason.startsWith('缺少依赖'));
  // 隐藏的 Skill；项目自带的 Skill 不出现在别的项目里。
  const hidden = resolveAvailability({ registry, project: { ...project, id: 'p2', hiddenSkills: ['prd'] }, agent: {} });
  assert.equal(hidden.unavailable.find(({ capability }) => capability.id === 'prd').reason, '本项目已隐藏');
  assert.equal([...hidden.available, ...hidden.unavailable.map(({ capability }) => capability)].some(({ id }) => id === 'release'), false);
  // 不属于任何项目：在会话的临时目录里可以本地写，不对外。
  assert.equal(resolveAvailability({ registry, project: null, agent: {} }).cap, 'local');
});

test('任务将用到的能力来自智能体配置与临时增减，冲突时列出原因', () => {
  const project = { id: 'p1', effectCap: 'local', excluded: [], hiddenSkills: [] };
  const agent = { effectCap: 'external', requiredServices: ['github'], preferredSkills: ['prd'] };
  const { usable, blocked } = resolveCapabilities({ registry, project, agent, added: ['search'], removed: [] });
  assert.deepEqual(usable.map(({ id }) => id), ['search', 'prd']);
  assert.deepEqual(blocked.map(({ capability, reason }) => [capability.id, reason]), [['github', '超出效果上限']]);
});

test('为本项目放开：取消排除、提高上限，Skill 连同依赖一起放开', () => {
  const project = { id: 'p2', effectCap: 'read', excluded: ['search'], hiddenSkills: ['prd'] };
  assert.deepEqual(releaseForProject(project, registry[3], registry), { ...project, excluded: [] });
  const released = releaseForProject(project, registry[4], registry);
  assert.equal(released.effectCap, 'local');
  assert.deepEqual(released.hiddenSkills, []);
});

test('工具授权：仅这一次 / 本任务内 / 本项目内始终允许，或拒绝', () => {
  for (const action of ['deny', 'once', 'task', 'project']) assert.equal(canSubmitDecision('工具授权', action), true);
  assert.equal(canSubmitDecision('工具授权', 'allow'), false);
  assert.equal(decisionLabel('工具授权', 'project'), '本项目内始终允许');
  assert.equal(decisionLabel('工具授权', 'once'), '已允许这一次');
});

test('输入区入口：行首 / 调用 Skill，@ 引用对象', () => {
  assert.deepEqual(composerTrigger('/需求'), { kind: 'skill', query: '需求', start: 0 });
  assert.equal(composerTrigger('帮我 /需求'), null);
  assert.equal(composerTrigger('/需求文档 继续'), null);
  assert.deepEqual(composerTrigger('参考 @mvp'), { kind: 'reference', query: 'mvp', start: 3 });
  assert.deepEqual(composerTrigger('@'), { kind: 'reference', query: '', start: 0 });
  assert.equal(composerTrigger('邮箱 a@b.com'), null);
  assert.equal(applyComposerPick('参考 @mv', composerTrigger('参考 @mv'), '@mvp.html'), '参考 @mvp.html ');
  assert.equal(applyComposerPick('/需', composerTrigger('/需'), '/需求文档'), '/需求文档 ');
});

test('一句话接入能力与显式调用 Skill', () => {
  assert.deepEqual(parseAssistantIntent('接入 Notion'), { kind: 'connect', name: 'Notion' });
  assert.deepEqual(parseAssistantIntent('/需求文档 把这次讨论写下来'), { kind: 'task', skill: '需求文档' });
});

test('对话中的管理动作：先做、暂停、并发、不用验收、打开管理页', () => {
  assert.deepEqual(parseManagementIntent('先做这个'), { action: 'do-now', target: '这个' });
  assert.deepEqual(parseManagementIntent('先做 对比 Agent SDK'), { action: 'do-now', target: '对比 Agent SDK' });
  assert.deepEqual(parseManagementIntent('暂停更新项目文档'), { action: 'pause', target: '更新项目文档' });
  assert.deepEqual(parseManagementIntent('并发调到 3'), { action: 'concurrency', value: 3 });
  assert.deepEqual(parseManagementIntent('把并发上限改成2'), { action: 'concurrency', value: 2 });
  assert.deepEqual(parseManagementIntent('审阅实现结果不用验收了'), { action: 'no-acceptance', target: '审阅实现结果' });
  assert.deepEqual(parseManagementIntent('打开待办'), { action: 'open-page', page: 'tasks' });
  assert.deepEqual(parseManagementIntent('打开 Inbox'), { action: 'open-page', page: 'inbox' });
  assert.equal(parseManagementIntent('打开周报笔记'), null);
  assert.equal(parseAssistantIntent('并发调到 3').kind, 'manage');
});

test('管理动作的目标：按标题匹配任务，“这个”指当前焦点', () => {
  const tasks = [{ id: 'a', title: '对比 Agent SDK' }, { id: 'b', title: '更新项目文档' }];
  assert.equal(matchByTitle(tasks, 'Agent SDK').id, 'a');
  assert.equal(matchByTitle(tasks, '项目文档').id, 'b');
  assert.equal(matchByTitle(tasks, '天气'), null);
  assert.equal(refersToFocus('这个'), true);
  assert.equal(refersToFocus(''), true);
  assert.equal(refersToFocus('更新项目文档'), false);
});

test('笔记的差异建议：逐条接受只替换对应片段，正文已被改过时不动', () => {
  const content = '## 本周\n- 完成原型\n- 修复恢复问题';
  assert.equal(applySuggestion(content, { before: '- 完成原型', after: '- 完成原型顶部状态区改版' }), '## 本周\n- 完成原型顶部状态区改版\n- 修复恢复问题');
  assert.equal(applySuggestion(content, { before: '- 不存在的一行', after: 'x' }), null);
  // 没有 before 的建议是追加一段。
  assert.equal(applySuggestion(content, { before: '', after: '## 下周' }), `${content}\n\n## 下周`);
});

test('收进笔记：以引用块追加并注明出处', () => {
  assert.equal(appendExcerpt('正文\n', '第一行\n第二行', '原型范围梳理'), '正文\n\n> 第一行\n> 第二行\n> —— 摘自「原型范围梳理」\n');
  assert.equal(appendExcerpt('', '划线', '《数据密集型应用系统设计》'), '> 划线\n> —— 摘自《数据密集型应用系统设计》\n');
});

test('书伴不剧透：只拦下还没读到的章节', () => {
  const chapters = [{ id: 'c9', keywords: ['线性一致性'] }, { id: 'c10', keywords: ['批处理', 'MapReduce'] }];
  assert.equal(spoilerChapter('MapReduce 后面怎么讲', chapters, 0).id, 'c10');
  assert.equal(spoilerChapter('线性一致性是什么', chapters, 0), null);
  assert.equal(spoilerChapter('MapReduce 后面怎么讲', chapters, 1), null);
});

test('伴随会话里识别安排类意图，提示改交给 Multivac', () => {
  assert.equal(isArrangementIntent('把这章整理成笔记文档'), true);
  assert.equal(isArrangementIntent('先做这个'), true);
  assert.equal(isArrangementIntent('提醒我明天继续读'), true);
  assert.equal(isArrangementIntent('这里的共识是什么意思'), false);
  assert.equal(isArrangementIntent('整理结构'), false);
  assert.equal(isArrangementIntent('/调研 分布式共识'), true);
});

test('工作目录：临时目录、项目主目录与 worktree', () => {
  assert.deepEqual(workingDirOf({ sessionId: 'learning', project: null }), { kind: 'temp', path: '~/.multivac/tmp/learning' });
  const managed = { id: 'research', name: '技术研究', directories: [{ kind: 'managed', path: '~/Multivac/projects/技术研究/' }] };
  assert.deepEqual(workingDirOf({ sessionId: 'x', project: managed }), { kind: 'managed', path: '~/Multivac/projects/技术研究/' });
  const mounted = { id: 'm', name: 'M', directories: [{ kind: 'mounted', path: '~/code/m' }, { kind: 'mounted', path: '~/code/docs' }] };
  // 会话在主目录（第一个）工作。
  assert.deepEqual(workingDirOf({ sessionId: 'a', project: mounted }), { kind: 'mounted', path: '~/code/m' });
  assert.deepEqual(workingDirOf({ sessionId: 'fix', project: mounted, worktree: true }), { kind: 'worktree', path: '~/code/m/.worktrees/fix' });
  // 托管目录不开 worktree。
  assert.equal(workingDirOf({ sessionId: 'fix', project: managed, worktree: true }).kind, 'managed');
});

test('项目目录：新建、挂载、卸载与设为主目录', () => {
  assert.deepEqual(initialDirectories('读书笔记'), [{ kind: 'managed', path: '~/Multivac/projects/读书笔记/' }]);
  assert.deepEqual(initialDirectories('notes', ' ~/code/notes '), [{ kind: 'mounted', path: '~/code/notes' }]);

  const start = [{ kind: 'mounted', path: '~/code/m' }];
  const mounted = mountDirectory(start, '~/code/docs');
  assert.equal(mounted.ok, true);
  // 挂载排在已有目录之后，不改变主目录。
  assert.deepEqual(mounted.directories.map((item) => item.path), ['~/code/m', '~/code/docs']);
  // 重复挂载（含末尾斜杠）与空路径被拒绝，目录不变。
  assert.equal(mountDirectory(mounted.directories, '~/code/m/').ok, false);
  assert.equal(mountDirectory(mounted.directories, '   ').ok, false);
  assert.equal(mountDirectory(mounted.directories, '~/code/m/').directories, mounted.directories);

  // 不能卸载最后一个目录。
  const last = unmountDirectory(start, '~/code/m');
  assert.equal(last.ok, false);
  assert.equal(last.directories, start);
  // 卸载主目录后由下一个接替。
  assert.deepEqual(unmountDirectory(mounted.directories, '~/code/m').directories.map((item) => item.path), ['~/code/docs']);

  // 设为主目录：移到最前，其余顺序不变。
  const three = [...mounted.directories, { kind: 'managed', path: '~/Multivac/projects/M/' }];
  assert.deepEqual(setPrimaryDirectory(three, '~/Multivac/projects/M/').map((item) => item.path), ['~/Multivac/projects/M/', '~/code/m', '~/code/docs']);
  assert.equal(setPrimaryDirectory(three, '~/nowhere'), three);

  assert.equal(directorySummary({ directories: three }), '挂载目录 · ~/code/m 等 3 个目录');
  assert.equal(directorySummary({ directories: [] }), '项目目录缺失');
});

test('会话元数据：保留改名、归档与归入的项目，丢弃无效值', () => {
  const meta = normalizeSessionMeta({ a: { title: ' 新名字 ', archived: true }, b: { title: '  ', archived: 'yes' }, c: { projectId: null }, d: { projectId: 'multivac' }, e: 3 });
  assert.deepEqual(meta, { a: { title: '新名字', archived: true }, c: { projectId: null }, d: { projectId: 'multivac' } });
  assert.deepEqual(normalizeSessionMeta(null), {});
});

test('会话页筛选：项目、状态、类型与搜索', () => {
  const sessions = [
    { id: 'a', title: '原型范围梳理', kind: '任务', projectId: 'multivac', text: '整理页面状态' },
    { id: 'b', title: '分布式系统学习', kind: '探索', projectId: null, text: '线性一致性' },
    { id: 'c', title: '恢复机制排查', kind: '任务', projectId: 'multivac', archived: true },
    { id: 'd', title: '书伴', kind: '伴随', projectId: null },
  ];
  const ids = (options) => filterSessions(sessions, options).map((item) => item.id);
  assert.deepEqual(ids({}), ['a', 'b', 'd']);
  assert.deepEqual(ids({ status: 'archived' }), ['c']);
  assert.deepEqual(ids({ status: 'all', projectId: 'multivac' }), ['a', 'c']);
  assert.deepEqual(ids({ projectId: 'default' }), ['b', 'd']);
  assert.deepEqual(ids({ kind: '探索' }), ['b']);
  // 搜索同时看标题与内容。
  assert.deepEqual(ids({ query: '一致性' }), ['b']);
  assert.deepEqual(ids({ query: '原型' }), ['a']);
});

test('项目改名：不能为空，不能与其他项目重名', () => {
  const projects = [{ id: 'a', name: 'Multivac 开发' }, { id: 'b', name: '技术研究' }];
  assert.equal(projectNameError('  ', projects, 'a'), '项目名不能为空。');
  assert.equal(projectNameError('技术研究', projects, 'a'), '已有同名项目，换一个名字。');
  // 与自己原来的名字相同、或前后多了空格，都可以保存。
  assert.equal(projectNameError(' Multivac 开发 ', projects, 'a'), '');
  assert.equal(projectNameError('Multivac 产品', projects, 'a'), '');
});

test('知识范围：只能在使用范围之内勾选', () => {
  const entries = [
    { id: '产品定义', scope: 'Multivac 项目' },
    { id: '学习资料', scope: '仅指定任务' },
    { id: '研究资料', scope: '未授权使用' },
    { id: '书架', scope: '仅书伴与笔记' },
    { id: '笔记库', scope: '所有项目' },
  ];
  const multivac = { name: 'Multivac 开发', knowledge: ['产品定义', '研究资料', '笔记库'] };
  const research = { name: '技术研究', knowledge: ['产品定义', '笔记库'] };
  assert.equal(knowledgeBlockReason(entries[0], multivac), '');
  assert.equal(knowledgeBlockReason(entries[0], research), '使用范围限定在「Multivac 项目」。');
  assert.equal(knowledgeBlockReason(entries[1], multivac), '只在任务里明确指定时使用，不自动检索。');
  assert.equal(knowledgeBlockReason(entries[4], research), '');
  // 勾选了但使用范围不允许的，不会被检索。
  assert.deepEqual(retrievableKnowledge(entries, multivac).map((entry) => entry.id), ['产品定义', '笔记库']);
  assert.deepEqual(retrievableKnowledge(entries, research).map((entry) => entry.id), ['笔记库']);
  assert.deepEqual(retrievableKnowledge(entries, { name: '新项目' }), []);
});

test('模型协议：按提供方给默认值，OpenAI 兼容必须手选', () => {
  assert.equal(defaultProtocol('openai'), 'openai-responses');
  assert.equal(defaultProtocol('anthropic'), 'anthropic-messages');
  assert.equal(defaultProtocol('google'), 'google-generative-ai');
  assert.equal(defaultProtocol('openai-compatible'), '');
  const compatible = { name: '本地', provider: 'openai-compatible', protocol: '', modelId: 'qwen3', endpoint: 'http://127.0.0.1:11434/v1' };
  assert.equal(modelConfigError(compatible), 'OpenAI 兼容的模型需要手动选择协议。');
  assert.equal(modelConfigError({ ...compatible, protocol: 'openai-completions', endpoint: ' ' }), 'OpenAI 兼容的模型需要填写 API 端点。');
  assert.equal(modelConfigError({ ...compatible, protocol: 'openai-completions' }), '');
});

test('模型可用性：由配置、API Key 与模拟的连接检查逐项得出', () => {
  const model = { name: 'GPT', provider: 'openai', protocol: 'openai-responses', modelId: 'gpt-5.2', endpoint: 'https://api.openai.com/v1', keyStored: false, check: null };
  assert.equal(modelAvailability({ ...model, protocol: '' }).label, '配置需修复');
  assert.equal(modelAvailability(model).label, '未认证');
  assert.equal(simulateModelCheck(model).status, 'failed');
  const keyed = { ...model, keyStored: true };
  assert.equal(modelAvailability(keyed).label, '待检查');
  const passed = { ...keyed, check: simulateModelCheck(keyed) };
  assert.deepEqual([modelAvailability(passed).available, modelAvailability(passed).label], [true, '可用']);
  // 本机端点模拟为本地服务没启动。
  const local = { ...keyed, provider: 'openai-compatible', protocol: 'openai-completions', endpoint: 'http://127.0.0.1:11434/v1' };
  const failed = { ...local, check: simulateModelCheck(local) };
  assert.equal(modelAvailability(failed).label, '连接失败');
  assert.equal(modelAvailability(failed).message, '无法连接 127.0.0.1:11434，请确认本地服务已经启动。');
  // 改名不影响检查结果；改了端点等连接字段，要重新检查。
  assert.equal(applyModelEdit(passed, { name: 'GPT 主力' }).check, passed.check);
  assert.equal(applyModelEdit(passed, { endpoint: 'https://proxy.example/v1' }).check, null);
});
