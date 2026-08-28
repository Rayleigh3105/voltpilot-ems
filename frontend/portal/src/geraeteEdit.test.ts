import { describe, expect, it } from 'vitest';
import type { ComponentTemplate, SiteComponentRow } from './api';
import {
  auswirkungen,
  brauchtVerbindungstest,
  delta,
  kundenRolle,
  normalisiereSecretEingabe,
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
