import { useEffect, useState } from 'preact/hooks';
import {
  clearMetrics,
  dailyRollups,
  dayKey,
  flushMetrics,
  metricsStorage,
  RAW_MAX,
  RAW_MAX_AGE_MS,
  recentEvents,
  ROLLUP_DAYS,
  type DailyRollup,
  type MetricEvent,
} from '../lib/metrics';

const LABELS: Record<string, string> = {
  'app.start': '起動',
  'app.update': 'アプリ更新',
  'note.open': 'ノートを開く',
  'note.create': 'ノート作成',
  'note.daily': 'デイリー作成',
  'note.rename': '名前変更',
  'note.delete': '削除',
  'note.import': '取り込み',
  'note.save': '端末への保存',
  sync: '同期',
  'sync.deferred': '同期の保留',
  'bgsync.register': 'バックグラウンド同期の予約',
};

const TRIGGERS: Record<string, string> = {
  startup: '起動',
  idle: '編集停止',
  hidden: '離脱',
  resume: '復帰',
  online: 'オンライン復帰',
  manual: '手動',
  import: '取り込み',
  settings: '設定変更',
  retry: '再実行',
  background: 'バックグラウンド',
};

const label = (name: string) => LABELS[name] ?? name;
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
const fmtKB = (b: number) => `${(b / 1024).toFixed(b < 10240 ? 1 : 0)}KB`;

function summarize(rollups: DailyRollup[], sinceDay: string) {
  const by = new Map<string, DailyRollup>();
  for (const r of rollups) {
    if (r.day < sinceDay) continue;
    const s = by.get(r.name) ?? { ...r, key: r.name, count: 0, errors: 0, totalMs: 0, maxMs: 0, sums: {} };
    s.count += r.count;
    s.errors += r.errors;
    s.totalMs += r.totalMs;
    s.maxMs = Math.max(s.maxMs, r.maxMs);
    for (const [k, v] of Object.entries(r.sums)) s.sums[k] = (s.sums[k] ?? 0) + v;
    by.set(r.name, s);
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
}

function describe(e: MetricEvent): string {
  const a = e.attrs ?? {};
  if (e.name === 'sync') {
    const parts = [TRIGGERS[a.trigger as string] ?? String(a.trigger)];
    if (e.ok === false) parts.push(String(a.error ?? 'エラー'));
    else {
      if (a.pushed) parts.push(`push ${a.pushed}`);
      if (a.pulled) parts.push(`pull ${a.pulled}`);
      if (a.conflicts) parts.push(`競合 ${a.conflicts}`);
      if (!a.pushed && !a.pulled) parts.push('変更なし');
    }
    parts.push(`${a.requests ?? 0}req · ${fmtKB(Number(a.bytes ?? 0))}`);
    return parts.join(' · ');
  }
  if (e.name === 'sync.deferred') return `${TRIGGERS[a.trigger as string] ?? a.trigger} · オフライン · 未同期 ${a.pending}`;
  if (e.name === 'app.start') return `${a.notes} ノート${a.online ? '' : ' · オフライン'}`;
  if (e.name === 'note.import') return `新規 ${a.added} · 上書き ${a.overwritten} · 対象外 ${a.skipped}`;
  return Object.entries(a)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
}

export function Metrics({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<{
    rollups: DailyRollup[];
    events: MetricEvent[];
    storage: { events: number; rollups: number };
  } | null>(null);

  const load = async () => {
    await flushMetrics();
    const [rollups, events, storage] = await Promise.all([dailyRollups(), recentEvents(100), metricsStorage()]);
    setData({ rollups, events, storage });
  };

  useEffect(() => void load(), []);

  if (!data) return <div class="settings">読み込み中…</div>;

  const today = Date.now();
  const week = summarize(data.rollups, dayKey(today - 6 * 86400_000));
  const syncDays = data.rollups
    .filter((r) => r.name === 'sync' && r.day >= dayKey(today - 13 * 86400_000))
    .sort((a, b) => b.day.localeCompare(a.day));

  return (
    <div class="settings metrics">
      <header class="settings-head">
        <h2>メトリクス</h2>
        <button class="icon" onClick={onClose} aria-label="閉じる">
          ✕
        </button>
      </header>

      <h3>直近 7 日</h3>
      {week.length === 0 ? (
        <p class="empty">まだ記録がありません</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>操作</th>
              <th>回数</th>
              <th>失敗</th>
              <th>平均</th>
              <th>最大</th>
            </tr>
          </thead>
          <tbody>
            {week.map((r) => (
              <tr key={r.name}>
                <td>{label(r.name)}</td>
                <td>{r.count}</td>
                <td class={r.errors ? 'bad' : ''}>{r.errors || ''}</td>
                <td>{r.totalMs ? fmtMs(r.totalMs / r.count) : ''}</td>
                <td>{r.maxMs ? fmtMs(r.maxMs) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>同期（日別・直近 14 日）</h3>
      {syncDays.length === 0 ? (
        <p class="empty">まだ同期の記録がありません</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>日付</th>
              <th>回数</th>
              <th>失敗</th>
              <th>push</th>
              <th>pull</th>
              <th>通信</th>
            </tr>
          </thead>
          <tbody>
            {syncDays.map((r) => (
              <tr key={r.day}>
                <td>{r.day.slice(5)}</td>
                <td>{r.count}</td>
                <td class={r.errors ? 'bad' : ''}>{r.errors || ''}</td>
                <td>{r.sums.pushed ?? 0}</td>
                <td>{r.sums.pulled ?? 0}</td>
                <td>
                  {r.sums.requests ?? 0}req
                  <br />
                  {fmtKB(r.sums.bytes ?? 0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <small>通信量は API の JSON 本文（非圧縮）の合計で、実際の転送量はこれより小さくなります。</small>

      <h3>最近のイベント</h3>
      <ul class="events">
        {data.events.map((e) => (
          <li key={e.id} class={e.ok === false ? 'bad' : ''}>
            <span class="ev-time">
              {new Date(e.t).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </span>
            <span class="ev-name">
              {label(e.name)}
              {e.src === 'sw' && <span class="ev-src">SW</span>}
              {e.ms !== undefined && <span class="ev-ms">{fmtMs(e.ms)}</span>}
            </span>
            <span class="ev-desc">{describe(e)}</span>
          </li>
        ))}
      </ul>

      <h3>保存量と保持ルール</h3>
      <p class="retention">
        イベント {data.storage.events} 件 / 日次集計 {data.storage.rollups} 行。イベントは直近 {RAW_MAX} 件かつ{' '}
        {RAW_MAX_AGE_MS / 86400_000} 日まで、日次集計は {ROLLUP_DAYS} 日まで保持し、古いものから自動で削除します。
        端末への保存は回数だけを集計します。ノート名や本文は記録しません。
      </p>
      <button
        class="danger"
        onClick={async () => {
          if (!confirm('メトリクスをすべて削除しますか？')) return;
          await clearMetrics();
          await load();
        }}
      >
        メトリクスを消去
      </button>
    </div>
  );
}
