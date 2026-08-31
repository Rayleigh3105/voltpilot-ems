/**
 * **VORSCHLÄGE** — Zone ② der Steuerung, ganz oben (Konzept
 * `vp-steuerung-konzept-b3` §3.3, Stufe 6; Leitprinzip Regel 1: *„Vorschlag vor
 * Regel"*).
 *
 * Die Software ist zuerst ein BERATER: aus dem Fahrplan (Überschuss- und
 * Preis-Fenster) und den steuerbaren Komponenten dieser Anlage entstehen
 * konkrete Karten — „Wallbox heute 11:00–15:00 laden, da ist Überschuss".
 * „Übernehmen" öffnet den EINEN bestehenden Regel-Baukasten VORBEFÜLLT; erst
 * dort, hinter der Folgen-Karte, wird daraus eine Regel.
 *
 * ⚠ **EIN VORSCHLAG WIRD NIRGENDS GESPEICHERT** (Konzept §4 wörtlich). Er ist
 * eine Ableitung und erneuert sich mit jedem Fahrplan (alle 15 Minuten).
 * Server-seitig lebt nur die GEGENRICHTUNG: dass der Kunde ihn gerade nicht
 * sehen will (`site_suggestion_state`, weil `localStorage` im Haus verboten
 * ist).
 *
 * ⚠ **ES ENTSTEHT KEINE ZWEITE REGEL-MECHANIK** (Captain: „nur freier
 * Builder", keine Vorlagen-Mechanik). Ein Vorschlag liefert eine
 * `Partial<ConsumerDraft>`-VORBEFÜLLUNG in genau denselben Baukasten, den die
 * Startpunkte seit Stufe 2 füllen — nur mit Zahlen, die aus DIESEM Fahrplan
 * stammen statt aus einer statischen Vorlage.
 *
 * ---
 * **DIE FÜNF EHRLICHKEITSREGELN** (der Warum-Wächter `begruendung.test.ts`
 * prüft die erste davon über das VERHALTEN):
 *
 *  1. **Ohne belastbares Fenster kein Vorschlag.** Fehlen `pvKw`/`loadKw` oder
 *     `importPriceCtKwh`, ist das Fenster zu kurz, oder ist der Tag preislich
 *     flach — dann entsteht GAR KEINE Karte, nie eine mit einer geschätzten
 *     Zahl. Jede Begründung nennt Zahlen, die im Fahrplan stehen.
 *  2. **Ohne steuerbare Komponente kein Vorschlag.** Eine Karte, deren
 *     „Übernehmen" in einen Anlege-Assistenten liefe, ist kein Vorschlag,
 *     sondern eine Umleitung — den Weg nennt der Leer-Zustand der Kapsel.
 *  3. **Nichts vorschlagen, was schon läuft.** Eine Komponente mit aktiver
 *     Regel, mit einem Anspruch aus einem anderen Flow (Stufe 3) oder mit
 *     laufendem Handeingriff (Stufe 4) bekommt keine Karte.
 *  4. **Das Fenster muss die Komponente TRAGEN.** Ein Überschuss-Fenster, das
 *     die Mindestleistung des Geräts nicht hergibt, verspräche einen Lauf, der
 *     nicht zustande kommt.
 *  5. **Höchstens EINE Karte je Komponente, höchstens {@link MAX_VORSCHLAEGE}
 *     insgesamt.** Zwei Karten über dieselbe Wallbox sind Rauschen.
 *
 * ---
 * **⚠ Eine argumentierte Abweichung vom Beispiel-Wortlaut des Konzepts.** §3.3
 * skizziert die Vorbefüllung als „Wenn Solar-Überschuss > 2 kW **und 11–15
 * Uhr** · dann Wallbox ein". Gebaut ist die Regel OHNE das feste Zeitfenster,
 * und zwar aus zwei Gründen: (a) der Verbraucher-Fragenbaum stellt die
 * Zeitfenster-Frage bei der Absicht „reagieren" gar nicht
 * (`consumerQuestions`), eine mitgeschriebene `recurrence` wäre also ein
 * verborgener Zustand, den der Kunde im Baukasten nie zu sehen bekäme; und (b)
 * ein hartes Fenster machte die Regel an jedem ANDEREN Tag falsch — der
 * Überschuss verschiebt sich mit dem Wetter. Die Uhrzeit im Titel ist deshalb
 * die VORHERSAGE dieses Fahrplans („heute passiert das zwischen 11 und 15
 * Uhr"), die Regel selbst reagiert auf den GEMESSENEN Überschuss. Beides sagt
 * die Karte.
 *
 * PURE + unit-getestet (`vorschlaege.test.ts`); die Fläche rendert nur.
 */
import type {
  EntityStrategy, Intervention, ScheduleSlot, VorschauKnoepfe,
} from './api';
import type { ConsumerDraft } from './consumers/questions';
import type { Consumer } from './consumers/types';
import type { SteuerartWunsch } from './steuerartDialog';
import { fmtNum } from './format';
import { MIN_SPANNE_CT } from './preisFenster';

// ---------------------------------------------------------------------------
// Vokabular
// ---------------------------------------------------------------------------

/** Woraus ein Vorschlag entsteht. */
export type VorschlagArt = 'ueberschuss' | 'guenstig';

export interface Vorschlag {
  /**
   * Der stabile Schlüssel, unter dem „Später"/„Ablehnen" server-seitig
   * gemerkt wird. ABGELEITET (Art + Komponente), nie getippt — und in der
   * Form, die `Vorschlaege.pruefeSchluessel` hält.
   */
  key: string;
  art: VorschlagArt;
  /** Das Zeichen der Karte (die Fläche wählt daraus ihr Icon). */
  komponenteId: string;
  komponenteName: string;
  /** Die Überschrift („Wallbox heute 11:00–15:00 laden"). */
  titel: string;
  /** Die BEGRÜNDUNG mit den Zahlen aus dem Fahrplan. */
  begruendung: string;
  /** Der Name, den die vorbefüllte Regel vorschlägt. */
  regelName: string;
  /** Die Vorbefüllung des BESTEHENDEN Verbraucher-Baukastens. */
  prefill: Partial<ConsumerDraft>;
  /**
   * Die STEUERART, auf die dieser Vorschlag zielt (Verbrauchsmanagement v1 P2,
   * Konzept §6.1: „Ein Vorschlag zielt auf die Steuerart").
   *
   * ⚠ Er SETZT sie nicht — „Übernehmen" öffnet den Steuerart-Dialog auf seiner
   * Folgen-Karte, damit vor dem Speichern dasteht, was passiert. Das ist die
   * Haus-Regel „die Folgen-Karte steht IMMER vor der Aktivierung"; ein Knopf,
   * der ohne sie schreibt, wäre die eine Stelle, an der sie fehlte.
   */
  steuerart: SteuerartWunsch;
  /**
   * Die Übersetzung DIESES Vorschlags in die drei Knöpfe der Vorschau-Route
   * (Steuerung Stufe 7). Sie entsteht HIER, wo Fenster und Leistung ohnehin
   * gerechnet werden — eine zweite Ableitung aus Titel oder Vorbefüllung wäre
   * geraten, und eine geratene Eingabe ergibt eine erfundene Zahl.
   *
   * ⚠ `verbraucherAbSlot` zählt ab dem LAUFENDEN Slot, weil `kommend()` ihn
   * behält — dieselbe Null wie der Horizont des Optimierers. Wer an einer der
   * beiden Stellen dreht, verschiebt die Vorschau um Viertelstunden.
   *
   * `null` = dieser Vorschlag lässt sich nicht belastbar übersetzen; dann
   * zeigt seine Folgen-Karte keine Zahl (Leitprinzip Regel 2).
   */
  knoepfe: VorschauKnoepfe | null;
}

/** Der Knopf, mit dem ein Kunde die Wirkung EINES Vorschlags erfragt. */
export const WAS_BRINGT = 'Was bringt das?';

/**
 * Warum die Zahl NICHT von selbst an jeder Karte steht (Steuerung Stufe 7).
 *
 * ⚠ Eine Vorschau ist ein echter MILP-Lauf. Drei Karten beim Öffnen der Seite
 * wären drei Solve-Läufe, die niemand bestellt hat — genau der Grund, warum die
 * Route einen Deckel hat. Sie wird deshalb GEFRAGT, nicht gedrängt.
 */
export const WAS_BRINGT_HINWEIS =
  'VoltPilot rechnet die Wirkung dieses Vorschlags auf Ihren Fahrplan aus.';

/**
 * Was an einer Karte steht, deren Vorschlag sich nicht in die drei Knöpfe der
 * Vorschau-Route übersetzen lässt. Sie bekommt den Knopf gar nicht erst —
 * dieser Satz ist die Begründung im Titel, nie eine Zahl.
 */
export const WAS_BRINGT_NICHT =
  'Für diesen Vorschlag lässt sich die Wirkung noch nicht ausrechnen.';

/**
 * Die Zeitzone der Plattform (v1, wie `anlage.ts` und `HistoryRange.ZONE`
 * server-seitig). Sie steht hier, damit die Uhrzeit einer Karte NICHT von der
 * Zeitzone des Browsers abhängt - ein Kunde im Urlaub liest sonst ein Fenster,
 * das seine Anlage nie hat.
 */
export const PLATTFORM_ZONE = 'Europe/Berlin';

/** Wie viele Karten die Zone höchstens zeigt (§3.3: „0–3 Karten"). */
export const MAX_VORSCHLAEGE = 3;

/** Ein Fahrplan-Slot ist eine Viertelstunde. */
const SLOT_STUNDEN = 0.25;
const SLOT_MS = SLOT_STUNDEN * 3_600_000;

/**
 * Wie lang ein Überschuss-Fenster mindestens sein muss (4 Slots = 1 Stunde).
 * Kürzer ist kein Fenster, sondern eine Wolkenlücke — und ein Gerät, das eine
 * Viertelstunde anläuft, hat niemandem geholfen.
 */
export const MIN_UEBERSCHUSS_SLOTS = 4;

/** Wie lang ein günstiges Fenster ist (8 Slots = 2 Stunden). */
export const GUENSTIG_SLOTS = 8;

/** Unter diesem Überschuss lohnt keine Aussage (Messrauschen). */
export const MIN_UEBERSCHUSS_KW = 0.5;

// ---------------------------------------------------------------------------
// Die Fenster (die einzige Stelle, an der hier gerechnet wird)
// ---------------------------------------------------------------------------

export interface Fenster {
  /** Erster Slot (einschliesslich) und letzter Slot (EINSCHLIESSLICH). */
  vonIdx: number;
  bisIdx: number;
  /** Beginn des ersten und ENDE des letzten Slots, als ISO-Zeitpunkte. */
  von: string;
  bis: string;
}

export interface UeberschussFenster extends Fenster {
  /** Die Energie, die der Fahrplan im Fenster als Überschuss erwartet (kWh). */
  kwh: number;
  /** Die KLEINSTE Überschuss-Leistung im Fenster (kW) — sie trägt die Zusage. */
  minKw: number;
  /** Die grösste Überschuss-Leistung im Fenster (kW). */
  maxKw: number;
}

export interface PreisFensterVorschlag extends Fenster {
  /** Der mittlere Bezugspreis im Fenster (ct/kWh). */
  ctMittel: number;
  /** Der HÖCHSTE Bezugspreis im Fenster — daraus wird die Regel-Schwelle. */
  ctMax: number;
  /** Der mittlere Bezugspreis des ganzen Horizonts (der Vergleichsmassstab). */
  ctHorizont: number;
}

/** Nur Slots, deren Viertelstunde noch nicht vorbei ist. */
function kommend(slots: readonly ScheduleSlot[], now: Date): ScheduleSlot[] {
  const jetzt = now.getTime();
  return slots.filter((s) => {
    const t = Date.parse(s.start);
    return Number.isFinite(t) && t + SLOT_MS > jetzt;
  });
}

function ende(slot: ScheduleSlot): string {
  return new Date(Date.parse(slot.start) + SLOT_MS).toISOString();
}

/**
 * Das LÄNGSTE zusammenhängende Fenster, in dem der Fahrplan mehr Solarstrom
 * erwartet, als das Haus braucht — und in dem der Überschuss durchgehend
 * mindestens {@code minKw} beträgt.
 *
 * ⚠ Ein Slot ohne `pvKw` ODER ohne `loadKw` BRICHT das Fenster, statt
 * übersprungen zu werden: eine Lücke stillschweigend zu überbrücken hiesse,
 * eine Zusage über eine Viertelstunde zu machen, für die niemand etwas
 * gerechnet hat.
 */
export function ueberschussFenster(
  slots: readonly ScheduleSlot[] | null | undefined,
  now: Date,
  minKw: number,
): UeberschussFenster | null {
  if (!slots || slots.length === 0) return null;
  const kandidaten = kommend(slots, now);
  const schwelle = Math.max(minKw, MIN_UEBERSCHUSS_KW);
  let best: UeberschussFenster | null = null;
  let start = -1;
  for (let i = 0; i <= kandidaten.length; i += 1) {
    const s = i < kandidaten.length ? kandidaten[i] : null;
    const pv = s?.pvKw;
    const last = s?.loadKw;
    const ok =
      s != null
      && pv != null && Number.isFinite(pv)
      && last != null && Number.isFinite(last)
      && pv - last >= schwelle;
    if (ok) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) {
      const len = i - start;
      if (len >= MIN_UEBERSCHUSS_SLOTS && (best == null || len > best.bisIdx - best.vonIdx + 1)) {
        let kwh = 0;
        let min = Infinity;
        let max = -Infinity;
        for (let j = start; j < i; j += 1) {
          const ueber = (kandidaten[j].pvKw as number) - (kandidaten[j].loadKw as number);
          kwh += ueber * SLOT_STUNDEN;
          min = Math.min(min, ueber);
          max = Math.max(max, ueber);
        }
        best = {
          vonIdx: start,
          bisIdx: i - 1,
          von: kandidaten[start].start,
          bis: ende(kandidaten[i - 1]),
          kwh,
          minKw: min,
          maxKw: max,
        };
      }
      start = -1;
    }
  }
  return best;
}

/**
 * Das GÜNSTIGSTE zusammenhängende Fenster im kommenden Fahrplan.
 *
 * ⚠ Zwei Zurückhaltungen, beide aus der Preis-Grammatik des Hauses
 * (`preisFenster.ts` Regel 3) übernommen: ohne durchgehende Preise entsteht
 * kein Fenster, und auf einem FLACHEN Tag (Spanne unter
 * {@link MIN_SPANNE_CT}) ist „die günstigsten Stunden" eine Behauptung ohne
 * Inhalt — dann gibt es GAR KEINEN Vorschlag.
 */
export function guenstigFenster(
  slots: readonly ScheduleSlot[] | null | undefined,
  now: Date,
  len = GUENSTIG_SLOTS,
): PreisFensterVorschlag | null {
  if (!slots || slots.length === 0 || len <= 0) return null;
  const kandidaten = kommend(slots, now);
  const cts = kandidaten.map((s) =>
    s.importPriceCtKwh != null && Number.isFinite(s.importPriceCtKwh)
      ? (s.importPriceCtKwh as number)
      : null);
  const werte = cts.filter((v): v is number => v != null);
  // Ein Fenster, das den ganzen Rest verschlucken würde, benennt nichts.
  if (werte.length < len || cts.length < len * 2) return null;
  const spanne = Math.max(...werte) - Math.min(...werte);
  if (spanne < MIN_SPANNE_CT) return null;

  let bestVon = -1;
  let bestSumme = Infinity;
  for (let i = 0; i + len <= cts.length; i += 1) {
    let summe = 0;
    let vollstaendig = true;
    for (let j = i; j < i + len; j += 1) {
      const v = cts[j];
      if (v == null) { vollstaendig = false; break; }
      summe += v;
    }
    if (!vollstaendig) continue;
    if (summe < bestSumme) { bestSumme = summe; bestVon = i; }
  }
  if (bestVon < 0) return null;
  let max = -Infinity;
  for (let j = bestVon; j < bestVon + len; j += 1) max = Math.max(max, cts[j] as number);
  return {
    vonIdx: bestVon,
    bisIdx: bestVon + len - 1,
    von: kandidaten[bestVon].start,
    bis: ende(kandidaten[bestVon + len - 1]),
    ctMittel: bestSumme / len,
    ctMax: max,
    ctHorizont: werte.reduce((a, b) => a + b, 0) / werte.length,
  };
}

// ---------------------------------------------------------------------------
// Zeiten in Kundendeutsch
// ---------------------------------------------------------------------------

/** „11:00" in der Zone der Anlage — nie in UTC, nie geraten. */
export function uhrzeit(iso: string, zone?: string): string {
  const d = new Date(Date.parse(iso));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('de-DE', {
    hour: '2-digit', minute: '2-digit', timeZone: zone,
  });
}

/** „heute" / „morgen" — mehr behauptet die Karte nicht (der Horizont ist 24 h). */
export function tagWort(iso: string, now: Date, zone?: string): string {
  const tag = (d: Date) => d.toLocaleDateString('de-DE', { timeZone: zone });
  const ziel = new Date(Date.parse(iso));
  if (Number.isNaN(ziel.getTime())) return '';
  if (tag(ziel) === tag(now)) return 'heute';
  const morgen = new Date(now.getTime() + 86_400_000);
  if (tag(ziel) === tag(morgen)) return 'morgen';
  return '';
}

/** „heute 11:00–15:00 Uhr" (das Tageswort entfällt, wenn es keins gibt). */
export function fensterWort(f: Fenster, now: Date, zone?: string): string {
  const tag = tagWort(f.von, now, zone);
  const spanne = `${uhrzeit(f.von, zone)}–${uhrzeit(f.bis, zone)} Uhr`;
  return tag ? `${tag} ${spanne}` : spanne;
}

// ---------------------------------------------------------------------------
// Welche Komponente überhaupt in Frage kommt
// ---------------------------------------------------------------------------

export interface VorschlagInput {
  /** Der aktuelle Fahrplan (die EINE Quelle der Zahlen). */
  slots: readonly ScheduleSlot[] | null;
  /** Die steuerbaren Komponenten dieser Anlage. */
  consumers: readonly Consumer[];
  /** Die Ansprüche anderer Regeln je Komponente (Stufe 3). */
  claims?: Record<string, EntityStrategy[]> | null;
  /** Laufende Handeingriffe (Stufe 4). */
  eingriffe?: readonly Intervention[] | null;
  /** Pausiert die ganze Anlage gerade (Stufe 4)? */
  pausiert?: boolean;
  /** Die server-seitig gemerkten „Später"/„Ablehnen" (Schlüssel). */
  stumm?: readonly string[] | null;
  now: Date;
  /** Die Zeitzone der Anlage für die Uhrzeiten. */
  zone?: string;
}

/**
 * Ob eine Komponente heute einen Vorschlag bekommen darf. Der EINE Ort für
 * die Regeln 2 und 3 — jede Ablehnung hier ist eine Aussage, keine Bequemlichkeit.
 */
export function kommtInFrage(
  c: Consumer,
  claims: Record<string, EntityStrategy[]> | null | undefined,
  eingriffe: readonly Intervention[] | null | undefined,
): boolean {
  // Ein Gerät, das nicht verbunden ist, kann keine Regel ausführen.
  if (c.connection !== 'connected') return false;
  // Pausiert (der Kunde hat es selbst stillgelegt) — dann drängt sich nichts auf.
  if (!c.enabled) return false;
  // Es läuft schon eine Regel darauf: „noch keine Regel tut dasselbe" (§3.3).
  if (c.controlActivation !== 'not_activated') return false;
  if (c.hasDraftPolicy) return false;
  // Ein fremder Flow beansprucht die Komponente (Stufe 3).
  if ((claims?.[c.id]?.length ?? 0) > 0) return false;
  // Ein laufender Handeingriff (Stufe 4) — er ist die Entscheidung von JETZT.
  if ((eingriffe ?? []).some((e) => e.entityId === c.id)) return false;
  return true;
}

/**
 * Die Leistung, die eine Komponente mindestens braucht, um sinnvoll zu laufen.
 * Ohne beides gibt es keine Zahl — und damit keine Zusage, dass ein Fenster
 * sie trägt.
 */
export function mindestLeistung(c: Consumer): number | null {
  const min = c.minPowerKw;
  if (min != null && Number.isFinite(min) && min > 0) return min;
  const rated = c.ratedPowerKw;
  if (rated != null && Number.isFinite(rated) && rated > 0) return rated;
  return null;
}

/** Die Schwelle der Überschuss-Bedingung: die Mindestleistung, auf 0,5 kW gerundet. */
export function ueberschussSchwelle(minKw: number): number {
  return Math.max(0.5, Math.round(minKw * 2) / 2);
}

/** Die Schwelle der Preis-Bedingung: über dem teuersten Slot des Fensters. */
export function preisSchwelle(ctMax: number): number {
  return Math.ceil(ctMax * 2) / 2;
}

// ---------------------------------------------------------------------------
// Die Karten
// ---------------------------------------------------------------------------

function ct(v: number): string {
  return v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/**
 * Die Vorschläge dieser Anlage — höchstens {@link MAX_VORSCHLAEGE}, höchstens
 * einer je Komponente, und **keiner ohne belastbares Fenster**.
 */
export function vorschlaege(input: VorschlagInput): Vorschlag[] {
  // Während einer Anlagen-Pause drängt sich nichts auf: der Kunde hat gerade
  // ausdrücklich gesagt, dass er die Automatik nicht will.
  if (input.pausiert) return [];
  const kandidaten = input.consumers.filter(
    (c) => kommtInFrage(c, input.claims, input.eingriffe));
  if (kandidaten.length === 0) return [];

  const stumm = new Set(input.stumm ?? []);
  const preis = guenstigFenster(input.slots, input.now);
  const out: Vorschlag[] = [];
  const belegt = new Set<string>();

  // 1 · Überschuss zuerst: das ist Energie, die sonst niemand nutzt.
  for (const c of kandidaten) {
    const minKw = mindestLeistung(c);
    if (minKw == null) continue;
    const fenster = ueberschussFenster(input.slots, input.now, minKw);
    // Regel 4: das Fenster muss die Komponente durchgehend TRAGEN.
    if (!fenster || fenster.minKw < minKw) continue;
    const key = `ueberschuss:${c.id}`;
    if (stumm.has(key)) continue;
    const schwelle = ueberschussSchwelle(minKw);
    // ⚠ DASSELBE Tageswort wie im Titel. Es fest auf „heute" zu setzen war ein
    // Widerspruch in derselben Karte, sobald der Fahrplan das Fenster erst
    // MORGEN sieht (im Browser-Beweis aufgefallen, nicht im Unit-Test).
    const wann = tagWort(fenster.von, input.now, input.zone) || 'in diesem Zeitraum';
    out.push({
      key,
      art: 'ueberschuss',
      komponenteId: c.id,
      komponenteName: c.name,
      titel: `„${c.name}" ${fensterWort(fenster, input.now, input.zone)} laufen lassen`,
      begruendung:
        `In diesem Fenster erwartet der Fahrplan ${fmtNum(fenster.kwh, 'kWh', 1)} `
        + `Solar-Überschuss (mindestens ${fmtNum(fenster.minKw, 'kW', 1)} durchgehend). `
        + `Die Regel schaltet „${c.name}" ein, sobald der gemessene Überschuss über `
        + `${fmtNum(schwelle, 'kW', 1)} liegt — ${wann} also voraussichtlich in diesem Fenster.`,
      regelName: `${c.name} bei Solar-Überschuss`,
      steuerart: { quelle: 'ueberschuss', schwelleKw: schwelle },
      prefill: {
        intent: 'react',
        conditions: [{
          signal: 'site.pv_surplus_kw',
          operator: 'gt',
          value: schwelle,
          resetValue: Math.max(0.25, schwelle - 0.5),
        }],
        target: { kind: 'on_off', value: true },
        enforcement: 'opportunistic',
        gridEnergyPolicy: 'avoid',
      },
      knoepfe: {
        verbraucherAbSlot: fenster.vonIdx,
        verbraucherSlots: fenster.bisIdx - fenster.vonIdx + 1,
        verbraucherKw: minKw,
      },
    });
    belegt.add(c.id);
    if (out.length >= MAX_VORSCHLAEGE) return out;
  }

  // 2 · Günstige Stunden für alles, was noch keine Karte hat.
  if (preis) {
    const schwelle = preisSchwelle(preis.ctMax);
    for (const c of kandidaten) {
      if (belegt.has(c.id)) continue;
      const key = `guenstig:${c.id}`;
      if (stumm.has(key)) continue;
      // Ohne belastbare Leistung gibt es keine Vorschau-Eingabe - die Karte
      // entsteht trotzdem (sie braucht die Zahl nicht), nur ihre Folgen-Karte
      // bleibt dann zahllos.
      const kw = mindestLeistung(c);
      out.push({
        key,
        art: 'guenstig',
        komponenteId: c.id,
        komponenteName: c.name,
        titel: `„${c.name}" ${fensterWort(preis, input.now, input.zone)} laufen lassen`,
        begruendung:
          `Das sind die günstigsten Stunden im Fahrplan: ${ct(preis.ctMittel)} ct/kWh im `
          + `Schnitt gegenüber ${ct(preis.ctHorizont)} ct/kWh sonst. Die Regel schaltet `
          + `„${c.name}" ein, solange Ihr Bezugspreis unter ${ct(schwelle)} ct/kWh liegt.`,
        regelName: `${c.name} in günstigen Stunden`,
        steuerart: { quelle: 'guenstig', preisgrenzeCtKwh: schwelle },
        prefill: {
          intent: 'cheap',
          conditions: [{
            signal: 'market.import_price_ct_kwh',
            operator: 'lt',
            value: schwelle,
          }],
          target: { kind: 'on_off', value: true },
          gridEnergyPolicy: 'allow',
        },
        knoepfe: kw == null ? null : {
          verbraucherAbSlot: preis.vonIdx,
          verbraucherSlots: preis.bisIdx - preis.vonIdx + 1,
          verbraucherKw: kw,
        },
      });
      belegt.add(c.id);
      if (out.length >= MAX_VORSCHLAEGE) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Copy der Karte
// ---------------------------------------------------------------------------

/** Die Überschrift der Vorschlags-Reihe — mit der Zahl, nie ohne. */
export function vorschlagKopf(n: number): string {
  if (n === 1) return 'VoltPilot hat einen Vorschlag für Sie';
  return `VoltPilot hat ${n} Vorschläge für Sie`;
}

/**
 * Warum es gerade KEINEN Vorschlag gibt — nur, wenn der Grund BELEGT ist.
 * Ohne belegten Grund schweigt die Fläche (statt zu behaupten, es gäbe nichts
 * zu tun).
 */
export function keinVorschlagGrund(input: VorschlagInput): string | null {
  if (input.pausiert) {
    return 'Die Automatik pausiert gerade — Vorschläge macht VoltPilot wieder, '
      + 'sobald sie weiterläuft.';
  }
  if (input.consumers.length === 0) {
    return 'Für Vorschläge braucht VoltPilot ein schaltbares Gerät — unter '
      + '„Komponenten" legen Sie eines an.';
  }
  if (!input.slots || input.slots.length === 0) {
    return 'Für Vorschläge braucht VoltPilot einen Fahrplan — für diese Anlage '
      + 'liegt gerade keiner vor.';
  }
  return null;
}

/**
 * Der LEER-ZUSTAND, wenn es Vorschläge gibt (§3.3: „Der Leer-Zustand ist die
 * Vorschlags-Liste selbst"). „Noch keine Regel" DIREKT unter zwei konkreten
 * Vorschlägen liest sich, als gäbe es nichts - im Browser-Beweis aufgefallen.
 */
export const LEER_MIT_VORSCHLAEGEN =
  'Oder legen Sie eine eigene Regel an — im Baukasten sagen Sie in Ihren '
  + 'Worten, was passieren soll.';

export const UEBERNEHMEN = 'Übernehmen';
export const SPAETER = 'Später';
export const ABLEHNEN = 'Ablehnen';

/** Was „Später" und „Ablehnen" bewirken — die Karte sagt es, bevor geklickt wird. */
export const SPAETER_HINWEIS = 'blendet den Vorschlag für einen Tag aus';
export const ABLEHNEN_HINWEIS = 'blendet den Vorschlag für sieben Tage aus';
