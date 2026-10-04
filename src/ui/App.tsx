import { useEffect, useRef, useState } from 'preact/hooks';
import { setConfig as saveConfig, type Config } from '../lib/db';
import { planImport } from '../lib/importer';
import { normalizeNotePath, noteTitle } from '../lib/paths';
import { DEFAULT_DAILY_TEMPLATE, dailySettings, formatDate, renderTemplate } from '../lib/template';
import type { SyncController, SyncView } from '../lib/syncController';
import { vault } from '../lib/vault';
import { Editor } from './Editor';
import { Preview } from './Preview';
import { Settings } from './Settings';
import { Sidebar } from './Sidebar';
import { Switcher } from './Switcher';

const LAST_NOTE_KEY = 'gitvault.lastNote';
const MODE_KEY = 'gitvault.mode';

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // per-device convenience only
  }
}
function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function pathFromHash(): string | null {
  const m = location.hash.match(/^#\/n\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

function navigate(path: string, replace = false) {
  const hash = `#/n/${encodeURIComponent(path)}`;
  if (replace) history.replaceState(null, '', hash);
  else location.hash = hash;
  store(LAST_NOTE_KEY, path);
}

function useVaultVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => vault.subscribe(() => setV((x) => x + 1)), []);
  return v;
}

function useSyncView(sync: SyncController): SyncView {
  const [view, setView] = useState(sync.view);
  useEffect(() => sync.subscribe(() => setView(sync.view)), [sync]);
  return view;
}

function relativeTime(t: number | null): string {
  if (!t) return '未同期';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'たった今';
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  return new Date(t).toLocaleDateString();
}

function SyncChip({ view, dirty, onClick }: { view: SyncView; dirty: number; onClick: () => void }) {
  let cls = 'ok';
  let text = `✓ ${relativeTime(view.lastSyncAt)}`;
  if (view.status === 'syncing') [cls, text] = ['busy', '⟳ 同期中'];
  else if (view.status === 'offline') [cls, text] = ['off', dirty ? `オフライン · ${dirty}件待機` : 'オフライン'];
  else if (view.status === 'error') [cls, text] = ['err', '⚠ 同期エラー'];
  else if (dirty) [cls, text] = ['pending', `● ${dirty}件未同期`];
  return (
    <button class={`chip ${cls}`} onClick={onClick} title={view.lastError ?? '今すぐ同期'}>
      {text}
    </button>
  );
}

export function App({ initialConfig, sync }: { initialConfig: Config | null; sync: SyncController }) {
  const [config, setConfig] = useState(initialConfig);
  const [path, setPath] = useState<string | null>(pathFromHash);
  const [mode, setMode] = useState<'edit' | 'read'>(recall(MODE_KEY) === 'read' ? 'read' : 'edit');
  const [drawer, setDrawer] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [settings, setSettings] = useState(false);
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const version = useVaultVersion();
  const syncView = useSyncView(sync);

  useEffect(() => {
    const onHash = () => setPath(pathFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Reopen the last note on launch.
  useEffect(() => {
    if (path) return;
    const last = recall(LAST_NOTE_KEY);
    if (last && vault.has(last)) navigate(last, true), setPath(last);
  }, [version]);

  useEffect(() => {
    const r = syncView.lastResult;
    if (r?.conflicts.length) setToast(`競合を検出しました。あなたの版を「${noteTitle(r.conflicts[0])}」として残しました`);
  }, [syncView.lastResult]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  if (!config || settings) {
    return (
      <Settings
        initial={config}
        dirtyCount={vault.dirtyCount}
        onClose={config ? () => setSettings(false) : undefined}
        onSave={async (cfg) => {
          await saveConfig(cfg);
          vault.deviceName = cfg.deviceName;
          const first = !config;
          setConfig(cfg);
          setSettings(false);
          if (first) await sync.start();
          else void sync.sync();
        }}
      />
    );
  }

  const open = (p: string) => {
    navigate(p);
    setPath(p);
    setDrawer(false);
    setSwitcher(false);
  };

  const create = async (p: string, content = '') => {
    if (!vault.has(p)) await vault.create(p, content);
    open(p);
    setMode('edit');
    void sync.noteEdited();
  };

  const newNote = (folder: string) => {
    const name = prompt('ノート名', '無題');
    if (name) void create(normalizeNotePath(folder ? `${folder}/${name}` : name));
  };

  const daily = () => {
    const { folder, format, templatePath } = dailySettings(config);
    const date = new Date();
    const name = formatDate(date, format);
    const path = normalizeNotePath(folder ? `${folder}/${name}` : name);
    const template = vault.read(normalizeNotePath(templatePath)) ?? '# {{title}}\n\n';
    void create(path, renderTemplate(template, { title: noteTitle(path), date }));
  };

  const editDailyTemplate = () => {
    void create(normalizeNotePath(dailySettings(config).templatePath), DEFAULT_DAILY_TEMPLATE);
  };

  const importFolder = async (files: File[]) => {
    if (!files.length) return;
    const plan = await planImport(files, (p) => vault.read(p));
    const flat = files.every((f) => !f.webkitRelativePath);
    const lines = [
      `新規 ${plan.added.length} 件`,
      plan.changed.length ? `内容が異なる既存ノート ${plan.changed.length} 件（上書き）` : '',
      plan.unchanged ? `同一のため省略 ${plan.unchanged} 件` : '',
      plan.skipped ? `対象外（添付・設定など）${plan.skipped} 件` : '',
      flat ? '\n※ フォルダ構成が取得できなかったため、すべてルートに置かれます' : '',
    ].filter(Boolean);
    const items = [...plan.added, ...plan.changed];
    if (!items.length) return setToast(`取り込むノートはありません（${lines.join(' / ')}）`);
    if (!confirm(`取り込み内容:\n${lines.join('\n')}\n\n取り込んで GitHub に同期しますか？`)) return;
    await vault.importNotes(items);
    setToast(`${items.length} 件を取り込みました。同期します`);
    void sync.sync();
  };

  const rename = async () => {
    setMenu(false);
    if (!path) return;
    const next = prompt('新しい名前（フォルダは / で区切る）', path.replace(/\.md$/i, ''));
    if (!next) return;
    const to = normalizeNotePath(next);
    if (to === path) return;
    if (vault.has(to)) return alert('同じ名前のノートがあります');
    await vault.rename(path, to);
    navigate(to, true);
    setPath(to);
    void sync.noteEdited();
  };

  const remove = async () => {
    setMenu(false);
    if (!path || !confirm(`「${noteTitle(path)}」を削除しますか？`)) return;
    await vault.remove(path);
    history.replaceState(null, '', '#');
    setPath(null);
    void sync.noteEdited();
  };

  const toggleMode = () => {
    const next = mode === 'edit' ? 'read' : 'edit';
    setMode(next);
    store(MODE_KEY, next);
  };

  const exists = path !== null && vault.has(path);

  return (
    <div class="app">
      <header class="topbar">
        <button class="icon" onClick={() => setDrawer(true)} aria-label="ノート一覧">
          ☰
        </button>
        <h1 class="title" onClick={() => exists && void rename()}>
          {exists ? noteTitle(path) : 'GitVault'}
        </h1>
        <SyncChip view={syncView} dirty={vault.dirtyCount} onClick={() => void sync.sync()} />
        {exists && (
          <button class="icon" onClick={toggleMode} aria-label={mode === 'edit' ? '閲覧モード' : '編集モード'}>
            {mode === 'edit' ? '👁' : '✎'}
          </button>
        )}
        <button class="icon" onClick={() => setMenu(!menu)} aria-label="メニュー">
          ⋮
        </button>
      </header>

      {menu && (
        <div class="menu-backdrop" onClick={() => setMenu(false)}>
          <div class="menu" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => (setMenu(false), setSwitcher(true))}>🔎 ノートを開く</button>
            <button onClick={() => (setMenu(false), newNote(''))}>＋ 新規ノート</button>
            <button onClick={() => (setMenu(false), daily())}>📅 今日のノート</button>
            <button onClick={() => (setMenu(false), editDailyTemplate())}>📝 デイリーテンプレートを編集</button>
            <button onClick={() => (setMenu(false), importInput.current?.click())}>📥 フォルダから取り込む</button>
            {exists && <button onClick={rename}>✎ 名前を変更 / 移動</button>}
            {exists && (
              <button class="danger" onClick={remove}>
                🗑 削除
              </button>
            )}
            <button onClick={() => (setMenu(false), void sync.sync())}>⟳ 今すぐ同期</button>
            <button onClick={() => (setMenu(false), setSettings(true))}>⚙ 設定</button>
            {syncView.lastError && <p class="menu-error">最後のエラー: {syncView.lastError}</p>}
          </div>
        </div>
      )}

      <main class="main">
        {exists ? (
          <>
            <Editor path={path} visible={mode === 'edit'} onEdit={() => void sync.noteEdited()} />
            {mode === 'read' && (
              <Preview
                path={path}
                version={version}
                onEdit={() => void sync.noteEdited()}
                onOpenLink={(target, resolved) => (resolved ? open(target) : void create(normalizeNotePath(target)))}
              />
            )}
          </>
        ) : (
          <div class="home">
            <p>{path ? 'このノートは存在しません。' : 'ノートを選ぶか、新しく作成してください。'}</p>
            <button class="primary" onClick={() => setSwitcher(true)}>
              ノートを開く / 作成
            </button>
            <button onClick={daily}>今日のノート</button>
          </div>
        )}
      </main>

      <div class={`drawer-backdrop${drawer ? ' open' : ''}`} onClick={() => setDrawer(false)} />
      <aside class={`drawer${drawer ? ' open' : ''}`}>
        <Sidebar
          current={path}
          version={version}
          onOpen={open}
          onNewNote={(f) => (setDrawer(false), newNote(f))}
          onDaily={() => (setDrawer(false), daily())}
          onSettings={() => (setDrawer(false), setSettings(true))}
          repoLabel={`${config.owner}/${config.repo}@${config.branch}`}
        />
      </aside>

      <input
        type="file"
        multiple
        hidden
        ref={(el) => {
          importInput.current = el;
          // Folder picking: a vault's subfolders arrive as webkitRelativePath.
          if (el) el.webkitdirectory = true;
        }}
        onChange={(e) => {
          const input = e.currentTarget as HTMLInputElement;
          const files = [...(input.files ?? [])];
          input.value = '';
          void importFolder(files);
        }}
      />

      {switcher && <Switcher onOpen={open} onCreate={(p) => void create(p)} onClose={() => setSwitcher(false)} />}
      {toast && (
        <div class="toast" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  );
}
