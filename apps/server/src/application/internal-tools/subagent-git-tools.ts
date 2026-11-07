import { Type } from 'typebox';
import { defineInternalTool } from './internal-tool-service.js';
const Paths = Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { minItems: 1, maxItems: 100, uniqueItems: true });
export const SUBAGENT_GIT_TOOLS = [
  defineInternalTool({ name: 'inspect_subagent_git', effect: 'query', requires: ['subagentGit'],
    description: '核对本次委派明确文件的 HEAD、状态与差异；仅执行方式可用，不修改文件。提交前必须核对同一组文件。',
    parameters: Type.Object({ paths: Paths }, { additionalProperties: false }),
    async execute(input, context) { return { content: await context.services.subagentGit.inspect(context.sessionId, input, context.signal), result: { summary: '已核对委派文件差异', refs: [] } }; },
  }),
  defineInternalTool({ name: 'commit_subagent_code', effect: 'manage', requires: ['subagentGit'],
    description: '执行方式完成运行检查并核对当前差异后，仅提交 paths 明确文件。受 writeScope 限制，保留无关暂存；无改动不创建空提交，不推送。中断或未知结果只读核对，不重放提交。',
    parameters: Type.Object({ paths: Paths, message: Type.String({ minLength: 1, maxLength: 16000 }) }, { additionalProperties: false }),
    async execute(input, context) { return { content: await context.services.subagentGit.commit(context.sessionId, input, context.signal), result: { summary: '已核对委派本地提交结果', refs: [] } }; },
  }),
];
