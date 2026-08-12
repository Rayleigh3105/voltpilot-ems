import { describe, expect, it } from 'vitest';
import {
  BUILTIN_GESPERRT,
  bestand,
  fassungsZustand,
  gruppen,
  herkunft,
  pruefstand,
  ruecknahmeFolgen,
  spur,
  umfang,
  type AdminVorlage,
} from './adminVorlagen';

function v(over: Partial<AdminVorlage> = {}): AdminVorlage {
  return {
    templateRef: 'certified:acme:relais',
    kind: 'certified',
    version: 1,
    brand: 'acme',
    brandLabel: 'ACME',
    model: 'relais',
    modelLabel: 'Relais 16',
    communication: 'modbus_tcp',
    communicationLabel: 'Modbus TCP',
    transportSchema: [{ key: 'ip' }, { key: 'port' }],
    channels: null,
    writes: null,
    certificationStatus: 'certified',
    usedByComponents: 0,
    ...over,
  };
}

describe('adminVorlagen', () => {
  it('gruppiert je Schlüssel, neueste Fassung zuerst', () => {
    const g = gruppen([v({ version: 1 }), v({ version: 3 }), v({ version: 2 })]);
    expect(g).toHaveLength(1);
    expect(g[0].fassungen.map((f) => f.version)).toEqual([3, 2, 1]);
    expect(g[0].waehlbar?.version).toBe(3);
  });

  it('⚠ eine zurückgezogene Fassung fällt auf die VORHERIGE zurück', () => {
    const g = gruppen([v({ version: 1 }), v({ version: 2, withdrawnAt: '2026-08-12T10:00:00Z' })]);
    expect(g[0].waehlbar?.version).toBe(1);
    expect(fassungsZustand(g[0].fassungen[0], g[0]).label).toBe('Zurückgezogen');
    expect(fassungsZustand(g[0].fassungen[1], g[0]).label).toBe('In der Auswahl');
  });

  it('sind ALLE Fassungen zurückgezogen, ist die Vorlage nicht mehr wählbar', () => {
    const g = gruppen([
      v({ version: 1, withdrawnAt: '2026-08-12T10:00:00Z' }),
      v({ version: 2, withdrawnAt: '2026-08-12T11:00:00Z' }),
    ]);
    expect(g[0].waehlbar).toBeNull();
    expect(fassungsZustand(g[0].fassungen[0], g[0]).label).toBe('Zurückgezogen');
  });

  it('⚠ eine eingebaute Vorlage ist nicht editierbar und sagt WARUM', () => {
    const g = gruppen([v({ kind: 'builtin', templateRef: 'builtin:deye:sun' })]);
    expect(g[0].editierbar).toBe(false);
    expect(g[0].gesperrtWeil).toBe(BUILTIN_GESPERRT);
    expect(g[0].gesperrtWeil).toContain('Neustart');
    expect(g[0].gesperrtWeil).toContain('Katalog');
  });

  it('eine selbst eingetragene Vorlage IST editierbar', () => {
    expect(gruppen([v()])[0].editierbar).toBe(true);
    expect(gruppen([v()])[0].gesperrtWeil).toBeNull();
  });

  it('ein unbekanntes Wort behauptet nichts', () => {
    expect(herkunft('quatsch').label).toBe('Unbekannt');
    expect(herkunft(null).label).toBe('Unbekannt');
    expect(pruefstand('quatsch').label).toBe('Unbekannt');
    expect(pruefstand(undefined).ton).toBe('off');
  });

  it('unterscheidet die Prüf-Zustände in ihrem Ton', () => {
    expect(pruefstand('certified').ton).toBe('ok');
    expect(pruefstand('in_certification').ton).toBe('warn');
    expect(pruefstand('not_certified').ton).toBe('warn');
    expect(pruefstand('builtin').ton).toBe('off');
  });

  it('⚠ „keine Angabe" ist etwas anderes als „liefert nichts"', () => {
    expect(umfang(v())).toEqual([
      '2 Verbindungsfelder',
      'Messwerte: keine Angabe',
      'Schreiben: keine Angabe',
    ]);
    expect(umfang(v({ channels: [{}, {}], writes: [{}] }))).toEqual([
      '2 Verbindungsfelder',
      '2 Messwerte',
      '1 Schreib-Fähigkeiten',
    ]);
  });

  it('die Folgenliste nennt die nächste Fassung UND was gleich bleibt', () => {
    const g = gruppen([v({ version: 1 }), v({ version: 2, usedByComponents: 3 })])[0];
    const folgen = ruecknahmeFolgen(g, 2);
    expect(folgen[0]).toContain('Fassung 1');
    expect(folgen[1]).toContain('3 Komponenten');
    expect(folgen[1]).toContain('NICHT');
    expect(folgen[2]).toContain('nicht gelöscht');
  });

  it('ohne weitere Fassung sagt die Folgenliste die Wahrheit', () => {
    const g = gruppen([v({ version: 1 })])[0];
    expect(ruecknahmeFolgen(g, 1)[0]).toContain('nicht mehr zur Auswahl');
    expect(ruecknahmeFolgen(g, 1)[1]).toContain('keine Komponente');
  });

  it('die Papier-Spur nennt nur, was belegt ist', () => {
    expect(spur(v())).toEqual([]);
    expect(spur(v({ createdBy: 'admin-1', withdrawnBy: 'admin-2' }))).toEqual([
      'Eingetragen von admin-1',
      'Zurückgezogen von admin-2',
    ]);
  });

  it('der Kopf-Satz zählt nur Belegtes', () => {
    expect(bestand([])).toContain('leer');
    const list = gruppen([
      v({ kind: 'builtin', templateRef: 'builtin:a:b' }),
      v({ templateRef: 'certified:x:y' }),
      v({ templateRef: 'certified:z:z', withdrawnAt: '2026-08-12T10:00:00Z' }),
    ]);
    const satz = bestand(list);
    expect(satz).toContain('1 eingebaute');
    expect(satz).toContain('2 selbst eingetragene');
    expect(satz).toContain('1 nicht mehr wählbar');
  });
});
