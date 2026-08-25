/**
 * Die **VORSCHAU MIT ZAHLEN** und der **NACHTEIL-BELEG** (Steuerung Stufe 7,
 * Konzept `vp-steuerung-konzept-b3` §3.5/§3.6/§3.8; Leitprinzip Regel 2 und 3).
 *
 * Zwei Fragen, zwei Richtungen, EIN Modul:
 *
 *  - **VORHER** („was ändert diese Entscheidung?") — die Zahl kommt vom
 *    SERVER (`POST /sites/{id}/steuerung-vorschau`, zwei echte Solver-Läufe
 *    über eine Eingabe). Hier steht nur, wie aus ihr ein deutscher Satz wird.
 *  - **LAUFEND** („was kostet mich diese Regel gerade?") — die Näherung
 *    {@link nachteilBisher} aus dem Fahrplan, den die Seite ohnehin geladen
 *    hat. Sie ist die Antwort auf Leitprinzip Regel 3: *„die Steuerung zeigt
 *    laufend, wenn eine Kundenregel die Automatik gerade ausbremst"*.
 *
 * ---
 * **⚠ JEDE ZAHL HIER IST EINE NÄHERUNG, UND JEDE SAGT DAS.** Der Präzedenzfall
 * ist `batterySavingsPlannedEur` (die Historie nennt eine geplante Zahl nie
 * „gemessen"). Eine exakte Gegenwelt bräuchte ein zweites, regelfreies Solve je
 * Lauf — das ist ausdrücklich NICHT gebaut (Konzept §3.8 G8, „L").
 *
 * **⚠ Ohne belastbare Zutat GAR KEINE Zahl.** Fehlt der Bezugspreis, der Wert
 * gespeicherter Energie (λ) oder die Ladeleistung des Speichers, ist das
 * Ergebnis `null` MIT Grund — nie eine 0 und nie eine Schätzung aus dem, was
 * gerade da ist. Der Warum-Wächter (`begruendung.test.ts`) prüft das über das
 * Verhalten.
 *
 * PURE + unit-getestet (`vorschau.test.ts`); die Fläche rendert nur.
 */
import type { ScheduleSlot } from './api';
import { fmtNum } from './format';

// ---------------------------------------------------------------------------
// 1 · VORHER — die Server-Zahl als Satz
// ---------------------------------------------------------------------------

/** Was die Kunden-Route liefert (die api spiegelt sie 1:1). */
export interface VorschauErgebnis {
  /** variante − basis in EUR; negativ = es kostet. null = keine Zahl. */
  deltaEur: number | null;
  basisEur: number | null;
  varianteEur: number | null;
  horizonSlots: number | null;
  /** Immer true — es gibt keinen exakten Zweig. */
  naeherung: boolean;
  /** Warum es keine Zahl gibt; nur gesetzt, wenn `deltaEur` null ist. */
  grund: string | null;
}

/**
 * Der Satz für Block 2 der Folgen-Karte („Auswirkung auf den Fahrplan").
 *
 * ⚠ Er nennt IMMER den Zeitraum, über den gerechnet wurde. Ohne ihn läse sich
 * „kostet 0,90 €" als Dauer-Aussage, während es die Wirkung über den
 * Fahrplan-Horizont ist — und der endet spätestens morgen.
 */
/**
 * Was in Block 2 steht, SOLANGE die Server-Zahl unterwegs ist.
 *
 * ⚠ Sie ist der Grund, warum die Fläche einen Lade-Zustand führt statt einfach
 * auf den Ehrlichkeits-Satz zurückzufallen: „Nicht abschätzbar" und eine
 * Sekunde später ein Euro-Betrag sind ZWEI WAHRHEITEN über dieselbe
 * Entscheidung, gelesen in der Reihenfolge, in der sie einander widersprechen.
 * Ein Kunde, der schnell klickt, hätte die falsche gelesen.
 */
export const VORSCHAU_LAEUFT =
  'VoltPilot rechnet gerade aus, was das an Ihrem Fahrplan ändert …';

export interface SatzOptionen {
  /**
   * Der gerechnete Knopf ist SCHWÄCHER als die Entscheidung, die er abbildet —
   * die wahre Wirkung liegt also jenseits der Zahl.
   *
   * ⚠ Das ist keine Feinheit, sondern die Richtung, in der eine Näherung
   * gefährlich wird. `socFloorNow` ist ein BODEN (laden und wieder bis dorthin
   * entladen bleibt erlaubt), eine haltende Regel ist eine EINFRIERUNG. Die
   * gerechnete Zahl unterschätzt die Kosten also systematisch — und ein zu
   * kleiner Preis ist genau der Fehler, der einen Kunden klicken lässt. Mit
   * `untergrenze` sagt der Satz „mindestens" bzw. „höchstens" und behauptet
   * damit nur noch, was wirklich belegt ist.
   */
  untergrenze?: boolean;
}

export function vorschauSatz(
  v: VorschauErgebnis | null,
  opt?: SatzOptionen,
): string | null {
  if (!v) return null;
  if (v.deltaEur == null) return v.grund;
  const betrag = fmtNum(Math.abs(v.deltaEur), '€', 2);
  const zeitraum = zeitraumWort(v.horizonSlots);
  // Die gerechnete Variante ist die MILDERE, ihr Ergebnis also die obere
  // Schranke des Kundennutzens: ein Nachteil ist mindestens so gross, ein
  // Vorteil höchstens so gross.
  const kosten = opt?.untergrenze ? 'mindestens ' : '';
  const nutzen = opt?.untergrenze ? 'höchstens ' : '';
  return v.deltaEur < 0
    ? `Im ${zeitraum} kostet Sie das voraussichtlich ${kosten}${betrag} — VoltPilot plant `
      + 'dafür anders. (Näherung aus dem aktuellen Fahrplan.)'
    : `Im ${zeitraum} bringt Ihnen das voraussichtlich ${nutzen}${betrag}. `
      + '(Näherung aus dem aktuellen Fahrplan.)';
}

/** „Fahrplan-Zeitraum" bzw., wenn er bekannt ist, die Stundenzahl. */
export function zeitraumWort(slots: number | null | undefined): string {
  if (slots == null || !Number.isFinite(slots) || slots <= 0) return 'Fahrplan-Zeitraum';
  const stunden = Math.round(slots / 4);
  return stunden >= 1 ? `Zeitraum der nächsten ${stunden} Stunden` : 'Fahrplan-Zeitraum';
}

/**
 * Der Vorrang-Hinweis **Variante 2** (§3.6, Captain-Entscheid S2: „Variante 2
 * mit Zahl, sobald vorhanden"). Sie IST Variante 1 mit der Zahl — deshalb
 * entsteht sie aus dem Variante-1-Satz plus dem Vorschau-Satz und nicht als
 * dritter, eigener Wortlaut.
 *
 * ⚠ **Ohne Zahl gibt es sie nicht.** Der Aufrufer bleibt dann bei Variante 1;
 * eine „Variante 2" ohne Zahl wäre schlicht Variante 1 mit einer leeren
 * Behauptung.
 */
export function vorrangMitZahl(
  variante1: string,
  v: VorschauErgebnis | null,
  opt?: SatzOptionen,
): string | null {
  if (!v || v.deltaEur == null) return null;
  const betrag = fmtNum(Math.abs(v.deltaEur), '€', 2);
  const kosten = opt?.untergrenze ? 'mindestens ' : '';
  const nutzen = opt?.untergrenze ? 'höchstens ' : '';
  const richtung = v.deltaEur < 0
    ? `Im ${zeitraumWort(v.horizonSlots)} kostet Sie das voraussichtlich ${kosten}${betrag}`
    : `Im ${zeitraumWort(v.horizonSlots)} bringt Ihnen das voraussichtlich ${nutzen}${betrag}`;
  // Variante 1 ohne ihren Schluss-Satz, dann die Zahl, dann der Rückweg —
  // derselbe Fakt, nur beziffert.
  return `${variante1} ${richtung} (Näherung aus dem aktuellen Fahrplan).`;
}

// ---------------------------------------------------------------------------
// 1b · Die ÜBERSETZUNG einer Entscheidung in die drei Knöpfe
// ---------------------------------------------------------------------------

/**
 * Was die Vorschau-Route entgegennimmt. Sie kennt GENAU drei Knöpfe; alles,
 * was sich nicht in sie übersetzen lässt, bekommt keine Zahl.
 */
export interface Knoepfe {
  socFloorNow?: boolean;
  forcedChargeSlots?: number;
  verbraucherAbSlot?: number;
  verbraucherSlots?: number;
  verbraucherKw?: number;
}

/** Eine übersetzte Entscheidung: die Eingabe UND wie ehrlich sie ist. */
export interface Uebersetzung {
  knoepfe: Knoepfe;
  /** Siehe {@link SatzOptionen.untergrenze}. */
  untergrenze: boolean;
}

/**
 * **Eine Regel, die den Speicher beansprucht** — der Fahrplan verliert ihn
 * (Stufe 3). Der nächstliegende Knopf ist der SoC-Boden.
 *
 * ⚠ Er ist nachweislich SCHWÄCHER als der Anspruch (Boden statt Einfrierung),
 * deshalb `untergrenze: true`. Einen exakten Knopf gäbe es (`battery_held` im
 * Solver seit Stufe 3), aber die Kunden-Route führt bewusst nur die drei
 * benannten — ihn zu ergänzen ist eine eigene, begründete Entscheidung, keine
 * Nebenwirkung dieser Fläche.
 */
export function knoepfeFuerSpeicherRegel(): Uebersetzung {
  return { knoepfe: { socFloorNow: true }, untergrenze: true };
}

/**
 * **Ein Handeingriff am Speicher.** „Ladestand halten" ist derselbe Boden wie
 * oben (und damit dieselbe Untergrenze); „Speicher jetzt laden" ist über die
 * Dauer EXAKT abbildbar, also ohne Vorbehalt.
 *
 * ⚠ Ohne Dauer gibt es beim Laden keine Eingabe — eine erfundene Dauer ergäbe
 * eine erfundene Zahl.
 */
export function knoepfeFuerEingriff(
  aktion: 'speicher_halten' | 'speicher_laden' | 'pause' | 'resume',
  minuten: number | null | undefined,
): Uebersetzung | null {
  if (aktion === 'speicher_halten') {
    return { knoepfe: { socFloorNow: true }, untergrenze: true };
  }
  if (aktion === 'speicher_laden') {
    if (minuten == null || !Number.isFinite(minuten) || minuten <= 0) return null;
    const slots = Math.max(1, Math.round(minuten / 15));
    return { knoepfe: { forcedChargeSlots: slots }, untergrenze: false };
  }
  // „Automatik pausieren" trifft JEDE Komponente auf ihren Failsafe — das ist
  // keiner der drei Knöpfe, und das Nächstliegende zu rechnen hiesse, eine
  // andere Frage zu beantworten als die gestellte.
  return null;
}

// ---------------------------------------------------------------------------
// 2 · LAUFEND — der Nachteil-Beleg (§3.8 G8)
// ---------------------------------------------------------------------------

export interface Nachteil {
  /** Die Näherung in EUR (>= 0). null = nicht bestimmbar. */
  eur: number | null;
  /** Die Energie, um die es geht (kWh). null = nicht bestimmbar. */
  kwh: number | null;
  /** Wie viele Viertelstunden gewertet wurden. */
  slots: number;
  /** Warum es keine Zahl gibt — nur gesetzt, wenn `eur` null ist. */
  grund: string | null;
}

/** Der Grund, wenn der Fahrplan die fragliche Zeit gar nicht abdeckt. */
export const KEINE_SLOTS =
  'Für die Zeit seit dem Start der Regel liegt kein Fahrplan vor.';

/** Der Grund, wenn Preis oder Speicherwert fehlen. */
export const KEINE_PREISE =
  'Für diese Zeit fehlen Strompreis oder Speicherwert — der Nachteil lässt sich nicht beziffern.';

const SLOT_STUNDEN = 0.25;

/**
 * **Was die Regel den Fahrplan bisher gekostet hat — eine Näherung.**
 *
 * Gerechnet wird je Viertelstunde seit `seit`: das Haus hatte ein Defizit
 * (`load − pv`), der Speicher hätte es decken können (bis zu seiner
 * Entladeleistung), und das hätte `importPreis − λ` je kWh gespart. Solange
 * die Regel den Speicher hält, ist genau das die entgangene Ersparnis.
 *
 * ⚠ **Drei Ehrlichkeiten, die nicht wegoptimiert werden dürfen:**
 *
 *  1. **Ein Slot ohne Preis ODER ohne λ macht die GANZE Zahl unbestimmbar** —
 *     mit weniger Slots weiterzurechnen ergäbe eine zu kleine Zahl, die wie
 *     eine echte aussieht (dieselbe Regel wie in `handeingriff.planVerzicht`).
 *  2. **Eine NEGATIVE Marge zählt als 0, nie als Gewinn.** Wo der Speicherwert
 *     über dem Bezugspreis liegt, war das Halten richtig — daraus einen
 *     Vorteil zu buchen, machte aus dem Nachteil-Beleg eine Werbung.
 *  3. **Ohne Entladeleistung gibt es keine Obergrenze** und damit keine
 *     belastbare Energie — dann ist das Ergebnis `null`.
 */
export function nachteilBisher(
  slots: readonly ScheduleSlot[] | null | undefined,
  seit: Date | null,
  now: Date,
  maxEntladeKw: number | null,
): Nachteil {
  const leer = (grund: string): Nachteil => ({ eur: null, kwh: null, slots: 0, grund });
  if (!slots || slots.length === 0 || !seit) return leer(KEINE_SLOTS);
  if (maxEntladeKw == null || !Number.isFinite(maxEntladeKw) || maxEntladeKw <= 0) {
    return leer(KEINE_PREISE);
  }
  const von = seit.getTime();
  const bis = now.getTime();
  let kwh = 0;
  let eur = 0;
  let gewertet = 0;
  for (const s of slots) {
    const t = Date.parse(s.start);
    if (!Number.isFinite(t) || t < von || t >= bis) continue;
    gewertet += 1;
    const load = s.loadKw;
    const pv = s.pvKw;
    if (load == null || !Number.isFinite(load)) return leer(KEINE_PREISE);
    const defizit = Math.max(load - (pv != null && Number.isFinite(pv) ? pv : 0), 0);
    if (defizit <= 0) continue;
    const imp = s.importPriceCtKwh;
    const lam = s.storedValueCtKwh;
    if (imp == null || !Number.isFinite(imp) || lam == null || !Number.isFinite(lam)) {
      return leer(KEINE_PREISE);
    }
    const gedeckt = Math.min(defizit, maxEntladeKw) * SLOT_STUNDEN;
    const margeCt = Math.max(imp - lam, 0);
    kwh += gedeckt;
    eur += (gedeckt * margeCt) / 100;
  }
  if (gewertet === 0) return leer(KEINE_SLOTS);
  return { eur, kwh, slots: gewertet, grund: null };
}

/** Unter diesem Betrag wird nichts behauptet (Rundungs-Rauschen). */
export const NACHTEIL_SICHTBAR_AB = 0.02;

/**
 * Die laufende Zeile an der Regel-Karte (Leitprinzip Regel 3). Sie entsteht
 * NUR, wenn die Regel den Speicher wirklich beansprucht UND die Zahl
 * belastbar ist — sonst schweigt sie, statt einen Nachteil zu behaupten.
 */
export function nachteilZeile(
  n: Nachteil,
  seit: Date | null,
  zone?: string,
): string | null {
  if (n.eur == null || n.eur < NACHTEIL_SICHTBAR_AB) return null;
  const uhr = seit
    ? seit.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: zone })
    : null;
  const seitText = uhr ? `seit ${uhr} ` : '';
  return `Diese Regel hält den Speicher ${seitText}— dem Fahrplan sind dadurch bisher `
    + `etwa ${fmtNum(n.eur, '€', 2)} entgangen (Näherung).`;
}
