/**
 * In-memory view of the vault for the UI. Edits land in memory immediately and are
 * persisted to IndexedDB after a short debounce, so typing never waits on storage.
 */
import { getDB, removeFile, writeFile } from './db';
import { gitBlobSha } from './gitBlob';
import { merge3 } from './merge';
import { conflictCopyPath, isSyncable } from './paths';

const PERSIST_DELAY_MS = 400;

interface Note {
  content: string;
  /** IndexedDB rev that `persisted` corresponds to. */
  rev: number;
  /** Content as of `rev` (merge base if sync writes underneath an unsaved edit). */
  persisted: string;
}

export type VaultEvent = { type: 'changed' } | { type: 'external'; paths: string[] };

export class Vault {
  private notes = new Map<string, Note>();
  private baseSha = new Map<string, string>();
  private tombstones = new Set<string>();
  private dirtySet = new Set<string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private listeners = new Set<(e: VaultEvent) => void>();
  deviceName = 'device';

  subscribe(fn: (e: VaultEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: VaultEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  /** (Re)load everything from IndexedDB, keeping notes that still have unsaved edits. */
  async load(): Promise<string[]> {
    const db = await getDB();
    const [files, bases] = await Promise.all([db.getAll('files'), db.getAll('bases')]);
    this.baseSha = new Map(bases.map((b) => [b.path, b.sha]));
    this.tombstones = new Set(files.filter((f) => f.deleted).map((f) => f.path));
    const changed: string[] = [];
    const next = new Map<string, Note>();
    for (const f of files) {
      if (f.deleted || !isSyncable(f.path)) continue;
      const old = this.notes.get(f.path);
      if (old && this.timers.has(f.path)) {
        next.set(f.path, old); // persist() will reconcile via its rev check
        continue;
      }
      if (!old || old.rev !== f.rev) changed.push(f.path);
      next.set(f.path, { content: f.content, rev: f.rev, persisted: f.content });
    }
    for (const path of this.notes.keys()) if (!next.has(path)) changed.push(path);
    this.notes = next;
    await this.recomputeDirty();
    if (changed.length) this.emit({ type: 'external', paths: changed });
    this.emit({ type: 'changed' });
    return changed;
  }

  private async recomputeDirty(): Promise<void> {
    const dirty = new Set(this.tombstones);
    for (const [path, n] of this.notes) {
      if (this.timers.has(path) || this.baseSha.get(path) !== (await gitBlobSha(n.content))) dirty.add(path);
    }
    this.dirtySet = dirty;
  }

  paths(): string[] {
    return [...this.notes.keys()].sort((a, b) => a.localeCompare(b));
  }

  has(path: string): boolean {
    return this.notes.has(path);
  }

  read(path: string): string | undefined {
    return this.notes.get(path)?.content;
  }

  /** Number of notes with changes not yet on GitHub. */
  get dirtyCount(): number {
    return this.dirtySet.size;
  }

  write(path: string, content: string): void {
    const note = this.notes.get(path);
    if (note) {
      if (note.content === content) return;
      note.content = content;
    } else {
      this.notes.set(path, { content, rev: 0, persisted: '' });
      this.tombstones.delete(path);
    }
    this.dirtySet.add(path);
    clearTimeout(this.timers.get(path));
    this.timers.set(
      path,
      setTimeout(() => void this.persist(path), PERSIST_DELAY_MS),
    );
    this.emit({ type: 'changed' });
  }

  private async persist(path: string): Promise<void> {
    clearTimeout(this.timers.get(path));
    this.timers.delete(path);
    const note = this.notes.get(path);
    if (!note) return;
    const content = note.content;
    const res = await writeFile(path, content, note.rev);
    if (res.ok) {
      note.rev = res.rev;
      note.persisted = content;
    } else {
      await this.reconcile(path, note, content, res.current?.deleted ? undefined : res.current);
    }
    if (this.baseSha.get(path) === (await gitBlobSha(note.content)) && !this.timers.has(path)) this.dirtySet.delete(path);
    this.emit({ type: 'changed' });
  }

  /** Sync replaced this note while an edit was still in memory: merge, or keep both. */
  private async reconcile(path: string, note: Note, ours: string, current: { content: string; rev: number } | undefined): Promise<void> {
    if (!current) {
      const res = await writeFile(path, ours);
      if (res.ok) Object.assign(note, { rev: res.rev, persisted: ours });
      return;
    }
    const outcome = merge3(note.persisted, ours, current.content);
    if (outcome.clean) {
      const res = await writeFile(path, outcome.text, current.rev);
      if (res.ok) {
        Object.assign(note, { content: outcome.text, rev: res.rev, persisted: outcome.text });
        this.emit({ type: 'external', paths: [path] });
        return;
      }
    }
    Object.assign(note, { content: current.content, rev: current.rev, persisted: current.content });
    const copy = conflictCopyPath(path, this.deviceName, new Date());
    await writeFile(copy, ours);
    this.notes.set(copy, { content: ours, rev: 1, persisted: ours });
    this.dirtySet.add(copy);
    this.emit({ type: 'external', paths: [path, copy] });
  }

  /** Persist all pending edits now (before sync, or when the app goes to the background). */
  async flush(): Promise<void> {
    await Promise.all([...this.timers.keys()].map((p) => this.persist(p)));
  }

  async create(path: string, content = ''): Promise<void> {
    this.write(path, content);
    await this.persist(path);
  }

  async remove(path: string): Promise<void> {
    clearTimeout(this.timers.get(path));
    this.timers.delete(path);
    this.notes.delete(path);
    await removeFile(path);
    if (this.baseSha.has(path)) {
      this.tombstones.add(path);
      this.dirtySet.add(path);
    } else {
      this.dirtySet.delete(path);
    }
    this.emit({ type: 'changed' });
  }

  /** Write many notes at once (overwriting), then refresh; the next sync pushes them as one commit. */
  async importNotes(items: { path: string; content: string }[]): Promise<void> {
    await this.flush();
    for (const item of items) await writeFile(item.path, item.content);
    await this.load();
  }

  async rename(from: string, to: string): Promise<void> {
    const content = this.read(from);
    if (content === undefined || from === to) return;
    await this.create(to, content);
    await this.remove(from);
  }
}

export const vault = new Vault();
