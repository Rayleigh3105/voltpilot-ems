/**
 * Die Einstellungs-Seite als OBERFLÄCHE — Autoritäts-Stufen (E4), Wirkung &
 * Ehrlichkeit (E5) und die Zuständigkeits-Grenze zur Box (E7). Rein, ohne
 * React; die Seite (`pages/AnlageTechnik.tsx`) und die Zeile
 * (`components/SettingEditors.tsx`) rendern daraus.
 *
 * Konzept: `data/vp-settings-ux-konzept/report.md` §7 P3/P5 + §7.2, Mockups in
 * `concept.html`; Captain-Entscheide **D4** (Stufe-②-Werte werden für Kunden
 * read-only SICHTBAR statt unsichtbar) und **D5** (die Box bleibt eine eigene
 * Seite, beide Seiten teilen die Bildsprache).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Warum die Wirkungs-Chips hier DEKLARIERT und nicht aus `claimedBy` abgeleitet
 * sind: seit „Eigenverbrauch ist kein Modus mehr" beanspruchen ALLE vier
 * Kunden-Einstellungen genau `['marktvermarktung']` (`modeSettings.ts`) — eine
 * Ableitung allein daraus gäbe allen vier IDENTISCHE Chips und behauptete
 * damit, der Stromtarif wirke auf den Speicher und die Speicherschonung auf die
 * Erlöse. Die Wirkung ist eine Eigenschaft der EINSTELLUNG, nicht ihres Modus,
 * also steht sie als Tabelle je Id da — genau wie `SETTING_HINT` in
 * `settingsNav.ts`. `modeSettings.ts` bleibt unangetastet.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { ALL_SETTINGS, settingRelevant, type ModeSettingDef } from './modeSettings';
import type { SettingsGroupId } from './settingsNav';
import type { Provenienz } from './historieWelten';
import type { ModeSettingId } from './surface';

// ---------------------------------------------------------------------------
// 1 · E4 — die drei Autoritäts-Stufen
// ---------------------------------------------------------------------------

/**
 * Wer über den Wert bestimmt:
 *  - **①** der Kunde selbst (normale Zeile mit „Bearbeiten"),
 *  - **②** VoltPilot (read-only sichtbar, mit Abzeichen und OHNE Aktionsknopf —
 *    Captain-Entscheid 2 vom 16.07.: der Vertrieb läuft persönlich),
 *  - **③** niemand — es läuft automatisch und wird nur erklärt (§ 14a,
 *    Negativpreis-Abregelung, EEG-Solarladen).
 */
export type AuthorityLevel = 1 | 2 | 3;

export interface AuthorityInfo {
  level: AuthorityLevel;
  /** Das Zeichen der Stufe — Text, nie ein Emoji (Icon-Konvention des Portals). */
  mark: string;
  /** Die Kurzform am Abzeichen der Zeile. */
  badge: string;
  /** Die Stufe ausgeschrieben (Legende). */
  label: string;
  /** Ein Satz, was die Stufe bedeutet. */
  note: string;
}

/**
 * Die Wortwahl ist bewusst das PARTIZIP („Von VoltPilot eingerichtet"): der
 * Copy-Wächter (`copy.test.ts`) verbietet die Gegenwartsform „VoltPilot richtet
 * ein", weil sie in M3 die Anfragewand bezeichnete. Hier ist es ein Zustand,
 * keine Aufforderung — und genau so steht es seit E1 schon an der Zeile.
 */
export const AUTHORITY: Record<AuthorityLevel, AuthorityInfo> = {
  1: {
    level: 1,
    mark: '①',
    badge: 'Sie',
    label: 'Sie stellen ein',
    note: 'Diese Werte ändern Sie selbst — jederzeit und ohne Rückfrage.',
  },
  2: {
    level: 2,
    mark: '②',
    badge: 'VoltPilot',
    label: 'Von VoltPilot eingerichtet',
    note: 'Vertragsnahe Werte, die VoltPilot mit Ihnen einrichtet. Sie sehen sie hier, ändern können Sie sie nicht.',
  },
  3: {
    level: 3,
    mark: '③',
    badge: 'Automatisch',
    label: 'Läuft automatisch',
    note: 'Schutzfunktionen, die immer mitlaufen — ganz ohne Einstellung.',
  },
};

/** Kanonische Reihenfolge der Stufen (Legende). */
export const AUTHORITY_ORDER: readonly AuthorityLevel[] = [1, 2, 3];

/**
 * Die Stufen, die eine ZEILE tragen kann. Stufe ③ ist bewusst nicht dabei: sie
 * gehört keiner Einstellung, sondern dem Schutz-Streifen — es gibt dort nichts
 * zu stellen, also auch keine Zeile.
 */
export type RowAuthority = 1 | 2;

/**
 * Die Stufe einer Einstellung. `editability` in `modeSettings.ts` liefert sie
 * bereits — E4 macht sie nur sichtbar (Report §7 P3, Befund B4).
 */
export function authorityOf(setting: ModeSettingDef): RowAuthority {
  return setting.editability === 'voltpilot' ? 2 : 1;
}

/** Die Notiz an einer ②-Zeile: was sie ist und wie man sie ändern lässt. */
export const VOLTPILOT_ROW_NOTE = 'Von VoltPilot eingerichtet · Änderung? Sprechen Sie uns an.';

/** Der Einleitungssatz über dem Schutz-Streifen (③) am Seitenfuß. */
export const PROTECTION_SETTINGS_INTRO = 'Läuft immer mit, ganz ohne Einstellung:';

// ---------------------------------------------------------------------------
// 2 · E4/D4 — die Stufe-②-Werte, die die Seite ZEIGT
// ---------------------------------------------------------------------------

/**
 * Wo ein von VoltPilot eingerichteter Wert auf der Seite ERSCHEINT.
 *
 * Bewusst getrennt von `settingsNav.settingsGroupFor`: das dort ist die Adresse
 * der HEIMAT eines Werts (der Deep-Link des Modus-Spiegels), und ein ②-Wert hat
 * seine Heimat weiter im Modus-Container (`home: 'modus'`). Er wird hier
 * gezeigt, nicht besessen — deshalb eine eigene, additive Zuordnung, statt die
 * E1-Zusage „ein Link ohne Ziel gibt es nicht" aufzuweichen.
 *
 * Der Leistungspreis und seine Abrechnungsperiode sind Vertragsfakten (Gruppe
 * „Geld & Verträge"); die Lastspitzen-Reserve ist eine Speicher-Reservierung
 * (Gruppe „Speicher") — genau die Verteilung des Entwurfs §7 P4.
 */
export function voltpilotGroupFor(id: ModeSettingId): SettingsGroupId | null {
  switch (id) {
    case 'leistungspreis':
    case 'abrechnung-leistung':
      return 'geld';
    case 'lastspitzen-reserve':
      return 'speicher';
    default:
      return null;
  }
}

/** Was eine ②-Zeile zum Anzeigen braucht (nur die gelesenen Felder). */
export interface VoltpilotSite {
  plantKind?: string | null;
  leistungspreisEurKw?: number | null;
  abrechnungLeistung?: 'jahr' | 'monat' | null;
  peakReserveSocPct?: number | null;
}

/**
 * Trägt die Anlage für diesen ②-Wert überhaupt etwas? D4 macht die Werte
 * SICHTBAR — es erfindet keine. Eine Hausanlage ohne Lastspitzenkappung hat
 * keinen Leistungspreis, also steht dort auch keine Zeile „—": das wäre
 * Rauschen, kein Gewinn (die „ohne Quelle keine Kachel"-Disziplin).
 *
 * Die Abrechnungsperiode hängt am Leistungspreis (ohne ihn gibt es nichts
 * abzurechnen) und wird deshalb mit ihm zusammen gezeigt, auch wenn das Feld
 * selbst leer ist — der Wert liest sich dann fail-soft als „—".
 */
export function hasVoltpilotValue(site: VoltpilotSite, id: ModeSettingId): boolean {
  switch (id) {
    case 'leistungspreis':
    case 'abrechnung-leistung':
      return site.leistungspreisEurKw != null;
    case 'lastspitzen-reserve':
      return site.peakReserveSocPct != null;
    default:
      return false;
  }
}

/**
 * Die Stufe-②-Zeilen EINER Gruppe (D4) — in der kanonischen Registry-Reihenfolge
 * und nur, soweit die Anlage sie wirklich trägt.
 */
export function voltpilotRows(group: SettingsGroupId, site: VoltpilotSite): ModeSettingDef[] {
  return ALL_SETTINGS.filter(
    (def) =>
      def.editability === 'voltpilot' &&
      voltpilotGroupFor(def.id) === group &&
      hasVoltpilotValue(site, def.id) &&
      settingRelevant(def, { plantKind: site.plantKind ?? null }),
  );
}

// ---------------------------------------------------------------------------
// 3 · E5 — Wirkungs-Chips
// ---------------------------------------------------------------------------

/** Worauf eine Einstellung wirkt — die drei Dinge, die der Kunde kennt. */
export type SettingEffect = 'fahrplan' | 'erloese' | 'speicher';

export const EFFECT_LABEL: Record<SettingEffect, string> = {
  fahrplan: 'Wirkt auf: Fahrplan',
  erloese: 'Wirkt auf: Erlöse',
  speicher: 'Wirkt auf: Ihr Speicher',
};

/** Kanonische Reihenfolge, damit zwei Zeilen nie unterschiedlich sortieren. */
const EFFECT_ORDER: readonly SettingEffect[] = ['fahrplan', 'erloese', 'speicher'];

/**
 * Die Wirkung je Einstellung — belegt an dem, was der Wert im System WIRKLICH
 * anfasst:
 *  - `stromtarif` geht als Bezugspreis in die Zielfunktion des Fahrplans UND in
 *    jede bewertete Euro-Zahl (`pricing.py import_prices` / `SlotEconomics`).
 *  - `anzulegender-wert` bildet über die gleitende Marktprämie den
 *    Einspeisewert — derselbe Wert plant und rechnet ab.
 *  - `netzladen` ist eine Nebenbedingung des Fahrplans und bestimmt, woraus der
 *    Speicher geladen werden darf.
 *  - `speicherschonung` ist der Verschleißpreis: er ändert, wie oft der Fahrplan
 *    den Speicher bewegt.
 *  - die drei ②-Werte wirken analog (Leistungspreis in Plan + Abrechnung, die
 *    Reserve als SoC-Untergrenze des Speichers).
 */
const EFFECTS: Record<ModeSettingId, SettingEffect[]> = {
  stromtarif: ['fahrplan', 'erloese'],
  'anzulegender-wert': ['fahrplan', 'erloese'],
  netzladen: ['fahrplan', 'speicher'],
  speicherschonung: ['fahrplan', 'speicher'],
  leistungspreis: ['fahrplan', 'erloese'],
  'abrechnung-leistung': ['erloese'],
  'lastspitzen-reserve': ['fahrplan', 'speicher'],
};

/** Worauf diese Einstellung wirkt, in kanonischer Reihenfolge. */
export function effectsOf(id: ModeSettingId): SettingEffect[] {
  const set = new Set(EFFECTS[id] ?? []);
  return EFFECT_ORDER.filter((e) => set.has(e));
}

/** Die Chip-Beschriftungen einer Zeile („Wirkt auf: …"). */
export function effectChips(id: ModeSettingId): string[] {
  return effectsOf(id).map((e) => EFFECT_LABEL[e]);
}

// ---------------------------------------------------------------------------
// 4 · E5 — Ehrlichkeits-Abzeichen
// ---------------------------------------------------------------------------

/**
 * Welche Art von Zahl diese Einstellung verändert — dieselbe Disziplin wie die
 * Historie (`historieWelten.PROVENIENZ`: Gemessen · Bewertet · Geplant).
 *
 * **`gemessen` kommt hier nie vor, und das ist der Punkt:** keine Einstellung
 * verändert je eine gemessene Zahl. Ein Preisfeld bewertet die Vergangenheit
 * NEU (rückwirkend, weil es keine Preishistorie gibt), eine Verhaltens-
 * Einstellung wirkt ausschließlich auf kommende Fahrpläne.
 */
const HONESTY: Record<ModeSettingId, Provenienz> = {
  stromtarif: 'bewertet',
  'anzulegender-wert': 'bewertet',
  leistungspreis: 'bewertet',
  'abrechnung-leistung': 'bewertet',
  netzladen: 'geplant',
  speicherschonung: 'geplant',
  'lastspitzen-reserve': 'geplant',
};

export function honestyOf(id: ModeSettingId): Provenienz | null {
  return HONESTY[id] ?? null;
}

/** Der eine Satz zum Abzeichen — was sich ändert und was ausdrücklich nicht. */
export function honestyNote(art: Provenienz): string {
  switch (art) {
    case 'bewertet':
      return 'Ändert bewertete Zahlen rückwirkend — nie eine gemessene.';
    case 'geplant':
      return 'Ändert kommende Fahrpläne — nie eine aufgezeichnete Messung.';
    default:
      return 'Gemessene Werte Ihrer Anlage.';
  }
}

// ---------------------------------------------------------------------------
// 5 · E5 — die lebende Bezugspreis-Vorschau
// ---------------------------------------------------------------------------

/**
 * Was die Vorschau aus dem Fahrplan liest. Strukturelle Teilmenge von
 * `api.ScheduleSlot` — bewusst so schmal, dass klar ist: hier wird NICHTS
 * gerechnet, nur gelesen.
 */
export interface PreisSlot {
  start: string;
  priceEurMwh?: number | null;
  importPriceCtKwh?: number | null;
  importPriceSource?: string | null;
}

export interface BezugspreisVorschau {
  /** „32,5 ct/kWh" — der Preis, mit dem gerade geplant und bewertet wird. */
  wert: number;
  /** „(Börsenpreis 12,4 + Netzentgelte/Abgaben 20,1)" — oder null. */
  aufschluesselung: string | null;
}

/** Ab hier ist der Aufschlags-Anteil Information statt Rundungsrauschen. */
const PREIS_TEIL_DEADBAND_CT = 0.05;

const ctFmt = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * Der Slot, der JETZT läuft — `[start, start + slotMinutes)`, dieselbe Semantik
 * wie `control.controlReasonSlot` und der Edge. Null außerhalb des Horizonts:
 * lieber keine Vorschau als eine aus einem fremden Slot.
 */
export function aktuellerPreisSlot<T extends PreisSlot>(
  slots: readonly T[] | null | undefined,
  slotMinutes: number,
  now: Date,
): T | null {
  if (!slots || slots.length === 0) return null;
  const len = (Number.isFinite(slotMinutes) && slotMinutes > 0 ? slotMinutes : 15) * 60_000;
  const t = now.getTime();
  for (const s of slots) {
    const start = Date.parse(s.start);
    if (!Number.isFinite(start)) continue;
    if (t >= start && t < start + len) return s;
  }
  return null;
}

/**
 * Die lebende Vorschau unter dem Stromtarif (Report §7 P5): **Ihr Bezugspreis
 * gerade**, samt Aufschlüsselung.
 *
 * **Es gibt hier keine zweite Preisrechnung.** Die Komposition ist serverseitig
 * die EINE Wahrheit (`pricing.py import_prices` ⟷ `SlotEconomics.importPriceCtSql`)
 * und reist je Viertelstunde als `importPriceCtKwh` + `importPriceSource` mit
 * dem Fahrplan mit; hier wird sie nur gelesen — genau wie im Fahrplan-„Warum"
 * (`fahrplanWhy.importPriceDetail`, dieselben Quellen-Fälle, dasselbe
 * Deadband). Aus den Formularfeldern selbst zu addieren wäre die zweite
 * Wahrheit, die auseinanderlaufen kann.
 *
 * Null, wenn der Lauf den Preis nicht trägt (ältere Läufe) oder kein Fahrplan
 * vorliegt — die Fläche sagt dann, dass sie es nicht weiß, statt eine Zahl zu
 * erfinden.
 */
export function bezugspreisVorschau(slot: PreisSlot | null): BezugspreisVorschau | null {
  if (!slot || slot.importPriceCtKwh == null) return null;
  const wert = Number(slot.importPriceCtKwh);
  if (!Number.isFinite(wert)) return null;
  return { wert, aufschluesselung: aufschluesselung(slot, wert) };
}

function aufschluesselung(slot: PreisSlot, wert: number): string | null {
  const source = slot.importPriceSource ?? null;
  if (source === 'fest') return '(Ihr Festpreis-Tarif)';
  if (source === 'spot') return '(reiner Börsenpreis)';
  if (source !== 'preisblatt' && source !== 'sammelaufschlag' && source !== 'default-flag') {
    return null;
  }
  const spotEurMwh = slot.priceEurMwh;
  if (spotEurMwh == null || !Number.isFinite(Number(spotEurMwh))) return null;
  const spot = Number(spotEurMwh) / 10;
  const rest = wert - spot;
  if (rest <= PREIS_TEIL_DEADBAND_CT) return null;
  return `(Börsenpreis ${ctFmt(spot)} + Netzentgelte/Abgaben ${ctFmt(rest)})`;
}

/** Die Vorschau als EIN Satz — „Ihr Bezugspreis gerade: 32,5 ct/kWh (…)". */
export function bezugspreisSatz(view: BezugspreisVorschau | null): string | null {
  if (!view) return null;
  const head = `Ihr Bezugspreis gerade: ${ctFmt(view.wert)} ct/kWh`;
  return view.aufschluesselung ? `${head} ${view.aufschluesselung}` : head;
}

/**
 * Was dort steht, solange es keinen Preis gibt. Zwei ehrliche Fälle statt einer
 * Zahl: ohne Tarifangabe ist nichts zu komponieren, mit Tarif aber ohne
 * (aktuellen) Fahrplan weiß die Fläche es schlicht noch nicht.
 */
export function bezugspreisLeerText(tarifArt: string | null | undefined): string {
  return tarifArt === 'ohne' || tarifArt == null
    ? 'Ohne Tarifangabe rechnen wir Ihren Netzbezug nicht in Euro um.'
    : 'Ihr Bezugspreis erscheint hier, sobald der nächste Fahrplan gerechnet ist.';
}

// ---------------------------------------------------------------------------
// 6 · E7 — die Grenze zur Box (D5: die Box bleibt eine eigene Seite)
// ---------------------------------------------------------------------------

/**
 * Die Zuständigkeit wird BEIDSEITIG ausgesprochen (Report §7.2). Bis E7 sagte
 * sie nur die Box („… Die Anlagensteuerung planen Sie im VoltPilot-Portal.");
 * das Portal schwieg in die Gegenrichtung.
 */
export const ZUSTAENDIG_PORTAL =
  'Hier stellen Sie ein, WOFÜR Ihre Anlage arbeitet — Verträge, Preise und das Verhalten Ihres Speichers.';

export const ZUSTAENDIG_BOX =
  'Direkt am Gerät stellen Sie ein, WOMIT gemessen wird — Wechselrichter, Erzeuger, Zähler, Vorzeichen und die Freigabe der Steuerung.';

/**
 * Wie die Box erreichbar ist. Bewusst KEIN Link: die Box steht im Heimnetz des
 * Kunden, ihre Adresse kennt das Portal nicht — ein geratener Link führte ins
 * Leere. Dieselbe Ehrlichkeit wie im Anlagen-Modell.
 */
export const BOX_ADDRESS_NOTE =
  'Die Geräteseite öffnen Sie in Ihrem Heimnetz unter der Adresse Ihres VoltPilot-Geräts, Port 8484.';

/** Die Faustregel für alles, was künftig dazukommt. */
export const BOX_RULE =
  'Faustregel: Braucht es ein Kabel oder ein Messgerät, gehört es an das Gerät. Braucht es einen Vertrag oder Geld, gehört es hierher.';
