import type { CreateNote, UpdateNoteFields } from '@multivac/contracts';
import type { SqliteNotesRepository } from '../storage/sqlite-notes-repository.js';
import type { WorkbenchEventPublisher } from './workbench-events.js';

export class NotesService {
  constructor(readonly repository: SqliteNotesRepository, private readonly events?: WorkbenchEventPublisher) {}
  list() { return this.repository.list(); }
  get(id: string, revision?: number) { return this.repository.get(id, revision); }
  operation(commandId: string) { return this.repository.operation(commandId); }
  changed(noteId: string) { this.events?.publish({ type: 'notes.changed', noteId }); }
  create(input: CreateNote) {
    const result = this.repository.create(input);
    if (result.changed) this.changed(result.value.id);
    return result.value;
  }
  update(id: string, input: UpdateNoteFields) {
    const result = this.repository.update(id, input);
    if (result.changed) this.changed(id);
    return result.value;
  }
}
