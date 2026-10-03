import { Type } from 'typebox';
import { ManagementPageIdSchema } from './management-pages.js';

/**
 * 全局 Multivac 的内部工具：由服务端直接执行、只注入全局 Multivac 会话的工具（查询与管理项目、工作区与会话）。
 * 这里只放服务端与前端共用的口径：工具行的展示名称与关键参数，以及工具结果中可以公开的部分。
 */

export interface InternalToolDisplay {
  /** 工具行在没有关键参数时显示的“动作 + 对象”，如“列出工作区”。 */
  displayName: string;
  /** 最能说明本次调用的入参与对应动作；工具行据此写成“动作 + 关键参数”。 */
  keyArgument?: { argument: string; action: string };
}

/**
 * 已注册内部工具的展示口径。新增内部工具时在这里登记，服务端注册表会核对每个工具都有展示口径。
 */
export const INTERNAL_TOOL_DISPLAY: Readonly<Record<string, InternalToolDisplay>> = {
  list_workspaces: { displayName: '列出工作区' },
  list_tasks: { displayName: '列出任务', keyArgument: { argument: 'query', action: '查找任务' } },
  get_task: { displayName: '查看任务', keyArgument: { argument: 'taskId', action: '查看任务' } },
  request_task_input: { displayName: '提出任务澄清' },
  submit_task_result: { displayName: '提交任务成果' },
  create_task: { displayName: '新建任务', keyArgument: { argument: 'title', action: '新建任务' } },
  propose_create_task: { displayName: '提议新建任务', keyArgument: { argument: 'title', action: '提议新建任务' } },
  delete_task: { displayName: '删除任务', keyArgument: { argument: 'taskId', action: '删除任务' } },
  list_task_groups: { displayName: '列出任务分组' },
  create_task_group: { displayName: '新建任务分组', keyArgument: { argument: 'title', action: '新建任务分组' } },
  list_task_requests: { displayName: '列出任务请求' },
  get_task_request: { displayName: '查看任务请求' },
  respond_task_request: { displayName: '回应任务请求', keyArgument: { argument: 'decision', action: '任务决定' } },
  list_task_artifacts: { displayName: '列出任务成果' },
  read_task_artifact: { displayName: '读取任务成果' },
  submit_task_artifact: { displayName: '登记任务成果', keyArgument: { argument: 'title', action: '登记任务成果' } },
  update_task: { displayName: '修改任务属性' },
  control_task: { displayName: '管理任务执行', keyArgument: { argument: 'action', action: '任务动作' } },
  list_projects: { displayName: '列出项目' },
  list_sessions: { displayName: '列出会话', keyArgument: { argument: 'title', action: '查找会话' } },
  get_session: { displayName: '查看会话', keyArgument: { argument: 'sessionId', action: '查看会话' } },
  get_current_view: { displayName: '读取当前视图' },
  read_session_recent: { displayName: '读取会话内容', keyArgument: { argument: 'sessionId', action: '读取会话' } },
  create_session: { displayName: '新建会话', keyArgument: { argument: 'title', action: '新建会话' } },
  rename_session: { displayName: '改名会话', keyArgument: { argument: 'title', action: '会话改名为' } },
  archive_session: { displayName: '归档会话', keyArgument: { argument: 'sessionId', action: '归档会话' } },
  restore_session: { displayName: '恢复会话', keyArgument: { argument: 'sessionId', action: '恢复会话' } },
  switch_workspace: { displayName: '切换工作区', keyArgument: { argument: 'workspaceId', action: '切到工作区' } },
  open_session: { displayName: '在工作区打开会话', keyArgument: { argument: 'sessionId', action: '在工作区打开' } },
  set_parallel_count: { displayName: '调整并排数', keyArgument: { argument: 'count', action: '并排数调为' } },
  set_view_mode: { displayName: '切换并排 / 聚焦' },
  open_management_page: { displayName: '打开管理页' },
  rename_project: { displayName: '项目改名', keyArgument: { argument: 'name', action: '项目改名为' } },
  update_project_constraints: { displayName: '修改项目默认约束' },
  propose_create_project: { displayName: '提议新建项目', keyArgument: { argument: 'name', action: '提议新建项目' } },
  propose_mount_directory: { displayName: '提议挂载目录', keyArgument: { argument: 'directory', action: '提议挂载' } },
  propose_unmount_directory: { displayName: '提议卸载目录', keyArgument: { argument: 'directory', action: '提议卸载' } },
  propose_set_primary_directory: {
    displayName: '提议设为主目录',
    keyArgument: { argument: 'directory', action: '提议设为主目录' },
  },
  propose_move_session_to_project: {
    displayName: '提议归入项目',
    keyArgument: { argument: 'sessionId', action: '提议归入项目' },
  },
  // 示例提议（只在测试环境注册）：验证对话内确认卡机制。
  example_propose_rename_session: {
    displayName: '提议改名会话',
    keyArgument: { argument: 'title', action: '提议改名为' },
  },
};

/** 对话中可以点开的对象：会话、项目与工作区。 */
export type MultivacObjectKind = 'session' | 'project' | 'workspace' | 'task';

/**
 * 回复正文中指向对象的链接写法（Markdown 链接的地址）：`multivac://session/<会话 id>`、
 * `multivac://project/<项目 id>`、`multivac://workspace/<工作区 id>`。界面按 id 核对对象存在后渲染为可以点开的链接
 * （会话在工作区打开，项目打开设置 · 项目，工作区切到它），核对不到的只显示文字。
 */
export const MULTIVAC_OBJECT_LINK_PATTERN = /^multivac:\/\/(session|project|workspace|task)\/([A-Za-z0-9._:-]{1,128})$/u;

export function multivacObjectLink(kind: MultivacObjectKind, id: string): string {
  return `multivac://${kind}/${id}`;
}

/** 解析回复中的对象链接地址；不是对象链接时返回 null。 */
export function parseMultivacObjectLink(href: string): { kind: MultivacObjectKind; id: string } | null {
  const match = MULTIVAC_OBJECT_LINK_PATTERN.exec(href);
  return match ? { kind: match[1] as MultivacObjectKind, id: match[2]! } : null;
}

export function internalToolDisplay(toolName: string): InternalToolDisplay | undefined {
  return Object.hasOwn(INTERNAL_TOOL_DISPLAY, toolName) ? INTERNAL_TOOL_DISPLAY[toolName] : undefined;
}

export const INTERNAL_TOOL_RESULT_SUMMARY_MAX_LENGTH = 120;
export const INTERNAL_TOOL_RESULT_MAX_REFS = 50;

const RefId = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' });
const RefLabel = Type.String({ minLength: 1, maxLength: 200 });

/** 结果中涉及的对象：前端据此把回复与回执中的对象渲染为可以打开的链接。 */
export const AssistantToolObjectRefSchema = Type.Union([
  Type.Object({ kind: Type.Literal('task'), taskId: RefId, label: RefLabel }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal('workspace'), workspaceId: RefId, label: RefLabel },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('project'), projectId: RefId, label: RefLabel },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('session'), sessionId: RefId, label: RefLabel },
    { additionalProperties: false },
  ),
]);
export type AssistantToolObjectRef = Type.Static<typeof AssistantToolObjectRefSchema>;

export const INTERNAL_TOOL_RECEIPT_HEADLINE_MAX_LENGTH = 120;
export const INTERNAL_TOOL_RECEIPT_DETAIL_MAX_LENGTH = 400;

/**
 * 回执上的操作（由用户点击，复用界面已有的做法）：
 * - open-session：在工作区打开会话（切到它所在的工作区并聚焦；已归档的先在确认卡上说明需要恢复）；
 * - restore-session：恢复已归档的会话（归档回执上的撤回）；
 * - open-workspace：切到这个工作区（与对话中的工作区链接同一路径）；
 * - open-management-page：打开管理中的这一页；
 * - open-project：打开“设置 · 项目”并选中这个项目（项目的名称、目录与默认约束在那里修改）。
 */
export const AssistantToolReceiptActionSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal('open-session'), sessionId: RefId },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('restore-session'), sessionId: RefId },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('open-workspace'), workspaceId: RefId },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('open-management-page'), page: ManagementPageIdSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('open-project'), projectId: RefId },
    { additionalProperties: false },
  ),
]);
export type AssistantToolReceiptAction = Type.Static<typeof AssistantToolReceiptActionSchema>;

/**
 * 管理类内部工具的回执（原型 ConfirmedReceipt）：做了什么（标题）、一句补充（在哪里、目录的去留、怎么撤回），
 * 以及可以接着做的操作。文字由服务端按执行结果写成，界面原样显示；按钮是否可用由界面按对象的当前状态判断。
 */
export const AssistantToolReceiptSchema = Type.Object(
  {
    headline: Type.String({ minLength: 1, maxLength: INTERNAL_TOOL_RECEIPT_HEADLINE_MAX_LENGTH }),
    detail: Type.String({ maxLength: INTERNAL_TOOL_RECEIPT_DETAIL_MAX_LENGTH }),
    actions: Type.Array(AssistantToolReceiptActionSchema, { maxItems: 2 }),
  },
  { additionalProperties: false },
);
export type AssistantToolReceipt = Type.Static<typeof AssistantToolReceiptSchema>;

/**
 * 内部工具结果中公开的部分（字段白名单）：一句中文结果摘要与涉及的对象；管理类工具另有回执。
 * 工具返回给模型的正文不公开；只有内部工具成功时才有这一项，内置工具（read、bash 等）始终没有。
 * 后续的扩展同样以新增可选字段的方式进行，仍按白名单校验。
 */
export const AssistantToolResultSchema = Type.Object(
  {
    summary: Type.String({ minLength: 1, maxLength: INTERNAL_TOOL_RESULT_SUMMARY_MAX_LENGTH }),
    refs: Type.Array(AssistantToolObjectRefSchema, { maxItems: INTERNAL_TOOL_RESULT_MAX_REFS }),
    receipt: Type.Optional(AssistantToolReceiptSchema),
  },
  { additionalProperties: false },
);
export type AssistantToolResult = Type.Static<typeof AssistantToolResultSchema>;
