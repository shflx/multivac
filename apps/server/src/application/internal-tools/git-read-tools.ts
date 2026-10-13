import { Type } from 'typebox';
import { defineInternalTool } from './internal-tool-service.js';
import { InternalToolError } from '../../modules/internal-tools/internal-tool.js';
import { taskToolFailure } from './task-tool-errors.js';

const Ref = Type.String({ minLength: 1, maxLength: 256 });
const Path = Type.String({ minLength: 1, maxLength: 1024 });
export const readGitTool = defineInternalTool({
  name: 'read_git', effect: 'query',
  description: '只读查询当前会话工作目录所属 Git 仓库：operation=branches 分页列出本地分支；log 查看 ref 的提交历史；file 读取 ref 中 path 文件的指定行；diff 比较 from 与 to（默认 HEAD），paths 可缩小范围，statOnly 可只看统计。ref 仅接受 HEAD、本地分支名、refs/heads/名称或提交 SHA，不接受任意 Git 表达式。offset 从 0 开始，file 按行分页，其他查询按条目分页；limit 默认 50，file 默认 200，分别最多 100 与 1000。返回固定提交 SHA 和是否还有内容，文件仅支持 768 KiB 以内的 UTF-8 常规文件。读取仓库中的历史对象，不访问其他工作树的当前文件，不切换、修改或提交分支，不 fetch/push，不执行任意命令。当前目录不是仓库根目录或 worktree 时明确失败，不向上寻找或扩大文件权限。',
  parameters: Type.Object({
    operation: Type.Union([Type.Literal('branches'), Type.Literal('log'), Type.Literal('file'), Type.Literal('diff')]),
    ref: Type.Optional(Ref), from: Type.Optional(Ref), to: Type.Optional(Ref), path: Type.Optional(Path),
    paths: Type.Optional(Type.Array(Path, { maxItems: 100, uniqueItems: true })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })), statOnly: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false }),
  async execute(params, context) {
    if (!context.services.gitRead) throw new InternalToolError('只读 Git 通道尚未接入。');
    try {
      return { content: await context.services.gitRead.read(context.sessionId, params, context.signal), result: { summary: '已读取本地 Git 仓库', refs: [] } };
    } catch (error) { return taskToolFailure('读取本地 Git 仓库', error); }
  },
});
