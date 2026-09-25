/**
 * Die Kundenwörter des Portals — rein, ohne React.
 *
 * **Die Umbenennungen** (Captain-Entscheid D6, Wortquelle: Begriffs-Audit
 * `data/vp-energiemarkt-x9/report.md` Teil 3, Zeilen 2/5/6) stehen hier als
 * Konstanten, damit die Flächen, die dasselbe Feld aufnehmen
 * (Einstellungs-Seite, Anlege-Assistent, Admin-Anlegen-Drawer), nie
 * auseinanderlaufen. Das ist das **Zwei-Register-Modell** des Audits: Register A
 * ist der marktkorrekte Begriff, Register B die Kundenformulierung — und jede
 * Kundenformulierung ist die Übersetzung genau EINES Begriffs aus A.
 *
 * Die frühere Suche der Einstellungs-Seite (E6) ist mit „Anlage – neu gedacht"
 * (E5 = A) entfallen: bei gut einem Dutzend Zeilen steht alles auf einen Blick
 * da. Ihre Suchwörter (`GLOSSAR`) speisen weiter die Hilfe-Suche, und
 * `normalizeTerm` bleibt - andere Suchen im Portal vergleichen damit.
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
 * derselben Maske gleich zu benennen. Umgesetzt ist deshalb die ABSICHT: der
 * Sammelaufschlag heißt ausdrücklich „gesamt", das Preisblatt behält
 * „Vertriebsaufschlag". Ein anderslautender Entscheid ist eine Zeile in
 * `tariffInput.TARIF_PARAM_FIELDS`.
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
 * Die TÄTIGKEITEN des Speichers im Fahrplan — der EINE Wortschatz auf Uhr,
 * Bildfahrplan, Stationen, Antworten, Erklär-Panel und in der Hilfe
 * (Konzept „Tagesuhr und Bildfahrplan", Entscheid E8 vom 24.09.2026;
 * Glossar-Nachtrag „Tätigkeit des Speichers"). Vorher hieß dieselbe Phase in
 * Band, Film und Panel je anders. Die Rollen ohne eigenes Listenwort
 * (Verkaufen, Lastspitze kappen, Reserve halten) sagt `fahrplanWhy.roleLabel`.
 */
export const FAHRPLAN_TAETIGKEIT = {
  sonneSpeichern: 'Sonne speichern',
  guenstigLaden: 'Günstig aus dem Netz laden',
  verbrauchDecken: 'Verbrauch decken',
  warten: 'Warten',
  einspeisungPausieren: 'Einspeisung pausieren',
} as const;

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

/** Das eine Kundenwort nach E10 (16.09.2026), rollen-zuordnung.md. */
export const SUMMENWERT = 'Summenwert';
/** Produkttexte, nicht freie Kundennamen; copy.test.ts prüft die Kundenflächen. */
export const SUMMENWERT_VERBOTENE_WOERTER = ['Gesamtwert', 'PV gesamt', 'Helfer'] as const;
/** @deprecated Kompatibler Exportname für bestehende Aufrufer; neue Flächen verwenden SUMMENWERT. */
export const GESAMTWERT = SUMMENWERT;

/**
 * Laden bei Bezug im Cockpit (Herzogau 24.09.2026, h4 §7 B2; `ladenBeiBezug.ts`):
 * die kurze Totzeit nach einer Wolkenkante ist kein Fehler und wird so gesagt;
 * ein bewusstes Netz-Laden des Fahrplans nennt seinen Grund.
 */
export const LADEN_BEI_BEZUG_WOLKE =
  'Eine Wolke hat die Sonne gerade verdeckt – der Speicher regelt in den nächsten Sekunden nach.';
export const LADEN_BEI_BEZUG_FAHRPLAN = 'Der Fahrplan lädt jetzt für die teuren Stunden.';

// ---------------------------------------------------------------------------
// 3 · Die Suchwörter der Einstellungen
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
 * Die Wörter, unter denen Kunden ihre Einstellungen suchen - Label, Fachwort
 * und Synonyme (auch die ALTEN Namen). Seit die Einstellungs-Seite keine eigene
 * Suche mehr hat (E5 = A), sind sie die Stichworte des Hilfe-Artikels
 * „Begriffe einfach erklärt" (`help/content/probleme.ts`): wer dort
 * „Anlagentyp" oder „Arbeitspreis" sucht, findet weiter die Erklärung.
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

// ---------------------------------------------------------------------------
// 4 · Vergleichen
// ---------------------------------------------------------------------------

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
