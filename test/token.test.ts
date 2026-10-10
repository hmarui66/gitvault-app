import { describe, expect, it } from 'vitest';
import { tokenStatus } from '../src/lib/token';

const now = new Date(2026, 9, 10, 23, 30); // late evening: must still count calendar days

describe('tokenStatus', () => {
  it('is unknown without a valid date', () => {
    expect(tokenStatus(undefined, now)).toEqual({ kind: 'unknown' });
    expect(tokenStatus('2026/10/20', now)).toEqual({ kind: 'unknown' });
  });
  it('warns from 7 days before through the expiry day', () => {
    expect(tokenStatus('2026-10-18', now)).toEqual({ kind: 'ok', days: 8 });
    expect(tokenStatus('2026-10-17', now)).toEqual({ kind: 'soon', days: 7 });
    expect(tokenStatus('2026-10-10', now)).toEqual({ kind: 'soon', days: 0 });
  });
  it('reports expiry once the date has passed', () => {
    expect(tokenStatus('2026-10-09', now)).toEqual({ kind: 'expired', days: -1 });
  });
  it('counts across month boundaries', () => {
    expect(tokenStatus('2026-11-02', new Date(2026, 9, 31))).toEqual({ kind: 'soon', days: 2 });
  });
});
