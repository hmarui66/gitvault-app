/**
 * Local-only metrics for app operations and background work.
 *
 * Bounded by design, in two tiers:
 *  - raw events: recent detail, capped by count (RAW_MAX) and age (RAW_MAX_AGE_MS)
 *  - daily rollups: one row per (day, metric) with counts/durations/sums, kept for ROLLUP_DAYS
 * High-frequency metrics (AGGREGATE_ONLY) are summed in memory and only touch rollups.
 *
 * Battery: recording never wakes the device. There are no intervals; writes happen at most
 * once per FLUSH_DELAY_MS while the app is in use, plus piggybacked on moments that already
 * do work (app hidden, end of a sync). Retention pruning runs at most once per PRUNE_INTERVAL_MS.
 * Stored in a separate IndexedDB database so metrics can never interfere with notes.
 * No note paths or content are recorded.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export const RAW_MAX = 500;
export const RAW_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
export const ROLLUP_DAYS = 90;
const AGGREGATE_ONLY = new Set(['note.save']);
const FLUSH_DELAY_MS = 60_000;
const FLUSH_BATCH = 50;
const PRUNE_INTERVAL_MS = 3600_000;

export type Attrs = Record<string, string | number>;

export interface MetricEvent {
  id?: number;
  t: number;
  name: string;
  src: 'page' | 'sw';
  ms?: number;
  ok?: boolean;
  attrs?: Attrs;
}

export interface DailyRollup {
  key: string;
  day: string;
  name: string;
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  /** Sums of numeric attributes (e.g. pushed notes, requests, bytes). */
  sums: Record<string, number>;
}

interface Schema extends DBSchema {
  events: { key: number; value: MetricEvent };
  daily: { key: string; value: DailyRollup };
}

const DB_NAME = 'gitvault-metrics';
let dbPromise: Promise<IDBPDatabase<Schema>> | null = null;

function getMetricsDB(): Promise<IDBPDatabase<Schema>> {
  dbPromise ??= openDB<Schema>(DB_NAME, 1, {
    upgrade(db) {
      db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
      db.createObjectStore('daily', { keyPath: 'key' });
    },
    blocking() {
      void dbPromise?.then((db) => db.close());
      dbPromise = null;
    },
  });
  return dbPromise;
}

const SRC: MetricEvent['src'] = typeof window === 'undefined' ? 'sw' : 'page';
const buffer: MetricEvent[] = [];
/** In-memory partial rollups for AGGREGATE_ONLY metrics, merged into the DB on flush. */
const pending = new Map<string, DailyRollup>();
let timer: ReturnType<typeof setTimeout> | undefined;
let lastPrune = 0;

function emptyRollup(day: string, name: string): DailyRollup {
  return { key: `${day}|${name}`, day, name, count: 0, errors: 0, totalMs: 0, maxMs: 0, sums: {} };
}

function accumulate(r: DailyRollup, e: Pick<MetricEvent, 'ms' | 'ok' | 'attrs'>, count = 1): void {
  r.count += count;
  if (e.ok === false) r.errors++;
  if (e.ms !== undefined) {
    r.totalMs += e.ms;
    r.maxMs = Math.max(r.maxMs, e.ms);
  }
  for (const [k, v] of Object.entries(e.attrs ?? {})) if (typeof v === 'number') r.sums[k] = (r.sums[k] ?? 0) + v;
}

function merge(into: DailyRollup, from: DailyRollup): void {
  into.count += from.count;
  into.errors += from.errors;
  into.totalMs += from.totalMs;
  into.maxMs = Math.max(into.maxMs, from.maxMs);
  for (const [k, v] of Object.entries(from.sums)) into.sums[k] = (into.sums[k] ?? 0) + v;
}

export function dayKey(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Record a metric. Buffered in memory and written in batches; never throws. */
export function record(name: string, data: { ms?: number; ok?: boolean; attrs?: Attrs } = {}): void {
  const e: MetricEvent = { t: Date.now(), name, src: SRC, ...data };
  if (e.ms !== undefined) e.ms = Math.round(e.ms);
  if (AGGREGATE_ONLY.has(name)) {
    const day = dayKey(e.t);
    const key = `${day}|${name}`;
    let r = pending.get(key);
    if (!r) pending.set(key, (r = emptyRollup(day, name)));
    accumulate(r, e);
  } else {
    buffer.push(e);
  }
  if (buffer.length >= FLUSH_BATCH) void flushMetrics();
  // One-shot and only while the app is running: it never wakes a sleeping device.
  else timer ??= setTimeout(() => void flushMetrics(), FLUSH_DELAY_MS);
}

/** Write buffered metrics and enforce retention. Call before the context may be suspended. */
export async function flushMetrics(): Promise<void> {
  clearTimeout(timer);
  timer = undefined;
  const batch = buffer.splice(0);
  const partials = [...pending.values()];
  pending.clear();
  if (!batch.length && !partials.length) return;
  try {
    const db = await getMetricsDB();
    const tx = db.transaction(['events', 'daily'], 'readwrite');
    const events = tx.objectStore('events');
    const daily = tx.objectStore('daily');
    // Fold this batch into per-day rollups in memory, then do one read+write per touched row.
    const touched = new Map<string, DailyRollup>();
    const rollupFor = (day: string, name: string) => {
      const key = `${day}|${name}`;
      let r = touched.get(key);
      if (!r) touched.set(key, (r = emptyRollup(day, name)));
      return r;
    };
    for (const e of batch) {
      await events.add(e);
      accumulate(rollupFor(dayKey(e.t), e.name), e);
    }
    for (const p of partials) merge(rollupFor(p.day, p.name), p);
    for (const r of touched.values()) {
      const stored = await daily.get(r.key);
      if (stored) merge(stored, r);
      await daily.put(stored ?? r);
    }

    const now = Date.now();
    if (now - lastPrune < PRUNE_INTERVAL_MS) {
      await tx.done;
      return;
    }
    lastPrune = now;
    // Retention: oldest raw events first (ids grow with time), then rollups older than ROLLUP_DAYS.
    // Between prunes the raw log can exceed RAW_MAX by at most an hour's worth of events.
    let total = await events.count();
    let cursor = await events.openCursor();
    while (cursor && (total > RAW_MAX || cursor.value.t < now - RAW_MAX_AGE_MS)) {
      await cursor.delete();
      total--;
      cursor = await cursor.continue();
    }
    // Keys are "YYYY-MM-DD|name", so every key of an older day sorts below the cutoff day.
    await daily.delete(IDBKeyRange.upperBound(dayKey(now - ROLLUP_DAYS * 24 * 3600 * 1000), true));
    await tx.done;
  } catch {
    // Metrics are best-effort; losing a batch is acceptable.
  }
}

export async function recentEvents(limit = 100): Promise<MetricEvent[]> {
  const out: MetricEvent[] = [];
  let cursor = await (await getMetricsDB()).transaction('events').store.openCursor(null, 'prev');
  while (cursor && out.length < limit) {
    out.push(cursor.value);
    cursor = await cursor.continue();
  }
  return out;
}

export async function dailyRollups(): Promise<DailyRollup[]> {
  return (await getMetricsDB()).getAll('daily');
}

export async function metricsStorage(): Promise<{ events: number; rollups: number }> {
  const db = await getMetricsDB();
  return { events: await db.count('events'), rollups: await db.count('daily') };
}

/** For tests: make the next flush prune regardless of the hourly throttle. */
export function resetPruneThrottle(): void {
  lastPrune = 0;
}

export async function clearMetrics(): Promise<void> {
  buffer.length = 0;
  pending.clear();
  const db = await getMetricsDB();
  await Promise.all([db.clear('events'), db.clear('daily')]);
}

export async function deleteMetricsDatabase(): Promise<void> {
  buffer.length = 0;
  pending.clear();
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
