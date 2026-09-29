import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DecideProposalSchema,
  GLOBAL_ASSISTANT_SESSION_ID,
  type AssistantApiErrorCode,
  type ProposalDecisionResponse,
  type ProposalListResponse,
} from '@multivac/contracts';
import { Check } from 'typebox/value';
import { ProposalService, ProposalServiceError } from '../../application/proposals/proposal-service.js';
import { requestOrigin } from './window-origin.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};
const DECISION_BODY_LIMIT_BYTES = 1024;

class RequestBodyTooLargeError extends Error {}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(value));
}

function writeError(response: ServerResponse, status: number, code: AssistantApiErrorCode, message: string): void {
  writeJson(response, status, { error: { code, message } });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > DECISION_BODY_LIMIT_BYTES) throw new RequestBodyTooLargeError();
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) throw new SyntaxError('empty body');
  return JSON.parse(text);
}

/** `/api/assistant/proposals`（列表）与 `/api/assistant/proposals/:id/decision`（确认或取消）。 */
function proposalRoute(pathname: string): { proposalId: string | null } | null {
  const match = /^\/api\/assistant\/proposals(?:\/([^/]+)\/decision)?$/u.exec(pathname);
  if (!match) return null;
  try {
    return { proposalId: match[1] ? decodeURIComponent(match[1]) : null };
  } catch {
    return null;
  }
}

/**
 * 全局 Multivac 对话内的提议：查询（含历史）与用户的决定（确认或取消，按提议 id 幂等）。
 * 决定只能由用户经界面（或直接调用本地接口）提交：它不是 Agent 可调用的工具，内部工具拿不到它，
 * 对话内容、引用与工具返回都不会触发它。
 */
export function createProposalRequestHandler(service: ProposalService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const route = proposalRoute(url.pathname);
    if (!route) return false;

    try {
      if ([...url.searchParams.keys()].length > 0) {
        writeError(response, 400, 'INVALID_REQUEST', '提议接口不接受查询参数。');
        return true;
      }
      if (route.proposalId === null) {
        if (request.method !== 'GET') {
          writeError(response, 404, 'NOT_FOUND', '接口不存在。');
          return true;
        }
        const body: ProposalListResponse = { proposals: service.list(GLOBAL_ASSISTANT_SESSION_ID) };
        writeJson(response, 200, body);
        return true;
      }

      if (request.method !== 'POST') {
        writeError(response, 404, 'NOT_FOUND', '接口不存在。');
        return true;
      }
      if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
        writeError(response, 415, 'INVALID_REQUEST', '提议的决定必须使用 application/json。');
        return true;
      }
      const body = await readJsonBody(request);
      if (!Check(DecideProposalSchema, body)) {
        writeError(response, 400, 'INVALID_REQUEST', '提议的决定无效。');
        return true;
      }
      const result: ProposalDecisionResponse = {
        proposal: await service.decide(
          GLOBAL_ASSISTANT_SESSION_ID, route.proposalId, body.decision, requestOrigin(request), body.options,
        ),
      };
      writeJson(response, 200, result);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        writeError(response, 413, 'BODY_TOO_LARGE', '请求体超过大小限制。');
      } else if (error instanceof SyntaxError) {
        writeError(response, 400, 'INVALID_REQUEST', '请求体不是有效 JSON。');
      } else if (error instanceof ProposalServiceError) {
        const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'INVALID_REQUEST' ? 400 : 409;
        writeError(response, status, error.code, error.message);
      } else {
        writeError(response, 500, 'INTERNAL_ERROR', '服务处理请求时发生内部错误。');
      }
    }
    return true;
  };
}
