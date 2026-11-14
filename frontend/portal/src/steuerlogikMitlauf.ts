/**
 * Steuerlogik Stufe 2, das Blatt der Plattform: reine Ableitungen aus dem Blatt und dem Vergleichsprotokoll
 * (docs/contracts/v2/steuerlogik-rueckmeldung.md). Eine mitlaufende Logik schaltet nichts — das Blatt zeigt, was sie
 * schalten würde, neben dem, was geschaltet ist. Unbekannt bleibt unbekannt, nie „aus“.
 */
import { ApiError, type SteuerlogikBericht, type SteuerlogikLogik, type SteuerlogikStand } from './api';

/** Ein Schaltstand in Worten; `null` heißt unbekannt. */
export function standText(s: SteuerlogikStand | null | undefined): string {
  if (!s) return 'unbekannt';
  const teile: string[] = [];
  if (s.stufe != null) teile.push(s.stufe === 0 ? 'aus' : `Stufe ${s.stufe}`);
  if (s.ein != null) teile.push(s.ein ? 'an' : 'aus');
  if (s.sollwert != null) teile.push(`Sollwert ${zahl(s.sollwert)}`);
  if (s.betriebsart) teile.push(s.betriebsart);
  if (s.anteil != null) teile.push(`${zahl(s.anteil)} %`);
  return teile.length > 0 ? teile.join(', ') : 'unbekannt';
}

function zahl(v: number): string {
  return v.toLocaleString('de-DE', { maximumFractionDigits: 1 }).replace('-', '−');
}

/** Eine Dauer in Sekunden, knapp: „45 s“, „12 min“, „2 h 05 min“. */
export function dauer(s: number): string {
  if (s < 120) return `${s} s`;
  if (s < 7200) return `${Math.floor(s / 60)} min`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h} h ${String(m).padStart(2, '0')} min`;
}

/** Die Uhrzeit eines Zeitstempels in der Zone der Anlage. */
export function uhrzeit(iso: string): string {
  return new Date(iso).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Die Abweichung je Gerät als Satz: „61 s von 22 min verschieden“, ohne Vergleich ein ehrlicher Grund. */
export function abweichungSatz(abweichend: number, verglichen: number): string {
  if (verglichen === 0) return 'noch nicht verglichen (eine Seite unbekannt)';
  if (abweichend === 0) return `gleich, seit ${dauer(verglichen)} verglichen`;
  return `${dauer(abweichend)} von ${dauer(verglichen)} verschieden`;
}

/** Was die Box zur Logik quittiert hat. */
export function quittungSatz(l: SteuerlogikLogik, laufendeFassung: number | null): { text: string; ton: 'ok' | 'warn' | 'leise' } {
  const q = l.quittung;
  if (!q) return { text: 'Noch keine Quittung der Box', ton: 'leise' };
  if (laufendeFassung != null && q.fassung !== laufendeFassung) {
    return { text: `Box quittiert noch Fassung ${q.fassung}`, ton: 'warn' };
  }
  if (q.zustand === 'active') return { text: `Box hat Fassung ${q.fassung} angenommen`, ton: 'ok' };
  return { text: `Box lehnt ab: ${q.detail ?? q.zustand}`, ton: 'warn' };
}

/** Die laufende Fassung einer Logik, sonst `null` (stillgelegt). */
export function laufendeFassung(l: SteuerlogikLogik): number | null {
  return l.fassungen.find((f) => f.zustand === 'mitlaufend')?.fassung ?? null;
}

/** Die Sätze einer Ablehnung der Annahme: Grund, dazu Befunde und nicht bestandene Proben des Berichts. */
export function ablehnungSaetze(e: unknown): string[] {
  if (!(e instanceof ApiError)) return ['Die Logik konnte nicht übergeben werden. Bitte erneut versuchen.'];
  const body = (e.body && typeof e.body === 'object' ? e.body : {}) as { message?: unknown; bericht?: SteuerlogikBericht };
  const out = [typeof body.message === 'string' ? body.message : e.message];
  for (const b of body.bericht?.befunde ?? []) out.push(b);
  for (const p of body.bericht?.proben ?? []) {
    if (p.besteht) continue;
    const a = p.abweichungen[0];
    out.push(a ? `Probe „${p.name}“: ${a.stelle} ist ${a.ist}, erwartet ${a.soll}` : `Probe „${p.name}“ besteht nicht`);
  }
  return out;
}

/** Der Tag der Anlage (Europe/Berlin) eines Zeitpunkts als JJJJ-MM-TT. */
export function tagDerAnlage(jetzt: Date): string {
  return jetzt.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
}
