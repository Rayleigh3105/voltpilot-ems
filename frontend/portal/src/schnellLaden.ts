/**
 * „Jetzt schnell laden“ im Cockpit (Kapitän 07.11.2026, Befund
 * `voltpilot-lademodus-schnellzugriff`, Entscheide F3 b, F4 a, F5 a).
 *
 * Eine schmale Zeile oben im Cockpit, NUR solange ein Auto steckt und
 * „Schnell“ dort etwas ändern kann: ein Knopf statt vier Tipps über
 * Steuerung › Laden. Sie ist eine bewusste, kleine Ausnahme von „Das Cockpit
 * bleibt reine Anzeige“ (`docs/konzepte/cockpit-tagesfilm/README.md`):
 * genau eine Handlung, nur in genau dieser Lage, und dieselbe wie im Reiter
 * Laden - derselbe `POST /charging-boost`, dieselbe Regel (`boostbar`),
 * dieselbe Dauer-Vorwahl „bis Abstecken, höchstens 14 Std“.
 *
 * Reine Ableitung; `components/SchnellLadenZeile.tsx` rendert sie.
 */
import type { Betriebsart } from './api';
import { ladeSicht } from './ebenenNav';
import {
  BOOST_INTRO,
  LADEPUNKT_ABSTECKEN_DECKEL_MIN,
  boostbar,
  budgetFuer,
  chargerName,
  connectorName,
  ladepunktSperre,
  ladevorgangRows,
  type ChargingBudget,
  type LadepunktDauer,
  type LadepunktFolgen,
  type SiteCharging,
} from './ladepunkte';
import { fKw } from './steuerung/zeit';

/** Die Vorwahl der Dauer (F4 a): „bis Abstecken, höchstens 14 Std“ wie im Blatt des Ladepunkts. */
export const SCHNELL_DAUER_VORGABE = 'abstecken';

/** Der Knopf der Zeile - das Wort des Reiters Laden („Schnell“), nicht „voll laden“. */
export const SCHNELL_KNOPF = 'Jetzt schnell laden';

/** Der Rückweg, solange „Schnell“ läuft - das Wort des Reiters Laden. */
export const SCHNELL_ZURUECK = 'Zurück zu Smart';

export interface SchnellZeile {
  key: string;
  chargePointId: string;
  connectorId: number;
  /** „Wallbox Garage“, bei mehreren Steckern einer Säule mit „· Stecker B“. */
  name: string;
  /** „Auto steckt · wartet auf Sonne“ / „Lädt schnell auf Ihren Wunsch · 11,0 kW“. */
  satz: string;
  /** Läuft „Schnell“ hier schon? Dann bietet die Zeile den Rückweg an. */
  laeuft: boolean;
  /** Das Budget der Box dieser Säule - für die Folgen-Karte. */
  budget: ChargingBudget | null;
}

/**
 * Nur Privatkunden (F5 a): Betriebsart „endkunde“, ohne gespeicherte
 * Betriebsart bis 2 Ladepunkte - dieselbe Unterscheidung wie die Navigation
 * (`ladeSicht`). Betreiber behalten ihren „Ladepark“.
 */
export function schnellFuerPrivatkunden(
  betriebsart: Betriebsart | null | undefined,
  ladepunktAnzahl: number | null | undefined,
  charging: SiteCharging | null | undefined,
): boolean {
  const anzahl = ladepunktAnzahl ?? charging?.chargers.length ?? null;
  return ladeSicht(betriebsart ?? null, anzahl) === 'privatkunde';
}

/**
 * Die Zeilen der Cockpit-Zeile: je Stecker, an dem ein Auto steckt und
 * „Schnell“ etwas ändern kann, oder an dem „Schnell“ schon läuft.
 *
 * Keine Zeile, wo VoltPilot die Wallbox nicht regelt (`ladepunktSperre`), wo
 * der Kunde selbst pausiert hat (`handeingriff`) oder wo „Schnell“ nichts
 * übersteuern kann - dort steht der Grund im Reiter Laden, das Cockpit bleibt
 * ruhig.
 */
export function schnellZeilen(input: {
  charging: SiteCharging | null | undefined;
  betriebsart: Betriebsart | null | undefined;
  ladepunktAnzahl: number | null | undefined;
  nowMs: number;
}): SchnellZeile[] {
  const { charging, nowMs } = input;
  if (!charging || !schnellFuerPrivatkunden(input.betriebsart, input.ladepunktAnzahl, charging)) return [];
  const out: SchnellZeile[] = [];
  for (const cp of charging.chargers) {
    const budget = budgetFuer(charging, cp);
    if (ladepunktSperre(cp, budget, nowMs)) continue;
    const mehrere = (cp.connectors ?? []).length > 1;
    for (const row of ladevorgangRows([cp], nowMs)) {
      if (row.handeingriff) continue;
      const laeuft = row.boost;
      if (!laeuft && !boostbar(budget, row)) continue;
      const kw = row.powerKw != null && row.powerKw > 0.05 ? ` · ${fKw(row.powerKw)}` : '';
      const satz = laeuft
        ? `Lädt schnell auf Ihren Wunsch${kw}`
        : row.reasonCode === 'kein_ueberschuss'
          ? 'Auto steckt · wartet auf Sonne'
          : row.tone === 'laedt'
            ? `Auto steckt · lädt${kw}`
            : 'Auto steckt · wartet';
      out.push({
        key: row.key,
        chargePointId: row.chargePointId,
        connectorId: row.connectorId,
        name: mehrere ? `${chargerName(cp)} · ${connectorName(row.connectorId)}` : chargerName(cp),
        satz,
        laeuft,
        budget,
      });
    }
  }
  return out;
}

/**
 * Die Folgen-Karte vor dem Klick, im Vier-Block-Muster des bestehenden
 * Handeingriff-Dialogs - in den Wörtern des Reiters Laden („Schnell“,
 * „Smart“), nicht der Betreiber-Seite („Jetzt voll laden“, „Automatik
 * fortsetzen“).
 *
 * ⚠ Die einzige Zahl ist die gemeldete Anschlussgrenze; wie viel Leistung
 * dieser Ladung zufällt, weiß vorher niemand, also steht es nicht da.
 */
export function schnellFolgenKarte(
  budget: ChargingBudget | null,
  dauer: LadepunktDauer,
  andereLadepunkte: number,
): LadepunktFolgen {
  const limit = typeof budget?.gridLimitKw === 'number' && Number.isFinite(budget.gridLimitKw) ? budget.gridLimitKw : null;
  const netz = limit == null
    ? 'Ihr Netzanschluss bleibt geschützt.'
    : `Ihr Netzanschluss (${fKw(limit)}) bleibt geschützt.`;
  const risiko = ['Ohne Sonne kommt der Strom aus dem Netz und kostet Ihren Bezugspreis.'];
  if (andereLadepunkte > 0) risiko.push('Die anderen Ladepunkte teilen sich den Rest und können dadurch langsamer laden.');
  return {
    titel: SCHNELL_KNOPF,
    intro: BOOST_INTRO,
    bloecke: [
      { key: 'passiert', titel: 'Das passiert', zeilen: ['Diese Ladung bekommt volle Leistung - auch aus dem Netz, auch ohne Sonne.'] },
      { key: 'risiko', titel: 'Risiko', zeilen: risiko },
      {
        key: 'gleich',
        titel: 'Das bleibt gleich',
        zeilen: [netz, 'Anschlussgrenze, Sicherheitsabstand und Ausfall-Schutz gelten weiter.'],
      },
      {
        key: 'ende',
        titel: 'Ende / Rücknahme',
        zeilen: [
          // ⚠ „bis Abstecken" bekommt keine Minutenzahl - es gilt allein der Deckel der Box (14 Stunden).
          dauer.minutes == null
            ? `Endet beim Abstecken, spätestens nach ${LADEPUNKT_ABSTECKEN_DECKEL_MIN / 60} Stunden - danach wieder Smart.`
            : `Endet nach ${dauer.label}, beim Abstecken schon früher - danach wieder Smart.`,
          `„${SCHNELL_ZURUECK}“ beendet es sofort.`,
        ],
      },
    ],
    bestaetigen: dauer.minutes == null ? 'Schnell laden bis zum Abstecken' : `Schnell laden - ${dauer.label}`,
  };
}
