/**
 * **„Preise im Zeitraum" — was eine Kilowattstunde wert war** (Konzept
 * „Erlöse · Preise und Verdienst", 25.09.2026).
 *
 * Bis hier war die Karte eine Liste aus acht Name-über-Wert-Paaren. Die
 * wichtigste Einsicht — selbst genutzter Strom ist ein Vielfaches eines
 * eingespeisten wert — musste man sich zusammenlesen. Jetzt sind es DREI
 * Balken auf einer ct-Skala, in derselben Reihenfolge und Rollenfarbe wie
 * Kennzahlen und Abrechnung: Eigenverbrauch · Einspeisung · Netzbezug.
 *
 * ⚠ **Jede Zahl ist der Quotient zweier SERVER-Summen** (REGEL 1 aus
 *   `erloesEbenen.ts`): `Geld ÷ Menge` — dieselbe Rechnung wie „Ø … ct/kWh"
 *   in der Abrechnung, also dieselbe Zahl. Fehlt eine der beiden Summen oder
 *   ist die Menge zu klein, steht „—" mit Grund, nie ein Null-Balken.
 *
 * Die Tarif-Grundlage (fester Tarif, EEG, Börse) wird zur Unterzeile; die
 * Direktvermarktungs-Größen (Monatsmarktwert, anzulegender Wert, Prämie) stehen
 * in „So verdient Ihre Anlage", wo sie ein Bild haben. Der Satz „Bei 0,0 ct
 * Börsenpreis …" (Captain-Entscheid E12: Ebene 2, wortgleich) steht im ⓘ an
 * der Einspeisung.
 *
 * Reines Modul: kein React, kein Netzwerk.
 */

import type { SiteEarnings } from './api';
import {
  balkenliste,
  ctWert,
  istMinus,
  type Balkenliste,
  type BalkenRolle,
  type BalkenUnter,
  type BalkenZeile,
} from './balkenliste';
import {
  BEWERTUNG_WERT,
  durchschnittCt,
  ebene2,
  nullCtSatz,
  speicherWert,
  type GlossarEintrag,
} from './erloesEbenen';
import { rundeKaufmaennisch } from './erloesZeilen';
import { NBSP } from './format';

export const PREISE_TITEL = 'Preise im Zeitraum';

/**
 * Die Antwort über den Balken. Sie steht NUR, wenn beide Werte bekannt sind und
 * sie stimmt — im umgekehrten Fall schweigt die Karte, statt das Gegenteil zu
 * behaupten (die Balken zeigen es ohnehin).
 */
export const MERKSATZ = 'Selbst genutzter Strom war mehr wert als eingespeister.';

/** Der ⓘ-Titel des E12-Satzes an der Einspeisung. */
export const NULL_CT_TITEL = 'Bei 0,0 ct Börsenpreis';

export interface PreisVergleich {
  merksatz: string | null;
  liste: Balkenliste;
  /** Speicher und Bewertung in einer ruhigen Fußzeile. */
  fuss: string;
  /** Die Begriffe der Karte (ⓘ am Titel) — dieselbe Quelle wie Ebene 2. */
  glossar: GlossarEintrag[];
}

export interface PreisVergleichInput {
  money: SiteEarnings;
  /** Ob der Speicher aus dem Netz laden darf (`site.netzladenErlaubt`). */
  netzladenErlaubt?: boolean | null;
}

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Unter dieser Menge gibt es keinen Durchschnittspreis (wie `durchschnittCt`). */
const KWH_TOTBAND = 0.05;

/**
 * Warum eine Zeile keinen Durchschnittspreis trägt — in dieser Reihenfolge:
 * gemessen nichts (eine echte Null der MENGE), nicht bewertet (Geld fehlt),
 * oder keine Menge bekannt. Unbekannt ist nie „nichts".
 */
function ohnePreis(eur: number | null, kwh: number | null, nichts: string): string {
  if (kwh != null && Math.abs(kwh) < KWH_TOTBAND) return nichts;
  if (eur == null) return 'noch nicht bewertet';
  return 'ohne Menge kein Durchschnittspreis';
}

/** „25 ct/kWh" — der Tarif, wie ihn der Kunde eingetragen hat. */
function tarif(v: number): string {
  return `${v.toLocaleString('de-DE', { maximumFractionDigits: 2 })}${NBSP}ct/kWh`;
}

function zeile(
  id: BalkenRolle,
  name: string,
  ct: number | null,
  unter: BalkenUnter,
  info: BalkenZeile['info'] = null,
): BalkenZeile {
  return {
    id,
    name,
    rolle: id,
    wert: ctWert(ct),
    vorhanden: ct != null,
    minus: istMinus(ct),
    segmente: ct == null ? [] : [{ rolle: id, von: 0, bis: ct }],
    unter,
    info,
  };
}

/** Eigenverbrauch: gespart je selbst genutzter kWh = der vermiedene Bezug. */
function eigenverbrauch(m: SiteEarnings): BalkenZeile {
  const eur = num(m.eigenverbrauchsWertEur);
  const kwh = num(m.selbstverbrauchKwh);
  const ct = durchschnittCt(eur, kwh);
  // Ohne Stromtarif hat der Eigenverbrauch keinen Wert — derselbe Grund und
  // derselbe Weg wie in Ebene 1 und in der Abrechnung.
  const unter: BalkenUnter =
    ct != null
      ? { text: 'gespart: vermiedener Netzbezug' }
      : eur == null
        ? { text: 'kein Stromtarif hinterlegt', link: { text: 'Stromtarif hinterlegen ›', ziel: 'tarif' } }
        : { text: ohnePreis(eur, kwh, 'kein Eigenverbrauch im Zeitraum') };
  return zeile('eigenverbrauch', 'Eigenverbrauch', ct, unter);
}

/** Einspeisung: verdient je eingespeister kWh — Börse (+ Prämie) bzw. EEG. */
function einspeisung(m: SiteEarnings): BalkenZeile {
  const eur = num(m.einspeiseErloesEur);
  const kwh = num(m.eingespeistKwh);
  const ct = durchschnittCt(eur, kwh);
  if (ct == null) {
    return zeile('einspeisung', 'Einspeisung', null, { text: ohnePreis(eur, kwh, 'nichts eingespeist') });
  }

  if (m.plantKind === 'direktvermarktung') {
    const praemie = num(m.marktpraemieEur);
    const text =
      praemie == null
        ? 'verdient: Börse'
        : Math.abs(praemie) < 0.005
          ? 'verdient: Börse · Marktprämie ruht'
          : 'verdient: Börse + Marktprämie';
    // E12 (Captain-Entscheid a): der Hebelsatz gehört auf Ebene 2, wortgleich —
    // jetzt auf Abruf statt als zweizeiliger Absatz.
    const aw = num(m.anzulegenderWertCtKwh);
    const mv = num(m.marketValueSolarCtKwh);
    const satz = aw != null && mv != null ? rundeKaufmaennisch(aw - mv, 2) : 0;
    return zeile(
      'einspeisung',
      'Einspeisung',
      ct,
      { text },
      satz > 0 ? { titel: NULL_CT_TITEL, text: nullCtSatz(satz) } : null,
    );
  }
  if (m.exportVerguetungPriced) {
    return zeile('einspeisung', 'Einspeisung', ct, {
      text: 'verdient: feste Vergütung (EEG), 20 Jahre ab Inbetriebnahme',
    });
  }
  return zeile('einspeisung', 'Einspeisung', ct, {
    text: 'verdient: Börsenpreis · nicht verknüpft',
    link: { text: 'Anlage verknüpfen ›', ziel: 'mastr' },
  });
}

/** Netzbezug: bezahlt je gekaufter kWh — mit der Tarif-Grundlage. */
function netzbezug(m: SiteEarnings): BalkenZeile {
  const eur = num(m.stromkostenEur);
  const kwh = num(m.bezogenKwh);
  const ct = durchschnittCt(eur, kwh);
  if (ct == null) {
    return zeile('netzbezug', 'Netzbezug', null, { text: ohnePreis(eur, kwh, 'kein Netzbezug im Zeitraum') });
  }
  const param = num(m.tarifParamCtKwh);
  const hinterlegen = { text: 'Tarif hinterlegen ›', ziel: 'tarif' as const };
  const unter: BalkenUnter =
    m.tarifArt === 'fest' && param != null
      ? { text: `bezahlt: fester Tarif ${tarif(param)}` }
      : m.tarifArt === 'dynamisch'
        ? { text: `bezahlt: Börsenpreis + ${ctWert(param ?? 0)} Aufschlag` }
        : m.tarifPriced
          ? { text: 'bezahlt: Börsenpreis + übliche Netzentgelte, Abgaben, Umsatzsteuer', link: hinterlegen }
          : { text: 'bezahlt: Börsenpreis', link: hinterlegen };
  return zeile('netzbezug', 'Netzbezug', ct, unter);
}

export function preisVergleich(input: PreisVergleichInput): PreisVergleich {
  const m = input.money;
  const zeilen = [eigenverbrauch(m), einspeisung(m), netzbezug(m)];

  const eigen = durchschnittCt(num(m.eigenverbrauchsWertEur), num(m.selbstverbrauchKwh));
  const einsp = durchschnittCt(num(m.einspeiseErloesEur), num(m.eingespeistKwh));
  const merksatz = eigen != null && einsp != null && eigen > einsp ? MERKSATZ : null;

  const speicher = speicherWert(m, input.netzladenErlaubt);
  const fuss = [speicher ? `Speicher ${speicher}` : null, `Bewertung: ${BEWERTUNG_WERT}`]
    .filter(Boolean)
    .join(' · ');

  return {
    merksatz,
    liste: balkenliste('Preise je Kilowattstunde', zeilen),
    fuss,
    glossar: ebene2({ money: m, netzladenErlaubt: input.netzladenErlaubt }).glossar,
  };
}
