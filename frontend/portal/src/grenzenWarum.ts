/**
 * „GRENZEN ALS GRÜNDE" — Erklärbarkeit Stufe 3 (Konzept
 * `data/vp-warum-erklaerbar-e2` §5.4 + §8 + §10 Stufe 3, Captain-Freigabe
 * 17.08.2026, F1–F6).
 *
 * Die Frage, für die es diese Stufe gibt, ist **W4: „drosselt IHR meine
 * Anlage?"** — und sie war bis hierher am Warum-Ort nicht beantwortbar. Die
 * Rolle `abregeln` behauptete IMMER den negativen Börsenpreis, obwohl der
 * Solver auch an der Einspeisegrenze und an der §14a-Netzgrenze abregelt; und
 * die Grenze, die der Wechselrichter SELBST hält (Herzogau: 33 kW im Gerät
 * gegen 70 kW im Portal), stand nur auf der Cockpit-Karte, nie dort, wo der
 * Kunde nach dem Warum fragt. Zwei Untersuchungsrunden per Wartungstunnel
 * gingen dafür drauf.
 *
 * ── DIE VIER REGELN DIESES MODULS ──────────────────────────────────────────
 *
 * 1. **Jeder Grund hängt an einem EXPORTIERten Fakt** (die Echtheits-Regel,
 *    `begruendung.test.ts`): §14a und die Einspeisegrenze sind Bindungs-FLAGS
 *    des Laufs (`explain._binding_flags`), der Negativpreis ist der
 *    persistierte Slot-Preis. Trägt kein Fakt eine Ursache, wird die
 *    BEOBACHTUNG gesagt — nie die plausibelste der drei.
 * 2. **Eine Grenze nennt ihren URHEBER** (§8): Netzbetreiber (§ 14a) · Ihre
 *    Anmeldung (Einspeisegrenze) · Ihr Gerät selbst · der Markt (Negativpreis).
 *    Genau das ist die Antwort auf W4, und genau deshalb führt der FREMDE
 *    Auftrag vor unserer eigenen Ökonomie ({@link GRUND_REIHENFOLGE}).
 * 3. **Der Satz über die Grenze IM GERÄT wird DURCHGEREICHT, nie neu
 *    formuliert** — er entsteht an genau EINER Stelle
 *    (`curtailment.deviceLimitLine`, „Grenzen & Wächter" Stufe 0) und trägt
 *    dort schon die Regel, die dem Gerät nie UNSERE eigene Kappe anlastet.
 *    Zwei Formulierungen für dasselbe Urteil sind das, was das Haus vermeidet.
 * 4. **Die VoltPilot-eigenen Schutzgrenzen** (Reserve, SoC-Fenster,
 *    EEG-Solarladen) stehen hier bewusst NICHT: sie liegen nicht am
 *    Netzanschluss, und sie tragen ihre Chips schon (`fahrplanWhy.bindingChips`)
 *    direkt daneben. Dieselbe Aussage zweimal auf einer Karte ist das
 *    dokumentierte Anti-Muster.
 */

import type { CurtailmentStatus } from './api';
import { deviceLimitLine } from './curtailment';
import { fmtNum } from './format';

/** Wer die Grenze gesetzt hat (§8). */
export type GrenzenUrheber = 'netzbetreiber' | 'anmeldung' | 'markt';

/** Die belegbaren Ursachen einer geformten Viertelstunde. */
export type GrenzenId = 'netzgrenze_14a' | 'einspeisegrenze' | 'negativpreis';

/** Das Kundenwort des Urhebers — es steht VOR dem Satz, nie darin. */
export const URHEBER_LABEL: Record<GrenzenUrheber, string> = {
  netzbetreiber: 'Ihr Netzbetreiber',
  anmeldung: 'Ihre Anmeldung',
  markt: 'Der Strommarkt',
};

/**
 * DIE REIHENFOLGE, und sie ist eine Aussage: W4 fragt „wer drosselt?", also
 * führt der FREMDE Auftrag vor unserer eigenen Ökonomie. Eine vom
 * Netzbetreiber angeordnete Begrenzung als „negativer Börsenpreis" zu
 * erklären, verschwiege genau den Urheber, nach dem gefragt wurde — dieselbe
 * Disziplin wie „`reach` gewinnt vor `reason`" im Einspeisewächter (die
 * schärfere Aussage führt).
 *
 * Was dadurch NICHT verschwindet: binden mehrere zugleich, nennt der SATZ den
 * Leitgrund und die {@link grenzenView} listet alle — plus die Bindungs-Chips
 * daneben, die es ohnehin tun.
 */
export const GRUND_REIHENFOLGE: GrenzenId[] = [
  'netzgrenze_14a',
  'einspeisegrenze',
  'negativpreis',
];

/** Die Bindungs-Flags des Laufs, die eine Grenze am Netzanschluss belegen. */
const FLAG_FUER: Partial<Record<GrenzenId, string>> = {
  netzgrenze_14a: 'grid_limit_14a',
  einspeisegrenze: 'feed_in_cap',
};

/**
 * Was die Viertelstunde SELBST trägt — eine strukturelle Teilmenge von
 * `fahrplanWhy.WhySlot`, damit dieses Modul nicht von ihm abhängt (der
 * Generator hängt an DIESEM Modul, nicht umgekehrt).
 */
export interface GrenzenSlot {
  slotFlags?: string[] | null;
  /** Der Börsenpreis in EUR/MWh; < 0 ist der exportierte Negativpreis-Fakt. */
  priceEurMwh?: number | null;
}

/**
 * Die Grenzen-Fakten, die NICHT in der Viertelstunde stehen: die gepflegte
 * Einspeisegrenze der Anlage und der Block der Box. Beide optional — ohne sie
 * ist jede Fläche zeichengleich zu Stufe 2 (die Gründe bleiben, nur die Zahl
 * bzw. der Geräte-Satz fehlen).
 */
export interface GrenzenKontext {
  /** `site.maxFeedInKw` — die im Portal hinterlegte Einspeisegrenze (kW). */
  maxFeedInKw?: number | null;
  /** Der s0-Block: Einspeisewächter + die Grenze IM GERÄT. */
  curtailment?: CurtailmentStatus | null;
}

export interface GrenzenGrund {
  id: GrenzenId;
  urheber: GrenzenUrheber;
  /** „Ihr Netzbetreiber" — das Wort für die Fläche. */
  urheberLabel: string;
  /** Der ganze Satz (§5.4-Wortlaut). */
  text: string;
}

const URHEBER_VON: Record<GrenzenId, GrenzenUrheber> = {
  netzgrenze_14a: 'netzbetreiber',
  einspeisegrenze: 'anmeldung',
  negativpreis: 'markt',
};

/** de-DE „-2,1 ct/kWh" aus EUR/MWh. */
function ctFmt(eurMwh: number): string {
  const ct = eurMwh / 10;
  return `${ct.toLocaleString('de-DE', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} ct/kWh`;
}

function num(v: number | null | undefined): number | null {
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
}

/** Trägt die Viertelstunde das Flag, das diese Grenze belegt? */
function belegt(id: GrenzenId, slot: GrenzenSlot): boolean {
  if (id === 'negativpreis') {
    const p = num(slot.priceEurMwh);
    return p != null && p < 0;
  }
  const flag = FLAG_FUER[id];
  return flag != null && (slot.slotFlags ?? []).includes(flag);
}

/**
 * Der Satz einer belegten Grenze (§5.4-Wortlaut). `mitZahl` ist die einzige
 * Stelle, an der der Kontext zählt: ohne gepflegte Einspeisegrenze wird die
 * Ursache trotzdem genannt (das FLAG ist der Fakt), nur eben ohne Zahl — eine
 * erfundene kW-Angabe wäre schlimmer als keine.
 */
function grundText(id: GrenzenId, slot: GrenzenSlot, kontext?: GrenzenKontext | null): string {
  switch (id) {
    case 'netzgrenze_14a':
      return (
        'Ihr Netzbetreiber begrenzt gerade den Netzanschluss (§ 14a) – der Plan ' +
        'hält die Grenze ein; Ihr Gerät begrenzt zusätzlich.'
      );
    case 'einspeisegrenze': {
      const cap = num(kontext?.maxFeedInKw);
      const wieviel =
        cap == null ? 'nur eine begrenzte Leistung' : `höchstens ${fmtNum(cap, 'kW', 1)}`;
      return `Ihre Anlage darf am Netzanschluss ${wieviel} einspeisen – der Plan begrenzt die PV auf diesen Wert.`;
    }
    case 'negativpreis': {
      const p = num(slot.priceEurMwh);
      return p != null
        ? `Einspeisen würde beim negativen Börsenpreis (${ctFmt(p)}) Geld kosten.`
        : 'Einspeisen würde beim negativen Börsenpreis Geld kosten.';
    }
  }
}

/** Alle Grenzen, die diese Viertelstunde BELEGT geformt haben (§8-Reihenfolge). */
export function gruende(slot: GrenzenSlot, kontext?: GrenzenKontext | null): GrenzenGrund[] {
  const out: GrenzenGrund[] = [];
  for (const id of GRUND_REIHENFOLGE) {
    if (!belegt(id, slot)) continue;
    const urheber = URHEBER_VON[id];
    out.push({
      id,
      urheber,
      urheberLabel: URHEBER_LABEL[urheber],
      text: grundText(id, slot, kontext),
    });
  }
  return out;
}

/**
 * Der LEITGRUND einer Drosselung — null, wenn keine Ursache belegt ist. Genau
 * dieses `null` ist die Stufe-3-Zusage: die Fläche sagt dann, was der Plan TUT,
 * und behauptet keine der drei möglichen Ursachen.
 */
export function leitgrund(
  slot: GrenzenSlot,
  kontext?: GrenzenKontext | null,
): GrenzenGrund | null {
  return gruende(slot, kontext)[0] ?? null;
}

/**
 * Der Querverweis auf die Befehle-Seite (§5.4): wo eine Grenze WIRKTE, ist die
 * Anschlussfrage immer dieselbe — „schickt VoltPilot dieses Limit an mein
 * Gerät?". Die Adresse baut die Fläche (`nav.befehleHash`), hier steht nur das
 * Wort, damit es an jedem Warum-Ort gleich lautet.
 */
export const GRENZEN_VERWEIS = 'Was VoltPilot an dieses Gerät schickt: Befehle ansehen';

/** Die Überschrift des Blocks — er sammelt NUR die Grenzen am Netzanschluss. */
export const GRENZEN_TITEL = 'Grenzen am Netzanschluss';

export interface GrenzenView {
  /** Die belegten Grenzen dieser Viertelstunde, Urheber zuerst. */
  gruende: GrenzenGrund[];
  /**
   * Die FREMDE Wahrheit: was der Wechselrichter selbst hält. Wörtlich der Satz
   * aus `curtailment.deviceLimitLine` — eine zweite Formulierung wäre ein
   * zweites Urteil.
   */
  geraet: string | null;
  /** Der Verweis-Text; er steht nur da, wo wirklich eine Grenze wirkte. */
  verweis: string;
}

/**
 * Der Block „Grenzen am Netzanschluss" einer Viertelstunde — null, sobald es
 * nichts Belegtes zu sagen gibt (Null-Degradation: ein älterer Lauf ohne Flags
 * und eine Box ohne s0-Block rendern zeichengleich wie vor dieser Stufe).
 *
 * Das TOR ist bewusst ROLLEN-UNABHÄNGIG: die Einspeisegrenze bindet auch in
 * einer Viertelstunde, die verkauft oder den Verbrauch deckt — dort stellt sich
 * dieselbe Frage („warum nicht mehr?"), und eine Erklärung, die nur an der
 * Rolle `abregeln` hängt, verschwiege sie. Gezeigt wird der Block, sobald eine
 * Grenze am Netzanschluss belegt gebunden hat ODER der Plan hier drosselt
 * (`curtailing`) — nur dann ist die Grenze im Gerät die Antwort auf eine
 * Frage, die der Kunde gerade stellt.
 *
 * ⚠ `bereitsGenannt` ist die Umsetzung der Haus-Regel „nichts steht ZWEIMAL
 * auf einer Karte": auf einer Abregel-Karte trägt der Warum-Satz den Leitgrund
 * bereits WÖRTLICH, also lässt der Block ihn aus (im Browser wäre die
 * Einspeisegrenze sonst zweimal untereinander gestanden). Auf einer Karte, die
 * ihre Ursache NICHT nennt (verkaufen/eigenverbrauch am Cap), bleibt er drin —
 * dort ist er die einzige Erklärung.
 */
export function grenzenView(
  slot: GrenzenSlot,
  kontext?: GrenzenKontext | null,
  bereitsGenannt?: GrenzenId | null,
): GrenzenView | null {
  const flags = slot.slotFlags ?? [];
  const geformt =
    flags.includes('grid_limit_14a') ||
    flags.includes('feed_in_cap') ||
    flags.includes('curtailing');
  if (!geformt) return null;
  const g = gruende(slot, kontext).filter((x) => x.id !== bereitsGenannt);
  const geraet = deviceLimitLine(kontext?.curtailment ?? null);
  if (g.length === 0 && geraet == null) return null;
  return { gruende: g, geraet, verweis: GRENZEN_VERWEIS };
}
