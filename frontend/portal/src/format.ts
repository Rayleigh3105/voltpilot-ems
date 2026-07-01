/** Shared German formatting helpers for the portal. */

export function eur(v: number): string {
  return v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "vor 4 Sek." / "vor 12 Min." / "vor 3 Std." / date - or "noch nie". */
export function fmtRelative(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'noch nie';
  const diffS = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 1000);
  if (diffS < 60) return `vor ${Math.round(diffS)} Sek.`;
  if (diffS < 3600) return `vor ${Math.round(diffS / 60)} Min.`;
  if (diffS < 86400) return `vor ${Math.round(diffS / 3600)} Std.`;
  return new Date(iso).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function fmtNum(v: number | null | undefined, unit: string, digits = 1): string {
  return v == null ? '-' : `${Number(v).toFixed(digits)} ${unit}`;
}
