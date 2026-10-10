/**
 * Token expiry warnings. GitHub reports a PAT's expiry in a response header, but does not
 * expose it to browsers (CORS), so the user enters the date shown when the token was created.
 */
export const TOKEN_WARN_DAYS = 7;

export type TokenStatus =
  | { kind: 'unknown' } // no expiry date entered
  | { kind: 'ok'; days: number }
  | { kind: 'soon'; days: number } // 0 = expires today
  | { kind: 'expired'; days: number }; // days < 0

/** Days from `now`'s local calendar date to `expiresOn` ("YYYY-MM-DD"). */
function daysUntil(expiresOn: string, now: Date): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiresOn);
  if (!m) return null;
  const expiry = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((expiry.getTime() - today.getTime()) / 86400_000);
}

export function tokenStatus(expiresOn: string | undefined, now = new Date()): TokenStatus {
  const days = expiresOn ? daysUntil(expiresOn, now) : null;
  if (days === null) return { kind: 'unknown' };
  if (days < 0) return { kind: 'expired', days };
  if (days <= TOKEN_WARN_DAYS) return { kind: 'soon', days };
  return { kind: 'ok', days };
}
