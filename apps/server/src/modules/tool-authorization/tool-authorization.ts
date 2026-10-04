import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  AssistantPublicEvent,
  ToolAuthorizationAccess,
  ToolAuthorizationGrant,
  ToolAuthorizationRequest,
  ToolAuthorizationStatus,
} from '@multivac/contracts';
import { isPathWithin } from '../sessions/working-directory.js';

/** 请求离开待授权后的状态。 */
export type ResolvedToolAuthorizationStatus = Exclude<ToolAuthorizationStatus, 'pending'>;

/** 新建授权请求所需的字段；状态总是从待授权开始。 */
export type NewToolAuthorizationRequest = Omit<ToolAuthorizationRequest, 'status' | 'decidedAt' | 'approval'>;

/** 用户选择“本会话内 / 本项目内”时新记住的授权；范围取自请求中保存的 remember。 */
export type NewToolAuthorizationGrant = Pick<
  ToolAuthorizationGrant,
  'grantId' | 'scope' | 'sessionId' | 'projectId' | 'access' | 'directory' | 'sourceRequestId' | 'createdAt'
>;

/**
 * 用户批准时的范围：仅这一次不记住；本会话内、本项目内同时写入记住的授权。
 * 同一范围、类别与目录已有仍有效的授权时沿用那一条，不重复记住。
 */
export type ToolAuthorizationUserApproval =
  | { scope: 'once' }
  | { scope: 'session' | 'project'; grant: NewToolAuthorizationGrant };

/**
 * 请求的写入与对应公共事件在同一个 SQLite 事务中提交；
 * event 为 null 表示这次调用没有改变请求（例如请求早已离开待授权）。
 */
export interface ToolAuthorizationMutation {
  request: ToolAuthorizationRequest;
  event: AssistantPublicEvent | null;
}

/** 查找记住的授权时的依据：谁（会话与其所属项目）以哪类工具访问哪个真实路径。 */
export interface ToolAuthorizationGrantQuery {
  sessionId: string;
  /** 会话当前所属的项目；不属于项目时为 null，项目范围的授权不参与匹配。 */
  projectId: string | null;
  access: ToolAuthorizationAccess;
  /** 边界判定解析出的真实绝对路径。 */
  targetPath: string;
}

export interface ToolAuthorizationRepository {
  get(requestId: string): ToolAuthorizationRequest | undefined;
  all?(): ToolAuthorizationRequest[];
  /** 会话的全部请求（含历史），按创建顺序。 */
  listBySession(sessionId: string): ToolAuthorizationRequest[];
  /** 最近的请求，最近的在前；给出会话时只取这个会话的，否则跨全部会话。 */
  listRecent(limit: number, sessionId?: string): ToolAuthorizationRequest[];
  /** 写入待授权请求，并追加 assistant.authorization.requested 事件。 */
  create(request: NewToolAuthorizationRequest): ToolAuthorizationMutation;
  /**
   * 按已记住的授权放行：直接写入一条已批准（来源为记住的授权）的请求，更新该授权的使用记录，
   * 只追加 assistant.authorization.resolved 事件，不经过待授权，不会出现授权卡。
   */
  createRemembered(request: NewToolAuthorizationRequest, grantId: string): ToolAuthorizationMutation;
  /**
   * 只有仍待授权的请求才会转为 status，并追加 assistant.authorization.resolved 事件；
   * 请求已离开待授权时原样返回、不追加事件。批准必须给出 approval（记住的授权在同一事务中写入）。
   * 请求不存在时抛错。
   */
  resolve(
    requestId: string,
    status: ResolvedToolAuthorizationStatus,
    decidedAt: string,
    approval?: ToolAuthorizationUserApproval,
  ): ToolAuthorizationMutation;
  /** 把全部待授权请求置为已失效，返回每条请求的变更；用于启动对账。 */
  invalidatePending(decidedAt: string): ToolAuthorizationMutation[];

  /** 匹配的第一条仍有效的授权：会话范围优先于项目范围，同范围内先记住的优先。 */
  findGrant(query: ToolAuthorizationGrantQuery): ToolAuthorizationGrant | undefined;
  /** 仍有效的授权，最近记住的在前。 */
  listGrants(): ToolAuthorizationGrant[];
  getGrant(grantId: string): ToolAuthorizationGrant | undefined;
  /** 撤销仍有效的授权；已撤销的保持原撤销时间。授权不存在时返回 undefined。 */
  revokeGrant(grantId: string, revokedAt: string): ToolAuthorizationGrant | undefined;
  /** 仅供 E2E 重置：删除全部记住的授权。 */
  deleteAllGrantsForTest(): void;
}

/**
 * 记住的授权不得覆盖的位置：用户主目录、工作文件根目录与内部数据目录。
 * 放行目录等于或包含其中任一个，或位于内部数据目录之中时，这次请求不能记住，只能单次批准。
 */
export interface RememberBoundary {
  homeDir: string;
  workRoot: string;
  dataDir: string;
}

/** 路径的字面形式与真实形式（跟随符号链接；不存在时只有字面形式）。 */
function pathForms(path: string): string[] {
  const literal = resolve(path);
  try {
    const real = realpathSync.native(literal);
    return real === literal ? [literal] : [literal, real];
  } catch {
    return [literal];
  }
}

/** 启动时算好的保护位置；目录可能经符号链接，字面与真实形式都参与比较。 */
export interface RememberGuard {
  /** 放行目录不得等于或包含的位置。 */
  covered: readonly string[];
  /** 放行目录不得位于其中的位置。 */
  internal: readonly string[];
}

export function rememberGuard(boundary: RememberBoundary): RememberGuard {
  return {
    covered: [boundary.homeDir, boundary.workRoot, boundary.dataDir].flatMap(pathForms),
    internal: pathForms(boundary.dataDir),
  };
}

/**
 * 这次访问可以记住的放行目录：目标（边界判定解析出的真实路径）所在的目录，含其中的子目录。
 * 为保守起见，目录是文件系统根目录、等于或包含用户主目录 / 工作文件根目录 / 内部数据目录，
 * 或位于内部数据目录之中时返回 null——这样的范围过大或涉及 Multivac 自身数据，只能单次批准。
 */
export function rememberableDirectory(targetPath: string, guard: RememberGuard): string | null {
  const directory = dirname(targetPath);
  if (dirname(directory) === directory) return null;
  if (guard.covered.some((path) => isPathWithin(directory, path))) return null;
  if (guard.internal.some((path) => isPathWithin(path, directory))) return null;
  return directory;
}

/**
 * 记住的授权是否覆盖这次访问：仍有效、类别相同、范围所指的会话或项目正是发起访问的会话或其当前项目，
 * 且目标的真实路径按路径段位于放行目录之内（同前缀的兄弟目录不算）。
 * 目标路径由边界判定跟随符号链接并消去 `..` 后给出，所以经链接或 `..` 指向目录外的访问不会被覆盖。
 */
export function grantCovers(grant: ToolAuthorizationGrant, query: ToolAuthorizationGrantQuery): boolean {
  if (grant.revokedAt !== null || grant.access !== query.access) return false;
  const owner = grant.scope === 'session'
    ? grant.sessionId === query.sessionId
    : query.projectId !== null && grant.projectId === query.projectId;
  return owner && isPathWithin(grant.directory, query.targetPath);
}
