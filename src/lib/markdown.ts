import DOMPurify from 'dompurify';
import { Marked, type TokenizerAndRendererExtension } from 'marked';
import { resolveLink } from './links';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function wikilinkExtension(paths: () => string[]): TokenizerAndRendererExtension {
  return {
    name: 'wikilink',
    level: 'inline',
    start: (src) => src.indexOf('[['),
    tokenizer(src) {
      const m = /^\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]+))?\]\]/.exec(src);
      if (!m) return undefined;
      return { type: 'wikilink', raw: m[0], target: m[1].trim(), alias: m[3]?.trim() };
    },
    renderer(token) {
      const target = token.target as string;
      const resolved = resolveLink(target, paths());
      const cls = resolved ? 'wikilink' : 'wikilink unresolved';
      return `<a href="#" class="${cls}" data-target="${escapeHtml(resolved ?? target)}">${escapeHtml((token.alias as string) ?? target)}</a>`;
    },
  };
}

const tagExtension: TokenizerAndRendererExtension = {
  name: 'tag',
  level: 'inline',
  start(src) {
    const m = /(^|\s)#[^\s#]/.exec(src);
    return m ? m.index + m[1].length : undefined;
  },
  tokenizer(src) {
    const m = /^#([\p{L}\p{N}_/-]+)/u.exec(src);
    if (!m || /^\d+$/.test(m[1])) return undefined;
    return { type: 'tag', raw: m[0], tag: m[1] };
  },
  renderer(token) {
    return `<span class="tag">#${escapeHtml(token.tag as string)}</span>`;
  },
};

export function createRenderer(paths: () => string[]): (src: string) => string {
  const marked = new Marked({ gfm: true, breaks: true });
  marked.use({ extensions: [wikilinkExtension(paths), tagExtension] });
  marked.use({
    renderer: {
      // Task checkboxes are clickable in reading mode (toggling edits the source).
      checkbox({ checked }) {
        return `<input type="checkbox" class="task"${checked ? ' checked' : ''}> `;
      },
    },
  });
  return (src) => {
    // A BOM kept for byte-exact sync would otherwise stop the first line from parsing (e.g. a heading).
    const html = marked.parse(src.replace(/^\uFEFF/, ''), { async: false });
    return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
  };
}

/** Toggle the n-th task list item (`- [ ]` / `- [x]`) in the source, skipping fenced code. */
export function toggleTask(src: string, index: number): string {
  const lines = src.split('\n');
  let inFence = false;
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/.exec(lines[i]);
    if (!m) continue;
    if (n++ === index) {
      lines[i] = m[1] + (m[2] === ' ' ? 'x' : ' ') + m[3] + lines[i].slice(m[0].length);
      return lines.join('\n');
    }
  }
  return src;
}
