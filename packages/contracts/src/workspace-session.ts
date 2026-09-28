import { Type } from 'typebox';
import { AssistantQuoteSchema } from './assistant-session.js';
import { TempRetentionDaysSchema } from './preferences.js';

/** 不属于任何项目的会话所在的默认工作区；项目工作区另有各自的 id（与项目 id 相同）。 */
export const DEFAULT_WORKSPACE_ID = 'default';
/** 默认工作区的名称。 */
export const DEFAULT_WORKSPACE_NAME = '默认工作区';
export const WORKSPACE_SESSION_TITLE_MAX_LENGTH = 80;
export const WORKSPACE_SESSION_BODY_LIMIT_BYTES = 4 * 1024;

/** 会话 id 由客户端生成并作为新建命令的幂等键，与 commandId 使用相同字符集。 */
export const WorkspaceSessionIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9._:-]+$',
});

const Title = Type.String({ minLength: 1, maxLength: WORKSPACE_SESSION_TITLE_MAX_LENGTH });
const Timestamp = Type.String({ minLength: 1 });

/** coordinator 是全局 Multivac 会话；work 是用户在工作区里新建的工作会话。 */
export const WorkspaceSessionKindSchema = Type.Union([
  Type.Literal('coordinator'),
  Type.Literal('work'),
]);
export type WorkspaceSessionKind = Type.Static<typeof WorkspaceSessionKindSchema>;

/**
 * 会话工作目录的类型：
 * - session-temp：不属于项目的工作会话专用的临时目录（工作文件根目录下 `sessions/`）；
 * - multivac：全局 Multivac 长期保留的工作目录（工作文件根目录下 `multivac/`）；
 * - project-managed：项目没有挂载目录时由 Multivac 托管的目录（工作文件根目录下 `projects/`）；
 * - project-mounted：项目挂载的用户目录；
 * - worktree：在挂载目录的独立 worktree 中修改（预留）。
 */
export const WorkingDirectoryKindSchema = Type.Union([
  Type.Literal('session-temp'),
  Type.Literal('multivac'),
  Type.Literal('project-managed'),
  Type.Literal('project-mounted'),
  Type.Literal('worktree'),
]);
export type WorkingDirectoryKind = Type.Static<typeof WorkingDirectoryKindSchema>;

/** 会话的工作目录：以 Multivac 的会话记录为准，路径为绝对路径。 */
export const WorkingDirectorySchema = Type.Object(
  {
    kind: WorkingDirectoryKindSchema,
    path: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type WorkingDirectory = Type.Static<typeof WorkingDirectorySchema>;

export const WorkspaceSessionSchema = Type.Object(
  {
    sessionId: WorkspaceSessionIdSchema,
    title: Title,
    kind: WorkspaceSessionKindSchema,
    workspaceId: Type.String({ minLength: 1 }),
    createdAt: Timestamp,
    archivedAt: Type.Union([Timestamp, Type.Null()]),
    /** 栈式深入的父会话；顶层会话为 null。 */
    parentSessionId: Type.Union([WorkspaceSessionIdSchema, Type.Null()]),
    /** 深入时在父会话中选中的内容；顶层会话为 null。 */
    originText: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    workingDirectory: WorkingDirectorySchema,
  },
  { additionalProperties: false },
);
export type WorkspaceSession = Type.Static<typeof WorkspaceSessionSchema>;

export const WorkspaceSessionListResponseSchema = Type.Object(
  {
    /** 列出的工作区；跨全部工作区列出时为 null。 */
    workspaceId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    sessions: Type.Array(WorkspaceSessionSchema),
  },
  { additionalProperties: false },
);
export type WorkspaceSessionListResponse = Type.Static<typeof WorkspaceSessionListResponseSchema>;

export const CreateWorkspaceSessionSchema = Type.Object(
  {
    sessionId: WorkspaceSessionIdSchema,
    title: Title,
    /**
     * 新会话所在的工作区，缺省为默认工作区。项目工作区中的会话以项目主目录为工作目录；
     * 栈式深入的子会话留在父会话的工作区，不接受另一个工作区。
     */
    workspaceId: Type.Optional(Type.String({ minLength: 1 })),
    /** 栈式深入：基于父会话中选中的一段内容新建子会话。 */
    parent: Type.Optional(Type.Object(
      {
        sessionId: WorkspaceSessionIdSchema,
        quote: AssistantQuoteSchema,
      },
      { additionalProperties: false },
    )),
  },
  { additionalProperties: false },
);
export type CreateWorkspaceSession = Type.Static<typeof CreateWorkspaceSessionSchema>;

export const RenameWorkspaceSessionSchema = Type.Object(
  { title: Title },
  { additionalProperties: false },
);
export type RenameWorkspaceSession = Type.Static<typeof RenameWorkspaceSessionSchema>;

/** 归入项目的核对与结果中最多列出的条目名；超出的只计入数量。 */
export const SESSION_MOVE_ENTRY_LIST_LIMIT = 100;

/**
 * 归入项目：会话移到项目的同名工作区，工作目录改为项目主目录，会话 id、Pi 历史与父子关系不变。
 * 只在会话空闲（没有进行中的一轮，也没有等待授权）时进行。
 */
export const MoveSessionToProjectSchema = Type.Object(
  {
    projectId: Type.String({ minLength: 1 }),
    /**
     * 原工作目录是会话临时目录时，是否把其中的文件一并移入项目目录：
     * 按第一层条目移动，与项目目录中已有条目同名的不覆盖、留在原临时目录。
     */
    moveFiles: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type MoveSessionToProject = Type.Static<typeof MoveSessionToProjectSchema>;

/** 归入前的核对：只给出目标项目，不做任何修改。 */
export const SessionMovePreviewRequestSchema = Type.Object(
  { projectId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
export type SessionMovePreviewRequest = Type.Static<typeof SessionMovePreviewRequestSchema>;

const EntryNames = Type.Array(Type.String({ minLength: 1 }), { maxItems: SESSION_MOVE_ENTRY_LIST_LIMIT });

/** 会话临时目录第一层的条目（文件与子目录），按名称排序。 */
export const SessionTempEntriesSchema = Type.Object(
  {
    total: Type.Integer({ minimum: 0 }),
    names: EntryNames,
    /** 与项目目录中已有条目同名的条目：不会移入，留在原临时目录。 */
    conflictTotal: Type.Integer({ minimum: 0 }),
    conflicts: EntryNames,
  },
  { additionalProperties: false },
);
export type SessionTempEntries = Type.Static<typeof SessionTempEntriesSchema>;

export const SessionMovePreviewSchema = Type.Object(
  {
    sessionId: WorkspaceSessionIdSchema,
    from: WorkingDirectorySchema,
    to: WorkingDirectorySchema,
    /** 会话此刻是否正在运行（含等待授权）；运行中不能归入，需要先停止。 */
    running: Type.Boolean(),
    /** 原工作目录是会话临时目录时其中的条目；不是临时目录时为 null（没有可移入的文件）。 */
    files: Type.Union([SessionTempEntriesSchema, Type.Null()]),
    /** 当前的临时目录保留时长：原临时目录归入后仍有文件时，从归入时起按它到期移到废纸篓。 */
    tempRetentionDays: TempRetentionDaysSchema,
  },
  { additionalProperties: false },
);
export type SessionMovePreview = Type.Static<typeof SessionMovePreviewSchema>;

export const SessionMoveResultSchema = Type.Object(
  {
    session: WorkspaceSessionSchema,
    /** 选择移入文件时的结果：已移入的条目数，与未移入（重名或移动失败）的条目；没有移入时为 null。 */
    files: Type.Union([
      Type.Object(
        {
          moved: Type.Integer({ minimum: 0 }),
          skippedTotal: Type.Integer({ minimum: 0 }),
          skipped: EntryNames,
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    /** 原临时目录是否已删除：目录为空（或文件全部移入）时删除，仍有文件时保留。 */
    sourceRemoved: Type.Boolean(),
    /** 原临时目录仍有文件而保留时，从归入时起按这个保留时长到期移到废纸篓（null 为从不清理）。 */
    tempRetentionDays: TempRetentionDaysSchema,
  },
  { additionalProperties: false },
);
export type SessionMoveResult = Type.Static<typeof SessionMoveResultSchema>;

/** 归档前的核对中最多列出的条目名；超出的只计入数量。 */
export const SESSION_ARCHIVE_ENTRY_LIST_LIMIT = 20;

/**
 * 归档前的核对（只读）：会话的工作目录，是临时目录时其中第一层的条目，以及当前的保留时长。
 * 空的临时目录归档时直接删除；有文件时归档确认卡提示一次，按保留时长到期移到废纸篓。
 */
export const SessionArchivePreviewSchema = Type.Object(
  {
    sessionId: WorkspaceSessionIdSchema,
    workingDirectory: WorkingDirectorySchema,
    /** 工作目录是临时目录时其中的条目（按名称排序）；不是临时目录时为 null（不会被清理）。 */
    files: Type.Union([
      Type.Object(
        {
          total: Type.Integer({ minimum: 0 }),
          names: Type.Array(Type.String({ minLength: 1 }), { maxItems: SESSION_ARCHIVE_ENTRY_LIST_LIMIT }),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    tempRetentionDays: TempRetentionDaysSchema,
  },
  { additionalProperties: false },
);
export type SessionArchivePreview = Type.Static<typeof SessionArchivePreviewSchema>;

/**
 * 恢复已归档会话的结果。临时目录在归档期间已到期移到废纸篓时，恢复会重建空的临时目录，
 * 并在 trashedDirectory 中写明何时移走、移到了哪里（原来的文件可以从废纸篓找回）；否则为 null。
 */
export const SessionRestoreResultSchema = Type.Object(
  {
    session: WorkspaceSessionSchema,
    trashedDirectory: Type.Union([
      Type.Object(
        {
          trashedAt: Type.String({ minLength: 1 }),
          /** 目录在废纸篓中的位置。 */
          trashPath: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);
export type SessionRestoreResult = Type.Static<typeof SessionRestoreResultSchema>;

/** 标题去掉首尾空白后才计算长度；全空白视为未填写。 */
export function normalizeWorkspaceSessionTitle(title: string): string | null {
  const normalized = title.trim();
  if (!normalized || normalized.length > WORKSPACE_SESSION_TITLE_MAX_LENGTH) return null;
  return normalized;
}

/** 并排数的可选值；1 栏即聚焦，不单独提供。 */
export const WORKSPACE_PARALLEL_OPTIONS = [2, 3, 4] as const;
export const WORKSPACE_DEFAULT_PARALLEL = 2;
export const WORKSPACE_MAX_PARALLEL = 4;

export const WorkspaceViewModeSchema = Type.Union([Type.Literal('parallel'), Type.Literal('focus')]);
export type WorkspaceViewMode = Type.Static<typeof WorkspaceViewModeSchema>;

/**
 * 工作区现场：并排数、各栏会话（slots[k] 是第 k + 1 栏）、当前会话、并排 / 聚焦、
 * 各并排数下的列宽与工作区条显隐。保存在服务端，按工作区 id 区分；刷新或重启后原样恢复。
 */
export const WorkspaceSceneStateSchema = Type.Object(
  {
    parallelCount: Type.Integer({ minimum: WORKSPACE_PARALLEL_OPTIONS[0], maximum: WORKSPACE_MAX_PARALLEL }),
    /** 已放置的会话；未满时空出的栏按会话列表顺序补位。 */
    slots: Type.Array(WorkspaceSessionIdSchema, { maxItems: WORKSPACE_MAX_PARALLEL }),
    focusedSessionId: Type.Union([WorkspaceSessionIdSchema, Type.Null()]),
    viewMode: WorkspaceViewModeSchema,
    /** 按并排数分别记住的各栏相对宽度；缺省为等宽。 */
    widths: Type.Record(
      Type.String({ pattern: '^[2-4]$' }),
      Type.Array(Type.Number({ exclusiveMinimum: 0 }), { minItems: 2, maxItems: WORKSPACE_MAX_PARALLEL }),
    ),
    barVisible: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type WorkspaceSceneState = Type.Static<typeof WorkspaceSceneStateSchema>;

/** 旧版现场：按展示顺序取前两个并排，split 为左栏占比。读取时升级为栏位现场。 */
export const LegacyWorkspaceSceneStateSchema = Type.Object(
  {
    order: Type.Array(WorkspaceSessionIdSchema),
    focusedSessionId: Type.Union([WorkspaceSessionIdSchema, Type.Null()]),
    viewMode: WorkspaceViewModeSchema,
    split: Type.Number({ minimum: 0, maximum: 1 }),
    barVisible: Type.Boolean(),
  },
);
export type LegacyWorkspaceSceneState = Type.Static<typeof LegacyWorkspaceSceneStateSchema>;

/** 旧版两栏现场沿用原有的并排会话、当前会话、视图与列宽。 */
export function upgradeLegacyWorkspaceScene(legacy: LegacyWorkspaceSceneState): WorkspaceSceneState {
  const split = Math.min(0.95, Math.max(0.05, legacy.split));
  return {
    parallelCount: WORKSPACE_DEFAULT_PARALLEL,
    slots: [...new Set(legacy.order)].slice(0, WORKSPACE_DEFAULT_PARALLEL),
    focusedSessionId: legacy.focusedSessionId,
    viewMode: legacy.viewMode,
    widths: legacy.split === 0.5 ? {} : { [WORKSPACE_DEFAULT_PARALLEL]: [split, 1 - split] },
    barVisible: legacy.barVisible,
  };
}

export const WorkspaceSceneSchema = Type.Object(
  {
    workspaceId: Type.String({ minLength: 1 }),
    scene: WorkspaceSceneStateSchema,
  },
  { additionalProperties: false },
);
export type WorkspaceScene = Type.Static<typeof WorkspaceSceneSchema>;

export const DEFAULT_WORKSPACE_SCENE: WorkspaceSceneState = {
  parallelCount: WORKSPACE_DEFAULT_PARALLEL,
  slots: [],
  focusedSessionId: null,
  viewMode: 'parallel',
  widths: {},
  barVisible: true,
};
