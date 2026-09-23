import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import * as M from '../bezugsbasisModell';
import { bb1Fassung, bb1Modell, bb1ZweiGroessen, bb4Gas, kz4, kz6, variablenVorschlag } from '../test/bezugsbasisFixtures';
import { BezugsbasisModell, BezugsbasisModellAnFassung } from './BezugsbasisModell';

/**
 * UEMS AP-17 IP-14 — die Modell-Ansicht einer Fassung in Kundenwörtern gegen R4/R12 (BB-0001 Fassung 2, Spritzguss),
 * R9 (BZ-3 abgelehnt), R3 (BB-0004 Gas über Gradtage) und R1 (Verhältnis ohne Grafik). Jede Zahl kommt aus der Fassung.
 */
afterEach(() => vi.restoreAllMocks());

const KOPF_R4 = 'Grundlast 10 523 kWh · je kg 0,2343 kWh · Streuung ± 0,8 % · gilt für 254 000–341 000 kg';
const KOPF_R3 = 'Grundlast 119 m³ (witterungsunabhängiger Anteil) · je Kd 3,8041 m³ · Streuung ± 4,6 % · gilt für 0–605 Kd';
const ABGELEHNT_R9 =
  'Betriebsstunden nicht aufgenommen: hängt an Produktionsmenge (r = 0,997). Ein Modell mit zwei Einflussgrößen braucht unabhängige Größen.';
const GROESSEN = M.groessenAusVorschlag(variablenVorschlag());

describe('Kundenwörter aus der Fassung (reine Helfer)', () => {
  it('rundet nur den Text, kaufmännisch (M5): 10 522,6206 → 10 523, 118,9104 → 119, −0,5 → −1, −0,4 → 0', () => {
    expect(M.ganzText('10522.6206')).toBe('10 523');
    expect(M.ganzText('118.9104')).toBe('119');
    expect(M.ganzText('81984.5')).toBe('81 985');
    expect(M.ganzText('-0.5')).toBe('−1');
    expect(M.ganzText('-0.4')).toBe('0');
    expect(M.prozentText('0.991')).toBe('99,1');
    expect(M.prozentText('1')).toBe('100');
    expect(M.einStelle('2')).toBe('2,0');
  });

  it('R4: der Kopfsatz wörtlich, Güte, Streuung und die Spannweite mit Toleranzband', () => {
    const f = bb1Modell();
    expect(M.kopfSatz(f, 'kWh/kg')).toBe(KOPF_R4);
    expect(M.gueteSatz(f.r2!)).toBe('Güte 0,991 — das Modell erklärt 99,1 % der Schwankung der Monatswerte.');
    expect(M.spannweiteSatz(M.spannweiten(f, 'kWh/kg', GROESSEN)[0])).toBe(
      'Einflussgröße 1, Produktionsmenge (BZ-1): 254 000–341 000 kg · das Modell gilt von 228 600 bis 375 100 kg; außerhalb ist es nicht anwendbar.',
    );
  });

  it('R9: die abgelehnte zweite Variable mit Namen — ohne Namen mit Kennzeichen', () => {
    const a = bb1Modell().abgelehnte_variablen![0];
    expect(M.abgelehntSatz(a, 'BZ-1', GROESSEN)).toBe(ABGELEHNT_R9);
    expect(M.abgelehntSatz(a, 'BZ-1')).toBe(
      'BZ-3 nicht aufgenommen: hängt an BZ-1 (r = 0,997). Ein Modell mit zwei Einflussgrößen braucht unabhängige Größen.',
    );
  });

  it('Punkte sind die zwölf Monatspaare, die Gerade ist a + b·x der Fassung über dem Toleranzband', () => {
    const g = M.grafik(bb1Modell())!;
    expect(g.punkte).toHaveLength(12);
    expect(g.punkte[0]).toEqual({ periode: '2026-11', x: 318000, y: 85581 });
    expect(g.band).toEqual({ von: 254000, bis: 341000 });
    expect(g.x).toEqual({ min: 228600, max: 375100 });
    expect(g.gerade.y1).toBeCloseTo(10522.6206 + 0.2343 * 228600, 6);
    expect(g.gerade.y2).toBeCloseTo(10522.6206 + 0.2343 * 375100, 6);
    expect(g.grundlast).toBeNull();
    expect(g.zweiteBei).toBeNull();
  });

  it('R3 Gas: Konstante 119 als witterungsunabhängiger Anteil, Kd auf der x-Achse, Grundlast-Linie bei x = 0', () => {
    const f = bb4Gas();
    expect(M.kopfSatz(f, 'm³/Kd')).toBe(KOPF_R3);
    expect(M.achsen(f, 'm³/Kd')).toEqual({ x: 'Gradtage in Kd', y: 'Energie in m³' });
    const g = M.grafik(f)!;
    expect(g.punkte.filter((p) => p.x === 0)).toHaveLength(2);
    expect(g.x).toEqual({ min: 0, max: 665.5 });
    expect(g.grundlast).toBeCloseTo(118.9104, 6);
  });

  it('zwei Einflussgrößen: die Gerade bei der Mitte der zweiten Spannweite, mit Hinweis', () => {
    const f = bb1ZweiGroessen();
    expect(M.kopfSatz(f, 'kWh/kg')).toBe(
      'Grundlast 10 512 kWh · je kg 0,2343 kWh · je Kd 0,021 kWh · Streuung ± 0,8 % · gilt für 254 000–341 000 kg und 0–605 Kd',
    );
    const g = M.grafik(f)!;
    expect(g.zweiteBei).toBe(302.5);
    expect(g.gerade.y1).toBeCloseTo(10511.8791 + 0.2343 * 228600 + 0.021 * 302.5, 6);
    const zwei = M.spannweiten(f, 'kWh/kg')[1];
    expect(M.zweiteHinweis(zwei, g.zweiteBei!)).toBe(
      'Die Gerade zeigt das Modell bei BZ-8 = 302,5 Kd (Mitte ihrer Spannweite 0–605 Kd); jeder Punkt ist ein Monat mit seinem eigenen Wert.',
    );
    expect(M.monatsZeilen(f, 'kWh/kg', 'Kd')[0]).toBe('November 2026: 85 581 kWh bei 318 000 kg und 415 Kd');
  });

  it('Verhältnis: kein Kopfsatz, keine Grafik — der Basiswert-Satz und die Monatsliste', () => {
    const f = bb1Fassung('freigegeben');
    expect(M.kopfSatz(f, 'kWh/kg')).toBeNull();
    expect(M.grafik(f)).toBeNull();
    expect(M.basiswertSatz(f, 'kWh/kg')).toBe('Verhältnis 0,2837 kWh je kg aus 1 Monat der Referenzperiode.');
    expect(M.monatsZeilen(f, 'kWh/kg')).toEqual(['Oktober 2026: 88 630 kWh bei 312 400 kg']);
  });
});

describe('die Ansicht', () => {
  it('R4 an der gespeicherten Fassung: Kopfsatz, zwölf Punkte, Gerade, Band, Tafel, abgelehnte BZ-3 mit Namen', async () => {
    const vorschlag = vi.spyOn(api, 'kennzahlVariablenVorschlag').mockResolvedValue(variablenVorschlag());
    render(<BezugsbasisModellAnFassung kennzahl={kz4()} fassung={bb1Modell()} />);
    expect(screen.getByTestId('bezugsbasis-modell-kopf').textContent).toBe(KOPF_R4);
    const grafik = screen.getByTestId('bezugsbasis-modell-grafik');
    expect(grafik.getAttribute('viewBox')).toBe('0 0 400 250');
    expect(within(grafik as unknown as HTMLElement).getAllByTestId('bezugsbasis-modell-punkt')).toHaveLength(12);
    expect(within(grafik as unknown as HTMLElement).getByTestId('bezugsbasis-modell-gerade')).toBeTruthy();
    expect(within(grafik as unknown as HTMLElement).getByTestId('bezugsbasis-modell-band')).toBeTruthy();
    expect(grafik.textContent).toContain('254 000');
    expect(grafik.textContent).toContain('341 000');
    expect(screen.getByTestId('bezugsbasis-modell-guete').textContent).toBe('Güte 0,991 — das Modell erklärt 99,1 % der Schwankung der Monatswerte.');
    expect(screen.getByTestId('bezugsbasis-modell-streuung').textContent).toContain('Streuung ± 0,8 %');
    expect(screen.getByTestId('bezugsbasis-modell-datenlage').textContent).toBe('vollständig (12 Monate)');
    expect(vorschlag).toHaveBeenCalledWith(kz4().id, '2026-11/2027-10');
    await waitFor(() => expect(screen.getByTestId('bezugsbasis-abgelehnt').textContent).toBe(ABGELEHNT_R9));
    expect(screen.getByTestId('bezugsbasis-modell-spannweite-1').textContent).toContain('Produktionsmenge (BZ-1): 254 000–341 000 kg');
    expect(screen.getByTestId('bezugsbasis-modell-monate').children).toHaveLength(12);
  });

  it('R3 Gas: Konstante 119, Kd auf der Achse, Grundlast-Linie', () => {
    render(<BezugsbasisModell fassung={bb4Gas()} einheit={kz6().einheit_anzeige} />);
    expect(screen.getByTestId('bezugsbasis-modell-kopf').textContent).toBe(KOPF_R3);
    expect(screen.getByTestId('bezugsbasis-modell-grafik').textContent).toContain('Gradtage in Kd');
    expect(screen.getByTestId('bezugsbasis-modell-grundlast')).toBeTruthy();
    expect(screen.queryByTestId('bezugsbasis-abgelehnt')).toBeNull();
  });

  it('Verhältnis: ohne Grafik, mit Basiswert-Satz, Datenlage und Monatsliste — und fragt keine Namen ab', () => {
    const vorschlag = vi.spyOn(api, 'kennzahlVariablenVorschlag');
    render(<BezugsbasisModellAnFassung kennzahl={kz4()} fassung={bb1Fassung('freigegeben')} />);
    expect(screen.queryByTestId('bezugsbasis-modell-grafik')).toBeNull();
    expect(screen.getByTestId('bezugsbasis-modell-basiswert').textContent).toBe('Verhältnis 0,2837 kWh je kg aus 1 Monat der Referenzperiode.');
    expect(screen.getByTestId('bezugsbasis-modell-datenlage').textContent).toBe('vorläufig (1 von 12 Monaten)');
    expect(screen.getByTestId('bezugsbasis-modell-kennzeichen').textContent).toBe('Bezugsbasis vorläufig (1 von 12 Monaten)');
    expect(screen.getByTestId('bezugsbasis-modell-monate').textContent).toBe('Oktober 2026: 88 630 kWh bei 312 400 kg');
    expect(vorschlag).not.toHaveBeenCalled();
  });

  it('im Assistenten ohne Datenlage und Basiswert (die Liste darüber nennt sie), zwei Größen mit Hinweis', () => {
    render(<BezugsbasisModell fassung={bb1ZweiGroessen()} einheit="kWh/kg" imAssistenten />);
    expect(screen.queryByTestId('bezugsbasis-modell-datenlage')).toBeNull();
    expect(screen.getByTestId('bezugsbasis-modell-zweite').textContent).toContain('Mitte ihrer Spannweite 0–605 Kd');
    expect(screen.getByTestId('bezugsbasis-modell-spannweite-2').textContent).toContain('0–605 Kd');
  });

  it('keine Norm-Wörter, kein Pfeil-Wort, keine Bewegung in den Quelltexten der Ansicht', () => {
    for (const datei of ['components/BezugsbasisModell.tsx', 'components/BezugsbasisModellGrafik.tsx', 'bezugsbasisModell.ts', 'components/BezugsbasisModell.css']) {
      const code = readFileSync(join(__dirname, '..', datei), 'utf8');
      expect(code, datei).not.toMatch(/EnPI|Baseline|Normalisierung|(^|[^\p{L}])KPI|(^|[^\p{L}])(besser|schlechter)|[↑↓▲▼]/u);
      expect(code, datei).not.toMatch(/transition|animation|@keyframes|<animate/);
    }
  });
});
