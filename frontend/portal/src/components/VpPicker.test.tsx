import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VpPicker } from './VpPicker';
import type { VpOption } from '../picker/optionen';

const ANLAGEN: VpOption[] = [
  { value: 'a', label: 'Auernheim', sub: 'Alles in Ordnung', dot: 'ok' },
  { value: 'b', label: 'Hof Lindenberg', sub: 'Gerät meldet sich nicht', dot: 'warn' },
  { value: 'c', label: 'Solarpark Dachau', sub: 'Alles in Ordnung', dot: 'ok' },
];

/** Zehn Zeilen - über {@link SUCHE_AB}, die Suche erscheint also von selbst. */
const VIELE: VpOption[] = Array.from({ length: 10 }, (_, i) => ({
  value: `v${i}`,
  label: `Gerät ${i}`,
  sub: `Kennung ${i}`,
}));

function phone(an: boolean) {
  // jsdom kennt `matchMedia` nicht - `useIsPhone` fällt sonst auf Desktop
  // zurück. Für die Sheet-Fassung wird sie ausdrücklich gestubbt.
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

beforeEach(() => phone(false));
afterEach(() => {
  // @ts-expect-error - die Stubs gehören dem einzelnen Test
  delete window.matchMedia;
});

const ausloeser = () => screen.getByRole('combobox', { name: 'Anlage' });

describe('der Auslöser trägt volle Feld-Semantik', () => {
  it('meldet sich als combobox mit Zustand - und öffnet erst auf Bedienung', () => {
    render(<VpPicker ariaLabel="Anlage" options={ANLAGEN} value="b" onChange={() => {}} />);
    const b = ausloeser();
    expect(b).toHaveAttribute('aria-expanded', 'false');
    expect(b).toHaveAttribute('aria-haspopup', 'listbox');
    expect(b).toHaveTextContent('Hof Lindenberg');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('zeigt den PLATZHALTER, nie eine rohe Kennung', () => {
    render(
      <VpPicker
        ariaLabel="Anlage"
        options={ANLAGEN}
        value="gibtesnicht"
        placeholder="Bitte wählen …"
        onChange={() => {}}
      />,
    );
    expect(ausloeser()).toHaveTextContent('Bitte wählen …');
  });

  it('ist gesperrt, wenn er gesperrt ist', () => {
    render(<VpPicker ariaLabel="Anlage" options={ANLAGEN} disabled onChange={() => {}} />);
    fireEvent.click(ausloeser());
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('trägt den Wert in ein Formular, OHNE ein zweites natives Element', () => {
    const { container } = render(
      <VpPicker ariaLabel="Anlage" name="site" options={ANLAGEN} value="c" onChange={() => {}} />,
    );
    // ⚠ Kein verstecktes `<select>` als Krücke - das wäre eine zweite Wahrheit
    // über denselben Wert, und Vorlesesoftware fände beide.
    expect(container.querySelector('select')).toBeNull();
    expect(container.querySelector('input[name="site"]')).toHaveValue('c');
  });
});

describe('DER TASTATUR-DURCHSTICH: alles ohne Maus', () => {
  it('öffnet, wandert, wählt - und der Fokus kehrt zum Feld zurück', () => {
    const onChange = vi.fn();
    render(<VpPicker ariaLabel="Anlage" options={ANLAGEN} value="a" onChange={onChange} />);
    const b = ausloeser();
    b.focus();

    fireEvent.keyDown(b, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    // Unter acht Zeilen gibt es kein Suchfeld - die LISTE trägt den Fokus.
    const liste = screen.getByRole('listbox');
    expect(document.activeElement).toBe(liste);
    // Sie öffnet auf dem gewählten Wert (wie das native Select).
    expect(liste).toHaveAttribute('aria-activedescendant', expect.stringContaining('-o0'));

    fireEvent.keyDown(liste, { key: 'ArrowDown' });
    expect(liste).toHaveAttribute('aria-activedescendant', expect.stringContaining('-o1'));
    fireEvent.keyDown(liste, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(b);
  });

  it('springt mit Pos1/Ende an die Ränder', () => {
    const onChange = vi.fn();
    render(<VpPicker ariaLabel="Anlage" options={ANLAGEN} value="a" onChange={onChange} />);
    fireEvent.keyDown(ausloeser(), { key: 'Enter' });
    const liste = screen.getByRole('listbox');
    fireEvent.keyDown(liste, { key: 'End' });
    fireEvent.keyDown(liste, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('schliesst mit Escape OHNE zu wählen und gibt den Fokus zurück', () => {
    const onChange = vi.fn();
    render(<VpPicker ariaLabel="Anlage" options={ANLAGEN} value="a" onChange={onChange} />);
    const b = ausloeser();
    b.focus();
    fireEvent.keyDown(b, { key: ' ' });
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(b);
  });

  it('TIPPEN-ZUM-SPRINGEN auf dem geschlossenen Feld - wie nativ', () => {
    const onChange = vi.fn();
    render(<VpPicker ariaLabel="Anlage" options={ANLAGEN} value="a" onChange={onChange} />);
    const b = ausloeser();
    b.focus();
    fireEvent.keyDown(b, { key: 's' });
    const liste = screen.getByRole('listbox');
    expect(liste).toHaveAttribute('aria-activedescendant', expect.stringContaining('-o2'));
    fireEvent.keyDown(liste, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('LÄUFT NICHT UM - der letzte Pfeil nach unten bleibt stehen', () => {
    render(<VpPicker ariaLabel="Anlage" options={ANLAGEN} value="c" onChange={() => {}} />);
    fireEvent.keyDown(ausloeser(), { key: 'Enter' });
    const liste = screen.getByRole('listbox');
    fireEvent.keyDown(liste, { key: 'ArrowDown' });
    expect(liste).toHaveAttribute('aria-activedescendant', expect.stringContaining('-o2'));
  });

  it('hält den Fokus IM Panel - Tab führt nicht hinter die offene Auswahl', () => {
    render(
      <VpPicker
        ariaLabel="Gerät"
        options={VIELE}
        value="v0"
        onChange={() => {}}
        createLabel="Neu anlegen"
        onCreate={() => {}}
      />,
    );
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Gerät' }), { key: 'Enter' });
    const feld = screen.getByRole('combobox', { name: /durchsuchen/ });
    expect(document.activeElement).toBe(feld);
    fireEvent.keyDown(feld, { key: 'Tab' });
    // Nächstes fokussierbares Element IM Panel - nicht die Seite dahinter.
    expect(screen.getByRole('button', { name: 'Neu anlegen' })).toBe(document.activeElement);
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(feld);
  });
});

describe('die eingebaute Suche', () => {
  it('bleibt unter acht Zeilen weg und erscheint darüber von selbst', () => {
    const { unmount } = render(
      <VpPicker ariaLabel="Anlage" options={ANLAGEN} onChange={() => {}} />,
    );
    fireEvent.click(ausloeser());
    expect(screen.queryByRole('combobox', { name: /durchsuchen/ })).not.toBeInTheDocument();
    unmount();

    render(<VpPicker ariaLabel="Gerät" options={VIELE} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Gerät' }));
    expect(screen.getByRole('combobox', { name: /durchsuchen/ })).toBeInTheDocument();
  });

  it('filtert tolerant und hebt die Fundstelle hervor', () => {
    render(<VpPicker ariaLabel="Gerät" options={VIELE} search="immer" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Gerät' }));
    fireEvent.change(screen.getByRole('combobox', { name: /durchsuchen/ }), {
      target: { value: 'gerat 3' },
    });
    const zeilen = screen.getAllByRole('option');
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0]).toHaveTextContent('Gerät 3');
    expect(within(zeilen[0]).getAllByText(/Gerät|3/).length).toBeGreaterThan(0);
  });

  it('sagt EHRLICH, wenn nichts passt - nie ein stiller leerer Bereich', () => {
    render(<VpPicker ariaLabel="Gerät" options={VIELE} search="immer" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Gerät' }));
    fireEvent.change(screen.getByRole('combobox', { name: /durchsuchen/ }), {
      target: { value: 'huawei' },
    });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/huawei/)).toBeInTheDocument();
  });

  it('meldet die Trefferzahl an Vorlesesoftware', () => {
    render(<VpPicker ariaLabel="Gerät" options={VIELE} search="immer" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Gerät' }));
    fireEvent.change(screen.getByRole('combobox', { name: /durchsuchen/ }), {
      target: { value: 'gerät 1' },
    });
    expect(screen.getByRole('status')).toHaveTextContent('1 Treffer');
  });

  it('setzt den Anker auf den ersten Treffer - Enter wählt, was oben steht', () => {
    const onChange = vi.fn();
    render(<VpPicker ariaLabel="Gerät" options={VIELE} search="immer" onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Gerät' }));
    const feld = screen.getByRole('combobox', { name: /durchsuchen/ });
    fireEvent.change(feld, { target: { value: 'gerät 7' } });
    fireEvent.keyDown(feld, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('v7');
  });
});

describe('die Nebenzeile und der Zustands-Punkt', () => {
  it('rendert beide - genau das kann ein natives Select nicht', () => {
    const { container } = render(
      <VpPicker ariaLabel="Anlage" options={ANLAGEN} onChange={() => {}} />,
    );
    fireEvent.click(ausloeser());
    expect(screen.getByText('Gerät meldet sich nicht')).toBeInTheDocument();
    expect(container.ownerDocument.querySelectorAll('.vp-picker-dot.state-warn')).toHaveLength(1);
  });
});

describe('eine GESPERRTE Zeile bleibt sichtbar und nennt ihren Grund', () => {
  const MIT_SPERRE: VpOption[] = [
    { value: 'm', label: 'Marktoptimierung', disabled: true, disabledHint: 'Noch nicht freigeschaltet' },
    { value: 'e', label: 'Eigenverbrauch' },
  ];

  it('zeigt Zeile UND Grund, wählt sie aber nicht', () => {
    const onChange = vi.fn();
    render(<VpPicker ariaLabel="Modus" options={MIT_SPERRE} onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Modus' }));
    expect(screen.getByText('Noch nicht freigeschaltet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /Marktoptimierung/ }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Gruppen', () => {
  const KATALOG: VpOption[] = [
    { value: 'd1', label: 'SUN-30K', group: 'deye', sub: '30 kW · Hybrid' },
    { value: 'f1', label: 'Symo 10.0-3-M', group: 'fronius' },
  ];

  it('setzt Überschriften, die keine Auswahl-Zeilen sind', () => {
    render(
      <VpPicker
        ariaLabel="Modell"
        options={KATALOG}
        groups={[{ key: 'deye', label: 'Deye' }, { key: 'fronius', label: 'Fronius' }]}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Modell' }));
    expect(screen.getByText('Deye')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });
});

describe('Mehrfachauswahl', () => {
  it('schaltet um, BLEIBT OFFEN und zeigt Chips', () => {
    const onChangeMany = vi.fn();
    const { rerender } = render(
      <VpPicker
        ariaLabel="Ergebnis"
        options={ANLAGEN}
        values={['a']}
        onChangeMany={onChangeMany}
      />,
    );
    const b = screen.getByRole('combobox', { name: 'Ergebnis' });
    expect(b).toHaveTextContent('Auernheim');
    fireEvent.click(b);
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-multiselectable', 'true');
    fireEvent.click(screen.getByRole('option', { name: /Solarpark/ }));
    expect(onChangeMany).toHaveBeenCalledWith(['a', 'c']);
    // Eine Mehrfachauswahl, die nach jedem Haken zuklappt, ist keine.
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    rerender(
      <VpPicker
        ariaLabel="Ergebnis"
        options={ANLAGEN}
        values={['a', 'c']}
        onChangeMany={onChangeMany}
      />,
    );
    expect(screen.getAllByRole('option', { selected: true })).toHaveLength(2);
  });
});

describe('async: jeder Zustand wird BENANNT, nie als leere Liste gezeigt', () => {
  it('sagt, dass geladen wird', () => {
    render(<VpPicker ariaLabel="Gerät" options={[]} loading onChange={() => {}} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Gerät' }));
    expect(screen.getByText('Wird geladen …')).toBeInTheDocument();
  });

  it('nennt den GRUND eines Fehlschlags und bietet den Weg an', () => {
    const onRetry = vi.fn();
    render(
      <VpPicker
        ariaLabel="Gerät"
        options={[]}
        loadError="Die Liste konnte nicht geladen werden."
        onRetry={onRetry}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Gerät' }));
    expect(screen.getByText('Die Liste konnte nicht geladen werden.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe('„+ Neu anlegen"', () => {
  it('gibt es nur mit Handler, schliesst das Panel und meldet den Klick', () => {
    const onCreate = vi.fn();
    const { unmount } = render(
      <VpPicker ariaLabel="Anlage" options={ANLAGEN} onChange={() => {}} />,
    );
    fireEvent.click(ausloeser());
    expect(screen.queryByRole('button', { name: /anlegen/ })).not.toBeInTheDocument();
    unmount();

    render(
      <VpPicker
        ariaLabel="Anlage"
        options={ANLAGEN}
        onChange={() => {}}
        createLabel="Anlage anlegen"
        onCreate={onCreate}
      />,
    );
    fireEvent.click(ausloeser());
    fireEvent.click(screen.getByRole('button', { name: 'Anlage anlegen' }));
    expect(onCreate).toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});

describe('am TELEFON ist das Panel ein Bottom-Sheet', () => {
  it('bringt Hintergrund und Griff mit', () => {
    phone(true);
    const { container } = render(
      <VpPicker ariaLabel="Anlage" options={ANLAGEN} onChange={() => {}} />,
    );
    fireEvent.click(ausloeser());
    const doc = container.ownerDocument;
    expect(doc.querySelector('.vp-picker-panel.is-sheet')).toBeInTheDocument();
    expect(doc.querySelector('.vp-picker-backdrop')).toBeInTheDocument();
    expect(doc.querySelector('.vp-picker-griff')).toBeInTheDocument();
  });

  it('schliesst per Tipp auf den Hintergrund', () => {
    phone(true);
    const { container } = render(
      <VpPicker ariaLabel="Anlage" options={ANLAGEN} onChange={() => {}} />,
    );
    fireEvent.click(ausloeser());
    fireEvent.click(container.ownerDocument.querySelector('.vp-picker-backdrop')!);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('schliesst per WISCH nach unten - aber erst ab einem echten Zug', () => {
    phone(true);
    const { container } = render(
      <VpPicker ariaLabel="Anlage" options={ANLAGEN} onChange={() => {}} />,
    );
    fireEvent.click(ausloeser());
    const griff = container.ownerDocument.querySelector('.vp-picker-griff')!;

    // Ein kurzer Zupfer schliesst NICHT - sonst fällt das Sheet bei jedem
    // Scroll-Versuch zu.
    fireEvent.pointerDown(griff, { clientY: 100 });
    fireEvent.pointerUp(griff, { clientY: 120 });
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    fireEvent.pointerDown(griff, { clientY: 100 });
    fireEvent.pointerMove(griff, { clientY: 260 });
    fireEvent.pointerUp(griff, { clientY: 260 });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});

describe('⚠ das unvermessene Panel bleibt FOKUSSIERBAR', () => {
  it('wird durchsichtig gestellt, NIE `visibility: hidden`', () => {
    // Im echten Chrome gemessen (jsdom kann es nicht sehen): `focus()` auf
    // einem Nachfahren von `visibility: hidden` ist ein NO-OP. Das Panel steht
    // im ersten Durchgang unvermessen da - mit `hidden` bekam das Suchfeld den
    // Fokus nie, und die Tastatur-Bedienung war auf dem Desktop tot, während
    // jeder Test grün blieb. Dieser Wächter hält die Lehre fest.
    const { container } = render(
      <VpPicker ariaLabel="Gerät" options={VIELE} onChange={() => {}} />,
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Gerät' }));
    const panel = container.ownerDocument.querySelector<HTMLElement>('.vp-picker-panel')!;
    expect(panel.style.visibility).toBe('');
  });

  it('gibt dem Suchfeld den Fokus, sobald das Panel steht', () => {
    render(<VpPicker ariaLabel="Gerät" options={VIELE} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Gerät' }));
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: /durchsuchen/ }));
  });
});

describe('das Panel hängt an `document.body`', () => {
  it('ist damit nie vom `overflow: hidden` eines Wirts abgeschnitten', () => {
    const { container } = render(
      <div style={{ overflow: 'hidden' }}>
        <VpPicker ariaLabel="Anlage" options={ANLAGEN} onChange={() => {}} />
      </div>,
    );
    fireEvent.click(ausloeser());
    const panel = container.ownerDocument.querySelector('.vp-picker-panel')!;
    expect(container.contains(panel)).toBe(false);
    expect(document.body.contains(panel)).toBe(true);
  });
});
