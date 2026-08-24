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
// 2 · Der Suchindex
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
