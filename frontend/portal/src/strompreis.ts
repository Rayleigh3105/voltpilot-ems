/**
 * Der Börsenpreis-Streifen des Cockpits — die pure Ableitung (Konzept
 * `data/vp-cockpit-unten-ux-n3`, Variante A „Markt & Tag", PR 1; Captain-Go
 * 05.08.2026 mit den Empfehlungen D1–D3).
 *
 * Der Kundenwunsch war, den aktuellen Strompreis zu SEHEN — und für eine
 * Direktvermarktungs-Anlage ERKLÄRT der Preis das Speicherverhalten. Der
 * Streifen zeigt deshalb drei Dinge übereinander: den Jetzt-Preis mit einem
 * Urteil in WORTEN, die 24-h-Kurve (heute + morgen) mit Jetzt-Marker, und die
 * Plan-Kopplung („Ihr Fahrplan: Jetzt Zum Spitzenpreis verkaufen — noch bis
 * 20:15", Abzeichen „Geplant").
 *
 * Regeln, die nicht wegoptimiert werden dürfen:
 *
 * - **Gating = die Marktpreise-Regel (D1):** der Streifen erscheint genau
 *   dort, wo die Marktpreise-Ansicht erreichbar ist — Markt-Modus aktiv ODER
 *   dynamischer Tarif ({@link gateStrompreis}). Auf einer Festpreis-EEG-Anlage
 *   erklärt der Preis nichts (flacher Bezug, fixe Vergütung, der Plan folgt
 *   PV/Last statt dem Preis) — Zahlen ohne Konsequenz wären genau die
 *   Krankheit, die der Umbau der unteren Hälfte behebt.
 * - **Das Urteil nennt seinen Maßstab und schweigt, wo es keinen hat (D2):**
 *   Drittel der HEUTIGEN Spanne („gerade günstig" / „im Mittelfeld" / „gerade
 *   teuer"), mit den Ankern Tagestief/Tageshoch daneben. Eine Spanne unter
 *   {@link FLACH_SPANNE_CT} → „heute kaum Schwankung" OHNE Anker (ein flacher
 *   Tag darf kein Teuer/Günstig-Theater erzeugen). Ein Preis unter 0 ist der
 *   eigene Zustand „Negativpreis" — er schlägt alles, denn er ist die
 *   stärkere Tatsache (und der Anschluss für die § 51-Zeile).
 * - **Preise sind FAKTEN, der Plan ist GEPLANT:** die Kopplung zitiert
 *   ausschließlich einen Plan, der JETZT gilt — kein aktiver Slot (toter
 *   Plan, Horizont vorbei, Warum-Ebene unvollständig) → keine Kopplungszeile,
 *   nie ein erfundenes „Jetzt". Die Wörter kommen wörtlich aus der EINEN
 *   Fahrplan-Vokabel ({@link filmLabel}/`roleLabel`) — keine zweite
 *   Plan-Sprache.
 * - **Der Bezugspreis wird nie nachgerechnet (D3):** die Zweitzeile eines
 *   dynamischen Tarifs ist `importPriceCtKwh` des laufenden Slots — die eine
 *   serverseitige Preis-Wahrheit (SlotEconomics). Fehlt der Wert, entfällt
 *   die Zeile wortlos.
 * - **„Morgen" ist ehrlich:** die Kurve trägt die Morgen-Slots blass, sobald
 *   sie veröffentlicht sind; fehlen sie VOR ~14 Uhr, sagt eine ruhige Notiz
 *   den Weg („erscheinen gegen 13 Uhr") — danach wird nichts mehr behauptet.
 *
 * Pure + framework-frei (der `livePuls.ts`/`fahrplanJetzt.ts`-Präzedenzfall);
 * `components/StrompreisStrip.tsx` holt und rendert nur.
 */
import type { PricePoint, TarifArt } from './api';
import { filmLabel } from './fahrplanFilm';
import { phases, type SlotRole, type WhySlot } from './fahrplanWhy';
import { ctPerKwh } from './format';
import type { PlanWordingKind } from './schedule';
import { hasMode, type ActiveMode } from './surface';

// ---------------------------------------------------------------------------
// Gating (D1)
// ---------------------------------------------------------------------------

/**
 * Wo der Streifen erscheint: exakt die Signalmenge, die auch die
 * Marktpreise-Ansicht erreichbar macht (`surface.ts`/`anlageNav`) — der
 * Markt-Modus ODER ein dynamischer Tarif. Keine neue Regel, kein Drift.
 */
export function gateStrompreis(
  modes: ActiveMode[],
  tarifArt: TarifArt | null | undefined,
): boolean {
  return hasMode(modes, 'marktvermarktung') || tarifArt === 'dynamisch';
}

// ---------------------------------------------------------------------------
// Preis-Sicht (Kurve + Urteil + Anker)
// ---------------------------------------------------------------------------

/** Unter dieser Tagesspanne (ct/kWh) gibt es kein Teuer/Günstig-Urteil (D2). */
export const FLACH_SPANNE_CT = 5;

export type PreisUrteil = 'teuer' | 'guenstig' | 'mittel' | 'flach' | 'negativ';

/** Das Urteilswort — Bedeutung trägt das WORT, nie die Farbe allein. */
export const URTEIL_LABEL: Record<PreisUrteil, string> = {
  teuer: 'gerade teuer',
  guenstig: 'gerade günstig',
  mittel: 'im Mittelfeld',
  flach: 'heute kaum Schwankung',
  negativ: 'Negativpreis',
};

/** Der ehrliche Leerzustand: der Server hat für heute keine Preise. */
export const LEER_TEXT = 'Für heute liegen noch keine Börsenpreise vor.';

/** Die ruhige Notiz, solange morgen noch nicht veröffentlicht ist (S8). */
export const MORGEN_NOTE = 'Preise für morgen erscheinen gegen 13 Uhr.';

/** Die § 51-Zeile einer DV-Anlage im Negativpreis (marktpraemie-Vokabular). */
export const PRAEMIE_RUHT = 'Marktprämie ruht in Negativpreis-Viertelstunden.';

/** Ein Balken der Kurve. `ct: null` = Lücke — es wird nichts gezeichnet. */
export interface PreisBar {
  ct: number | null;
  tag: 'heute' | 'morgen';
  /** Slot liegt vollständig vor jetzt (gedimmt gezeichnet). */
  vergangen: boolean;
  /** Der laufende Slot (trägt den Jetzt-Marker). */
  jetzt: boolean;
}

export interface StrompreisView {
  /** 'leer' = keine heutigen Preise (der ehrliche Leerzustand). */
  state: 'leer' | 'bereit';
  /** „11,9 ct/kWh" — null, wenn der laufende Slot keinen Preis trägt. */
  jetztWert: string | null;
  /** Roh-ct des laufenden Slots (für die Kopplung/Notizen), sonst null. */
  jetztCt: number | null;
  urteil: PreisUrteil | null;
  urteilLabel: string | null;
  /** „Tagestief 0,4 ct (12:45)" / „Tageshoch 13,6 ct (19:45)"; null bei flach. */
  anker: { tief: string; hoch: string } | null;
  bars: PreisBar[];
  /** true = mindestens ein Balken unter 0 (die Nulllinie wird betont). */
  hatNegativ: boolean;
  /** Index des ersten Morgen-Balkens in `bars`, -1 = morgen (noch) nicht da. */
  morgenAb: number;
  /** {@link MORGEN_NOTE} oder null. */
  morgenNote: string | null;
}

function berlinDayKey(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
}

function berlinHour(now: Date): number {
  return Number(
    now.toLocaleString('en-GB', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      hour12: false,
    }),
  );
}

function hm(iso: string): string {
  return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function ct1(v: number): string {
  return v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** Das D2-Urteil über einem Jetzt-Preis und der heutigen Spanne. */
export function preisUrteil(jetztCt: number, minCt: number, maxCt: number): PreisUrteil {
  if (jetztCt < 0) return 'negativ';
  const spanne = maxCt - minCt;
  if (spanne < FLACH_SPANNE_CT) return 'flach';
  const p = (jetztCt - minCt) / spanne;
  if (p <= 1 / 3) return 'guenstig';
  if (p >= 2 / 3) return 'teuer';
  return 'mittel';
}

/**
 * Die ganze Preis-Sicht aus der Zonen-Serie (`GET /sites/{id}/prices`).
 * Heute/Morgen sind BERLINER Kalendertage (die Handelstage der Börse);
 * gestern-Slots der Serie werden verworfen. Ein Punkt ohne Preis bleibt eine
 * LÜCKE — nie eine erfundene 0.
 */
export function strompreisView(points: PricePoint[], now: Date): StrompreisView {
  const todayKey = berlinDayKey(now);
  const sorted = [...points].sort(
    (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime(),
  );
  const today = sorted.filter((p) => berlinDayKey(p.ts) === todayKey);
  // „Morgen" = der kleinste in der Serie vorhandene Tag NACH heute (nie über
  // eine +24h-Arithmetik, die am DST-Rückstell-Tag denselben Tag träfe).
  const laterKeys = sorted.map((p) => berlinDayKey(p.ts)).filter((k) => k > todayKey);
  const tomorrowKey = laterKeys.length > 0 ? laterKeys.sort()[0] : null;
  const tomorrow =
    tomorrowKey == null ? [] : sorted.filter((p) => berlinDayKey(p.ts) === tomorrowKey);

  const pricedToday = today.filter((p) => p.priceEurMwh != null);
  if (pricedToday.length === 0) {
    return {
      state: 'leer',
      jetztWert: null,
      jetztCt: null,
      urteil: null,
      urteilLabel: null,
      anker: null,
      bars: [],
      hatNegativ: false,
      morgenAb: -1,
      morgenNote: null,
    };
  }

  const nowMs = now.getTime();
  const current =
    today.find(
      (p) => new Date(p.ts).getTime() <= nowMs && nowMs < new Date(p.end).getTime(),
    ) ?? null;
  const jetztCt = current?.priceEurMwh == null ? null : Number(current.priceEurMwh) / 10;

  const cts = pricedToday.map((p) => Number(p.priceEurMwh) / 10);
  const minCt = Math.min(...cts);
  const maxCt = Math.max(...cts);
  const tief = pricedToday[cts.indexOf(minCt)];
  const hoch = pricedToday[cts.indexOf(maxCt)];

  const urteil = jetztCt == null ? null : preisUrteil(jetztCt, minCt, maxCt);
  const anker =
    urteil === 'flach'
      ? null
      : {
          tief: `Tagestief ${ct1(minCt)} ct (${hm(tief.ts)})`,
          hoch: `Tageshoch ${ct1(maxCt)} ct (${hm(hoch.ts)})`,
        };

  const bar = (p: PricePoint, tag: 'heute' | 'morgen'): PreisBar => ({
    ct: p.priceEurMwh == null ? null : Number(p.priceEurMwh) / 10,
    tag,
    vergangen: new Date(p.end).getTime() <= nowMs,
    jetzt: current != null && p.ts === current.ts,
  });
  const bars = [...today.map((p) => bar(p, 'heute')), ...tomorrow.map((p) => bar(p, 'morgen'))];

  return {
    state: 'bereit',
    jetztWert: current?.priceEurMwh == null ? null : ctPerKwh(current.priceEurMwh, 1),
    jetztCt,
    urteil,
    urteilLabel: urteil == null ? null : URTEIL_LABEL[urteil],
    anker,
    bars,
    hatNegativ: bars.some((b) => b.ct != null && b.ct < 0),
    morgenAb: tomorrow.length > 0 ? today.length : -1,
    // Nach ~14 Uhr wird der 13-Uhr-Termin nicht mehr versprochen — dann fehlt
    // morgen aus einem anderen Grund, und den kennt der Client nicht.
    morgenNote: tomorrow.length === 0 && berlinHour(now) < 14 ? MORGEN_NOTE : null,
  };
}

// ---------------------------------------------------------------------------
// Plan-Kopplung („was Ihr Speicher deshalb tut / worauf er wartet")
// ---------------------------------------------------------------------------

/** Vorspann jeder Kopplungszeile. */
export const KOPPLUNG_PREFIX = 'Ihr Fahrplan: ';

/**
 * Die Kopplungszeile, strukturiert: `pre` + **`action`** + `post`. Die Aktion
 * trägt die Betonung, damit der Renderer nichts neu formulieren muss.
 */
export interface PlanKopplung {
  pre: string;
  action: string;
  post: string | null;
}

/**
 * Die Kopplung aus dem Plan, der auf der Seite schon liegt. Reuse statt
 * zweiter Plan-Logik: die Phasen kommen aus `fahrplanWhy.phases` (inkl. der
 * Alles-oder-nichts-Regel der Warum-Ebene), die Wörter aus `filmLabel`.
 *
 * - kein Plan / keine Warum-Ebene / kein Slot, der JETZT läuft → null
 *   (die planStaleNote-Disziplin: ein toter Plan wird nie als „Jetzt" zitiert);
 * - laufende Aktions-Phase → „Jetzt {Label} — noch bis HH:MM";
 * - laufendes Abregeln bei Negativpreis → „Jetzt Einspeisung pausieren —
 *   nicht draufzahlen" (der rowSub-Wortlaut des Films);
 * - Ruhe (`warten`) mit einer späteren Aktions-Phase → „Ruhe — ab HH:MM
 *   {Label}" (worauf er wartet); ohne eine solche → „Jetzt Ruhe — noch bis
 *   HH:MM".
 */
export function planKopplung(
  slots: WhySlot[],
  now: Date,
  slotMinutes: number,
  kind: PlanWordingKind,
  jetztNegativ: boolean,
): PlanKopplung | null {
  const ph = phases(slots, slotMinutes);
  if (ph.length === 0) return null;
  const nowMs = now.getTime();
  const activeIdx = ph.findIndex(
    (p) => new Date(p.from).getTime() <= nowMs && nowMs < new Date(p.to).getTime(),
  );
  if (activeIdx < 0) return null;
  const active = ph[activeIdx];
  const flagsOf = (idx: number): string[] | null => slots[ph[idx].startIdx]?.slotFlags ?? null;

  if (active.role === 'warten') {
    const nextIdx = ph.findIndex((p, i) => i > activeIdx && p.kind !== 'idle');
    if (nextIdx >= 0) {
      const next = ph[nextIdx];
      return {
        pre: `Ruhe — ab ${hm(next.from)} `,
        action: filmLabel(next.role as SlotRole, kind, flagsOf(nextIdx)),
        post: null,
      };
    }
    return { pre: 'Jetzt ', action: 'Ruhe', post: ` — noch bis ${hm(active.to)}` };
  }

  const post =
    active.role === 'abregeln' && jetztNegativ
      ? ' — nicht draufzahlen'
      : ` — noch bis ${hm(active.to)}`;
  return {
    pre: 'Jetzt ',
    action: filmLabel(active.role as SlotRole, kind, flagsOf(activeIdx)),
    post,
  };
}

// ---------------------------------------------------------------------------
// Zweitzeile + Notizen
// ---------------------------------------------------------------------------

/**
 * D3: der Bezugspreis des laufenden Slots für dynamische Tarife — die eine
 * serverseitige Preis-Wahrheit (`importPriceCtKwh`), nie client-seitig
 * nachgerechnet. Null (kein dynamischer Tarif / älterer Lauf) = keine Zeile.
 */
export function bezugspreisJetzt(
  tarifArt: TarifArt | null | undefined,
  activeSlot: { importPriceCtKwh?: number | null } | null | undefined,
): string | null {
  if (tarifArt !== 'dynamisch') return null;
  const v = activeSlot?.importPriceCtKwh;
  if (v == null) return null;
  return `${ct1(Number(v))} ct/kWh`;
}

/**
 * Die § 51-Zeile: nur auf einer Direktvermarktungs-Anlage (nur dort gibt es
 * eine Marktprämie) und nur im Negativpreis-Urteil.
 */
export function praemieRuhtNote(urteil: PreisUrteil | null, isDv: boolean): string | null {
  return urteil === 'negativ' && isDv ? PRAEMIE_RUHT : null;
}
