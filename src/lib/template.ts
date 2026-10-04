/**
 * Templates compatible with Obsidian's core Templates plugin:
 * {{title}}, {{date}}, {{time}}, {{date:FORMAT}}, {{time:FORMAT}} with moment-style tokens.
 */

const WEEKDAYS = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];
const TOKEN_RE = /\[([^\]]*)\]|dddd|ddd|YYYY|YY|MM|M|DD|D|HH|H|mm|ss/g;

export const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD';
export const DEFAULT_TIME_FORMAT = 'HH:mm';

export function dailySettings(cfg: { dailyFolder?: string; dailyFormat?: string; dailyTemplatePath?: string }) {
  return {
    folder: (cfg.dailyFolder ?? 'Daily').replace(/^\/+|\/+$/g, ''),
    format: cfg.dailyFormat || DEFAULT_DATE_FORMAT,
    templatePath: cfg.dailyTemplatePath || 'Templates/Daily.md',
  };
}

export const DEFAULT_DAILY_TEMPLATE = `# {{date:YYYY-MM-DD (ddd)}}

## やること
- [ ]

## メモ

`;

/** Format a date with the moment.js token subset daily notes need. `[text]` is literal. */
export function formatDate(date: Date, format: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return format.replace(TOKEN_RE, (token, literal: string | undefined) => {
    if (literal !== undefined) return literal;
    switch (token) {
      case 'YYYY': return String(date.getFullYear());
      case 'YY': return String(date.getFullYear()).slice(-2);
      case 'MM': return pad(date.getMonth() + 1);
      case 'M': return String(date.getMonth() + 1);
      case 'DD': return pad(date.getDate());
      case 'D': return String(date.getDate());
      case 'HH': return pad(date.getHours());
      case 'H': return String(date.getHours());
      case 'mm': return pad(date.getMinutes());
      case 'ss': return pad(date.getSeconds());
      case 'dddd': return WEEKDAYS[date.getDay()];
      case 'ddd': return WEEKDAYS[date.getDay()][0];
      default: return token;
    }
  });
}

export function renderTemplate(template: string, vars: { title: string; date: Date }): string {
  return template.replace(/\{\{\s*(title|date|time)\s*(?::([^}]*))?\}\}/g, (_m, name: string, format: string | undefined) => {
    if (name === 'title') return vars.title;
    return formatDate(vars.date, format?.trim() || (name === 'date' ? DEFAULT_DATE_FORMAT : DEFAULT_TIME_FORMAT));
  });
}
