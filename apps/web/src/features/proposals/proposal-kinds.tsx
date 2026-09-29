import { FileQuestion, PenLine, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Check } from 'typebox/value';
import {
  EXAMPLE_RENAME_SESSION_PROPOSAL_KIND,
  ExampleRenameSessionPayloadSchema,
  ExampleRenameSessionPreviewSchema,
  type Proposal,
} from '@multivac/contracts';
import { ObjectLink } from '../assistant/object-links.js';

/**
 * 一种提议在对话中的呈现（卡片内容由提议种类提供）。新增提议种类时在 PROPOSAL_KIND_VIEWS 登记：
 * 卡片的外壳（标题、提出时的问题、确认与取消、回执）由 ProposalCard 统一处理，这里只给出这一种提议的内容。
 */
export interface ProposalKindView {
  /** 卡片标题前的图标。 */
  icon: LucideIcon;
  /** 标题下的一句说明，写明确认后会发生什么。 */
  subtitle: string;
  /** 确认按钮的文字（动作，如“创建项目”“归入项目”）。 */
  confirmLabel: string;
  /**
   * 卡片内容：两列字段（`<dl>` 中的 `<div><dt/><dd/></div>`，按原型 ProjectCard / TaskReceipt 的写法）。
   * 拿到的是服务端给出的参数快照与提出时的预览，按该种类在契约中的 schema 自行核对；核对不过时返回 null，
   * 卡片只显示标题。
   */
  Body: (props: { proposal: Proposal }) => ReactNode;
}

/** 示例提议（给会话改名，只在测试环境出现）的内容：哪个会话、改成什么、在哪个工作区。 */
function ExampleRenameSessionBody({ proposal }: { proposal: Proposal }) {
  if (!Check(ExampleRenameSessionPayloadSchema, proposal.payload) ||
      !Check(ExampleRenameSessionPreviewSchema, proposal.preview)) return null;
  const { payload, preview } = proposal;
  return (
    <>
      <div>
        <dt>会话</dt>
        <dd><ObjectLink target={{ kind: 'session', id: payload.sessionId }}>{preview.currentTitle}</ObjectLink></dd>
      </div>
      <div><dt>新名称</dt><dd>{payload.title}</dd></div>
      <div><dt>所在</dt><dd>{preview.workspaceName}</dd></div>
    </>
  );
}

export const PROPOSAL_KIND_VIEWS: Readonly<Record<string, ProposalKindView>> = {
  [EXAMPLE_RENAME_SESSION_PROPOSAL_KIND]: {
    icon: PenLine,
    subtitle: '示例提议：确认后才会改名',
    confirmLabel: '改名',
    Body: ExampleRenameSessionBody,
  },
};

/** 界面还不认识的种类：只显示标题，确认仍由服务端按当前状态重新校验。 */
const UNKNOWN_KIND_VIEW: ProposalKindView = {
  icon: FileQuestion,
  subtitle: '确认后才会执行',
  confirmLabel: '确认',
  Body: () => null,
};

export function proposalKindView(kind: string): ProposalKindView {
  return Object.hasOwn(PROPOSAL_KIND_VIEWS, kind) ? PROPOSAL_KIND_VIEWS[kind]! : UNKNOWN_KIND_VIEW;
}
