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

import type { IconName } from '../designsystem/components/core/Icon';
import {
  ROLLEN,
  rolleVerfuegbar,
  type ComponentTemplate,
  type KomponentenRolle,
} from './komponentenAssistent';

/** Die sechs Typ-Karten aus Schritt 1 („Was möchten Sie anbinden?"). */
export type TypId =
  | 'wechselrichter'
  | 'wallbox'
  | 'ladesaeule'
  | 'verbraucher'
  | 'zaehler'
  | 'eigenbau';

/**
 * Die Gerätetyp-Dimension des Katalogs, auf die eine Karte hört.
 *
 * ⚠ `ladesaeule` und `eigenbau` haben KEINE: die eine erklärt nur den Weg (die
 * Säule wählt VoltPilot selbst an), die andere beschreibt das Gerät selbst.
 * Eine Vorlagen-Auswahl an ihnen wäre ein Formular ohne Wirkung.
 */
const TYP_DEVICE_TYPES: Record<TypId, string[]> = {
  wechselrichter: ['inverter'],
  wallbox: ['wallbox'],
  verbraucher: ['switch'],
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
  // sein - die EINZIGE Karte mit einer echten Rest-Frage.
  wechselrichter: ['inverter', 'pv-generation'],
  wallbox: ['consumer'],
  verbraucher: ['consumer'],
  zaehler: ['grid-meter'],
  ladesaeule: [],
  eigenbau: [],
};

export type TypKarte = {
  id: TypId;
  label: string;
  hint: string;
  /** Der Icon-Name des Designsystems - die Karte trägt ein Bild, nicht nur Text. */
  icon: IconName;
  /** Wie viele Katalog-Geräte hinter dieser Karte stehen (0 = keine eigene Vorlage). */
  treffer: number;
  /**
   * Der ehrliche Satz, wenn es für diesen Typ (noch) keine eigene Vorlage gibt.
   * `null` = es gibt welche, die Karte braucht keine Erklärung.
   */
  hinweis: string | null;
};

const KARTEN: Omit<TypKarte, 'treffer' | 'hinweis'>[] = [
  {
    id: 'wechselrichter',
    label: 'Wechselrichter',
    hint: 'Das Herz Ihrer Anlage - erzeugt Solarstrom und lädt Ihren Speicher.',
    icon: 'zap',
  },
  {
    id: 'wallbox',
    label: 'Wallbox',
    hint: 'Ihre eigene Ladestation zu Hause - VoltPilot steuert, wann sie lädt.',
    icon: 'battery-charging',
  },
  {
    id: 'ladesaeule',
    label: 'Ladesäule (OCPP)',
    hint: 'Eine Säule, die VoltPilot selbst anwählt - so tragen Sie sie ein.',
    icon: 'link',
  },
  {
    id: 'verbraucher',
    label: 'Schaltbarer Verbraucher',
    hint: 'Heizstab, Pumpe, Wärmepumpe - alles, was sich ein- und ausschalten lässt.',
    icon: 'sliders',
  },
  {
    id: 'zaehler',
    label: 'Zähler',
    hint: 'Misst am Hausanschluss, was Sie beziehen und einspeisen.',
    icon: 'activity',
  },
  {
    id: 'eigenbau',
    label: 'Eigenbau (Modbus)',
    hint: 'Ein Gerät selbst beschreiben: Adresse, Register, Messwerte - mit Live-Vorschau.',
    icon: 'cpu',
  },
];

/**
 * Der Satz an einer Karte, hinter der KEINE eigene Vorlage steht.
 *
 * ⚠ Er ist kein Schmuck, er ist die Ehrlichkeits-Hälfte der Erweiterung: die
 * Karte führt dann in die VOLLE Geräteliste, und der Kunde muss wissen, warum
 * dort Wechselrichter stehen, obwohl er einen Zähler sucht.
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
 * Die Vorlagen hinter einer Typ-Karte.
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
 * Vorlage) passt zu JEDER Karte. Sie zu verstecken hieße, aus „unbekannt" ein
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

/** Die sechs Karten, mit ihrer Trefferzahl und ihrem ehrlichen Satz. */
export function typKarten(templates: ComponentTemplate[]): TypKarte[] {
  return KARTEN.map((k) => {
    const { erweitert } = geraeteFuerTyp(templates, k.id);
    const eigene = templates.filter((t) =>
      TYP_DEVICE_TYPES[k.id].includes((t.deviceType ?? '').trim()),
    ).length;
    return {
      ...k,
      treffer: eigene,
      hinweis: erweitert ? keineVorlageHinweis(k.id) : null,
    };
  });
}

/** Legt diese Karte überhaupt eine Komponente an? (Die Ladesäule tut es nicht.) */
export function legtAn(typ: TypId): boolean {
  return typ !== 'ladesaeule';
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
 * Die Rest-Frage einer Typ-Karte: welche Rolle das Gerät in der Anlage spielt.
 *
 * Sie hat GENAU EINE echte Ausprägung - der Wechselrichter, der auch ein
 * weiterer Erzeuger sein kann. Jede andere Karte beantwortet sie selbst; dann
 * ist die Liste einelementig und die Fläche stellt keine Frage.
 */
export function rollenWahl(typ: TypId, vorhandeneRollen: string[]): RollenWahl[] {
  return TYP_ROLLEN[typ].map((rolle) => {
    const def = ROLLEN.find((r) => r.id === rolle);
    const status = rolleVerfuegbar(rolle, vorhandeneRollen);
    return {
      rolle,
      label: def?.label ?? rolle,
      hint: def?.hint ?? '',
      verfuegbar: status.ok,
      grund: status.ok ? null : status.grund,
    };
  });
}

/**
 * Die VORGESCHLAGENE Rolle einer Karte - ein Vorschlag, nie eine Entscheidung.
 *
 * ⚠ Sie fällt NICHT auf eine unverfügbare Rolle zurück und blockiert
 * umgekehrt auch nichts: eine Anlage, deren Wechselrichter-Zeile von der
 * Plattform komponiert wurde, darf sehr wohl noch einen Wechselrichter
 * bekommen (der Server übernimmt die Zeile dann). Genau deshalb bleibt die
 * zweite Möglichkeit sichtbar und wählbar.
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
): KomponentenRolle | null {
  const wahl = rollenWahl(typ, vorhandeneRollen);
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
 * Die Schritt-Leiste - sie hängt am TYP, weil die Wege verschiedene Fragen
 * stellen. (Dasselbe Prinzip wie zuvor die Umbenennung von Schritt 2 in der
 * Selbstbau-Tür, nur konsequent zu Ende gedacht.)
 */
export function schritte(typ: TypId | null): string[] {
  if (typ === 'eigenbau') {
    return ['Was anbinden', 'Adresse', 'Messwerte', 'Was ist es?', 'Prüfen', 'Fertig'];
  }
  if (typ === 'ladesaeule') return ['Was anbinden', 'Anbinden'];
  return ['Was anbinden', 'Gerät wählen', 'Verbinden', 'Testen', 'Fertig'];
}

/** „Schritt 2 von 5" - die Fortschritts-Zeile der Vollbild-Fassung am Telefon. */
export function fortschritt(schrittListe: string[], aktiv: number): string {
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
 * Die Komponente, die gerade entstanden ist - für den Absprung im Schritt
 * „Fertig".
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

/** Die Überschrift des Schritts „Fertig" - Übernahme und Neuanlage sind zwei Sätze. */
export function abschlussTitel(name: string, uebernommen: boolean): string {
  const wer = name.trim() || 'Die Komponente';
  return uebernommen ? `„${wer}" ist wieder verbunden.` : `„${wer}" ist angelegt.`;
}

/**
 * Der Absprung aus dem Schritt „Fertig".
 *
 * ⚠ Er führt auf die KOMPONENTE in ihrer Geräte-Karte, nicht direkt auf die
 * Geräteseite - das ist die Haus-Regel des Drill-ins (Anlagen-Zentrale Stufe 3):
 * von der Zeile führt der Kartenkopf mit „Geräteseite ›" weiter, und dort
 * hängen die Handlungen. Ohne belegte Komponente gibt es keinen Absprung,
 * sondern nur „Schließen".
 */
export const ABSPRUNG_LABEL = 'Zur Komponente';

/** Der Knopf, der einen zweiten Durchlauf startet, ohne den Dialog zu schließen. */
export const WEITERES_LABEL = 'Weiteres Gerät anbinden';

/** Die Überschrift des Dialogs - sie sagt, was hier passiert. */
export const DIALOG_TITEL = 'Gerät anbinden';
