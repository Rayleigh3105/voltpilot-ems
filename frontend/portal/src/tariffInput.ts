/**
 * **Die Regeln der Tarif-Eingabe** (E2 „Bedeutungsfalle", Konzept
 * `data/vp-settings-ux-konzept/report.md` §4.1 Wunde 1 + §7 P6, Captain-Entscheid
 * D3 vom 31.07.2026). Rein und ohne DOM, damit die Regeln unabhängig von der
 * Darstellung geprüft werden (das `anlage.ts`/`supplyPrice.ts`-Muster).
 *
 * Drei Regeln leben hier:
 *
 * 1. **Ein Wert je Tarifart.** Bis E2 speiste EIN `param`-Zustand zwei Felder mit
 *    völlig verschiedener Bedeutung — 18 als „Aufschlag auf den Börsenpreis"
 *    wurde beim Umschalten stumm zu 18 als „Ihr Strompreis", und 32,5 ct
 *    Festpreis in der Gegenrichtung zu 32,5 ct Aufschlag (Bezugspreis ≈ 55
 *    ct/kWh). Der Bezugspreis ist die Größe, mit der der Optimierer PLANT, der
 *    Fehler war also nicht kosmetisch. {@link switchTarifArt} hält je Tarifart
 *    einen eigenen Entwurf; nichts wird je umgedeutet, und
 *    {@link tarifSwitchNote} sagt beim Wechsel, was passiert ist.
 * 2. **Plausibilitätsspannen als WARNUNG, nie als Sperre.** Ein ungewöhnlicher
 *    Wert darf gespeichert werden — aber nicht versehentlich. Die Spannen
 *    stehen in {@link TARIF_PARAM_FIELDS} und benennen jeweils die ANDERE
 *    Bedeutung, weil genau die Verwechslung der Fehler ist.
 * 3. **Eine Preis-Wahrheit je Formular (D3).** Serverseitig ERSETZT ein
 *    gepflegtes Preisblatt den Sammelaufschlag
 *    (`services/optimization/voltpilot_optimization/pricing.py` `import_prices`),
 *    im Formular stand dazu bis E2 kein Wort. Jetzt ist es eine ausdrückliche
 *    Wahl: {@link PriceMode} `'schnell'` (eine Zahl) oder `'genau'` (das
 *    Preisblatt) — und der jeweils andere Weg steht read-only daneben, damit der
 *    Wechsel verlustfrei SICHTBAR ist.
 */
import type { SupplyPrice, SupplyPriceUpdate, TarifArt } from './api';
import {
  SUPPLY_PRICE_FIELDS,
  supplyPriceComponentsSumCt,
  type SupplyPriceComponentKey,
  type SupplyPriceFormValues,
} from './supplyPrice';

// ---------------------------------------------------------------------------
// 1 · Ein Wert je Tarifart
// ---------------------------------------------------------------------------

/** Die beiden Tarifarten, die überhaupt eine Zahl tragen. */
export type TarifArtWithParam = 'fest' | 'dynamisch';

/** Eine Plausibilitätsspanne (ct/kWh) — Warnschwelle, nie eine Sperre. */
export interface TarifRange {
  min: number;
  max: number;
  /** Die übliche Spanne im Klartext, für die Warnung. */
  typical: string;
}

/** Beschreibung des Zahlenfelds EINER Tarifart. */
export interface TarifParamField {
  label: string;
  placeholder: string;
  help: string;
  range: TarifRange;
  /** Wie die Größe im Fließtext heißt (für die Wechsel-Notiz). */
  meaning: string;
}

/**
 * Die zwei Zahlenfelder — je Tarifart eines, mit EIGENER Bedeutung.
 *
 * Die Spannen sind bewusst weit: sie sollen die Verwechslung fangen, nicht den
 * Sonderfall gängeln.
 * - **Fest** ist der all-in Arbeitspreis: Haushaltsstrom liegt 2026 typisch bei
 *   25–45 ct/kWh (Report §4.1), Gewerbe darunter — unter 20 ct ist es fast
 *   sicher ein Aufschlag, über 60 ct kein realer Arbeitspreis.
 * - **Dynamisch** ist der SAMMELaufschlag (Netzentgelte + Abgaben + Marge
 *   zusammen, so sagt es der Hilfstext des Felds selbst): das recherchierte
 *   Standard-Komponentenset summiert netto 15,686 ct/kWh (≈ 18,7 ct brutto), in
 *   teuren Netzgebieten mehr. Unter 5 ct ist es fast sicher nur die Marge
 *   (der „Vertriebsaufschlag", typisch 1–3 ct — dieselbe Wort-Kollision, die der
 *   Begriffs-Audit `vp-energiemarkt-x9` als DRINGEND führt), über 30 ct wäre es
 *   mehr als ein kompletter Arbeitspreis.
 */
export const TARIF_PARAM_FIELDS: Record<TarifArtWithParam, TarifParamField> = {
  dynamisch: {
    // E6/D6: der Audit (Teil 3, Zeile 5) wollte hier „Vertriebsaufschlag" -
    // dieselbe Größe wie im Preisblatt. Das stimmt im Code NICHT (E2 hat es
    // belegt): DIESER Aufschlag ist der SAMMEL-Aufschlag und ersetzt das ganze
    // Preisblatt, der `vertriebsaufschlagCt` dort ist nur die Marge. Beide
    // gleich zu benennen wäre der Selbstwiderspruch, den die Umbenennung
    // beenden soll - also trägt das Feld jetzt ausdrücklich „gesamt" und die
    // Suche (`glossar.ts`) führt beide Wörter zusammen.
    label: 'Aufschlag auf den Börsenpreis (gesamt, ct/kWh)',
    placeholder: 'z. B. 18',
    help: 'Netzentgelte, Abgaben & Marge zusammen - steht auf Ihrer Stromrechnung. Nicht nur der Vertriebsaufschlag.',
    range: { min: 5, max: 30, typical: '15–25 ct/kWh' },
    meaning: 'der gesamte Aufschlag auf den Börsenpreis',
  },
  fest: {
    // E6/D6, Audit Zeile 6: „Strompreis" ist mehrdeutig (mit/ohne Grundpreis).
    label: 'Arbeitspreis (all-in, brutto) (ct/kWh)',
    placeholder: 'z. B. 32,5',
    help: 'Ihr fester Arbeitspreis je kWh - siehe Stromrechnung (ohne Grundpreis).',
    range: { min: 20, max: 60, typical: '25–45 ct/kWh' },
    meaning: 'Ihr gesamter Arbeitspreis',
  },
};

/** Das Zahlenfeld dieser Tarifart, oder `null` für „Ohne Angabe". */
export function tarifParamField(art: TarifArt): TarifParamField | null {
  return art === 'fest' || art === 'dynamisch' ? TARIF_PARAM_FIELDS[art] : null;
}

/** Die je Tarifart getrennt gehaltenen Entwürfe (Text, wie eingetippt). */
export interface TarifDrafts {
  fest: string;
  dynamisch: string;
}

/**
 * Der Anfangszustand: nur die GESPEICHERTE Tarifart trägt ihren Wert. Ein
 * Wechsel zur anderen Art startet damit leer — nie mit einer Zahl, die dort
 * etwas anderes bedeutet.
 */
export function initialDrafts(art: TarifArt, param: string): TarifDrafts {
  return {
    fest: art === 'fest' ? param : '',
    dynamisch: art === 'dynamisch' ? param : '',
  };
}

/** Das Ergebnis eines Tarifart-Wechsels. */
export interface TarifSwitch {
  drafts: TarifDrafts;
  /** Der Wert, der jetzt im Feld steht (leer, wenn es für diese Art keinen gibt). */
  param: string;
  /** Ein früher in dieser Sitzung eingetippter Wert derselben Art kam zurück. */
  restored: boolean;
  /** Die verlassene Art trug einen Wert (der jetzt NICHT mitwandert). */
  carriedNothing: boolean;
}

/**
 * Die Tarifart wechseln, ohne je eine Zahl umzudeuten: der aktuelle Text wird
 * unter der ALTEN Art abgelegt, und ins Feld kommt der Entwurf der NEUEN Art
 * (sonst leer).
 */
export function switchTarifArt(
  drafts: TarifDrafts,
  from: TarifArt,
  currentText: string,
  to: TarifArt,
): TarifSwitch {
  const next: TarifDrafts = { ...drafts };
  if (from === 'fest' || from === 'dynamisch') next[from] = currentText;
  const param = to === 'fest' || to === 'dynamisch' ? next[to] : '';
  const hadValue =
    (from === 'fest' || from === 'dynamisch') && currentText.trim() !== '';
  return {
    drafts: next,
    param,
    restored: param.trim() !== '',
    carriedNothing: hadValue && from !== to && tarifParamField(to) != null,
  };
}

/**
 * Der Satz, der den Wechsel erklärt — die eigentliche Reparatur von Wunde 1:
 * ein Bedeutungswechsel wird ANGESAGT statt stumm vollzogen. `null`, wenn es
 * nichts zu sagen gibt (nichts stand da, oder die neue Art hat kein Feld).
 */
export function tarifSwitchNote(sw: TarifSwitch, from: TarifArt, to: TarifArt): string | null {
  const target = tarifParamField(to);
  if (!target) return null;
  if (sw.restored) {
    return 'Ihr zuvor eingetragener Wert für diese Tarifart steht wieder im Feld.';
  }
  const source = tarifParamField(from);
  if (!sw.carriedNothing || !source) return null;
  // Beide Bedeutungen stehen im Nominativ, damit der Satz in BEIDE Richtungen
  // grammatisch trägt („… zählt Ihr gesamter Arbeitspreis" / „… zählt ein
  // Aufschlag auf den Börsenpreis").
  return (
    `Andere Bedeutung: bisher stand hier ${source.meaning}. ` +
    `Für „${tarifArtName(to)}" zählt ${target.meaning} - bitte neu eintragen. ` +
    'Ihr bisheriger Wert bleibt gemerkt, falls Sie zurückwechseln.'
  );
}

/** Der Name einer Tarifart im Fließtext (wie im Auswahlfeld). */
export function tarifArtName(art: TarifArt): string {
  if (art === 'fest') return 'Fest';
  if (art === 'dynamisch') return 'Dynamisch';
  return 'Ohne Angabe';
}

// ---------------------------------------------------------------------------
// 2 · Plausibilitätsspannen (Warnung, nie Sperre)
// ---------------------------------------------------------------------------

/** Zahl aus dem Feld lesen; `null`, wenn dort (noch) keine steht. */
function parseCt(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Die Warnung zu einem eingetippten Tarif-Wert, oder `null`. Sie benennt immer
 * die ANDERE Bedeutung, weil die Verwechslung der Fehler ist — und sie sagt
 * ausdrücklich, dass gespeichert werden darf.
 */
export function tarifParamWarning(art: TarifArt, text: string): string | null {
  const field = tarifParamField(art);
  if (!field) return null;
  const value = parseCt(text);
  if (value == null || value < 0) return null;
  const { min, max, typical } = field.range;
  if (value >= min && value <= max) return null;
  const low = value < min;
  if (art === 'fest') {
    return low
      ? `Ungewöhnlich niedrig für einen Arbeitspreis (üblich ${typical}). ` +
          'Meinten Sie den Aufschlag eines dynamischen Tarifs? ' +
          'Speichern können Sie den Wert trotzdem.'
      : `Ungewöhnlich hoch für einen Arbeitspreis (üblich ${typical}). ` +
          'Bitte prüfen Sie den Wert - speichern können Sie ihn trotzdem.';
  }
  return low
    ? `Ungewöhnlich niedrig für diesen Aufschlag (üblich ${typical}). ` +
        'Gemeint sind Netzentgelte, Abgaben UND Marge zusammen, nicht nur die ' +
        'Marge Ihres Anbieters. Speichern können Sie den Wert trotzdem.'
    : `Ungewöhnlich hoch für einen Aufschlag (üblich ${typical}). ` +
        'Meinten Sie Ihren festen Arbeitspreis? Dann wählen Sie oben „Fest". ' +
        'Speichern können Sie den Wert trotzdem.';
}

/**
 * Dieselbe Warnung für die Preisblatt-Komponenten, wo eine Verwechslung
 * genauso teuer ist: der **Vertriebsaufschlag** ist nur die Marge (typisch
 * 1–3 ct/kWh, so sagt es der Hilfstext) und heißt fast wie der Sammelaufschlag
 * eine Zeile höher — wer dort seine 18 ct einträgt, zählt Netzentgelte und
 * Abgaben doppelt. Andere Komponenten haben keine Warnung: sie sind entweder
 * gesetzlich fix oder je Netzbetreiber zu verschieden, um eine Schwelle zu
 * rechtfertigen.
 */
export function supplyComponentWarning(
  key: SupplyPriceComponentKey,
  text: string,
): string | null {
  if (key !== 'vertriebsaufschlagCt') return null;
  const value = parseCt(text);
  if (value == null || value < 0) return null;
  if (value <= 5) return null;
  return (
    'Der Vertriebsaufschlag ist nur die Marge Ihres Anbieters (typisch 1–3 ' +
    'ct/kWh), nicht der gesamte Aufschlag auf den Börsenpreis - Netzentgelte ' +
    'und Abgaben stehen schon in den Zeilen darüber. Speichern können Sie den ' +
    'Wert trotzdem.'
  );
}

// ---------------------------------------------------------------------------
// 3 · „Schnell / Genau" — eine Preis-Wahrheit je Formular (D3)
// ---------------------------------------------------------------------------

/**
 * Wie der Bezugspreis angegeben wird. `'schnell'` = eine Zahl (bei „Fest" der
 * Arbeitspreis, bei „Dynamisch" der Aufschlag), `'genau'` = das strukturierte
 * Preisblatt. Serverseitig ist das ein Entweder/Oder, also ist es hier eine
 * ausdrückliche Wahl.
 */
export type PriceMode = 'schnell' | 'genau';

/**
 * Der Modus, in dem die Anlage GESPEICHERT ist: ein gepflegtes Preisblatt
 * (>= 1 Komponente) ist „Genau", alles andere „Schnell". Das ist genau die
 * Bedingung, mit der der Optimierer entscheidet (`has_components`).
 */
export function initialPriceMode(sheet: SupplyPrice | null | undefined): PriceMode {
  return sheet?.hasComponents ? 'genau' : 'schnell';
}

/** Eine Karte der Modus-Wahl. */
export interface PriceModeCard {
  id: PriceMode;
  label: string;
  hint: string;
}

/**
 * Die zwei Karten der Wahl. Sie erscheint nur bei den strukturierten Tarifarten
 * (`dynamisch`/`ohne`) — bei „Fest" ist der all-in Arbeitspreis die eine
 * Wahrheit, ein Preisblatt wird dort serverseitig gar nicht gerechnet.
 */
export function priceModeCards(art: TarifArt): PriceModeCard[] {
  return [
    {
      id: 'schnell',
      label: 'Schnell',
      hint:
        art === 'dynamisch'
          ? 'Eine Zahl: Ihr Aufschlag auf den Börsenpreis.'
          : 'Keine eigene Preisangabe.',
    },
    {
      id: 'genau',
      label: 'Genau',
      hint: 'Ihr Preisblatt: Netzentgelt, Steuern, Umlagen und Marge einzeln.',
    },
  ];
}

/** Ein Satz, der sagt, WOMIT im gewählten Modus gerechnet wird. */
export function priceModeExplain(mode: PriceMode, art: TarifArt): string {
  if (mode === 'genau') {
    return 'Gerechnet wird: (Börsenpreis + Summe Ihrer Komponenten) × Umsatzsteuer.';
  }
  return art === 'dynamisch'
    ? 'Gerechnet wird: Börsenpreis + Ihr Aufschlag.'
    : 'Sie hinterlegen keinen eigenen Bezugspreis.';
}

/** Die Kurzfassung eines Preisblatts: „Σ 15,686 ct/kWh netto + 19 % USt". */
export function supplyPriceSummary(values: SupplyPriceFormValues): string {
  const sum = supplyPriceComponentsSumCt(values).toLocaleString('de-DE', {
    maximumFractionDigits: 3,
  });
  const ust = values.ustPct.trim();
  const ustPart = ust === '' ? '' : ` + ${ust.replace('.', ',')} % USt`;
  return `Σ ${sum} ct/kWh netto${ustPart}`;
}

/**
 * Der read-only Spiegel des jeweils ANDEREN Wegs — „verlustfrei sichtbar":
 * wer „Genau" wählt, sieht seine Schnell-Zahl weiterhin (und dass sie nicht
 * gerechnet wird); wer „Schnell" wählt, sieht sein Preisblatt zusammengefasst.
 * `null`, wenn der andere Weg gar nichts trägt.
 */
export function priceModeMirror(
  mode: PriceMode,
  art: TarifArt,
  param: string,
  values: SupplyPriceFormValues,
  storedMode: PriceMode,
): string | null {
  if (mode === 'genau') {
    if (art !== 'dynamisch' || param.trim() === '') return null;
    return (
      `Ihre Schnell-Angabe (Aufschlag ${param.trim()} ct/kWh) bleibt gespeichert, ` +
      'wird aber nicht gerechnet.'
    );
  }
  if (storedMode !== 'genau') return null;
  return `Ihr gepflegtes Preisblatt: ${supplyPriceSummary(values)}.`;
}

/**
 * Die Folge, die eine Modus-Wahl VORHER ansagt (die E3-Regel: was etwas
 * anderes entwertet, nennt es in seiner eigenen Bestätigung). Von „Genau" auf
 * „Schnell" zu wechseln entfernt beim Speichern das Preisblatt — sonst würde es
 * serverseitig weiterhin gewinnen und die Oberfläche würde lügen.
 */
export function priceModeConsequence(
  storedMode: PriceMode,
  mode: PriceMode,
  art: TarifArt = 'dynamisch',
): string | null {
  if (storedMode !== 'genau' || mode !== 'schnell') return null;
  const base = 'Beim Speichern werden Ihre Bezugspreis-Komponenten entfernt - sonst ';
  // Nur „Dynamisch" hat eine Schnell-ZAHL, die sonst überstimmt würde; bei
  // „Ohne Angabe" bliebe schlicht das Preisblatt gerechnet.
  return art === 'dynamisch'
    ? `${base}würde weiterhin das Preisblatt gerechnet und nicht Ihre Zahl.`
    : `${base}würde weiterhin das Preisblatt gerechnet.`;
}

/**
 * Der PATCH, der ein Preisblatt entwertet: jede Komponente (und der
 * Preisblatt-Stand) wird geleert, der USt-Satz bleibt unangetastet (er ist
 * serverseitig NOT NULL). Danach ist `hasComponents` falsch, also rechnet der
 * Optimierer wieder mit der Schnell-Angabe.
 */
export function clearSupplyPricePatch(): SupplyPriceUpdate {
  const patch: SupplyPriceUpdate = { komponentenStand: null };
  for (const f of SUPPLY_PRICE_FIELDS) patch[f.key] = null;
  return patch;
}
