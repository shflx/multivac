import { Type, type Static } from 'typebox';

export const SkillRefSchema = Type.Object(
  {
    skillId: Type.String({ minLength: 1, maxLength: 100 }),
    version: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  },
  { additionalProperties: false },
);
export type SkillRef = Static<typeof SkillRefSchema>;
export interface SkillManifest {
  name: string;
  description: string;
  metadata: Record<string, unknown>;
  diagnostics: string[];
  dependencies: { source: 'declared' | 'unknown'; tools: string[] };
  files: { path: string; bytes: number; hash: string }[];
  version: string;
}
export interface SkillRecord extends SkillRef {
  name: string;
  displayName: string;
  userTools?: string[];
  description: string;
  source: string;
  projectId: string | null;
  revision: number;
  enabled: boolean;
  removed: boolean;
  createdAt: string;
  updatedAt: string;
}
export const SkillImportSchema = Type.Object(
  {
    source: Type.String({ minLength: 1, maxLength: 4096 }),
    projectId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    displayName: Type.String({ maxLength: 128 }),
    skillId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    revision: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);
export type SkillImport = Static<typeof SkillImportSchema>;
/**
 * 从浏览器上传的 Skill 包：选择的本地目录按相对路径逐个文件提交，或直接提交 zip 包；内容均为 base64。
 * label 只用于展示来源（目录名或 zip 文件名），不作为服务端路径。
 */
export const SkillUploadSchema = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 255 }),
    projectId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    displayName: Type.String({ maxLength: 128 }),
    skillId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    revision: Type.Optional(Type.Integer({ minimum: 1 })),
    content: Type.Union([
      Type.Object(
        {
          kind: Type.Literal('files'),
          files: Type.Record(Type.String({ minLength: 1, maxLength: 512 }), Type.String({ maxLength: 3_000_000 })),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        { kind: Type.Literal('zip'), data: Type.String({ minLength: 1, maxLength: 12_000_000 }) },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);
export type SkillUpload = Static<typeof SkillUploadSchema>;
/** 上传与对话草案登记的 Skill 没有可重新读取的本机目录，来源只用于展示。 */
export const SKILL_UPLOAD_SOURCE_PREFIX = 'upload:';
export const SKILL_DRAFT_SOURCE_PREFIX = 'draft:';
export function isPackagedSkillSource(source: string): boolean {
  return source.startsWith(SKILL_UPLOAD_SOURCE_PREFIX) || source.startsWith(SKILL_DRAFT_SOURCE_PREFIX);
}
export interface SkillPreview {
  previewId: string;
  input: SkillImport;
  manifest: SkillManifest;
  previousVersion: string | null;
  body: string;
  changes: string[];
}
export const SkillConfirmSchema = Type.Object(
  {
    commandId: Type.String({ minLength: 1, maxLength: 128 }),
    previewId: Type.String({ minLength: 1, maxLength: 100 }),
  },
  { additionalProperties: false },
);
export const SkillStateSchema = Type.Object(
  {
    commandId: Type.String({ minLength: 1, maxLength: 128 }),
    skillId: Type.String({ minLength: 1, maxLength: 100 }),
    revision: Type.Integer({ minimum: 1 }),
    action: Type.Union([Type.Literal('enable'), Type.Literal('disable'), Type.Literal('remove')]),
  },
  { additionalProperties: false },
);
export interface SkillContext {
  projectId: string | null;
  sessionId: string | null;
  host: 'work' | 'task' | 'reading';
  tools: readonly string[];
}
export interface SkillAvailability {
  record: SkillRecord;
  available: boolean;
  reasons: string[];
  dependencies: SkillManifest['dependencies'];
  hidden: boolean;
  closed: boolean;
}
export const SkillPreferenceSchema = Type.Object(
  {
    commandId: Type.String({ minLength: 1, maxLength: 128 }),
    skillId: Type.String({ minLength: 1, maxLength: 100 }),
    projectId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    sessionId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    revision: Type.Integer({ minimum: 0 }),
    hidden: Type.Boolean(),
  },
  { additionalProperties: false },
);
export interface SkillUse extends SkillRef {
  useId: string;
  sessionId: string;
  toolCallId: string;
  path: string;
  kind: 'load' | 'resource';
  createdAt: string;
}
/** 详情中的使用记录：附带会话名称，便于识别来自哪次对话；会话已归档或不存在时不可打开。 */
export interface SkillUseView extends SkillUse {
  sessionTitle: string | null;
  sessionAvailable: boolean;
}
/** 显式调用身份随普通草稿持久化；UI 将首行呈现为标签，服务端只认固定身份。 */
export function skillInvocation(ref: SkillRef, label = 'Skill'): string {
  return `/Skill ${ref.skillId}@${ref.version} ${label.replace(/[\r\n]/gu, ' ')}\n`;
}
export function parseSkillInvocation(text: string): { ref: SkillRef; label: string; text: string } | null {
  const match = /^\/Skill ([A-Za-z0-9._:-]+)@([a-f0-9]{64}) ([^\r\n]*)\r?\n/u.exec(text);
  return match
    ? { ref: { skillId: match[1]!, version: match[2]! }, label: match[3]!, text: text.slice(match[0].length) }
    : null;
}
/** 本次请求的可见正文；只选了 Skill 没写内容时给出固定说明，服务端回显与前端待确认消息共用。 */
export function skillRequestText(selection: { label: string; text: string }): string {
  return selection.text.trim() ? selection.text : `使用 Skill「${selection.label}」`;
}
/** 历史消息上的 Skill 标签：只保留身份与名称，正文作为独立上下文交给模型，不进入用户消息。 */
export const AssistantMessageSkillSchema = Type.Object(
  {
    skillId: Type.String({ minLength: 1, maxLength: 100 }),
    version: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    label: Type.String({ maxLength: 256 }),
  },
  { additionalProperties: false },
);
export type AssistantMessageSkill = Static<typeof AssistantMessageSkillSchema>;
export const SkillDraftSchema = Type.Object(
  {
    displayName: Type.String({ maxLength: 128 }),
    projectId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    skillId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    revision: Type.Optional(Type.Integer({ minimum: 1 })),
    files: Type.Record(Type.String({ minLength: 1, maxLength: 240 }), Type.String({ maxLength: 65536 })),
  },
  { additionalProperties: false },
);
export type SkillDraft = Static<typeof SkillDraftSchema>;
export const SkillDependenciesSchema = Type.Object(
  {
    commandId: Type.String({ minLength: 1, maxLength: 128 }),
    skillId: Type.String({ minLength: 1, maxLength: 100 }),
    revision: Type.Integer({ minimum: 1 }),
    tools: Type.Union([
      Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32, uniqueItems: true }),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);
