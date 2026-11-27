/**
 * Die Schaltspur als Zeilen für „Technik & Diagnose" (nur Plattform-Administration): wo die Zeit zwischen Klick und
 * bestätigtem Zustand hingeht, Abschnitt für Abschnitt. Rein; die Komponente rendert nur.
 *
 * Zwei Uhren bleiben getrennt: Abschnitte der API (Anfrage, Senden, Herzschläge) in der Uhr der API, die Schritte der
 * Box in IHRER Uhr - nur als Abstände ab ihrem eigenen Empfang, nie gegen die Uhr der API verrechnet. Fehlt ein
 * Zeitpunkt, steht dort, warum, nie eine erfundene Null.
 */
import type { SchaltSpur } from './consumersApi';
import { CONSUMER_REASON_TEXT } from './status';

export interface SpurZeile {
  label: string;
  wert: string;
}

export interface SpurAnsicht {
  titel: string;
  ergebnis: string;
  zeilen: SpurZeile[];
}

const ZAHL = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

/** 180 ms, 2,4 s, 1 min 05 s. */
export function dauer(ms: number): string {
  if (ms < 0) return `${dauer(-ms)} vor`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${ZAHL.format(ms / 1000)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

function ms(von: string | null, bis: string | null): number | null {
  if (!von || !bis) return null;
  const d = new Date(bis).getTime() - new Date(von).getTime();
  return Number.isFinite(d) ? d : null;
}

function uhr(iso: string): string {
  return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function wunschText(s: SchaltSpur): string {
  if (s.art === 'zurueck') return 'Automatik fortsetzen';
  if (s.art === 'stop') return 'Aus';
  if (s.ausgaenge && s.ausgaenge.length > 0) return `An (Ausgänge ${s.ausgaenge.join(', ')})`;
  return 'An';
}

function grundText(code: string | null): string {
  if (!code) return 'ohne Grund';
  return CONSUMER_REASON_TEXT[code] ?? code;
}

const ZUSTELLUNG: Record<string, string> = {
  control_disabled: 'Steuerung nicht aktiviert',
  publisher_unavailable: 'Zustellung nicht verfügbar',
  publish_failed: 'Zustellung abgelehnt',
};

export function spurAnsicht(s: SchaltSpur): SpurAnsicht {
  const zeilen: SpurZeile[] = [];
  if (s.portalAntwortMs != null) zeilen.push({ label: 'Portal: Klick bis Antwort', wert: dauer(s.portalAntwortMs) });
  const senden = ms(s.apiEingang, s.gesendet);
  zeilen.push({
    label: 'API: Anfrage bis gesendet',
    wert: senden != null ? dauer(senden) : `nicht gesendet (${ZUSTELLUNG[s.zustellung ?? ''] ?? s.zustellung ?? 'unbekannt'})`,
  });
  const erste = ms(s.gesendet, s.ersteMeldung);
  zeilen.push({
    label: 'Gesendet bis erster Herzschlag',
    wert: erste != null ? dauer(erste) : s.gesendet ? 'noch kein Herzschlag' : '-',
  });
  if (s.boxEmpfangen) {
    const ab = (t: string | null, wort: string) => {
      const d = ms(s.boxEmpfangen, t);
      return d != null ? `${wort} +${dauer(d)}` : null;
    };
    const teile = [ab(s.boxEntschieden, 'entschieden'), ab(s.boxGeschrieben, 'geschrieben'),
      ab(s.boxZurueckgelesen, 'zurückgelesen'), ab(s.boxGemeldet, 'Herzschlag')].filter(Boolean);
    if (!s.boxGeschrieben && s.boxUrteil?.startsWith('held')) teile.push('nichts geschrieben (gehalten)');
    zeilen.push({ label: 'Box (eigene Uhr, ab Empfang)', wert: teile.join(' · ') || 'empfangen' });
  } else if (s.ersteMeldung) {
    zeilen.push({ label: 'Box', wert: 'meldet keine eigenen Zeitpunkte (Software vor der Schaltspur)' });
  }
  const gehalten = ms(s.gesendet, s.gehalten);
  if (gehalten != null) {
    zeilen.push({ label: 'Gesendet bis gehalten', wert: `${dauer(gehalten)} · ${grundText(s.grund)}` });
  }
  const bestaetigt = ms(s.gesendet, s.bestaetigt);
  if (bestaetigt != null) zeilen.push({ label: 'Gesendet bis bestätigt', wert: dauer(bestaetigt) });
  if (s.portalSichtbarMs != null) {
    zeilen.push({ label: 'Portal: Klick bis bestätigt sichtbar', wert: dauer(s.portalSichtbarMs) });
  }

  const gesamt = s.portalSichtbarMs ?? ms(s.apiEingang, s.bestaetigt);
  const ergebnis = s.ergebnis === 'bestaetigt'
    ? `bestätigt${gesamt != null ? ` nach ${dauer(gesamt)}` : ''}`
    : s.ergebnis === 'gehalten' ? `gehalten: ${grundText(s.grund)}`
      : s.ergebnis === 'abweichung' ? `Abweichung: ${grundText(s.grund)}`
        : s.ergebnis === 'ersetzt' ? 'durch einen neueren Tipp ersetzt'
          : 'noch nicht bestätigt';
  return { titel: `${uhr(s.apiEingang)} · ${wunschText(s)}`, ergebnis, zeilen };
}
