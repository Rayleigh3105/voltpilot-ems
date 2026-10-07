import type { Ablesung, BezugsgroesseWert } from './api';
import { schluesselVon, spanneVon, tagPlus } from './bezugsPeriode';
import { istGanzzahlig, zuordnung } from './bezugsdaten';
import { zahlText } from './zahl';
import { lokalerTag } from './uemsOrtsbaum';

/**
 * „1.250.000“ · „3.284.100,5“ · „−40“ - Tausenderpunkt, Komma und echtes Minus wie jede UEMS-Zahl (AP-08 E11; Konzept
 * Messen m1, Befund „1 250 000“). Gerundet wird hier nicht: die Stellen sind die des eingetragenen Werts.
 */
export function betrag(text: string | number | null): string {
  if (text === null) return '— keine Werte';
  const roh = String(text);
  const negativ = roh.startsWith('-');
  const [g, b] = (negativ ? roh.slice(1) : roh).split('.');
  return (negativ ? '\u2212' : '') + g.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (b ? `,${b}` : '');
}
export const zeitText = (text: string, zone: string) => new Intl.DateTimeFormat('de-DE', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(text));
export function periodenText(key: string, art: string): string {
  if (art === 'monat') return new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${key}-01T00:00:00Z`));
  if (art === 'tag') return new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${key}T00:00:00Z`));
  return key;
}
export function letzteFreiePeriode(heute: string, art: string, werte: BezugsgroesseWert[]): string {
  let key = schluesselVon(heute, art);
  do { key = schluesselVon(tagPlus(spanneVon(key, art)[0], -1), art); }
  while (werte.some(w => w.periode_von === spanneVon(key, art)[0]));
  return key;
}
export function periodenFehler(key: string, art: string, heute: string): string | null {
  const muster: Record<string, RegExp> = { monat: /^\d{4}-(0[1-9]|1[0-2])$/, jahr: /^\d{4}$/, woche: /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/, tag: /^\d{4}-\d{2}-\d{2}$/ };
  if (!muster[art]?.test(key)) return 'Bitte wählen Sie eine Periode.';
  const [von, bis] = spanneVon(key, art);
  if (schluesselVon(von, art) !== key || !Number.isFinite(Date.parse(von)) || new Date(`${von}T00:00:00Z`).toISOString().slice(0, 10) !== von) return 'Bitte wählen Sie eine gültige Periode.';
  return bis >= heute ? 'Diese Periode ist noch nicht zu Ende.' : null;
}
export function wertFehler(text: string, einheit: string): string | null {
  const normal = zahlText(text);
  if (normal === null) return 'Bitte geben Sie eine Zahl ein, zum Beispiel 1.234,5.';
  if (normal.startsWith('-')) return 'Mengen sind nicht negativ.';
  if (istGanzzahlig(einheit) && normal.includes(',')) return `${einheit} sind ganze Zahlen.`;
  return null;
}
export function wirksameAblesungen(alle: Ablesung[]): Ablesung[] {
  const map = new Map<string, Ablesung>();
  for (const a of alle) if (!map.has(a.zeitpunkt) || map.get(a.zeitpunkt)!.fassung < a.fassung) map.set(a.zeitpunkt, a);
  return [...map.values()].sort((a, b) => a.zeitpunkt.localeCompare(b.zeitpunkt));
}
/** Nur der Vertragszwilling bildet Monatsanteile; die Fläche bildet keine Menge. */
export function monatsZuordnung(alle: Ablesung[], zeit: string | null, zone: string) {
  if (!zeit) return null;
  const vor = wirksameAblesungen(alle).filter(a => Date.parse(a.zeitpunkt) < Date.parse(zeit)).slice(-1)[0];
  return vor ? zuordnung(Date.parse(vor.zeitpunkt), Date.parse(zeit), zone) : null;
}

/**
 * „Zählt zum Oktober 2026 – dem Zeitraum seit der letzten Ablesung am 01.10.“ (Konzept Messen m1, §6.5): der Monat, zu
 * dem eine Ablesung zählt, wenn ihr Zeitraum in EINEM Monat liegt - statt „Ablesezeitraum: 4 Tage 21 h 37 min“.
 */
export function zaehltSatz(monat: string, letzte: string | null, zone: string): string {
  const m = periodenText(monat, 'monat');
  if (!letzte) return `Zählt zum ${m}.`;
  const [, mo, t] = lokalerTag(letzte, zone).split('-');
  return `Zählt zum ${m} – dem Zeitraum seit der letzten Ablesung am ${t}.${mo}.`;
}
