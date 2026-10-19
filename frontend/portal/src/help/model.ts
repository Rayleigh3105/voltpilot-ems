import type { IconName } from '../../designsystem/components/core/Icon';

export const HELP_CATEGORIES = [
  { id: 'verstehen', title: 'VoltPilot verstehen', description: 'Das Zusammenspiel Ihrer Energieanlage.', icon: 'sun' },
  { id: 'start', title: 'Erste Schritte', description: 'Von der Anmeldung bis zum ersten Messwert.', icon: 'flag' },
  { id: 'alltag', title: 'Im Alltag', description: 'Messwerte, Fahrpläne und Ergebnisse lesen.', icon: 'activity' },
  { id: 'steuern', title: 'Energie steuern', description: 'Betriebsmodelle, Regeln und Ladepunkte.', icon: 'sliders' },
  { id: 'anlage', title: 'Anlage verwalten', description: 'Geräte, Komponenten und Einstellungen.', icon: 'settings' },
  { id: 'probleme', title: 'Probleme lösen', description: 'Antworten finden und den nächsten Schritt kennen.', icon: 'help-circle' },
  // MiSpeL MP-50 (BK-50 = A): die Gruppe 07 trägt „verstehen · rechnen · der Weg“; die beiden anderen Artikel folgen mit MP-53 und MP-56.
  { id: 'mispel', title: 'MiSpeL', description: 'Sonne und Netz in einem Speicher.', icon: 'battery' },
] as const;

export type HelpCategory = typeof HELP_CATEGORIES[number]['id'];
export type HelpArticleId =
  | 'voltpilot' | 'energiefluesse' | 'beispieltag' | 'energiemanagement'
  | 'orientierung' | 'anlage-anlegen' | 'box-verbinden'
  | 'summenwerte' | 'cockpit' | 'fahrplan' | 'messwerte' | 'erloese' | 'marktpreise' | 'prognosen' | 'portfolio'
  | 'geraete-steuern' | 'betriebsmodelle' | 'regeln' | 'speicher' | 'lastspitzen' | 'ladepark' | 'ladevorgaenge'
  | 'anlagenmodell' | 'geraete' | 'einstellungen' | 'standort-zuordnung-korrigieren'
  | 'probleme' | 'glossar' | 'kontakt'
  | 'mispel-verstehen';

/** Eine Wahl nebeneinander, etwa ein Förderweg: Titel, Unterzeile, Merkmale und ein Stand als Abzeichen. */
export interface HelpCard {
  icon: IconName;
  title: string;
  subtitle: string;
  items: string[];
  status: { tone: 'info' | 'warn'; text: string };
}

/** Ein Punkt mit Symbol; jeder Eintrag in `text` ist ein eigener Absatz. */
export interface HelpPoint {
  icon: IconName;
  title?: string;
  text: string[];
}

export interface HelpSection {
  id: string;
  title: string;
  paragraphs: string[];
  steps?: string[];
  note?: string;
  figure?: string;
  diagram?: 'energy' | 'loop' | 'day' | 'system' | 'proof' | 'storage' | 'mispel-vorher-nachher' | 'mispel-wege' | 'mispel-tag';
  cards?: HelpCard[];
  points?: HelpPoint[];
}

export interface HelpArticle {
  id: HelpArticleId;
  category: HelpCategory;
  title: string;
  /** Kennzeile über der Überschrift; ohne sie steht dort die Gruppe. */
  eyebrow?: string;
  /** Überschrift der Seite, wenn sie vom Titel in Liste und Suche abweicht. */
  headline?: string;
  summary: string;
  keywords: string[];
  prerequisite?: string;
  /** Stand-Hinweis unter „Gilt für“: für Inhalte, die von einem Datum abhängen. */
  asOf?: string;
  sections: HelpSection[];
  related: HelpArticleId[];
}

/** Same URLs in contextual help, search, article links and copied bookmarks. */
export function helpHref(article?: string, section?: string): string {
  return `#/hilfe${article ? `/${encodeURIComponent(article)}` : ''}${section ? `?abschnitt=${encodeURIComponent(section)}` : ''}`;
}
