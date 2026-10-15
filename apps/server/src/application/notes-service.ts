import type { CreateNote, UpdateNoteFields, DeleteNote } from '@multivac/contracts';
import type { SqliteNotesRepository } from '../storage/sqlite-notes-repository.js';
import type { WorkbenchEventPublisher } from './workbench-events.js';

export class NotesService {
  private deletion?: { check(id: string): void; release(id: string): void };
  setDeletionLifecycle(lifecycle: { check(id: string): void; release(id: string): void }) { this.deletion = lifecycle; }
  constructor(readonly repository: SqliteNotesRepository, private readonly events?: WorkbenchEventPublisher) {}
  list() { return this.repository.list(); }
  summary(id: string) { return this.repository.summary(id); }
  get(id: string, revision?: number) { return this.repository.get(id, revision); }
  versions(id: string, before?: number, limit?: number) { return this.repository.versions(id, before, limit); }
  operation(commandId: string) { return this.repository.operation(commandId); }
  changed(noteId: string) { this.events?.publish({ type: 'notes.changed', noteId }); }
  create(input: CreateNote) {
    const result = this.repository.create(input);
    if (result.changed) this.changed(result.value.id);
    return result.value;
  }
  remove(id: string, input: DeleteNote) {
    const result = this.repository.remove(id, input, () => this.deletion?.check(id));
    if (result.changed) this.changed(id);
    this.deletion?.release(id);
    return result.value;
  }
  update(id: string, input: UpdateNoteFields) {
    const result = this.repository.update(id, input);
    if (result.changed) this.changed(id);
    return result.value;
  }
}
