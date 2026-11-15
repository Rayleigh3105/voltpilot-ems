/**
 * Die Wortliste der Textform als Nachschlageseite neben dem Text (E9 = B: englische Wörter; Bericht 17.7). Die
 * Wörter selbst kommen aus der byte-gleichen Kopie des Vertrags (`steuerlogik-woerter.json`,
 * `woerter.sync.test.ts`); hier stehen nur die Gruppen für Menschen und je Wort ein kurzer Satz, was es tut.
 */
import WOERTER_DATEI from './steuerlogik-woerter.json';

type Tabelle = Record<string, string>;
const DATEI = WOERTER_DATEI as unknown as Record<string, Tabelle | string>;

/** Die Tabellen der Datei, deren Wörter Schlüssel der Textform sind (für die Einfärbung). */
const SCHLUESSEL_TABELLEN = ['abschnitte', 'geraet', 'wert', 'stellwert', 'hilfe', 'zeitfenster', 'zustand', 'schritt',
  'ausgang', 'anzeige', 'marke', 'meldung', 'lage', 'probe'];

/** Jedes Wort, das als Schlüssel der Textform vorkommt. */
export const SPRACHWOERTER: ReadonlySet<string> = new Set(
  SCHLUESSEL_TABELLEN.flatMap((t) => Object.values(DATEI[t] as Tabelle)),
);

export interface Gruppe {
  titel: string;
  satz: string;
  tabelle: string;
}

/** Die Gruppen der Nachschlageseite, in der Reihenfolge, in der man sie beim Schreiben braucht. */
export const GRUPPEN: Gruppe[] = [
  { titel: 'Abschnitte', satz: 'Die Teile einer Logik, in dieser Reihenfolge.', tabelle: 'abschnitte' },
  { titel: 'Gerät', satz: 'Im Abschnitt Geräte: was die Logik schaltet.', tabelle: 'geraet' },
  { titel: 'Eingang', satz: 'Im Abschnitt Eingänge: was die Logik liest.', tabelle: 'wert' },
  { titel: 'Stellwert', satz: 'Im Abschnitt Stellwerte: ein Wert mit Bereich.', tabelle: 'stellwert' },
  { titel: 'Art eines Stellwerts', satz: 'Die Art eines Stellwerts; ohne Art eine Zahl mit Einheit oder Uhrzeit.', tabelle: 'art_stellwert' },
  { titel: 'Wer stellt', satz: 'Wer einen Stellwert stellt. Temperaturen stellt der Kunde immer.', tabelle: 'darf' },
  { titel: 'Hilfe eines Schalters', satz: 'Die Hilfe eines Schalters mit zwei Sätzen.', tabelle: 'hilfe' },
  { titel: 'Zeitfenster', satz: 'Ein Fenster eines Zeitplans.', tabelle: 'zeitfenster' },
  { titel: 'Zustand', satz: 'Im Abschnitt Zustände: was sich die Logik merkt.', tabelle: 'zustand' },
  { titel: 'Art eines Zustands', satz: 'Die Art eines Zustands.', tabelle: 'art_zustand' },
  { titel: 'Schritt eines Zählers', satz: 'Die Schritte eines Zählers: der erste zutreffende gilt.', tabelle: 'schritt' },
  { titel: 'Ausgang', satz: 'Im Abschnitt Ausgänge: was ein Gerät tun soll, als Formel.', tabelle: 'ausgang' },
  { titel: 'Erklärsatz', satz: 'Im Abschnitt Erklärsätze: die erste zutreffende Zeile gilt.', tabelle: 'lage' },
  { titel: 'Art eines Erklärsatzes', satz: 'Die Art eines Erklärsatzes: Farbe und Zeichen der Karte.', tabelle: 'art_lage' },
  { titel: 'Meldung', satz: 'Im Abschnitt Meldungen.', tabelle: 'meldung' },
  { titel: 'Probe', satz: 'Im Abschnitt Proben: ein durchgespielter Fall.', tabelle: 'probe' },
  { titel: 'Gegeben einer Probe', satz: 'Feste Wörter für „gegeben“.', tabelle: 'gegeben' },
  { titel: 'Erwartet von einer Probe', satz: 'Feste Wörter für „erwartet“.', tabelle: 'erwarte' },
  { titel: 'Anzeige', satz: 'Im Abschnitt Anzeige: was die Karte zusätzlich zeichnet.', tabelle: 'anzeige' },
  { titel: 'Marke der Anzeige', satz: 'Marken der Anzeige.', tabelle: 'marke' },
  { titel: 'Feste Werte', satz: 'Werte, die so im Text stehen.', tabelle: 'wertwort' },
  { titel: 'Wörter in Formeln', satz: 'Verknüpfen und Vergleichen.', tabelle: 'formelwort' },
  { titel: 'Funktionen', satz: 'In Formeln, mit Klammern.', tabelle: 'funktion' },
  { titel: 'Zeitgeber starten', satz: 'Im Feld „dann“ eines Schritts: start(zeitgeber) if Bedingung.', tabelle: 'handlung' },
  { titel: 'Feste Quellen', satz: 'Was jede Box liest, als Quelle eines Eingangs.', tabelle: 'quelle_fest' },
  { titel: 'Signale eines Geräts', satz: 'Als Quelle: <Gerät>.<Signal>.', tabelle: 'signal' },
  { titel: 'Eigenschaften eines Geräts', satz: 'In Formeln: <Gerät>.<Eigenschaft>.', tabelle: 'geraet_eigenschaft' },
  { titel: 'Betriebsarten', satz: 'Werte einer Betriebsart.', tabelle: 'betriebsart' },
  { titel: 'Wochentage', satz: 'In Zeitfenstern.', tabelle: 'tage' },
];

/** Was ein Wort tut, je Tabelle und englischem Wort; ohne Eintrag genügt das deutsche Wort. */
const ERKLAERT: Record<string, Tabelle> = {
  abschnitte: {
    logic: 'Sprachversion, immer 1', devices: 'Geräte, die die Logik schaltet', inputs: 'Werte, die sie liest',
    settings: 'Stellwerte mit Bereich und „wer stellt“', constraints: 'Was zwischen Stellwerten gelten muss',
    formulas: 'Benannte Formeln', states: 'Schalter, Zähler, Zeitgeber', outputs: 'Was jedes Gerät tun soll',
    status: 'Titel und Satz für den Kunden', tests: 'Proben, freiwillig', notifications: 'Nachrichten',
    display: 'Zusätzliche Anzeige der Karte',
  },
  wert: { max_age: 'Älter als das gilt der Wert als unbekannt' },
  stellwert: { default: 'Vorgabe', range: 'Bereich [von, bis]', step: 'Schrittweite', editable_by: 'Wer ihn stellt', options: 'Auswahl: Wort und Name' },
  zustand: {
    on_when: 'Geht an, wenn alles gilt', on_when_any: 'Geht an, wenn eines gilt', off_when: 'Geht aus, wenn alles gilt',
    off_when_any: 'Geht aus, sobald eines gilt (aus gewinnt)', after_restart: 'Wert nach einem Neustart der Box',
    on_text: 'Satz im Blatt „Warum?“ fürs Angehen', off_text: 'Satz fürs Ausgehen', min: 'Kleinster Wert', max: 'Größter Wert',
  },
  schritt: { by: 'Um so viel ändern', set: 'Auf diesen Wert setzen', not_before: 'Frühestens so lange nach dem letzten Wechsel', then: 'Einen Zeitgeber starten' },
  ausgang: {
    level: 'Stufe 0 bis Zahl der Ausgänge', on_off: 'Ein oder aus', setpoint: 'Sollwert in °C oder kW', mode: 'Betriebsart',
    percent: 'Anteil 0 bis 100 %', must_run: 'Pflicht vor dem Fahrplan: nur in der Übersetzung einer Steuerart',
  },
  lage: { when: 'Wenn das gilt …', else: 'Die letzte Zeile: sonst', title: 'Kurzer Titel', text: 'Satz mit {Formel} für Werte von jetzt' },
  probe: { given: 'Werte am Anfang', after: 'So lange läuft die Probe', expect: 'Was danach gelten soll' },
  wertwort: { keep: 'Nach einem Neustart: behalten', unknown: 'Kein frischer Wert' },
  funktion: {
    if: 'if(Bedingung, dann, sonst)', known: 'Hat einen frischen Wert', unknown: 'Hat keinen frischen Wert',
    time_window: 'time_window(von, bis): Uhrzeit liegt im Fenster', in_schedule: 'Jetzt im Zeitplan',
    holds: 'holds(Bedingung, Dauer): gilt seit mindestens', since: 'Zeit seit dem letzten Wechsel eines Zustands',
    running: 'Ein Zeitgeber läuft', last: 'Letzter Schritt eines Zählers', min: 'Kleinster Wert', max: 'Größter Wert',
    changes: 'changes(Zähler, Dauer): um wie viel er sich in der Dauer bewegt hat',
    oldest_change: 'oldest_change(Zähler, Dauer): wie lange der älteste Wechsel darin her ist',
  },
  formelwort: { clock: 'Die Uhrzeit, zum Vergleich mit "HH:MM"', unknown: 'Kein Wert: nur als Zweig von if(), etwa „sonst kein Wunsch“' },
  geraet_eigenschaft: { requested: 'Was die Logik im letzten Takt wollte', output_hours_today: 'Einschaltzeit aller Ausgänge seit Mitternacht' },
  quelle_fest: {
    'site.grid': 'kW, + heißt Bezug', 'battery.power': 'kW, + heißt laden', 'price.current': 'ct/kWh, eine Zahl ohne Einheit',
    'site.surplus': 'kW: Sonnenstrom minus Hausverbrauch, aus derselben Messung',
  },
  signal: { power: 'kW, die das Gerät zieht: gemessen, sonst die seiner bestätigten Stufe' },
};

export interface Zeile {
  wort: string;
  deutsch: string;
  satz: string | null;
}

/** Die Zeilen einer Gruppe: englisches Wort, das deutsche Wort der Wortliste und, wo es hilft, ein Satz. */
export function zeilen(g: Gruppe): Zeile[] {
  const t = DATEI[g.tabelle] as Tabelle;
  return Object.entries(t).map(([deutsch, wort]) => ({
    wort,
    deutsch: deutsch.replace(/_/g, ' '),
    satz: ERKLAERT[g.tabelle]?.[wort] ?? null,
  }));
}

/** Sucht in allen Gruppen nach englischem oder deutschem Wort oder Satz. */
export function suche(begriff: string): { gruppe: Gruppe; zeilen: Zeile[] }[] {
  const b = begriff.trim().toLowerCase();
  return GRUPPEN.map((g) => ({
    gruppe: g,
    zeilen: zeilen(g).filter((z) => !b || z.wort.toLowerCase().includes(b) || z.deutsch.toLowerCase().includes(b)
      || (z.satz ?? '').toLowerCase().includes(b)),
  })).filter((x) => x.zeilen.length > 0);
}

/** Alle Tabellen der Datei außer der Erklärung und den Schema-Namen. */
export function tabellenDerDatei(): string[] {
  return Object.keys(DATEI).filter((k) => !k.startsWith('_') && k !== 'schema_def');
}
