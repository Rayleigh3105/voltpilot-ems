import { describe, expect, it } from 'vitest';
import {
  ablehnung,
  braucheAufmerksamkeit,
  freigabe,
  kopfSatz,
  pflegeOrt,
  quellenText,
  selbstbauZeilen,
  sollIst,
  type FlottenAnlage,
} from './adminKomponentenFlotte';

function a(over: Partial<FlottenAnlage> = {}): FlottenAnlage {
  return {
    siteId: 's1',
    siteName: 'Pilsting',
    tenantId: 't1',
    tenantName: 'Kunde A',
    componentAuthority: 'portal',
    componentCount: 4,
    sources: { builtin: 1, certified: 0, custom: 0, composed: 3, unknown: 0 },
    privateTemplates: 0,
    syncStatus: 'in_sync',
    ...over,
  };
}

describe('adminKomponentenFlotte', () => {
  it('nennt den Pflege-Ort, und alles außer „portal“ ist die Box', () => {
    expect(pflegeOrt('portal').label).toBe('Im Portal');
    expect(pflegeOrt('box').label).toBe('An der Box');
    expect(pflegeOrt(null).label).toBe('An der Box');
    expect(pflegeOrt('quatsch').label).toBe('An der Box');
  });

  it('⚠ „nicht gemeldet“ ist KEIN Warnton - nur „ausstehend“ ist einer', () => {
    expect(sollIst('unreported').ton).toBe('off');
    expect(sollIst('pending').ton).toBe('warn');
    expect(sollIst('in_sync').ton).toBe('ok');
    expect(sollIst('quatsch').label).toBe('Unbekannt');
  });

  it('die Herkunft nennt nur, was da ist', () => {
    expect(quellenText(null)).toBe('Noch keine Komponenten');
    expect(quellenText({ builtin: 0, certified: 0, custom: 0, composed: 0, unknown: 0 }))
      .toBe('Noch keine Komponenten');
    expect(quellenText({ builtin: 2, certified: 1, custom: 3, composed: 0, unknown: 1 }))
      .toBe('2× Katalog · 1× geprüfte Vorlage · 3× Selbstbau · 1× ohne Angabe');
  });

  it('⚠ eine nicht gemeldete Freigabe-Herkunft wird BENANNT, nie als „nicht freigegeben“ gelesen', () => {
    const w = freigabe({ controlPoints: 1, platformActivated: 1, templateWrites: 0 });
    expect(w.text).toContain('1 Komponente darf schreiben');
    expect(w.belege).toContain('1 Gerät scharfgeschaltet');
    expect(w.belege).toContain('Herkunft der Freigabe nicht gemeldet');
    expect(w.belege.join(' ')).not.toContain('nicht freigegeben');
  });

  it('die drei Freigabe-Stufen erscheinen nebeneinander', () => {
    const w = freigabe({
      controlPoints: 2,
      platformActivated: 1,
      templateWrites: 3,
      certSource: 'device',
    });
    expect(w.belege).toEqual([
      '1 Gerät scharfgeschaltet',
      '3× über eine geprüfte Vorlage',
      'Am Gerät selbst freigegeben',
    ]);
    expect(w.ton).toBe('ok');
  });

  it('eine nur lesende Anlage bekommt gar keinen Satz', () => {
    expect(freigabe(null).text).toBeNull();
    expect(freigabe({ controlPoints: 0, platformActivated: 0, templateWrites: 0 }).text).toBeNull();
  });

  it('die Ablehnung nennt Grund und Fassung, sonst gibt es keine', () => {
    expect(ablehnung(a())).toBeNull();
    expect(ablehnung(a({ refusedReason: 'Unbekannter Treiber', refusedRevision: 'r7' })))
      .toBe('Die Box hat eine Fassung abgelehnt (Fassung r7): Unbekannter Treiber');
  });

  it('Aufmerksamkeit: Ablehnung vor ausstehend, Stilles gar nicht', () => {
    const liste = [
      a({ siteId: 'p', syncStatus: 'pending' }),
      a({ siteId: 'still', syncStatus: 'unreported' }),
      a({ siteId: 'r', refusedReason: 'kaputt' }),
    ];
    expect(braucheAufmerksamkeit(liste).map((x) => x.siteId)).toEqual(['r', 'p']);
  });

  it('der Kopf-Satz zählt nur Belegtes und nennt Stilles getrennt', () => {
    expect(kopfSatz([])).toContain('Noch keine Anlage');
    const satz = kopfSatz([
      a(),
      a({ siteId: 's2', componentAuthority: 'box' }),
      a({ siteId: 's3', syncStatus: 'unreported' }),
    ]);
    expect(satz).toContain('2 im Portal gepflegt');
    expect(satz).toContain('1 noch an der Box');
    expect(satz).toContain('1 ohne Rückmeldung');
  });

  it('der Selbstbau-Blick nimmt eigene Geräte UND eigene Vorlagen', () => {
    const liste = [
      a({ siteId: 'nix' }),
      a({ siteId: 'geraet', sources: { builtin: 0, certified: 0, custom: 2, composed: 0, unknown: 0 } }),
      a({ siteId: 'vorlage', privateTemplates: 1 }),
    ];
    expect(selbstbauZeilen(liste).map((x) => x.siteId)).toEqual(['geraet', 'vorlage']);
  });
});
