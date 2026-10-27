/**
 * Die Klassen-Regel der Sonnen-Erzählung (Konzept `vp-fahrplan-eigenverbrauch-konzept`,
 * Scheibe S1, report.md §5.1): EINE reine Ableitung, die für eine Anlage beantwortet,
 * ob der FAHRPLAN mit einem Preis rechnet, der sich über den Tag ändert — und damit,
 * ob die Oberfläche die Sonnen- oder die Preis-Erzählung erzählt.
 *
 * Keine zweite Wahrheit: `importPriceCtKwh`/`exportValueCtKwh` sind dieselbe
 * serverseitige Preisbildung (`SchedulePricingService`/`SlotEconomics`, Zwilling von
 * `pricing.py`), mit der der Optimierer entschieden hat und mit der die Erlöse rechnen.
 * Stammdaten (Tarifart, Vermarktungsart) dienen NUR als Rückfall für Läufe ohne diese
 * Felder — wie bisher in `fahrplanTag.bildPreisArt`.
 *
 * Die drei bestehenden Tore gehen hier auf (report.md §5.4), ohne sichtbare Änderung:
 *  - `fahrplanTag.bildPreisArt` liest {@link PreisRolle.bezug};
 *  - `strompreis.gateStrompreis` und der Preise-Reiter (`surface.ts`) lesen
 *    `preisRolle(…).erzaehlung === 'preis'`.
 */
import type { TarifArt } from './api';
import type { PlanWordingKind } from './schedule';

/** Unter dieser Tagesspanne (ct/kWh) gilt ein Preis als flach — dieselbe Schwelle wie `fahrplanTag.PREIS_FLACH_CT`. */
export const PREIS_FLACH_CT = 0.5;

/** Rechnet der Bezug über den Tag mit einem Preis, der sich ändert? */
export type Bezug = 'flach' | 'schwankt' | 'unbekannt';

/**
 * Rechnet die Einspeisung über den Tag mit einem Preis, der sich ändert?
 * `flach_mit_nullstunden` = sonst fest, aber einige Viertelstunden ohne
 * Vergütung (§ 51a bei negativem Börsenpreis).
 */
export type Einspeisung = 'flach' | 'flach_mit_nullstunden' | 'schwankt' | 'unbekannt';

export type Erzaehlung = 'sonne' | 'preis';

/** Minimaler Viertelstunden-Ausschnitt, den die Regel braucht (Teilmenge von `WhySlot`/`ScheduleSlot`). */
export interface PreisRolleSlot {
  importPriceCtKwh?: number | null;
  exportValueCtKwh?: number | null;
}

export interface PreisRolleEingabe {
  /** Die Viertelstunden des gezeigten Laufs; leer/fehlend = kein Lauf (Stammdaten-Rückfall). */
  slots?: readonly PreisRolleSlot[] | null;
  /** Der hinterlegte Tarif — Rückfall, trägt der Lauf die Preisfelder nicht. */
  tarifArt?: TarifArt | null;
  /** Verkauft die Anlage an den Markt? Rückfall wie oben. */
  plantKind?: PlanWordingKind | null;
  /**
   * Vergütung nicht hinterlegt: der Plan rechnet Einspeisung im Rückfall zum
   * Börsenpreis (`SiteEarnings.exportVerguetungPriced === false`). Dann bleibt
   * die Erzählung „Sonne" (mit sichtbarer Lücke) — die Börse ist hier eine
   * fehlende Angabe, keine echte Preis-Geschichte (report.md §5.1, §5.2).
   */
  luecke?: boolean;
}

export interface PreisRolle {
  bezug: Bezug;
  einspeisung: Einspeisung;
  luecke: boolean;
  erzaehlung: Erzaehlung;
  /** Indizes in `slots` ohne Vergütung (§ 51a) — für Bogen, Band und Satz. */
  nullstunden: number[];
}

function zahl(v: number | null | undefined): number | null {
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
}

function spanne(werte: readonly number[]): number {
  return werte.length === 0 ? 0 : Math.max(...werte) - Math.min(...werte);
}

/** `unbekannt`, trägt nicht JEDE Viertelstunde das Feld — sonst `flach`/`schwankt` an der Tagesspanne. */
function reihenKlasse(werte: (number | null)[]): 'flach' | 'schwankt' | 'unbekannt' {
  if (werte.length === 0 || werte.some((v) => v == null)) return 'unbekannt';
  return spanne(werte as number[]) < PREIS_FLACH_CT ? 'flach' : 'schwankt';
}

/** Löst `bezug = unbekannt` über Stammdaten auf — wortgleich mit dem bisherigen Rückfall in `fahrplanTag.bildPreisArt`. */
function stammdatenFlach(
  tarifArt: TarifArt | null | undefined,
  plantKind: PlanWordingKind | null | undefined,
): boolean {
  return tarifArt != null && tarifArt !== 'dynamisch' && plantKind !== 'direktvermarktung';
}

/**
 * Die Klassen-Regel aus den Preisen des Plans (report.md §5.1). Pure + framework-frei.
 */
export function preisRolle(eingabe: PreisRolleEingabe): PreisRolle {
  const slots = eingabe.slots ?? [];
  const luecke = eingabe.luecke === true;

  const bezug = reihenKlasse(slots.map((s) => zahl(s.importPriceCtKwh)));

  const exportWerte = slots.map((s) => zahl(s.exportValueCtKwh));
  let einspeisung: Einspeisung = 'unbekannt';
  const nullstunden: number[] = [];
  if (slots.length > 0 && exportWerte.every((v) => v != null)) {
    const werte = exportWerte as number[];
    const nullIdx: number[] = [];
    werte.forEach((v, i) => {
      if (v === 0) nullIdx.push(i);
    });
    const ungleichNull = werte.filter((v) => v !== 0);
    if (nullIdx.length === 0) {
      einspeisung = spanne(werte) < PREIS_FLACH_CT ? 'flach' : 'schwankt';
    } else if (ungleichNull.length > 0 && spanne(ungleichNull) < PREIS_FLACH_CT) {
      einspeisung = 'flach_mit_nullstunden';
      nullstunden.push(...nullIdx);
    } else {
      einspeisung = 'schwankt';
    }
  }

  const bezugSonnenfaehig =
    bezug === 'schwankt' ? false : bezug === 'flach' ? true : stammdatenFlach(eingabe.tarifArt, eingabe.plantKind);
  // Keine Daten widerlegen die Sonnen-Erzählung nicht (`unbekannt`); nur eine
  // ECHT schwankende Einspeisung tut das — außer die Lücke ist der einzige Grund.
  const einspeisungSonnenfaehig =
    einspeisung === 'flach' || einspeisung === 'flach_mit_nullstunden' || einspeisung === 'unbekannt' || luecke;

  const erzaehlung: Erzaehlung = bezugSonnenfaehig && einspeisungSonnenfaehig ? 'sonne' : 'preis';

  return { bezug, einspeisung, luecke, erzaehlung, nullstunden };
}
