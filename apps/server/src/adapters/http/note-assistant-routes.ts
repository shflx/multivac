import type { IncomingMessage, ServerResponse } from 'node:http';
import { Check } from 'typebox/value';
import { PrepareNoteContextSchema, CreateNoteDiscussionSchema } from '@multivac/contracts';
import type { NoteAssistantService } from '../../application/note-assistant-service.js';
import { NotesError } from '../../modules/notes/note.js';
import { readNotesInput, notesResponse, notesFailure } from './notes-routes.js';

export function createNoteAssistantRequestHandler(service: NoteAssistantService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const match = /^\/api\/notes\/([^/]+)\/(companion|contexts|discussions)$/u.exec(path);
    if (!match) return false;
    try {
      const id = decodeURIComponent(match[1]!);
      if (request.method === 'POST' && match[2] === 'companion') notesResponse(response, 200, service.ensureRoot(id));
      else if (request.method === 'GET' && match[2] === 'discussions') notesResponse(response, 200, { discussions: service.discussions(id) });
      else if (request.method === 'POST' && match[2] === 'contexts') {
        const input = await readNotesInput(request);
        if (!Check(PrepareNoteContextSchema, input)) throw new NotesError('笔记上下文参数无效。');
        notesResponse(response, 200, service.prepare(id, input));
      } else if (request.method === 'POST' && match[2] === 'discussions') {
        const input = await readNotesInput(request);
        if (!Check(CreateNoteDiscussionSchema, input)) throw new NotesError('分层讨论参数无效。');
        notesResponse(response, 200, await service.createDiscussion(id, input));
      } else throw new NotesError('不支持的笔记讨论操作。', 405);
    } catch (error) { notesFailure(response, error); }
    return true;
  };
}
