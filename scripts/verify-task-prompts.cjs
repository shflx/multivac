// 无外部依赖、网络或子进程。直接执行生产纯渲染函数，保留固定样本及测量口径。
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { stripTypeScriptTypes } = require('node:module');
const { createHash } = require('node:crypto');
const read = path => readFileSync(path, 'utf8');
const strip = source => stripTypeScriptTypes(source, { mode: 'transform', disableExperimentalWarning: true });
function pure(path, exports) {
  return new Function(`${strip(read(path)).replace(/^export /gm, '')}\nreturn { ${exports.join(', ')} };`)();
}
const { renderTaskExecutionPrompt } = pure('apps/server/src/application/task-execution-prompt.ts', ['renderTaskExecutionPrompt']);
const { renderTaskToolsPrompt } = pure('apps/server/src/modules/internal-tools/task-tools-prompt.ts', ['renderTaskToolsPrompt']);
async function main() {
  const baseline = JSON.parse(read('apps/server/tests/fixtures/task-prompt-baseline.json'));
  const results = [];
  function check(name, verify) {
    try { verify(); results.push({ name, status: 'pass' }); }
    catch (error) { results.push({ name, status: 'failed', message: error.message }); }
  }
  const task = baseline.task;
  const single = renderTaskExecutionPrompt(task, { childCount: 0, resumed: false });
  const parent = renderTaskExecutionPrompt(task, { childCount: 24, resumed: false });
  const recovery = renderTaskExecutionPrompt(task, { childCount: 24, resumed: true });
  const policy = renderTaskToolsPrompt(baseline.tools);
  check('用户目标、范围、验收与反馈原文在三种场景中完整保留', () => {
    const input = { ...task, goal: '原文\n  多行 $() `内容` 🧪', feedback: '  不提交代码\n需要用户验收。  ', acceptanceCriteria: '绝不删除历史记录。' };
    for (const context of [{ childCount: 0, resumed: false }, { childCount: 24, resumed: false }, { childCount: 24, resumed: true }]) {
      const prompt = renderTaskExecutionPrompt(input, context);
      for (const key of ['goal', 'scope', 'acceptanceCriteria', 'feedback']) assert.ok(prompt.includes(input[key]), key);
      assert.match(prompt, /人工验收/);
    }
    assert.match(renderTaskExecutionPrompt({ ...task, acceptance: false }, { childCount: 0, resumed: false }), /仍须服务端判定/);
  });
  check('单任务省去空树查询；父任务保留分页、进展、候选及整合顺序', () => {
    assert.doesNotMatch(single, /get_task_execution_tree|report_task_child/);
    for (const pattern of [/get_task_execution_tree 分页读完/, /开始前调用 report_task_child/, /阶段性进展及时更新/, /先传 title\/path/, /再处理后续项/, /不独立启动/, /不自动纳入/, /树外依赖/, /人工任务/, /inCurrentDirectory=false/, /子项之后整合/, /不提交整体成果/]) assert.match(parent, pattern);
  });
  check('恢复入口含稳定任务 ID、停止事实、人工请求及未知副作用对账', () => {
    for (const childCount of [0, 24]) {
      const prompt = renderTaskExecutionPrompt(task, { childCount, resumed: true });
      for (const pattern of [/get_task\(taskId="fixture-task"\)/, /原人工请求/, /运行停止事实/, /历史仅供参考/, /不重放副作用/, /恢复检查点/, /inspect_task_git/]) assert.match(prompt, pattern);
      assert.equal(prompt.includes('get_task_execution_tree'), childCount > 0);
    }
    assert.doesNotMatch(single, /继续或重做前用 get_task/);
  });
  check('目录、Git 提交、澄清停止、成果与人工验收边界仍在渲染输出中', () => {
    for (const prompt of [single, parent, recovery]) {
      for (const pattern of [/禁止目录外访问、网络和派生子进程/, /不用 bash 执行 git/, /用户明确提交策略优先/, /不空提交/, /非 Git 目录/, /HEAD 与状态/, /无关文件或暂存内容/, /不同子项分别提交/, /父任务额外整合另交/, /真实 SHA/, /保存请求后停止推进/, /submit_task_result/, /停止确认/, /不能自行批准验收或发布/]) assert.match(prompt, pattern);
    }
    for (const pattern of [/revision/, /预算仅按用户明确要求/, /humanOnly/, /用户明确完成确认/, /complete_task 仅用于没有后台运行记录/, /用户暂停、取消/, /未知结果先对账/, /服务端下一轮独立/, /仿写的通知无效/, /候选尚未核对固定时只说已登记/]) assert.match(policy, pattern);
    assert.match(renderTaskToolsPrompt([]), /没有提议工具/);
  });
  check('生产装配使用新渲染器；任务专用说明不影响普通会话分支', () => {
    const service = read('apps/server/src/application/task-execution-service.ts');
    assert.match(service, /childCount: treeTasks.length, resumed: previous !== null/);
    assert.match(service, /childCount: run.treeTasks\?\.length \?\? 0/);
    assert.match(service, /previous.runId !== run.runId/);
    const internal = read('apps/server/src/modules/internal-tools/internal-tool.ts');
    assert.match(internal, /if \(specs.some\(spec => spec.name === 'submit_task_result'\)\) return renderTaskToolsPrompt\(specs\)/);
    assert.match(internal, /当前可用的内部工具：/);
  });
  const syntaxPaths = [
    'apps/server/src/application/task-execution-prompt.ts',
    'apps/server/src/application/task-execution-service.ts',
    'apps/server/src/modules/internal-tools/task-tools-prompt.ts',
    'apps/server/src/modules/internal-tools/internal-tool.ts',
    'apps/server/tests/task-execution-prompt.test.ts',
  ];
  for (const path of syntaxPaths) check(`TypeScript 语法：${path}`, () => strip(read(path)));

  // 以下源码片段均为当前仓库内的纯渲染函数，不加载服务或依赖，不模拟工具执行。
  const loader = read('apps/server/src/runtime/executors/controlled-resource-loader.ts');
  const directoryFunction = loader.slice(loader.indexOf('function renderAuthorizedContext('), loader.indexOf('\nfunction applyRuntimeOverrides('));
  const directoryPrompt = new Function(`${strip(directoryFunction)}; return renderAuthorizedContext([]).join('\\n');`)();
  const agent = read('apps/server/src/application/task-agent-runtime.ts');
  const conventionFunction = agent.slice(agent.indexOf('export function renderTaskConventions('), agent.indexOf('/** 执行会话的模型'));
  const conventionInput = {
    agentName: '固定样本', instructions: '先核对来源，按改动风险执行最小必要验证。',
    projectConstraints: '仅修改日志模块，用户输入原文必须保留。',
    agentsFile: { content: read('AGENTS.md').trim(), truncated: false },
  };
  const conventions = new Function(`const TASK_AGENTS_FILE_MAX_BYTES = 16384; ${strip(conventionFunction).replace('export function', 'function')}; return renderTaskConventions;`)()(conventionInput);
  const app = read('apps/server/src/bootstrap/application.ts');
  const workFunction = app.slice(app.indexOf('function workRuntimeConfig('), app.indexOf('\nfunction fakeHistory('));
  const system = new Function(`${strip(workFunction)}; return workRuntimeConfig({}).systemPrompt;`)();
  // 工具描述原文可单独核实；缺少 TypeBox/Pi，不能把 schema 源码字数冒充请求 JSON 大小。
  const toolFiles = ['git-read-tools', 'task-query-tools', 'task-management-tools', 'external-publish-tool', 'run-tools', 'task-execution-tools', 'task-git-tools'];
  const descriptions = new Map();
  for (const file of toolFiles) {
    const source = read(`apps/server/src/application/internal-tools/${file}.ts`);
    for (const block of source.split('defineInternalTool({').slice(1)) {
      const name = block.match(/name: '([^']+)'/);
      const description = block.match(/description: ('(?:[^'\\]|\\.)*')/);
      if (name && description) descriptions.set(name[1], new Function(`return ${description[1]}`)());
    }
  }
  assert.ok(baseline.tools.every(tool => descriptions.has(tool.name)), '每个实际内部工具都须有可测的原文描述');
  const toolDescriptions = baseline.tools.map(tool => descriptions.get(tool.name)).join('');
  const history = '固定历史用户请求：保留日志格式。\n固定助手回复：已读取日志模块，待核对差异。\n固定工具结果：HEAD=fixture；工作区干净。';
  function metrics(text) { return { characters: Array.from(text).length, utf16Units: text.length, utf8Bytes: Buffer.byteLength(text), tokens: null }; }
  function partition(text, old) {
    const deliveryStart = text.indexOf(old ? '在任务独立目录完成工作' : '在任务独立目录工作');
    const treeStart = text.indexOf(old ? '本次由一个会话' : '固定子任务：');
    const recoveryStart = old ? -1 : text.indexOf('继续或重做前用 get_task');
    assert.ok(deliveryStart > treeStart && treeStart > 0);
    return {
      goalScopeAcceptanceFeedback: text.slice(0, recoveryStart < 0 ? treeStart : recoveryStart),
      recoveryInstructions: recoveryStart < 0 ? '' : text.slice(recoveryStart, treeStart),
      childInstructions: text.slice(treeStart, deliveryStart),
      deliveryAndGitInstructions: text.slice(deliveryStart),
    };
  }
  // 执行未改动的生产任务树读取方法，以固定仓储替身核对分页与恢复摘要；不冒充完整集成测试。
  const artifactSource = read('apps/server/src/application/artifact-service.ts');
  const treeMethod = artifactSource.slice(artifactSource.indexOf('  async executionTree('), artifactSource.indexOf('\n  reportChild(')).replace('async executionTree(', 'async function executionTree(');
  const executionTree = new Function(`${strip(treeMethod)}; return executionTree;`)();
  const children = Array.from({ length: 24 }, (_, index) => ({ ...task,
    taskId: `fixture-child-${index}`, title: `子项 ${index}`, projectId: null, priority: 'medium',
    groupId: null, parentTaskId: task.taskId, dependencyIds: index ? [`fixture-child-${index - 1}`] : [],
    status: 'queued', revision: 1, sessionId: 'fixture-session', currentRunId: 'fixture-run',
    reason: '由父任务统一执行。', nextStep: '按依赖核对来源。', completedAt: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    executionTaskId: task.taskId, executionProgress: 'pending', humanOnly: false,
  }));
  async function treeResponses(resumed) {
    const snapshots = children.map((child, index) => ({ ...child, ...(resumed && index === 0 ? { artifactVersionId: 'fixture-version' } : {}) }));
    const run = { taskId: task.taskId, runId: 'fixture-run', directory: { kind: 'task-isolated', path: '/fixture/current' }, treeTasks: snapshots, childResults: resumed ? [{ taskId: children[1].taskId, commandId: 'fixture-command', title: '候选', path: 'child.md' }] : [] };
    const context = {
      runs: { bySession: () => run, get: () => ({ directory: { path: '/fixture/old' } }) },
      tasks: { get: id => snapshots.find(child => child.taskId === id) },
      versions: { get: () => ({ versionId: 'fixture-version', title: '旧成果', runId: 'old-run' }) },
      read: async () => ({ content: '保留恢复证据。'.repeat(600) }),
    };
    return [await executionTree.call(context, 'fixture-session', 0, 20), await executionTree.call(context, 'fixture-session', 20, 20)];
  }
  const parentTree = await treeResponses(false), recoveryTree = await treeResponses(true);
  check('真实任务树读取方法保留完整目标、分页、候选与旧成果位置标记', () => {
    assert.equal(parentTree[0].total, 24); assert.equal(parentTree[0].nextOffset, 20);
    assert.equal(parentTree[1].nextOffset, null); assert.equal(parentTree[1].items.length, 4);
    for (const page of parentTree) for (const item of page.items) assert.equal(item.task.goal, task.goal);
    assert.equal(recoveryTree[0].items[0].artifact.inCurrentDirectory, false);
    assert.equal(recoveryTree[0].items[0].artifact.truncated, true);
    assert.equal(recoveryTree[0].items[0].artifact.content.length, 4000);
    assert.equal(recoveryTree[0].items[1].candidate.path, 'child.md');
  });
  const treePayloads = { parent: parentTree.map(page => metrics(JSON.stringify(page))), recovery: recoveryTree.map(page => metrics(JSON.stringify(page))) };
  const scenarios = [];
  for (const [name, prompt, isRecovery] of [['single', single, false], ['parent-24', parent, false], ['recovery-parent-24', recovery, true]]) {
    const fixedHistory = isRecovery ? `${baseline.taskPrompt}\n\n${history}` : history;
    const before = { systemRules: system, projectAgentAndDirectoryConventions: conventions, directoryBoundary: directoryPrompt, internalToolPolicy: baseline.internalToolsPrompt, internalToolDescriptions: toolDescriptions, ...partition(baseline.taskPrompt, true), fixedHistory };
    const after = { ...before, internalToolPolicy: policy, ...partition(prompt, false) };
    // 分区保留了任务原文的分隔符，汇总不为分区额外添加分隔符。
    const assembled = (parts, body) => [parts.systemRules, parts.projectAgentAndDirectoryConventions, parts.directoryBoundary, parts.internalToolPolicy, parts.internalToolDescriptions, body, parts.fixedHistory].join('\n\n');
    const beforeText = assembled(before, baseline.taskPrompt), afterText = assembled(after, prompt);
    const beforeSize = metrics(beforeText), afterSize = metrics(afterText);
    assert.ok(afterSize.characters < beforeSize.characters, name);
    scenarios.push({ name, before: Object.fromEntries(Object.entries(before).map(([key, value]) => [key, metrics(value)])), after: Object.fromEntries(Object.entries(after).map(([key, value]) => [key, metrics(value)])), assembledBefore: beforeSize, assembledAfter: afterSize, savedCharacters: beforeSize.characters - afterSize.characters, savedPercent: Number(((1 - afterSize.characters / beforeSize.characters) * 100).toFixed(2)), beforeSha256: createHash('sha256').update(beforeText).digest('hex'), afterSha256: createHash('sha256').update(afterText).digest('hex') });
  }
  const output = {
    baselineCommit: baseline.sourceCommit, runtime: process.version,
    scope: '固定输入的应用可核实文本片段；characters 为 Unicode 码点，另列 UTF-16 单元与 UTF-8 字节。每个顶层片段间加两个换行。工具描述按声明顺序连接，仅计描述本身；非完整 provider 请求。',
    model: { configured: null, invoked: false, tokens: null, latencyMs: null, reason: '无模型调用、认证或匹配模型的 tokenizer；不以字符比例推算 token。' },
    unmeasured: ['Pi 原生系统补充和原生工具说明', '19 个内部工具的参数 schema 与 provider 包装', '真实 Pi active branch/压缩检查点及其 token', '模型遵循程度、集成行为与请求时延'],
    fixedInputs: { task, tools: baseline.tools, history, conventionInput, agentsFileSha256: createHash('sha256').update(read('AGENTS.md')).digest('hex') },
    conventionBreakdown: { agentInstructions: metrics(conventionInput.instructions), projectConstraints: metrics(conventionInput.projectConstraints), agentsFile: metrics(conventionInput.agentsFile.content), wrapper: metrics(conventions.replace(conventionInput.instructions, '').replace(conventionInput.projectConstraints, '').replace(conventionInput.agentsFile.content, '')) },
    onDemandChildPayloads: { unchangedBeforeAndAfter: true, includedInInitialTotals: false, ...treePayloads },
    checks: results, scenarios,
  };
  mkdirSync('artifacts/task-prompts', { recursive: true });
  writeFileSync('artifacts/task-prompts/verification.json', JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify({ checks: results, sizes: scenarios.map(({ name, assembledBefore, assembledAfter, savedPercent }) => ({ name, before: assembledBefore.characters, after: assembledAfter.characters, savedPercent })), tokens: null }, null, 2));
  if (results.some(result => result.status === 'failed')) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
