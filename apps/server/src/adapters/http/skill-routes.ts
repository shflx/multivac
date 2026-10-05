import type { IncomingMessage, ServerResponse } from 'node:http';
import { Check } from 'typebox/value';
import { SkillImportSchema, SkillConfirmSchema, SkillStateSchema, SkillPreferenceSchema } from '@multivac/contracts';
import type { SkillService } from '../../application/skill-service.js';
import { SkillError } from '../../modules/skills/skill-package.js';

export function createSkillRequestHandler(service: SkillService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/skills')) return false;
    const send = (status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };
    try {
      if (request.method === 'GET' && url.pathname === '/api/skills') { send(200, service.list()); return true; }
      if (request.method === 'GET' && url.pathname === '/api/skills/catalog') {
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) throw new SkillError('需要会话身份。');
        send(200,service.catalog(service.context(sessionId))); return true;
      }
      if (request.method === 'GET' && url.pathname === '/api/skills/preference') { send(200,service.preference(url.searchParams.get('skillId') ?? '',url.searchParams.get('projectId'),url.searchParams.get('sessionId'))); return true; }
      const detail = /^\/api\/skills\/([^/]+)$/u.exec(url.pathname);
      if (request.method === 'GET' && detail) { send(200, service.detail(decodeURIComponent(detail[1]!), url.searchParams.get('version') ?? undefined)); return true; }
      if (request.method !== 'POST') throw new SkillError('不支持的 Skill 操作。', 405);
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 16384) throw new SkillError('请求过大。', 413); chunks.push(bytes); }
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (url.pathname === '/api/skills/preview' && Check(SkillImportSchema, input)) send(200, service.preview(input));
      else if (url.pathname === '/api/skills/confirm' && Check(SkillConfirmSchema, input)) send(200, service.confirm(input.commandId, input.previewId));
      else if (url.pathname === '/api/skills/preference' && Check(SkillPreferenceSchema,input)) send(200,service.setPreference(input));
      else if (url.pathname === '/api/skills/state' && Check(SkillStateSchema, input)) send(200, service.state(input));
      else throw new SkillError('Skill 请求参数无效。');
    } catch (error) {
      const status = error instanceof SkillError ? error.status : error instanceof SyntaxError ? 400 : 500;
      send(status, { error: { message: status === 500 ? 'Skill 读取或保存失败，请检查来源后重试。' : (error as Error).message } });
    }
    return true;
  };
}
