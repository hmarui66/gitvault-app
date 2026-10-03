import { autocompletion, closeBrackets, type Completion, type CompletionContext } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore, redo, undo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Annotation, EditorSelection, EditorState } from '@codemirror/state';
import {
  Decoration,
  drawSelection,
  EditorView,
  keymap,
  MatchDecorator,
  placeholder,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { useEffect, useRef } from 'preact/hooks';
import { dirname, noteTitle } from '../lib/paths';
import { vault } from '../lib/vault';

/** Marks transactions that load content from the vault (as opposed to user edits). */
const External = Annotation.define<boolean>();

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.55em', fontWeight: '700' },
  { tag: t.heading2, fontSize: '1.3em', fontWeight: '700' },
  { tag: t.heading3, fontSize: '1.15em', fontWeight: '700' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--muted)' },
  { tag: t.monospace, fontFamily: 'var(--mono)', color: 'var(--code)' },
  { tag: t.quote, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [t.processingInstruction, t.contentSeparator], color: 'var(--faint)' },
]);

const linkDecorator = new MatchDecorator({
  regexp: /\[\[[^\]\n]+\]\]|(?<=^|\s)#[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*/gu,
  decoration: (m) => Decoration.mark({ class: m[0].startsWith('[[') ? 'cm-wikilink' : 'cm-tag' }),
});

const linkHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = linkDecorator.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = linkDecorator.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

function wikiLinkCompletions(ctx: CompletionContext) {
  const m = ctx.matchBefore(/\[\[[^\]\n]*/);
  if (!m) return null;
  const paths = vault.paths();
  const titleCount = new Map<string, number>();
  for (const p of paths) titleCount.set(noteTitle(p), (titleCount.get(noteTitle(p)) ?? 0) + 1);
  const options: Completion[] = paths.map((p) => {
    // Ambiguous titles are linked by path.
    const label = titleCount.get(noteTitle(p))! > 1 ? p.replace(/\.md$/i, '') : noteTitle(p);
    return {
      label,
      detail: dirname(p) || undefined,
      apply: (view, _c, from, to) => {
        const closed = view.state.sliceDoc(to, to + 2) === ']]';
        const insert = closed ? label : `${label}]]`;
        view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + label.length + 2 } });
      },
    };
  });
  return { from: m.from + 2, options, validFor: /^[^\]\n]*$/ };
}

/** Replace only the differing middle part so the cursor survives external updates. */
function applyExternal(view: EditorView, next: string) {
  const cur = view.state.doc.toString();
  if (cur === next) return;
  let start = 0;
  while (start < cur.length && start < next.length && cur[start] === next[start]) start++;
  let endCur = cur.length;
  let endNext = next.length;
  while (endCur > start && endNext > start && cur[endCur - 1] === next[endNext - 1]) {
    endCur--;
    endNext--;
  }
  view.dispatch({ changes: { from: start, to: endCur, insert: next.slice(start, endNext) }, annotations: External.of(true) });
}

interface Props {
  path: string;
  visible: boolean;
  onEdit: () => void;
}

export function Editor({ path, visible, onEdit }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, EditorState>());
  const pathRef = useRef(path);
  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;

  const makeState = (doc: string) =>
    EditorState.create({
      doc,
      extensions: [
        history(),
        drawSelection(),
        closeBrackets(),
        keymap.of([...defaultKeymap, ...historyKeymap, { key: 'Tab', run: indentMore, shift: indentLess }]),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(highlight),
        linkHighlighter,
        autocompletion({ override: [wikiLinkCompletions], icons: false }),
        EditorView.lineWrapping,
        placeholder('書き始める…'),
        EditorView.contentAttributes.of({ autocapitalize: 'sentences', autocorrect: 'on', spellcheck: 'false' }),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged || u.transactions.some((tr) => tr.annotation(External))) return;
          vault.write(pathRef.current, u.state.doc.toString());
          onEditRef.current();
        }),
      ],
    });

  useEffect(() => {
    const view = new EditorView({ parent: host.current!, state: makeState(vault.read(path) ?? '') });
    viewRef.current = view;
    const unsubscribe = vault.subscribe((e) => {
      if (e.type === 'external' && e.paths.includes(pathRef.current)) {
        applyExternal(view, vault.read(pathRef.current) ?? '');
      }
    });
    return () => {
      unsubscribe();
      view.destroy();
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current!;
    if (pathRef.current === path) return;
    states.current.set(pathRef.current, view.state);
    pathRef.current = path;
    const content = vault.read(path) ?? '';
    const cached = states.current.get(path);
    // Keep undo history per note, unless the note changed while it was closed.
    view.setState(cached && cached.doc.toString() === content ? cached : makeState(content));
  }, [path]);

  useEffect(() => {
    if (visible) viewRef.current?.requestMeasure();
  }, [visible]);

  const run = (fn: (v: EditorView) => void, refocus = true) => () => {
    const v = viewRef.current;
    if (!v) return;
    fn(v);
    if (refocus && !v.hasFocus) v.focus();
  };

  const wrap = (before: string, after = before) =>
    run((v) => {
      v.dispatch(
        v.state.changeByRange((r) => ({
          changes: [
            { from: r.from, insert: before },
            { from: r.to, insert: after },
          ],
          range: EditorSelection.range(r.from + before.length, r.to + before.length),
        })),
      );
    });

  const linePrefix = (prefix: string) =>
    run((v) => {
      const line = v.state.doc.lineAt(v.state.selection.main.head);
      const has = line.text.startsWith(prefix);
      v.dispatch({
        changes: has ? { from: line.from, to: line.from + prefix.length } : { from: line.from, insert: prefix },
      });
    });

  return (
    <div class="editor-wrap" style={{ display: visible ? 'flex' : 'none' }}>
      <div class="editor" ref={host} />
      {/* preventDefault on mousedown keeps focus (and the soft keyboard) in the editor */}
      <div class="toolbar" role="toolbar" onMouseDown={(e) => e.preventDefault()}>
        <button onClick={wrap('[[', ']]')} aria-label="リンク">[[ ]]</button>
        <button onClick={linePrefix('- [ ] ')} aria-label="タスク">☐</button>
        <button onClick={linePrefix('- ')} aria-label="リスト">•</button>
        <button onClick={linePrefix('# ')} aria-label="見出し">H</button>
        <button onClick={wrap('**')} aria-label="太字"><b>B</b></button>
        <button onClick={wrap('`')} aria-label="コード">{'</>'}</button>
        <button onClick={run((v) => indentLess(v))} aria-label="インデント解除">⇤</button>
        <button onClick={run((v) => indentMore(v))} aria-label="インデント">⇥</button>
        <button onClick={run((v) => undo(v))} aria-label="元に戻す">↶</button>
        <button onClick={run((v) => redo(v))} aria-label="やり直し">↷</button>
        <button onClick={run((v) => v.contentDOM.blur(), false)} aria-label="キーボードを閉じる">⌄</button>
      </div>
    </div>
  );
}
