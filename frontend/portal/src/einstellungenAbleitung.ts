import type { Schwere } from './meldungenApi';
import type { RuhezeitRegeln, RuhezeitTeilfenster } from './ruhezeit';

/**
 * Reine Ableitungen der Einstellungs-Seite (Konzept `vp-einstellungen-konzept-e1`, Scheibe 1,
 * §4.4 Kurzbild und §4.5 Ruhezeit-Vorgaben) - Komponenten rendern nur, was diese Funktionen sagen.
 */

// --------------------------------------------------------------------- Zwei Stufen je Weg (E3)

/** Die zwei Stufen des Entwurfs (Entscheid 3A) - „ab Hinweis" gibt es nicht mehr, Hinweise gehen nie hinaus. */
export type ZweiStufen = 'alle' | 'nur_dringend';

/** Eine gespeicherte `hinweis`-Schwere (alte Daten) wirkt wie `warnung` - sie verließ das Portal ohnehin nie. */
export function stufeAusSchwere(schwere: Schwere): ZweiStufen {
  return schwere === 'dringend' ? 'nur_dringend' : 'alle';
}

export function schwereAusStufe(stufe: ZweiStufen): Schwere {
  return stufe === 'nur_dringend' ? 'dringend' : 'warnung';
}

// --------------------------------------------------------------------------------- Kurzbild (§4.4)

export interface KurzbildWeg {
  /** Das Wort der Zeile ("E-Mail", "Push", "Team-Kanal", "Telegram"). */
  label: string;
  schwere: Schwere;
  aktiv: boolean;
}

export interface KurzbildZeile {
  schwere: Schwere;
  /** Die Wege, die bei dieser Schwere JETZT ankommen - leer, wenn keiner oder Ruhezeit wartet. */
  wege: string[];
  /** Diese Zeile wartet gerade auf das Ende der Ruhezeit. */
  wartet: boolean;
}

export interface Kurzbild {
  ruhezeitBis: Date | null;
  zeilen: KurzbildZeile[];
}

const STUFEN: Schwere[] = ['hinweis', 'warnung', 'dringend'];

/** Ein Weg mit `schwere` erreicht die gegebene Zeile - Hinweis verlässt das Portal nie (§2.5 Zusammenhang). */
function erreichtZeile(wegSchwere: Schwere, zeile: Schwere): boolean {
  if (zeile === 'hinweis') return false;
  const effektiv = wegSchwere === 'hinweis' ? 'warnung' : wegSchwere;
  return effektiv === 'warnung' ? true : zeile === 'dringend';
}

/**
 * Das Kurzbild „So erreicht Sie eine Meldung jetzt" (§4.4): je Stufe die Wege, die jetzt ankommen.
 * Grundlage ist `ruhezeitBis` aus der SERVER-Probe (`POST /api/v1/ruhezeit/probe`), nie der
 * Portal-Zwilling (B9) - die Seite übergibt hier nur das schon entschiedene Ergebnis.
 */
export function baueKurzbild(wege: KurzbildWeg[], ruhezeitBis: Date | null, dringendDurch: boolean): Kurzbild {
  const zeilen = STUFEN.map((schwere): KurzbildZeile => {
    if (schwere === 'hinweis') return { schwere, wege: [], wartet: false };
    const wartet = ruhezeitBis != null && (schwere === 'warnung' || !dringendDurch);
    const aktive = wartet ? [] : wege.filter((w) => w.aktiv && erreichtZeile(w.schwere, schwere)).map((w) => w.label);
    return { schwere, wege: aktive, wartet };
  });
  return { ruhezeitBis, zeilen };
}

// ----------------------------------------------------------------------- Ruhezeit-Vorgaben (§4.5)

export type RuhezeitPresetId = 'keine' | 'nachts' | 'nachts_wochenende' | 'ausserhalb_arbeitszeit' | 'eigene';

const NACHT: RuhezeitTeilfenster = { von: '22:00', bis: '07:00' };
const ARBEITSZEIT_ENDE: RuhezeitTeilfenster = { von: '18:00', bis: '07:00' };

function gleichesFenster(a: RuhezeitTeilfenster | undefined, b: RuhezeitTeilfenster): boolean {
  return a?.von === b.von && a?.bis === b.bis;
}

/** Erkennt eine der fünf Vorgaben wieder - unbekannte Kombinationen sind ehrlich „Eigene Zeiten". */
export function ruhezeitPresetVon(regeln: RuhezeitRegeln): RuhezeitPresetId {
  const ohneWochenende = regeln.wochenende == null;
  if (!regeln.werktags && ohneWochenende) return 'keine';
  if (gleichesFenster(regeln.werktags, NACHT) && ohneWochenende) return 'nachts';
  if (gleichesFenster(regeln.werktags, NACHT) && regeln.wochenende === 'ganz') return 'nachts_wochenende';
  if (gleichesFenster(regeln.werktags, ARBEITSZEIT_ENDE) && regeln.wochenende === 'ganz') return 'ausserhalb_arbeitszeit';
  return 'eigene';
}

/**
 * Die Regeln einer gewählten Vorgabe. „Eigene Zeiten" behält die vorherigen Fenster (oder eine
 * sinnvolle Grundlage, wenn vorher keine Ruhezeit galt) - eine Wahl setzt kein leeres Formular.
 */
export function ruhezeitRegelnFuerPreset(preset: RuhezeitPresetId, vorher: RuhezeitRegeln): RuhezeitRegeln {
  switch (preset) {
    case 'keine':
      return {};
    case 'nachts':
      return { werktags: { ...NACHT } };
    case 'nachts_wochenende':
      return { werktags: { ...NACHT }, wochenende: 'ganz' };
    case 'ausserhalb_arbeitszeit':
      return { werktags: { ...ARBEITSZEIT_ENDE }, wochenende: 'ganz' };
    case 'eigene':
      return {
        werktags: vorher.werktags ?? { ...NACHT },
        wochenende: vorher.wochenende ?? 'ganz',
      };
  }
}

export const RUHEZEIT_PRESET_LABEL: Record<RuhezeitPresetId, string> = {
  keine: 'Keine',
  nachts: 'Nachts 22 bis 7 Uhr',
  nachts_wochenende: 'Nachts und am Wochenende',
  ausserhalb_arbeitszeit: 'Außerhalb der Arbeitszeit',
  eigene: 'Eigene Zeiten',
};
