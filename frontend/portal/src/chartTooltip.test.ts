import { describe, expect, it } from 'vitest';
import {
  ableseSatz,
  energieTeil,
  escHtml,
  flussSatz,
  flussTeil,
  kopf,
  notizZeile,
  punkt,
  tooltip,
  wertZeile,
} from './chartTooltip';

const kw = (v: number) => `${v.toLocaleString('de-DE', { maximumFractionDigits: 1 })} kW`;
const kwh = (v: number) => `${v.toLocaleString('de-DE', { maximumFractionDigits: 1 })} kWh`;

describe('K7 · der Satz', () => {
  it('setzt aus Messwerten EINEN Mini-Satz statt einer Zahlenkolonne', () => {
    const satz = ableseSatz([
      flussTeil('pv', 5.2, kw),
      flussTeil('haus', 3.4, kw),
      flussTeil('netz', -1.8, kw),
    ]);
    expect(satz).toBe('Sonne liefert 5,2 kW, Haus braucht 3,4 kW, 1,8 kW ins Netz.');
  });

  it('nennt die Richtung als WORT, nie als Minuszeichen', () => {
    expect(flussTeil('netz', 1.2, kw)).toBe('1,2 kW aus dem Netz');
    expect(flussTeil('netz', -1.2, kw)).toBe('1,2 kW ins Netz');
    expect(flussTeil('speicher', 3.1, kw)).toBe('Speicher lädt mit 3,1 kW');
    expect(flussTeil('speicher', -3.1, kw)).toBe('Speicher gibt 3,1 kW ab');
    for (const teil of [
      flussTeil('netz', -1.2, kw),
      flussTeil('speicher', -3.1, kw),
      flussTeil('pv', -0.4, kw),
    ]) {
      expect(teil).not.toMatch(/[-−]\s*\d/);
    }
  });

  it('ERFINDET keine Zuordnung — jede Größe spricht nur ihren eigenen Messwert', () => {
    // Die Konstellation aus der Aufgabenstellung: PV 5,2 · Speicher +3,1 ·
    // Haus 2,1. Eine Zuordnung „3,1 in die Batterie, 2,1 ins Haus" wäre eine
    // Bilanz-Zerlegung, die kein Kanal misst - sie darf nicht entstehen.
    const satz = ableseSatz([
      flussTeil('pv', 5.2, kw),
      flussTeil('speicher', 3.1, kw),
      flussTeil('haus', 2.1, kw),
    ])!;
    expect(satz).toBe('Sonne liefert 5,2 kW, Speicher lädt mit 3,1 kW, Haus braucht 2,1 kW.');
    expect(satz).not.toMatch(/in die Batterie|ins Haus|davon/);
  });

  it('lässt eine NICHT gemessene Größe aus dem Satz heraus (nie eine erfundene 0)', () => {
    expect(flussTeil('pv', null, kw)).toBeNull();
    expect(ableseSatz([flussTeil('pv', null, kw), flussTeil('haus', 3.4, kw)])).toBe(
      'Haus braucht 3,4 kW.',
    );
  });

  it('sagt unter dem Totband das WORT statt einer Null-Zahl', () => {
    expect(flussTeil('pv', 0.01, kw)).toBe('keine Sonne');
    expect(flussTeil('haus', 0, kw)).toBe('Haus braucht nichts');
    expect(flussTeil('netz', 0.02, kw)).toBe('Netz ausgeglichen');
    expect(flussTeil('speicher', -0.03, kw)).toBe('Speicher hält');
  });

  it('teilt das Totband mit live.ts — 0,05 kW ist die eine Schwelle', () => {
    expect(flussTeil('netz', 0.05, kw)).toBe('Netz ausgeglichen');
    expect(flussTeil('netz', 0.051, kw)).toBe('0,1 kW aus dem Netz');
  });

  it('ohne einen einzigen belegten Teil gibt es KEINEN Satz', () => {
    expect(ableseSatz([])).toBeNull();
    expect(ableseSatz([null, undefined, ''])).toBeNull();
  });

  it('reiht ohne „und" — eine Ablese-Zeile ist eine Aufzählung, keine Folgerung', () => {
    expect(ableseSatz(['a', 'b', 'c'])).toBe('a, b, c.');
  });
});

describe('K7 · der ENERGIE-Satz (Zeitraum statt Zeitpunkt)', () => {
  it('spricht in Vergangenheitsform über den Eimer', () => {
    expect(
      ableseSatz([
        energieTeil('pv', 42.1, kwh),
        energieTeil('haus', 31, kwh),
        energieTeil('netz', -12.3, kwh),
      ]),
    ).toBe('Sonne 42,1 kWh erzeugt, Haus 31 kWh verbraucht, 12,3 kWh eingespeist.');
  });

  it('nennt auch hier die Richtung als Wort und lässt Unbelegtes weg', () => {
    expect(energieTeil('netz', 4, kwh)).toBe('4 kWh bezogen');
    expect(energieTeil('speicher', 6, kwh)).toBe('6 kWh geladen');
    expect(energieTeil('speicher', -6, kwh)).toBe('6 kWh abgegeben');
    expect(energieTeil('speicher', null, kwh)).toBeNull();
  });

  it('behauptet bei einer gemessenen 0 keine Bewegung', () => {
    expect(energieTeil('netz', 0, kwh)).toBe('nichts über das Netz');
    expect(energieTeil('speicher', 0, kwh)).toBe('Speicher unbewegt');
  });
});

describe('K7 · die HTML-Bausteine (die XSS-Regel ist heilig)', () => {
  it('escapt jeden Text, der nicht von uns stammt', () => {
    expect(escHtml('<img src=x onerror=alert(1)>')).toBe(
      '&lt;img src=x onerror=alert(1)&gt;',
    );
    expect(escHtml('a & "b"')).toBe('a &amp; &quot;b&quot;');
  });

  it('escapt auch die Kopfzeile — sie ist die Stelle, an der ein Name landen könnte', () => {
    expect(kopf('<b>x</b>')).toBe('<b>&lt;b&gt;x&lt;/b&gt;</b>');
  });

  it('baut den Punkt aus der aufgelösten Token-Farbe', () => {
    expect(punkt('#2E9E5B')).toContain('background:#2E9E5B');
    expect(wertZeile('#2E9E5B', 'Speicher lädt')).toBe(`${punkt('#2E9E5B')}Speicher lädt`);
    expect(notizZeile('#6c757d', 'Grund')).toBe('<span style="color:#6c757d">Grund</span>');
  });

  it('lässt leere Teile aus dem Tooltip fallen, statt Leerzeilen zu erzeugen', () => {
    expect(tooltip('a', null, '', undefined, 'b')).toBe('a<br/>b');
    expect(tooltip(null, undefined)).toBe('');
  });
});

describe('M10 im Geiste · keine Doppel-Kolonne', () => {
  it('zieht die Fluss-Größen in EINEN Satz und sagt, welche er genannt hat', () => {
    const s = flussSatz({ pv: 5.2, haus: 3.4, netz: -1.8 }, kw);
    expect(s.text).toBe('Sonne liefert 5,2 kW, Haus braucht 3,4 kW, 1,8 kW ins Netz.');
    expect([...s.genannt].sort()).toEqual(['haus', 'netz', 'pv']);
  });

  it('reiht IMMER dem Weg der Energie nach, egal wie die Werte hereinkommen', () => {
    const s = flussSatz({ netz: 1, speicher: -2, haus: 3, pv: 4 }, kw);
    expect(s.text).toBe(
      'Sonne liefert 4 kW, Haus braucht 3 kW, 1 kW aus dem Netz, Speicher gibt 2 kW ab.',
    );
  });

  it('nennt eine NICHT gemessene Größe nicht — sie behält damit ihre eigene Zeile', () => {
    const s = flussSatz({ pv: 5.2, netz: null }, kw);
    expect(s.text).toBe('Sonne liefert 5,2 kW.');
    expect(s.genannt.has('netz')).toBe(false);
    expect(s.genannt.has('haus')).toBe(false);
  });

  it('ohne einen einzigen Wert gibt es weder Satz noch genannte Größe', () => {
    const s = flussSatz({}, kw);
    expect(s.text).toBeNull();
    expect(s.genannt.size).toBe(0);
  });

  it('kann denselben Satz mit dem ENERGIE-Wortschatz bauen', () => {
    const s = flussSatz({ pv: 42.1, haus: 31 }, kwh, energieTeil);
    expect(s.text).toBe('Sonne 42,1 kWh erzeugt, Haus 31 kWh verbraucht.');
  });
});
