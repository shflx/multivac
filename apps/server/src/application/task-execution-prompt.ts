import { createCommandShell } from '../runtime/executors/command-shell.js';
import type { HumanRequest, Task } from '@multivac/contracts';

export interface TaskPromptContext {
  /** 启动时固定的后代数量；不按当前任务关系重新推断执行范围。 */
  childCount: number;
  resumed: boolean;
  platform?: NodeJS.Platform;
  /** 同一执行会话中已持久化的人工回应；新会话仍使用完整任务说明。 */
  inboxResponses?: readonly Pick<HumanRequest, 'requestId' | 'question' | 'decision' | 'answer'>[];
  /** 任务目录的依赖准备情况；无锁文件时为空，不提及。 */
  dependencies?: string | null;
}

const TREE_INSTRUCTIONS = [
  '由本会话处理启动时固定的全部子任务。先用 get_task_execution_tree 分页读完范围、真实状态与成果摘要，按依赖推进；不独立启动子任务，新增子项不自动纳入。',
  '每个子项开始前调用 report_task_child（不传 title/path），阶段性进展及时更新 summary；完成后先传 title/path 登记成果候选，再处理后续项。以工具回执为准，不用口头更新代替登记或到整体结束才补记。',
  '候选可供本轮内部推进，待父运行停止确认后核对固定，不等于交付或验收，不满足树外依赖。人工任务及树外依赖须实际满足，不得绕过。',
  'inCurrentDirectory=false 表示旧成果不在当前目录；不得假设代码已合并或越权访问，缺少材料时澄清。中间父任务在子项之后整合，整体最后核对并登记成果。',
  '只剩人工子项或树外依赖时，登记已做子项后结束本轮，等待服务端固定成果；不提交整体成果。仅需用户回答具体问题时调用 request_task_input。',
].join('\n');

const DELIVERY_INSTRUCTIONS = [
  '默认在任务独立目录工作并保护用户原工作树。文件、bash、网页和已配置 MCP 使用工作会话共用执行规则；可自主安装依赖、构建、运行单元与真实浏览器测试、启动本机 HTTP 服务并修复失败。文件工具逐次核对当前项目范围，范围外走 Inbox 授权；cwd/worktree 和文件工具授权不构成 shell 沙箱，不得借 shell 绕过授权流程。任务仍受 Run 身份、共享预算、暂停取消及停止核对约束。',
  'Git 状态与差异可用 inspect_task_git；本地其他分支历史可用只读 read_git。专用 Git 工具是可核对入口，共用 shell 也能操作仓库元数据；外发仍须真实用户许可，不自动 push。默认在有代码改动的工作项登记成果前，用 commit_task_code 指定相关文件，按完整逻辑单元本地提交；不同子项分别提交，父任务额外整合另交，不重复提交已提交子项。单任务在整体登记前提交。',
  '用户明确提交策略优先；遵循仓库提交规范，成果记录真实 SHA。无改动不空提交，非 Git 目录不初始化或调用提交。不得混入无关文件或暂存内容；失败或结果未知先核对 HEAD 与状态，不盲目重试或声称成功。提交不等于远端发布。',
  '需要澄清用 request_task_input，保存请求后停止推进，等待回应。成果写为独立文件，用 submit_task_result 登记相对路径与标题，说明实际完成、未完成与验证失败项。登记仅为意图，执行终结且停止确认、文件与证据核对后才固定和发起验收；运行结束不等于任务完成，不能自行批准验收或发布。',
].join('\n');

/** 用户字段保留原文；只按服务端固定范围省略无关的执行流程，不裁剪历史或恢复检查点。 */
export function renderTaskExecutionPrompt(task: Pick<Task, 'taskId' | 'title' | 'goal' | 'scope' | 'acceptanceCriteria' | 'feedback' | 'acceptance'>, context: TaskPromptContext): string {
  const interpreter = (context.platform ?? process.platform) === 'win32' ? `命令工具名仍为 bash，实际解释器为 ${createCommandShell('win32').syntax}。使用 PowerShell 语法与 npm.cmd/npx.cmd；专用受控 Git 和旧隔离执行器仍不可用。` : null;
  if (context.resumed && context.inboxResponses?.length) {
    return [
      `用户已回应任务请求（taskId="${task.taskId}"）。`,
      ...context.inboxResponses.map(request => `请求：${request.question}（${request.requestId}）\n用户决定：${request.decision}\n用户回应：${request.answer || '无补充内容'}`),
      `沿用本会话已有任务上下文。继续前用 get_task(taskId="${task.taskId}") 核对当前任务、原人工请求、运行停止事实及最近进展；已有恢复检查点保留，未知工具结果先只读对账，不重放副作用。回应不扩大目录、权限或验收边界。`,
      ...(context.childCount > 0 ? [`固定子任务：${context.childCount} 项，用 get_task_execution_tree 核对当前进度，沿用原固定范围。`] : []),
      // 依赖可能在回应期间补齐，增量提示也如实说明当前情况。
      ...(interpreter ? [interpreter] : []),
      ...(context.dependencies ? [context.dependencies] : []),
    ].join('\n\n');
  }
  return [
    `任务：${task.title}（${task.taskId}）\n目标：${task.goal}\n范围：${task.scope || '仅本任务独立目录'}\n验收要求：${task.acceptanceCriteria || '提交可核对的成果与证据'}\n验收方式：${task.acceptance ? '人工验收' : '可核对的自检，仍须服务端判定'}\n用户回应：${task.feedback ?? '无'}`,
    ...(context.resumed ? [`继续或重做前用 get_task(taskId="${task.taskId}") 核对当前状态、原人工请求、运行停止事实及最近进展，历史仅供参考；涉及未知工具结果先只读对账，不重放副作用。沿用已有恢复检查点；如需核对代码，使用 inspect_task_git。`] : []),
    context.childCount > 0 ? `固定子任务：${context.childCount} 项。\n${TREE_INSTRUCTIONS}` : '固定子任务：0 项，直接处理当前任务。',
    DELIVERY_INSTRUCTIONS,
    ...(interpreter ? [interpreter] : []),
    ...(context.dependencies ? [context.dependencies] : []),
  ].join('\n\n');
}
