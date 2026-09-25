/**
 * „WORAUF IHR PLAN ACHTET" (Konzept „Tagesuhr und Bildfahrplan", Karte unter
 * dem Tagesbild): die Eingaben und Grenzen, mit denen der Fahrplan rechnet.
 *
 * Jede Zeile ist ein GEPFLEGTER Wert der Anlage oder ein Feld des Laufs, nie
 * eine Annahme dieser Seite; fehlt der Wert, fehlt die Zeile (nie eine 0, nie
 * ein „—" ohne Grund). Hier wohnen auch die Hinweise, die früher im
 * Aufklapper „Mehr erklären" standen: Tages-Bogen und Ausblick der Lage, der
 * Horizont vor den Börsenpreisen von morgen, der §14a-Rückfall und die
 * Prognosen.
 *
 * Rein: kein React, kein Netz.
 */

import type { IconName } from '../designsystem/components/core/Icon';
import type { TarifArt } from './api';
import type { LageView } from './fahrplanLage';
import { FALLBACK_14A_NOTE, FORECAST_FOOTNOTE } from './fahrplanWhy';
import { NBSP, fmtNum } from './format';
import type { PlanWordingKind } from './schedule';

export interface AnnahmeZeile {
  /** Stabiler Schlüssel (Tests, React). */
  key: string;
  icon: IconName;
  titel: string;
  text: string;
  /** Ein Weg zu mehr (etwa die Prognosequalität); null = keiner. */
  link: { href: string; text: string } | null;
}

export interface AnnahmenEingabe {
  /** Wann der jüngste Lauf entstand; null = unbekannt. */
  planVon: Date | null;
  slotMinutes: number;
  plantKind: PlanWordingKind;
  tarifArt?: TarifArt | null;
  /** Fester Preis bzw. Aufschlag des dynamischen Tarifs (ct/kWh). */
  tarifParamCtKwh?: number | null;
  netzladenErlaubt?: boolean | null;
  /** Die volle Entlade-Untergrenze des Laufs (`effectiveFloorSocPct`). */
  untergrenzePct?: number | null;
  /** Die Einspeisegrenze am Netzanschluss (kW). */
  einspeisegrenzeKw?: number | null;
  /** Das Lastspitzen-Ziel des Laufs (kW Netzbezug). */
  lastspitzeZielKw?: number | null;
  fallback14a?: boolean | null;
  lage?: LageView | null;
  /** Der Horizont-Hinweis (`schedule.horizonHint`); null = der Plan reicht über heute. */
  horizont?: string | null;
}

function zahl(v: number | null | undefined): number | null {
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
}

function uhr(d: Date): string {
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

export function planAnnahmen(e: AnnahmenEingabe): AnnahmeZeile[] {
  const out: AnnahmeZeile[] = [];
  const zeile = (key: string, icon: IconName, titel: string, text: string, link: AnnahmeZeile['link'] = null) =>
    out.push({ key, icon, titel, text, link });

  // Die Lage: wie der Tag verläuft und was für morgen erwartet wird.
  if (e.lage?.bogen) zeile('bogen', 'trending-up', 'Der Tag', e.lage.bogen);
  if (e.lage?.ausblick) zeile('ausblick', 'calendar', 'Morgen', e.lage.ausblick);
  // Der Horizont-Satz steht nur einmal, auch wenn die Lage ihn schon trägt.
  if (e.horizont && e.horizont !== e.lage?.ausblick) zeile('horizont', 'calendar', 'Wie weit der Plan reicht', e.horizont);

  const param = zahl(e.tarifParamCtKwh);
  if (e.tarifArt === 'dynamisch') {
    zeile(
      'tarif',
      'euro',
      'Dynamischer Tarif',
      param != null && param > 0
        ? `Ihr Strompreis folgt der Börse, dazu ${fmtNum(param, 'ct', 1)} Aufschlag je kWh.`
        : 'Ihr Strompreis folgt der Börse.',
    );
  } else if (e.tarifArt === 'fest' && param != null) {
    zeile('tarif', 'euro', 'Fester Strompreis', `${fmtNum(param, 'ct', 1)} je kWh.`);
  }
  if (e.plantKind === 'direktvermarktung') {
    zeile('vermarktung', 'trending-up', 'Direktvermarktung', 'Verkauft wird zum Börsenpreis.');
  }
  if (e.netzladenErlaubt === true) {
    zeile('netzladen', 'zap', 'Netzladen aktiv', 'Der Speicher darf günstigen Netzstrom laden (Ihre Einstellung).');
  } else if (e.netzladenErlaubt === false) {
    zeile('netzladen', 'sun', 'Nur Solarladen (EEG)', 'Der Speicher lädt nur aus Sonnenstrom (Ihre Einstellung).');
  }

  const unten = zahl(e.untergrenzePct);
  if (unten != null) {
    zeile('untergrenze', 'shield', 'Untergrenze', `Der Plan entlädt nicht unter ${Math.round(unten).toLocaleString('de-DE')}${NBSP}%.`);
  }
  if (e.lage?.nachtreserve) zeile('nachtreserve', 'shield', 'Reserve für die Nacht', e.lage.nachtreserve);
  const einspeisung = zahl(e.einspeisegrenzeKw);
  if (einspeisung != null && einspeisung > 0) {
    zeile('einspeisegrenze', 'sliders', 'Einspeisegrenze', `${fmtNum(einspeisung, 'kW')} am Netzanschluss.`);
  }
  const spitze = zahl(e.lastspitzeZielKw);
  if (spitze != null && spitze > 0) {
    zeile('lastspitze', 'trending-down', 'Lastspitzen', `Ziel: höchstens ${fmtNum(spitze, 'kW')} Netzbezug.`);
  }
  if (e.fallback14a === true) zeile('14a', 'alert-triangle', '§ 14a', FALLBACK_14A_NOTE);

  if (e.planVon) {
    zeile(
      'neu',
      'refresh-cw',
      'Neu geplant',
      `Zuletzt um ${uhr(e.planVon)} Uhr; VoltPilot plant alle ${e.slotMinutes} Minuten neu.`,
    );
  }
  zeile('prognosen', 'activity', 'Prognosen', FORECAST_FOOTNOTE, { href: '#/prognose', text: 'Zur Prognosequalität' });
  return out;
}
