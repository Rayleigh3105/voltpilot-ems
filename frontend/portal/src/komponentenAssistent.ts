/**
 * Der EINE Anlege-Assistent, als REINE Ableitung (Einheitsmodell Stufe 1,
 * Konzept `vp-komponenten-einheit-h2` §4.1).
 *
 * Diese Datei rechnet und formuliert; sie rendert nichts und ruft nichts ab.
 * Damit ist jede Regel des Assistenten ohne DOM prüfbar - dasselbe Muster wie
 * `src/consumers/questions.ts`, `src/regeln/` und `src/anlageFlow.ts`.
 *
 * Die vier Schritte des Konzepts, hier als Zustand:
 *   1. Gerät   - Vorlage wählen (Katalog / geprüfte Vorlage)
 *   2. Verbindung + „Verbindung testen" (Pflicht - Weiter erst nach einem Ja)
 *   3. Was ist es? - die Rolle
 *   4. Prüfen & anlegen
 *
 * WORTSCHATZ: Set A („Komponente", „Gerät", „Messwert"). Kein „Entität",
 * kein „Messpunkt", kein „Quelle" - das ist das gepinnte D3-Wörterbuch.
 */

/** Ein Feld des `transport_schema` einer Vorlage (das Formular-Vokabular). */
import {
  hervorheben as hervorhebenIntern,
  normalisiereSuche as normalisiereSucheIntern,
  passt,
  suchBegriffe as suchBegriffeIntern,
  type TextTeil,
} from './picker/suche';

export type TemplateField = {
  key: string;
  label: string;
  /** `text` | `number` | `checkbox` | `select` - alles andere wird als Text behandelt. */
  type?: string;
  required?: boolean;
  default?: string | number | boolean;
  help?: string;
  options?: { value: string | number; label: string }[];
  secret?: boolean;
};

/** Eine Vorlage, wie `GET /api/v1/component-templates` sie liefert. */
export type ComponentTemplate = {
  templateRef: string;
  kind: string;
  version: number;
  brand: string;
  brandLabel: string;
  model: string;
  modelLabel: string;
  /**
   * Die Gerätetyp-Dimension des Katalogs (`inverter` | `wallbox` | `switch` |
   * `meter` | `charge_point` | `custom`). Sie trägt die Typ-Karten des neuen
   * Anlege-Wegs; `null`/absent heißt „die Vorlage sagt es nicht", nie ein
   * geratener Typ. Ein älterer Backend-Stand liefert sie gar nicht.
   */
  deviceType?: string | null;
  /**
   * Die Vorlage, die DIESE abgelöst hat - `null` = sie gilt. Der Lesepfad des
   * Assistenten liefert abgelöste Vorlagen ausdrücklich NICHT aus (sie bleiben
   * nur nachschlagbar), das Feld ist hier also die Erklärung, kein Filter.
   */
  supersededBy?: string | null;
  family?: string | null;
  familyLabel?: string | null;
  communication: string;
  communicationLabel: string;
  transportSchema?: TemplateField[] | null;
  ratedKw?: number | null;
  certificationStatus?: string | null;
};

/** Die vier Rollen, die der Assistent anbietet. */
export type KomponentenRolle = 'inverter' | 'pv-generation' | 'grid-meter' | 'consumer';

export type RolleOption = {
  id: KomponentenRolle;
  label: string;
  hint: string;
};

/**
 * Die Rollen-Auswahl in Schritt 3, in der Reihenfolge, in der ein Kunde sie
 * erwartet. Die Hinweise sagen, was die Rolle BEDEUTET - nicht, wie sie intern
 * heißt.
 */
export const ROLLEN: RolleOption[] = [
  {
    id: 'inverter',
    label: 'Wechselrichter / Speicher',
    hint: 'Das Herz Ihrer Anlage: erzeugt Solarstrom und lädt Ihren Speicher.',
  },
  {
    id: 'pv-generation',
    label: 'Weiterer Erzeuger',
    hint: 'Eine zusätzliche Solaranlage mit eigenem Wechselrichter.',
  },
  {
    id: 'grid-meter',
    label: 'Netz-Zähler',
    hint: 'Misst am Hausanschluss, was Sie beziehen und einspeisen. Nur einer je Anlage.',
  },
  {
    id: 'consumer',
    label: 'Verbraucher',
    hint: 'Ein Gerät, das Strom verbraucht - zum Beispiel eine Wallbox.',
  },
];

/**
 * Die drei Türen aus Schritt 1 (§4.1).
 *
 * Die Selbstbau-Tür ist seit Stufe 3 BEGEHBAR: der Kunde beschreibt sein Gerät
 * selbst (Adresse, Register, Messwerte) und sieht beim Anlegen echte Werte.
 * Sie führt in einen EIGENEN Assistenten - ihre Schritte 2-4 fragen etwas
 * anderes als die der Katalog-Tür (Messwerte statt eines Vorlagen-Formulars),
 * und in einen Ablauf zu pressen, was verschiedene Fragen stellt, wäre genau
 * die Verschmelzung, die dieses Konzept vermeidet.
 */
export type TuerId = 'katalog' | 'vorlage' | 'selbstbau' | 'ladesaeule';

export type Tuer = {
  id: TuerId;
  label: string;
  hint: string;
  /** false = sichtbar, aber (noch) nicht begehbar. */
  verfuegbar: boolean;
  /** Der ehrliche Satz an einer nicht begehbaren Tür. */
  bald?: string;
};

export function tueren(templates: ComponentTemplate[]): Tuer[] {
  const geprüft = templates.filter((t) => t.kind === 'certified').length;
  return [
    {
      id: 'katalog',
      label: 'Gerät aus dem VoltPilot-Katalog',
      hint: 'Deye, Fronius, KOSTAL, go-e, Shelly und mehr - Marke und Modell auswählen.',
      verfuegbar: templates.some((t) => t.kind === 'builtin'),
    },
    {
      id: 'vorlage',
      label: 'Geprüfte Vorlage',
      hint:
        geprüft > 0
          ? 'Von VoltPilot geprüfte Geräte, die nicht im Katalog stehen.'
          : 'Hier erscheinen Geräte, die VoltPilot zusätzlich geprüft hat. Aktuell ist die Liste leer.',
      verfuegbar: geprüft > 0,
    },
    {
      id: 'selbstbau',
      label: 'Eigenes Gerät (Modbus)',
      hint: 'Ein Gerät selbst beschreiben: Adresse, Register, Messwerte - mit Live-Vorschau.',
      verfuegbar: true,
    },
    /*
      Anlagen-Zentrale Stufe 3 (PR 3c, §13.4): „Weitere Säule anbinden" ist eine
      TÜR dieses Knopfs geworden, statt ein eigener Ort am Ende der
      Ladevorgänge-Seite.

      ⚠ Sie legt bewusst NICHTS an: eine Ladesäule verbindet sich SELBST (sie
      wählt VoltPilot an) - hier gibt es also nichts einzutragen, nur den Weg zu
      erklären. Ein Formular an dieser Stelle würde eine Handlung versprechen,
      die es nicht gibt.
    */
    {
      id: 'ladesaeule',
      label: 'Ladesäule (OCPP)',
      hint: 'Die Säule wählt VoltPilot selbst an - so tragen Sie sie dort ein.',
      verfuegbar: true,
    },
  ];
}

/**
 * Die Vorlagen einer Tür.
 *
 * ⚠ Die Türen `selbstbau` und `ladesaeule` haben KEINE: die eine beschreibt das
 * Gerät selbst, die andere erklärt nur den Weg (eine Ladesäule verbindet sich
 * selbst). Eine Marken-Auswahl an ihnen wäre ein Formular ohne Wirkung.
 */
export function templatesFuerTuer(
  templates: ComponentTemplate[],
  tuer: TuerId,
): ComponentTemplate[] {
  if (tuer === 'selbstbau' || tuer === 'ladesaeule') return [];
  const kind = tuer === 'vorlage' ? 'certified' : 'builtin';
  return templates.filter((t) => t.kind === kind);
}

/** Marken einer Tür, alphabetisch, mit ihren Modellen. */
export function marken(
  templates: ComponentTemplate[],
): { brand: string; brandLabel: string; models: ComponentTemplate[] }[] {
  const byBrand = new Map<string, { brandLabel: string; models: ComponentTemplate[] }>();
  for (const t of templates) {
    const entry = byBrand.get(t.brand) ?? { brandLabel: t.brandLabel, models: [] };
    entry.models.push(t);
    byBrand.set(t.brand, entry);
  }
  return [...byBrand.entries()]
    .map(([brand, v]) => ({ brand, brandLabel: v.brandLabel, models: v.models }))
    .sort((a, b) => a.brandLabel.localeCompare(b.brandLabel, 'de'));
}

/**
 * Die Formularfelder einer Vorlage, GENERISCH aus ihrem `transport_schema`.
 *
 * Der Assistent kennt keine Marke: was gefragt wird, steht in der Vorlage. Ein
 * neues Gerät braucht deshalb keine Portal-Änderung - genau der Punkt, an dem
 * Stufe 0a den Katalog zu Daten gemacht hat.
 */
export function felder(template: ComponentTemplate | null): TemplateField[] {
  if (!template || !Array.isArray(template.transportSchema)) return [];
  return template.transportSchema.filter((f) => f && typeof f.key === 'string' && f.key !== '');
}

/** Die Vorbelegung eines Formulars aus den Feld-Vorgaben der Vorlage. */
export function initialeVerbindung(template: ComponentTemplate | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of felder(template)) {
    if (f.default !== undefined && f.default !== null) out[f.key] = f.default;
  }
  return out;
}

/**
 * Welche Pflichtfelder noch fehlen - die Liste, die der „Weiter"-Knopf braucht.
 * Ein Feld gilt als gefüllt, wenn es einen nicht-leeren Wert trägt; `false` bei
 * einem Kontrollkästchen ist ein WERT, keine Lücke.
 */
export function fehlendeFelder(
  template: ComponentTemplate | null,
  verbindung: Record<string, unknown>,
): TemplateField[] {
  return felder(template).filter((f) => {
    if (!f.required) return false;
    const v = verbindung[f.key];
    if (f.type === 'checkbox') return v === undefined || v === null;
    return v === undefined || v === null || String(v).trim() === '';
  });
}

/**
 * Der Zustand des Verbindungstests. `ungeprueft` ist der Start; nur `bestanden`
 * gibt das Speichern frei.
 */
export type TestZustand = 'ungeprueft' | 'laeuft' | 'bestanden' | 'fehlgeschlagen';

/** Ein Messwert, den das Gerät im Test gemeldet hat. */
export type TestMesswert = { label: string; wert: string };

/**
 * Die vier Kanäle des Tests als Klartext-Zeilen. Ein Kanal, den das Gerät NICHT
 * meldet, fehlt in der Liste - er erscheint nie als 0 (die Lücke-statt-Null-
 * Regel des Hauses).
 */
export function messwerte(reading: Record<string, unknown> | null | undefined): TestMesswert[] {
  if (!reading) return [];
  const rows: TestMesswert[] = [];
  const push = (key: string, label: string, unit: string) => {
    const v = reading[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) return;
    rows.push({ label, wert: `${v.toLocaleString('de-DE', { maximumFractionDigits: 2 })} ${unit}` });
  };
  push('pvKw', 'Solarleistung', 'kW');
  push('loadKw', 'Verbrauch', 'kW');
  push('gridKw', 'Netz', 'kW');
  push('socPct', 'Ladestand', '%');
  return rows;
}

/**
 * Die deutschen Sätze zu den Fehlerklassen des Tests. Sie sind bewusst hier und
 * nicht im Server: dieselbe Klasse braucht am Gerät und im Portal denselben
 * Satz, und der Server schickt die Klasse, nicht die Formulierung.
 *
 * Ein Code, den diese Tabelle nicht kennt, bekommt KEINE erfundene Erklärung -
 * dann gilt der Satz des Servers, und wenn auch der fehlt, ein neutraler.
 */
const TEST_FEHLER: Record<string, string> = {
  unreachable: 'Unter dieser Adresse antwortet nichts. Bitte IP-Adresse und Netzwerk prüfen.',
  no_answer:
    'Das Gerät ist erreichbar, antwortet aber nicht wie erwartet. Bitte Seriennummer, Port und Modell prüfen.',
  invalid_response: 'Die Antwort passt nicht zu diesem Modell. Bitte die Modellauswahl prüfen.',
  implausible: 'Das Gerät antwortet, die Messwerte sind aber unplausibel.',
  fronius_api: 'Die Solar-API des Geräts hat nicht geantwortet.',
  invalid_request: 'Die Angaben sind unvollständig.',
  not_supported: 'Diese Verbindungsart kann Ihre VoltPilot-Box noch nicht prüfen.',
  rate_limited: 'Ihre VoltPilot-Box prüft gerade schon. Bitte einen Moment warten.',
  timeout: 'Ihre VoltPilot-Box hat nicht rechtzeitig geantwortet. Bitte erneut versuchen.',
};

export function testFehlerText(code?: string | null, serverText?: string | null): string {
  const known = code ? TEST_FEHLER[code] : undefined;
  if (known) return known;
  if (serverText && serverText.trim() !== '') return serverText.trim();
  return 'Die Prüfung ist fehlgeschlagen.';
}

/**
 * Das Ergebnis eines Testlaufs, aus der Probe-Antwort abgeleitet.
 *
 * Streng auf der Ja-Seite: nur eine Antwort OHNE Gesamt-Ablehnung und mit einer
 * `ok`-Zeile ist ein Ja. Alles andere - Timeout, Ratenbegrenzung, leere
 * Ergebnisliste - ist ein Nein mit Grund.
 */
export type ProbeAntwort = {
  errorCode?: string | null;
  message?: string | null;
  results?: {
    ok?: boolean;
    errorCode?: string | null;
    message?: string | null;
    reading?: Record<string, unknown> | null;
    finding?: ProbeBefund | null;
  }[];
};

/**
 * Der Befund einer verletzten Plausibilitätsregel (Vertrag
 * `mqtt-probe.schema.json` `op_result.finding`): WELCHER Kanal und WARUM.
 *
 * Maschinenlesbar, damit diese Datei keinen deutschen Satz nach Stichworten
 * durchsuchen muss. Ein Wort, das die Tabellen unten nicht kennen, führt zu
 * KEINER Aussage - nie zu einer erfundenen.
 */
export type ProbeBefund = {
  channel: string;
  rule: string;
  raw?: number | null;
  value?: number | null;
  /**
   * Die SCHÄTZUNG neben dem Befund (Ladestand aus der Batteriespannung). Sie
   * ändert das Urteil nicht - der Test bleibt fehlgeschlagen, die Ausnahme
   * bleibt nötig; sie gibt dem Kunden nur eine Zahl statt nur einer Ablehnung.
   */
  estimate?: { socPct?: number | null; voltageV?: number | null } | null;
};

export type TestErgebnis = {
  zustand: 'bestanden' | 'fehlgeschlagen';
  text: string;
  messwerte: TestMesswert[];
  /**
   * Die BELEGE, aus denen die Hebel entstehen (`testHebel.ts`) - maschinenlesbar
   * durchgereicht, nie neu abgeleitet.
   *
   * ⚠ Sie stehen NEBEN `text`/`regelText`, weil eine Fläche niemals einen
   * deutschen Satz nach Stichworten durchsuchen soll (die Haus-Regel, an der
   * schon `target_verdict` neben `state` hängt). Beide sind absent, wo der
   * Server nichts gesagt hat - dann gibt es auch keinen Hebel.
   */
  errorCode?: string | null;
  befund?: ProbeBefund | null;
  /**
   * Die verletzte Regel im Klartext - nur bei einem Fehlschlag, dessen Befund
   * einen Kanal NENNT. Ohne Befund steht hier nichts: eine erfundene Erklärung
   * wäre schlimmer als keine.
   */
  regelText?: string;
  /**
   * Der Ausweg, wenn dieser Kanal fehlen DARF. `null`/absent = es gibt keinen -
   * ein kaputter Rahmen und die Leerantwort des Loggers sind keine Fälle, die
   * ein Mensch übergehen darf.
   */
  override?: TestOverride;
};

/**
 * „Trotzdem fortfahren (nur Lesen)": der Weg aus der Sackgasse, wenn das Gerät
 * geantwortet hat und nachweislich nur EIN Kanal fehlt.
 *
 * Er entsteht ausschließlich aus dem Befund des Servers - die Fläche leitet
 * nie selbst ab, ob eine Verletzung übergehbar ist.
 */
export type TestOverride = {
  /** Der Kanal, den der Kunde abnickt - er reist so zum Server zurück. */
  channel: string;
  /** Die Beschriftung des Knopfs. */
  label: string;
  /** Was er bewirkt - und was er ausdrücklich NICHT bewirkt. */
  folgen: string[];
};

/**
 * Die verletzten Regeln in Klartext, je (Kanal, Regel). Sie sagen, was GEMESSEN
 * wurde und was daraus folgt - nie nur „unplausibel".
 */
function regelText(befund: ProbeBefund, hatWerte: boolean): string | undefined {
  if (befund.channel !== 'soc_pct') return undefined;
  const rest = hatWerte
    ? ' Spannung, Strom und Leistung sind lesbar.'
    : '';
  switch (befund.rule) {
    case 'missing':
      return (
        'Der Ladestand liest 0 % - bei einer Eigenbau- oder nicht gekoppelten Batterie heißt das: ' +
        'das BMS liefert keine Daten an den Wechselrichter.' + rest
      );
    case 'out_of_range':
      return (
        `Der Ladestand liest ${fmtProzent(befund.value)} - das kann kein Ladestand sein ` +
        '(gültig sind 1 bis 100 %). Meist passt die Modellauswahl nicht zum Gerät.'
      );
    case 'no_answer':
      return (
        'Das Gerät hat geantwortet, aber alle Register standen auf 0 - so antwortet der ' +
        'Datenlogger, wenn er den Wechselrichter selbst nicht erreicht.'
      );
    default:
      return undefined;
  }
}

function fmtProzent(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'einen unmöglichen Wert';
  return `${v.toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`;
}

/**
 * Der Ausweg - AUSSCHLIESSLICH für die eine Regel, die ein Gerätezustand ist
 * und kein Lesefehler.
 */
function overrideFuer(befund: ProbeBefund): TestOverride | undefined {
  if (befund.channel !== 'soc_pct' || befund.rule !== 'missing') return undefined;
  return {
    channel: befund.channel,
    label: 'Trotzdem fortfahren (nur Lesen)',
    folgen: [
      'Solarleistung, Verbrauch und Netz werden ganz normal aufgezeichnet.',
      'Der Ladestand bleibt leer - wir zeigen nie eine erfundene 0.',
      'Die Steuerung des Speichers bleibt aus: ohne Ladestand kann VoltPilot ihn nicht schützen.',
      'Sobald das BMS gekoppelt ist, hier erneut „Verbindung testen" - dann fällt die Ausnahme weg.',
    ],
  };
}

export function testErgebnis(antwort: ProbeAntwort | null | undefined): TestErgebnis {
  if (!antwort) {
    return { zustand: 'fehlgeschlagen', text: testFehlerText(null, null), messwerte: [] };
  }
  if (antwort.errorCode) {
    return {
      zustand: 'fehlgeschlagen',
      text: testFehlerText(antwort.errorCode, antwort.message),
      messwerte: [],
      errorCode: antwort.errorCode,
    };
  }
  const line = antwort.results?.[0];
  if (!line || !line.ok) {
    // ⚠ Ein Fehlschlag ZEIGT, was ankam - wenn ein Befund den einen
    // verletzenden Kanal nennt. Vorher stand hier ein nacktes „die Messwerte
    // sind unplausibel" ohne eine einzige Zahl, und an genau diesem Rätsel ist
    // eine reale Neuanlage hängengeblieben (Mühlfeldweg 2, 21.08.2026).
    const befund = line?.finding ?? null;
    const rows = befund ? messwerte(line?.reading) : [];
    return {
      zustand: 'fehlgeschlagen',
      text: testFehlerText(line?.errorCode, line?.message ?? antwort.message),
      messwerte: rows,
      errorCode: line?.errorCode ?? null,
      befund,
      regelText: befund ? regelText(befund, rows.length > 0) : undefined,
      override: befund ? overrideFuer(befund) : undefined,
    };
  }
  const rows = messwerte(line.reading);
  return {
    zustand: 'bestanden',
    text:
      rows.length > 0
        ? 'Das Gerät antwortet. Diese Messwerte kommen gerade an:'
        : 'Das Gerät antwortet.',
    messwerte: rows,
  };
}

/**
 * Der Satz an der fertigen Komponente, wenn sie ausdrücklich ohne einen
 * Messkanal betrieben wird - der DAUERHAFTE Ausweis des Klicks, nicht nur eine
 * Meldung im Assistenten.
 *
 * Er liest die Anbindung, die der Server gespeichert hat (`reading_override`),
 * und behauptet nichts, was dort nicht steht: ohne Datum kein Datum.
 */
export function ohneMesswertHinweis(
  connection: Record<string, unknown> | null | undefined,
): { badge: string; satz: string } | null {
  const o = connection?.['reading_override'];
  if (!o || typeof o !== 'object') return null;
  const rec = o as Record<string, unknown>;
  if (rec['channel'] !== 'soc_pct') return null;
  const at = typeof rec['accepted_at'] === 'string' ? rec['accepted_at'] : null;
  const wann = at ? datumText(at) : null;
  return {
    badge: 'ohne Ladestand',
    satz:
      'Diese Komponente wurde mit unplausiblen Testwerten angelegt' +
      (wann ? ` am ${wann}` : '') +
      ': das BMS meldet keinen Ladestand. Alle anderen Messwerte laufen normal; ' +
      'die Steuerung des Speichers bleibt deshalb aus.',
  };
}

function datumText(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * Der Bilanz-Hinweis aus §3.4/§4.1 Schritt 3 - EIN Satz, der sagt, ob diese
 * Komponente in die Energiebilanz eingeht.
 *
 * Er steht da, damit niemand glaubt, ein zusätzlich angelegter Verbraucher
 * würde zum Hausverbrauch addiert: er steckt in der gemessenen Bilanz längst
 * drin, und ihn ein zweites Mal zu zählen wäre schlicht falsch.
 */
export function bilanzHinweis(rolle: KomponentenRolle): string {
  switch (rolle) {
    case 'inverter':
      return 'Dieses Gerät trägt die Energiebilanz Ihrer Anlage - Solarstrom, Speicher und Netz.';
    case 'pv-generation':
      return 'Die Erzeugung dieses Geräts wird zur Solarleistung Ihrer Anlage addiert.';
    case 'grid-meter':
      return 'Dieser Zähler misst am Hausanschluss und wird dadurch zur maßgeblichen Netz-Messung.';
    case 'consumer':
      return 'Dieses Gerät zeigt seinen eigenen Verbrauch. In den Hausverbrauch geht es nicht zusätzlich ein - dort ist es bereits enthalten.';
  }
}

/**
 * Ob eine Rolle in dieser Anlage überhaupt noch wählbar ist, samt Grund. Der
 * Server prüft dieselben Regeln noch einmal (er ist der Zaun) - hier stehen sie,
 * damit der Kunde sie SIEHT, statt in eine Ablehnung zu laufen.
 */
export function rolleVerfuegbar(
  rolle: KomponentenRolle,
  vorhandeneRollen: string[],
): { ok: true } | { ok: false; grund: string } {
  if (rolle === 'grid-meter' && vorhandeneRollen.filter((r) => r === 'grid-meter').length > 0) {
    return {
      ok: false,
      grund: 'Diese Anlage hat bereits einen Netz-Zähler. Es ist nur einer möglich.',
    };
  }
  return { ok: true };
}

/** Die Zusammenfassung in Schritt 4 - was gleich passiert, in Klartext. */
export type PruefZeile = { label: string; wert: string };

export function pruefen(
  template: ComponentTemplate,
  rolle: KomponentenRolle,
  name: string,
  verbindung: Record<string, unknown>,
  /** Die verwaiste Komponente, die dieses Gerät übernimmt (Alias-Kontinuität). */
  uebernahme?: ComponentMatch | null,
): PruefZeile[] {
  const rows: PruefZeile[] = [
    { label: 'Name', wert: nameVorschau(template, name, uebernahme) },
    { label: 'Gerät', wert: `${template.brandLabel} ${template.modelLabel}` },
    { label: 'Art', wert: ROLLEN.find((r) => r.id === rolle)?.label ?? rolle },
    { label: 'Verbindung', wert: template.communicationLabel },
  ];
  if (uebernahme) {
    rows.splice(1, 0, { label: 'Komponente', wert: UEBERNAHME_ZEILE });
  }
  for (const f of felder(template)) {
    const v = verbindung[f.key];
    if (v === undefined || v === null || String(v).trim() === '') continue;
    if (f.type === 'checkbox' && v === false) continue;
    rows.push({ label: f.label, wert: anzeigeWert(f, v) });
  }
  return rows;
}

function anzeigeWert(field: TemplateField, value: unknown): string {
  if (field.type === 'checkbox') return value ? 'ja' : 'nein';
  if (field.options) {
    const hit = field.options.find((o) => String(o.value) === String(value));
    if (hit) return hit.label;
  }
  return String(value);
}

/**
 * Der Satz, der den Abschluss ehrlich macht: das Portal hat gespeichert, die
 * Box muss es noch anwenden. Ein „fertig", das eine Zustellung behauptet, die
 * niemand gemessen hat, wäre genau die Erfindung, die dieses Haus vermeidet.
 */

// ---------------------------------------------------------------------------
// Alias-Kontinuität: eine verwaiste Komponente wird ÜBERNOMMEN, nicht verdoppelt
// (Live-Fall Herzogau, 20.08.2026 - Captain: „beim neu hinzufügen sind die
// Aliase jetzt weg").
// ---------------------------------------------------------------------------

/**
 * Die vorhandene Komponente, die der Server bei diesem Gerät übernehmen würde.
 * Sie kommt VOM SERVER (`POST /sites/{id}/component-match`) - die Regel, welche
 * Zeile das ist, wohnt dort und wird hier NIE nachgerechnet: ein zweiter
 * Fingerabdruck in TypeScript würde von ihr abdriften (die Haus-Regel der
 * Zwillinge, hier bewusst vermieden statt gepinnt).
 */
export type ComponentMatch = {
  entityId: string;
  label?: string | null;
  role?: string | null;
  brand?: string | null;
  model?: string | null;
  /** Hatte eine Bindung, die gerissen ist (statt nie einer zugeordnet gewesen). */
  orphaned?: boolean | null;
};

/** Die Zeile in der Prüfen-Liste, wenn übernommen statt angelegt wird. */
export const UEBERNAHME_ZEILE = 'Vorhandene Komponente wird wieder verbunden';

/**
 * Der Name, den die Komponente NACH dem Speichern trägt.
 *
 * <p>Die Regel spiegelt den Server (`COALESCE(NULLIF(?,''), label)`): ein leer
 * gelassenes Feld ÜBERSCHREIBT nichts. Deshalb ist das Feld auch nicht mehr mit
 * dem Modellnamen vorbefüllt - genau diese Vorbefüllung hat den Kundennamen
 * überschrieben.
 */
export function nameVorschau(
  template: ComponentTemplate,
  name: string,
  uebernahme?: ComponentMatch | null,
): string {
  const getippt = name.trim();
  if (getippt !== '') return getippt;
  const bisher = uebernahme?.label?.trim();
  if (bisher) return bisher;
  return template.modelLabel;
}

/**
 * Der Satz über dem Namensfeld, wenn eine vorhandene Komponente übernommen wird -
 * oder `null`, wenn wirklich eine neue entsteht.
 *
 * <p>Er BEHAUPTET nie einen Namen, den es nicht gibt: eine Zeile ohne
 * Kundennamen wird über Marke und Modell benannt, nie über eine erfundene
 * Bezeichnung.
 */
export function uebernahmeHinweis(
  uebernahme: ComponentMatch | null | undefined,
  template: ComponentTemplate | null,
): string | null {
  if (!uebernahme) return null;
  const name = uebernahme.label?.trim();
  const wer = name
    ? `Ihre bisherige Komponente „${name}"`
    : 'eine Komponente, die Sie schon angelegt haben';
  const grund = uebernahme.orphaned
    ? 'Ihre Verbindung zu diesem Gerät war unterbrochen'
    : 'sie ist noch keinem Gerät zugeordnet';
  const geraet = template ? `${template.brandLabel} ${template.modelLabel}` : 'Dieses Gerät';
  return (
    `${geraet} ist vermutlich ${wer} - ${grund}. ` +
    'Wir verbinden sie wieder, statt eine zweite anzulegen: Name, Verlauf und ' +
    'Zuordnungen bleiben erhalten.'
  );
}

/** Die Hilfe unter dem Namensfeld - sie sagt, was ein LEERES Feld bedeutet. */
export function nameHilfe(uebernahme?: ComponentMatch | null): string {
  return uebernahme?.label?.trim()
    ? `Leer lassen behält den bisherigen Namen „${uebernahme.label.trim()}".`
    : 'So heißt die Komponente in Ihrer Anlage. Leer lassen ist in Ordnung - dann '
        + 'benennen wir sie nach Marke und Modell.';
}

export const ABSCHLUSS_HINWEIS =
  'Gespeichert. Ihre VoltPilot-Box übernimmt die Änderung, sobald sie das nächste Mal ' +
  'verbunden ist - der Stand steht an der Komponente.';

/**
 * Die Soll/Ist-Zeile je Komponente („Läuft auf dem Gerät · Fassung 3" /
 * „Änderung unterwegs" / der bewusste Halt / ehrlich unbekannt).
 *
 * `unreported` heißt UNBEKANNT, nie „nicht angekommen": eine ältere Box meldet
 * ihren Anwende-Stand gar nicht, und daraus einen Fehler zu machen wäre eine
 * Behauptung über ein Gerät, das nichts gesagt hat.
 *
 * `held` ist die dritte Antwort der Box (Befund L1): sie hat GENAU diese
 * Fassung gesehen und bewusst nichts angewandt, weil im Portal keine Anbindung
 * mehr hinterlegt ist. Das ist kein Fehler und keine Reise - der Satz sagt
 * deshalb, was WIRKLICH läuft, statt „unterwegs" zu behaupten (der Zustand,
 * in dem eine solche Anlage vorher für immer hing).
 *
 * `no_gateway_device` ist der EINE Fall, in dem der Grund bekannt IST (Befund
 * L10): die Anlage hat mehrere Geräte und keins davon ist als steuerndes Gerät
 * des Speichers hinterlegt, also gibt es keinen Empfänger. Das zu verschweigen
 * war der Befund - „Stand auf dem Gerät unbekannt" schickte den Kunden suchen,
 * obwohl der Server weiß, was fehlt, und was zu tun ist.
 *
 * `box_managed` ist die Rückgabe (Befund L8): die Box hat GEMELDET, dass sie
 * ihre Geräte wieder selbst pflegt. Dann gibt es gar kein Soll/Ist mehr - und
 * ohne diesen Zustand behauptete die Zeile nach einem „am Gerät verwalten"
 * dauerhaft „Änderung unterwegs zur Box" (jeder Push zählt die Soll-Revision
 * hoch, während die alte Ist-Zeile stehen blieb) oder, schlimmer, ein
 * „Läuft auf dem Gerät · Fassung N" über einen Stand, dem niemand mehr folgt.
 */
export const KEIN_EMPFAENGER_SATZ =
  'Diese Anlage hat mehrere Geräte und keinen zugeordneten Speicher - VoltPilot '
  + 'weiß nicht, an welches Gerät die Einstellungen gehen. Bitte tragen Sie unter '
  + '„Technik" das steuernde Gerät des Speichers ein.';

export function sollIstText(
  syncStatus: string | null | undefined,
  definitionVersion: number,
): string {
  switch (syncStatus) {
    case 'in_sync':
      return `Läuft auf dem Gerät · Fassung ${definitionVersion}`;
    case 'pending':
      return 'Änderung unterwegs zur Box';
    case 'held':
      return 'Die Box behält den letzten Gerätestand';
    case 'no_gateway_device':
      return KEIN_EMPFAENGER_SATZ;
    case 'box_managed':
      return 'Die Geräte werden auf der Box gepflegt';
    default:
      return 'Stand auf dem Gerät unbekannt';
  }
}

/**
 * Der EINE Satz unter der Halt-Zeile: WARUM die Box nichts angewandt hat.
 *
 * Der Grund kommt WÖRTLICH von der Box (`heldReason`) - eine zweite
 * Formulierung derselben Lage wäre eine zweite Wahrheit. Ohne gemeldeten Grund
 * steht der Hausatz, ohne Halt gar nichts.
 */
export function haltGrund(
  syncStatus: string | null | undefined,
  heldReason?: string | null,
): string | null {
  if (syncStatus !== 'held') return null;
  const gemeldet = heldReason?.trim();
  return gemeldet
    ? gemeldet
    : 'Im Portal ist für diese Anlage keine Anbindung mehr hinterlegt; '
        + 'die Box behält deshalb den zuletzt angewandten Stand.';
}

/**
 * Der Ton der Soll/Ist-Zeile: ok · unterwegs · unbekannt.
 *
 * ⚠ Ein Halt, ein fehlender Empfänger und die gemeldete Rückgabe sind bewusst
 * `unbekannt` und nicht `busy`: in allen drei Fällen ist nichts unterwegs. Ein
 * eigener Warnton wäre die dritte Farbe für Zustände, die die Anlage nicht
 * stören - sie läuft weiter, nur die nächste Änderung wartet. Ein `ok` sind sie
 * auch nicht: bei den ersten beiden gehen Soll und Ist wirklich auseinander,
 * und bei der Rückgabe gibt es gar kein Soll/Ist mehr, das „stimmt".
 */
export function sollIstTon(syncStatus: string | null | undefined): 'ok' | 'busy' | 'unbekannt' {
  if (syncStatus === 'in_sync') return 'ok';
  if (syncStatus === 'pending') return 'busy';
  return 'unbekannt';
}

/**
 * Der EINE Satz, der sagt, WO die Geräte dieser Anlage gepflegt werden
 * (Einheitsmodell Stufe 2). Ein Satz, kein Alarm - der Wechsel des
 * Bearbeitungs-Orts ist ein Zustand, keine Störung.
 *
 * Die drei Fälle sind bewusst verschieden:
 *
 * - **box-verwaltet:** die Anlage wartet noch (auf einen Box-Stand, der ihre
 *   Verbindungen meldet). Das wird GESAGT, sonst wäre die Abwesenheit des
 *   Assistenten unerklärlich - der Kunde sähe nur, dass hier etwas fehlt.
 * - **portal-verwaltet nach einer ÜBERNAHME:** die Anlage war vorher am Gerät
 *   eingerichtet; der Satz erklärt den Wechsel und nennt, dass am Gerät nichts
 *   passiert ist.
 * - **portal-verwaltet ohne Übernahme:** hier wurde nie woanders gepflegt, also
 *   gibt es nichts zu erklären - dann SCHWEIGT die Fläche.
 */
export function verwaltungsHinweis(
  componentAuthority: string | null | undefined,
  adoptedAt: string | null | undefined,
): string | null {
  if (componentAuthority !== 'portal') {
    return (
      'Die Geräte dieser Anlage werden noch direkt an Ihrer VoltPilot-Box gepflegt. ' +
      'Sobald die Box ihre Anbindung meldet, übernehmen wir sie hierher - Sie müssen dafür nichts tun.'
    );
  }
  if (!adoptedAt) return null;
  return (
    'Die Geräte dieser Anlage werden jetzt hier im Portal gepflegt. ' +
    'An Ihrer Anlage selbst hat sich dadurch nichts geändert.'
  );
}

/**
 * Die Ablehnungs-Zeile der Anlage, wenn die Box ein Soll NICHT anwenden konnte.
 * Sie nennt beides: dass die alte Fassung weiterläuft, UND warum die neue nicht
 * angekommen ist. Nur eines davon zu sagen wäre die Hälfte der Wahrheit.
 */
export function ablehnungText(
  refusedRevision: string | null | undefined,
  refusedReason: string | null | undefined,
): string | null {
  if (!refusedRevision) return null;
  const grund = refusedReason && refusedReason.trim() !== '' ? refusedReason.trim() : null;
  const kopf = 'Ihre VoltPilot-Box konnte die letzte Änderung nicht übernehmen; es läuft weiter der vorherige Stand.';
  return grund ? `${kopf} Grund: ${grund}` : kopf;
}

// ─── Modell-SUCHE (Captain 21.08.2026, Scout `vp-geraeteseite-rev-b8` NACHTRAG 5)

/**
 * „Bitte bei den Modellen eine Suche einbauen. Das ist ziemlich schwierig ein
 * Modell zu finden." - der Captain-Befund beim Anlegen eines
 * SUN-30K-SG02HP3-EU-AM3.
 *
 * Der behobene Schmerz ist das STUFENMENÜ: wer sein Modell nicht schon einer
 * Marke zuordnen kann, muss sieben Marken durchklicken, um 47 Vorlagen zu
 * sehen - und wer den Namen vom Typenschild abtippt („SUN 30K"), findet in
 * einem `select` gar nichts, weil ein natives Auswahlfeld nur auf den
 * Zeilenanfang springt.
 *
 * **⚠ DIE SUCHE ERFINDET KEINE VORLAGE.** Sie filtert genau die Liste, die das
 * Stufenmenü daneben zeigt (`templatesFuerTuer`) - dieselbe Quelle, dasselbe
 * Ergebnis, nur ein anderer Weg dorthin. Das Stufenmenü bleibt als
 * Stöber-Alternative erhalten: wer seine Marke kennt, klickt weiter.
 */

export interface ModellTreffer {
  template: ComponentTemplate;
  /** Der Marken-Name, mit hervorgehobenen Fundstellen. */
  marke: TextTeil[];
  /** Der Modell-Name, mit hervorgehobenen Fundstellen. */
  modell: TextTeil[];
  /** „30 kW · Hybrid, 3-phasig · Solarman-Logger" - was davon bekannt ist. */
  zusatz: string;
}

export interface ModellSuche {
  /** Die Treffer, beste zuerst - gedeckelt auf {@link MAX_TREFFER}. */
  treffer: ModellTreffer[];
  /** Wie viele es INSGESAMT gibt (der Deckel wird nie verschwiegen). */
  gesamt: number;
  /** Der Satz, wenn nichts passt - nie ein stiller leerer Bereich. */
  leer: string | null;
  /** Die Zeile über der Liste („12 von 47 Vorlagen"), oder null ohne Suche. */
  zaehler: string | null;
}

/**
 * Wie viele Treffer die Liste zeigt. Mehr wäre wieder eine Liste zum
 * Durchscrollen - und genau die ist der Grund für die Suche.
 */
export const MAX_TREFFER = 12;

/**
 * Die tolerante Suche wohnt seit dem VpPicker-System in `picker/suche.ts` -
 * EINE Implementierung für die ganze Plattform (die Modell-Suche war ihr
 * Vorbild und ist ihr erster Abnehmer geblieben). Sie wird hier
 * DURCHGEREICHT, damit jeder bestehende Aufrufer und jeder bestehende Test
 * unverändert gültig bleibt.
 */
export { hervorheben, normalisiereSuche, suchBegriffe } from './picker/suche';
export type { TextTeil } from './picker/suche';

/**
 * Die Zusatz-Angaben eines Treffers (Captain: „kW, Phasen, HV/LV").
 *
 * ⚠ Sie werden GELESEN, nie geraten: die Nennleistung steht in der Vorlage,
 * die Phasen/Spannungslage stecken im Familien-Namen des Katalogs
 * („Hybrid, 3-phasig"). Fehlt eines, fehlt es - nie eine erfundene 0 kW.
 */
export function modellZusatz(t: ComponentTemplate): string {
  const teile: string[] = [];
  if (typeof t.ratedKw === 'number' && Number.isFinite(t.ratedKw) && t.ratedKw > 0) {
    teile.push(`${t.ratedKw.toLocaleString('de-DE')} kW`);
  }
  const familie = (t.familyLabel ?? '').trim();
  if (familie !== '') teile.push(familie);
  const comm = (t.communicationLabel ?? '').trim();
  if (comm !== '') teile.push(comm);
  return teile.join(' · ');
}

/** Was durchsucht wird - alles, was auf einem Typenschild stehen kann. */
function heuhaufen(t: ComponentTemplate): string {
  return normalisiereSucheIntern([
    t.brandLabel, t.brand, t.modelLabel, t.model,
    t.familyLabel ?? '', t.family ?? '', t.communicationLabel ?? '',
  ].join(' '));
}

/**
 * Der Rang eines Treffers: was mit der Eingabe BEGINNT, steht oben.
 *
 * Wer „SG02" tippt, meint fast immer ein Modell und nicht eine Marke - deshalb
 * schlägt ein Modell-Treffer einen Marken-Treffer, und ein Präfix schlägt eine
 * Fundstelle mitten im Namen.
 */
function rang(t: ComponentTemplate, begriffe: string[]): number {
  const modell = normalisiereSucheIntern(`${t.modelLabel} ${t.model}`);
  const marke = normalisiereSucheIntern(`${t.brandLabel} ${t.brand}`);
  if (begriffe.some((b) => modell.startsWith(b))) return 0;
  if (begriffe.some((b) => modell.includes(b))) return 1;
  if (begriffe.some((b) => marke.startsWith(b))) return 2;
  return 3;
}

/**
 * Die Suche über ALLE Marken und Modelle einer Tür.
 *
 * Ohne Eingabe gibt es KEINE Treffer und keinen Zähler - die Suche drängt sich
 * nicht auf, das Stufenmenü daneben bleibt der ruhige Weg.
 */
export function modellSuche(templates: ComponentTemplate[], query: string): ModellSuche {
  const begriffe = suchBegriffeIntern(query);
  if (begriffe.length === 0) {
    return { treffer: [], gesamt: templates.length, leer: null, zaehler: null };
  }
  const passend = templates.filter((t) => {
    return passt(heuhaufen(t), begriffe);
  });
  if (passend.length === 0) {
    return {
      treffer: [],
      gesamt: 0,
      leer: `Keine Vorlage passt zu „${query.trim()}“. Oft reicht ein Teil des Namens, `
        + 'zum Beispiel nur „30K“ - sonst hilft die Marken-Auswahl darunter.',
      zaehler: null,
    };
  }
  const sortiert = [...passend].sort((a, b) => {
    const d = rang(a, begriffe) - rang(b, begriffe);
    if (d !== 0) return d;
    const m = a.modelLabel.localeCompare(b.modelLabel, 'de');
    return m !== 0 ? m : a.brandLabel.localeCompare(b.brandLabel, 'de');
  });
  const treffer = sortiert.slice(0, MAX_TREFFER).map((t) => ({
    template: t,
    marke: hervorhebenIntern(t.brandLabel, begriffe),
    modell: hervorhebenIntern(t.modelLabel, begriffe),
    zusatz: modellZusatz(t),
  }));
  return {
    treffer,
    gesamt: passend.length,
    leer: null,
    // ⚠ Der Deckel wird NIE verschwiegen - eine Liste, die zwölf von dreissig
    // zeigt und dreissig behauptet, lässt jemanden vergeblich scrollen.
    zaehler: passend.length > MAX_TREFFER
      ? `${treffer.length} von ${passend.length} Treffern - Suche verfeinern zeigt die übrigen.`
      // „Treffer" ist im Deutschen im Singular wie im Plural gleich.
      : `${passend.length} Treffer`,
  };
}
