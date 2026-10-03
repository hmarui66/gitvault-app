import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { normalizeNotePath, noteTitle } from '../lib/paths';
import { vault } from '../lib/vault';

/** Subsequence match; lower score is better. */
function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const s = target.toLowerCase();
  const direct = s.indexOf(q);
  if (direct >= 0) return direct;
  let pos = 0;
  let gaps = 0;
  for (const ch of q) {
    const i = s.indexOf(ch, pos);
    if (i < 0) return null;
    gaps += i - pos;
    pos = i + 1;
  }
  return 100 + gaps;
}

interface Props {
  onOpen: (path: string) => void;
  onCreate: (path: string) => void;
  onClose: () => void;
}

export function Switcher({ onOpen, onCreate, onClose }: Props) {
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const items = useMemo(() => {
    const paths = vault.paths();
    if (!q.trim()) return paths.slice(0, 50);
    return paths
      .map((p) => ({ p, s: fuzzyScore(q.trim(), p) }))
      .filter((x): x is { p: string; s: number } => x.s !== null)
      .sort((a, b) => a.s - b.s)
      .slice(0, 50)
      .map((x) => x.p);
  }, [q]);

  const createPath = q.trim() ? normalizeNotePath(q) : null;
  const canCreate = createPath !== null && !vault.has(createPath);

  const submit = (e: Event) => {
    e.preventDefault();
    if (items.length) onOpen(items[0]);
    else if (canCreate) onCreate(createPath!);
  };

  return (
    <div class="modal-backdrop" onClick={onClose}>
      <form class="modal switcher" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <input ref={input} value={q} placeholder="ノートを開く / 作成" onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <div class="switcher-list">
          {items.map((p) => (
            <button type="button" key={p} class="tree-item result" onClick={() => onOpen(p)}>
              <span class="result-title">{noteTitle(p)}</span>
              <span class="result-path">{p}</span>
            </button>
          ))}
          {canCreate && (
            <button type="button" class="tree-item create" onClick={() => onCreate(createPath!)}>
              ＋ 作成: {createPath}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
