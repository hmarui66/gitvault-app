import { useMemo, useState } from 'preact/hooks';
import { basename, noteTitle } from '../lib/paths';
import { vault } from '../lib/vault';

interface Folder {
  name: string;
  path: string;
  folders: Map<string, Folder>;
  notes: string[];
}

function buildTree(paths: string[]): Folder {
  const root: Folder = { name: '', path: '', folders: new Map(), notes: [] };
  for (const p of paths) {
    const segs = p.split('/');
    let f = root;
    for (const seg of segs.slice(0, -1)) {
      let child = f.folders.get(seg);
      if (!child) {
        child = { name: seg, path: f.path ? `${f.path}/${seg}` : seg, folders: new Map(), notes: [] };
        f.folders.set(seg, child);
      }
      f = child;
    }
    f.notes.push(p);
  }
  return root;
}

const OPEN_KEY = 'gitvault.openFolders';
function loadOpen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

interface Props {
  current: string | null;
  version: number;
  onOpen: (path: string) => void;
  onNewNote: (folder: string) => void;
  onDaily: () => void;
  onSettings: () => void;
  repoLabel: string;
}

export function Sidebar({ current, version, onOpen, onNewNote, onDaily, onSettings, repoLabel }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(loadOpen);
  const paths = useMemo(() => vault.paths(), [version]);
  const tree = useMemo(() => buildTree(paths), [paths]);

  const toggle = (path: string) => {
    const next = new Set(open);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setOpen(next);
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
    } catch {
      // storage unavailable: folder state is just not remembered
    }
  };

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const hits: { path: string; snippet: string | null; score: number }[] = [];
    for (const p of paths) {
      const inTitle = p.toLowerCase().includes(q);
      const text = vault.read(p) ?? '';
      const i = text.toLowerCase().indexOf(q);
      if (!inTitle && i < 0) continue;
      const snippet = i < 0 ? null : text.slice(Math.max(0, i - 30), i + q.length + 50).replace(/\s+/g, ' ');
      hits.push({ path: p, snippet, score: inTitle ? 0 : 1 });
    }
    return hits.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path)).slice(0, 100);
  }, [query, paths, version]);

  const renderFolder = (f: Folder, depth: number) => (
    <>
      {[...f.folders.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((child) => (
          <div key={child.path}>
            <button class="tree-item folder" style={{ paddingLeft: `${12 + depth * 16}px` }} onClick={() => toggle(child.path)}>
              <span class="chev">{open.has(child.path) ? '▾' : '▸'}</span>
              {child.name}
            </button>
            {open.has(child.path) && renderFolder(child, depth + 1)}
          </div>
        ))}
      {f.notes.map((p) => (
        <button
          key={p}
          class={`tree-item note${p === current ? ' active' : ''}`}
          style={{ paddingLeft: `${28 + depth * 16}px` }}
          onClick={() => onOpen(p)}
        >
          {noteTitle(p)}
        </button>
      ))}
    </>
  );

  return (
    <nav class="sidebar">
      <div class="sidebar-head">
        <input
          type="search"
          placeholder="検索（タイトル・本文）"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
      </div>
      <div class="sidebar-actions">
        <button onClick={() => onNewNote('')}>＋ 新規ノート</button>
        <button onClick={onDaily}>📅 今日</button>
      </div>
      <div class="tree">
        {results
          ? results.map((r) => (
              <button key={r.path} class="tree-item result" onClick={() => onOpen(r.path)}>
                <span class="result-title">{noteTitle(r.path)}</span>
                <span class="result-path">{r.path.includes('/') ? r.path.slice(0, -basename(r.path).length - 1) : ''}</span>
                {r.snippet && <span class="result-snippet">{r.snippet}</span>}
              </button>
            ))
          : renderFolder(tree, 0)}
        {results?.length === 0 && <p class="empty">見つかりません</p>}
        {!results && paths.length === 0 && <p class="empty">ノートはまだありません</p>}
      </div>
      <button class="sidebar-foot" onClick={onSettings}>
        ⚙ {repoLabel}
      </button>
    </nav>
  );
}
