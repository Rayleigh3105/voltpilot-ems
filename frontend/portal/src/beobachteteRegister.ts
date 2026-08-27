/**
 * „Beobachtete Register" — die Messbibliothek, richtig herum (Geräteseiten
 * Stufe 3a; Konzept `data/vp-geraeteseite-rahmen-r2` §7.2/§7.5, Captain-Entscheide
 * **D3a** auch für HTTP/OCPP und **D5a** Client zuerst).
 *
 * **Der behobene Befund ist die RICHTUNG.** Die Messbibliothek fragte „was
 * KÖNNTE dieses Gerät liefern?" und zeigte acht empfohlene Katalog-Punkte; die
 * Frage eines Kunden auf einer Geräteseite ist die umgekehrte: **„was beobachte
 * ich hier gerade, und was sagt es JETZT?"**. Diese Datei ist die reine Regel
 * dafür — `components/BeobachteteRegister.tsx` rendert sie und entscheidet
 * nichts (das `geraetRegister.ts`/`geraetSeite.ts`-Muster).
 *
 * ⚠ **Vier Ehrlichkeitsregeln, die man beim Anfassen kennen muss:**
 *
 * 1. **Der WERT wird gelesen, nie gerechnet.** Er kommt aus der letzten
 *    Beobachtung des Servers (`decodedValue`/`rawValue`/`lastReadAt` am
 *    Katalog-Punkt); fehlt er, bleibt die Zeile ohne Wert — nie eine erfundene 0.
 * 2. **Die EINHEIT kommt vom Katalog und wird NIE geraten** (die
 *    `registerWrite.wertAnzeige`-Regel): ein „kW" hinter einem Ampere-Register
 *    wäre die gefährlichste Beschriftung dieses Pfades.
 * 3. **Ein Punkt, den die Box heute gar nicht lesen kann, behauptet keine
 *    Beobachtung.** Bis Stufe 3c pollt `vp-measurements` jeden Punkt gegen den
 *    PRIMÄREN Wechselrichter (§2.3 Schicht 3) — eine an eine Nebenkomponente
 *    gebundene Beobachtung steht deshalb auf „wartet auf die Box", solange kein
 *    Wert angekommen ist. Kam einer an, gewinnt der WERT: er ist der Beleg.
 * 4. **Nur EINGESCHALTETE Auswahlen sind Beobachtungen.** Eine abgewählte bleibt
 *    Historie (der Server löscht sie nie) und gehört nicht in eine Liste, die
 *    „das beobachte ich" überschrieben ist.
 */
import type {
  MeasurementCatalogPoint, MeasurementHistory, MeasurementSelectionState,
} from './api';
import { fmtRelative } from './format';
import type { MiniPoint } from './miniChart';
import { parseRegisterZahl } from './registerWrite';

/* ---------------------------------------------------------------------------
 * Die zwei Wortwahlen (D3a)
 * ------------------------------------------------------------------------- */

/**
 * „Register" ist an einem HTTP- oder OCPP-Gerät das FALSCHE Wort — dort sind
 * die Punkte API-Schlüssel bzw. MeterValue-Measurands. Die FÄHIGKEIT ist
 * dieselbe, deshalb gibt es die Liste dort auch (Entscheidung D3), nur ohne
 * Lesen und Schreiben.
 */
export type Wortwahl = 'register' | 'messwert';

/**
 * Welches Wort diese Seite spricht. Eingang ist die Register-Fähigkeit, die
 * `geraetGesicht` schon aus der ANBINDUNG ableitet — hier wird sie nicht neu
 * entschieden, sonst gäbe es zwei Urteile über denselben Transport.
 */
export function wortwahl(registerFaehig: boolean): Wortwahl {
  return registerFaehig ? 'register' : 'messwert';
}

export const TITEL: Record<Wortwahl, string> = {
  register: 'Beobachtete Register',
  messwert: 'Beobachtete Messwerte',
};

export const HINZU: Record<Wortwahl, string> = {
  register: 'Register beobachten',
  messwert: 'Messwert beobachten',
};

/** Situativ leer: die Sektion BLEIBT und sagt, wie man sie füllt (§4.6). */
export const LEER: Record<Wortwahl, string> = {
  register: 'Noch kein Register beobachtet — „Register beobachten" fügt eines hinzu.',
  messwert: 'Noch kein Messwert beobachtet — „Messwert beobachten" fügt einen hinzu.',
};

/**
 * Der Titel des Katalog-Einschubs. Er NENNT das Gerät (§7.2 Teil 2) — genau
 * das war der gemeldete Defekt: derselbe Titel über jeder Liste, während die
 * Liste eine ganz andere Anlage meinte. Ohne Namen bleibt es beim Auftrag.
 */
export function katalogTitel(wahl: Wortwahl, geraetName: string | null | undefined): string {
  const name = (geraetName ?? '').trim();
  const sache = wahl === 'register' ? 'Register' : 'Messwerte';
  return name ? `${sache} des ${name}` : HINZU[wahl];
}

/* ---------------------------------------------------------------------------
 * Eine Zeile der Beobachtungs-Liste
 * ------------------------------------------------------------------------- */

export type ZeileZustand = 'beobachtet' | 'wartet' | 'abgelehnt';

export const ZUSTAND_WORT: Record<ZeileZustand, string> = {
  beobachtet: 'beobachtet',
  wartet: 'wartet auf die Box',
  abgelehnt: 'abgelehnt',
};

export const ZUSTAND_TON: Record<ZeileZustand, 'ok' | 'warn' | 'ruhig'> = {
  beobachtet: 'ok',
  wartet: 'ruhig',
  abgelehnt: 'warn',
};

/**
 * Der Grund einer wartenden Zeile auf einem Gerät, das die Box heute nicht
 * pollt. ⚠ Wortgleich mit `registerFamilie.BEOBACHTEN_HINWEIS` gedacht, aber
 * kürzer: er steht AN der Zeile, der lange Satz über der Liste.
 */
export const WARTET_AUF_BOX =
  'Ihre Box liest diesen Punkt erst mit einem der nächsten Stände.';

export interface BeobachteteZeile {
  /** Stabiler Schlüssel — auch der React-Key. */
  key: string;
  pointKey: string;
  /** Der deutsche Name aus dem Katalog, sonst der gespeicherte, sonst der Schlüssel. */
  name: string;
  /** Register/Adresse (mono gesetzt) — `null`, wo keine bekannt ist. */
  adresse: string | null;
  /** Der letzte Wert samt Einheit — `null` heißt „noch keiner", nie 0. */
  wert: string | null;
  /** „vor 12 Sek." — `null`, solange nichts gelesen wurde. */
  frische: string | null;
  zustand: ZeileZustand;
  zustandWort: string;
  ton: 'ok' | 'warn' | 'ruhig';
  /** Warum die Zeile nicht „beobachtet" ist — der Server-Grund, sonst unserer. */
  grund: string | null;
  /** Ob „Verlauf" etwas zu zeigen hätte (dieselbe Regel wie bisher). */
  verlaufMoeglich: boolean;
  /** Ein selbst definiertes Register (es trägt keinen Katalog-Namen). */
  eigen: boolean;
}

export interface ZeilenInput {
  /** Die Auswahl DIESER Komponente (`?entityId=`), so wie der Server sie liefert. */
  selections: MeasurementSelectionState['selections'] | null | undefined;
  /** Der (familien-gefilterte) Katalog — er trägt Name, Adresse, Einheit und Wert. */
  katalog: readonly MeasurementCatalogPoint[] | null | undefined;
  /**
   * Kann die Box einen Punkt DIESES Geräts heute lesen
   * (`registerFamilie.beobachtenMoeglich`)? Ohne diese Angabe wird nichts
   * eingeschränkt — die Regel gehört dem Wirt, der das Gerät kennt.
   */
  lesbar?: boolean;
  now?: number;
}

/** Die Adresse eines Punktes — dieselbe Darstellung wie im Katalog-Einschub. */
export function adresse(point: MeasurementCatalogPoint): string | null {
  if (!point.address) return point.selector || null;
  if (point.address.registers?.length) {
    return point.address.registers
      .map((r) => `0x${r.toString(16).padStart(4, '0')}`)
      .join(', ');
  }
  return `SunSpec M${point.address.modelId}, Offset ${point.address.offsetWords}`;
}

/** Der Wert einer Zeile — dekodiert bevorzugt, roh als ehrlicher Rückfall. */
function wertVon(point: MeasurementCatalogPoint | null): string | null {
  if (!point) return null;
  if (point.decodedValue != null && point.decodedValue !== '') {
    return point.unit ? `${point.decodedValue} ${point.unit}` : point.decodedValue;
  }
  // ⚠ Roh wird als ROH beschriftet: eine nackte Zahl neben einem dekodierten
  // Nachbarn läse sich als derselbe Maßstab.
  if (point.rawValue != null && point.rawValue !== '') return `roh ${point.rawValue}`;
  return null;
}

const RANG: Record<ZeileZustand, number> = { abgelehnt: 0, wartet: 1, beobachtet: 2 };

/**
 * Die Zeilen der Beobachtungs-Liste — Aufmerksamkeit zuerst, dann alphabetisch.
 *
 * ⚠ Die Sortierung ist die Haus-Rangfolge (abgelehnt → wartet → beobachtet):
 * was eine Handlung braucht, steht oben. Innerhalb eines Rangs entscheidet der
 * NAME — „zuletzt gelesen" wäre eine Ordnung, die bei jedem Herzschlag springt.
 */
export function zeilen(input: ZeilenInput): BeobachteteZeile[] {
  const now = input.now ?? Date.now();
  const jetzt = new Date(now);
  const katalog = new Map((input.katalog ?? []).map((p) => [p.pointKey, p]));
  const out: BeobachteteZeile[] = [];
  for (const sel of input.selections ?? []) {
    // Regel 4: eine abgewählte Auswahl ist Historie, keine Beobachtung.
    if (!sel.enabled) continue;
    const point = katalog.get(sel.pointKey) ?? null;
    const wert = wertVon(point);
    const gelesen = point?.lastReadAt ?? null;
    const status = sel.applyStatus;
    let zustand: ZeileZustand;
    let grund: string | null = null;
    if (status === 'rejected') {
      zustand = 'abgelehnt';
      grund = sel.applyReason ?? null;
    } else if (status === 'applied' || status === 'first_sample') {
      // Regel 3: ohne Lesbarkeit UND ohne Wert wird keine Beobachtung behauptet.
      if (input.lesbar === false && wert == null) {
        zustand = 'wartet';
        grund = WARTET_AUF_BOX;
      } else {
        zustand = 'beobachtet';
      }
    } else {
      zustand = 'wartet';
      grund = sel.applyReason
        ?? (input.lesbar === false ? WARTET_AUF_BOX : null);
    }
    out.push({
      key: sel.pointKey,
      pointKey: sel.pointKey,
      name: point?.labelDe?.trim() || sel.label?.trim() || sel.pointKey,
      adresse: point ? adresse(point) : (sel.customDefinition?.selector ?? null),
      wert,
      frische: gelesen ? fmtRelative(gelesen, jetzt) : null,
      zustand,
      zustandWort: ZUSTAND_WORT[zustand],
      ton: ZUSTAND_TON[zustand],
      grund,
      verlaufMoeglich: Boolean(point?.recorded || gelesen),
      eigen: sel.customDefinition != null,
    });
  }
  return out.sort(
    (a, b) => RANG[a.zustand] - RANG[b.zustand] || a.name.localeCompare(b.name, 'de-DE'),
  );
}

/**
 * Die Kurzfassung im geschlossenen Zustand („3 beobachtet · Ladestand 87 % vor
 * 12 Sek.", §7.2).
 *
 * ⚠ Sie zählt die Zustände GETRENNT: „3 beobachtet" über drei wartenden Zeilen
 * wäre die Behauptung, die diese Stufe gerade abschafft. Ohne Zeile gibt es
 * keine Kurzfassung — der leere Zustand steht im Körper, und ihn hier zu
 * wiederholen wäre dieselbe Aussage zweimal auf einer Karte.
 */
export function kurzfassung(rows: readonly BeobachteteZeile[]): string | null {
  if (rows.length === 0) return null;
  const zahl = (z: ZeileZustand) => rows.filter((r) => r.zustand === z).length;
  const teile: string[] = [];
  if (zahl('beobachtet') > 0) teile.push(`${zahl('beobachtet')} beobachtet`);
  if (zahl('wartet') > 0) teile.push(`${zahl('wartet')} wartet`);
  if (zahl('abgelehnt') > 0) teile.push(`${zahl('abgelehnt')} abgelehnt`);
  const erste = rows.find((r) => r.wert);
  if (erste) teile.push([erste.name, erste.wert, erste.frische].filter(Boolean).join(' '));
  return teile.length > 0 ? teile.join(' · ') : null;
}

/* ---------------------------------------------------------------------------
 * Der Mini-Verlauf (24 h)
 * ------------------------------------------------------------------------- */

/**
 * Wie viele Zeilen einen Mini-Verlauf bekommen. Jeder kostet einen eigenen
 * Verlaufs-Abruf; jenseits der Grenze bleibt die Zeile ohne Spark — sie
 * behauptet dann nichts, statt die Seite mit Abrufen zu belasten.
 */
export const MAX_SPARK = 8;

/**
 * Die Punkte des Mini-Verlaufs. Eine Lücke bleibt eine Lücke (`null`) — der
 * Baustein zeichnet sie als solche (die `miniChart`-Regel).
 */
export function sparkPunkte(history: MeasurementHistory | null | undefined): MiniPoint[] {
  return (history?.data ?? []).map((d) => ({
    key: d.time,
    value: d.gap ? null : d.value,
  }));
}

/* ---------------------------------------------------------------------------
 * Die BRÜCKE: lesen, gut finden, behalten (§7.2 Teil 3)
 * ------------------------------------------------------------------------- */

/** Was „Beobachten" aus einer gelesenen Zeile macht — die Vorbefüllung. */
export interface BrueckeVorschlag {
  /** Der Name des Registers, so weit er bekannt ist. */
  label: string;
  /** Die Adresse DEZIMAL — das Formular rechnet nicht, es füllt. */
  address: string;
  sourceKind: 'modbus_holding' | 'modbus_input';
  unit: string;
  scale: string;
}

/**
 * Aus einer Lesung wird eine Beobachtung — das „Reinziehen" des Auftrags
 * (§7.2: lesen, gut finden, behalten).
 *
 * ⚠ **Es wird NICHTS geraten, und wo etwas fehlt, entsteht kein Vorschlag:**
 * ohne auflösbare Adresse (`parseRegisterZahl`) gibt es keinen, und eine SPULE
 * bekommt keinen — das Eigenbau-Formular kennt nur Holding- und Input-Register,
 * ein Vorschlag darauf wäre eine Zusage, die das Formular nicht halten kann.
 *
 * ⚠ Die SKALA wird aus dem gelesenen Paar abgeleitet (`skaliert / roh`), nie
 * erfunden: ohne beide Zahlen bleibt es bei 1, und die Einheit kommt vom
 * Server oder gar nicht.
 */
export function brueckeAusLesung(input: {
  adresse: string;
  art: 'holding' | 'input' | 'coil';
  registerLabel?: string | null;
  scaleUnit?: string | null;
  beforeRaw?: number | null;
  beforeScaled?: number | null;
}): BrueckeVorschlag | null {
  if (input.art === 'coil') return null;
  const n = parseRegisterZahl(input.adresse);
  if (n == null) return null;
  const raw = typeof input.beforeRaw === 'number' ? input.beforeRaw : null;
  const scaled = typeof input.beforeScaled === 'number' ? input.beforeScaled : null;
  const skala = raw != null && raw !== 0 && scaled != null ? scaled / raw : 1;
  return {
    label: input.registerLabel?.trim()
      || `Register 0x${n.toString(16).padStart(4, '0')}`,
    address: String(n),
    sourceKind: input.art === 'input' ? 'modbus_input' : 'modbus_holding',
    unit: input.scaleUnit?.trim() ?? '',
    scale: String(skala),
  };
}

/** Der Knopf an einer gelesenen Zeile — er sagt, was er tut. */
export const BRUECKE_LABEL = 'Beobachten';

/**
 * Warum an einer gelesenen Zeile kein „Beobachten" steht. Ein Knopf, der
 * strukturell nichts bewirken kann, wird nicht angeboten — dort steht der
 * Grund (die `registerZugang`-Regel).
 */
export const BRUECKE_NICHT_MOEGLICH =
  'Aus einer Spule lässt sich keine Beobachtung anlegen — das Formular kennt '
  + 'nur Holding- und Input-Register.';

/* ---------------------------------------------------------------------------
 * Eigene Register als Katalog-Punkte
 * ------------------------------------------------------------------------- */

/**
 * Die selbst definierten Register als Katalog-Punkte — damit Liste, Einschub
 * und Verlauf sie wie jeden anderen Punkt behandeln können.
 *
 * ⚠ `erlaubt` entscheidet der WIRT: ein eigenes Register wird gegen den
 * PRIMÄREN Wechselrichter gelesen, steht also nur auf dessen Seite; auf einer
 * Wallbox wäre es eine Zusage gegen die falsche Adresse.
 */
export function eigenePunkte(
  state: MeasurementSelectionState | null | undefined,
  erlaubt: boolean,
): MeasurementCatalogPoint[] {
  if (!erlaubt) return [];
  return (state?.selections ?? [])
    .filter((s) => s.customDefinition)
    .map((selection) => {
      const definition = selection.customDefinition!;
      const effectiveCadence = selection.cadenceS ?? definition.cadenceS;
      return {
        family: 'custom',
        pointKey: selection.pointKey,
        sourceKind: definition.sourceKind,
        address: {
          kind: definition.sourceKind,
          registers: [definition.address],
          widthWords: Math.max(1, definition.widthBits / 16),
        },
        selector: definition.selector,
        widthBits: definition.widthBits,
        valueType: definition.valueType,
        signed: definition.signed,
        endian: definition.endian,
        scale: { kind: 'factor', value: definition.scale },
        unit: definition.unit,
        group: 'Eigene Messwerte',
        labelDe: definition.label,
        labelSource: 'Eigenes Register',
        semanticStatus: 'unknown',
        aggregationKind: 'gauge',
        defaultCadenceS: definition.cadenceS,
        minCadenceS: 1,
        longTermCadenceS: null,
        pollGroup: `custom:${definition.sourceKind}:${definition.address}`,
        sourceUrl: '',
        sourceCommit: null,
        sourceRevision: null,
        dynamic: false,
        recommended: false,
        available: true,
        availabilityStatus: 'family_configured',
        availabilityReason: selection.enabled
          ? 'Eigenes Register; die Aufzeichnung ist für dieses Gerät angefordert.'
          : 'Eigenes Register; die Aufzeichnung ist beendet, die Historie bleibt erhalten.',
        recorded: selection.enabledAt != null,
        selected: selection.enabled,
        selectedCadenceS: selection.cadenceS,
        lastReadAt: null,
        rawValue: null,
        decodedValue: null,
        quality: null,
        gap: false,
        droppedSamples: 0,
        estimatedDataPerYearBytes: Math.round(
          (365.25 * 24 * 3600) / Math.max(1, effectiveCadence) * 96,
        ),
      } satisfies MeasurementCatalogPoint;
    });
}
