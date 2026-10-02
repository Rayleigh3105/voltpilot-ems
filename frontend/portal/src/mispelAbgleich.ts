import { request } from './api';
import { NBSP, eurAmount } from './format';
import { kwhText, monatName } from './mispelMengen';

/**
 * Abgleich Gerät ↔ Messstellenbetreiber (MiSpeL MP-15, Bedienkonzept BK-15 Variante A). Nur Formatierung und der
 * Client der drei Routen — jede Zahl und jede Ampel kommt fertig aus der API (`MsbAbgleichService`). Maßgeblich bleiben
 * die Werte des Messstellenbetreibers (Tenor S. 28): der Abgleich erklärt, er ersetzt nichts.
 */

export type Ampel = 'gruen' | 'gelb' | 'rot' | 'grau';

export interface AbgleichErgebnis {
  geraetKwh: number | null;
  msbKwh: number | null;
  unterschiedKwh: number | null;
  abweichungProzent: number | null;
  ampel: Ampel;
  grund: 'keine_msb_werte' | 'keine_geraetewerte' | 'luecke' | 'zaehlerwechsel' | null;
}

export interface FarbeWirkung {
  farbe: 'gruen' | 'gelb' | 'rot' | 'grau';
  formel: string;
  begriff: string;
  vorherKwh: number | null;
  nachherKwh: number | null;
}

export interface Wirkung {
  schluessel: string;
  vorherFassung: number;
  vorherWertequelle: string;
  farben: FarbeWirkung[];
  saldierungVorherEur: number | null;
  saldierungNachherEur: number | null;
  differenzEur: number | null;
}

export interface Schwellen {
  gruenBisProzent: number;
  gelbBisProzent: number;
}

export interface AbgleichZaehler {
  groesse: string;
  rolle: string;
  richtung: string;
  messstelleId: string;
  messstelle: string;
  zaehlpunkt: string | null;
  messstellenbetreiber: string | null;
  abgleich: AbgleichErgebnis | null;
}

export interface AbgleichMonat {
  monat: string;
  zaehler: AbgleichZaehler[];
  groessteAbweichung: string | null;
  wirkung: Wirkung | null;
  schwellen: Schwellen;
}

export interface MsbImport {
  id: string;
  dateiname: string | null;
  viertelstunden: number;
  ersetzt: number;
  von: string;
  bis: string;
  importiertAm: string;
  importiertVon: string | null;
}

export interface MessstelleAbgleich {
  messstelleId: string;
  messstelle: string;
  rolle: string | null;
  festlegungsgroesse: string | null;
  richtung: 'bezug' | 'abgabe' | null;
  zaehlpunkt: string | null;
  messstellenbetreiber: string | null;
  wertequelle: string | null;
  anlage: string | null;
  monate: { monat: string; zaehlpunkt: string; abgleich: AbgleichErgebnis; wirkung: Wirkung | null }[];
  importe: MsbImport[];
  schwellen: Schwellen;
}

export interface Eingelesen {
  importDatei: MsbImport;
  neu: boolean;
  zaehlpunkte: string[];
  richtungen: string[];
}

export const abgleichApi = {
  monat: (siteId: string, monat: string) =>
    request<AbgleichMonat>(`/api/v1/sites/${siteId}/mispel/abgrenzung/monate/${monat}/abgleich`),
  messstelle: (id: string) => request<MessstelleAbgleich>(`/api/v1/messstellen/${id}/msb-abgleich`),
  einlesen: (id: string, datei: File) => {
    const body = new FormData();
    body.append('datei', datei);
    return request<Eingelesen>(`/api/v1/messstellen/${id}/msb-werte`, { method: 'POST', body });
  },
};

// ------------------------------------------------------------------ Wörter

export const AMPEL_WORT: Record<Ampel, string> = {
  gruen: 'grün',
  gelb: 'gelb',
  rot: 'rot',
  grau: 'nicht vergleichbar',
};

export function grundWort(grund: AbgleichErgebnis['grund']): string {
  switch (grund) {
    case 'keine_msb_werte':
      return 'noch keine Werte des Messstellenbetreibers';
    case 'keine_geraetewerte':
      return 'keine Gerätewerte';
    case 'luecke':
      return 'Lücke';
    case 'zaehlerwechsel':
      return 'Zählerwechsel';
    default:
      return '';
  }
}

/** „Z2 · Entladen“ — Rolle der Festlegung und Richtung der Messstelle. */
export function zaehlerName(z: Pick<AbgleichZaehler, 'rolle' | 'richtung'>): string {
  return `${z.rolle} · ${z.richtung}`;
}

/** „am Speicherzähler (Entladen)“ für den Satz in der Monatskarte. */
export function zaehlerImSatz(z: Pick<AbgleichZaehler, 'rolle' | 'richtung'>): string {
  const wer = z.rolle === 'Z1' ? 'Netzanschlusszähler' : z.rolle === 'Z2' ? 'Speicherzähler' : `Zähler ${z.rolle}`;
  return `Am ${wer} (${z.richtung})`;
}

export function prozentText(p: number | null | undefined): string {
  if (p == null) return '—';
  const s = Math.abs(p).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${p < 0 ? '−' : p > 0 ? '+' : '±'}${s}${NBSP}%`;
}

export function unterschiedText(e: AbgleichErgebnis): string {
  if (e.unterschiedKwh == null) return '—';
  const kwh = Math.round(e.unterschiedKwh);
  const s = Math.abs(kwh).toLocaleString('de-DE');
  return `${kwh < 0 ? '−' : kwh > 0 ? '+' : '±'}${s}${NBSP}kWh (${prozentText(e.abweichungProzent)})`;
}

export function eurText(v: number | null | undefined): string {
  if (v == null) return 'offen';
  return `${v < 0 ? '−' : '+'}${NBSP}${eurAmount(Math.abs(v))}`;
}

const FARBE_WORT: Record<FarbeWirkung['farbe'], string> = { gruen: 'Grün', gelb: 'Gelb', rot: 'Rot', grau: 'Grau' };

/** „Rot (16) 2.270 kWh → 2.050 kWh“. */
export function farbeText(f: FarbeWirkung): string {
  const nr = f.formel ? ` ${f.formel}` : '';
  return `${FARBE_WORT[f.farbe]}${nr}`;
}

/** Die Farbe mit der größten Änderung — für die Tabelle an der Messstelle. */
export function groessteFarbe(w: Wirkung): FarbeWirkung | null {
  let beste: FarbeWirkung | null = null;
  let d = -1;
  for (const f of w.farben) {
    if (f.vorherKwh == null || f.nachherKwh == null) continue;
    const x = Math.abs(f.nachherKwh - f.vorherKwh);
    if (x > d) {
      d = x;
      beste = f;
    }
  }
  return beste;
}

/** Der kurze Wirkungstext einer Zeile: „Rot (16) 2.270 → 2.050 kWh · Saldierung −23 €“. */
export function wirkungKurz(w: Wirkung | null): string {
  if (!w) return '—';
  const f = groessteFarbe(w);
  const teile: string[] = [];
  if (f) teile.push(`${farbeText(f)} ${kwhText(f.vorherKwh).replace(`${NBSP}kWh`, '')} → ${kwhText(f.nachherKwh)}`);
  teile.push(`Saldierung ${eurText(w.differenzEur)}`);
  return teile.join(' · ');
}

/**
 * Der Satz der Monatskarte (BK-15 A): die größte Abweichung, ihre Ampel und ihre Wirkung — oder warum nichts
 * vergleichbar ist. `null`, solange der Messstellenbetreiber für den Monat noch keine Werte geliefert hat.
 */
export function satz(a: AbgleichMonat): { ampel: Ampel; kopf: string; text: string } | null {
  const mitMsb = a.zaehler.filter((z) => z.abgleich?.msbKwh != null);
  if (mitMsb.length === 0) return null;
  const g = a.zaehler.find((z) => z.groesse === a.groessteAbweichung);
  const massgeblich = 'Abgerechnet wird mit den Werten des Messstellenbetreibers';
  if (!g || !g.abgleich) {
    const grau = mitMsb.find((z) => z.abgleich?.grund) ?? mitMsb[0];
    return {
      ampel: 'grau',
      kopf: 'Gerät ↔ Messstellenbetreiber: nicht vergleichbar.',
      text: `${zaehlerImSatz(grau)}: ${grundWort(grau.abgleich?.grund ?? null)}. ${massgeblich}.`,
    };
  }
  const e = g.abgleich;
  let wirkung = '';
  const d = a.wirkung?.differenzEur;
  if (d != null) {
    wirkung = d === 0 ? '; die Saldierung bleibt gleich'
      : `; die Saldierung ist dadurch ${eurAmount(Math.abs(d))} ${d < 0 ? 'niedriger' : 'höher'} als in der Vorschau`;
  }
  return {
    ampel: e.ampel,
    kopf: `Gerät ↔ Messstellenbetreiber: ${AMPEL_WORT[e.ampel]}.`,
    text: `${zaehlerImSatz(g)} liegen beide ${prozentText(e.abweichungProzent)} auseinander. ${massgeblich}${wirkung}.`,
  };
}

export function schwellenText(s: Schwellen): string {
  const p = (x: number) => `${x.toLocaleString('de-DE')}${NBSP}%`;
  return `bis ${p(s.gruenBisProzent)} grün · bis ${p(s.gelbBisProzent)} gelb · darüber rot · grau: nicht vergleichbar (Lücke, Zählerwechsel, noch keine Werte). Die Festlegung nennt keine Schwellen; es ist ein Vorschlag von VoltPilot.`;
}

export { kwhText, monatName };
