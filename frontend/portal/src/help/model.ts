export const HELP_CATEGORIES = [
  { id: 'verstehen', title: 'VoltPilot verstehen', description: 'Das Zusammenspiel Ihrer Energieanlage.', icon: 'sun' },
  { id: 'start', title: 'Erste Schritte', description: 'Von der Anmeldung bis zum ersten Messwert.', icon: 'flag' },
  { id: 'alltag', title: 'Im Alltag', description: 'Messwerte, Fahrpläne und Ergebnisse lesen.', icon: 'activity' },
  { id: 'steuern', title: 'Energie steuern', description: 'Betriebsmodelle, Regeln und Ladepunkte.', icon: 'sliders' },
  { id: 'anlage', title: 'Anlage verwalten', description: 'Geräte, Komponenten und Einstellungen.', icon: 'settings' },
  { id: 'probleme', title: 'Probleme lösen', description: 'Antworten finden und den nächsten Schritt kennen.', icon: 'help-circle' },
] as const;

export type HelpCategory = typeof HELP_CATEGORIES[number]['id'];
export type HelpArticleId =
  | 'voltpilot' | 'energiefluesse' | 'beispieltag' | 'energiemanagement'
  | 'orientierung' | 'anlage-anlegen' | 'box-verbinden'
  | 'summenwerte' | 'cockpit' | 'fahrplan' | 'messwerte' | 'erloese' | 'marktpreise' | 'prognosen' | 'portfolio'
  | 'betriebsmodelle' | 'regeln' | 'speicher' | 'lastspitzen' | 'ladepark' | 'ladevorgaenge'
  | 'anlagenmodell' | 'geraete' | 'einstellungen' | 'standort-zuordnung-korrigieren'
  | 'probleme' | 'glossar' | 'kontakt';

export interface HelpSection {
  id: string;
  title: string;
  paragraphs: string[];
  steps?: string[];
  note?: string;
  figure?: string;
  diagram?: 'energy' | 'loop' | 'day' | 'system' | 'proof' | 'storage';
}

export interface HelpArticle {
  id: HelpArticleId;
  category: HelpCategory;
  title: string;
  summary: string;
  keywords: string[];
  prerequisite?: string;
  sections: HelpSection[];
  related: HelpArticleId[];
}

/** Same URLs in contextual help, search, article links and copied bookmarks. */
export function helpHref(article?: string, section?: string): string {
  return `#/hilfe${article ? `/${encodeURIComponent(article)}` : ''}${section ? `?abschnitt=${encodeURIComponent(section)}` : ''}`;
}
