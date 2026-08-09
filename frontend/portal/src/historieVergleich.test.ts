import { describe, expect, it } from 'vitest';
import {
  angleichen,
  delta,
  ENERGIE_WERTUNG,
  fuehrendesDelta,
  keineVergleichsDatenText,
  laufendHinweis,
  normalisiereModus,
  ueberlagerungAktiv,
  ueberlagerungLegende,
  vergleichsAnker,
  vergleichsAnkerFor,
  vergleichsChip,
  vergleichsKopf,
  vergleichsName,
  vergleichsOptionen,
  vorjahrVerfuegbar,
  wirksamerModus,
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

/**
 * **F8 — zwei Zeiträume überlagern.** Der zweite Abruf ist technisch derselbe
 * wie das Δ (F3); neu ist nur, WELCHE Periode gewählt werden kann und dass
 * beide Flächen dieselbe Wahl lesen.
 */
describe('F8 · gegen welchen Zeitraum überlagert wird', () => {
  const cov = (firstDataAt: string | null) => ({
    firstDataAt,
    lastDataAt: '2026-07-30T11:45:00Z',
    expectedFrom: '',
    expectedTo: '',
    expectedBuckets: 100,
    measuredBuckets: 100,
    gaps: 0,
    resolutionMinutes: 15,
  });

  it('verschiebt den Anker je nach Wahl - Vorperiode oder Vorjahr', () => {
    expect(vergleichsAnkerFor(JULI, 'month', 'vorperiode').getMonth()).toBe(5);
    const vj = vergleichsAnkerFor(JULI, 'month', 'vorjahr');
    expect([vj.getFullYear(), vj.getMonth(), vj.getDate()]).toEqual([2025, 6, 1]);
  });

  it('lässt „Aus" das Δ NICHT verstummen - es bleibt die Vorperiode', () => {
    // Sonst könnten Δ-Zeile und Überlagerung sich widersprechen, weil jede ihre
    // eigene Vorperiode wählte. Es gibt genau diese eine Quelle.
    expect(wirksamerModus('aus')).toBe('vorperiode');
    expect(ueberlagerungAktiv('aus')).toBe(false);
    expect(ueberlagerungAktiv('vorperiode')).toBe(true);
    expect(vergleichsAnkerFor(JULI, 'month', 'aus').getMonth()).toBe(5);
  });

  it('benennt den Vorjahres-Zeitraum mit seinem Jahr', () => {
    expect(vergleichsName(JULI, 'month', 'vorjahr')).toBe('Juli 2025');
    expect(vergleichsKopf(JULI, 'month', 'vorjahr')).toBe('Vergleich: Juli 2025');
    // Ohne Modus-Angabe bleibt alles wie vor F8.
    expect(vergleichsName(JULI, 'month')).toBe('Juni');
  });

  it('bietet das Vorjahr NUR beim Monat an - und nur, wo Daten liegen können', () => {
    expect(vorjahrVerfuegbar(JULI, 'month', cov('2024-01-01T12:00:00Z'))).toBe(true);
    // Die Anlage misst erst seit Juni 2026 - Juli 2025 gibt es nicht.
    expect(vorjahrVerfuegbar(JULI, 'month', cov('2026-06-19T12:00:00Z'))).toBe(false);
    expect(vorjahrVerfuegbar(JULI, 'day', cov('2024-01-01T12:00:00Z'))).toBe(false);
    expect(vorjahrVerfuegbar(JULI, 'year', cov('2024-01-01T12:00:00Z'))).toBe(false);
    // Ohne Abdeckungsdaten wird nichts behauptet - die Wahl bleibt offen.
    expect(vorjahrVerfuegbar(JULI, 'month', null)).toBe(true);
    expect(vorjahrVerfuegbar(JULI, 'month', cov(null))).toBe(true);
  });

  it('nennt die Wahlmöglichkeiten beim Namen des Zeitraums', () => {
    const o = vergleichsOptionen(JULI, 'month', cov('2024-01-01T12:00:00Z'));
    expect(o.map((x) => x.id)).toEqual(['aus', 'vorperiode', 'vorjahr']);
    expect(o.map((x) => x.label)).toEqual(['Aus', 'Juni 2026', 'Juli 2025']);
    // Ein Tages-Zeitraum hat keine Vorjahres-Wahl.
    expect(vergleichsOptionen(JULI, 'day', null).map((x) => x.id)).toEqual(['aus', 'vorperiode']);
  });

  it('lässt ein mitgebrachtes „Vorjahr" auf die Vorperiode zurückfallen, wo es das nicht gibt', () => {
    expect(normalisiereModus('vorjahr', JULI, 'day', null)).toBe('vorperiode');
    expect(normalisiereModus('vorjahr', JULI, 'month', cov('2026-06-19T12:00:00Z'))).toBe(
      'vorperiode',
    );
    expect(normalisiereModus('vorjahr', JULI, 'month', null)).toBe('vorjahr');
    expect(normalisiereModus('aus', JULI, 'day', null)).toBe('aus');
  });

  it('sagt in der Legende, welcher Zeitraum durchgezogen und welcher blass liegt', () => {
    expect(ueberlagerungLegende(JULI, 'month', 'aus')).toBeNull();
    const l = ueberlagerungLegende(JULI, 'month', 'vorjahr')!;
    expect(l.aktuell).toBe('Juli 2026');
    expect(l.vergleich).toBe('Juli 2025');
    expect(l.satz).toBe('Durchgezogen: Juli 2026 · blass gestrichelt: Juli 2025');
  });

  it('sagt eine datenlose Vergleichsperiode, statt sie zu zeichnen', () => {
    expect(keineVergleichsDatenText(JULI, 'month', 'vorjahr')).toBe(
      'Keine Daten für Juli 2025 — es gibt nichts zu überlagern.',
    );
  });

  it('richtet ungleich lange Zeiträume am INDEX aus - Lücke statt gestrecktem Wert', () => {
    // 28 Tage gegen 31: der Rest ist ehrlich leer, nichts wird gedehnt.
    expect(angleichen([1, 2], 4)).toEqual([1, 2, null, null]);
    // Und der Überhang wird abgeschnitten, nie in den Nachbarabschnitt gemalt.
    expect(angleichen([1, 2, 3, 4], 2)).toEqual([1, 2]);
    expect(angleichen([1, null, 3], 3)).toEqual([1, null, 3]);
    expect(angleichen(null, 2)).toEqual([null, null]);
  });

  it('zeigt einen GESETZTEN Vergleich als Chip - und schweigt bei „Aus"', () => {
    // Mobil wandert die Bedienung ins ⋯-Blatt; der Zustand darf damit nicht
    // unsichtbar werden, sonst überlagert das Diagramm eine ungefragte Reihe.
    expect(vergleichsChip(JULI, 'month', 'aus')).toBeNull();
    expect(vergleichsChip(JULI, 'month', 'vorperiode')).toBe('Vergleich: Juni 2026');
    expect(vergleichsChip(JULI, 'month', 'vorjahr')).toBe('Vergleich: Juli 2025');
    // Er sagt exakt dasselbe wie die Kopfzeile der Karte - eine Wahrheit.
    expect(vergleichsChip(JULI, 'month', 'vorjahr')).toBe(vergleichsKopf(JULI, 'month', 'vorjahr'));
  });
});

/**
 * Die EINE Δ-Zeile der Mobil-Fassung. Sie ersetzt sechs Einzel-Δ und muss
 * deshalb NENNEN, worüber sie spricht - „etwa gleich" ohne Gegenstand wäre ein
 * Vergleich, den niemand nachrechnen kann.
 */
describe('fuehrendesDelta', () => {
  const summen = (werte: (number | null)[]) =>
    (['erzeugt', 'verbraucht', 'bezogen', 'eingespeist', 'geladen', 'entladen'] as const).map(
      (key, i) => ({ key, label: key[0].toUpperCase() + key.slice(1), kwh: werte[i] ?? null }),
    );

  it('nimmt die ERSTE Summe mit ehrlicher Basis und nennt sie beim Namen', () => {
    const d = fuehrendesDelta(
      summen([120, 40, 10, 80, 30, 25]),
      summen([100, 40, 10, 80, 30, 25]),
      'dem Vortag',
    );
    expect(d?.label).toBe('Erzeugt');
    expect(d?.view.text).toBe('20 % mehr als am Vortag');
    expect(d?.view.wertung).toBe('gut');
  });

  it('überspringt eine Summe ohne Vergleichsbasis, statt zu schweigen', () => {
    // Eine Anlage ohne PV: „Erzeugt" hat nichts zu vergleichen, „Verbraucht"
    // schon - der Vergleich fällt also auf die nächste GEMESSENE Größe.
    const d = fuehrendesDelta(
      summen([null, 50, 10, 0, 30, 25]),
      summen([null, 40, 10, 0, 30, 25]),
      'dem Vortag',
    );
    expect(d?.label).toBe('Verbraucht');
    expect(d?.view.richtung).toBe('mehr');
    // Verbrauch ist keine Leistung - die Richtung ist die Tatsache, nicht eine
    // Wertung (Regel 3 bleibt auch in der Kurzfassung gültig).
    expect(d?.view.wertung).toBe('neutral');
  });

  it('bleibt ohne Vorperiode und ohne jede Basis STUMM', () => {
    expect(fuehrendesDelta(summen([120]), null, 'dem Vortag')).toBeNull();
    expect(fuehrendesDelta(summen([120]), undefined, 'dem Vortag')).toBeNull();
    // Nirgends eine Basis: nie ein Δ gegen eine erfundene Null.
    expect(
      fuehrendesDelta(summen([120, 40]), summen([null, null]), 'dem Vortag'),
    ).toBeNull();
    expect(fuehrendesDelta(summen([120, 40]), summen([0, 0]), 'dem Vortag')).toBeNull();
  });
});
