import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VpDatePicker } from './VpDatePicker';
import { VpTimePicker } from './VpTimePicker';

function phone(an: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (q: string) => ({
      matches: q.includes('max-width') ? an : !an,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
}

beforeEach(() => {
  phone(false);
  vi.setSystemTime(new Date('2026-08-21T10:00:00'));
});
afterEach(() => {
  vi.useRealTimers();
  // @ts-expect-error - der Stub gehört dem einzelnen Test
  delete window.matchMedia;
});

const feld = (name: string) => screen.getByRole('combobox', { name });

describe('VpDatePicker: die ANZEIGE ist deutsch, der WERT bleibt ISO', () => {
  it('zeigt das Datum deutsch', () => {
    render(<VpDatePicker ariaLabel="Tag" value="2026-08-21" onChange={() => {}} />);
    expect(feld('Tag')).toHaveTextContent('21.08.2026');
  });

  it('gibt ISO zurück - byte-gleich mit dem abgelösten nativen Feld', () => {
    const onChange = vi.fn();
    render(<VpDatePicker ariaLabel="Tag" value="2026-08-21" onChange={onChange} />);
    fireEvent.click(feld('Tag'));
    fireEvent.click(screen.getByRole('gridcell', { name: '25' }));
    expect(onChange).toHaveBeenCalledWith('2026-08-25');
  });

  it('trägt den Wert ins Formular, OHNE ein zweites natives Element', () => {
    const { container } = render(
      <VpDatePicker ariaLabel="Tag" name="von" value="2026-08-21" onChange={() => {}} />,
    );
    expect(container.querySelector('input[type="date"]')).toBeNull();
    // Der Formular-Träger liegt im Panel des Kalenders - er existiert, sobald
    // die Fläche ihn braucht; sichtbar ist ausschliesslich der deutsche Text.
    expect(feld('Tag')).toHaveTextContent('21.08.2026');
  });
});

describe('VpDatePicker: der Kalender ist deutsch gebaut', () => {
  it('beginnt die Woche am MONTAG und trägt die Kalenderwoche', () => {
    render(<VpDatePicker ariaLabel="Tag" value="2026-08-21" onChange={() => {}} />);
    fireEvent.click(feld('Tag'));
    const kopf = screen.getAllByRole('columnheader');
    expect(kopf[0]).toHaveTextContent('KW');
    expect(kopf[1]).toHaveTextContent('Mo');
    expect(kopf[7]).toHaveTextContent('So');
    expect(screen.getByText('August 2026')).toBeInTheDocument();
    expect(screen.getByText('34')).toBeInTheDocument();
  });

  it('blättert vor und zurück', () => {
    render(<VpDatePicker ariaLabel="Tag" value="2026-08-21" onChange={() => {}} />);
    fireEvent.click(feld('Tag'));
    fireEvent.click(screen.getByRole('button', { name: 'Voriger Monat' }));
    expect(screen.getByText('Juli 2026')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Nächster Monat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Nächster Monat' }));
    expect(screen.getByText('September 2026')).toBeInTheDocument();
  });

  it('sperrt Tage ausserhalb der Grenzen, statt sie zu verstecken', () => {
    const onChange = vi.fn();
    render(
      <VpDatePicker
        ariaLabel="Tag"
        value="2026-08-21"
        max="2026-08-21"
        onChange={onChange}
      />,
    );
    fireEvent.click(feld('Tag'));
    const morgen = screen.getByRole('gridcell', { name: '22' });
    expect(morgen).toBeDisabled();
    fireEvent.click(morgen);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('VpDatePicker: DER TASTATUR-DURCHSTICH', () => {
  it('bewegt sich mit Pfeilen und wählt mit Enter', () => {
    const onChange = vi.fn();
    render(<VpDatePicker ariaLabel="Tag" value="2026-08-21" onChange={onChange} />);
    const b = feld('Tag');
    b.focus();
    fireEvent.keyDown(b, { key: 'ArrowDown' });
    const gitter = screen.getByRole('grid');
    expect(document.activeElement).toBe(gitter);
    fireEvent.keyDown(gitter, { key: 'ArrowRight' });
    fireEvent.keyDown(gitter, { key: 'ArrowDown' });
    fireEvent.keyDown(gitter, { key: 'Enter' });
    // 21. + 1 Tag + 7 Tage = 29.
    expect(onChange).toHaveBeenCalledWith('2026-08-29');
  });

  it('springt mit Bild-auf/-ab einen Monat und blättert das Panel mit', () => {
    render(<VpDatePicker ariaLabel="Tag" value="2026-08-21" onChange={() => {}} />);
    fireEvent.keyDown(feld('Tag'), { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'PageDown' });
    expect(screen.getByText('September 2026')).toBeInTheDocument();
  });

  it('schliesst mit Escape und gibt den Fokus zurück', () => {
    const onChange = vi.fn();
    render(<VpDatePicker ariaLabel="Tag" value="2026-08-21" onChange={onChange} />);
    const b = feld('Tag');
    b.focus();
    fireEvent.keyDown(b, { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'Escape' });
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(b);
  });
});

describe('VpDatePicker: Woche und Monat sind DASSELBE Gitter', () => {
  it('Woche - die ganze Zeile ist die Auswahl, der Wert ist `JJJJ-Www`', () => {
    const onChange = vi.fn();
    render(<VpDatePicker ariaLabel="Woche" art="woche" value="2026-W34" onChange={onChange} />);
    expect(feld('Woche')).toHaveTextContent('KW 34 · 17.08.–23.08.2026');
    fireEvent.click(feld('Woche'));
    fireEvent.click(screen.getByRole('gridcell', { name: '25' }));
    expect(onChange).toHaveBeenCalledWith('2026-W35');
  });

  it('Monat - der Wert ist `JJJJ-MM`', () => {
    const onChange = vi.fn();
    render(<VpDatePicker ariaLabel="Monat" art="monat" value="2026-08" onChange={onChange} />);
    expect(feld('Monat')).toHaveTextContent('August 2026');
    fireEvent.click(feld('Monat'));
    fireEvent.click(screen.getByRole('gridcell', { name: '11' }));
    expect(onChange).toHaveBeenCalledWith('2026-08');
  });
});

describe('VpDatePicker am TELEFON', () => {
  it('wird zum Bottom-Sheet', () => {
    phone(true);
    const { container } = render(
      <VpDatePicker ariaLabel="Tag" value="2026-08-21" onChange={() => {}} />,
    );
    fireEvent.click(feld('Tag'));
    expect(container.ownerDocument.querySelector('.vp-picker-panel.is-sheet')).toBeInTheDocument();
    expect(container.ownerDocument.querySelector('.vp-picker-backdrop')).toBeInTheDocument();
  });
});

describe('VpTimePicker: getippt wird FREI, das Raster ist nur der schnelle Weg', () => {
  it('liest eine getippte Zeit tolerant', () => {
    const onChange = vi.fn();
    render(<VpTimePicker ariaLabel="Von" value="06:00" onChange={onChange} />);
    const f = feld('Von');
    fireEvent.change(f, { target: { value: '1830' } });
    fireEvent.keyDown(f, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('18:30');
  });

  it('NIMMT einen Wert neben dem Raster an - das Formular darf nicht enger werden', () => {
    const onChange = vi.fn();
    render(<VpTimePicker ariaLabel="Von" value="06:00" onChange={onChange} />);
    const f = feld('Von');
    fireEvent.change(f, { target: { value: '06:07' } });
    fireEvent.blur(f);
    expect(onChange).toHaveBeenCalledWith('06:07');
  });

  it('RÄT NICHT bei einer unleserlichen Eingabe, sondern sagt es', () => {
    const onChange = vi.fn();
    render(<VpTimePicker ariaLabel="Von" value="06:00" onChange={onChange} />);
    const f = feld('Von');
    fireEvent.change(f, { target: { value: 'abends' } });
    fireEvent.blur(f);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/keine Uhrzeit/)).toBeInTheDocument();
  });

  it('nennt die Grenze, statt still zu klemmen', () => {
    const onChange = vi.fn();
    render(<VpTimePicker ariaLabel="Von" value="08:00" min="06:00" max="22:00" onChange={onChange} />);
    const f = feld('Von');
    fireEvent.change(f, { target: { value: '05:00' } });
    fireEvent.blur(f);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/zwischen 06:00 und 22:00/)).toBeInTheDocument();
  });

  it('bietet das Raster an und wählt daraus', () => {
    const onChange = vi.fn();
    render(<VpTimePicker ariaLabel="Von" value="06:00" onChange={onChange} />);
    fireEvent.click(feld('Von'));
    expect(screen.getByRole('option', { name: '06:15' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: '06:15' }));
    expect(onChange).toHaveBeenCalledWith('06:15');
  });

  it('lässt sich vollständig mit der Tastatur bedienen', () => {
    const onChange = vi.fn();
    render(<VpTimePicker ariaLabel="Von" value="06:00" onChange={onChange} />);
    const f = feld('Von');
    f.focus();
    // Pfeil-ab öffnet die Liste, der zweite bewegt sie.
    fireEvent.keyDown(f, { key: 'ArrowDown' });
    fireEvent.keyDown(f, { key: 'ArrowDown' });
    fireEvent.keyDown(f, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('06:15');
  });

  it('⚠ REISST NICHT WIEDER AUF, wenn der Fokus nach dem Wählen zurückkehrt', () => {
    // Im Browser aufgefallen: das Feld öffnete auf blossen Fokus, das
    // Schliessen fokussiert es - eine Auswahl liess sich nie abschliessen.
    const onChange = vi.fn();
    render(<VpTimePicker ariaLabel="Von" value="06:00" onChange={onChange} />);
    const f = feld('Von');
    fireEvent.click(f);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: '06:30' }));
    expect(onChange).toHaveBeenCalledWith('06:30');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(f);
  });

  it('öffnet NICHT beim blossen Durchtabben eines Formulars', () => {
    render(<VpTimePicker ariaLabel="Von" value="06:00" onChange={() => {}} />);
    feld('Von').focus();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('leert sauber - ein leeres Feld ist eine gültige Antwort', () => {
    const onChange = vi.fn();
    render(<VpTimePicker ariaLabel="Von" value="06:00" onChange={onChange} />);
    const f = feld('Von');
    fireEvent.change(f, { target: { value: '' } });
    fireEvent.blur(f);
    expect(onChange).toHaveBeenCalledWith('');
  });
});
