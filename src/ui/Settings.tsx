import { useState } from 'preact/hooks';
import { deleteDatabase, type Config } from '../lib/db';
import { GitHub } from '../lib/github';
import { deleteMetricsDatabase } from '../lib/metrics';
import { dailySettings } from '../lib/template';
import { TOKEN_WARN_DAYS } from '../lib/token';

interface Props {
  initial: Config | null;
  dirtyCount: number;
  onSave: (cfg: Config) => Promise<void>;
  onClose?: () => void;
}

const DELAYS = [
  { v: 30, label: '30秒' },
  { v: 120, label: '2分（推奨）' },
  { v: 300, label: '5分' },
  { v: 0, label: '自動同期しない（アプリ離脱時と手動のみ）' },
];

export function Settings({ initial, dirtyCount, onSave, onClose }: Props) {
  const [cfg, setCfg] = useState<Config>(() => {
    const base = initial ?? { owner: '', repo: '', branch: 'main', token: '', deviceName: 'Pixel', autoSyncDelaySec: 120 };
    const d = dailySettings(base);
    return { ...base, dailyFolder: d.folder, dailyFormat: d.format, dailyTemplatePath: d.templatePath };
  });
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const field = (key: keyof Config) => ({
    value: String(cfg[key] ?? ''),
    onInput: (e: Event) => setCfg({ ...cfg, [key]: (e.target as HTMLInputElement).value.trim() }),
  });

  const repoChanged = !!initial && (initial.owner !== cfg.owner || initial.repo !== cfg.repo || initial.branch !== cfg.branch);
  const connectionChanged = !initial || repoChanged || initial.token !== cfg.token;

  const save = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      // Only re-verify GitHub access when it could have changed, so other settings can be saved offline.
      if (connectionChanged) {
        const info = await new GitHub(cfg).checkRepo();
        if (!info.canPush) throw new Error('このトークンにはリポジトリへの書き込み権限がありません');
      }
      if (repoChanged) {
        const warn = dirtyCount > 0 ? `\n未同期の変更 ${dirtyCount} 件は失われます。` : '';
        if (!confirm(`リポジトリを切り替えると、この端末のノートを削除して取り込み直します。${warn}`)) return;
        await deleteDatabase();
      }
      await onSave(cfg);
      if (repoChanged) location.reload();
      setMsg({ kind: 'ok', text: '保存しました' });
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    const warn = dirtyCount > 0 ? `未同期の変更 ${dirtyCount} 件も失われます。` : '';
    if (!confirm(`この端末のノートと設定をすべて削除します。${warn}GitHub 上のデータは消えません。`)) return;
    await deleteDatabase();
    await deleteMetricsDatabase();
    location.reload();
  };

  return (
    <div class="settings">
      <header class="settings-head">
        <h2>{initial ? '設定' : 'GitVault のセットアップ'}</h2>
        {onClose && (
          <button class="icon" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        )}
      </header>
      <form onSubmit={save}>
        <label>
          オーナー
          <input {...field('owner')} required autocapitalize="off" placeholder="your-name" />
        </label>
        <label>
          リポジトリ
          <input {...field('repo')} required autocapitalize="off" placeholder="notes" />
        </label>
        <label>
          ブランチ
          <input {...field('branch')} required autocapitalize="off" />
        </label>
        <label>
          アクセストークン（Fine-grained PAT）
          <input {...field('token')} required type="password" autocomplete="off" />
          <small>
            GitHub → Settings → Developer settings → Fine-grained tokens で、このリポジトリだけを対象に
            <b>Contents: Read and write</b> を付与して発行してください。トークンはこの端末の IndexedDB にのみ保存されます。
          </small>
        </label>
        <label>
          トークンの有効期限（任意）
          <input
            type="date"
            value={cfg.tokenExpiresOn ?? ''}
            onInput={(e) => setCfg({ ...cfg, tokenExpiresOn: (e.target as HTMLInputElement).value || undefined })}
          />
          <small>
            トークン発行時に表示される期限（Fine-grained tokens の一覧にも表示）を入力すると、{TOKEN_WARN_DAYS} 日前から起動時に警告します。
            GitHub はこの期限をブラウザに渡さないため、自動では取得できません。トークンを更新したら、この日付も更新してください。
          </small>
        </label>
        <label>
          端末名（コミットメッセージ・競合コピー名に使用）
          <input {...field('deviceName')} required />
        </label>
        <label>
          自動同期（編集が止まってから）
          <select
            value={String(cfg.autoSyncDelaySec)}
            onChange={(e) => setCfg({ ...cfg, autoSyncDelaySec: Number((e.target as HTMLSelectElement).value) })}
          >
            {DELAYS.map((d) => (
              <option key={d.v} value={String(d.v)}>
                {d.label}
              </option>
            ))}
          </select>
          <small>入力内容は常に端末へ即時保存されます。ここで決めるのは GitHub へコミットするタイミングです。</small>
        </label>
        <fieldset>
          <legend>デイリーノート</legend>
          <label>
            フォルダ（空欄でルート）
            <input {...field('dailyFolder')} autocapitalize="off" placeholder="Daily" />
          </label>
          <label>
            ファイル名の形式
            <input {...field('dailyFormat')} autocapitalize="off" placeholder="YYYY-MM-DD" />
          </label>
          <label>
            テンプレートのノート
            <input {...field('dailyTemplatePath')} autocapitalize="off" placeholder="Templates/Daily.md" />
            <small>
              テンプレートは普通のノートとして同期されます（メニューの「デイリーテンプレートを編集」から作成・編集）。
              使える変数: <code>{'{{title}}'}</code> <code>{'{{date}}'}</code> <code>{'{{time}}'}</code>{' '}
              <code>{'{{date:YYYY年M月D日 (ddd)}}'}</code>。書式は YYYY / MM / M / DD / D / HH / mm / ddd（月）/ dddd（月曜日）、
              <code>[文字]</code> はそのまま出力。
            </small>
          </label>
        </fieldset>
        {msg && <p class={`msg ${msg.kind}`}>{msg.text}</p>}
        <button class="primary" type="submit" disabled={busy}>
          {busy ? '確認中…' : initial ? '保存' : '接続して取り込む'}
        </button>
      </form>
      {initial && (
        <button class="danger" onClick={reset}>
          この端末のデータを消去
        </button>
      )}
    </div>
  );
}
