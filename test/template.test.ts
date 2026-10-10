import { describe, expect, it } from 'vitest';
import { dailySettings, formatDate, renderTemplate } from '../src/lib/template';

// 2026-10-04 is a Sunday
const d = new Date(2026, 9, 4, 9, 5, 7);

describe('formatDate', () => {
  it('supports the moment-style tokens daily notes use', () => {
    expect(formatDate(d, 'YYYY-MM-DD')).toBe('2026-10-04');
    expect(formatDate(d, 'YYYY年M月D日 (ddd)')).toBe('2026年10月4日 (日)');
    expect(formatDate(d, 'dddd HH:mm:ss')).toBe('日曜日 09:05:07');
    expect(formatDate(d, 'YYYY/MM/YYYY-MM-DD')).toBe('2026/10/2026-10-04');
  });
  it('outputs [bracketed] text literally', () => {
    expect(formatDate(d, '[Day] D [of] M')).toBe('Day 4 of 10');
  });
});

describe('renderTemplate', () => {
  it('fills Obsidian-compatible variables', () => {
    const tpl = '# {{title}}\n{{date}} {{time}}\n{{ date:YYYY年M月D日 }} {{time:H時}}';
    expect(renderTemplate(tpl, { title: '2026-10-04', date: d })).toBe('# 2026-10-04\n2026-10-04 09:05\n2026年10月4日 9時');
  });
  it('does not copy a template BOM into new notes', () => {
    expect(renderTemplate('\uFEFF# {{title}}', { title: 't', date: d })).toBe('# t');
  });
  it('leaves unknown placeholders untouched', () => {
    expect(renderTemplate('{{weather}}', { title: 't', date: d })).toBe('{{weather}}');
  });
});

describe('dailySettings', () => {
  it('defaults for configs saved before the feature existed', () => {
    expect(dailySettings({})).toEqual({ folder: 'Daily', format: 'YYYY-MM-DD', templatePath: 'Templates/Daily.md' });
    expect(dailySettings({ dailyFolder: '/Journal/' }).folder).toBe('Journal');
    expect(dailySettings({ dailyFolder: '' }).folder).toBe('');
  });
});
