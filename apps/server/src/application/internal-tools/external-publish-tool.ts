import { ProposeGitPublishSchema } from '@multivac/contracts';
import { defineInternalTool } from './internal-tool-service.js';
import { InternalToolError } from '../../modules/internal-tools/internal-tool.js';

export const proposeGitPublishTool = defineInternalTool({
  name: 'propose_git_publish', effect: 'manage', parameters: ProposeGitPublishSchema,
  description: '用户希望发布代码时，为当前会话仓库的 HEAD 提交申请一次 Git 分支发布。只能选已配置的 HTTPS remote 和新 branch；固定目标和提交，内容变化须重新申请。工具不会执行 push，须由用户在 Inbox 界面批准；批准不代表发布成功或任务完成。',
  async execute(params, { services, sessionId, commandId }) {
    if (!services.externalPublish) throw new InternalToolError('Git 发布申请尚未接入。');
    try {
      const request = await services.externalPublish.propose(sessionId, commandId, params);
      return { content: `发布申请已保存：${request.id}，提交 ${request.commit}，目标 ${request.target} ${request.ref}。状态：${request.status}。请用户在 Inbox 核对并决定。`, result: { summary: 'Git 发布等待用户授权', refs: [] } };
    } catch { throw new InternalToolError('无法生成发布申请：请核对当前会话仓库、HTTPS 远端与分支名称；尚未执行发布。'); }
  },
});
