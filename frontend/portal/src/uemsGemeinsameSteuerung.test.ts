import { describe, expect, it } from 'vitest';
import { KUNDENWORT, platzhalter, SAETZE, satz, ZUSTAENDE, type SatzSchluessel } from './uemsGemeinsameSteuerung';

/**
 * Die Tabelle §5.8 des Konzepts AP-15 (`data/vp-uems-ap15-verbund/report.md`), wörtlich und
 * mit den Beispielwerten der Anlage AN-1 am Netzanschluss NA-1. Ändert sich ein Satz, ändert
 * sich zuerst das Konzept — dann diese Zeile, dann die Konstante.
 */
const PARAGRAF_5_8: Array<{ wo: string; schluessel: SatzSchluessel; werte: Record<string, string>; satz: string }> = [
  { wo: 'Karte, Zustand aktiv', schluessel: 'karte_aktiv', werte: { boxen: '2', einspeisung_kw: '100', bezug_kw: '550' }, satz: 'Gemeinsame Steuerung aktiv · 2 Boxen · Einspeisung höchstens 100 kW · Bezug höchstens 550 kW' },
  { wo: 'Box-Zeile, führend', schluessel: 'box_fuehrend', werte: { box: 'Halle 1' }, satz: 'Box Halle 1 führt die Anlage · regelt am Netzanschluss' },
  { wo: 'Box-Zeile, mitsteuernd', schluessel: 'box_mitsteuernd', werte: { box: 'Verwaltung', einspeisung_kw: '60', bezug_kw: '77' }, satz: 'Box Verwaltung steuert mit · hält ihren Anteil: Einspeisung 60 kW · Bezug 77 kW' },
  { wo: 'Erklärung unter den Anteilen', schluessel: 'erklaerung_anteile', werte: {}, satz: 'Jede Box hält ihren Teil der Grenze selbst ein — auch ohne Internet. Zusammen bleiben sie immer unter der Grenze am Netzanschluss.' },
  { wo: 'Box stumm (A1)', schluessel: 'box_stumm', werte: { box: 'Verwaltung', uhrzeit: '13:10' }, satz: 'Box Verwaltung antwortet seit 13:10 nicht. Die Grenze am Netzanschluss bleibt eingehalten; ihre Geräte laufen mit ihren sicheren Vorgabewerten.' },
  { wo: 'führende Box stumm (A2)', schluessel: 'fuehrende_box_stumm', werte: { box: 'Halle 1' }, satz: 'Box Halle 1 antwortet nicht. Niemand regelt gerade am Netzanschluss; jede Box und jedes Gerät hält seinen sicheren Anteil.' },
  { wo: 'beide nicht verbunden (A4)', schluessel: 'beide_nicht_verbunden', werte: {}, satz: 'Beide Boxen sind nicht verbunden. Die Grenze am Netzanschluss halten sie selbst ein.' },
  { wo: 'Zähler fehlt (A7)', schluessel: 'zaehler_fehlt', werte: { box: 'Halle 1' }, satz: 'Box Halle 1 sieht den Netzzähler nicht; sie hält ihren sicheren Anteil.' },
  { wo: 'Update nötig (A12)', schluessel: 'update_noetig', werte: { box: 'Verwaltung' }, satz: 'Box Verwaltung braucht ein Update für die gemeinsame Steuerung.' },
  { wo: 'fremde Anlage (R20)', schluessel: 'fremde_anlage', werte: {}, satz: 'Diese Box gehört zu einer anderen Anlage. Gemeinsam gesteuert wird nur hinter demselben Netzanschluss.' },
  { wo: 'Regel über zwei Boxen', schluessel: 'regel_ueber_zwei_boxen', werte: { box: 'Halle 1', andere_box: 'Verwaltung' }, satz: 'Diese Regel braucht Werte von Box Halle 1 und steuert ein Gerät an Box Verwaltung. Eine Regel lebt heute auf einer Box.' },
  { wo: 'Verlust-Zeile (R2)', schluessel: 'verlust', werte: { kwh: '160' }, satz: 'Heute 160 kWh nicht erzeugt, weil diese Box den Netzanschluss nicht sieht.' },
  { wo: 'Vorbehalt erhöht (R23)', schluessel: 'vorbehalt_erhoeht', werte: { ladepark: 'Ladepark Verwaltung', kw: '55' }, satz: 'Ihr Verbrauch ist gewachsen: die Reserve für alles Übrige wurde erhöht. Der Ladepark Verwaltung bekommt jetzt höchstens 55 kW.' },
  { wo: 'Hinweis beim Einrichten (G7)', schluessel: 'hinweis_einrichten', werte: { kw: '77', box: 'Halle 1' }, satz: 'Der Ladepark hängt an einer Box, die den Netzanschluss nicht sieht: er bekommt fest 77 kW. An Box Halle 1 bekäme er, was am Anschluss frei ist.' },
  { wo: 'Anhalten', schluessel: 'angehalten', werte: { box: 'Halle 1' }, satz: 'Gemeinsame Steuerung angehalten. Box Halle 1 steuert allein; alle Boxen halten weiter ihren Anteil.' },
  { wo: 'Prüfung läuft', schluessel: 'pruefung_laeuft', werte: {}, satz: 'Eingerichtet · wird geprüft. VoltPilot prüft die Anlage mit einer kurzen Messung und schaltet sie frei.' },
];

describe('AP-15 IP-25 · Sätze der Gemeinsamen Steuerung (§5.8)', () => {
  it('jede Zeile aus §5.8 hat genau eine Konstante, und jede Konstante eine Zeile', () => {
    expect(PARAGRAF_5_8.map((z) => z.schluessel).sort()).toEqual(Object.keys(SAETZE).sort());
    expect(PARAGRAF_5_8).toHaveLength(16);
  });

  it.each(PARAGRAF_5_8)('$wo: mit den Werten aus §5.8 entsteht wörtlich der Satz', ({ schluessel, werte, satz: erwartet }) => {
    expect(satz(schluessel, werte)).toBe(erwartet);
  });

  it('Platzhalter stehen nur dort, wo §5.8 einen Wert einsetzt', () => {
    for (const { schluessel, werte } of PARAGRAF_5_8) {
      expect(platzhalter(SAETZE[schluessel]).sort(), schluessel).toEqual(Object.keys(werte).sort());
    }
  });

  it('ein offener oder überzähliger Platzhalter ist ein Fehler, kein halber Satz', () => {
    expect(() => satz('box_stumm', { box: 'Verwaltung' })).toThrow(/fehlt \[uhrzeit\]/);
    expect(() => satz('beide_nicht_verbunden', { box: 'Halle 1' })).toThrow(/überzählig \[box\]/);
  });

  it('Kundenwort und Zustände sind die aus S1', () => {
    expect(KUNDENWORT).toBe('Gemeinsame Steuerung');
    expect(Object.values(ZUSTAENDE).join(' · ')).toBe('eingerichtet · wird geprüft · aktiv · angehalten');
    expect(SAETZE.karte_aktiv.startsWith(`${KUNDENWORT} ${ZUSTAENDE.aktiv}`)).toBe(true);
    expect(SAETZE.angehalten.startsWith(`${KUNDENWORT} ${ZUSTAENDE.angehalten}`)).toBe(true);
  });
});
