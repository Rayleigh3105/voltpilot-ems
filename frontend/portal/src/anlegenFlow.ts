/**
 * Der NEUE ANLEGE-FLUSS, als REINE Ableitung (Anlegen-Rework Stufe 2, Konzept
 * `data/vp-anlegen-rework/konzept.md`, Captain-Entscheidungen 22.08.2026).
 *
 * Der behobene Befund ist der EINSTIEG, nicht die Semantik: bis hierher fragte
 * der Assistent zuerst nach der HERKUNFT der Vorlage („Katalog" | „Geprüfte
 * Vorlage" | „Eigenes Gerät" | „Ladesäule") - eine Auskunft, die ein Kunde über
 * sein Gerät gar nicht hat. Gefragt wird jetzt nach dem GERÄTETYP, und den
 * trägt seit Stufe 1 der Katalog selbst (`ComponentTemplate.deviceType`).
 *
 * Diese Datei rechnet und formuliert; sie rendert nichts und ruft nichts ab -
 * dasselbe Muster wie `komponentenAssistent.ts`, `selbstbau.ts` und
 * `ladesaeuleAnbinden.ts`, aus denen sie ihre Bausteine bezieht.
 *
 * ⚠ **Die Anlege-SEMANTIK ist unverändert.** Es entstehen dieselben Aufrufe mit
 * denselben Rümpfen (`testComponentConnection` → `matchComponent` →
 * `createComponent` bzw. `readCustomComponent` → `createCustomComponent`), und
 * die Übernahme-Entscheidung fällt weiterhin allein auf dem Server. Neu ist die
 * REIHENFOLGE der Fragen und die Fläche, auf der sie gestellt werden.
 *
 * WORTSCHATZ: Set A („Komponente", „Gerät", „Messwert").
 */

import type { SiteComponentRow } from './api';
import { kundenRolle } from './geraeteEdit';
import {
  ROLLEN,
  rolleVerfuegbar,
  type ComponentTemplate,
  type KomponentenRolle,
} from './komponentenAssistent';

/**
 * Die ART eines Anlege-Wegs. Seit dem Gerätekatalog (Konzept „Aufbau und
 * Gerätekatalog") ergibt sie sich aus dem gewählten Modell (`typFuerTemplate`)
 * oder aus dem gewählten Weg ohne Vorlage (Ladesäule, Modbus-Gerät).
 */
export type TypId =
  | 'wechselrichter'
  | 'wallbox'
  | 'ladesaeule'
  | 'verbraucher'
  | 'zaehler'
  | 'eigenbau';

/**
 * Die Gerätetyp-Dimension des Katalogs, auf die eine Art hört.
 *
 * ⚠ `ladesaeule` und `eigenbau` haben KEINE: die erste erklärt nur den Weg
 * (die Säule wählt VoltPilot selbst an), die zweite beschreibt das Gerät
 * selbst. Eine Vorlagen-Auswahl an ihnen wäre ein Formular ohne Wirkung.
 */
const TYP_DEVICE_TYPES: Record<TypId, string[]> = {
  wechselrichter: ['inverter'],
  wallbox: ['wallbox'],
  // Ein I/O-Modul (Ebyte M31) ist EIN Gerät mit N Ausgängen; seine Ausgänge
  // werden danach einzeln Verbrauchern zugeordnet - der Weg beginnt deshalb
  // bei derselben Art wie ein Schaltaktor.
  verbraucher: ['switch', 'io_module'],
  zaehler: ['meter'],
  ladesaeule: [],
  eigenbau: [],
};

/** Der Gerätetyp einer bestehenden Vorlage für den Wiedereinstieg in denselben Assistenten. */
export function typFuerTemplate(template: ComponentTemplate | null): TypId {
  switch (template?.deviceType) {
    case 'wallbox':
      return 'wallbox';
    case 'switch':
    case 'io_module':
      return 'verbraucher';
    case 'meter':
      return 'zaehler';
    default:
      return 'wechselrichter';
  }
}

/** Die Rollen, die ein Typ in der Anlage einnehmen kann. */
const TYP_ROLLEN: Record<TypId, KomponentenRolle[]> = {
  // Ein Wechselrichter kann das Herz der Anlage ODER ein weiterer Erzeuger
  // sein - die EINZIGE Art mit einer echten Rest-Frage.
  wechselrichter: ['inverter', 'pv-generation'],
  wallbox: ['consumer'],
  verbraucher: ['consumer'],
  zaehler: ['grid-meter'],
  ladesaeule: [],
  eigenbau: [],
};

/**
 * Ein ECHTER Zähler - eine Vorlage mit `deviceType: meter`, seit 06.11.2026 der
 * Shelly Pro 3EM - hat zwei Aufgaben: am Hausanschluss den Netz-Zähler oder in
 * einer Unterverteilung einen Unterzähler. Die Box liest den Unterzähler als
 * Verbraucher-Quelle (`consumer`), sein Wert geht nie in den Netzwert. Ein Gerät,
 * über das nur gemessen wird (ein Wechselrichter mit Zähler am Netzpunkt), bleibt
 * Netz-Zähler: als Unterzähler könnte die Box ihm keine Rolle zuordnen.
 */
const ZAEHLER_ROLLEN: KomponentenRolle[] = ['grid-meter', 'consumer'];

/** Die Kundenworte der Verbraucher-Rolle eines Zählers (Glossar: Unterzähler). */
export const UNTERZAEHLER_ROLLE = {
  label: 'Unterzähler',
  hint: 'Misst einen Teil der Anlage, zum Beispiel eine Unterverteilung oder eine Halle. Er zählt nicht als Netz-Zähler.',
} as const;

function rollenFuer(typ: TypId, deviceType?: string | null): KomponentenRolle[] {
  if (typ === 'zaehler' && (deviceType ?? '').trim() === 'meter') return ZAEHLER_ROLLEN;
  return TYP_ROLLEN[typ];
}

/**
 * Der Satz zu einer Art, hinter der KEINE eigene Vorlage steht.
 *
 * ⚠ Er ist kein Schmuck, er ist die Ehrlichkeits-Hälfte der Erweiterung: der
 * Katalog zeigt dann die VOLLE Geräteliste (unter „Zähler" etwa), und der Kunde
 * muss wissen, warum dort Wechselrichter stehen, obwohl er einen Zähler sucht.
 */
export function keineVorlageHinweis(typ: TypId): string {
  switch (typ) {
    case 'zaehler':
      return 'Für Zähler gibt es noch keine eigene Vorlage. Wählen Sie das Gerät, über das '
        + 'gemessen wird - VoltPilot ordnet es als Netz-Zähler ein.';
    case 'wallbox':
      return 'Für Wallboxen gibt es noch keine eigene Vorlage. Wählen Sie das Gerät, über das '
        + 'gelesen wird.';
    case 'verbraucher':
      return 'Für schaltbare Verbraucher gibt es noch keine eigene Vorlage. Wählen Sie das '
        + 'Gerät, über das gelesen wird.';
    default:
      return 'Für diesen Gerätetyp gibt es noch keine eigene Vorlage. Wählen Sie das Gerät, '
        + 'über das gelesen wird.';
  }
}

/**
 * Die Vorlagen einer Art (die Modellwahl beim Bearbeiten auf der Geräteseite).
 *
 * ⚠ **Der Typ ist ein FILTER, kein Zaun - und wo er nichts findet, WEITET er
 * sich sichtbar.** Das ist die Kompatibilitäts-Hälfte des Umbaus: der alte
 * Assistent ließ jede Vorlage mit jeder Rolle zu (ein SunSpec-Gerät als
 * Netz-Zähler war der übliche Weg), und der Katalog kennt bis heute keine
 * einzige `meter`-Vorlage. Ein strenger Filter hätte diesen Weg ersatzlos
 * gestrichen - eine Verhaltensänderung, die dieses Stufe ausdrücklich nicht
 * machen darf. `erweitert: true` sagt der Fläche, dass sie den Grund NENNEN
 * muss ({@link keineVorlageHinweis}).
 *
 * ⚠ Eine Vorlage OHNE `deviceType` (`null`/absent - „die Vorlage sagt es
 * nicht", der ältere Backend-Stand, eine von Hand eingetragene geprüfte
 * Vorlage) passt zu JEDER Art. Sie zu verstecken hieße, aus „unbekannt" ein
 * „gehört hier nicht hin" zu machen.
 */
export function geraeteFuerTyp(
  templates: ComponentTemplate[],
  typ: TypId,
): { templates: ComponentTemplate[]; erweitert: boolean } {
  if (TYP_DEVICE_TYPES[typ].length === 0) return { templates: [], erweitert: false };
  const passend = templates.filter((t) => {
    const dt = (t.deviceType ?? '').trim();
    if (dt === '') return true;
    return TYP_DEVICE_TYPES[typ].includes(dt);
  });
  // Trifft der Filter etwas Eigenes (nicht nur Unklassifiziertes), gilt er.
  const eigen = passend.some((t) => TYP_DEVICE_TYPES[typ].includes((t.deviceType ?? '').trim()));
  if (eigen) return { templates: passend, erweitert: false };
  return { templates, erweitert: templates.length > 0 };
}

export type RollenWahl = {
  rolle: KomponentenRolle;
  label: string;
  hint: string;
  verfuegbar: boolean;
  /** Warum nicht - nie ein deaktivierter Knopf ohne Grund. */
  grund: string | null;
};

/**
 * Die Rest-Frage einer Art: welche Rolle das Gerät in der Anlage spielt.
 *
 * Sie hat GENAU EINE echte Ausprägung - der Wechselrichter, der auch ein
 * weiterer Erzeuger sein kann. Jede andere Art beantwortet sie selbst; dann
 * ist die Liste einelementig und die Fläche stellt keine Frage.
 */
export function rollenWahl(
  typ: TypId,
  vorhandeneRollen: string[],
  namen: Partial<Record<KomponentenRolle, string | null>> = {},
  /** Der Gerätetyp der gewählten Vorlage: nur ein echter Zähler (`meter`) kann auch Unterzähler sein. */
  deviceType?: string | null,
): RollenWahl[] {
  return rollenFuer(typ, deviceType).map((rolle) => {
    const def = typ === 'zaehler' && rolle === 'consumer' ? UNTERZAEHLER_ROLLE : ROLLEN.find((r) => r.id === rolle);
    const status = rolleVerfuegbar(rolle, vorhandeneRollen, namen);
    return {
      rolle,
      label: def?.label ?? rolle,
      hint: def?.hint ?? '',
      verfuegbar: status.ok,
      grund: status.ok ? null : status.grund,
    };
  });
}

/** Die Geräte, die eine Anlage SCHON HAT - als Rollen-Liste für {@link rollenWahl}, mit ihren Namen. */
export type VorhandeneGeraete = {
  rollen: string[];
  namen: Partial<Record<KomponentenRolle, string | null>>;
};

/**
 * Was die Anlage schon hat, aus den Zeilen von `GET …/components` - in den Rollen des Assistenten.
 *
 * ⚠ Eine Zeile zählt nur MIT Anbindung. Die Plattform komponiert Zeilen OHNE Anbindung (Netz und
 * Haus beim Verbinden der Box, den Speicher aus seinen Eckdaten); der Server füllt sie beim
 * Speichern, statt eine zweite anzulegen. Zählten sie hier, sperrte die Fläche den Netz-Zähler
 * auf jeder Anlage mit Box und schlüge auf einer Anlage mit komponiertem, aber nie eingerichtetem
 * Speicher „Weiterer Erzeuger“ vor - als hätte sie schon einen Hauptwechselrichter. Die Rollen
 * der Zeilen sind das v1-Vokabular (`battery-hybrid`), die Fläche fragt in ihrem eigenen
 * (`kundenRolle`).
 */
export function vorhandeneGeraete(
  zeilen: readonly SiteComponentRow[],
  /** Die Zeile, die gerade bearbeitet wird - sie zählt nicht als „schon da“. */
  ausser?: string | null,
): VorhandeneGeraete {
  const rollen: string[] = [];
  const namen: VorhandeneGeraete['namen'] = {};
  for (const zeile of zeilen) {
    if (zeile.id === ausser) continue;
    const conn = zeile.connection;
    const angebunden = conn != null && typeof conn === 'object' && Object.keys(conn).length > 0;
    if (!angebunden) continue;
    const rolle = kundenRolle(zeile);
    rollen.push(rolle);
    if (namen[rolle] === undefined) namen[rolle] = zeile.label?.trim() || null;
  }
  return { rollen, namen };
}

/**
 * Die VORGESCHLAGENE Rolle einer Art - ein Vorschlag, nie eine Entscheidung.
 *
 * ⚠ Sie fällt NICHT auf eine unverfügbare Rolle zurück. Hat die Anlage schon einen
 * angebundenen Wechselrichter, ist die Rolle gesperrt (der Server lehnte einen zweiten
 * beim Speichern ab) und der weitere Erzeuger ist die Antwort; eine nur komponierte,
 * nie eingerichtete Zeile zählt dafür nicht ({@link vorhandeneGeraete}).
 */
export function vorschlagRolle(
  typ: TypId,
  vorhandeneRollen: string[],
  /**
   * Ein elektrischer Slot kann die Restfrage bereits beantwortet haben. Die
   * Rolle wird nur übernommen, wenn sie zu diesem Typ gehört und verfügbar
   * ist; ein fremder/gesperrter Wert fällt auf dieselbe ehrliche Ableitung wie
   * der globale Einstieg zurück.
   */
  bevorzugt?: KomponentenRolle | null,
  /** Der Gerätetyp der gewählten Vorlage ({@link rollenWahl}). */
  deviceType?: string | null,
): KomponentenRolle | null {
  const wahl = rollenWahl(typ, vorhandeneRollen, {}, deviceType);
  const frei = wahl.filter((w) => w.verfuegbar);
  if (frei.length === 0) return null;
  const ortsgebunden = frei.find((w) => w.rolle === bevorzugt);
  if (ortsgebunden) return ortsgebunden.rolle;
  if (frei.length === 1) return frei[0].rolle;
  // Der Wechselrichter-Fall: hat die Anlage schon einen, meint der Kunde
  // fast immer einen WEITEREN Erzeuger.
  const hatWechselrichter = vorhandeneRollen.some((r) => r === 'inverter');
  const zweit = frei.find((w) => w.rolle === 'pv-generation');
  if (hatWechselrichter && zweit) return zweit.rolle;
  return frei[0].rolle;
}

/**
 * Wie lange die Eingabe ruhen muss, bevor der Verbindungstest (bzw. das Lesen
 * eines Messwerts, die Vorschau einer Batterie) von selbst läuft. Wer das Feld
 * verlässt, wartet nicht.
 */
export const AUTO_TEST_MS = 800;

/** „Schritt 2 von 4" - die Fortschritts-Zeile der Vollbild-Fassung am Telefon. */
export function fortschritt(schrittListe: string[], aktiv: number): string {
  // Hinter dem letzten Schritt steht das Ergebnis, kein weiterer Schritt.
  if (schrittListe.length > 0 && aktiv > schrittListe.length) return 'Fertig';
  const n = Math.min(Math.max(aktiv, 1), schrittListe.length);
  return `Schritt ${n} von ${schrittListe.length}`;
}

/** Der Anteil (0..1) für den Fortschrittsbalken am Telefon. */
export function fortschrittAnteil(schrittListe: string[], aktiv: number): number {
  if (schrittListe.length === 0) return 0;
  const n = Math.min(Math.max(aktiv, 1), schrittListe.length);
  return n / schrittListe.length;
}

/**
 * Welche Verbindungsfelder unter „Erweitert" verschwinden.
 *
 * Pflichtfelder stehen IMMER oben - ohne sie geht kein Test. Alles Übrige
 * (Port, Slave-ID, Vorzeichen, Skalierung) sind Experten-Angaben mit einer
 * brauchbaren Vorgabe; sie unaufgefordert zu zeigen macht aus einer Frage
 * („wo steht das Gerät?") ein Formular.
 *
 * ⚠ Es ist eine reine ANORDNUNG, kein Filter: jedes Feld bleibt erreichbar und
 * wird unverändert mitgeschickt. Und der Aufklapper muss OFFEN sein, sobald ein
 * Hebel auf ein Feld darin zeigt - sonst springt der Klick ins Unsichtbare.
 */
export function feldGruppen<T extends { required?: boolean }>(
  felderListe: T[],
): { pflicht: T[]; erweitert: T[] } {
  return {
    pflicht: felderListe.filter((f) => f.required === true),
    erweitert: felderListe.filter((f) => f.required !== true),
  };
}

/**
 * Die Komponente, die gerade entstanden ist - der Aufbau springt nach dem
 * Speichern auf sie.
 *
 * ⚠ Sie wird BELEGT bestimmt, nie geraten: bei einer Übernahme ist es die
 * übernommene Zeile, sonst die EINE Id, die vorher noch nicht da war. Sind es
 * mehrere oder keine (ein Nebenlauf, ein älterer Server), gibt es `null` - die
 * Fläche verlinkt dann auf die Liste statt auf eine erfundene Komponente.
 */
export function neueKomponente(
  vorher: { id: string }[],
  nachher: { id: string }[],
  uebernahmeId?: string | null,
): string | null {
  if (uebernahmeId && uebernahmeId.trim()) return uebernahmeId.trim();
  const alt = new Set(vorher.map((r) => r.id));
  const neu = nachher.filter((r) => !alt.has(r.id)).map((r) => r.id);
  return neu.length === 1 ? neu[0] : null;
}

/** Der Satz nach dem Speichern (Aufbau) - Übernahme und Neuanlage sind zwei Sätze. */
export function abschlussTitel(name: string, uebernommen: boolean): string {
  const wer = name.trim() || 'Die Komponente';
  return uebernommen ? `„${wer}" ist wieder verbunden.` : `„${wer}" ist angelegt.`;
}
