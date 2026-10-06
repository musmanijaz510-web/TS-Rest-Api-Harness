// In-memory store. Insertion order is the stable order cursors page over.
import type { Note } from './schema.ts';

const notes = new Map<string, Note>();

export const listNotes = (): Note[] => [...notes.values()];
export const findNote = (id: string): Note | undefined => notes.get(id);
export const saveNote = (note: Note): Note => {
  notes.set(note.id, note);
  return note;
};
export const deleteNote = (id: string): boolean => notes.delete(id);
export const resetNotes = (): void => notes.clear();
