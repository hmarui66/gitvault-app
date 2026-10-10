import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearMetrics,
  dailyRollups,
  dayKey,
  flushMetrics,
  metricsStorage,
  RAW_MAX,
  recentEvents,
  record,
  resetPruneThrottle,
  ROLLUP_DAYS,
} from '../src/lib/metrics';

const DAY = 86400_000;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 10, 12, 0));
  await clearMetrics();
  resetPruneThrottle();
});
afterEach(() => vi.useRealTimers());

describe('metrics', () => {
  it('rolls events up per day and keeps them as raw events', async () => {
    record('sync', { ms: 100, ok: true, attrs: { trigger: 'idle', pushed: 2, requests: 4 } });
    record('sync', { ms: 300, ok: false, attrs: { trigger: 'online', requests: 1 } });
    await flushMetrics();
    const [r] = await dailyRollups();
    expect(r).toMatchObject({ day: '2026-10-10', name: 'sync', count: 2, errors: 1, totalMs: 400, maxMs: 300 });
    expect(r.sums).toEqual({ pushed: 2, requests: 5 });
    expect((await recentEvents()).map((e) => e.attrs?.trigger)).toEqual(['online', 'idle']);
  });

  it('keeps high-frequency saves out of the raw log and accumulates them in memory', async () => {
    for (let i = 0; i < 200; i++) record('note.save', { ms: 2, ok: true });
    expect(await metricsStorage()).toEqual({ events: 0, rollups: 0 }); // nothing written yet
    await flushMetrics();
    expect(await metricsStorage()).toEqual({ events: 0, rollups: 1 });
    record('note.save', { ms: 5 });
    await flushMetrics();
    const [r] = await dailyRollups();
    expect(r).toMatchObject({ name: 'note.save', count: 201, maxMs: 5 });
  });

  it('flushing with nothing recorded does not touch the database', async () => {
    await flushMetrics();
    expect(await metricsStorage()).toEqual({ events: 0, rollups: 0 });
  });

  it('caps raw events by count', async () => {
    for (let i = 0; i < RAW_MAX + 30; i++) {
      record('note.open');
      if (i % 40 === 0) await flushMetrics(); // stay under the auto-flush batch size
    }
    resetPruneThrottle();
    await flushMetrics();
    expect((await metricsStorage()).events).toBe(RAW_MAX);
  });

  it('drops raw events older than 7 days and rollups older than the retention window', async () => {
    vi.setSystemTime(Date.now() - (ROLLUP_DAYS + 5) * DAY);
    record('note.open');
    await flushMetrics();
    vi.setSystemTime(new Date(2026, 9, 2, 12, 0)); // 8 days before "now"
    record('note.create');
    await flushMetrics();
    vi.setSystemTime(new Date(2026, 9, 10, 12, 0));
    record('note.delete');
    resetPruneThrottle();
    await flushMetrics();
    expect((await recentEvents()).map((e) => e.name)).toEqual(['note.delete']);
    expect((await dailyRollups()).map((r) => r.name).sort()).toEqual(['note.create', 'note.delete']);
  });

  it('prunes at most once per hour', async () => {
    for (let i = 0; i < RAW_MAX; i++) {
      record('note.open');
      if (i % 40 === 0) await flushMetrics();
    }
    await flushMetrics(); // prunes (first flush after reset), at the cap
    for (let i = 0; i < 10; i++) record('note.open');
    await flushMetrics(); // throttled: may exceed the cap briefly
    expect((await metricsStorage()).events).toBe(RAW_MAX + 10);
    vi.setSystemTime(Date.now() + 3600_000 + 1);
    record('note.open');
    await flushMetrics();
    expect((await metricsStorage()).events).toBe(RAW_MAX);
  });

  it('uses local calendar days', () => {
    expect(dayKey(new Date(2026, 0, 2, 23, 59).getTime())).toBe('2026-01-02');
  });
});
