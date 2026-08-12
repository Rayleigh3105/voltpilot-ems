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
export type TemplateField = {
  key: string;
  label: string;
  /** `text` | `number` | `checkbox` | `select` - alles andere wird als Text behandelt. */
  type?: string;
  required?: boolean;
  default?: string | number | boolean;
  help?: string;
  options?: { value: string | number; label: string }[];
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
export type TuerId = 'katalog' | 'vorlage' | 'selbstbau';

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
  ];
}

/** Die Vorlagen einer Tür. */
export function templatesFuerTuer(
  templates: ComponentTemplate[],
  tuer: TuerId,
): ComponentTemplate[] {
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
  }[];
};

export type TestErgebnis = {
  zustand: 'bestanden' | 'fehlgeschlagen';
  text: string;
  messwerte: TestMesswert[];
};

export function testErgebnis(antwort: ProbeAntwort | null | undefined): TestErgebnis {
  if (!antwort) {
    return { zustand: 'fehlgeschlagen', text: testFehlerText(null, null), messwerte: [] };
  }
  if (antwort.errorCode) {
    return {
      zustand: 'fehlgeschlagen',
      text: testFehlerText(antwort.errorCode, antwort.message),
      messwerte: [],
    };
  }
  const line = antwort.results?.[0];
  if (!line || !line.ok) {
    return {
      zustand: 'fehlgeschlagen',
      text: testFehlerText(line?.errorCode, line?.message ?? antwort.message),
      messwerte: [],
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
): PruefZeile[] {
  const rows: PruefZeile[] = [
    { label: 'Name', wert: name.trim() === '' ? template.modelLabel : name.trim() },
    { label: 'Gerät', wert: `${template.brandLabel} ${template.modelLabel}` },
    { label: 'Art', wert: ROLLEN.find((r) => r.id === rolle)?.label ?? rolle },
    { label: 'Verbindung', wert: template.communicationLabel },
  ];
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
export const ABSCHLUSS_HINWEIS =
  'Gespeichert. Ihre VoltPilot-Box übernimmt die Änderung, sobald sie das nächste Mal ' +
  'verbunden ist - der Stand steht an der Komponente.';

/**
 * Die Soll/Ist-Zeile je Komponente („Läuft auf dem Gerät · Fassung 3" /
 * „Änderung unterwegs" / ehrlich unbekannt).
 *
 * `unreported` heißt UNBEKANNT, nie „nicht angekommen": eine ältere Box meldet
 * ihren Anwende-Stand gar nicht, und daraus einen Fehler zu machen wäre eine
 * Behauptung über ein Gerät, das nichts gesagt hat.
 */
export function sollIstText(
  syncStatus: string | null | undefined,
  definitionVersion: number,
): string {
  switch (syncStatus) {
    case 'in_sync':
      return `Läuft auf dem Gerät · Fassung ${definitionVersion}`;
    case 'pending':
      return 'Änderung unterwegs zur Box';
    default:
      return 'Stand auf dem Gerät unbekannt';
  }
}

/** Der Ton der Soll/Ist-Zeile: ok · unterwegs · unbekannt. */
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
