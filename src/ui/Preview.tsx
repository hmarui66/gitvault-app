import { useMemo } from 'preact/hooks';
import { backlinks } from '../lib/links';
import { createRenderer, toggleTask } from '../lib/markdown';
import { noteTitle } from '../lib/paths';
import { vault } from '../lib/vault';

const render = createRenderer(() => vault.paths());

interface Props {
  path: string;
  version: number;
  onOpenLink: (target: string, resolved: boolean) => void;
  onEdit: () => void;
}

export function Preview({ path, version, onOpenLink, onEdit }: Props) {
  const content = vault.read(path) ?? '';
  const html = useMemo(() => render(content), [content, version]);
  const links = useMemo(() => backlinks(path, vault.paths(), (p) => vault.read(p)), [path, version]);

  const onClick = (e: MouseEvent) => {
    const el = e.target as HTMLElement;
    const wikilink = el.closest('a.wikilink');
    if (wikilink) {
      e.preventDefault();
      onOpenLink(wikilink.getAttribute('data-target')!, !wikilink.classList.contains('unresolved'));
      return;
    }
    const anchor = el.closest('a[href]');
    if (anchor && /^https?:/.test(anchor.getAttribute('href')!)) {
      e.preventDefault();
      window.open(anchor.getAttribute('href')!, '_blank', 'noopener');
      return;
    }
    if (el instanceof HTMLInputElement && el.classList.contains('task')) {
      const boxes = [...(e.currentTarget as HTMLElement).querySelectorAll('input.task')];
      vault.write(path, toggleTask(content, boxes.indexOf(el)));
      onEdit();
    }
  };

  return (
    <div class="preview-scroll">
      <article class="preview" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
      {links.length > 0 && (
        <section class="backlinks">
          <h4>バックリンク</h4>
          {links.map((p) => (
            <a key={p} href="#" onClick={(e) => (e.preventDefault(), onOpenLink(p, true))}>
              {noteTitle(p)}
            </a>
          ))}
        </section>
      )}
    </div>
  );
}
