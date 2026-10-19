import {
  MISPEL_ABGRENZUNGSOPTION, MISPEL_DIREKTVERMARKTUNG, MISPEL_FARBEN, MISPEL_PAUSCHALOPTION,
} from '../../glossar';
import type { HelpArticle } from '../model';

/**
 * MiSpeL MP-50 (Bedienkonzept BK-50 = A, Captain 13.10.2026): die Themenseite „MiSpeL verstehen“ in der Gruppe 07 des
 * Hilfe-Zentrums. Wortlaut, Reihenfolge und Bilder folgen der Attrappe des Konzepts (Abschnitt 3.1); die Bilder
 * zeichnet `MispelBild.tsx` aus den Angaben unten, in den Farben der MiSpeL-Karte.
 *
 * Ein Satz mit Rechtsaussage trägt in der Zeile darüber `// MP-61: Rechtsprüfung`: Bis eine Kanzlei ihn gesehen hat,
 * bleibt die Seite im Entwicklungsstand und in der Demo. Nicht behauptet wird: dass die Regeln schon gelten, dass die
 * Pauschaloption anwendbar ist, dass ein Auto heute zurückspeist. „Lohnt es sich für mich?“ verweist bis zu den
 * Musteranlagen (MP-54) nur auf den Vorteilsrechner.
 */

/** Was in den Bildern als Symbol steht. */
export type MispelKnoten = 'sonne' | 'speicher' | 'netz' | 'haus';

export const MISPEL_KNOTEN: Record<MispelKnoten, string> = {
  sonne: 'Solaranlage', speicher: 'Speicher', netz: 'Stromnetz', haus: 'Haus oder Betrieb',
};

export interface MispelVorherNachher {
  titel: string;
  zeilen: { erlaubt: boolean; kette: MispelKnoten[]; satz: string }[];
  fazit: string;
}

export const MISPEL_VORHER_NACHHER: readonly [MispelVorherNachher, MispelVorherNachher] = [
  {
    titel: 'Bisher',
    zeilen: [
      { erlaubt: true, kette: ['sonne', 'speicher'], satz: 'Sonnenstrom laden' },
      {
        erlaubt: false, kette: ['netz', 'speicher'],
        // MP-61: Rechtsprüfung
        satz: 'Netzstrom laden kostet die Förderung für den Strom aus dem Speicher – für das ganze Kalenderjahr',
      },
    ],
    // MP-61: Rechtsprüfung
    fazit: 'Der Speicher an einer geförderten Solaranlage durfte nur Sonnenstrom aufnehmen.',
  },
  {
    titel: 'Mit MiSpeL',
    zeilen: [
      { erlaubt: true, kette: ['sonne', 'speicher'], satz: 'Sonnenstrom laden' },
      {
        erlaubt: true, kette: ['netz', 'speicher'],
        // MP-61: Rechtsprüfung
        satz: 'Netzstrom laden ist erlaubt – die Förderung des Sonnenstroms bleibt',
      },
    ],
    // MP-61: Rechtsprüfung
    fazit: 'Der Speicher darf mischen. Gezählt wird, welcher Strom welchen Weg genommen hat.',
  },
];

export interface MispelWeg {
  farbe: 'gruen' | 'gelb' | 'rot' | 'ohne';
  name: string;
  kette: MispelKnoten[];
  /** Die Folge in Kundenworten, als Abzeichen. */
  folge: string;
  satz: string;
}

const gross = (wort: string) => wort.charAt(0).toUpperCase() + wort.slice(1);

export const MISPEL_WEGE: readonly MispelWeg[] = [
  {
    farbe: 'gruen', name: gross(MISPEL_FARBEN.gruen), kette: ['sonne', 'netz'],
    // MP-61: Rechtsprüfung
    folge: 'Marktprämie wie bisher',
    satz: 'Sonnenstrom geht direkt ins Netz',
  },
  {
    farbe: 'gelb', name: gross(MISPEL_FARBEN.gelb), kette: ['sonne', 'speicher', 'netz'],
    // MP-61: Rechtsprüfung
    folge: 'Marktprämie bleibt',
    satz: 'Sonnenstrom geht erst in den Speicher, später ins Netz',
  },
  {
    farbe: 'rot', name: gross(MISPEL_FARBEN.rot), kette: ['netz', 'speicher', 'netz'],
    // MP-61: Rechtsprüfung
    folge: 'Umlagen entfallen auf diese Menge',
    satz: 'Netzstrom wird nur zwischengespeichert und wieder eingespeist',
  },
  {
    farbe: 'ohne', name: 'Ohne Farbe', kette: ['netz', 'haus'],
    // MP-61: Rechtsprüfung
    folge: 'wie bisher voll belastet',
    satz: 'Netzstrom, den Sie verbrauchen – auch der, mit dem ein Auto fährt',
  },
];

export const MISPEL_WEGE_UNTERSCHRIFT = [
  'Rot heißt hier nicht „schlecht“: Es ist die Farbe der Festlegung für Netzstrom, der nur zwischengespeichert wurde.',
  // MP-61: Rechtsprüfung
  'Auf die rote Menge entfällt nach heutiger Rechtslage auch das Netzentgelt; das kann sich mit der Reform der Netzentgelte ändern.',
] as const;

export interface MispelTagAbschnitt {
  von: number;
  bis: number;
  art: 'netz' | 'sonne' | 'abgabe' | 'ruhe';
  text: string;
}

/** Ein Tag als Band: Schema, keine Messwerte. */
export const MISPEL_TAG: {
  titel: string;
  abschnitte: readonly MispelTagAbschnitt[];
  legende: readonly { art: MispelTagAbschnitt['art']; text: string }[];
  unterschrift: string;
} = {
  titel: 'So kann ein Tag aussehen',
  abschnitte: [
    { von: 0, bis: 5, art: 'netz', text: 'lädt günstigen Netzstrom' },
    { von: 5, bis: 10, art: 'ruhe', text: '' },
    { von: 10, bis: 15, art: 'sonne', text: 'lädt Sonnenstrom' },
    { von: 15, bis: 17, art: 'ruhe', text: '' },
    { von: 17, bis: 21.5, art: 'abgabe', text: 'gibt ab: Haus und Netz' },
    { von: 21.5, bis: 24, art: 'ruhe', text: '' },
  ],
  legende: [
    { art: 'netz', text: 'Netz → Speicher' },
    { art: 'sonne', text: 'Sonne → Speicher' },
    { art: 'abgabe', text: 'Speicher → Haus und Netz' },
  ],
  unterschrift: 'Schema, keine Messwerte. Was davon grün, gelb oder rot zählt, bestimmt erst die Monatsrechnung.',
};

export const mispelArticles: HelpArticle[] = [
  {
    id: 'mispel-verstehen', category: 'mispel', title: 'MiSpeL verstehen',
    eyebrow: 'MiSpeL · Speicher und Ladepunkte im Mischbetrieb',
    headline: 'Sonne und Netz in einem Speicher',
    // MP-61: Rechtsprüfung
    summary: 'Bisher musste sich ein Speicher an einer geförderten Solaranlage entscheiden: nur Sonnenstrom – oder die Förderung für den Strom aus dem Speicher ist weg. Mit MiSpeL darf er beides laden.',
    keywords: [
      'MiSpeL', 'Mischbetrieb', 'Netzladen', 'Netzstrom', 'Förderweg', 'Abgrenzungsoption', 'Pauschaloption', 'Direktvermarktung',
      'Marktprämie', 'Umlagen', 'grün', 'gelb', 'rot', 'Ladepunkt', 'Wallbox', 'Zurückspeisen', 'bidirektional', 'Bundesnetzagentur', 'Festlegung',
    ],
    // MP-61: Rechtsprüfung
    prerequisite: 'Anlagen mit Speicher oder rückspeisefähigem Ladepunkt – Gewerbe und Haushalt. Mit fester Einspeisevergütung geht es nicht.',
    // MP-61: Rechtsprüfung
    asOf: 'Stand Oktober 2026: Die Bundesnetzagentur hat die Regeln am 01.10.2026 beschlossen; wirksam werden sie zwei Wochen nach der Veröffentlichung im Amtsblatt. VoltPilot hat dazu noch keine Anlage im Echtbetrieb.',
    sections: [
      { id: 'vorher-nachher', title: 'Vorher und nachher', paragraphs: [], diagram: 'mispel-vorher-nachher' },
      { id: 'drei-farben', title: 'Drei Farben für vier Wege', paragraphs: [
        'Jede Kilowattstunde bekommt eine Farbe – je nachdem, woher sie kam und wohin sie ging. Portal und Nachweis benutzen dieselben Farben.',
      ], diagram: 'mispel-wege' },
      { id: 'ein-tag', title: 'Ein Tag im Mischbetrieb', paragraphs: [], diagram: 'mispel-tag' },
      { id: 'zwei-wege', title: 'Zwei Wege – welcher passt?', paragraphs: [], cards: [
        {
          icon: 'activity', title: MISPEL_ABGRENZUNGSOPTION, subtitle: 'Jede Kilowattstunde genau erfasst',
          items: [
            // MP-61: Rechtsprüfung
            'Für Gewerbe, größere Anlagen, Speicher ohne Solaranlage und Ladepunkte',
            // MP-61: Rechtsprüfung
            'Zwei geeichte Zähler: am Netzanschluss und am Speicher – in einfachen Fällen genügt einer',
            'Gerechnet je Viertelstunde, bestimmt je Monat',
          ],
          // MP-61: Rechtsprüfung
          status: { tone: 'info', text: 'möglich · bis 30.09.2027 nur mit Einverständnis von Netz- und Messstellenbetreiber' },
        },
        {
          icon: 'home', title: MISPEL_PAUSCHALOPTION, subtitle: 'Daumenregel für kleine Solaranlagen',
          items: [
            // MP-61: Rechtsprüfung
            'Für Solaranlagen bis 30 kWp – typisch Haushalte',
            // MP-61: Rechtsprüfung
            'Ein Zähler am Netzanschluss genügt',
            // MP-61: Rechtsprüfung
            'Bis 500 kWh je kWp und Jahr Marktprämie; darüber ein Zwischenbereich, danach entfallen Umlagen',
          ],
          // MP-61: Rechtsprüfung
          status: { tone: 'warn', text: 'noch nicht anwendbar · wartet auf die Genehmigung der EU-Kommission' },
        },
      ] },
      { id: 'was-sich-aendert', title: 'Was sich für Sie ändert', paragraphs: [], points: [
        { icon: 'hand', title: `${MISPEL_DIREKTVERMARKTUNG} statt fester Vergütung`, text: [
          // MP-61: Rechtsprüfung
          'Beide Wege setzen die Direktvermarktung voraus.',
          // MP-61: Rechtsprüfung
          'Sie schließen einen Vertrag mit einem Direktvermarkter und erhalten Marktwert und Marktprämie statt eines festen Satzes.',
        ] },
        { icon: 'activity', title: 'Ein zweiter Zähler – meistens', text: [
          // MP-61: Rechtsprüfung
          'Am Speicher oder Ladepunkt. Bei Speichern ohne Solaranlage und in der Pauschaloption genügt der Zähler am Netzanschluss.',
        ] },
        {
          icon: 'zap',
          // MP-61: Rechtsprüfung
          title: 'Netzladen ist erlaubt',
          text: ['VoltPilot plant das Laden aus Sonne und Netz gemeinsam. Der Schalter „Netzladen“ gehört dann Ihnen.'],
        },
        { icon: 'file-text', title: 'Eine Abrechnung in Farben', text: [
          // MP-61: Rechtsprüfung
          'Jeden Monat die Mengen in Grün, Gelb und Rot – mit Nachweis für Lieferant, Direktvermarkter und Netzbetreiber.',
        ] },
      ] },
      { id: 'lohnt-es-sich', title: 'Lohnt es sich für mich?', paragraphs: [
        'Ob sich MiSpeL für Ihre Anlage lohnt, hängt an Speicher, Solaranlage, Verbrauch und Stromtarif – es kann auch weniger bringen als heute. Das rechnet der Vorteilsrechner „Was bringt MiSpeL meiner Anlage?“: Er vergleicht immer dieselbe Anlage, heute gegen mit MiSpeL – nie gegen „ohne Speicher“.',
      ], note: 'Der Vorteilsrechner kommt als eigener Artikel in die Gruppe „MiSpeL“. Bis dahin hilft Ihnen „Kontakt und Unterstützung“ weiter.' },
      { id: 'auto', title: 'Und das Auto?', paragraphs: [], points: [
        { icon: 'car', text: [
          // MP-61: Rechtsprüfung
          'Ein Ladepunkt, der zurückspeisen kann, zählt wie ein Speicher. Der Strom, mit dem Sie fahren, bleibt voll belastet.',
          'VoltPilot kann das Zurückspeisen schon planen und abrechnen. Eingeschaltet ist es noch nicht: Erst muss es an echter Wallbox und echtem Auto geprüft sein.',
        ] },
      ] },
    ],
    related: ['einstellungen', 'erloese', 'glossar', 'kontakt'],
  },
];
