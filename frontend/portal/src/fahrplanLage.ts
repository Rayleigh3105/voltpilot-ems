/**
 * DIE „LAGE"-ZEILE der Fahrplan-Seite (Erklärbarkeit Stufe 2 „Die Lage",
 * Konzept `data/vp-warum-erklaerbar-e2` §6 + §10 Stufe 2, Captain-Entscheide
 * F1-F6; **F4: NUR die Fahrplan-Seite, NICHT das Cockpit-Band**).
 *
 * Sie beantwortet zwei Kundenfragen, BEVOR sie entstehen:
 *
 * - **W3 „Warum ist der Speicher mittags schon leer?"** → der TAGES-BOGEN:
 *   wie der Börsenpreis heute verläuft und was der Fahrplan daraus macht.
 *   (Der reale Fall: eine Anlage stand mittags auf 9 % SoC, die richtige
 *   Antwort - morgens teuer entladen, mittags im Preistal aus Solar füllen,
 *   abends wieder entladen - stand NIRGENDS kundenlesbar und wurde von Hand
 *   aus Preiskurve und Registern rekonstruiert.)
 * - **W9 „Was erwartet die Anlage für morgen?"** → der MORGEN-AUSBLICK aus
 *   dem Wetter-WORT und den PV-/Last-Eingaben, mit denen der Fahrplan
 *   wirklich gerechnet hat, plus der {@link BEDINGUNGS_SATZ}.
 *
 * ── DIE VIER EHRLICHKEITSREGELN (§6, bindend) ──────────────────────────────
 *
 * 1. **kWh-Zahlen NUR aus den Eingaben, mit denen wirklich geplant wurde.**
 *    Es sind dieselben Reihen, die das Fahrplan-Diagramm als Prognose-Linien
 *    zeichnet - Zeile und Diagramm können sich damit nicht widersprechen. Aus
 *    Bewölkung und kWp eine ZWEITE Erzeugungsprognose zu rechnen ist im Haus
 *    ausdrücklich verboten (`wetterLeistung.ts`); das Wetter liefert deshalb
 *    hier nur ein WORT ({@link weatherWhyTomorrow}), nie eine Zahl.
 * 2. **Reicht der Horizont nicht bis morgen** (vormittags, bevor die
 *    Börsenpreise für morgen vorliegen), sagt die Zeile GENAU DAS -
 *    `horizonHint`, derselbe Satz wie unter dem Diagramm - statt eines
 *    erfundenen Ausblicks.
 * 3. **Wo der Bogen nicht eindeutig ist, entfällt der Satz** (K1). Die
 *    Bogen-Erkennung ist bewusst eine einfache, prüfbare Heuristik über der
 *    persistierten Preisreihe; ein flacher oder krummer Tag bekommt keine
 *    Erzählung, keine geratene.
 * 4. **Jede Aussage über den Speicher hängt an einem exportierten Fakt** (die
 *    EINE Echtheits-Regel, `begruendung.test.ts`): der Plan-Halbsatz des
 *    Bogens an der GEMESSENEN Verteilung von Laden/Entladen im Plan selbst,
 *    die „hebt auf"/„füllt sich wieder"-Halbsätze an den Stufe-1-Lauf-Fakten
 *    (Anker + freie Auffüll-Quote). Fehlt der Fakt, fehlt der Halbsatz.
 *
 * ── Was hier bewusst NICHT steht ───────────────────────────────────────────
 *
 * - **Kein Vergleich „heute vs. morgen" in kWh.** Der jüngste Lauf deckt von
 *   HEUTE nur den Rest des Tages ab (er beginnt jetzt) - eine „heute ≈ X kWh"-
 *   Zahl daraus wäre je nach Tageszeit etwas anderes. Der Maßstab für die
 *   Überschuss-Zahl ist deshalb der erwartete VERBRAUCH von morgen, also
 *   dieselbe Reihe über demselben Fenster.
 * - **Keine Geld-Zahl.** Die Euro-Zeile der Seite ist ihr Ort; zwei Wahrheiten
 *   über denselben Betrag sind genau das, was das Haus vermeidet.
 */

import { fmtNum } from './format';
import {
  REFILL_HIGH_PCT,
  REFILL_LOW_PCT,
  refillFreePct,
  terminalAnchor,
  type PlanWhyFacts,
} from './fahrplanWhy';
import { horizonHint } from './schedule';
import { weatherWhyTomorrow, type CloudPoint, type TomorrowSky } from './weather';

/** Was die Lage-Ableitung je Viertelstunde braucht - ein Subset von `ScheduleSlot`. */
export interface LageSlot {
  start: string;
  /** + = laden, − = entladen (kW); null = der Lauf trägt den Wert nicht. */
  batteryKw: number | null;
  /** Der Börsenpreis der Viertelstunde (EUR/MWh); null = unbepreist. */
  priceEurMwh: number | null;
  /** Die PV-Prognose, mit der geplant wurde (kW). */
  pvKw?: number | null;
  /** Die Last-Prognose, mit der geplant wurde (kW). */
  loadKw?: number | null;
}

// ---- Der Tages-Bogen ------------------------------------------------------

/**
 * Die drei Tagesblöcke in LOKALER Zeit (DACH = Europe/Berlin, die
 * `todaySlots`-Konvention des Hauses). Die Nachtstunden gehören bewusst zu
 * keinem Block: der Bogen ist eine Aussage über den TAG, und eine billige
 * Nachtstunde würde den „mittags am günstigsten"-Vergleich verfälschen.
 */
export const BLOCK_MORGEN: [number, number] = [6, 11];
export const BLOCK_MITTAG: [number, number] = [11, 16];
export const BLOCK_ABEND: [number, number] = [16, 22];

/** Unter so vielen bepreisten Viertelstunden ist ein Block kein Block. */
export const BLOCK_MIN_SLOTS = 4;

/**
 * So viel muss das Mittagstal unter BEIDEN Randblöcken liegen, damit von einem
 * Bogen die Rede sein darf. Darunter ist der Tag flach oder krumm - und dann
 * entfällt der Satz (K1), statt eine Erzählung über 0,3 ct zu bauen.
 */
export const BOGEN_MIN_SPREAD_CT = 1.0;

/** Unter diesem Betrag ist eine Energie-Summe Rauschen, keine Handlung. */
export const BOGEN_DEADBAND_KWH = 0.5;

/** So viel der geplanten Ladung muss mittags liegen, damit „lädt mittags" gilt. */
export const BOGEN_LADEN_ANTEIL = 0.5;
/** So viel der geplanten Entladung muss in die Randblöcke fallen. */
export const BOGEN_ENTLADEN_ANTEIL = 0.6;

interface BlockZahlen {
  /** Mittlerer Börsenpreis des Blocks in ct/kWh. */
  ct: number;
  slots: number;
  ladenKwh: number;
  entladenKwh: number;
}

function localHour(iso: string): number {
  return new Date(iso).getHours();
}

function inBlock(iso: string, [von, bis]: [number, number]): boolean {
  const h = localHour(iso);
  return h >= von && h < bis;
}

/** Die Viertelstunden des Plans, die auf den lokalen Kalendertag von `now` fallen. */
function heute<T extends { start: string }>(slots: T[], now: Date): T[] {
  const tag = now.toDateString();
  return slots.filter((s) => new Date(s.start).toDateString() === tag);
}

function blockZahlen(
  slots: LageSlot[],
  block: [number, number],
  slotsProStunde: number,
): BlockZahlen | null {
  const drin = slots.filter((s) => inBlock(s.start, block));
  const preise = drin
    .map((s) => s.priceEurMwh)
    .filter((v): v is number => v != null && Number.isFinite(Number(v)))
    .map((v) => Number(v) / 10);
  if (preise.length < BLOCK_MIN_SLOTS) return null;
  const laden = drin.reduce((sum, s) => sum + Math.max(Number(s.batteryKw ?? 0), 0), 0);
  const entladen = drin.reduce((sum, s) => sum + Math.max(-Number(s.batteryKw ?? 0), 0), 0);
  return {
    ct: preise.reduce((a, b) => a + b, 0) / preise.length,
    slots: preise.length,
    ladenKwh: laden / slotsProStunde,
    entladenKwh: entladen / slotsProStunde,
  };
}

/** Der erkannte Tagesverlauf - heute genau EINE Form, der Rest ist `null`. */
export interface Tagesbogen {
  /** Mittlerer Börsenpreis je Block in ct/kWh. */
  morgenCt: number;
  mittagCt: number;
  abendCt: number;
  /** Der Fahrplan legt die Mehrheit seiner Ladung in den Mittagsblock. */
  laedtMittags: boolean;
  /** Der Fahrplan entlädt überwiegend in die beiden teuren Randblöcke. */
  entlaedtInDieRandbloecke: boolean;
}

/**
 * Der Bogen des heutigen Tages - oder `null`, wenn er nicht eindeutig ist.
 *
 * Erkannt wird GENAU EINE Form: das Mittagstal (morgens und abends teuer,
 * mittags am günstigsten). Sie ist die Form, aus der die Frage „warum ist mein
 * Speicher mittags leer?" entsteht; jede andere bleibt unbenannt, weil eine
 * Heuristik, die alles erklärt, nichts belegt.
 *
 * Die zwei Plan-Flags sind AUSSAGEN ÜBER DEN PLAN, nicht über seinen Grund:
 * sie zählen, wo die geplante Ladung bzw. Entladung wirklich liegt.
 */
export function tagesbogen(slots: LageSlot[], now: Date, slotMinutes = 15): Tagesbogen | null {
  if (slotMinutes <= 0) return null;
  const slotsProStunde = 60 / slotMinutes;
  const tag = heute(slots, now);
  const morgen = blockZahlen(tag, BLOCK_MORGEN, slotsProStunde);
  const mittag = blockZahlen(tag, BLOCK_MITTAG, slotsProStunde);
  const abend = blockZahlen(tag, BLOCK_ABEND, slotsProStunde);
  if (morgen == null || mittag == null || abend == null) return null;

  const rand = Math.min(morgen.ct, abend.ct);
  if (rand - mittag.ct < BOGEN_MIN_SPREAD_CT) return null;

  const ladenGesamt = morgen.ladenKwh + mittag.ladenKwh + abend.ladenKwh;
  const entladenGesamt = morgen.entladenKwh + mittag.entladenKwh + abend.entladenKwh;
  return {
    morgenCt: morgen.ct,
    mittagCt: mittag.ct,
    abendCt: abend.ct,
    laedtMittags:
      ladenGesamt > BOGEN_DEADBAND_KWH &&
      mittag.ladenKwh / ladenGesamt >= BOGEN_LADEN_ANTEIL,
    entlaedtInDieRandbloecke:
      entladenGesamt > BOGEN_DEADBAND_KWH &&
      (morgen.entladenKwh + abend.entladenKwh) / entladenGesamt >= BOGEN_ENTLADEN_ANTEIL,
  };
}

function ct(v: number): string {
  return fmtNum(v, 'ct/kWh');
}

/**
 * Der Bogen als EIN Satz. Der Preis-Teil ist reine Beobachtung; der
 * Plan-Halbsatz kommt nur dazu, soweit der Plan ihn wirklich trägt - er nennt
 * damit nie eine Handlung, die nicht im Fahrplan steht.
 */
export function bogenSatz(bogen: Tagesbogen | null): string | null {
  if (bogen == null) return null;
  const preise =
    `Der Börsenpreis ist heute morgens (Ø ${ct(bogen.morgenCt)}) und abends ` +
    `(Ø ${ct(bogen.abendCt)}) am teuersten, mittags am günstigsten (Ø ${ct(bogen.mittagCt)}).`;
  if (bogen.entlaedtInDieRandbloecke && bogen.laedtMittags) {
    return `${preise} Der Fahrplan entlädt den Speicher in die teuren Stunden und lädt ihn mittags – um die Mittagszeit ist er planmäßig am leersten.`;
  }
  if (bogen.entlaedtInDieRandbloecke) {
    return `${preise} Der Fahrplan entlädt den Speicher in die teuren Stunden.`;
  }
  if (bogen.laedtMittags) {
    return `${preise} Der Fahrplan lädt den Speicher mittags.`;
  }
  return preise;
}

// ---- Der Morgen-Ausblick --------------------------------------------------

/**
 * Bis zu dieser LOKALEN Stunde muss der Plan morgen reichen, damit über
 * „morgen" eine Tagesaussage entstehen darf.
 *
 * ⚠ Das ist die Regel, an der die ganze Ehrlichkeit dieses Halbsatzes hängt:
 * der rollierende 24-h-Horizont endet je nach Lauf-Zeitpunkt MITTEN in
 * morgen. Ein Lauf von 13 Uhr kennt von morgen nur die Stunden bis 13 Uhr -
 * die Summe daraus wäre kein Tages-Überschuss, sondern ein halber, und läse
 * sich als „morgen kommt kaum Sonne". Reicht der Plan nicht bis hierher, wird
 * über die kWh von morgen geschwiegen (das Wetter-WORT darf trotzdem stehen,
 * es kommt aus einer 48-h-Vorhersage).
 */
export const AUSBLICK_MIN_END_HOUR = 18;

/** Unter dieser Zahl bewerteter Viertelstunden gibt es keine Tagessumme. */
export const AUSBLICK_MIN_SLOTS = 32;

/** Die Energie-Erwartung für morgen, ausschließlich aus den Plan-Eingaben. */
export interface MorgenEnergie {
  /** Σ max(PV − Last, 0) über morgen, in kWh. */
  ueberschussKwh: number;
  /** Σ Last über morgen, in kWh - der Maßstab im selben Fenster. */
  verbrauchKwh: number;
}

/**
 * Was der Fahrplan für MORGEN erwartet - `null`, sobald die Grundlage fehlt
 * (Horizont reicht nicht weit genug, oder der Lauf trägt die Prognose-Spalten
 * nicht). Nie eine erfundene 0: „keine Aussage" und „kein Überschuss" sind
 * verschiedene Dinge.
 */
export function morgenEnergie(
  slots: LageSlot[],
  now: Date,
  slotMinutes = 15,
): MorgenEnergie | null {
  if (slotMinutes <= 0) return null;
  const morgen = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toDateString();
  const tag = slots.filter((s) => new Date(s.start).toDateString() === morgen);
  const mitPrognose = tag.filter(
    (s) =>
      s.pvKw != null &&
      s.loadKw != null &&
      Number.isFinite(Number(s.pvKw)) &&
      Number.isFinite(Number(s.loadKw)),
  );
  if (mitPrognose.length < AUSBLICK_MIN_SLOTS) return null;
  const letzte = mitPrognose[mitPrognose.length - 1];
  if (localHour(letzte.start) < AUSBLICK_MIN_END_HOUR) return null;
  const slotsProStunde = 60 / slotMinutes;
  const ueberschuss =
    mitPrognose.reduce(
      (sum, s) => sum + Math.max(Number(s.pvKw) - Number(s.loadKw), 0),
      0,
    ) / slotsProStunde;
  const verbrauch =
    mitPrognose.reduce((sum, s) => sum + Math.max(Number(s.loadKw), 0), 0) / slotsProStunde;
  return { ueberschussKwh: ueberschuss, verbrauchKwh: verbrauch };
}

const HIMMEL_SATZ: Record<TomorrowSky, string> = {
  sonnig: 'Für morgen meldet die Wettervorhersage überwiegend Sonne.',
  wechselnd: 'Für morgen meldet die Wettervorhersage wechselnde Bewölkung.',
  bewoelkt: 'Für morgen meldet die Wettervorhersage kaum Sonne.',
};

function kwh(v: number): string {
  return fmtNum(v, 'kWh', v >= 10 ? 0 : 1);
}

/**
 * Der Halbsatz über den Speicher - er hängt an den STUFE-1-LAUF-FAKTEN und
 * an nichts sonst (die EINE Echtheits-Regel, Gate-Tabelle `BEGRUENDUNGEN`
 * Einträge `lage_aufheben`/`lage_auffuellung`).
 *
 * Es ist bewusst dieselbe Aussage wie in `ankerSatz` auf der JETZT-Karte, nur
 * kürzer und auf morgen bezogen: eine ZWEITE Wahrheit über denselben Fakt wäre
 * genau das, was das Haus vermeidet. Die lange Fassung mit den Zahlen steht
 * hinter dem „Warum?" des Helden.
 */
export function speicherHalbsatz(plan?: PlanWhyFacts | null): string | null {
  const refill = refillFreePct(plan);
  if (refill == null) return null;
  if (refill <= REFILL_LOW_PCT && terminalAnchor(plan) === 'bezugspreis') {
    return 'Der Speicher hebt seine Ladung für die kommenden Abende auf.';
  }
  if (refill >= REFILL_HIGH_PCT) {
    return 'Der eigene Überschuss füllt den Speicher im Fahrplan-Zeitraum ohnehin wieder auf.';
  }
  return null;
}

/**
 * Der Morgen-Ausblick als EIN Satz-Block (oder `null`).
 *
 * Reihenfolge und Gates: das Wetter-WORT (aus der 48-h-Vorhersage), dann
 * entweder die kWh-Erwartung aus den Plan-Eingaben ODER - wenn der Horizont
 * morgen gar nicht erreicht - der ehrliche `horizonHint`. Nie beides, und nie
 * eine Zahl ohne ihr Fenster.
 */
export function ausblickSatz(
  slots: LageSlot[],
  now: Date,
  opts: {
    slotMinutes?: number;
    weather?: CloudPoint[] | null;
    plan?: PlanWhyFacts | null;
  } = {},
): string | null {
  const slotMinutes = opts.slotMinutes ?? 15;
  const teile: string[] = [];
  const himmel = opts.weather ? weatherWhyTomorrow(opts.weather, now) : null;
  if (himmel) teile.push(HIMMEL_SATZ[himmel]);

  const energie = morgenEnergie(slots, now, slotMinutes);
  if (energie != null) {
    teile.push(
      `Der Fahrplan rechnet für morgen mit ${kwh(energie.ueberschussKwh)} Solar-Überschuss ` +
        `bei ${kwh(energie.verbrauchKwh)} erwartetem Verbrauch.`,
    );
    const speicher = speicherHalbsatz(opts.plan);
    if (speicher) teile.push(speicher);
  } else {
    const hint = horizonHint(slots, now, slotMinutes);
    if (hint) teile.push(hint);
  }
  return teile.length === 0 ? null : teile.join(' ');
}

// ---- Die Zeile ------------------------------------------------------------

/**
 * Der Bedingungs-Satz (§6, konstant): er ist die halbe Flip-Erklärung. Ein
 * Kunde, der weiß, dass alle 15 Minuten neu geplant wird, liest eine geänderte
 * Kurve als Nachführung statt als Sprunghaftigkeit - und er behauptet dabei
 * NICHTS über einen einzelnen Wechsel (die Kausal-Attribution eines
 * Plan-Flips wäre wieder eine Erfindung, §7).
 */
export const BEDINGUNGS_SATZ =
  'Ändert sich die Vorhersage, plant VoltPilot automatisch neu – alle 15 Minuten.';

/** Die Herkunft, die unter der Zeile steht. */
export const LAGE_QUELLE_PLAN = 'Basiert auf Ihrer Verbrauchs- und PV-Prognose.';
export const LAGE_QUELLE_WETTER = 'Wetterdaten für Ihren Standort.';

export interface LageInput {
  /** Die Viertelstunden des JÜNGSTEN Laufs (nicht der Tages-Splice). */
  slots: LageSlot[];
  slotMinutes?: number;
  /** Die Lauf-Fakten der Erklärbarkeit Stufe 1; ohne sie fehlt der Speicher-Halbsatz. */
  plan?: PlanWhyFacts | null;
  /** Die Wetter-Vorhersage der Anlage; ohne sie fehlt das Himmels-Wort. */
  weather?: CloudPoint[] | null;
  now: Date;
}

export interface LageView {
  /** Der Tages-Bogen; `null` = der Tag hat keine eindeutige Form. */
  bogen: string | null;
  /** Der Morgen-Ausblick bzw. der ehrliche Horizont-Hinweis. */
  ausblick: string | null;
  /** {@link BEDINGUNGS_SATZ} - immer dabei, sobald die Zeile überhaupt steht. */
  bedingung: string;
  /** Woher die Aussagen kommen. */
  quelle: string;
}

/**
 * Die ganze Zeile - oder `null`, wenn es nichts Belegtes zu sagen gibt.
 *
 * `null` ist der Normalfall eines älteren Laufs (keine Prognose-Spalten, keine
 * Preise) und einer Anlage ohne Wetterdaten: die Fahrplan-Seite rendert dann
 * zeichengleich wie vor dieser Stufe. Eine Karte, die nur den konstanten
 * Bedingungs-Satz trüge, wäre Rauschen - deshalb hängt sie an mindestens EINER
 * abgeleiteten Aussage.
 */
export function lageView(input: LageInput): LageView | null {
  const slotMinutes = input.slotMinutes ?? 15;
  const bogen = bogenSatz(tagesbogen(input.slots, input.now, slotMinutes));
  const ausblick = ausblickSatz(input.slots, input.now, {
    slotMinutes,
    weather: input.weather,
    plan: input.plan,
  });
  if (bogen == null && ausblick == null) return null;
  const nutztWetter =
    input.weather != null && weatherWhyTomorrow(input.weather, input.now) != null;
  return {
    bogen,
    ausblick,
    bedingung: BEDINGUNGS_SATZ,
    quelle: nutztWetter ? `${LAGE_QUELLE_PLAN} ${LAGE_QUELLE_WETTER}` : LAGE_QUELLE_PLAN,
  };
}
