import type {
  BewertungMessabdeckung,
  BewertungMessabdeckungMesswert,
  BewertungMessabdeckungOrt,
  BewertungMessabdeckungPlan,
  BewertungMessabdeckungRest,
} from './api';
import { prozentText, urteilText, zahlMitEinheit } from './bewertung';
import { UEMS_BEWERTUNG_ABDECKUNG } from './glossar';
import { tagText } from './uemsMessmittel';

/**
 * UEMS AP-16 IP-18 (§5.3, R5): die Abdeckungs-Tabelle je Energieeinsatz und je Ort aus der Route
 * `…/bewertung/messabdeckung` (IP-13). Vier Spalten — gemessen · geplant · Ersatz · ungemessen —, dazu die Rest-Zeilen
 * je Anlage und die Summe mit K8. Nichts wird hier gerechnet; die Zahlen stehen so, wie die Route sie liefert.
 *
 * ⚠ „geplant“ trägt NIE eine Menge (auch keine 0): eine geplante Messstelle hat noch keine Werte. ⚠ Ersatz ist eine
 * Teilmenge von „gemessen“ und wird nie dazugezählt. ⚠ „ungemessen“ ist ausschließlich der Rest der Anlagenbilanz.
 */

export const ABDECKUNG_SPALTEN = [
  { schluessel: 'gemessen', titel: UEMS_BEWERTUNG_ABDECKUNG.gemessen },
  { schluessel: 'geplant', titel: UEMS_BEWERTUNG_ABDECKUNG.geplant },
  { schluessel: 'ersatz', titel: UEMS_BEWERTUNG_ABDECKUNG.ersatz },
  { schluessel: 'ungemessen', titel: UEMS_BEWERTUNG_ABDECKUNG.ungemessen },
] as const;

export type AbdeckungSpalte = (typeof ABDECKUNG_SPALTEN)[number]['schluessel'];

export interface AbdeckungZeile {
  schluessel: string;
  art: 'einsatz' | 'ort' | 'rest';
  kennzeichen: string | null;
  titel: string;
  unter: string | null;
  zellen: Record<AbdeckungSpalte, string[]>;
  menge: string | null;
  /** Nur an Rest-Zeilen: die Anlage aus `je_ort` — daraus entsteht ein Messbedarf (IP-20). */
  rest?: BewertungMessabdeckungOrt;
}

const gemessenText = (m: BewertungMessabdeckungMesswert) =>
  `${m.kennzeichen}${m.ort ? ` (${m.ort})` : ''}: ${zahlMitEinheit(m.menge, m.einheit)}`;

/** „MS-23 (Halle 1) — keine Datenquelle seit 27.11.2026“ bzw. „Messbedarf MB-1 — offen“; nie eine Menge. */
function geplantText(p: BewertungMessabdeckungPlan): string {
  const wo = p.ort ? ` (${p.ort})` : '';
  if (p.kennzeichen) {
    const seit = p.keine_datenquelle_seit ? ` — keine Datenquelle seit ${tagText(p.keine_datenquelle_seit)}` : ' — keine Datenquelle';
    return `${p.kennzeichen}${wo}${seit}${p.messbedarf ? ` · für ${p.messbedarf}` : ''}`;
  }
  return `Messbedarf ${p.messbedarf ?? ''}${wo} — offen`.replace('  ', ' ');
}

const ersatzText = (m: BewertungMessabdeckungMesswert) =>
  `${m.kennzeichen}: ${zahlMitEinheit(m.menge, m.einheit)} Ersatzwerte (in „gemessen“ enthalten)`;

const restText = (r: BewertungMessabdeckungRest, einheit: string | null) =>
  `Rest ${r.anlage}: ${zahlMitEinheit(r.menge, einheit ?? 'kWh')}${r.anteil_prozent ? ` (${prozentText(r.anteil_prozent)} der Anlage)` : ''}`;

/** Die Zeilen je Energieeinsatz und darunter die Rest-Zeilen je Anlage („keinem Energieeinsatz zugeordnet“). */
export function einsatzZeilen(m: BewertungMessabdeckung): AbdeckungZeile[] {
  const zeilen: AbdeckungZeile[] = m.je_einsatz.map((e) => ({
    schluessel: e.id,
    art: 'einsatz',
    kennzeichen: e.kennzeichen,
    titel: e.name,
    unter: e.traeger === 'Strom' ? e.traeger : `${e.traeger} — ohne Anteil`,
    zellen: {
      gemessen: e.gemessen.map(gemessenText),
      geplant: e.geplant.map(geplantText),
      ersatz: e.ersatz.map(ersatzText),
      ungemessen: e.ungemessen.map((r) => restText(r, e.einheit)),
    },
    menge: e.menge === null && e.geplant.length > 0 ? 'geplant — keine Werte' : zahlMitEinheit(e.menge, e.einheit),
  }));
  for (const o of m.je_ort) {
    if (o.art !== 'anlage' || !o.ungemessen) continue;
    zeilen.push({
      schluessel: `rest-${o.id ?? o.name}`,
      art: 'rest',
      kennzeichen: null,
      titel: `Rest ${o.name ?? o.ungemessen.anlage}`,
      unter: 'keinem Energieeinsatz zugeordnet',
      zellen: { gemessen: [], geplant: [], ersatz: [], ungemessen: [restText(o.ungemessen, o.einheit)] },
      menge: zahlMitEinheit(o.ungemessen.menge, o.einheit ?? 'kWh'),
      rest: o,
    });
  }
  return zeilen;
}

/** Die Zeilen je Ort (Anlage, Standort …); ein Träger ohne Nenner steht „ohne Anteil“ (E3). */
export function ortZeilen(m: BewertungMessabdeckung): AbdeckungZeile[] {
  return m.je_ort.map((o) => ({
    schluessel: `${o.art}-${o.id ?? o.name}-${o.traeger}`,
    art: 'ort',
    kennzeichen: o.kennzeichen,
    titel: o.name ?? '—',
    unter: o.traeger === 'Strom' ? o.traeger : `${o.traeger} — ohne Anteil`,
    zellen: {
      gemessen: o.gemessen.map(gemessenText),
      geplant: o.geplant.map(geplantText),
      ersatz: o.ersatz.map(ersatzText),
      ungemessen: o.ungemessen ? [restText(o.ungemessen, o.einheit)] : o.traeger === 'Strom' ? [] : ['ohne Nenner je Träger'],
    },
    menge: null,
  }));
}

export interface AbdeckungSumme {
  teile: { schluessel: string; label: string; wert: string }[];
  k8: string;
  k8Zustand: 'ueber_schwelle' | 'unter_schwelle' | 'nicht_anwendbar';
  satz: string | null;
}

/** Die Summe (§5.3): Nenner mit „x von y Anlagen“, gemessen und zugeordnet mit K8, geplant ohne Menge, Ersatz, ungemessen. */
export function abdeckungSumme(m: BewertungMessabdeckung): AbdeckungSumme {
  const s = m.summe;
  const geplant = [...m.je_einsatz.flatMap((e) => e.geplant), ...m.je_ort.flatMap((o) => o.geplant)]
    .map((p) => p.kennzeichen ?? (p.messbedarf ? `Messbedarf ${p.messbedarf}` : null))
    .filter((x): x is string => !!x);
  const geplantListe = [...new Set(geplant)];
  return {
    teile: [
      { schluessel: 'nenner', label: 'Stromeinsatz', wert: `${zahlMitEinheit(s.nenner.wert, s.nenner.einheit ?? 'kWh')} aus ${s.nenner.vorhanden} von ${s.nenner.gesamt} Anlagen` },
      { schluessel: 'gemessen', label: 'gemessen und zugeordnet', wert: `${zahlMitEinheit(s.gemessen_zugeordnet, 'kWh')} = ${prozentText(s.abdeckung_prozent)}` },
      { schluessel: 'geplant', label: 'geplant', wert: geplantListe.length > 0 ? `${geplantListe.join(', ')} — noch keine Werte` : '—' },
      { schluessel: 'ersatz', label: 'Ersatz', wert: `${zahlMitEinheit(s.ersatz, 'kWh')} (in „gemessen“ enthalten)` },
      { schluessel: 'ungemessen', label: 'ungemessen', wert: `${zahlMitEinheit(s.ungemessen, 'kWh')} = ${prozentText(s.ungemessen_prozent)}` },
    ],
    k8: `K8 · Messabdeckung: ${urteilText(s.k8)}`,
    k8Zustand: s.k8,
    satz: s.abdeckung_prozent && s.ungemessen && s.ungemessen_prozent
      ? `${prozentText(s.abdeckung_prozent)} des Stromeinsatzes sind Energieeinsätzen zugeordnet; ${zahlMitEinheit(s.ungemessen, 'kWh')} (${prozentText(s.ungemessen_prozent)}) sind keinem zugeordnet.`
      : null,
  };
}
