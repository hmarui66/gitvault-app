import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

/** A note as it exists on this device. `rev` increases on every local write (by the user or by sync). */
export interface FileRec {
  path: string;
  content: string;
  /** Tombstone: deleted locally, deletion not yet pushed. */
  deleted: boolean;
  mtime: number;
  rev: number;
}

/** The last version of a note both this device and the remote agreed on (the merge base). */
export interface BaseRec {
  path: string;
  sha: string;
  content: string;
}

export interface Config {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  deviceName: string;
  /** Seconds of editing inactivity before an automatic sync. 0 = manual / on-leave only. */
  autoSyncDelaySec: number;
  /** Daily notes: folder, file name format (moment-style tokens), and template note path. */
  dailyFolder?: string;
  dailyFormat?: string;
  dailyTemplatePath?: string;
  /** Token expiry date ("YYYY-MM-DD") as shown by GitHub, for advance warnings. */
  tokenExpiresOn?: string;
}

export interface SyncState {
  lastCommit: string | null;
  lastSyncAt: number | null;
  lastError: string | null;
}

interface Schema extends DBSchema {
  files: { key: string; value: FileRec };
  bases: { key: string; value: BaseRec };
  kv: { key: string; value: unknown };
}

export type DB = IDBPDatabase<Schema>;

const DB_NAME = 'gitvault';
let dbPromise: Promise<DB> | null = null;

export function getDB(): Promise<DB> {
  dbPromise ??= openDB<Schema>(DB_NAME, 1, {
    upgrade(db) {
      db.createObjectStore('files', { keyPath: 'path' });
      db.createObjectStore('bases', { keyPath: 'path' });
      db.createObjectStore('kv');
    },
    // Another context (e.g. Settings wiping data) wants to delete/upgrade: let go of our connection.
    blocking() {
      void dbPromise?.then((db) => db.close());
      dbPromise = null;
    },
  });
  return dbPromise;
}

export async function deleteDatabase(): Promise<void> {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getConfig(): Promise<Config | null> {
  return ((await (await getDB()).get('kv', 'config')) as Config | undefined) ?? null;
}

export async function setConfig(config: Config): Promise<void> {
  await (await getDB()).put('kv', config, 'config');
}

export async function getSyncState(): Promise<SyncState> {
  const s = (await (await getDB()).get('kv', 'syncState')) as SyncState | undefined;
  return s ?? { lastCommit: null, lastSyncAt: null, lastError: null };
}

export async function setSyncState(patch: Partial<SyncState>): Promise<SyncState> {
  const db = await getDB();
  const next = { ...(await getSyncState()), ...patch };
  await db.put('kv', next, 'syncState');
  return next;
}

export type WriteResult = { ok: true; rev: number } | { ok: false; current: FileRec | undefined };

/**
 * Write a note. With `expectedRev`, the write only succeeds if nobody (i.e. sync) has
 * written the note since the caller last read it.
 */
export async function writeFile(path: string, content: string, expectedRev?: number): Promise<WriteResult> {
  const tx = (await getDB()).transaction('files', 'readwrite');
  const cur = await tx.store.get(path);
  const curRev = cur?.rev ?? 0;
  if (expectedRev !== undefined && curRev !== expectedRev) {
    await tx.done;
    return { ok: false, current: cur };
  }
  const rev = curRev + 1;
  await tx.store.put({ path, content, deleted: false, mtime: Date.now(), rev });
  await tx.done;
  return { ok: true, rev };
}

/** Delete a note. Synced notes leave a tombstone so the deletion can be pushed. */
export async function removeFile(path: string): Promise<void> {
  const tx = (await getDB()).transaction(['files', 'bases'], 'readwrite');
  const cur = await tx.objectStore('files').get(path);
  const base = await tx.objectStore('bases').get(path);
  if (base) {
    await tx.objectStore('files').put({ path, content: '', deleted: true, mtime: Date.now(), rev: (cur?.rev ?? 0) + 1 });
  } else {
    await tx.objectStore('files').delete(path);
  }
  await tx.done;
}
