import { describe, expect, it, vi } from 'vitest';
import type { SiteEntity } from './api';
import { BETRIEBSMODELLE, STEUERN_ENTWURF_SCHLUESSEL, entwurfSpeichern, grenzeFehler, hatSpeicher, komponentenZeilen, schrittZaehler } from './steuernAssistent';

const entity = (p: Partial<SiteEntity>): SiteEntity => ({
  id: 'k-1', entityType: 'meter', typeLabel: 'Zähler', role: 'grid', label: null,
  control: false, deviceId: null, capabilities: null, guards: null, syncStatus: 'in_sync', observed: null,
  edgeSourceId: null, ...p,
});

describe('SteuernAssistent — reine Regeln', () => {
  it('zeigt sechs Schritte', () => {
    expect(schrittZaehler(4)).toBe('Schritt 4 von 6');
  });

  it('spricht Steuerbarkeit ausschließlich aus dem API-Fakt control', () => {
    expect(komponentenZeilen([
      entity({ id: 'k-9', entityType: 'ocpp-charge-point', typeLabel: 'Ladepunkt', label: 'Parkplatz Halle 2', control: true }),
      entity({ id: 'ek-1', typeLabel: 'Energiekarte EK-1' }),
    ])).toEqual([
      { id: 'k-9', name: 'Parkplatz Halle 2', steuerbar: true, status: 'Steuerbar — Freigabe prüfen', weg: 'Verbindung und Freigabe prüfen' },
      { id: 'ek-1', name: 'Energiekarte EK-1', steuerbar: false, status: 'Nicht steuerbar (misst)', weg: null },
    ]);
  });

  it('prüft die Grenze gegen die vereinbarte Leistung', () => {
    expect(grenzeFehler('220', 200)).toBe('220 kW liegen über 200 kW vereinbarter Leistung — bitte prüfen.');
    expect(grenzeFehler('200', 200)).toBeNull();
  });

  it('Marktoptimierung ist eine Wahl, kein aktiver Zustand', () => {
    expect(BETRIEBSMODELLE.find((m) => m.id === 'arbitrage')).toEqual({
      id: 'arbitrage', label: 'Marktoptimierung', text: 'Günstige Stunden nutzen. Die Wahl schaltet noch nichts ein.',
    });
    expect(hatSpeicher([entity({ role: 'storage' })])).toBe(true);
  });

  it('bewahrt die vorbereitete Betriebsweise nur als Browser-Entwurf', () => {
    const setItem = vi.fn();
    entwurfSpeichern({ setItem }, { standortId: 'ST-1', anlageId: 'AN-2', steuerarten: {}, betriebsmodell: 'arbitrage' });
    expect(setItem).toHaveBeenCalledWith(STEUERN_ENTWURF_SCHLUESSEL,
      JSON.stringify({ standortId: 'ST-1', anlageId: 'AN-2', steuerarten: {}, betriebsmodell: 'arbitrage' }));
  });
});
