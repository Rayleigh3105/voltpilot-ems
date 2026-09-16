import type { BezugsdatenBefund, BezugsdatenVorschau } from './api';

export const URTEIL_LABEL: Record<string, string> = {
  neu: 'Neu',
  wiederholung: 'Schon vorhanden',
  konflikt: 'Abweichender Wert',
  berichtigung: 'Berichtigung',
  uebersprungen: 'Nicht übernommen',
  abgelehnt: 'Abgelehnt',
};

export type VorschauAbleitung = {
  zeilen: number;
  uebernehmen: number;
  nichtUebernehmen: number;
  teiluebernahme: boolean;
  knopf: string;
  bestaetigung: string | null;
  befunde: BezugsdatenBefund[];
};

/** Reine Anzeige-Ableitung: Zähler bleiben die Server-/Vertragszähler, Sätze bleiben Server-Sätze. */
export function vorschauAbleitung(v: BezugsdatenVorschau): VorschauAbleitung {
  const n = v.import.aenderungen;
  const befunde = [...v.import.befunde, ...v.zeilen.flatMap((z) => z.befunde)]
    .filter((b, i, alle) => alle.findIndex((x) => x.befund === b.befund && x.satz === b.satz) === i);
  return {
    zeilen: v.import.zaehler.zeilen,
    uebernehmen: n,
    nichtUebernehmen: v.import.zaehler.zeilen - n,
    teiluebernahme: v.import.bestaetigung !== null,
    knopf: n === 0 ? 'Nichts zu übernehmen' : `${n} ${n === 1 ? 'Zeile' : 'Zeilen'} übernehmen`,
    bestaetigung: v.import.bestaetigung,
    befunde,
  };
}

export const trennzeichenText = (wert: string | null): string =>
  wert === '\t' ? 'Tabulator' : wert === ';' ? 'Semikolon' : wert === ',' ? 'Komma' : wert ?? 'Nicht erkannt';
