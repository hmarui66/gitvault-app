import { describe, expect, it } from 'vitest';
import { planImport, vaultRelativePath } from '../src/lib/importer';

const file = (rel: string, content: string) => {
  const f = new File([content], rel.split('/').pop()!);
  Object.defineProperty(f, 'webkitRelativePath', { value: rel });
  return f;
};

describe('vaultRelativePath', () => {
  it('drops the picked folder name', () => {
    expect(vaultRelativePath({ name: 'b.md', webkitRelativePath: 'MyVault/a/b.md' })).toBe('a/b.md');
    expect(vaultRelativePath({ name: 'b.md', webkitRelativePath: '' })).toBe('b.md');
  });
});

describe('planImport', () => {
  it('keeps a BOM in imported notes', async () => {
    const plan = await planImport([file('V/a.md', '\uFEFF# A')], () => undefined);
    expect(plan.added[0].content).toBe('\uFEFF# A');
  });

  it('classifies notes and skips what GitVault does not sync', async () => {
    const existing = new Map([
      ['same.md', 'S'],
      ['diff.md', 'old'],
    ]);
    const plan = await planImport(
      [
        file('V/new/日記.md', 'N'),
        file('V/same.md', 'S'),
        file('V/diff.md', 'new'),
        file('V/.obsidian/app.json', '{}'),
        file('V/attachments/img.png', 'x'),
      ],
      (p) => existing.get(p),
    );
    expect(plan.added).toEqual([{ path: 'new/日記.md', content: 'N' }]);
    expect(plan.changed).toEqual([{ path: 'diff.md', content: 'new' }]);
    expect(plan.unchanged).toBe(1);
    expect(plan.skipped).toBe(2);
  });
});
