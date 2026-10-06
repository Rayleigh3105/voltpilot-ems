/**
 * Verbessern-Konzept v1 §6.9 (Richtungsfrage 9.3 A): „Maßnahme planen“ in vier kurzen Schritten — 1 Was ist zu tun?
 * und wie zeigt sich die Wirkung (Entscheid 6), 2 Was soll es bringen? (Prozent mit Umrechnung in kWh, „Weiß ich noch
 * nicht“, Begründung, Vorher-Monat; Entscheide 12, 13), 3 Wer und bis wann?, 4 Prüfen. Am Rechner dieselben Fragen als
 * ein Dialog. Hier steht nur die Form: Vorbelegung, Prüfung je Schritt (Ablehnungen vor dem Senden statt danach) und
 * die Anfrage; entschieden wird an der Route. „Heute“ ist der Tag der Route (eine Uhr, Befund 2).
 */
import type { Kennzahl, MassnahmeArt, MassnahmeNeu } from './api';
import { monatWort } from './bezugsbasisVergleich';
import { tag, zielwertAusEingabe } from './energieziele';
import { NBSP } from './format';
import { UEMS_MASSNAHME } from './glossar';
import {
  AUSGANGSLAGE_HOECHSTENS_MONATE,
  HERKUNFT_WORT,
  letzterAbgeschlossenerMonat,
  monateAus,
  monateText,
  monateWert,
  type MassnahmeVorbelegung,
} from './massnahmen';
import { tageNoch, tageWort, tageZwischen } from './massnahmenBild';

export const TITEL = `${UEMS_MASSNAHME} planen`;
export const KNOPF_ANLEGEN = `${UEMS_MASSNAHME} anlegen`;
export const WEITER = 'Weiter';
export const ZURUECK = 'Zurück';
export const ABBRECHEN = 'Abbrechen';
export const AENDERN = 'Ändern';
export const WEISS_NICHT = 'Weiß ich noch nicht';
export const ANDERER_MONAT = 'Anderen Monat wählen';
export const ANDERER_TAG = 'Anderer Tag';

export type Schritt = 1 | 2 | 3 | 4;
export const SCHRITTE: readonly Schritt[] = [1, 2, 3, 4];
/** Die Frage je Schritt (Überschrift des Blatts) und das kurze Wort rechts über der Leiste. */
export const SCHRITT_FRAGE: Record<Schritt, string> = {
  1: TITEL,
  2: 'Was soll es bringen?',
  3: 'Wer und bis wann?',
  4: 'Prüfen und anlegen',
};
export const SCHRITT_WORT: Record<Schritt, string> = { 1: 'Was?', 2: 'Wirkung', 3: 'Termin', 4: 'Prüfen' };

/** Entscheid 6: die drei Antworten auf „Wie zeigt sich die Wirkung?“. */
export const ART_WAHL: Record<MassnahmeArt, { wort: string; satz: string }> = {
  gemessen: { wort: 'An einer Kennzahl gemessen', satz: 'VoltPilot vergleicht nach der Umsetzung mit der Bezugsbasis.' },
  nicht_gemessen: {
    wort: 'Spart Energie, wird aber nicht gemessen',
    satz: 'zum Beispiel Druckluft, solange sie keine Kennzahl hat',
  },
  organisatorisch: { wort: 'Organisatorisch', satz: 'regelt Zuständigkeiten, Abläufe oder Schulungen' },
};

export interface Entwurf {
  titel: string;
  art: MassnahmeArt;
  kennzahl: string;
  /** Prozent weniger als erwartet, wie getippt („3“, „2,5“). */
  prozent: string;
  /** Die Schätzung in kWh im Jahr ohne Kennzahl, wie getippt („12000“, „12.000“). */
  kwh: string;
  weissNicht: boolean;
  wortlaut: string;
  von: string;
  bis: string;
  einsatz: string;
  energieziel: string;
  standort: string;
  verantwortlich: string;
  termin: string;
}

/** Was die Vorbelegung über die Art sagt: mit Kennzahl gemessen, aus Feststellung oder Audit organisatorisch. */
export function artAus(v: MassnahmeVorbelegung, mitBasis: boolean): MassnahmeArt {
  if (v.kennzahl) return 'gemessen';
  if (v.herkunft === 'nichtkonformitaet' || v.herkunft === 'audit') return 'organisatorisch';
  if (v.herkunft === 'einsatz') return 'nicht_gemessen';
  return mitBasis ? 'gemessen' : 'nicht_gemessen';
}

export function entwurfAus(v: MassnahmeVorbelegung, heute: string, mitBasis = true): Entwurf {
  const [von, bis] = monateAus(v.monate, heute);
  return {
    titel: v.titel ?? '',
    art: artAus(v, mitBasis),
    kennzahl: v.kennzahl ?? '',
    prozent: '',
    kwh: '',
    weissNicht: false,
    wortlaut: '',
    von,
    bis,
    einsatz: v.einsatz ?? '',
    energieziel: v.energieziel ?? '',
    standort: '',
    verantwortlich: '',
    termin: '',
  };
}

/** Die Herkunft als Satz über dem Blatt: „aus der Feststellung F-2029-0001“; von Hand nichts. */
export function herkunftZeile(v: MassnahmeVorbelegung): string | null {
  if (v.herkunft === 'von_hand' || v.herkunft === 'energieziel') return null;
  return `${HERKUNFT_WORT[v.herkunft]}${v.herkunftKennung ? ` ${v.herkunftKennung}` : ''}`;
}

// ------------------------------------------------------------------ Zahlen der Eingabe

/** „3“ oder „2,5“ (Prozent weniger) → wie im Vertrag, weniger negativ; ungültig `null`. */
export const prozentAusEingabe = zielwertAusEingabe;

/** „12000“, „12.000“ oder „12 000“ → ganze kWh > 0; ungültig `null`. */
export function kwhAusEingabe(text: string): number | null {
  const t = text.replace(/[\s.  ]/g, '');
  if (!/^\d{1,12}$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}

// ------------------------------------------------------------------ Termin per Schnellwahl

/** Der letzte Tag des Monats von `jjjjmm`. */
function monatsende(jjjjmm: string): string {
  const j = Number(jjjjmm.slice(0, 4));
  const m = Number(jjjjmm.slice(5, 7));
  const letzter = new Date(Date.UTC(j, m, 0)).getUTCDate();
  return `${jjjjmm}-${String(letzter).padStart(2, '0')}`;
}

function plusMonate(jjjjmm: string, n: number): string {
  const j = Number(jjjjmm.slice(0, 4));
  const m = Number(jjjjmm.slice(5, 7)) - 1 + n;
  return `${j + Math.floor(m / 12)}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
}

/**
 * „Ende Mai · Ende Juni · Ende September“: das Ende des nächsten und des übernächsten Monats und das Ende des nächsten
 * Quartals danach — vom Tag der Route aus, nie in der Vergangenheit.
 */
export function terminVorschlaege(heute: string): { wert: string; wort: string }[] {
  const dieser = heute.slice(0, 7);
  const kandidaten = [plusMonate(dieser, 1), plusMonate(dieser, 2)];
  const quartal = (() => {
    let m = plusMonate(dieser, 3);
    while (![3, 6, 9, 12].includes(Number(m.slice(5, 7)))) m = plusMonate(m, 1);
    return m;
  })();
  if (!kandidaten.includes(quartal)) kandidaten.push(quartal);
  return kandidaten.map((m) => ({ wert: monatsende(m), wort: `Ende ${monatWort(m).split(' ')[0]}` }));
}

/** „Termin 30.06.2029 - noch 61 Tage. Danach steht die Maßnahme als überfällig in der Wiedervorlage.“ */
export function terminSatz(termin: string, heute: string): string {
  const rest = tageZwischen(heute, termin);
  const wann = rest > 0 ? `noch ${tageNoch(rest)}` : rest === 0 ? 'heute' : `schon seit ${tageWort(-rest)} vorbei`;
  return `Termin ${tag(termin)} - ${wann}. Danach steht die ${UEMS_MASSNAHME} als überfällig in der Wiedervorlage.`;
}

// ------------------------------------------------------------------ Vorher (Ausgangslage)

/** Höchstens zwölf abgeschlossene Monate vor heute (wie die Route, `MassnahmeService.AUSGANGSLAGE_HOECHSTENS_MONATE`). */
export const AUSGANGSLAGE_HOECHSTENS = AUSGANGSLAGE_HOECHSTENS_MONATE;

export function vorherMonate(heute: string): { value: string; label: string }[] {
  const letzter = letzterAbgeschlossenerMonat(heute);
  return Array.from({ length: AUSGANGSLAGE_HOECHSTENS }, (_, i) => {
    const m = plusMonate(letzter, -i);
    return { value: m, label: monatWort(m) };
  });
}

export const vorherText = (e: Pick<Entwurf, 'von' | 'bis'>) => monateText(e.von, e.bis);

// ------------------------------------------------------------------ Prüfen je Schritt

export type Fehler = Partial<Record<'titel' | 'kennzahl' | 'prozent' | 'kwh' | 'wortlaut' | 'monate' | 'verantwortlich' | 'termin', string>>;

const ZEHN_STELLEN = 'Eine Zahl zwischen 0 und 100 mit höchstens einer Stelle nach dem Komma, zum Beispiel 3 oder 2,5.';

/** Die Form-Regeln eines Schritts (4 = alle); was die Route sicher ablehnen würde, steht vor dem Senden da. */
export function pruefen(e: Entwurf, schritt: Schritt, heute: string): Fehler {
  const f: Fehler = {};
  if (schritt === 1 || schritt === 4) {
    if (!e.titel.trim()) f.titel = `Bitte sagen Sie in einem Satz, was zu tun ist.`;
    if (e.art === 'gemessen' && !e.kennzahl) f.kennzahl = 'Bitte wählen Sie die Kennzahl, an der gemessen wird.';
  }
  if (schritt === 2 || schritt === 4) {
    if (e.art === 'gemessen' && !e.weissNicht) {
      const p = prozentAusEingabe(e.prozent);
      if (p === null || p === 0) f.prozent = e.prozent.trim() ? ZEHN_STELLEN : `Bitte eine Zahl - oder „${WEISS_NICHT}“.`;
    }
    if (e.art === 'nicht_gemessen' && !e.weissNicht && e.kwh.trim() && kwhAusEingabe(e.kwh) === null) {
      f.kwh = 'Eine ganze Zahl in kWh im Jahr, zum Beispiel 12.000.';
    }
    if (!e.wortlaut.trim()) {
      f.wortlaut = e.art === 'organisatorisch' ? 'Bitte sagen Sie in einem Satz, was sich ändern soll.' : 'Bitte sagen Sie in einem Satz, warum Sie das erwarten.';
    }
    if (e.art === 'gemessen') {
      const letzter = letzterAbgeschlossenerMonat(heute);
      const erlaubt = new Set(vorherMonate(heute).map((m) => m.value));
      if (e.von > e.bis) f.monate = 'Der erste Monat liegt vor dem letzten.';
      else if (!erlaubt.has(e.von) || !erlaubt.has(e.bis) || e.bis > letzter) {
        f.monate = `Vorher sind abgeschlossene Monate, höchstens ${AUSGANGSLAGE_HOECHSTENS}.`;
      }
    }
  }
  if (schritt === 3 || schritt === 4) {
    if (!e.verantwortlich) f.verantwortlich = 'Bitte wählen Sie, wer sich kümmert.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.termin)) f.termin = 'Bitte wählen Sie, bis wann.';
  }
  return f;
}

/** Die Anfrage an `POST /api/v1/massnahmen` — ohne Kennzahl nie eine Zahl in Prozent, mit Kennzahl nie kWh. */
export function anfrage(e: Entwurf, v: MassnahmeVorbelegung, einstufungFassung?: number): MassnahmeNeu {
  const gemessen = e.art === 'gemessen';
  const prozent = gemessen && !e.weissNicht ? prozentAusEingabe(e.prozent) : null;
  const kwh = e.art === 'nicht_gemessen' && !e.weissNicht && e.kwh.trim() ? kwhAusEingabe(e.kwh) : null;
  const mitKennung = ['abweichung', 'nichtkonformitaet', 'audit', 'managementbewertung'].includes(v.herkunft);
  return {
    titel: e.titel.trim(),
    verantwortlich: e.verantwortlich,
    termin: e.termin,
    herkunft: v.herkunft,
    ...(mitKennung && v.herkunftKennung ? { herkunft_kennung: v.herkunftKennung } : {}),
    art: e.art,
    ...(gemessen ? { kennzahl: e.kennzahl, monate: monateWert(e.von, e.bis) } : {}),
    ...(!gemessen && e.standort ? { standort: e.standort } : {}),
    ...(e.einsatz ? { einsatz: e.einsatz } : {}),
    ...(e.einsatz && einstufungFassung !== undefined && e.einsatz === v.einsatz ? { einstufung_fassung: einstufungFassung } : {}),
    ...(gemessen && e.energieziel ? { energieziel: e.energieziel } : {}),
    ...(prozent !== null && prozent !== 0 ? { erwartete_wirkung_prozent: prozent } : {}),
    ...(kwh !== null ? { erwartete_einsparung_kwh_jahr: kwh } : {}),
    erwartete_wirkung_wortlaut: e.wortlaut.trim(),
  };
}

// ------------------------------------------------------------------ Zusammenfassung (Schritt 4 bzw. rechts am Rechner)

export interface Zeile {
  schritt: Schritt;
  titel: string;
  wert: string;
  klein: string | null;
}

/** „So wird sie angelegt“: Was · Wirkung · Erwartet · Für · Wer und bis wann — je Zeile mit dem Schritt, der sie ändert. */
export function zusammenfassung(
  e: Entwurf,
  namen: { kennzahl: string | null; energieziel: string | null; person: string | null; vorher: string | null; kwhJahr: string | null },
): Zeile[] {
  const zeilen: Zeile[] = [{ schritt: 1, titel: 'Was', wert: e.titel.trim() || '—', klein: null }];
  zeilen.push({
    schritt: 1,
    titel: 'Wirkung',
    wert: e.art === 'gemessen' ? `gemessen an ${namen.kennzahl ?? 'einer Kennzahl'}` : ART_WAHL[e.art].wort,
    klein: e.art === 'gemessen' ? (namen.vorher ? `Vorher: ${namen.vorher}` : `Vorher: ${vorherText(e)}`) : null,
  });
  if (e.art !== 'organisatorisch') {
    const p = prozentAusEingabe(e.prozent);
    const kwh = kwhAusEingabe(e.kwh);
    const wert = e.weissNicht
      ? WEISS_NICHT
      : e.art === 'gemessen'
        ? p
          ? `${String(Math.abs(p)).replace('.', ',')}${NBSP}% weniger${namen.kwhJahr ? `, rund ${namen.kwhJahr}${NBSP}kWh im Jahr` : ''}`
          : '—'
        : kwh
          ? `rund ${kwh.toLocaleString('de-DE')}${NBSP}kWh im Jahr, geschätzt`
          : 'ohne Zahl';
    zeilen.push({ schritt: 2, titel: 'Erwartet', wert, klein: e.wortlaut.trim() ? `‚${e.wortlaut.trim()}‘` : null });
  } else {
    zeilen.push({ schritt: 2, titel: 'Soll sich ändern', wert: e.wortlaut.trim() || '—', klein: null });
  }
  if (namen.energieziel) zeilen.push({ schritt: 1, titel: 'Für', wert: namen.energieziel, klein: null });
  zeilen.push({
    schritt: 3,
    titel: 'Wer und bis wann',
    wert: `${namen.person ?? '—'}${e.termin ? ` · bis ${tag(e.termin)}` : ''}`,
    klein: null,
  });
  return zeilen;
}

export const DANACH = `Danach: Melden Sie die Umsetzung, sobald sie erledigt ist. Die Wirkung sehen Sie dann auf der Seite der ${UEMS_MASSNAHME}.`;

/** Nur Kennzahlen mit freigegebener Bezugsbasis taugen zur Messung (M2). */
export const mitBasis = (k: Pick<Kennzahl, 'bezugsbasis'>) => k.bezugsbasis?.freigabe_status === 'freigegeben';
