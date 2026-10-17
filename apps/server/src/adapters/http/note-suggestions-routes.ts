import type { IncomingMessage, ServerResponse } from 'node:http';
import { Check } from 'typebox/value';
import { ImportNoteSuggestionsSchema, DecideNoteSuggestionSchema } from '@multivac/contracts';
import type { NoteSuggestionsService } from '../../application/note-suggestions-service.js';
import { NotesError } from '../../modules/notes/note.js';
import { readNotesInput, notesResponse, notesFailure } from './notes-routes.js';

export function createNoteSuggestionsRequestHandler(service: NoteSuggestionsService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const match = /^\/api\/notes\/([^/]+)\/suggestions(?:\/([^/]+))?$/u.exec(url.pathname);
    if (!match) return false;
    try {
      const id = decodeURIComponent(match[1]!);
      if (request.method === 'GET' && !match[2]) notesResponse(response, 200, { suggestions: service.list(id, url.searchParams.get('sessionId') ?? undefined) });
      else if (request.method === 'POST' && !match[2]) {
        const input = await readNotesInput(request);
        if (!Check(ImportNoteSuggestionsSchema, input)) throw new NotesError('生成建议来源参数无效。');
        notesResponse(response, 200, { suggestions: await service.import(id, input) });
      } else if (request.method === 'POST' && match[2]) {
        const input = await readNotesInput(request);
        if (!Check(DecideNoteSuggestionSchema, input)) throw new NotesError('建议处理参数无效。');
        notesResponse(response, 200, service.decide(id, decodeURIComponent(match[2]), input));
      } else throw new NotesError('不支持的建议操作。', 405);
    } catch (error) { notesFailure(response, error); }
    return true;
  };
}
