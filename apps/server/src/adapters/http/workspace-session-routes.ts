import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CreateProjectSchema,
  CreateWorkspaceSessionSchema,
  MoveSessionToProjectSchema,
  SessionMovePreviewRequestSchema,
  PROJECT_BODY_LIMIT_BYTES,
  RenameWorkspaceSessionSchema,
  UpdateProjectSchema,
  WorkspaceSceneStateSchema,
  WORKSPACE_SESSION_BODY_LIMIT_BYTES,
  type AssistantApiErrorCode,
  type MoveSessionToProject,
} from '@multivac/contracts';
import { Check } from 'typebox/value';
import {
  WorkspaceSessionService,
  WorkspaceSessionServiceError,
} from '../../application/workspace-session-service.js';
import { AssistantSessionServiceError } from '../../application/assistant-session-service.js';
import { ProjectService, ProjectServiceError } from '../../application/project-service.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

class RequestBodyTooLargeError extends Error {}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(value));
}

function writeError(response: ServerResponse, status: number, code: AssistantApiErrorCode, message: string): void {
  writeJson(response, status, { error: { code, message } });
}

function errorStatus(code: AssistantApiErrorCode): number {
  switch (code) {
    case 'INVALID_REQUEST':
      return 400;
    case 'NOT_FOUND':
      return 404;
    case 'SESSION_ID_CONFLICT':
      return 409;
    case 'COMMAND_STATE_MISMATCH':
      return 422;
    case 'ASSISTANT_SESSION_BINDING_MISMATCH':
    case 'ASSISTANT_SESSION_RECOVERY_FAILED':
    case 'ASSISTANT_SESSION_UNAVAILABLE':
    case 'DEFAULT_MODEL_UNAVAILABLE':
      return 503;
    default:
      return 500;
  }
}

async function readJsonBody(request: IncomingMessage, limitBytes = WORKSPACE_SESSION_BODY_LIMIT_BYTES): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limitBytes) throw new RequestBodyTooLargeError();
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) throw new SyntaxError('empty body');
  return JSON.parse(text);
}

function isJson(request: IncomingMessage): boolean {
  return Boolean(request.headers['content-type']?.toLowerCase().startsWith('application/json'));
}

/** 读取项目接口的 JSON 请求体；不是 JSON 时直接回 415 并返回 undefined。 */
async function readProjectBody(request: IncomingMessage, response: ServerResponse, action: string): Promise<unknown> {
  if (!isJson(request)) {
    writeError(response, 415, 'INVALID_REQUEST', `${action}必须使用 application/json。`);
    return undefined;
  }
  return readJsonBody(request, PROJECT_BODY_LIMIT_BYTES);
}

type SessionAction = 'archive' | 'restore' | 'move-to-project' | 'move-to-project/preview';

/**
 * 解析 `/api/sessions/:id` 与其生命周期操作：`archive`、`restore`、`move-to-project`（归入项目）
 * 与 `move-to-project/preview`（归入前的核对）；id 需 URL 解码。
 */
function sessionPath(pathname: string): { sessionId: string; action: SessionAction | null } | null {
  const match = /^\/api\/sessions\/([^/]+)(?:\/(archive|restore|move-to-project(?:\/preview)?))?$/u.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return { sessionId: decodeURIComponent(match[1]), action: (match[2] as SessionAction | undefined) ?? null };
  } catch {
    return null;
  }
}

/** 解析 `/api/workspaces/:id/scene`。 */
function scenePath(pathname: string): string | null {
  const match = /^\/api\/workspaces\/([^/]+)\/scene$/u.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/**
 * 解析 `/api/projects`、`/api/projects/preview` 与 `/api/projects/:id`。
 * `preview` 只接受 POST（新建前的核对），同名的 GET 按项目 id 读取。
 */
function projectPath(pathname: string): { projectId: string | null } | null {
  if (pathname === '/api/projects') return { projectId: null };
  const match = /^\/api\/projects\/([^/]+)$/u.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return { projectId: decodeURIComponent(match[1]) };
  } catch {
    return null;
  }
}

/**
 * 工作区接口：工作区列表（含项目与目录）、项目（列出、读取、新建前核对、新建、更新）、
 * 会话注册表（列出、新建、改名、归档与恢复、归入项目）与工作区现场。
 */
export function createWorkspaceSessionRequestHandler(service: WorkspaceSessionService, projects: ProjectService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const workspaces = url.pathname === '/api/workspaces';
    const project = projectPath(url.pathname);
    const collection = url.pathname === '/api/sessions';
    const item = collection ? null : sessionPath(url.pathname);
    const sceneWorkspaceId = scenePath(url.pathname);
    if (!workspaces && !project && !collection && !item && sceneWorkspaceId === null) return false;

    try {
      if (workspaces || project) {
        if (workspaces && request.method === 'GET') {
          writeJson(response, 200, projects.listWorkspaces());
        } else if (project?.projectId === null && request.method === 'GET') {
          writeJson(response, 200, projects.listProjects());
        } else if (project?.projectId && request.method === 'GET') {
          writeJson(response, 200, projects.getProject(project.projectId));
        } else if (
          (project?.projectId === null || project?.projectId === 'preview') && request.method === 'POST'
        ) {
          // 新建项目（或新建前的核对）：名称与可选的挂载目录；项目随之带一个同名工作区。
          const preview = project.projectId === 'preview';
          const body = await readProjectBody(request, response, '新建项目');
          if (body === undefined) return true;
          if (!Check(CreateProjectSchema, body)) {
            writeError(response, 400, 'INVALID_REQUEST', '新建项目请求体无效。');
            return true;
          }
          if (preview) writeJson(response, 200, projects.previewProject(body));
          else writeJson(response, 201, projects.createProject(body));
        } else if (project?.projectId && request.method === 'PATCH') {
          // 更新项目：名称、目录（挂载、卸载、主目录）与默认约束，只改给出的字段。
          const body = await readProjectBody(request, response, '更新项目');
          if (body === undefined) return true;
          if (!Check(UpdateProjectSchema, body)) {
            writeError(response, 400, 'INVALID_REQUEST', '更新项目请求体无效。');
            return true;
          }
          writeJson(response, 200, projects.updateProject(project.projectId, body));
        } else {
          writeError(response, 405, 'INVALID_REQUEST', '不支持的请求方法。');
        }
        return true;
      }
      if (sceneWorkspaceId !== null && request.method === 'GET') {
        writeJson(response, 200, service.getScene(sceneWorkspaceId));
        return true;
      }
      if (sceneWorkspaceId !== null && request.method === 'PUT') {
        if (!isJson(request)) {
          writeError(response, 415, 'INVALID_REQUEST', '工作区现场必须使用 application/json。');
          return true;
        }
        const body = await readJsonBody(request);
        if (!Check(WorkspaceSceneStateSchema, body)) {
          writeError(response, 400, 'INVALID_REQUEST', '工作区现场请求体无效。');
          return true;
        }
        writeJson(response, 200, service.saveScene(sceneWorkspaceId, body));
        return true;
      }
      if (sceneWorkspaceId !== null) {
        writeError(response, 405, 'INVALID_REQUEST', '不支持的请求方法。');
        return true;
      }
      if (collection && request.method === 'GET') {
        // `?archived=include` 时一并返回已归档会话；缺省只列未归档会话。
        const archived = url.searchParams.get('archived');
        if (archived !== null && archived !== 'include') {
          writeError(response, 400, 'INVALID_REQUEST', 'archived 只支持 include。');
          return true;
        }
        // `?workspace=<id>` 列出指定工作区，`?workspace=all` 跨全部工作区；缺省为默认工作区。
        const workspace = url.searchParams.get('workspace');
        if (workspace === '') {
          writeError(response, 400, 'INVALID_REQUEST', 'workspace 不能为空。');
          return true;
        }
        writeJson(response, 200, service.list({
          includeArchived: archived === 'include',
          ...(workspace === null ? {} : { workspaceId: workspace === 'all' ? null : workspace }),
        }));
        return true;
      }
      if (collection && request.method === 'POST') {
        if (!isJson(request)) {
          writeError(response, 415, 'INVALID_REQUEST', '新建会话必须使用 application/json。');
          return true;
        }
        const body = await readJsonBody(request);
        if (!Check(CreateWorkspaceSessionSchema, body)) {
          writeError(response, 400, 'INVALID_REQUEST', '新建会话请求体无效。');
          return true;
        }
        const result = await service.create(body);
        writeJson(response, result.created ? 201 : 200, result.session);
        return true;
      }
      if (item && item.action === null && request.method === 'PATCH') {
        if (!isJson(request)) {
          writeError(response, 415, 'INVALID_REQUEST', '会话改名必须使用 application/json。');
          return true;
        }
        const body = await readJsonBody(request);
        if (!Check(RenameWorkspaceSessionSchema, body)) {
          writeError(response, 400, 'INVALID_REQUEST', '会话改名请求体无效。');
          return true;
        }
        writeJson(response, 200, service.rename(item.sessionId, body.title));
        return true;
      }
      if (item && item.action === 'archive' && request.method === 'POST') {
        writeJson(response, 200, service.archive(item.sessionId));
        return true;
      }
      if (item && item.action === 'restore' && request.method === 'POST') {
        writeJson(response, 200, service.restore(item.sessionId));
        return true;
      }
      if (item && (item.action === 'move-to-project' || item.action === 'move-to-project/preview') && request.method === 'POST') {
        // 归入项目（或归入前的核对）：只能由用户在界面的确认卡上确认后经这里完成，不作为 Agent 工具提供。
        const preview = item.action === 'move-to-project/preview';
        if (!isJson(request)) {
          writeError(response, 415, 'INVALID_REQUEST', '归入项目必须使用 application/json。');
          return true;
        }
        const body = await readJsonBody(request);
        if (preview ? !Check(SessionMovePreviewRequestSchema, body) : !Check(MoveSessionToProjectSchema, body)) {
          writeError(response, 400, 'INVALID_REQUEST', '归入项目请求体无效。');
          return true;
        }
        const { projectId } = body as { projectId: string };
        writeJson(response, 200, preview
          ? service.previewMoveToProject(item.sessionId, projectId)
          : await service.moveToProject(item.sessionId, body as MoveSessionToProject));
        return true;
      }
      // 其余 `/api/sessions/:id/...` 路径由会话级接口处理。
      return false;
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        writeError(response, 413, 'BODY_TOO_LARGE', '请求体超过大小限制。');
      } else if (error instanceof SyntaxError) {
        writeError(response, 400, 'INVALID_REQUEST', '请求体不是有效 JSON。');
      } else if (
        error instanceof WorkspaceSessionServiceError || error instanceof AssistantSessionServiceError ||
        error instanceof ProjectServiceError
      ) {
        writeError(response, errorStatus(error.code), error.code, error.message);
      } else {
        writeError(response, 500, 'INTERNAL_ERROR', '服务处理请求时发生内部错误。');
      }
      return true;
    }
  };
}
