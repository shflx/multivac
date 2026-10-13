import type { CreateNote, UpdateNote } from '@multivac/contracts';
import type { SqliteNotesRepository } from '../storage/sqlite-notes-repository.js';
import type { WorkbenchEventPublisher } from './workbench-events.js';

export class NotesService {
  constructor(readonly repository: SqliteNotesRepository, private readonly events?: WorkbenchEventPublisher) {}
  list() { return this.repository.list(); }
  get(id: string) { return this.repository.get(id); }
  changed(noteId: string) { this.events?.publish({ type: 'notes.changed', noteId }); }
  create(input: CreateNote) {
    const result = this.repository.create(input);
    if (result.changed) this.changed(result.value.id);
    return result.value;
  }
  update(id: string, input: UpdateNote) {
    const result = this.repository.update(id, input);
    if (result.changed) this.changed(id);
    return result.value;
  }
}
