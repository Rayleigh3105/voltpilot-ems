import { describe, expect, it } from 'vitest';
import { editorEntities, type EntityAdminDto } from './flowsApi';

const row = (over: Partial<EntityAdminDto>): EntityAdminDto => ({
  id: '7f1f999e-21cf-4ac5-87e9-8a1b2c3d4e5f', entityType: 'battery-hybrid', role: 'battery-hybrid', label: null, capabilities: null,
  ...over,
});

describe('editorEntities (Admin-Durchgang F19)', () => {
  it('nennt eine Entität ohne eigenen Namen nach ihrem Typ, nie nach ihrer Kennung', () => {
    const [e] = editorEntities([row({})]);
    expect(e.label).toBe('Batteriespeicher');
    expect(e.label).not.toContain('7f1f999e');
  });

  it('behält einen eigenen Namen und nummeriert gleiche Typwörter, damit die Auswahl eindeutig bleibt', () => {
    const liste = editorEntities([
      row({ id: 'a', entityType: 'wallbox', label: null }),
      row({ id: 'b', entityType: 'wallbox', label: '  ' }),
      row({ id: 'c', entityType: 'grid-meter', label: 'Zähler Halle' }),
      row({ id: 'd', entityType: null }),
    ]);
    expect(liste.map((e) => e.label)).toEqual(['Wallbox 1', 'Wallbox 2', 'Zähler Halle']);
  });
});
