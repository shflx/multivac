import { Type } from 'typebox';
import { defineInternalTool } from './internal-tool-service.js';
import { InternalToolError } from '../../modules/internal-tools/internal-tool.js';
import { taskToolFailure } from './task-tool-errors.js';

const Path = Type.String({ minLength: 1, maxLength: 1024 });
const inspectTaskGitTool = defineInternalTool({
  name: 'inspect_task_git', effect: 'query',
  description: '读取当前真实任务 worktree 的 HEAD、文件状态和差异。通过受控 Git 通道访问所属仓库元数据，不用原生 bash 执行 git。paths 可限定任务目录内相对文件路径；staged=true 查看已暂存差异。不读取其他工作区、不修改分支、不访问网络。',
  parameters: Type.Object({ paths: Type.Optional(Type.Array(Path, { maxItems: 100, uniqueItems: true })), staged: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  async execute(params, context) {
    if (!context.services.taskGit) throw new InternalToolError('任务 Git 通道尚未接入。');
    try {
      return { content: await context.services.taskGit.inspect(context.sessionId, params, context.signal), result: { summary: '已读取任务 Git 状态与差异', refs: [] } };
    } catch (error) { return taskToolFailure('读取任务 Git 状态', error); }
  },
});
const commitTaskCodeTool = defineInternalTool({
  name: 'commit_task_code', effect: 'manage',
  description: '按任务默认提交策略，在完成一个有代码改动的任务或子任务后，为当前任务 worktree 创建一次本地提交，再登记该任务成果；用户明确禁止提交或指定其他策略时遵循用户要求。无改动不创建空提交，非 Git 目录不初始化仓库。先用 inspect_task_git 核对差异，列出本次修改的相对文件路径和提交信息；仅暂存、提交这些文件，保留其他暂存内容。绑定任务分支，禁用 hooks、签名、外部过滤器与子进程；作者为 Multivac。不推送、不修改主分支、不执行任意 Git 参数。返回真实提交 SHA；中断或失败后先查询 HEAD 和状态，不盲目重复提交。',
  parameters: Type.Object({ paths: Type.Array(Path, { minItems: 1, maxItems: 100, uniqueItems: true }), message: Type.String({ minLength: 1, maxLength: 16000 }) }, { additionalProperties: false }),
  async execute(params, context) {
    if (!context.services.taskGit) throw new InternalToolError('任务 Git 通道尚未接入。');
    try {
      return { content: await context.services.taskGit.commit(context.sessionId, params, context.signal), result: { summary: '已创建任务本地代码提交', refs: [] } };
    } catch (error) { return taskToolFailure('提交任务代码', error); }
  },
});
export const TASK_GIT_TOOLS = [inspectTaskGitTool, commitTaskCodeTool];
