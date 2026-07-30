import { describe, expect, it } from 'vitest';
import {
  delta,
  ENERGIE_WERTUNG,
  laufendHinweis,
  vergleichsAnker,
  vergleichsKopf,
  vergleichsName,
} from './historieVergleich';

const JULI = new Date(2026, 6, 15, 12); // Mi, 15.07.2026
const NOW = new Date(2026, 6, 30, 14, 7);

/**
 * F3 — Δ zur Vorperiode. Die billigste Form von „nachschauen": ein zweiter
 * Abruf desselben Endpunkts mit verschobenem Anker beantwortet „ist das viel?"
 * ohne dass jemand blättern muss.
 */
describe('F3 · wohin der Vergleich schaut', () => {
  it('nimmt genau die bestehende Blätter-Geste, damit beide nie auseinanderlaufen', () => {
    expect(vergleichsAnker(JULI, 'month').getMonth()).toBe(5); // Juni
    expect(vergleichsAnker(JULI, 'year').getFullYear()).toBe(2025);
    expect(vergleichsAnker(JULI, 'day').getDate()).toBe(14);
    expect(vergleichsAnker(JULI, 'week').getDate()).toBe(8);
  });

  it('nennt die Vorperiode, wie ein Mensch sie sagt', () => {
    expect(vergleichsName(JULI, 'month')).toBe('Juni');
    expect(vergleichsName(JULI, 'day')).toBe('dem Vortag');
    expect(vergleichsName(JULI, 'week')).toBe('der Vorwoche');
    expect(vergleichsName(JULI, 'year')).toBe('2025');
    // Über die Jahresgrenze gehört das Jahr dazu - „Dezember" allein wäre
    // eine andere Aussage.
    expect(vergleichsName(new Date(2026, 0, 15, 12), 'month')).toBe('Dezember 2025');
  });

  it('setzt die Vergleichsperiode als Kopfzeile der Karte', () => {
    expect(vergleichsKopf(JULI, 'month')).toBe('Vergleich: Juni 2026');
  });
});

describe('F3 · eine laufende Periode wird als solche beschriftet', () => {
  it('sagt beim laufenden Monat, dass die Vorperiode vollständig ist', () => {
    const hinweis = laufendHinweis(NOW, 'month', NOW);
    expect(hinweis).toContain('läuft noch');
    expect(hinweis).toContain('Juni 2026');
  });

  it('schweigt bei einem abgeschlossenen Zeitraum - da gibt es nichts klarzustellen', () => {
    expect(laufendHinweis(new Date(2026, 4, 15, 12), 'month', NOW)).toBeNull();
  });
});

describe('F3 · das Δ selbst', () => {
  it('rechnet Richtung, Prozent und Satz', () => {
    const mehr = delta(11763, 9968, true, 'Juni')!;
    expect(mehr.richtung).toBe('mehr');
    expect(mehr.pct).toBe(18);
    expect(mehr.text).toBe('18 % mehr als im Juni');
    expect(mehr.wertung).toBe('gut');

    const weniger = delta(1227, 1348, false, 'Juni')!;
    expect(weniger.richtung).toBe('weniger');
    expect(weniger.pct).toBe(9);
    expect(weniger.text).toBe('9 % weniger als im Juni');
    // Weniger Netzbezug ist eindeutig gut.
    expect(weniger.wertung).toBe('gut');
  });

  it('sagt bei kleinen Änderungen „etwa wie" statt einer Richtung', () => {
    const flach = delta(102, 100, true, 'Juni')!;
    expect(flach.richtung).toBe('gleich');
    expect(flach.text).toBe('etwa wie im Juni');
    expect(flach.wertung).toBe('neutral');
  });

  it('formuliert den Namen im richtigen Fall', () => {
    expect(delta(120, 100, null, 'dem Vortag')!.text).toBe('20 % mehr als am Vortag');
    expect(delta(120, 100, null, 'der Vorwoche')!.text).toBe('20 % mehr als in der Vorwoche');
    // Eine Jahreszahl steht bloß - „im 2025" wäre kein Deutsch.
    expect(delta(120, 100, null, '2025')!.text).toBe('20 % mehr als 2025');
  });

  it('gibt es NICHT ohne Vergleichsbasis - nie gegen eine erfundene Null', () => {
    // Die Vorperiode trug den Kanal gar nicht.
    expect(delta(500, null, true, 'Juni')).toBeNull();
    expect(delta(500, undefined, true, 'Juni')).toBeNull();
    // Der aktuelle Wert fehlt.
    expect(delta(null, 500, true, 'Juni')).toBeNull();
    // Eine (nahezu) Null als Nenner ergäbe „+∞ %".
    expect(delta(500, 0, true, 'Juni')).toBeNull();
    expect(delta(500, 0.01, true, 'Juni')).toBeNull();
    expect(delta(Number.NaN, 100, true, 'Juni')).toBeNull();
  });

  it('bleibt neutral, wo die Richtung nicht eindeutig ist', () => {
    // Mehr Verbrauch ist weder gut noch schlecht - es ist der Bedarf des Hauses.
    expect(delta(120, 100, null, 'Juni')!.wertung).toBe('neutral');
    // Mehr Erzeugung ist gut, weniger schlecht.
    expect(delta(80, 100, true, 'Juni')!.wertung).toBe('schlecht');
  });

  it('wertet nur die zwei eindeutigen Energiesummen', () => {
    expect(ENERGIE_WERTUNG.erzeugt).toBe(true);
    expect(ENERGIE_WERTUNG.bezogen).toBe(false);
    // Eine Eigenverbrauchs-Anlage will WENIGER einspeisen - also keine Wertung.
    expect(ENERGIE_WERTUNG.eingespeist).toBeNull();
    expect(ENERGIE_WERTUNG.verbraucht).toBeNull();
    expect(ENERGIE_WERTUNG.geladen).toBeNull();
    expect(ENERGIE_WERTUNG.entladen).toBeNull();
  });
});
