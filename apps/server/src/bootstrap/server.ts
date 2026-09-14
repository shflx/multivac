import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AssistantSessionService } from '../application/assistant-session-service.js';
import { createAssistantRequestHandler } from '../adapters/http/assistant-routes.js';

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  try {
    return LOCAL_HOSTNAMES.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && LOCAL_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

function reject(response: ServerResponse, code: 'HOST_NOT_ALLOWED' | 'ORIGIN_NOT_ALLOWED'): void {
  response.writeHead(403, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify({
    error: {
      code,
      message: code === 'HOST_NOT_ALLOWED' ? 'Host 不在本地服务允许范围内。' : 'Origin 不在本地服务允许范围内。',
    },
  }));
}

export interface MultivacHttpServerOptions {
  service: AssistantSessionService;
  bodyLimitBytes?: number;
}

/** 原生 HTTP factory 保持依赖可注入，测试不会触碰真实 Pi 或用户数据。 */
export function createMultivacHttpServer(options: MultivacHttpServerOptions): Server {
  const handleAssistant = createAssistantRequestHandler(options);
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    if (!hostAllowed(request.headers.host)) {
      reject(response, 'HOST_NOT_ALLOWED');
      return;
    }
    const origin = request.headers.origin;
    if (!originAllowed(origin)) {
      reject(response, 'ORIGIN_NOT_ALLOWED');
      return;
    }
    if (origin) {
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-methods': 'GET, PUT, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
      });
      response.end();
      return;
    }

    void handleAssistant(request, response);
  });
}
