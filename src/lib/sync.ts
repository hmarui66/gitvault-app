/**
 * Sync engine. DOM-free so that both the page and the service worker (Background Sync) can run it.
 *
 * Model: every note has three versions, compared by git blob sha —
 *   base   = last version this device and the remote agreed on (stored in `bases`)
 *   local  = what is in `files` now
 *   remote = what is on the branch head now
 * The usual three-way rules decide pull / push / merge per path, and every local change
 * found in one run goes into a single commit.
 */
import { getConfig, getDB, getSyncState, setSyncState, type BaseRec, type Config, type FileRec } from './db';
import { gitBlobSha } from './gitBlob';
import { GitHub, NonFastForwardError, type GitHubLike, type TreeEntry } from './github';
import { merge3 } from './merge';
import { flushMetrics, record } from './metrics';
import { conflictCopyPath, isSyncable } from './paths';

export const SYNC_CHANNEL = 'gitvault';
export const SYNC_LOCK = 'gitvault-sync';
/** Background Sync tag the page registers and the service worker handles. */
export const BG_SYNC_TAG = 'gitvault-sync';

export interface SyncResult {
  pulled: string[];
  pushed: string[];
  /** Paths of conflict copies created in this run. */
  conflicts: string[];
  commit: string | null;
  /** A local edit raced with this run; another run is needed to finish reconciling. */
  incomplete: boolean;
}

export type SyncMessage = { type: 'synced'; result: SyncResult } | { type: 'sync-error'; message: string };

interface Pull {
  path: string;
  sha: string | null;
  rev: number;
}
interface Push {
  path: string;
  content: string | null;
  sha: string | null;
  /** Local rev the pushed content corresponds to. */
  rev: number;
}
interface Merge {
  path: string;
  base: string;
  local: string;
  localSha: string;
  remoteSha: string;
  rev: number;
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  return locks ? locks.request(SYNC_LOCK, fn) : fn();
}

function broadcast(msg: SyncMessage): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const ch = new BroadcastChannel(SYNC_CHANNEL);
  ch.postMessage(msg);
  ch.close();
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** What started a sync; recorded in metrics. */
export type SyncTrigger = 'startup' | 'idle' | 'hidden' | 'resume' | 'online' | 'manual' | 'import' | 'settings' | 'retry' | 'background';

export interface SyncOptions {
  github?: GitHubLike;
  now?: () => Date;
  trigger?: SyncTrigger;
}

/** Run one full sync (pull + push in a single commit). Serialized across tabs and the service worker. */
export async function runSync(opts: SyncOptions = {}): Promise<SyncResult> {
  return withLock(async () => {
    const cfg = await getConfig();
    if (!cfg) throw new Error('Not configured');
    const gh = opts.github ?? new GitHub(cfg);
    const now = opts.now ?? (() => new Date());
    const trigger = opts.trigger ?? 'manual';
    const started = performance.now();
    const before = { requests: gh.stats?.requests ?? 0, bytes: gh.stats?.bytes ?? 0 };
    const traffic = () => ({
      requests: (gh.stats?.requests ?? 0) - before.requests,
      bytes: (gh.stats?.bytes ?? 0) - before.bytes,
    });
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await syncOnce(gh, cfg, now);
        await setSyncState({ lastSyncAt: Date.now(), lastError: null });
        record('sync', {
          ms: performance.now() - started,
          ok: true,
          attrs: {
            trigger,
            pulled: result.pulled.length,
            pushed: result.pushed.length,
            conflicts: result.conflicts.length,
            retries: attempt,
            ...traffic(),
          },
        });
        await flushMetrics(); // the service worker may be stopped right after this
        broadcast({ type: 'synced', result });
        return result;
      } catch (e) {
        // Someone pushed between our read and our ref update: start over from the new head.
        if (e instanceof NonFastForwardError && attempt < 3) continue;
        const message = e instanceof Error ? e.message : String(e);
        await setSyncState({ lastError: message });
        record('sync', { ms: performance.now() - started, ok: false, attrs: { trigger, error: message.slice(0, 120), ...traffic() } });
        await flushMetrics();
        broadcast({ type: 'sync-error', message });
        throw e;
      }
    }
  });
}

async function syncOnce(gh: GitHubLike, cfg: Config, now: () => Date): Promise<SyncResult> {
  const db = await getDB();
  const files = (await db.getAll('files')).filter((f) => isSyncable(f.path));
  const bases = await db.getAll('bases');
  const state = await getSyncState();

  // --- 1. Remote state -------------------------------------------------------
  let head = await gh.getHead();
  if (head.kind === 'empty') head = { kind: 'ok', sha: await gh.initEmpty() };

  let remoteTree: string | null = null;
  let remote: Map<string, string>;
  if (head.kind === 'missing') {
    remote = new Map();
  } else if (head.sha === state.lastCommit) {
    // Nothing changed remotely since our last consistent sync: bases mirror the remote tree.
    remote = new Map(bases.map((b) => [b.path, b.sha]));
  } else {
    remoteTree = await gh.getCommitTree(head.sha);
    const blobs = await gh.getTree(remoteTree);
    remote = new Map(blobs.filter((b) => isSyncable(b.path)).map((b) => [b.path, b.sha]));
  }

  // --- 2. Plan ---------------------------------------------------------------
  const fileMap = new Map<string, FileRec>(files.map((f) => [f.path, f]));
  const baseMap = new Map<string, BaseRec>(bases.map((b) => [b.path, b]));
  const localSha = new Map<string, string | null>();
  for (const f of files) localSha.set(f.path, f.deleted ? null : await gitBlobSha(f.content));

  const pulls: Pull[] = [];
  const pushes: Push[] = [];
  const merges: Merge[] = [];
  const agreed: { path: string; sha: string; content: string }[] = [];
  const bothDeleted: Pull[] = [];

  for (const path of new Set([...fileMap.keys(), ...baseMap.keys(), ...remote.keys()])) {
    const f = fileMap.get(path);
    const rev = f?.rev ?? 0;
    const b = baseMap.get(path)?.sha ?? null;
    const r = remote.get(path) ?? null;
    const l = f ? localSha.get(path)! : b;
    if (l === b && r === b) continue;
    if (l === b) pulls.push({ path, sha: r, rev });
    else if (r === b) pushes.push({ path, content: f!.deleted ? null : f!.content, sha: l, rev });
    else if (l === r) {
      if (r === null) bothDeleted.push({ path, sha: null, rev });
      else agreed.push({ path, sha: r, content: f!.content });
    } else if (l === null) pulls.push({ path, sha: r, rev }); // deleted here, edited there: keep the edit
    else if (r === null) pushes.push({ path, content: f!.content, sha: l, rev }); // edited here, deleted there
    else merges.push({ path, base: baseMap.get(path)?.content ?? '', local: f!.content, localSha: l, remoteSha: r, rev });
  }

  // --- 3. Download what we need ---------------------------------------------
  const needed = [...new Set([...pulls.map((p) => p.sha), ...merges.map((m) => m.remoteSha)].filter((s): s is string => !!s))];
  const blobs = new Map<string, string>();
  await mapLimit(needed, 6, async (sha) => blobs.set(sha, await gh.getBlob(sha)));

  // Merge outcomes and their hashes are computed up front: IndexedDB transactions
  // auto-commit if we await anything else (like crypto.subtle) inside them.
  const date = now();
  const mergePlans = await Promise.all(
    merges.map(async (m) => {
      const remoteContent = blobs.get(m.remoteSha)!;
      const outcome = merge3(m.base, m.local, remoteContent);
      if (outcome.clean) return { m, remoteContent, merged: outcome.text, mergedSha: await gitBlobSha(outcome.text) };
      return { m, remoteContent, merged: null, mergedSha: null, copyPath: conflictCopyPath(m.path, cfg.deviceName, date) };
    }),
  );

  // --- 4. Apply remote changes locally (compare-and-set on rev) -------------
  const pulled: string[] = [];
  const conflicts: string[] = [];
  let incomplete = false;
  {
    const tx = db.transaction(['files', 'bases'], 'readwrite');
    const fs = tx.objectStore('files');
    const bs = tx.objectStore('bases');
    const t = date.getTime();
    for (const p of pulls) {
      const cur = await fs.get(p.path);
      if ((cur?.rev ?? 0) !== p.rev) {
        incomplete = true; // edited while we were downloading; reconcile next run
        continue;
      }
      if (p.sha === null) {
        await fs.delete(p.path);
        await bs.delete(p.path);
      } else {
        const content = blobs.get(p.sha)!;
        await fs.put({ path: p.path, content, deleted: false, mtime: t, rev: (cur?.rev ?? 0) + 1 });
        await bs.put({ path: p.path, sha: p.sha, content });
      }
      pulled.push(p.path);
    }
    for (const a of agreed) await bs.put(a);
    for (const d of bothDeleted) {
      await bs.delete(d.path);
      const cur = await fs.get(d.path);
      if (cur?.deleted && cur.rev === d.rev) await fs.delete(d.path);
    }
    for (const plan of mergePlans) {
      const { m, remoteContent } = plan;
      const cur = await fs.get(m.path);
      if ((cur?.rev ?? 0) !== m.rev) {
        incomplete = true;
        continue;
      }
      const rev = m.rev + 1;
      await bs.put({ path: m.path, sha: m.remoteSha, content: remoteContent });
      if (plan.merged !== null) {
        await fs.put({ path: m.path, content: plan.merged, deleted: false, mtime: t, rev });
        pushes.push({ path: m.path, content: plan.merged, sha: plan.mergedSha, rev });
        pulled.push(m.path);
      } else {
        // Unresolvable: the remote version wins the original path, ours is kept beside it.
        await fs.put({ path: m.path, content: remoteContent, deleted: false, mtime: t, rev });
        await fs.put({ path: plan.copyPath!, content: m.local, deleted: false, mtime: t, rev: 1 });
        pushes.push({ path: plan.copyPath!, content: m.local, sha: m.localSha, rev: 1 });
        pulled.push(m.path);
        conflicts.push(plan.copyPath!);
      }
    }
    await tx.done;
  }

  // --- 5. Push all local changes as one commit ------------------------------
  let commit: string | null = head.kind === 'ok' ? head.sha : null;
  if (pushes.length > 0) {
    const entries: TreeEntry[] = pushes.map((p) => ({ path: p.path, content: p.content }));
    const message = commitMessage(pushes, cfg.deviceName);
    if (head.kind === 'missing') {
      const tree = await gh.createTree(null, entries.filter((e) => e.content !== null));
      commit = await gh.createCommit(message, tree, []);
      await gh.createRef(commit);
    } else {
      const tree = await gh.createTree(remoteTree ?? (await gh.getCommitTree(head.sha)), entries);
      commit = await gh.createCommit(message, tree, [head.sha]);
      await gh.updateRef(commit);
    }

    const tx = db.transaction(['files', 'bases'], 'readwrite');
    const fs = tx.objectStore('files');
    const bs = tx.objectStore('bases');
    for (const p of pushes) {
      if (p.content === null) {
        await bs.delete(p.path);
        const cur = await fs.get(p.path);
        if (cur?.deleted && cur.rev === p.rev) await fs.delete(p.path);
      } else {
        await bs.put({ path: p.path, sha: p.sha!, content: p.content });
      }
    }
    await tx.done;
  }

  // If anything was skipped, bases no longer mirror `commit`; force a full tree comparison next time.
  await setSyncState({ lastCommit: incomplete ? null : commit });
  return { pulled, pushed: pushes.map((p) => p.path), conflicts, commit, incomplete };
}

function commitMessage(pushes: Push[], device: string): string {
  const summary = pushes.length === 1 ? pushes[0].path : `${pushes.length} notes`;
  const body = pushes.map((p) => `${p.content === null ? 'D' : 'M'} ${p.path}`).join('\n');
  return `vault: update ${summary} from ${device}\n\n${body}\n`;
}
