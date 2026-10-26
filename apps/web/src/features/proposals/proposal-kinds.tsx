import { Bot, FileQuestion, Folder, FolderCheck, FolderInput, FolderMinus, FolderPlus, PenLine, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Check } from 'typebox/value';
import { McpManagementProposalPreviewSchema, SkillDraftSchema, type SkillPreview, DEFAULT_AGENT_ID, TaskProposalOptionsSchema, TaskProposalPayloadSchema, ProcessPreviewSchema } from '@multivac/contracts';
import {
  CREATE_AGENT_PROPOSAL_KIND,
  CreateAgentProposalPayloadSchema,
  CreateAgentProposalPreviewSchema,
  CREATE_PROJECT_PROPOSAL_KIND,
  CreateProjectProposalPayloadSchema,
  CreateProjectProposalPreviewSchema,
  EXAMPLE_RENAME_SESSION_PROPOSAL_KIND,
  ExampleRenameSessionPayloadSchema,
  ExampleRenameSessionPreviewSchema,
  MOUNT_DIRECTORY_PROPOSAL_KIND,
  MountDirectoryProposalPreviewSchema,
  MOVE_SESSION_TO_PROJECT_PROPOSAL_KIND,
  MoveSessionToProjectOptionsSchema,
  MoveSessionToProjectProposalPayloadSchema,
  MoveSessionToProjectProposalPreviewSchema,
  ProjectDirectoryProposalPayloadSchema,
  SET_PRIMARY_DIRECTORY_PROPOSAL_KIND,
  SetPrimaryDirectoryProposalPreviewSchema,
  UNMOUNT_DIRECTORY_PROPOSAL_KIND,
  UnmountDirectoryProposalPreviewSchema,
  type Proposal,
} from '@multivac/contracts';
import { ObjectLink } from '../assistant/object-links.js';
import { useRemoteConversation } from '../assistant/remote-context.js';
import { RemoteTaskAgent, TaskAgentPicker, useTaskAgentBlocker } from '../agents/task-agent-picker.js';
import { THINKING_LEVEL_LABELS } from '../models/model-profile-view.js';
import {
  MOUNT_DIRECTORY_NOTES,
  NEW_PROJECT_CARD,
  PRIMARY_DIRECTORY_NOTES,
  PROJECT_EXECUTION_NOTE,
  ProjectDirectoryRule,
  unmountDirectoryNotes,
} from '../projects/project-card-fields.js';
import { MOVE_RUNNING_WARNING, MoveChangeFields, useLiveRunning } from '../workspace/move-change-fields.js';
import type { ProposalOptions } from './proposals.js';

/** 种类内容组件拿到的：提议本身、用户在卡上的选择（没有可选择内容的种类为 null）与修改它的方法。 */
export interface ProposalBodyProps {
  proposal: Proposal;
  options: ProposalOptions | null;
  onOptionsChange: (options: ProposalOptions) => void;
  /** 决定正在提交：卡上的选择暂不可改。 */
  disabled: boolean;
}

/**
 * 一种提议在对话中的呈现（卡片内容由提议种类提供）。新增提议种类时在 PROPOSAL_KIND_VIEWS 登记：
 * 卡片的外壳（标题、提出时的问题、此刻不能确认的原因、确认与取消、回执）由 ProposalCard 统一处理，这里只给出这一种提议的内容。
 */
export interface ProposalKindView {
  /** 卡片标题前的图标。 */
  icon: LucideIcon;
  /** 标题下的一句说明，写明确认后会发生什么。 */
  subtitle: string;
  /** 确认按钮的文字（动作，如“创建项目”“归入项目”）。 */
  confirmLabel: string;
  /** 两列字段外层 `<dl>` 的样式类（如归入项目卡的 `move-card`）。 */
  fieldsClassName?: string;
  /**
   * 卡上由用户作出的选择的初始值：服务端种类声明了选项时必须给出，确认时随决定提交。
   * 模型给出的参数至多决定这里的默认值；没有可选择内容的种类省略，确认时不带选项。
   */
  initialOptions?: (proposal: Proposal) => ProposalOptions;
  /**
   * 此刻不能确认的原因（随实时状态或卡上的选择变化，如会话正在运行、所选智能体的模型待核对），可以确认时为 null。
   * 它是 React hook：每张待确认的卡在整个生命周期内固定调用它。最终仍以服务端确认时的重新校验为准。
   */
  useBlocker?: (proposal: Proposal, options: ProposalOptions | null) => string | null;
  /**
   * 卡片内容：两列字段（`<dl>` 中的 `<div><dt/><dd/></div>`，按原型 ProjectCard / TaskReceipt 的写法）。
   * 拿到的是服务端给出的参数快照与提出时的预览，按该种类在契约中的 schema 自行核对；核对不过时返回 null，
   * 卡片只显示标题。
   */
  Body: (props: ProposalBodyProps) => ReactNode;
}

/** 示例提议（给会话改名，只在测试环境出现）的内容：哪个会话、改成什么、在哪个工作区。 */
function ExampleRenameSessionBody({ proposal }: ProposalBodyProps) {
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

/** 新建智能体：确认后登记的完整配置，模型写法与设置 · 智能体一致。 */
function CreateAgentBody({ proposal }: ProposalBodyProps) {
  if (!Check(CreateAgentProposalPayloadSchema, proposal.payload) ||
      !Check(CreateAgentProposalPreviewSchema, proposal.preview)) return null;
  const { preview } = proposal;
  const modelName = preview.modelName ?? '默认模型';
  const model = preview.thinkingLevel ? `${modelName} · 推理 ${THINKING_LEVEL_LABELS[preview.thinkingLevel]}` : modelName;
  return (
    <>
      <div><dt>名称</dt><dd>{preview.name}</dd></div>
      {preview.description ? <div><dt>说明</dt><dd>{preview.description}</dd></div> : null}
      <div><dt>模型</dt><dd>{model}</dd></div>
      {preview.instructions ? <div><dt>指令</dt><dd className="proposal-agent-instructions">{preview.instructions}</dd></div> : null}
      <div><dt>边界</dt><dd>智能体是执行配置，不改变权限边界。</dd></div>
    </>
  );
}

/**
 * 新建项目：与界面“新建项目…”同一张卡的内容（名称、目录的类型路径与规则、“这个目录内的修改将自动执行”），
 * 名称与目录由提议给出，不能在卡上修改（要改就请 Multivac 重新提出，或在界面中新建）。
 */
function CreateProjectBody({ proposal }: ProposalBodyProps) {
  if (!Check(CreateProjectProposalPayloadSchema, proposal.payload) ||
      !Check(CreateProjectProposalPreviewSchema, proposal.preview)) return null;
  const { preview } = proposal;
  return (
    <>
      <div><dt>名称</dt><dd>{preview.name}</dd></div>
      <div>
        <dt>目录</dt>
        <dd>
          <ProjectDirectoryRule
            kind={preview.directory.kind}
            path={preview.directory.path}
            placeholder="名称合法后才能给出托管目录的位置（工作文件根目录的 projects/ 下）"
          />
        </dd>
      </div>
      <div><dt>执行</dt><dd>{PROJECT_EXECUTION_NOTE}</dd></div>
    </>
  );
}

function ProjectRow({ projectId, name }: { projectId: string; name: string }) {
  return (
    <div>
      <dt>项目</dt>
      <dd><ObjectLink target={{ kind: 'project', id: projectId }}>{name}</ObjectLink></dd>
    </div>
  );
}

function NotesRow({ notes }: { notes: readonly string[] }) {
  return <div><dt>说明</dt><dd>{notes.join('')}</dd></div>;
}

/** 挂载目录：与设置 · 项目的挂载确认卡同样的内容。 */
function MountDirectoryBody({ proposal }: ProposalBodyProps) {
  if (!Check(ProjectDirectoryProposalPayloadSchema, proposal.payload) ||
      !Check(MountDirectoryProposalPreviewSchema, proposal.preview)) return null;
  const { payload, preview } = proposal;
  return (
    <>
      <ProjectRow projectId={payload.projectId} name={preview.projectName} />
      <div>
        <dt>目录</dt>
        <dd><ProjectDirectoryRule kind={preview.directory.kind} path={preview.directory.path} /></dd>
      </div>
      <div><dt>执行</dt><dd>{PROJECT_EXECUTION_NOTE}</dd></div>
      <NotesRow notes={MOUNT_DIRECTORY_NOTES} />
    </>
  );
}

/** 卸载目录：与设置 · 项目的卸载确认卡同样的内容；卸载主目录时写明由谁接替。 */
function UnmountDirectoryBody({ proposal }: ProposalBodyProps) {
  if (!Check(ProjectDirectoryProposalPayloadSchema, proposal.payload) ||
      !Check(UnmountDirectoryProposalPreviewSchema, proposal.preview)) return null;
  const { payload, preview } = proposal;
  return (
    <>
      <ProjectRow projectId={payload.projectId} name={preview.projectName} />
      <div><dt>目录</dt><dd><code>{preview.directory.path}</code></dd></div>
      {preview.primary && preview.nextPrimary && (
        <div><dt>主目录</dt><dd>卸载后改为 <code>{preview.nextPrimary.path}</code></dd></div>
      )}
      <NotesRow notes={unmountDirectoryNotes(preview.primary)} />
    </>
  );
}

/** 设主目录：哪个目录、现在的主目录是哪个。 */
function SetPrimaryDirectoryBody({ proposal }: ProposalBodyProps) {
  if (!Check(ProjectDirectoryProposalPayloadSchema, proposal.payload) ||
      !Check(SetPrimaryDirectoryProposalPreviewSchema, proposal.preview)) return null;
  const { payload, preview } = proposal;
  return (
    <>
      <ProjectRow projectId={payload.projectId} name={preview.projectName} />
      <div><dt>设为</dt><dd><code>{preview.directory.path}</code></dd></div>
      <div><dt>现在</dt><dd><code>{preview.previousPrimary.path}</code></dd></div>
      <NotesRow notes={PRIMARY_DIRECTORY_NOTES} />
    </>
  );
}

/**
 * 会话归入项目：与界面归入项目卡同样的内容（目录与边界的变化、记住的授权如何适用、临时目录的文件）。
 * “一并移入”的勾选是用户在卡上的选择，确认时随决定提交；模型的 moveFiles 只决定默认是否勾选。
 */
function MoveSessionToProjectBody({ proposal, options, onOptionsChange, disabled }: ProposalBodyProps) {
  if (!Check(MoveSessionToProjectProposalPayloadSchema, proposal.payload) ||
      !Check(MoveSessionToProjectProposalPreviewSchema, proposal.preview)) return null;
  const { payload, preview } = proposal;
  const moveFiles = Check(MoveSessionToProjectOptionsSchema, options) ? options.moveFiles : true;
  return (
    <>
      <div>
        <dt>会话</dt>
        <dd><ObjectLink target={{ kind: 'session', id: payload.sessionId }}>{preview.sessionTitle}</ObjectLink></dd>
      </div>
      <ProjectRow projectId={payload.projectId} name={preview.projectName} />
      <MoveChangeFields
        targetName={preview.projectName}
        sourceProjectName={preview.fromProject ? preview.fromWorkspaceName : null}
        preview={preview.move}
        pending={null}
        moveFiles={moveFiles}
        onMoveFilesChange={(next) => onOptionsChange({ moveFiles: next })}
        disabled={disabled}
      />
    </>
  );
}

/** 归入项目卡此刻能不能确认：会话正在运行（含等待授权）时不能，按会话的实时状态，读到之前用提出时的核对。 */
function useMoveBlocker(proposal: Proposal): string | null {
  const payload = Check(MoveSessionToProjectProposalPayloadSchema, proposal.payload) ? proposal.payload : null;
  const preview = Check(MoveSessionToProjectProposalPreviewSchema, proposal.preview) ? proposal.preview : null;
  const live = useLiveRunning(payload?.sessionId ?? proposal.sessionId);
  const running = payload ? live ?? preview?.move.running ?? false : false;
  return running ? MOVE_RUNNING_WARNING : null;
}

/**
 * 任务确认卡：任务内容由提议给出；执行智能体是用户在卡上的选择（默认取提议参数，缺省为通用执行），确认时随决定提交。
 * “我来处理”的任务不由 Agent 执行，不显示执行智能体。
 */
function TaskCreateBody({ proposal, options, onOptionsChange, disabled }: ProposalBodyProps) {
  const remote = useRemoteConversation();
  if (!Check(TaskProposalPayloadSchema, proposal.payload)) return null;
  const task = proposal.payload;
  const agentId = Check(TaskProposalOptionsSchema, options) ? options.agentId : task.agentId ?? DEFAULT_AGENT_ID;
  const preview = proposal.preview as { projectName?: string; sourceDirectory?: string | null; parentTitle?: string | null; dependencyTitles?: string[] };
  return <><div><dt>标题</dt><dd>{task.title}</dd></div><div><dt>目标</dt><dd>{task.goal}</dd></div><div><dt>处理方式</dt><dd>{task.humanOnly ? '我来处理（Agent 不会执行）' : 'Agent 处理'}</dd></div>{!task.humanOnly && <div><dt>执行</dt><dd>{remote ? <RemoteTaskAgent value={agentId} /> : <TaskAgentPicker value={agentId} disabled={disabled} onChange={(next) => onOptionsChange({ agentId: next })} />}</dd></div>}<div><dt>项目</dt><dd>{preview.projectName ?? task.projectId ?? '日常'}</dd></div><div><dt>父任务</dt><dd>{task.parentTaskId ? `${preview.parentTitle ?? task.parentTaskId}（${task.parentTaskId}）` : '无'}</dd></div><div><dt>前置任务</dt><dd>{task.dependencyIds?.map((id, index) => `${preview.dependencyTitles?.[index] ?? id}（${id}）`).join('、') || '无'}；全部进入审核中或已完成后可执行</dd></div><div><dt>执行目录</dt><dd>{task.humanOnly ? '无需 Agent 执行目录' : preview.sourceDirectory ? `${preview.sourceDirectory} 的独立副本；不写入原目录` : '新建任务独立目录'}</dd></div><div><dt>执行条件</dt><dd>{task.humanOnly ? '由你处理，Agent 不会执行' : 'macOS 原生受限执行，禁止派生子进程；不新增容器'}</dd></div><div><dt>范围</dt><dd>{task.scope || '任务独立目录'}</dd></div><div><dt>优先级</dt><dd>{({ high: '高', medium: '中', low: '低' })[task.priority ?? 'medium']}</dd></div><div><dt>验收</dt><dd>{task.humanOnly ? '由你确认完成' : task.acceptance === false ? task.acceptanceCriteria || '服务端自检' : task.acceptanceCriteria || '需要人工验收'}</dd></div></>;
}

/** 任务确认卡此刻能不能确认：所选执行智能体可以执行（“我来处理”的任务不核对）。 */
function useTaskCreateBlocker(proposal: Proposal, options: ProposalOptions | null): string | null {
  const payload = Check(TaskProposalPayloadSchema, proposal.payload) ? proposal.payload : null;
  const agentId = Check(TaskProposalOptionsSchema, options) ? options.agentId : payload?.agentId ?? DEFAULT_AGENT_ID;
  const blocker = useTaskAgentBlocker(agentId);
  return payload?.humanOnly ? null : blocker;
}

export const PROPOSAL_KIND_VIEWS: Readonly<Record<string, ProposalKindView>> = {
  'mcp.manage': {
    icon: FileQuestion, subtitle: '固定事实由服务端复核；确认后仅执行所示管理操作', confirmLabel: '确认变更',
    Body: ({ proposal }) => {
      if (!Check(McpManagementProposalPreviewSchema, proposal.preview)) return <p role="alert">提议事实格式无效，请取消后重新提出。</p>;
      const preview = proposal.preview;
      return <><div><dt>影响</dt><dd>{preview.impact}</dd></div><div><dt>来源、传输、账号与范围</dt><dd><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 360, overflow: 'auto' }}>{JSON.stringify(preview.facts, null, 2)}</pre></dd></div><div><dt>有效至</dt><dd>{preview.expiresAt}</dd></div><div><dt>对账命令</dt><dd>{preview.commandId}</dd></div></>;
    },
  },
  'process.stop': {
    icon: FileQuestion, subtitle: '确认后请求停止，真实退出结果在运行页核对', confirmLabel: '仍然停止',
    Body: ({ proposal }: ProposalBodyProps) => {
      if (!Check(ProcessPreviewSchema, proposal.preview)) return null;
      const preview = proposal.preview;
      return <><div><dt>进程</dt><dd>{preview.process.name}</dd></div><div><dt>命令</dt><dd>{preview.process.command}</dd></div><div><dt>影响</dt><dd>{preview.impact}</dd></div></>;
    },
  },
  'skill.register': {
    icon: FileQuestion, subtitle: '确认后登记固定版本；脚本和工具声明不授予执行权限', confirmLabel: '确认登记',
    Body: ({proposal}) => {
      if(!Check(SkillDraftSchema,proposal.payload))return <p>草案格式无效。</p>;
      const preview=proposal.preview as SkillPreview;
      return <><div><dt>范围</dt><dd>{proposal.payload.projectId??'全局'}</dd></div><div><dt>变更</dt><dd>{preview.changes.join('、')||'无内容变化'}</dd></div><div><dt>正文</dt><dd><pre style={{whiteSpace:'pre-wrap',maxHeight:240,overflow:'auto'}}>{preview.body}</pre></dd></div><div><dt>附件</dt><dd>{Object.entries(proposal.payload.files).filter(([p])=>p!=='SKILL.md').map(([path,text])=><details key={path}><summary>{path}</summary><pre style={{whiteSpace:'pre-wrap',maxHeight:180,overflow:'auto'}}>{text}</pre></details>)}</dd></div><div><dt>诊断</dt><dd>{preview.manifest.diagnostics.join('；')||'无格式诊断'}；依赖{preview.manifest.dependencies.source==='unknown'?'未知':'仅按声明核对'}。</dd></div></>;
    },
  },
  'task.create': {
    icon: FileQuestion, subtitle: '确认后建立任务，尚未启动执行', confirmLabel: '创建任务',
    initialOptions: (proposal) => ({
      agentId: Check(TaskProposalPayloadSchema, proposal.payload) ? proposal.payload.agentId ?? DEFAULT_AGENT_ID : DEFAULT_AGENT_ID,
    }),
    useBlocker: useTaskCreateBlocker,
    Body: TaskCreateBody,
  },
  [CREATE_AGENT_PROPOSAL_KIND]: {
    icon: Bot, subtitle: '确认后登记为智能体，可在新建任务时选用', confirmLabel: '创建智能体',
    Body: CreateAgentBody,
  },
  [CREATE_PROJECT_PROPOSAL_KIND]: {
    icon: Folder,
    subtitle: NEW_PROJECT_CARD.description,
    confirmLabel: NEW_PROJECT_CARD.confirmLabel,
    Body: CreateProjectBody,
  },
  [MOUNT_DIRECTORY_PROPOSAL_KIND]: {
    icon: FolderPlus,
    subtitle: '确认后普通项目工作会话可直接读取、编辑和写入这个目录',
    confirmLabel: '挂载',
    Body: MountDirectoryBody,
  },
  [UNMOUNT_DIRECTORY_PROPOSAL_KIND]: {
    icon: FolderMinus,
    subtitle: '确认后移除项目挂载权限，已有工作目录和有效独立授权仍按原规则生效',
    confirmLabel: '卸载',
    Body: UnmountDirectoryBody,
  },
  [SET_PRIMARY_DIRECTORY_PROPOSAL_KIND]: {
    icon: FolderCheck,
    subtitle: '确认后项目中新建的会话在这个目录中工作',
    confirmLabel: '设为主目录',
    Body: SetPrimaryDirectoryBody,
  },
  [MOVE_SESSION_TO_PROJECT_PROPOSAL_KIND]: {
    icon: FolderInput,
    subtitle: '会话随之出现在该项目的工作区里，对话历史不变',
    confirmLabel: '归入项目',
    fieldsClassName: 'move-card',
    initialOptions: (proposal) => ({
      moveFiles: Check(MoveSessionToProjectProposalPayloadSchema, proposal.payload) ? proposal.payload.moveFiles ?? true : true,
    }),
    useBlocker: useMoveBlocker,
    Body: MoveSessionToProjectBody,
  },
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
