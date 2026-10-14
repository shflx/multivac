import { Type } from 'typebox';
import { ManagementPageIdSchema } from './management-pages.js';

/**
 * 全局 Multivac 的内部工具：由服务端直接执行、按会话种类注入的工具（查询与管理项目、工作区与会话）。
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
  read_previous_page: { displayName: '读取上一页' },
  read_next_page: { displayName: '读取下一页' },
  list_notes: { displayName: '查询独立笔记', keyArgument: { argument: 'query', action: '查找笔记' } },
  read_note: { displayName: '读取独立笔记', keyArgument: { argument: 'noteId', action: '读取笔记' } },
  create_note: { displayName: '新建独立笔记', keyArgument: { argument: 'title', action: '新建笔记' } },
  update_note: { displayName: '更新独立笔记', keyArgument: { argument: 'noteId', action: '更新笔记' } },
  get_note_operation: { displayName: '核对笔记保存回执' },
  list_books: { displayName: '列出书架' },
  get_book: { displayName: '查看书籍信息', keyArgument: { argument: 'bookId', action: '查看书籍' } },
  open_book: { displayName: '打开书籍', keyArgument: { argument: 'bookId', action: '打开书籍' } },
  list_workspaces: { displayName: '列出工作区' },
  list_tasks: { displayName: '列出任务', keyArgument: { argument: 'query', action: '查找任务' } },
  get_task: { displayName: '查看任务', keyArgument: { argument: 'taskId', action: '查看任务' } },
  list_inbox: { displayName: '查询 Inbox' },
  get_inbox_request: { displayName: '读取 Inbox 请求' },
  respond_inbox_request: { displayName: '转交用户决定' },
  propose_git_publish: { displayName: '申请 Git 分支发布' },
  request_task_input: { displayName: '提出任务澄清' },
  list_runs: { displayName: '查询任务运行' },
  list_managed_processes: { displayName: '查询后台进程' },
  read_managed_process_log: { displayName: '读取进程日志' },
  propose_stop_managed_process: { displayName: '提议停止进程' },
  stop_managed_process: { displayName: '停止后台进程' },
  stop_session_processes: { displayName: '结束会话后台运行' },
  start_managed_process: { displayName: '启动受控后台进程' },
  get_task_execution_tree: { displayName: '查看本次子任务范围' },
  report_task_child: { displayName: '登记子任务进展' },
  submit_task_result: { displayName: '提交任务成果' },
  read_git: { displayName: '读取本地 Git 仓库', keyArgument: { argument: 'ref', action: '读取分支' } },
  inspect_task_git: { displayName: '查看任务代码差异' },
  commit_task_code: { displayName: '提交任务代码', keyArgument: { argument: 'message', action: '创建本地提交' } },
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
  confirm_human_task: { displayName: '记录用户完成确认' },
  complete_task: { displayName: '提交任务完成说明', keyArgument: { argument: 'taskId', action: '完成任务' } },
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
  propose_create_agent: { displayName: '提议新建智能体', keyArgument: { argument: 'name', action: '提议新建智能体' } },
  // 示例提议（只在测试环境注册）：验证对话内确认卡机制。
  example_propose_rename_session: {
    displayName: '提议改名会话',
    keyArgument: { argument: 'title', action: '提议改名为' },
  },
};

/** 对话中可以点开的对象：会话、项目与工作区。 */
export type MultivacObjectKind = 'session' | 'project' | 'workspace' | 'task' | 'book' | 'inbox';

/**
 * 回复正文中指向对象的链接写法（Markdown 链接的地址）：`multivac://session/<会话 id>`、
 * `multivac://project/<项目 id>`、`multivac://workspace/<工作区 id>`。界面按 id 核对对象存在后渲染为可以点开的链接
 * （会话在工作区打开，项目打开设置 · 项目，工作区切到它），核对不到的只显示文字。
 */
export const MULTIVAC_OBJECT_LINK_PATTERN = /^multivac:\/\/(session|project|workspace|task|book|inbox)\/([A-Za-z0-9._:-]{1,128})$/u;

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

export interface CoordinatorToolGroup {
  label: string;
  /** 这组工具替协调者做什么，展示在智能体页的协调者详情里。 */
  purpose: string;
  tools: readonly string[];
}

/**
 * 协调者内部工具的展示分组。实际可用的工具以服务端注册为准（`AgentList.coordinatorTools`），
 * 这里只负责归类与说明；每个已注册工具必须恰好落在一组里，由服务端测试保证。
 */
export const COORDINATOR_TOOL_GROUPS: readonly CoordinatorToolGroup[] = [
  {
    label: '任务',
    purpose: '查询、新建与管理任务，处理任务提出的请求，所有有副作用的执行都转交任务会话。',
    tools: [
      'list_tasks', 'get_task', 'list_task_groups', 'create_task', 'propose_create_task', 'update_task', 'control_task',
      'delete_task', 'create_task_group', 'confirm_human_task', 'set_parallel_count',
      'list_task_requests', 'get_task_request', 'respond_task_request',
    ],
  },
  {
    label: '运行',
    purpose: '查看任务运行与后台进程，读取进程日志，停止进程前先请你确认。',
    tools: [
      'list_runs', 'list_managed_processes', 'read_managed_process_log', 'propose_stop_managed_process',
      'stop_managed_process', 'stop_session_processes',
    ],
  },
  { label: 'Inbox', purpose: '查询待你决定的请求，并把你的决定转交回去。', tools: ['list_inbox', 'get_inbox_request', 'respond_inbox_request'] },
  {
    label: '成果',
    purpose: '读取任务产出的成果，发布 Git 分支前先请你确认。',
    tools: ['list_task_artifacts', 'read_task_artifact', 'submit_task_artifact', 'propose_git_publish'],
  },
  {
    label: '工作区与会话',
    purpose: '查询和整理工作区与会话，切换视图，打开管理页面。',
    tools: [
      'list_workspaces', 'switch_workspace', 'list_sessions', 'get_session', 'get_current_view', 'read_session_recent',
      'create_session', 'rename_session', 'archive_session', 'restore_session', 'open_session', 'set_view_mode',
      'open_management_page',
    ],
  },
  {
    label: '项目',
    purpose: '查询项目，维护名称与默认约束；新建项目、挂载目录等改动先请你确认。',
    tools: [
      'list_projects', 'rename_project', 'update_project_constraints', 'propose_create_project', 'propose_mount_directory',
      'propose_unmount_directory', 'propose_set_primary_directory', 'propose_move_session_to_project',
    ],
  },
  { label: '阅读', purpose: '查询书架与书籍信息，打开书籍。', tools: ['list_books', 'get_book', 'open_book'] },
  { label: '笔记', purpose: '按你的要求查询、读取、新建和更新独立笔记，核对保存回执。', tools: ['list_notes', 'read_note', 'create_note', 'update_note', 'get_note_operation'] },
  { label: '智能体', purpose: '按你的描述提议新建智能体，确认后才保存。', tools: ['propose_create_agent'] },
];

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
