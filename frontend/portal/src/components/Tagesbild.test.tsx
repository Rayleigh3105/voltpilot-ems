import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Tagesbild } from './Tagesbild';
import type { History, HistoryBucket, SiteEarningsBucket } from '../api';
import { PANELS } from '../chartStyle';
import { chartTheme } from '../chartTheme';
import { PANEL_TITEL, REIHE } from '../tagesbild';

/**
 * Das Canvas ist echarts' Sache (jsdom hat keins), also wird die Einrichtung
 * hier weggestubbt — und der Mock RECHNET die Render-Closure aus und fängt ihr
 * `setOption`-Objekt ab. Nur so ist die PANEL-STRUKTUR beobachtbar: dass die
 * drei Flächen wirklich drei Grids sind, dass sie dieselbe Zeitachse tragen und
 * dass die „Jetzt"-Fahne genau EINMAL auftaucht, sieht man ausschließlich hier.
 */
let lastOption: any = null;
vi.mock('../useEChart', () => ({
  useEChart: (render: (chart: any, width: number) => void) => {
    lastOption = null;
    render(
      {
        getZr: () => ({ on: () => {}, off: () => {} }),
        containPixel: () => false,
        convertFromPixel: () => 0,
        setOption: (opt: any) => {
          lastOption = opt;
        },
      },
      900,
    );
    return { current: null };
  },
}));

function serie(name: string): any {
  return (lastOption?.series ?? []).find((s: any) => s?.name === name);
}

/** Alle markLine-Einträge ALLER Serien, die ein SICHTBARES Label tragen. */
function fahnen(): any[] {
  return (lastOption?.series ?? []).flatMap((s: any) =>
    (s?.markLine?.data ?? []).filter((m: any) => m?.label && m.label.show !== false),
  );
}

const NOW = new Date('2026-08-10T10:20:00Z');

// Die Jetzt-Fahne und die Vergangenheits-Schattierung haengen an der Uhr - die
// Fixture-Zeitstempel duerfen nicht morgen eine andere Aussage ergeben.
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

function bucket(over: Partial<HistoryBucket> = {}): HistoryBucket {
  return {
    start: '2026-08-10T10:00:00Z',
    pvKwh: 1,
    loadKwh: 0.5,
    gridImportKwh: 0.5,
    gridExportKwh: 0,
    batteryChargeKwh: 0.5,
    batteryDischargeKwh: 0,
    socMinPct: 50,
    socMaxPct: 55,
    socLastPct: 55,
    priceEurMwh: 80,
    costEur: 0.1,
    ...over,
  };
}

function history(over: Partial<History> = {}): History {
  return {
    range: 'day',
    from: '2026-08-10T00:00:00Z',
    to: '2026-08-11T00:00:00Z',
    bucketMinutes: 15,
    buckets: [
      bucket({ start: '2026-08-10T10:00:00Z' }),
      bucket({ start: '2026-08-10T10:15:00Z', batteryChargeKwh: 1 }),
      bucket({
        start: '2026-08-10T10:30:00Z',
        batteryChargeKwh: 0,
        batteryDischargeKwh: 1,
        priceEurMwh: 320,
      }),
      bucket({ start: '2026-08-10T10:45:00Z', priceEurMwh: -20 }),
    ],
    totals: {
      consumptionKwh: 2,
      pvGenerationKwh: 4,
      gridImportKwh: 2,
      gridExportKwh: 0,
      gridCostEur: 0.4,
      tarifArt: 'fest',
      batterySavingsPlannedEur: 1,
      autarkiePct: 50,
      eigenverbrauchPct: 50,
    },
    protocol: [],
    plan: [],
    events: [
      {
        type: 'negativpreis',
        start: '2026-08-10T10:30:00Z',
        end: '2026-08-10T10:45:00Z',
        text: 'Der Börsenpreis lag unter null.',
      },
    ],
    ...over,
  };
}

const geldReihe: SiteEarningsBucket[] = [
  {
    start: '2026-08-10T10:00:00Z',
    einspeiseErloesEur: 1,
    eigenverbrauchsWertEur: 1,
    stromkostenEur: 0.5,
    nettoEur: 1.5,
  },
];

const geld = { savedEur: 2.73, baselineEur: 3.1, actualEur: 0.37, series: geldReihe };

function renderBild(props: Partial<Parameters<typeof Tagesbild>[0]> = {}) {
  return render(
    <Tagesbild history={history()} geld={geld} plantKind="eigenverbrauch" {...props} />,
  );
}

describe('Tagesbild · die Panel-Struktur (F8 verschärft)', () => {
  it('zeichnet DREI Plotflächen mit demselben linken und rechten Rand', () => {
    renderBild();
    const grids = lastOption.grid;
    expect(grids).toHaveLength(3);
    // ⚠ Die Auflage der Panel-Stufe: gleiche Ränder, sonst lägen die
    // Zeitachsen nicht übereinander - und genau das ist der Zweck.
    expect(new Set(grids.map((g: any) => g.left)).size).toBe(1);
    expect(new Set(grids.map((g: any) => g.right)).size).toBe(1);
    // `containLabel` würde je Grid die eigene Beschriftungsbreite messen.
    expect(grids.some((g: any) => g.containLabel)).toBe(false);
  });

  it('verbindet die Fadenkreuze über ALLE Panels', () => {
    renderBild();
    expect(lastOption.axisPointer).toEqual({ link: [{ xAxisIndex: 'all' }] });
  });

  it('beschriftet die geteilte Zeitachse GENAU EINMAL — unten', () => {
    renderBild();
    const beschriftet = lastOption.xAxis.filter((a: any) => a.axisLabel?.show !== false);
    expect(beschriftet).toHaveLength(1);
    expect(beschriftet[0].gridIndex).toBe(2);
  });

  it('setzt die „Jetzt"-Fahne GENAU EINMAL, unter der Achse', () => {
    renderBild();
    const f = fahnen();
    expect(f).toHaveLength(1);
    expect(f[0].label.formatter).toMatch(/^Jetzt /);
    // K9: `start` ist das UNTERE Ende einer senkrechten markLine.
    expect(f[0].label.position).toBe('start');
    expect(f[0].label.rotate).toBe(0);
    expect(f[0].label.distance).toBe(PANELS.nowFlagDistancePx);
    // Die LINIE zieht trotzdem durch die anderen Panels.
    const stille = (lastOption.series ?? []).flatMap((s: any) =>
      (s?.markLine?.data ?? []).filter((m: any) => m?.label?.show === false),
    );
    expect(stille.length).toBeGreaterThan(0);
  });

  it('setzt auf der beschrifteten Achse KEINEN axisPointer-Schluessel', () => {
    // ⚠ Im Browser gefunden, nicht im Test: `axisPointer: undefined` ist NICHT
    // dasselbe wie „kein Schluessel" - ECharts liest daraus kein Teilmodell und
    // die ganze Flaeche stirbt beim Zeichnen („Cannot set properties of
    // undefined"). Der Test stubbt `setOption`, also faellt es hier nur als
    // Struktur auf.
    renderBild();
    const beschriftet = lastOption.xAxis[lastOption.xAxis.length - 1];
    expect('axisPointer' in beschriftet).toBe(false);
    expect(lastOption.xAxis[0].axisPointer).toEqual({ label: { show: false } });
  });

  it('traegt Vergangenheits-Schattierung UND Ereignis-Baender auf EINER markArea', () => {
    // Eine Serie hat genau eine `markArea` - getrennt gedacht verlor eine von
    // beiden (im Browser: die Baender waren unsichtbar, sobald es ein
    // Preis-Panel gab).
    renderBild();
    const preisFlaechen = serie(REIHE.preis).markArea.data;
    expect(preisFlaechen.length).toBeGreaterThanOrEqual(2);
    // Jedes Panel behaelt seine eigene Vergangenheits-Schattierung.
    expect(serie(REIHE.laden).markArea.data).toHaveLength(1);
    expect(serie(REIHE.ertrag).markArea.data).toHaveLength(1);
  });

  it('trägt über jeder Fläche ihre AUSSAGE, nicht nur eine Einheit', () => {
    renderBild();
    const titel = lastOption.title.filter((t: any) => t.show);
    expect(titel).toHaveLength(3);
    expect(titel[0].text).toContain(PANEL_TITEL.preis.text);
    expect(titel[1].text).toContain(PANEL_TITEL.leistung.text);
    expect(titel[2].text).toContain(PANEL_TITEL.ertrag.text);
    // Sie sitzen über ihrer Fläche, nicht daneben.
    titel.forEach((tt: any, i: number) => {
      expect(parseFloat(tt.top)).toBeLessThan(parseFloat(lastOption.grid[i].top));
    });
  });
});

describe('Tagesbild · K5, der Speicher ist EINE Farbe', () => {
  it('zeichnet Laden gefüllt und Abgeben als UMRISS — in derselben Farbe', () => {
    renderBild();
    const t = chartTheme();
    const bars = serie(REIHE.laden).data;
    expect(bars[0].itemStyle.color).toBe(t.charge);
    expect(bars[0].itemStyle.borderWidth).toBe(0);
    // Der Entlade-Slot: Umriss in DERSELBEN Serienfarbe, Füllung leer.
    expect(bars[2].itemStyle.borderColor).toBe(t.charge);
    expect(bars[2].itemStyle.color).toBe(t.surface);
  });

  it('nennt beide Richtungen mit ihrem WORT in der Legende', () => {
    renderBild();
    expect(screen.getByText(REIHE.laden)).toBeInTheDocument();
    expect(screen.getByText(REIHE.abgeben)).toBeInTheDocument();
  });
});

describe('Tagesbild · K3, die Detailtiefe', () => {
  it('hält Ladestand und Netz im Grundzustand zurück — auch in der Legende', () => {
    renderBild();
    expect(serie(REIHE.netz)).toBeUndefined();
    expect(serie(REIHE.ladestand)).toBeUndefined();
    // Die Legende bewirbt nur, was gezeichnet werden kann.
    expect(screen.queryByText(REIHE.ladestand)).toBeNull();
    expect(screen.getByRole('button', { name: /Mehr anzeigen/ })).toBeInTheDocument();
  });

  it('zeigt beide nach dem Umschalten — im Leistungs-Panel, nicht auf einer dritten Fläche', () => {
    renderBild();
    fireEvent.click(screen.getByRole('button', { name: /Mehr anzeigen/ }));
    expect(serie(REIHE.netz).xAxisIndex).toBe(1);
    expect(serie(REIHE.ladestand).xAxisIndex).toBe(1);
    expect(screen.getByText(REIHE.ladestand)).toBeInTheDocument();
  });

  it('bietet gar keinen Umschalter, wenn dahinter nichts liegt', () => {
    renderBild({
      history: history({
        buckets: history().buckets.map((b) => ({
          ...b,
          socLastPct: null,
          gridImportKwh: null,
          gridExportKwh: null,
        })),
      }),
    });
    expect(screen.queryByRole('button', { name: /Mehr anzeigen/ })).toBeNull();
  });
});

describe('Tagesbild · Panel 3 und der Vergleichsanker', () => {
  it('zeichnet die Ertragskurve auf ihrer eigenen Fläche und beschriftet ihr Ende', () => {
    renderBild();
    const e = serie(REIHE.ertrag);
    expect(e.xAxisIndex).toBe(2);
    expect(e.yAxisIndex).toBe(3);
    expect(e.data.filter((v: unknown) => v != null).length).toBeGreaterThan(0);
  });

  it('nennt im Kopf, was die Steuerung gebracht hat — mit dem exakten Paar als Anker', () => {
    renderBild();
    expect(screen.getByText(/hat die Steuerung an diesem Tag gebracht/)).toBeInTheDocument();
    expect(screen.getByText(/Ohne Speicher wären es/)).toBeInTheDocument();
  });

  it('lässt die Fläche ohne gemessenes Geld ehrlich entfallen (Höhe 0, keine Serie)', () => {
    renderBild({ geld: null });
    expect(serie(REIHE.ertrag)).toBeUndefined();
    // Die Grid-ANZAHL bleibt drei, damit die Indizes stabil sind.
    expect(lastOption.grid).toHaveLength(3);
    expect(lastOption.grid[2].height).toBe('0%');
    // Und die Achse wandert an das jetzt unterste Panel.
    const beschriftet = lastOption.xAxis.filter((a: any) => a.axisLabel?.show !== false);
    expect(beschriftet[0].gridIndex).toBe(1);
    // Ohne Geld gibt es auch keinen Kopf, der etwas behaupten könnte.
    expect(screen.queryByText(/hat die Steuerung an diesem Tag gebracht/)).toBeNull();
  });
});

describe('Tagesbild · der Tooltip liest ALLE Panels', () => {
  it('komponiert aus dem Eimer-Index, nicht aus den params des überfahrenen Panels', () => {
    renderBild();
    // ECharts liefert bei mehreren Grids nur die Serien EINES Panels - hier
    // also absichtlich nur ein einziger Eintrag.
    const html = lastOption.tooltip.formatter([{ dataIndex: 2 }]);
    expect(html).toContain(REIHE.preis);
    expect(html).toContain('Speicher gibt');
    expect(html).toContain(REIHE.ertrag);
  });

  it('K7: der Speicher steht als SATZ ganz oben, nicht als Wert-Zeile', () => {
    renderBild();
    const html: string = lastOption.tooltip.formatter([{ dataIndex: 2 }]);
    // Der Satz folgt UNMITTELBAR auf die Uhrzeit - vor jeder Wert-Zeile.
    const zeilen = html.split('<br/>');
    expect(zeilen[0]).toMatch(/^<b>/);
    expect(zeilen[1]).toBe('Speicher gibt 4 kW ab.');
    // Und er steht GENAU EINMAL da: der frühere Wert-Zeilen-Zwilling
    // („Speicher gibt ab 4 kW") ist die Doppel-Kolonne, die K7 beendet.
    expect(html.match(/Speicher gibt/g)).toHaveLength(1);
  });

  it('K7: der Satz ERFINDET keine Zuordnung — nur eigene Messwerte', () => {
    renderBild();
    const html: string = lastOption.tooltip.formatter([{ dataIndex: 2 }]);
    expect(html).not.toMatch(/in die Batterie|ins Haus|davon/);
  });

  it('interpoliert ausschließlich Konstanten und formatierte Zahlen (XSS-Regel)', () => {
    renderBild();
    const html = lastOption.tooltip.formatter([{ dataIndex: 0 }]);
    expect(html).not.toContain('<script');
    expect(html.match(/<span/g)?.length ?? 0).toBeGreaterThan(0);
  });

  it('gibt für einen Index ohne Eimer nichts aus', () => {
    renderBild();
    expect(lastOption.tooltip.formatter([{ dataIndex: 99 }])).toBe('');
  });
});
