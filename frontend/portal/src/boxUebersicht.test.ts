import { describe, expect, it } from 'vitest';
import type { Device, EdgeVersion, UemsDatenquelle } from './api';
import { kastenSatz } from './aufbauTabelle';
import { aufbauDerAnlage, boxGeraeteBlock, type AnlageDaten } from './boxGeraete';
import { boxLast, boxUebersicht, budgetAnteil, lastText, quellZeile } from './boxUebersicht';
import { fuehrendeBoxOf } from './geraetSeite';
import { dq, gatewayForm, goreDq1, goreForm, hsWege, liefert } from './test/boxGeraeteFixtures';

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
      [{ ...version, supports: ['data_sources', 'geraetesuche'], capabilities: ['data_sources', 'geraetesuche'] }],
      new Map([['anlage-1', 'Halle 2']]), JETZT,
    );
    expect(result.find((b) => b.id === 'box-2')?.faehigkeiten).toBe('Software 2.5.0 · alle Fähigkeiten');
    expect(result.find((b) => b.id === 'box-1')?.faehigkeiten).toContain('Rückmeldung je Datenquelle');
  });

  it('kein Update-Hinweis für Zuständigkeit ab Zeitpunkt: der Cloud-Zeitgeber erbringt sie für jede Box', () => {
    const [v] = boxUebersicht(
      [box('box-2', 'Box Halle 2', true)],
      [{ ...version, capabilities: ['data_sources', 'geraetesuche'] }],
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

  it('zeigt je Box Verbindung, Rolle und den nötigen Software-Weg', () => {
    const v = boxUebersicht(
      [box('box-2', 'Box Halle 2', true)], [version],
      new Map([['anlage-1', 'Halle 2']]), JETZT,
    )[0];
    expect(v.verbindung).toBe('Verbunden');
    expect(v.rolle).toBe('Führt Halle 2');
    expect(v.faehigkeiten).toBe('Software 2.5.0 · Update nötig für: Rückmeldung je Datenquelle, Gerätesuche');
    expect(v.updateNoetig).toBe(true);
  });

  /**
   * GE-4: die Seite „Standort › Boxen" zählte nur Datenquellen („Liest 1 Datenquelle"); sie ist seit 28.09.2026 im
   * Standort › Aufbau aufgegangen. Dort — und in Anlage › Aufbau, derselben `AufbauSection` — sagt die Box-Zeile
   * jetzt „n Geräte · Last p %": die Kästen aus der Zuordnung von GE-1, die Last aus `boxLast`, derselben Rechnung
   * wie „Geräte an dieser Box" auf der Box-Seite.
   */
  describe('Box-Zeile im Aufbau: „n Geräte · Last p %" — eine Rechnung mit der Box-Seite (GE-4)', () => {
    const NOW = Date.parse('2026-10-23T09:42:30Z');
    /** Was die Box-Zeile im Aufbau sagt, und was die Box-Seite derselben Box als Kurzsatz rechnet. */
    const beide = (d: AnlageDaten) => {
      const b = aufbauDerAnlage(d)!.boxen[0];
      const block = boxGeraeteBlock({
        boxId: b.id, boxRef: b.ref, siteId: d.siteId, box: b, datenquellen: d.datenquellen, zuordnung: d.uemsGeraete != null,
      });
      return { zeile: [kastenSatz(b.geraete, b.wege), b.last].filter(Boolean).join(' · '), seite: block.kurz };
    };

    it('Gore: „1 Gerät · Last 51 %" statt „Liest 1 Datenquelle" — die Steuerung ist das Gerät, DQ-1 ihr Weg', () => {
      expect(beide(goreForm(NOW))).toEqual({ zeile: '1 Gerät · Last 51\u00a0%', seite: '1 Gerät · Last 51\u00a0%' });
    });

    it('Gateway-Form: Geräte hinter dem Gateway zählen, Gateway und offener Anschluss stehen daneben', () => {
      const satz = '5 Geräte · 1 Gateway · 1 Anschluss offen · Last 40\u00a0%';
      expect(beide(gatewayForm(NOW))).toEqual({ zeile: satz, seite: satz });
    });

    it('meldet die Box keine Zahl, steht keine da — nie „0 %"; liest sie keinen Weg, steht keine Last', () => {
      expect(beide(goreForm(NOW, { datenquellen: [goreDq1(NOW, { rueckmeldung: null })] })).zeile).toBe('1 Gerät · Last nicht gemeldet');
      expect(beide(goreForm(NOW, { datenquellen: [] })).zeile).toBe('1 Gerät');
    });

    it('die Last zählt jeden Weg, den die Box liest, als Summe — auch für eine Nachbaranlage; archivierte nie', () => {
      const [wr, gw] = hsWege(NOW);
      const fremd = dq({ id: 'dq-9', kennzeichen: 'DQ-9', anlage: 'site-2', rueckmeldung: liefert(NOW, 6, 0) }, { id: 'box-hs', name: null });
      const alt = { ...fremd, id: 'dq-8', kennzeichen: 'DQ-8', archiviert_am: '2026-10-01T00:00:00Z' };
      const l = boxLast('box-hs', [wr, gw, fremd, alt]);
      expect(l.quellen.map((q) => q.kennzeichen)).toEqual(['DQ-1', 'DQ-3', 'DQ-9']);
      expect([l.last.anfragen, l.last.messwerte, l.kurz]).toEqual([17, 176, 'Last 57\u00a0%']);
      expect(boxLast('box-andere', [wr, gw]).kurz).toBeNull();
      expect(lastText(0.2)).toBe('Last unter 1\u00a0%');
    });
  });

  it('alte Boxen zeigen ehrlich, dass noch keine Rückmeldung je Quelle kommt', () => {
    expect(quellZeile(quelle({ rueckmeldung: null })).zustand).toBe('Box meldet noch nicht je Quelle');
  });
});
