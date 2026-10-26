import { useMemo, useRef, useState } from 'preact/hooks';
import { buildBlogPost, defaultBlogMeta, parseFrontmatter, parseTags, validateBlogMeta, type BlogMeta } from '../lib/blogExport';
import { record } from '../lib/metrics';

interface Props {
  path: string;
  content: string;
  onClose: () => void;
}

/** Form to turn the open note into a blog post; the result is copied or shared, never saved. */
export function BlogExport({ path, content, onClose }: Props) {
  const initial = useMemo(() => defaultBlogMeta(content, path), []);
  const [meta, setMeta] = useState<BlogMeta>(initial);
  const [tagsInput, setTagsInput] = useState(initial.tags.join(', '));
  const startsWithHeading = /^\s*#\s/.test(parseFrontmatter(content).body);
  const [dropTitleHeading, setDropTitleHeading] = useState(startsWithHeading);
  const [status, setStatus] = useState<string | null>(null);
  const output = useRef<HTMLTextAreaElement>(null);

  const full = { ...meta, tags: parseTags(tagsInput) };
  const errors = validateBlogMeta(full);
  const post = useMemo(() => buildBlogPost(content, full, { dropTitleHeading }), [content, JSON.stringify(full), dropTitleHeading]);

  const set = (patch: Partial<BlogMeta>) => setMeta({ ...meta, ...patch });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(post.text);
    } catch {
      // Clipboard API unavailable (or denied): fall back to selecting the text.
      output.current?.select();
      document.execCommand('copy');
    }
    record('blog.export', { attrs: { via: 'copy', tags: full.tags.length } });
    setStatus('コピーしました');
  };

  const share = async () => {
    try {
      await navigator.share({ title: full.title, text: post.text });
      record('blog.export', { attrs: { via: 'share', tags: full.tags.length } });
    } catch {
      // cancelled by the user
    }
  };

  return (
    <div class="modal-backdrop" onClick={onClose}>
      <div class="modal blog-export" onClick={(e) => e.stopPropagation()}>
        <header class="settings-head">
          <h2>ブログ記事に変換</h2>
          <button class="icon" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </header>
        <div class="blog-form">
          <label>
            タイトル
            <input value={meta.title} onInput={(e) => set({ title: (e.target as HTMLInputElement).value })} />
          </label>
          <label>
            日付
            <input type="date" value={meta.date} onInput={(e) => set({ date: (e.target as HTMLInputElement).value })} />
          </label>
          <label>
            説明（任意）
            <textarea rows={2} value={meta.description} onInput={(e) => set({ description: (e.target as HTMLTextAreaElement).value })} />
          </label>
          <label>
            タグ（カンマまたは空白区切り、任意）
            <input value={tagsInput} autocapitalize="off" placeholder="essay, database" onInput={(e) => setTagsInput((e.target as HTMLInputElement).value)} />
          </label>
          <label class="check">
            <input type="checkbox" checked={meta.draft} onChange={(e) => set({ draft: (e.target as HTMLInputElement).checked })} />
            下書き（draft: true。ブログには公開されない）
          </label>
          {startsWithHeading && (
            <label class="check">
              <input type="checkbox" checked={dropTitleHeading} onChange={(e) => setDropTitleHeading((e.target as HTMLInputElement).checked)} />
              先頭の見出しを削除する
            </label>
          )}
        </div>

        {errors.length > 0 && <p class="msg err">{errors.join(' / ')}</p>}
        {post.changes.length > 0 && (
          <ul class="blog-changes">
            {post.changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        )}
        <textarea ref={output} class="blog-output" readOnly value={post.text} />

        <div class="blog-actions">
          <button class="primary" disabled={errors.length > 0} onClick={copy}>
            コピー
          </button>
          {'share' in navigator && (
            <button disabled={errors.length > 0} onClick={share}>
              共有…
            </button>
          )}
          {status && <span class="msg ok">{status}</span>}
        </div>
        <small class="blog-note">変換結果は GitVault には保存されません。ノート本体も変更しません。</small>
      </div>
    </div>
  );
}
