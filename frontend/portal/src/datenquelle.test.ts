import { describe, expect, it } from 'vitest';
import type { DatenquelleBudgetBox, Device, EdgeVersion } from './api';
import { budgetFreiText, datenquelleBoxen, folgenSaetze, pruefungText } from './datenquelle';

const box = (id: string, siteId: string, name: string | null, lastSeenAt: string | null): Device => ({
  id, siteId, name, lastSeenAt, kind: 'edge', externalRef: `VP-${id}`, status: 'claimed', createdAt: '2026-09-16T09:00:00Z',
});

describe('Datenquelle anlegen — Ableitungen', () => {
  it('zeigt nur Boxen des Standorts mit echtem Verbindungs-, Software- und Budgetstand', () => {
    const budget: DatenquelleBudgetBox = {
      id: 'e2', name: 'Box Halle 2', quelle_passt: true,
      belegt: { channels: 52, samples_per_minute: 55, requests_per_minute: 1, duty_cycle_percent: 0.7 },
      frei: { channels: 0, samples_per_minute: 545, requests_per_minute: 29, duty_cycle_percent: 19.3 },
    };
    const versionen: EdgeVersion[] = [{ deviceId: 'e2', siteId: 'an2', coreVersion: '2.8.0', paletteVersion: null, reportedAt: '2026-09-16T09:59:00Z' }];
    expect(datenquelleBoxen(
      [box('e1', 'an1', 'Box Halle 1', '2026-09-16T07:00:00Z'), box('e2', 'an2', 'Box Halle 2', '2026-09-16T09:59:30Z'), box('e3', 'an3', 'Box Lindach', null)],
      versionen, ['an1', 'an2'], [budget], new Date('2026-09-16T10:00:00Z'),
    )).toEqual([
      { id: 'e1', name: 'Box Halle 1', verbunden: 'Meldet sich nicht', software: 'Software-Stand unbekannt', budget: 'Freies Lesebudget: wird beim Einrichten geprüft' },
      { id: 'e2', name: 'Box Halle 2', verbunden: 'Verbunden', software: 'Software 2.8.0', budget: 'Frei: 545 Messwerte/min · 29 Anfragen/min · 19,3 % Buszeit' },
    ]);
  });

  it('formuliert unbekanntes Budget, Prüfung und Folgen ohne erfundene Zahlen', () => {
    expect(budgetFreiText(null)).toBe('Freies Lesebudget: wird beim Einrichten geprüft');
    expect(pruefungText({ ergebnis: 'unreachable', dauer_ms: 804, text: 'Box Halle 2 erreicht 192.168.20.10:502 nicht.' }))
      .toBe('Nicht erreichbar · 804 ms — Box Halle 2 erreicht 192.168.20.10:502 nicht.');
    expect(folgenSaetze('Halle 2', 'Box Halle 2')).toContain('Vorhandene Datenquellen und Messwerte bleiben unverändert.');
  });
});
