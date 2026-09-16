import { describe, expect, it, vi } from 'vitest';
import type { FunktionFreigabeZeile, SiteEntity } from './api';
import { BETRIEBSMODELLE, STEUERN_ENTWURF_SCHLUESSEL, entwurfSpeichern, freigabeDarstellung, grenzeFehler, hatSpeicher, komponentenZeilen, schrittZaehler } from './steuernAssistent';

const entity = (p: Partial<SiteEntity>): SiteEntity => ({
  id: 'k-1', entityType: 'meter', typeLabel: 'Zähler', role: 'grid', label: null,
  control: false, deviceId: null, capabilities: null, guards: null, syncStatus: 'in_sync', observed: null,
  edgeSourceId: null, ...p,
});

const freigabe = (p: Partial<FunktionFreigabeZeile>): FunktionFreigabeZeile => ({
  entity_id: 'k-1', name: 'Komponente', weg: 'selbstbau', freigegeben: false,
  status: 'Schalt-Test und Freigabe erforderlich', station_verbunden: null, steuerart_gesetzt: null, ...p,
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

  it('bindet den Selbstbau-Weg mit Pflicht-Test und bestehender Freigabe-Frage ein', () => {
    expect(freigabeDarstellung(freigabe({ name: 'Wärmepumpe' }))).toEqual({
      titel: 'Wärmepumpe', status: 'Schalt-Test und Freigabe erforderlich',
      hinweis: 'Vor der Freigabe führt der Assistent den Schalt-Test durch und fragt „Steuern freigeben?“.',
      aktion: 'Schalt-Test und Freigabe',
    });
  });

  it('zeigt beim OCPP-Weg Station und Steuerart getrennt', () => {
    expect(freigabeDarstellung(freigabe({
      weg: 'ocpp', name: 'Parkplatz Halle 2', status: 'Station verbunden · Steuerart gesetzt',
      freigegeben: true, station_verbunden: true, steuerart_gesetzt: true,
    }))).toEqual({
      titel: 'Parkplatz Halle 2', status: 'Station verbunden · Steuerart gesetzt',
      hinweis: 'Die Steuerart des Ladepunkts ist gesetzt.', aktion: null,
    });
  });

  it('lässt die Scharfschaltung des Wechselrichters sichtbar bei VoltPilot', () => {
    expect(freigabeDarstellung(freigabe({
      weg: 'wechselrichter', name: 'Batteriespeicher', status: 'Freischaltung durch VoltPilot steht aus',
    }))).toEqual({
      titel: 'Wir schalten die Steuerung für Ihren Wechselrichter frei — VoltPilot',
      status: 'Freischaltung durch VoltPilot steht aus', hinweis: 'Batteriespeicher', aktion: null,
    });
  });
});
