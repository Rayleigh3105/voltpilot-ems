import { describe, expect, it } from 'vitest';
import {
  AXIS,
  BAR,
  BASE_SERIES_LIMIT,
  FILL,
  DAY_BOUNDARY_OPACITY,
  dayBoundaryStyle,
  GHOST,
  ghostBar,
  ghostItem,
  ghostLine,
  NARROW_PX,
  NOW,
  nowLabel,
  nowLineStyle,
  SMOOTH,
  storageItemStyle,
  storageMark,
  STROKE,
  withAlpha,
} from './chartStyle';
import { axisName, AXIS as AXIS_NAME, VERGLEICH, vergleichName, vergleichReihe } from './chartCopy';

/**
 * Die Geometrie-Schicht ist eine REGEL, keine Sammlung freier Zahlen — diese
 * Suite nagelt die Regel fest, nicht die einzelnen Werte. Wer eine Zahl
 * bewusst nachjustiert, ändert sie hier mit; wer die HIERARCHIE aufhebt oder
 * eine zweite Jetzt-Linie einführt, wird rot.
 */
describe('STROKE (F1 · Hierarchie statt Gleichmass)', () => {
  it('ist eine echte Hierarchie - jede Stufe ist dünner als die davor', () => {
    expect(STROKE.lead).toBeGreaterThan(STROKE.context);
    expect(STROKE.context).toBeGreaterThan(STROKE.contextSoft);
    expect(STROKE.contextSoft).toBeGreaterThan(STROKE.ref);
  });

  it('hält den KONTRAST, aus dem Filigranität entsteht (r2 §2 Befund ①)', () => {
    // Gleichmässig dünn ist nur blass: die Leitserie muss deutlich stärker
    // sein als der Kontext, sonst trägt keine Linie die Aussage.
    expect(STROKE.lead / STROKE.contextSoft).toBeGreaterThanOrEqual(1.5);
  });

  it('bleibt bei VIER Stufen - kein Wildwuchs wie die neun gemessenen Werte', () => {
    expect(new Set(Object.values(STROKE)).size).toBe(4);
  });
});

describe('FILL (F3 · Flächen sind Hauch)', () => {
  it('ordnet die Alphas nach ihrer Aufgabe', () => {
    expect(FILL.past).toBeLessThan(FILL.wash);
    expect(FILL.wash).toBeLessThan(FILL.band);
    expect(FILL.band).toBeLessThanOrEqual(FILL.speaking);
  });

  it('hält die AUSSAGE-tragende Fläche im erlaubten Band 0,10–0,16 (r2 §4)', () => {
    expect(FILL.speaking).toBeGreaterThanOrEqual(0.1);
    expect(FILL.speaking).toBeLessThanOrEqual(0.16);
  });

  it('hält den Standard-Wash bei höchstens 0,10 (F3-Vorgabe)', () => {
    expect(FILL.wash).toBeLessThanOrEqual(0.1);
  });
});

describe('NOW (F5 · EINE Jetzt-Linie)', () => {
  it('ist eine REFERENZ: dünn, gestrichelt, gedämpft - nie eine Serienfarbe', () => {
    expect(NOW.width).toBe(STROKE.ref);
    expect(NOW.dash).toEqual([3, 3]);
    expect(NOW.inkOpacity).toBeLessThan(1);
  });

  it('baut ihren lineStyle aus der INK-Farbe, nicht aus dem Preis-Blau', () => {
    const style = nowLineStyle({ ink: '#1A1A1A' });
    expect(style.color).toBe('#1A1A1A');
    expect(style.width).toBe(STROKE.ref);
    expect(style.opacity).toBe(NOW.inkOpacity);
  });

  it('pinnt das Label waagerecht - die dokumentierte Kanten-Falle', () => {
    // Auf einer Kategorie-Achse rendert ECharts ein innenliegendes
    // markLine-Label sonst GEDREHT entlang der Linie.
    expect(nowLabel({ axis: '#6C757D' }, 'insideEndTop').rotate).toBe(0);
    expect(nowLabel({ axis: '#6C757D' }, 'insideEndTop').formatter).toBe('Jetzt');
  });
});

describe('BAR (F9 · Säulenstäbe statt Farb-Block)', () => {
  it('deckelt die Breite und lässt eine Fuge', () => {
    expect(BAR.maxWidth).toBeLessThanOrEqual(16);
    expect(Number.parseInt(BAR.categoryGap, 10)).toBeGreaterThanOrEqual(30);
  });
});

describe('storageMark (K5 · gefüllte Speicher-Zustände)', () => {
  const t = { charge: '#2E9E5B', gridCharge: '#00ACC1', battDischarge: '#8B1E3F' };

  it('gibt Laden und Abgeben getrennte Farben und dieselbe gefüllte Form', () => {
    expect(storageMark('laden', t)).toEqual({ color: t.charge, form: 'filled' });
    expect(storageMark('entladen', t)).toEqual({ color: t.battDischarge, form: 'filled' });
  });

  it('behält Netzladen als EIGENEN Ton - die EEG-Unterscheidung ist compliance-tragend', () => {
    expect(storageMark('netzladen', t).color).toBe(t.gridCharge);
    expect(storageMark('netzladen', t).form).toBe('filled');
  });

  it('malt beide Speicher-Richtungen als gefüllte Balken', () => {
    const laden = storageItemStyle(storageMark('laden', t), '#FFFFFF');
    const entladen = storageItemStyle(storageMark('entladen', t), '#FFFFFF');
    expect(laden.color).toBe(t.charge);
    expect(laden.borderColor).toBeUndefined();
    expect(entladen.color).toBe(t.battDischarge);
    expect(entladen.borderColor).toBeUndefined();
  });

  it('behält die generische Umriss-Marke für neutrale Vergleiche', () => {
    const umriss = storageItemStyle({ color: '#607D8B', form: 'outline' }, '#FFFFFF');
    expect(umriss.color).toBe('#FFFFFF');
    expect(umriss.borderColor).toBe('#607D8B');
    expect(umriss.borderWidth).toBeGreaterThan(0);
  });
});

describe('withAlpha (Token + Alpha statt eines rgba-Literals)', () => {
  it('setzt die Deckkraft auf eine Token-Farbe', () => {
    expect(withAlpha('#2F6BD6', 0.14)).toBe('rgba(47,107,214,0.14)');
  });

  it('reicht durch, was es nicht sicher parsen kann - nie ein geratener Wert', () => {
    expect(withAlpha('rgb(1, 2, 3)', 0.5)).toBe('rgb(1, 2, 3)');
    expect(withAlpha('#abc', 0.5)).toBe('#abc');
  });
});

describe('Glättung und Grundzustand', () => {
  it('glättet gering genug, dass die Kurve nicht überschwingt', () => {
    // `smooth: true` ist der Faktor 0,5 - auf 15-Minuten-Daten schwingt eine
    // PV-Kurve damit nachts unter Null und behauptet einen nie gemessenen Wert.
    expect(SMOOTH).toBeGreaterThan(0);
    expect(SMOOTH).toBeLessThanOrEqual(0.25);
  });

  it('hält den Grundzustand bei drei Reihen (K3)', () => {
    expect(BASE_SERIES_LIMIT).toBe(3);
  });

  it('setzt die Achsentypo auf EINE Größe — und nie unter 12 px', () => {
    // E10/B7: 11 px lag unter der Lesbarkeitsgrenze des Skills („Don't render
    // critical text below 12pt"). Die Zahl ist absichtlich EINE für das ganze
    // Portal, und sie ist nach unten gedeckelt.
    expect(AXIS.fontSize).toBe(12);
    expect(AXIS.fontSize).toBeGreaterThanOrEqual(12);
    expect(AXIS.nameFontSize).toBeGreaterThanOrEqual(12);
  });
});

describe('chartCopy (K4 · Klartext + Einheit als Wort)', () => {
  it('lässt eine Einheit nie allein stehen', () => {
    expect(axisName('Leistung', 'kW')).toBe('Leistung (kW)');
    expect(AXIS_NAME.ladestand()).toBe('Ladestand (%)');
    expect(AXIS_NAME.preis()).toBe('Preis (ct/kWh)');
  });

  it('gibt am Telefon die nackte Einheit zurück - dort ist kein Platz', () => {
    expect(axisName('Leistung', 'kW', true)).toBe('kW');
    expect(AXIS_NAME.energie(true)).toBe('kWh');
  });

  it('sagt „Ladestand", nie „SoC"', () => {
    expect(AXIS_NAME.ladestand()).toContain('Ladestand');
    expect(AXIS_NAME.ladestand()).not.toMatch(/SoC/i);
  });
});

describe('M9 · die Geister-Ebene ist EINE Grammatik', () => {
  it('ist Kontext-Stärke, gestrichelt, EIN Alpha', () => {
    expect(GHOST.width).toBe(STROKE.contextSoft);
    expect(GHOST.dash).toBe('dashed');
    expect(GHOST.opacity).toBe(0.38);
  });

  it('behält die FARBE der Größe — eine Überlagerung erfindet keinen Ton', () => {
    expect(ghostLine('#2E9E5B').color).toBe('#2E9E5B');
    expect(ghostItem('#2E9E5B').color).toBe('#2E9E5B');
    expect(ghostBar('#6c757d').borderColor).toBe('#6c757d');
  });

  it('gibt Linie, Marker und Balken DIESELBE Deckkraft', () => {
    for (const s of [ghostLine('#000'), ghostItem('#000'), ghostBar('#000')]) {
      expect(s.opacity).toBe(GHOST.opacity);
    }
  });

  it('lässt einen Vergleichs-BALKEN leer — die Hauptreihe davor bleibt lesbar', () => {
    expect(ghostBar('#000').color).toBe('transparent');
    expect(ghostBar('#000').borderRadius).toBe(BAR.radius);
  });

  it('liegt UNTER der Kontext-Stufe der Hauptreihen - ein Vergleich ist nie Leitserie', () => {
    expect(GHOST.width).toBeLessThan(STROKE.lead);
    expect(GHOST.opacity).toBeLessThan(1);
  });
});

describe('M9 · und sie heißt überall gleich', () => {
  it('weist die Ebene mit EINEM Wort aus', () => {
    expect(vergleichName('Juni 2026')).toBe('Vergleich: Juni 2026');
    expect(vergleichReihe('Ergebnis', 'Juni 2026')).toBe('Ergebnis · Vergleich: Juni 2026');
  });

  it('nennt lieber nur das Wort als einen erfundenen Zeitraum', () => {
    expect(vergleichName()).toBe(VERGLEICH);
    expect(vergleichName(null)).toBe(VERGLEICH);
    expect(vergleichName('')).toBe(VERGLEICH);
    expect(vergleichReihe('Ergebnis')).toBe(`Ergebnis · ${VERGLEICH}`);
  });

  it('stellt die GRÖSSE voran - die Legende wird nach Größen gelesen', () => {
    expect(vergleichReihe('Ladestand', 'gestern').startsWith('Ladestand')).toBe(true);
  });
});

describe('Feinschliff · eine Referenz ist EINMAL definiert', () => {
  it('gibt der Tagesgrenze EINEN Stil - vorher stand er dreimal ausgeschrieben', () => {
    const s = dayBoundaryStyle({ axis: '#6c757d' });
    expect(s).toEqual({
      color: '#6c757d',
      type: 'dashed',
      width: STROKE.ref,
      opacity: DAY_BOUNDARY_OPACITY,
    });
  });

  it('haelt die Tagesgrenze RUHIGER als die Jetzt-Linie - sie ordnet nur ein', () => {
    expect(DAY_BOUNDARY_OPACITY).toBeGreaterThan(NOW.inkOpacity);
    // Beide sind Referenzen, also beide auf der Referenz-Staerke.
    expect(dayBoundaryStyle({ axis: '#000' }).width).toBe(STROKE.ref);
    expect(nowLineStyle({ ink: '#000' }).width).toBe(STROKE.ref);
  });

  it('traegt die Schmal-Grenze als EINE Zahl', () => {
    expect(NARROW_PX).toBe(480);
  });
});
