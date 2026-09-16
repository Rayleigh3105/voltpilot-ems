import { describe, expect, it } from 'vitest';
import { ApiError, type Device, type UemsDatenquelle } from './api';
import { geplanterWechsel, tauschFehler, tauschFolgen, wechselFolgen } from './boxDialoge';

const box = (id: string, name: string): Device => ({
  id, siteId: 'an-2', externalRef: `VP-${id}`, kind: 'edge', name, status: 'claimed',
  lastSeenAt: null, createdAt: null,
});
const quelle = {
  id: 'dq-3', kennzeichen: 'DQ-3', name: 'Netzzähler', anlage: 'an-1', protokoll: 'modbus_tcp',
  adresse: '192.168.10.31:502', geraete_ids: [1], netz: 'VLAN 10', mehrere_leser: false,
  steuerquelle: false, vergleichsquelle: false, kadenz_s: 60, archiviert_am: null,
  zustaendige_box: { id: 'e-1', name: 'Box Halle 1', heimat_anlage: 'an-1' },
  zeitraeume: [],
} satisfies UemsDatenquelle;

describe('Dialog-Ableitungen für Boxen und Datenquellen', () => {
  it('spricht die Folgen des Quellenwechsels im entschiedenen AP-04-Wortlaut', () => {
    expect(wechselFolgen(quelle, box('e-2', 'Box Halle 2'), 'Ab 10.04.2027 07:30')).toEqual([
      'Die Messstellen an DQ-3 behalten ihre Quelle.',
      'Ab 10.04.2027 07:30 liest Box Halle 2.',
      'Die Übergabe erfolgt mit einer kurzen Lücke (unter 1 Minute), sichtbar im Verlauf.',
    ]);
  });

  it('nennt beim Tausch alle übernommenen Aufgaben und den unveränderten Belegbestand', () => {
    const saetze = tauschFolgen(box('0482', 'Box Halle 2'), box('0090', 'Box Halle 2 (neu)'),
      [{ kennzeichen: 'DQ-4' }, { kennzeichen: 'DQ-5' }], true);
    expect(saetze.join(' ')).toContain('Heimat-Anlage, Rolle führende Box, Datenquellen DQ-4, DQ-5');
    expect(saetze.join(' ')).toContain('Messwert-Auswahl, Freigaben, Update-Zuordnung');
    expect(saetze.join(' ')).toContain('Werte und Protokolle bleiben');
  });

  it('übersetzt die Ablehnungsgründe des Nachfolger-Wegs in Kundensätze', () => {
    expect(tauschFehler(new ApiError(409, 'Konflikt', {
      grund: 'nachfolger_andere_heimat', satz: 'technischer Satz',
    }))).toBe('Ein Box-Tausch ist nur innerhalb derselben Anlage möglich.');
    expect(tauschFehler(new ApiError(409, 'Konflikt', {
      grund: 'nachfolger_belegt', satz: 'Die neue Box hat bereits eigene Aufgaben.',
    }))).toBe('Die neue Box hat bereits eigene Aufgaben.');
    expect(tauschFehler(new ApiError(404, 'fehlt'))).toContain('nicht gefunden');
  });

  it('findet nur einen noch nicht wirksamen Wechsel für die Rücknahme', () => {
    const z = { id: 'plan', box: quelle.zustaendige_box!, effective_from: '2027-04-10T05:30:00Z', effective_to: null };
    expect(geplanterWechsel({ zeitraeume: [z] }, new Date('2027-04-09T12:00:00Z'))?.id).toBe('plan');
    expect(geplanterWechsel({ zeitraeume: [z] }, new Date('2027-04-10T05:30:00Z'))).toBeNull();
  });
});
