import { describe, expect, it } from 'vitest';
import type { ComponentTemplate, SiteComponentRow } from './api';
import {
  auswirkungen,
  brauchtVerbindungstest,
  delta,
  kundenRolle,
  normalisiereFeldEingabe,
  normalisiereSecretEingabe,
  verbindungFuerSpeichern,
} from './geraeteEdit';

const row: SiteComponentRow = {
  id: 'stable', role: 'battery-hybrid', entityType: 'battery-hybrid', label: 'Scheune',
  brand: 'deye', model: 'old', family: 'old-family', communication: 'modbus',
  connection: { ip: '10.0.0.2', password: '••••••••', reading_override: { server: true } },
  templateRef: 'old-template', templateVersion: 1, definitionVersion: 4,
};
const template: ComponentTemplate = {
  templateRef: 'old-template', kind: 'builtin', version: 1, brand: 'deye', brandLabel: 'Deye',
  model: 'old', modelLabel: 'Old', deviceType: 'inverter', family: 'old-family',
  communication: 'modbus', communicationLabel: 'Modbus',
  transportSchema: [
    { key: 'ip', label: 'IP-Adresse', required: true },
    { key: 'password', label: 'Kennwort', type: 'password', secret: true },
  ],
};

describe('revisionierter Geräte-Edit-Vertrag', () => {
  it('maps composed technical roles back to the customer role', () => {
    expect(kundenRolle(row)).toBe('inverter');
  });

  it('does not demand a test for name-only changes or server evidence', () => {
    expect(brauchtVerbindungstest(row, template, 1, { ...row.connection! })).toBe(false);
  });

  it('demands a test for exactly a changed template or connection', () => {
    expect(brauchtVerbindungstest(row, template, 1,
      { ...row.connection!, ip: '10.0.0.3' })).toBe(true);
    expect(brauchtVerbindungstest(row,
      { ...template, templateRef: 'new-template' }, 1, row.connection!)).toBe(true);
    expect(brauchtVerbindungstest(row, { ...template, version: 2 }, 2, row.connection!)).toBe(true);
  });

  it('never exposes an old secret in the delta and names identity continuity', () => {
    const rows = delta(row, template, 1, 'inverter', 'Neue Scheune',
      { ...row.connection!, password: 'changed-secret' }, '');
    expect(rows.find((entry) => entry.feld === 'Kennwort')).toEqual({
      feld: 'Kennwort', vorher: '••••••••', nachher: 'neu gesetzt',
    });
    expect(JSON.stringify(rows)).not.toContain('changed-secret');
    expect(auswirkungen(rows)[0]).toContain('Geräte-ID, Messhistorie, Transaktionen, Befehle und Audit');
  });

  it('restores the unchanged sentinel when an existing secret is cleared', () => {
    expect(normalisiereSecretEingabe(
      { key: 'password', type: 'password' }, '', '••••••••',
    )).toBe('••••••••');
    expect(normalisiereSecretEingabe(
      { key: 'password', type: 'password' }, '', undefined,
    )).toBe('');
  });
});

describe('Zahlenfelder gehen als Zahl hinaus (Scout vp-kundenanlage-drei-geraete)', () => {
  const huawei: ComponentTemplate = {
    ...template,
    transportSchema: [
      { key: 'ip', label: 'IP-Adresse', type: 'text', required: true },
      { key: 'port', label: 'Port', type: 'number', default: 502 },
      { key: 'unit_id', label: 'Modbus-Unit-ID', type: 'number', default: 0 },
      { key: 'invert_grid_sign', label: 'Netz-Vorzeichen invertieren', type: 'checkbox' },
      {
        key: 'control_write_fc', label: 'Schreib-Funktionscode', type: 'select',
        options: [{ value: 0, label: 'Automatisch' }, { value: 16, label: 'FC16' }],
      },
      {
        key: 'byte_order', label: 'Byte-Reihenfolge', type: 'select',
        options: [{ value: 'auto', label: 'Automatisch' }, { value: 'little', label: 'Little' }],
      },
    ],
  };

  it('wandelt die Eingabe nach dem Schema-Typ: "01" wird 1, Komma wie Punkt', () => {
    // Das echte Fehlerbild: "1" an die Vorgabe "0" angehängt ergibt "01".
    expect(normalisiereFeldEingabe(huawei.transportSchema![2], '01')).toBe(1);
    expect(normalisiereFeldEingabe(huawei.transportSchema![1], '4196')).toBe(4196);
    expect(normalisiereFeldEingabe(huawei.transportSchema![2], '1,5')).toBe(1.5);
    expect(normalisiereFeldEingabe(huawei.transportSchema![2], ' 7 ')).toBe(7);
  });

  it('lässt ein leeres Zahlenfeld leer und Unlesbares als Text (die API nennt dann das Feld)', () => {
    expect(normalisiereFeldEingabe(huawei.transportSchema![2], '')).toBe('');
    expect(normalisiereFeldEingabe(huawei.transportSchema![2], 'abc')).toBe('abc');
  });

  it('gibt eine Auswahl im Typ ihres Optionswerts zurück', () => {
    expect(normalisiereFeldEingabe(huawei.transportSchema![4], '16')).toBe(16);
    expect(normalisiereFeldEingabe(huawei.transportSchema![5], 'little')).toBe('little');
  });

  it('fasst Text, Haken und Felder ohne Typ nicht an', () => {
    expect(normalisiereFeldEingabe(huawei.transportSchema![0], '010')).toBe('010');
    expect(normalisiereFeldEingabe(huawei.transportSchema![3], true)).toBe(true);
    expect(normalisiereFeldEingabe({}, '01')).toBe('01');
  });

  it('verbindungFuerSpeichern schickt Zahlen als Zahl, lässt leere Zahlenfelder weg und repariert Altbestand', () => {
    expect(verbindungFuerSpeichern(huawei, {
      ip: '192.168.178.60', port: '502', unit_id: '01', invert_grid_sign: true,
      control_write_fc: '16', byte_order: 'auto',
    })).toEqual({
      ip: '192.168.178.60', port: 502, unit_id: 1, invert_grid_sign: true,
      control_write_fc: 16, byte_order: 'auto',
    });
    expect(verbindungFuerSpeichern(huawei, { ip: '192.168.178.60', port: '', unit_id: '' }))
      .toEqual({ ip: '192.168.178.60' });
  });
});

