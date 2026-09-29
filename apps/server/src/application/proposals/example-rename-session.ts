import {
  EXAMPLE_RENAME_SESSION_PROPOSAL_KIND,
  ExampleRenameSessionPayloadSchema,
  normalizeWorkspaceSessionTitle,
  type ExampleRenameSessionPreview,
  type WorkspaceSession,
} from '@multivac/contracts';
import { Type } from 'typebox';
import { InternalToolError } from '../../modules/internal-tools/internal-tool.js';
import { defineProposalKind, ProposalExecutionError, type ProposalKind } from '../../modules/proposals/proposal.js';
import { defineInternalTool, proposedToolResult } from '../internal-tools/internal-tool-service.js';
import type { WorkspaceSessionService } from '../workspace-session-service.js';

/**
 * 示例提议：给工作会话改名。只在测试环境（`MULTIVAC_E2E_CONTROL=1` 的 E2E 服务与测试）注册，
 * 用来验证对话内确认卡机制本身——提出、确认时重新校验（名称已被改动则过期）、执行、回执与结果通知；
 * 它不是产品入口，正式环境中没有这个工具，也没有这种提议。改名走真实的会话服务与校验。
 */

export interface ExampleRenameSessionDependencies {
  sessions: Pick<WorkspaceSessionService, 'get' | 'rename'>;
  /** 工作区名称（卡片写明会话在哪个工作区）。 */
  workspaceName: (workspaceId: string) => string;
}

function sessionRef(session: WorkspaceSession) {
  return { kind: 'session' as const, sessionId: session.sessionId, label: session.title };
}

/** 读取会话；不存在或不是工作会话时返回 null。 */
function findSession(
  sessions: ExampleRenameSessionDependencies['sessions'],
  sessionId: string,
): WorkspaceSession | null {
  try {
    return sessions.get(sessionId);
  } catch {
    return null;
  }
}

export function exampleRenameSessionKind(dependencies: ExampleRenameSessionDependencies): ProposalKind {
  return defineProposalKind<typeof ExampleRenameSessionPayloadSchema, ExampleRenameSessionPreview>({
    kind: EXAMPLE_RENAME_SESSION_PROPOSAL_KIND,
    payload: ExampleRenameSessionPayloadSchema,
    prepare(payload) {
      const session = findSession(dependencies.sessions, payload.sessionId);
      if (!session) throw new InternalToolError(`没有找到会话 ${payload.sessionId}，没有提出改名。请先查询会话。`);
      if (session.archivedAt) throw new InternalToolError(`会话「${session.title}」已归档，没有提出改名。`);
      return {
        title: `把会话「${session.title}」改名为「${payload.title}」`,
        preview: { currentTitle: session.title, workspaceName: dependencies.workspaceName(session.workspaceId) },
        problem: session.title === payload.title ? `会话已经叫「${payload.title}」，不需要改名。` : null,
        refs: [sessionRef(session)],
      };
    },
    revalidate(payload, preview) {
      const session = findSession(dependencies.sessions, payload.sessionId);
      if (!session) return '会话已不存在。';
      if (session.archivedAt) return `会话「${session.title}」已归档。`;
      if (session.title !== preview.currentTitle) {
        return `会话已被改名为「${session.title}」（提出时是「${preview.currentTitle}」）。`;
      }
      if (session.title === payload.title) return `会话已经叫「${payload.title}」。`;
      return null;
    },
    execute(payload, _preview, origin) {
      try {
        const renamed = dependencies.sessions.rename(payload.sessionId, payload.title, origin);
        return { summary: `改名为「${renamed.title}」`, refs: [sessionRef(renamed)] };
      } catch (error) {
        throw new ProposalExecutionError(error instanceof Error && error.message ? error.message : '会话没有改名。');
      }
    },
  });
}

/** 示例提议工具：只生成确认卡，用户确认后才改名。 */
export const exampleProposeRenameSessionTool = defineInternalTool({
  name: 'example_propose_rename_session',
  effect: 'propose',
  description: '（示例，仅测试环境）提议给一个工作会话改名：在对话中生成一张确认卡，用户确认后才改名，确认之前什么都不做。' +
    '参数 sessionId 是会话 id（先用查询工具查到），title 是新名称。',
  parameters: Type.Object(
    {
      sessionId: Type.String({ minLength: 1, description: '工作会话 id' }),
      title: Type.String({ minLength: 1, description: '新的会话名称' }),
    },
    { additionalProperties: false },
  ),
  async execute(params, { propose }) {
    const title = normalizeWorkspaceSessionTitle(params.title);
    if (!title) throw new InternalToolError('新名称为空或太长，没有提出改名。');
    return proposedToolResult(await propose({
      kind: EXAMPLE_RENAME_SESSION_PROPOSAL_KIND,
      payload: { sessionId: params.sessionId, title },
    }));
  },
});
