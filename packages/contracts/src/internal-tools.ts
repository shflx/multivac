import { Type } from 'typebox';

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
  list_projects: { displayName: '列出项目' },
  list_sessions: { displayName: '列出会话', keyArgument: { argument: 'title', action: '查找会话' } },
  get_session: { displayName: '查看会话', keyArgument: { argument: 'sessionId', action: '查看会话' } },
  get_current_view: { displayName: '读取当前视图' },
  read_session_recent: { displayName: '读取会话内容', keyArgument: { argument: 'sessionId', action: '读取会话' } },
};

/**
 * 回复正文中指向会话或项目的链接写法（Markdown 链接的地址）：`multivac://session/<会话 id>`、
 * `multivac://project/<项目 id>`。界面按 id 核对对象存在后渲染为可以点开的链接（会话在工作区打开，
 * 项目打开设置 · 项目），核对不到的只显示文字。
 */
export const MULTIVAC_OBJECT_LINK_PATTERN = /^multivac:\/\/(session|project)\/([A-Za-z0-9._:-]{1,128})$/u;

export function multivacObjectLink(kind: 'session' | 'project', id: string): string {
  return `multivac://${kind}/${id}`;
}

/** 解析回复中的对象链接地址；不是对象链接时返回 null。 */
export function parseMultivacObjectLink(href: string): { kind: 'session' | 'project'; id: string } | null {
  const match = MULTIVAC_OBJECT_LINK_PATTERN.exec(href);
  return match ? { kind: match[1] as 'session' | 'project', id: match[2]! } : null;
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

/**
 * 内部工具结果中公开的部分（字段白名单）：一句中文结果摘要与涉及的对象。
 * 工具返回给模型的正文不公开；只有内部工具成功时才有这一项，内置工具（read、bash 等）始终没有。
 * 后续的回执、提议卡以新增可选字段的方式扩展，仍按白名单校验。
 */
export const AssistantToolResultSchema = Type.Object(
  {
    summary: Type.String({ minLength: 1, maxLength: INTERNAL_TOOL_RESULT_SUMMARY_MAX_LENGTH }),
    refs: Type.Array(AssistantToolObjectRefSchema, { maxItems: INTERNAL_TOOL_RESULT_MAX_REFS }),
  },
  { additionalProperties: false },
);
export type AssistantToolResult = Type.Static<typeof AssistantToolResultSchema>;
