/**
 * Shared period-navigation helpers for the Tag/Woche/Monat/Jahr range pattern
 * (used by Historie and Marktpreise). Boundaries follow the API's Europe/Berlin
 * semantics; the labels are German. Keeping these in one place means both pages
 * step and label periods identically.
 */
import type { HistoryRange } from './api';

export const PERIOD_RANGES: { id: HistoryRange; label: string }[] = [
  { id: 'day', label: 'Tag' },
  { id: 'week', label: 'Woche' },
  { id: 'month', label: 'Monat' },
  { id: 'year', label: 'Jahr' },
];

/** Local calendar date as the API's `at` param (YYYY-MM-DD). */
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/** Shift the anchor one period in `dir` (-1 back, +1 forward). */
export function shiftAnchor(anchor: Date, range: HistoryRange, dir: 1 | -1): Date {
  const d = new Date(anchor);
  if (range === 'day') d.setDate(d.getDate() + dir);
  if (range === 'week') d.setDate(d.getDate() + 7 * dir);
  if (range === 'month') d.setMonth(d.getMonth() + dir, 1);
  if (range === 'year') d.setFullYear(d.getFullYear() + dir, 0, 1);
  return d;
}

/** ISO-8601 week number (Monday-start), for the week label. */
export function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/** Human label for the current period, e.g. "KW 27 · 30.06. - 06.07.". */
export function periodLabel(anchor: Date, range: HistoryRange): string {
  if (range === 'day') {
    return anchor.toLocaleDateString('de-DE', {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  }
  if (range === 'week') {
    const monday = new Date(anchor);
    const off = (monday.getDay() + 6) % 7;
    monday.setDate(monday.getDate() - off);
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);
    const fmt = (x: Date) => x.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    return `KW ${isoWeek(anchor)} · ${fmt(monday)} - ${fmt(sunday)}`;
  }
  if (range === 'month') {
    return anchor.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  }
  return String(anchor.getFullYear());
}
