import { describe, expect, it } from 'vitest';
import type { Device, EdgeVersion, UemsDatenquelle } from './api';
import { boxUebersicht, budgetAnteil, quellZeile } from './boxUebersicht';
import { fuehrendeBoxOf } from './geraetSeite';

const JETZT = new Date('2026-11-03T13:05:00Z');
const box = (id: string, name: string, fuehrtAnlage: boolean): Device => ({
  id, siteId: 'anlage-1', externalRef: `VP-${id}`, kind: 'edge', name,
  status: 'claimed', lastSeenAt: '2026-11-03T13:04:40Z', createdAt: '2026-10-01T08:00:00Z',
  fuehrtAnlage,
});
const quelle = (over: Partial<UemsDatenquelle> = {}): UemsDatenquelle => ({
  id: 'dq-4', kennzeichen: 'DQ-4', name: 'WAGO-Steuerung', anlage: 'anlage-1',
  protokoll: 'modbus_tcp', adresse: '192.168.20.10:502', geraete_ids: [1], netz: null,
  mehrere_leser: false, steuerquelle: false, vergleichsquelle: false, kadenz_s: 60,
  archiviert_am: null, zustaendige_box: { id: 'box-2', name: 'Box Halle 2', heimat_anlage: 'anlage-1' },
  zeitraeume: [],
  rueckmeldung: {
    zustand: 'liefert_nicht', fehlerklasse: 'unreachable', seit: '2026-11-03T13:02:00Z',
    gelesen_am: '2026-11-03T13:01:00Z', anfragen_pro_minute: 6, messwerte_pro_minute: 120,
    gemeldet_am: '2026-11-03T13:04:40Z', text: 'Liefert keine Daten',
  },
  ...over,
});
const version: EdgeVersion = {
  deviceId: 'box-2', siteId: 'anlage-1', coreVersion: '2.5.0', paletteVersion: null,
  reportedAt: '2026-11-03T13:04:40Z', newestRelease: 'edge-2026.09.10', upToDate: false,
};

describe('Box-Übersicht · reine Ableitungen', () => {
  it('zeigt gemeldete Fähigkeiten nur an der meldenden Box und nutzt das Cloud-Urteil', () => {
    const result = boxUebersicht(
      [box('box-1', 'Alt', false), box('box-2', 'Neu', true)],
      [{ ...version, supports: ['data_sources'], capabilities: ['data_sources'] }], [],
      new Map([['anlage-1', 'Halle 2']]), JETZT,
    );
    expect(result.find((b) => b.id === 'box-2')?.faehigkeiten).toBe('Software 2.5.0 · alle Fähigkeiten');
    expect(result.find((b) => b.id === 'box-1')?.faehigkeiten).toContain('Rückmeldung je Datenquelle');
  });

  it('kein Update-Hinweis für Zuständigkeit ab Zeitpunkt: der Cloud-Zeitgeber erbringt sie für jede Box', () => {
    const [v] = boxUebersicht(
      [box('box-2', 'Box Halle 2', true)],
      [{ ...version, capabilities: ['data_sources'] }], [],
      new Map([['anlage-1', 'Halle 2']]), JETZT,
    );
    expect(v.faehigkeiten).toBe('Software 2.5.0 · alle Fähigkeiten');
    expect(v.faehigkeiten).not.toContain('Zuständigkeit ab Zeitpunkt');
    expect(v.updateNoetig).toBe(false);
  });

  it('wählt bei mehreren Boxen nur die serverseitig markierte führende Box', () => {
    const lesend = box('box-1', 'Lese-Box', false);
    const fuehrend = box('box-2', 'Box Halle 2', true);
    expect(fuehrendeBoxOf([lesend, fuehrend], 'anlage-1')).toBe(fuehrend);
    expect(fuehrendeBoxOf([{ ...lesend, fuehrtAnlage: false }, { ...fuehrend, fuehrtAnlage: false }], 'anlage-1')).toBeNull();
  });

  it('übersetzt Fehlerklasse, Zeitpunkt und Budget-Anteil in Kundenwörter', () => {
    const z = quellZeile(quelle());
    expect(z.zustand).toBe('Liefert keine Daten');
    expect(z.fehlerklasse).toBe('nicht erreichbar');
    expect(z.seit).toContain('03.11.2026');
    expect(z.budget).toBe('Budget-Anteil 20 % · 6 von 30 Anfragen/min · 120 von 600 Messwerten/min');
    expect(budgetAnteil(quelle({ rueckmeldung: null }))).toBe('Budget-Anteil nicht gemeldet');
  });

  it('zeigt je Box Verbindung, Rolle, Quellen und den nötigen Software-Weg', () => {
    const v = boxUebersicht(
      [box('box-2', 'Box Halle 2', true)], [version], [quelle()],
      new Map([['anlage-1', 'Halle 2']]), JETZT,
    )[0];
    expect(v.verbindung).toBe('Verbunden');
    expect(v.rolle).toBe('Führt Halle 2');
    expect(v.quellenSatz).toBe('Liest 1 Datenquelle');
    expect(v.budgetSumme).toBe('Zusammen 6 von 30 Anfragen/min');
    expect(v.faehigkeiten).toBe('Software 2.5.0 · Update nötig für: Rückmeldung je Datenquelle');
    expect(v.updateNoetig).toBe(true);
  });

  it('alte Boxen zeigen ehrlich, dass noch keine Rückmeldung je Quelle kommt', () => {
    expect(quellZeile(quelle({ rueckmeldung: null })).zustand).toBe('Box meldet noch nicht je Quelle');
  });
});
