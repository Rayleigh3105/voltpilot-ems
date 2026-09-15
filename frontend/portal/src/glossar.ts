/**
 * Das Wörterbuch der Einstellungs-Seite und ihre Suche (E6) — rein, ohne React.
 *
 * Zwei Aufgaben, eine Quelle:
 *  1. **Die Suche** (Report §7 P9, Befund B10): ~25 Einstellungen auf einer
 *     Seite ohne Suchfeld sind unauffindbar — „Wo stelle ich meinen Strompreis
 *     ein?" war bis hier auch für den Support unbeantwortbar. Gesucht wird über
 *     Label **und Synonym**, damit „Strompreis", „Arbeitspreis", „ct/kWh" oder
 *     „Börsenpreis" alle beim Stromtarif landen.
 *  2. **Die Umbenennungen** (Captain-Entscheid D6, Wortquelle: Begriffs-Audit
 *     `data/vp-energiemarkt-x9/report.md` Teil 3, Zeilen 2/5/6). Sie stehen hier
 *     als Konstanten, damit die drei Flächen, die dasselbe Feld aufnehmen
 *     (Einstellungs-Seite, Anlege-Assistent, Admin-Anlegen-Drawer), nie
 *     auseinanderlaufen.
 *
 * Das ist das **Zwei-Register-Modell** des Audits: Register A ist der
 * marktkorrekte Begriff (`term`), Register B die Kundenformulierung (`kunde`) —
 * und jede Kundenformulierung ist die Übersetzung genau EINES Begriffs aus A.
 * Die Suche kennt beide Register plus die Wörter, unter denen jemand tatsächlich
 * sucht (auch die ALTEN — wer „Anlagentyp" tippt, muss die Veräußerungsform
 * finden, sonst wäre die Umbenennung eine Sackgasse).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **Eine bewusste Abweichung von D6, damit die Fläche nicht falsch wird.**
 * Der Audit (Teil 3, Zeile 5) nennt „Aufschlag auf den Börsenpreis" und
 * „Vertriebsaufschlag" „dieselbe Größe". Das stimmt im Code NICHT, und E2 hat
 * es beim Bauen belegt: der Aufschlag der Tarifart „Dynamisch" ist der
 * SAMMEL-Aufschlag (Netzentgelte + Abgaben + Marge zusammen — er ERSETZT
 * serverseitig das ganze Preisblatt, `pricing.py import_prices`), der
 * `vertriebsaufschlagCt` des Preisblatts ist nur die MARGE (typisch 1–3 ct).
 * Beide tragen denselben Namen zu geben, hieße zwei verschiedene Größen in
 * derselben Maske gleich zu benennen — der Selbstwiderspruch, den die
 * Umbenennung beenden soll, nur schlimmer. Umgesetzt ist deshalb die ABSICHT:
 * der Sammelaufschlag heißt jetzt ausdrücklich „gesamt", das Preisblatt behält
 * „Vertriebsaufschlag", und die Suche führt beide Wörter zusammen. Ein
 * anderslautender Entscheid ist eine Zeile in `tariffInput.TARIF_PARAM_FIELDS`.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { SettingsGroupId } from './settingsNav';

// ---------------------------------------------------------------------------
// 1 · D6 — die Umbenennungen dieser Fläche
// ---------------------------------------------------------------------------

/**
 * „Anlagentyp" → **„Veräußerungsform"** (Audit Zeile 2, DRINGEND). Das Feld ist
 * kein Technik-Fakt, sondern der Vertragsfakt nach § 21b EEG — und genau der
 * Hebel, an dem die alte Sackgasse zum Missbrauch einlud („erklär dich zur
 * Direktvermarktungs-Anlage, um an ein Preisfeld zu kommen").
 */
export const VERAEUSSERUNGSFORM_LABEL = 'Veräußerungsform';

/** Die Kundenformulierung (Register B) — sie steht als Unterzeile am Feld. */
export const VERAEUSSERUNGSFORM_FRAGE = 'Wie wird Ihr Strom vergütet?';

/** Der InfoTip, der den kanonischen Begriff einmal erreichbar macht. */
export const VERAEUSSERUNGSFORM_TIP =
  'Die Veräußerungsform nach § 21b EEG: Bekommen Sie für Ihren eingespeisten Strom die feste ' +
  'Einspeisevergütung, oder vermarkten Sie ihn direkt am Markt? Danach richtet sich, wie ' +
  'VoltPilot Ihre Einspeisung bewertet.';

/** Die Gruppen-Überschriften, damit die Suche auch „Speicher" findet. */
export const GROUP_LABEL: Record<SettingsGroupId, string> = {
  anlage: 'Meine Anlage',
  geld: 'Strompreis & Vergütung',
  geraet: 'Mein Gerät',
  speicher: 'Mein Speicher',
  registrierung: 'Registrierung',
  app: 'Als App auf dem Handy',
  loeschen: 'Anlage löschen',
};

// ---------------------------------------------------------------------------
// 2 · UEMS — die Kundenwörter des Unternehmens-Energiemanagements (AP-00 IP-4)
// ---------------------------------------------------------------------------

/**
 * Die WORTQUELLE ist `docs/fachmodell/glossar.md` (PR 649) — dort steht je
 * Begriff die Definition, das Beispiel des Referenzunternehmens und der Stand
 * im Code. Hier stehen die Wörter nur als Konstanten, damit die Flächen, die
 * das UEMS Stück für Stück baut (Ortsbaum, Messstellen, Rechte, Boxen), NIE
 * auseinanderlaufen — dasselbe Motiv wie bei den D6-Umbenennungen darüber.
 *
 * ⚠ Der Wächter dazu ist `copy.test.ts`: er verbietet die INTERNEN Wörter
 * (Tenant, Site, Entity, Device, Channel, Slot …) in Kundentexten. Diese Datei
 * ist die andere Hälfte — sie sagt, was stattdessen dasteht.
 *
 * Neue Wörter kommen zuerst ins Fachmodell-Glossar, dann hierher; nie
 * umgekehrt (Pflegeregel: `docs/fachmodell/README.md`).
 */

/** Die Wurzel des Ortsbaums — das, worüber der Kunde berichtet. */
export const UEMS_UNTERNEHMEN = 'Unternehmen';

/** Ein räumlich abgegrenzter Ort des Unternehmens mit Adresse. */
export const UEMS_STANDORT = 'Standort';

/** Die Koordinaten-Zeile der Anlage, wenn neben ihr das Objekt „Standort“ steht (AP-02 W4). */
export const UEMS_STANDORT_AUF_DER_KARTE = 'Standort auf der Karte';

/** Die optionale zweite Ebene des Ortsbaums. */
export const UEMS_GEBAEUDE = 'Gebäude';

/** Die dritte, optionale Ebene (Halle Nord, Etage, Technikraum). */
export const UEMS_BEREICH = 'Bereich';

/** Der Übergabepunkt zum öffentlichen Netz. */
export const UEMS_NETZANSCHLUSS = 'Netzanschluss';

/** Alles, was hinter einem Netzanschluss elektrisch zusammenhängt. */
export const UEMS_ELEKTRISCHES_SYSTEM = 'elektrisches System';

/** Die fachliche Identität einer Messung — sie überlebt Gerät, Kanal und Box. */
export const UEMS_MESSSTELLE = 'Messstelle';

/**
 * WOHER eine Messstelle ihre Werte hat: Gerät und Messwert, zeitgültig (AP-04
 * §4.3). Im Register „Quelle (führend)“, nie „Primärquelle“ oder
 * „Quellenbindung“ (das Vertragswort der Werkstatt) — `copy.test.ts` wacht.
 */
export const UEMS_QUELLE = 'Quelle';

/** Je Größe genau EINE Quelle ist führend: sie trägt Auswertung und Bericht (AP-04 E3). */
export const UEMS_FUEHREND = 'führend';

/**
 * Jede weitere Quelle derselben Größe ist ein Vergleich — gekennzeichnet mit
 * Zweck, beide Werte nebeneinander, ohne Bewertung und ohne Ersatz (AP-04 E3).
 * Im Satz als „Vergleichsquelle“, nie „Referenz-“ oder „Sekundärquelle“.
 */
export const UEMS_VERGLEICH = 'Vergleich';

/** WAS gemessen wird (Wirkenergie, Leistung, Volumen …). */
export const UEMS_MESSGROESSE = 'Messgröße';

/** WORIN gemessen wird (Strom, Gas, Wärme, Wasser, Druckluft). */
export const UEMS_MEDIUM = 'Medium';

/** Eine betriebliche Tätigkeit, die Energie einsetzt (Spritzguss, Logistik). */
export const UEMS_PROZESS = 'Prozess';

/** Die Verrechnungseinheit des Kunden (Nummer + Name). */
export const UEMS_KOSTENSTELLE = 'Kostenstelle';

/** Die nicht-energetische Größe, auf die Energie bezogen wird (AP-09). */
export const UEMS_BEZUGSGROESSE = 'Bezugsgröße';

/**
 * ⚠ Der Erfassungsweg — Adresse plus Protokoll. Das Glossar bindet dieses Wort
 * ausdrücklich an die EINRICHTUNGSFLÄCHEN: „‚Datenquelle‘ ist ein Fachwort für
 * Einrichtende, kein Wort der Auswertungsflächen." Eine Auswertung nennt
 * stattdessen die Messstelle oder die Komponente.
 */
export const UEMS_DATENQUELLE = 'Datenquelle';

/** Das physische Kästchen hinter der Box (Wechselrichter, Zähler, Säule). */
export const UEMS_GERAET = 'Gerät';

/** Das EMS-Objekt in einer Anlage, das misst und/oder gesteuert wird. */
export const UEMS_KOMPONENTE = 'Komponente';

/** Die Hardware beim Kunden — nie „Edge", nie „Device" (bestehendes Wort). */
export const UEMS_BOX = 'VoltPilot-Box';

/**
 * Hat eine Anlage mehrere Boxen, ist EINE davon die führende (AP-06 E3): sie
 * bildet die Anlagen-Summe und empfängt den Fahrplan. Ein gespeicherter,
 * sichtbarer Fakt — nie geraten.
 */
export const UEMS_FUEHRENDE_BOX = 'führende Box';

/**
 * Die zwei Zustandsfamilien (AP-01 E8, `docs/fachmodell/zustaende.md`): der
 * LEBENSZYKLUS, den der Kunde setzt, und die BEOBACHTUNG, die nie jemand von
 * Hand setzt. Die Wörter bedeuten bei JEDEM Objekt dasselbe.
 */
export const UEMS_LEBENSZYKLUS = [
  'Entwurf',
  'eingerichtet',
  'aktiv',
  'angehalten',
  'archiviert',
] as const;

/** Die beobachteten Zustände — abgeleitet, nie gesetzt (AP-01 E8). */
export const UEMS_BEOBACHTUNG = ['liefert Daten', 'steuert'] as const;

/**
 * Die Rollen (AP-03 E1): zwei unternehmensweite, drei je Standort und die
 * befristete Unterstützung.
 */
export const UEMS_ROLLEN_UNTERNEHMEN = ['Kundenadministrator', 'Energiemanager'] as const;

/** Die drei Rollen, die je Standort vergeben werden (AP-03 E1). */
export const UEMS_ROLLEN_STANDORT = ['Bearbeiter', 'Bedienberechtigt', 'Leser'] as const;

/** Die befristete Rolle (Installateur | VoltPilot) mit Pflicht-Enddatum. */
export const UEMS_ROLLE_UNTERSTUETZER = 'Unterstützer';

/** Die zwei Funktionen, die JE STANDORT gelten (AP-01 E6). */
export const UEMS_FUNKTION_MESSEN = 'Messen & Auswerten';

/** Die zweite Funktion — sie trägt Geld, Betriebsmodell und Steuerung. */
export const UEMS_FUNKTION_STEUERN = 'Steuern & Optimieren';

/** Das Kundenwort der Radiogruppe Betriebsmodell — nicht „Arbitrage" (AP-01 E11). */
export const UEMS_MARKTOPTIMIERUNG = 'Marktoptimierung';

/**
 * Eine Messstelle hat genau EINE Hauptgröße (identitätsstiftend, nie änderbar)
 * und 0..n Nebengrößen desselben Messortes (AP-04 E1). Nebengrößen tragen nie
 * Bilanz oder Bericht.
 */
export const UEMS_HAUPTGROESSE = 'Hauptgröße';

/** Die Geschwister der Hauptgröße — nie in Bilanz oder Bericht (AP-04 E1). */
export const UEMS_NEBENGROESSE = 'Nebengröße';

/** Die elektrische Stellung am Netzanschluss (AP-04 E12). */
export const UEMS_HAUPTZAEHLER = 'Hauptzähler';

/**
 * Die elektrische Stellung darunter — sie bezieht sich auf die übergeordnete
 * MESSSTELLE derselben Anlage, nicht auf eine Komponente (AP-04 E12). Der Satz
 * steht mit dem Namen der übergeordneten Messstelle: „Unterzähler von MS-01".
 */
export const UEMS_UNTERZAEHLER_VON = 'Unterzähler von';

/**
 * ⚠ Das EINE Kundenwort des berechneten Messwerts (Konzept `vp-helfer-konzept-h1`,
 * Captain-Rahmenentscheid): ein Wert, den der Kunde aus mehreren gemessenen
 * Werten als gewichtete Summe zusammenstellt. Im Datenmodell ist das eine
 * berechnete Messstelle (`art = berechnet`, Formel = AP-10) — aber der Kunde
 * liest davon nie ein Werkstatt-Wort. Diese Konstante ist die EINE Stelle, an
 * der das Wort steht; ein späterer Wortwechsel ist eine Zeile hier, kein Umbau.
 * Nie „Helfer" (interner Arbeitstitel) und nie „virtueller Messwert"
 * (Home-Assistant-Wort) in der Kundensicht.
 */
export const GESAMTWERT = 'Gesamtwert';

/**
 * UEMS AP-11 (E12 = A) — die Wörter der Kennzahl (`docs/fachmodell/glossar.md`
 * › Kennzahl, AP-11 §4.13). „Kennzahl" gehört NUR dem neuen Objekt;
 * „Berechnung" = Form und Eingänge, „Fassung" = ein datierter Stand der
 * Berechnung, „Version" = ein Stand des Werts einer Periode — nie vertauscht.
 * In der Kundensicht nie KPI, Metrik, Kenngröße, Template, Widget; auf einer
 * Kennzahl-Fläche nie Durchschnitt oder Mittel (`copy.test.ts`).
 */
export const UEMS_KENNZAHL = 'Kennzahl';
export const UEMS_KENNZAHLEN = 'Kennzahlen';
export const UEMS_BERECHNUNG = 'Berechnung';
export const UEMS_FASSUNG = 'Fassung';
export const UEMS_VERSION = 'Version';
export const UEMS_VORLAGE = 'Vorlage';

/** Die Rollen der Eingänge in der Kundensicht (Vertrag `zaehler`/`nenner`/`paar`) — nie Zähler und Nenner: ein Zähler ist ein Messgerät. */
export const UEMS_MENGE = 'Menge';
export const UEMS_TEIL = 'Teil';
export const UEMS_GANZES = 'Ganzes';

/** Die Rechenform in der Kundensicht (Vertrag `quotient`/`anteil`/`zusammenfassung`). */
export const UEMS_RECHENFORM: Record<'quotient' | 'anteil' | 'zusammenfassung', string> = {
  quotient: `${UEMS_MENGE} je ${UEMS_BEZUGSGROESSE}`,
  // Dativ von „Ganzes“ — das Wort der Rolle bleibt `UEMS_GANZES`.
  anteil: `${UEMS_TEIL} an Ganzem`,
  zusammenfassung: `${UEMS_KENNZAHLEN} zusammenfassen`,
};

/** Die drei Stammdaten einer Kennzahl — nie Scope, nie Owner. */
export const UEMS_GELTUNGSBEREICH = 'Geltungsbereich';
export const UEMS_VERANTWORTLICH = 'Verantwortlich';
export const UEMS_ZWECK = 'Zweck';

// ---------------------------------------------------------------------------
// 3 · Der Suchindex
// ---------------------------------------------------------------------------

export interface GlossarEntry {
  /** Stabile Id (Testanker, React-Key). */
  id: string;
  /** Wie die Zeile auf der Seite heißt. */
  label: string;
  /** In welcher Gruppe sie steht. */
  group: SettingsGroupId;
  /**
   * Der kanonische Marktbegriff (Register A), wenn er vom Label abweicht — er
   * wird am Treffer genannt, damit das Fachwort mindestens einmal erreichbar
   * ist (die Regel des Zwei-Register-Modells).
   */
  fachwort?: string;
  /** Wörter, unter denen jemand danach sucht (inkl. der alten Namen). */
  synonyms: string[];
}

/**
 * Der Index. Er bildet die Zeilen ab, die die Seite wirklich rendert — eine
 * Suche, die auf etwas Nichtvorhandenes zeigt, wäre schlimmer als keine.
 */
export const GLOSSAR: GlossarEntry[] = [
  {
    id: 'name',
    label: 'Name der Anlage',
    group: 'anlage',
    synonyms: ['name', 'bezeichnung', 'umbenennen', 'titel'],
  },
  {
    id: 'standort',
    label: 'Standort',
    group: 'anlage',
    synonyms: ['standort', 'adresse', 'karte', 'koordinaten', 'ort', 'wetter', 'gebotszone'],
  },
  {
    id: 'veraeusserungsform',
    label: VERAEUSSERUNGSFORM_LABEL,
    group: 'anlage',
    fachwort: 'Veräußerungsform (§ 21b EEG)',
    synonyms: [
      'veraeusserungsform',
      'anlagentyp',
      'verguetung',
      'einspeiseverguetung',
      'direktvermarktung',
      'eigenverbrauch',
      'wie wird mein strom verguetet',
    ],
  },
  {
    id: 'max-einspeisung',
    label: 'Maximale Einspeiseleistung',
    group: 'anlage',
    fachwort: 'Einspeisegrenze am Netzanschlusspunkt',
    synonyms: ['einspeisegrenze', 'einspeiseleistung', 'netzanschluss', 'kw', 'begrenzung', 'kappung'],
  },
  {
    id: 'stromtarif',
    label: 'Stromtarif',
    group: 'geld',
    fachwort: 'Arbeitspreis bzw. Bezugspreis',
    synonyms: [
      'stromtarif',
      'strompreis',
      'arbeitspreis',
      'bezugspreis',
      'tarif',
      'ct/kwh',
      'cent',
      'boersenpreis',
      'dynamisch',
      'fest',
      'aufschlag',
      'vertriebsaufschlag',
      'preisblatt',
      'netzentgelt',
      'stromsteuer',
      'umlagen',
      'konzessionsabgabe',
      'umsatzsteuer',
      'stromrechnung',
    ],
  },
  {
    id: 'anzulegender-wert',
    label: 'Anzulegender Wert',
    group: 'geld',
    fachwort: 'anzulegender Wert (gleitende Marktprämie)',
    synonyms: ['anzulegender wert', 'marktpraemie', 'eeg', 'verguetungssatz', 'direktvermarktung'],
  },
  {
    id: 'netzladen',
    label: 'Netzladen des Speichers',
    group: 'geld',
    fachwort: 'Ausschließlichkeitsprinzip (EEG)',
    synonyms: ['netzladen', 'solarladen', 'arbitrage', 'aus dem netz laden', 'eeg', 'ausschliesslichkeit'],
  },
  {
    id: 'leistungspreis',
    label: 'Leistungspreis',
    group: 'geld',
    fachwort: 'Leistungspreis (€/kW)',
    synonyms: ['leistungspreis', 'lastspitze', 'spitzenlast', 'abrechnungsperiode', 'rlm'],
  },
  {
    id: 'geraet',
    label: 'Mein Gerät',
    group: 'geraet',
    synonyms: ['geraet', 'wechselrichter', 'geraete-id', 'box', 'verbinden', 'hinzufuegen', 'entfernen'],
  },
  {
    id: 'box',
    label: 'Ihre VoltPilot-Box',
    group: 'geraet',
    synonyms: ['box', 'geraeteseite', '8484', 'zaehler', 'erzeuger', 'vorzeichen', 'freigabe', 'kalibrierung'],
  },
  {
    id: 'speicher',
    label: 'Kapazität · Lade-/Entladeleistung',
    group: 'speicher',
    synonyms: ['speicher', 'batterie', 'kapazitaet', 'kwh', 'ladeleistung', 'entladeleistung', 'wirkungsgrad'],
  },
  {
    id: 'speicherschonung',
    label: 'Umgang mit dem Speicher',
    group: 'speicher',
    fachwort: 'Verschleißkosten je bewegter kWh',
    synonyms: ['speicherschonung', 'schonend', 'ausgewogen', 'aggressiv', 'zyklen', 'lebensdauer', 'verschleiss'],
  },
  {
    id: 'lastspitzen-reserve',
    label: 'Lastspitzen-Reserve',
    group: 'speicher',
    synonyms: ['reserve', 'lastspitze', 'notstrom', 'ladestand', 'soc'],
  },
  {
    id: 'mastr',
    label: 'Marktstammdatenregister',
    group: 'registrierung',
    fachwort: 'Marktstammdatenregister (MaStR)',
    synonyms: ['mastr', 'marktstammdaten', 'register', 'see-nummer', 'registrierung', 'bnetza', 'kwp'],
  },
  {
    id: 'app',
    label: 'Als App auf dem Handy',
    group: 'app',
    synonyms: [
      'app',
      'installieren',
      'startbildschirm',
      'homescreen',
      'handy',
      'iphone',
      'android',
      'vollbild',
      'symbol',
      'verknuepfung',
    ],
  },
  {
    id: 'loeschen',
    label: 'Anlage löschen',
    group: 'loeschen',
    synonyms: ['loeschen', 'entfernen', 'kuendigen', 'daten loeschen', 'unumkehrbar'],
  },
];

/** Höchstens so viele Treffer — eine lange Liste ist keine Antwort. */
export const MAX_HITS = 6;

/**
 * Normalisiert für den Vergleich: Kleinbuchstaben, Umlaute/ß aufgelöst,
 * Satzzeichen zu Leerzeichen. So findet „Veräußerungsform" auch, wer
 * „veraeusserungsform" oder „Veraeusserungs-Form" tippt.
 */
export function normalizeTerm(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9/]+/g, ' ')
    .trim();
}

function haystack(entry: GlossarEntry): string {
  return normalizeTerm(
    [entry.label, entry.fachwort ?? '', GROUP_LABEL[entry.group], ...entry.synonyms].join(' '),
  );
}

/**
 * Die Treffer zu einer Eingabe — in der Reihenfolge des Index (die der Seite),
 * gedeckelt auf `MAX_HITS`.
 *
 * Regel: JEDES Wort der Eingabe muss vorkommen (so verengt Tippen die Liste,
 * statt sie zu verbreitern), verglichen wird auf Teilzeichenkette (damit
 * „speicher" auch „Speicherschonung" trifft). Eine leere Eingabe trifft
 * NICHTS — die Suche zeigt dann gar keine Liste, statt so zu tun, als hätte
 * jemand gesucht.
 */
export function searchSettings(query: string): GlossarEntry[] {
  const tokens = normalizeTerm(query).split(' ').filter(Boolean);
  if (tokens.length === 0) return [];
  const hits: GlossarEntry[] = [];
  for (const entry of GLOSSAR) {
    const hay = haystack(entry);
    if (tokens.every((t) => hay.includes(t))) hits.push(entry);
    if (hits.length >= MAX_HITS) break;
  }
  return hits;
}

/** Der Satz unter dem Suchfeld, wenn nichts passt — nie eine leere Liste. */
export function noHitText(query: string): string {
  return `Zu „${query.trim()}" haben wir hier nichts gefunden. Alle Einstellungen dieser Anlage stehen unten in sechs Gruppen.`;
}

/** Der Platzhalter des Suchfelds, mit echten Beispielwörtern aus dem Index. */
export const SEARCH_PLACEHOLDER = 'Einstellung suchen … z. B. „Strompreis", „Netzladen", „Reserve"';
