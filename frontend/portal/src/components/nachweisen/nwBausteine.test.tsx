import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FolgenBalken } from './FolgenBalken';
import { StatusZeile, ZustandsZeichen } from './NwStatus';
import { NwZeichen } from './NwZeichen';
import { Kuerzel, NwFristZeile, NwZeile } from './NwZeilen';
import { datumsblock, folgenLegende, folgenSatz, kuerzelAus } from './nwBild';
import { Stufen } from './Stufen';
import { seitenLink, teilen, TEILEN_SATZ } from './teilen';
import { Weitergeben } from './Weitergeben';

describe('nwBild: Datumsblock, Kürzel, Legende', () => {
  it('bildet den Datumsblock aus dem Tag, ohne Tag keinen', () => {
    expect(datumsblock('bis', '2030-01-22')).toEqual({ wort: 'bis', tag: '22.01.', jahr: '2030', satz: 'bis 22.01.2030' });
    expect(datumsblock('', '2029-01-22T10:00:00Z')).toEqual({ wort: '', tag: '22.01.', jahr: '2029', satz: '22.01.2029' });
    expect(datumsblock('bis', null)).toBeNull();
    expect(datumsblock('bis', 'irgendwann')).toBeNull();
  });

  it('bildet Kürzel aus Vor- und Nachname, erfindet ohne Namen keins', () => {
    expect(kuerzelAus('Ines Kaltenbach')).toBe('IK');
    expect(kuerzelAus('Peter  van Hollerbach')).toBe('PH');
    expect(kuerzelAus('Claudia')).toBe('CL');
    expect(kuerzelAus('')).toBe('');
    expect(kuerzelAus(null)).toBe('');
  });

  it('zählt die Folgen in fester Reihe mit Einzahl und Mehrzahl', () => {
    const z = ['done', 'done', 'done', 'laeuft', 'laeuft', 'ohne'] as const;
    expect(folgenLegende([...z])).toEqual([
      { art: 'done', zahl: 3, wort: 'erledigt' },
      { art: 'laeuft', zahl: 2, wort: 'laufen' },
      { art: 'ohne', zahl: 1, wort: 'ohne Folge' },
    ]);
    expect(folgenSatz(['laeuft', 'done'])).toBe('1 erledigt, 1 läuft');
    expect(folgenLegende([])).toEqual([]);
  });
});

describe('Zeichen und Status-Zeile', () => {
  it('Zustands-Zeichen tragen ihr Wort für Vorleser, stumm nicht', () => {
    render(
      <>
        <ZustandsZeichen art="laeuft" />
        <ZustandsZeichen art="done" stumm />
      </>,
    );
    expect(screen.getByRole('img', { name: 'läuft' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'erledigt' })).toBeNull();
  });

  it('die Status-Zeile zeigt Zeichen, Text und leise den Fakt', () => {
    render(<StatusZeile zeichen={<NwZeichen art="ueber" />} text="Daten geändert" sub="· Stand 1 gilt noch" warn testId="s" />);
    const s = screen.getByTestId('s');
    expect(s.textContent).toBe('Daten geändert· Stand 1 gilt noch');
    expect(s.className).toContain('is-warn');
  });
});

describe('Stufen', () => {
  it('nennt jede Stufe mit Tag oder Zustand, ohne Tag nichts Erfundenes', () => {
    render(
      <Stufen
        testId="st"
        stufen={[
          { titel: 'Geplant', datum: '10.01.2029', zustand: 'done' },
          { titel: 'Durchgeführt', datum: null, zustand: 'an' },
          { titel: 'Abgeschlossen', zustand: 'offen' },
        ]}
      />,
    );
    const li = screen.getByTestId('st').querySelectorAll('li');
    expect([...li].map((l) => l.getAttribute('aria-label'))).toEqual(['Geplant: 10.01.2029', 'Durchgeführt: jetzt', 'Abgeschlossen: offen']);
    expect(li[0].querySelector('svg')).toBeTruthy();
    expect(li[2].querySelector('small')).toBeNull();
  });
});

describe('Zeilen', () => {
  it('eine Zeile mit Klick ist ein Knopf mit Pfeil; mit Verb ohne Pfeil', () => {
    const klick = vi.fn();
    render(
      <>
        <NwZeile titel="Geprüft" rechts="4 Themen" onClick={klick} testId="a" />
        <NwZeile titel="Kontext" verb="Festhalten" onClick={klick} testId="b" />
        <NwZeile titel="Nur Text" testId="c" />
      </>,
    );
    const a = screen.getByTestId('a');
    expect(a.tagName).toBe('BUTTON');
    expect(a.querySelector('.vp-nw-chev')).toBeTruthy();
    expect(screen.getByTestId('b').querySelector('.vp-nw-chev')).toBeNull();
    expect(screen.getByTestId('c').tagName).toBe('DIV');
    fireEvent.click(a);
    expect(klick).toHaveBeenCalledTimes(1);
  });

  it('eine Zeile mit Adresse ist ein Link; der Klick ersetzt das Springen', () => {
    const klick = vi.fn();
    render(<NwFristZeile datum={{ wort: 'bis', tag: '2030-01-22' }} titel="Internes Audit 2030" href="#/x" onClick={klick} testId="f" />);
    const f = screen.getByTestId('f');
    expect(f.tagName).toBe('A');
    expect(f.getAttribute('href')).toBe('#/x');
    expect(screen.getByRole('img', { name: 'bis 22.01.2030' })).toBeTruthy();
    fireEvent.click(f);
    expect(klick).toHaveBeenCalledTimes(1);
  });

  it('Kürzel zeigen die Initialen, Vorleser hören die Namen', () => {
    render(<Kuerzel testId="k" personen={[{ name: 'Ines Kaltenbach', kuerzel: 'IK' }, { name: 'Murat Demirci' }]} />);
    const k = screen.getByTestId('k');
    expect(k.getAttribute('aria-label')).toBe('Ines Kaltenbach, Murat Demirci');
    expect(k.textContent).toBe('IKMD');
  });

  it('ohne Personen keine Kürzel', () => {
    const { container } = render(<Kuerzel personen={[]} />);
    expect(container.textContent).toBe('');
  });
});

describe('Folgen-Balken', () => {
  it('ein Segment je Beschluss, Legende in Zahl und Wort', () => {
    render(<FolgenBalken testId="fb" zustaende={['done', 'done', 'done', 'laeuft', 'laeuft', 'ohne']} />);
    const fb = screen.getByTestId('fb');
    expect(fb.querySelectorAll('.vp-nw-segbar > i')).toHaveLength(6);
    expect(screen.getByRole('img', { name: 'Folgen der Beschlüsse: 3 erledigt, 2 laufen, 1 ohne Folge' })).toBeTruthy();
    expect(fb.querySelector('.vp-nw-seglg')?.textContent).toBe('3erledigt2laufen1ohne Folge');
  });
});

describe('Teilen', () => {
  it('teilt über das Telefon, wenn es das gibt', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const kopieren = vi.fn();
    expect(await teilen({ titel: 'T', url: 'https://x/#/a' }, { share, kopieren })).toBe('geteilt');
    expect(share).toHaveBeenCalledWith({ title: 'T', url: 'https://x/#/a' });
    expect(kopieren).not.toHaveBeenCalled();
  });

  it('abgebrochen ist abgebrochen - kein Rückfall', async () => {
    const abbruch = Object.assign(new Error('weg'), { name: 'AbortError' });
    const kopieren = vi.fn();
    expect(await teilen({ titel: 'T', url: 'u' }, { share: vi.fn().mockRejectedValue(abbruch), kopieren })).toBe('abgebrochen');
    expect(kopieren).not.toHaveBeenCalled();
  });

  it('ohne Teilen-Menü (oder wenn es scheitert) wird der Link kopiert', async () => {
    const kopieren = vi.fn().mockResolvedValue(undefined);
    expect(await teilen({ titel: 'T', url: 'u' }, { kopieren })).toBe('kopiert');
    expect(await teilen({ titel: 'T', url: 'u' }, { share: vi.fn().mockRejectedValue(new Error('NotAllowed')), kopieren })).toBe('kopiert');
    expect(await teilen({ titel: 'T', url: 'u' }, { share: vi.fn(), canShare: () => false, kopieren })).toBe('kopiert');
    expect(kopieren).toHaveBeenCalledTimes(3);
  });

  it('ohne beides ein Fehler', async () => {
    expect(await teilen({ titel: 'T', url: 'u' }, {})).toBe('fehler');
    expect(await teilen({ titel: 'T', url: 'u' }, { kopieren: vi.fn().mockRejectedValue(new Error('x')) })).toBe('fehler');
  });

  it('der Link zeigt auf die Route im selben Portal', () => {
    expect(seitenLink('#/portfolio/berichte/BR-1', { origin: 'https://p.example', pathname: '/' })).toBe('https://p.example/#/portfolio/berichte/BR-1');
    expect(seitenLink('/portfolio/x', { origin: 'https://p.example', pathname: '/app/' })).toBe('https://p.example/app/#/portfolio/x');
  });

  it('Weitergeben setzt Teilen an die zweite Stelle und meldet „Link kopiert“', async () => {
    const pdf = vi.fn();
    render(
      <Weitergeben
        knoepfe={[
          { symbol: 'speichern', text: 'PDF', onClick: pdf },
          { symbol: 'file-text', text: 'CSV', onClick: vi.fn() },
        ]}
        teilenLink={{ titel: 'Managementbewertung 2028', url: 'https://p/#/x' }}
        umgebung={{ kopieren: vi.fn().mockResolvedValue(undefined) }}
      />,
    );
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['PDF', 'Teilen', 'CSV']);
    fireEvent.click(screen.getByRole('button', { name: 'Teilen' }));
    await waitFor(() => expect(screen.getByTestId('weitergeben-satz').textContent).toBe(TEILEN_SATZ.kopiert));
    fireEvent.click(screen.getByRole('button', { name: 'PDF' }));
    expect(pdf).toHaveBeenCalledTimes(1);
  });
});

describe('Textfeld im Blatt', () => {
  it('Etikett gehört zum Feld, Fehler ist beschrieben, Länge begrenzt', async () => {
    const { NwTextfeld } = await import('./NwTextfeld');
    const onWert = vi.fn();
    render(<NwTextfeld label="Woran sehen Sie das?" wert="" onWert={onWert} mehrzeilig hoechstens={500} fehler="Bitte begründen." testid="t" />);
    const feld = screen.getByLabelText('Woran sehen Sie das?');
    expect(feld.tagName).toBe('TEXTAREA');
    expect(feld.getAttribute('maxlength')).toBe('500');
    expect(feld.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(feld.getAttribute('aria-describedby')!)?.textContent).toBe('Bitte begründen.');
    fireEvent.change(feld, { target: { value: 'Seit März' } });
    expect(onWert).toHaveBeenCalledWith('Seit März');
  });
});
