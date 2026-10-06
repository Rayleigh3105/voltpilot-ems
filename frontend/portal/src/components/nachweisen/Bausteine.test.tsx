import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { AlsNaechstes } from './AlsNaechstes';
import { ErklaerKnopf } from './ErklaerKnopf';
import { ERKLAER_WOERTER_HOECHSTENS, erklaerWoerter, erklaerZeilen, woerter, type Erklaerung } from './erklaerung';
import { NwKopf } from './NwKopf';
import { NwZeichen, NwZeichenLegende, ZaehlerChip } from './NwZeichen';

/**
 * Die gemeinsamen Bausteine von Nachweisen, Runde 2 (Konzept n1 §12): geprüft wird, was sie einem Menschen zusagen -
 * die Erklärung steht erst nach dem Antippen da, das Blatt benennt sich mit seiner Frage, es lässt sich schließen und
 * gibt den Fokus zurück, am Telefon ist es ein Blatt von unten und am Rechner ein Dialog in der Mitte.
 */

/** Das Beispiel des Konzepts (Mock `r2-U-erkl`): 42 Wörter einschließlich der Frage, wie §0.5 es misst. */
const NACHWEIS: Erklaerung = {
  frage: 'Was ist ein Nachweis?',
  klartext: 'Ein festgehaltener Beleg: wer was wann entschieden hat - und wo das Original liegt.',
  beiIhnen: 'Energiepolitik, Fassung 2 - entschieden von Robert Falk am 20.03.2029.',
  nichtVerwechseln: 'kein Urteil. Ob es genügt, beurteilt, wer Sie prüft.',
  fachwort: 'dokumentierte Information',
};

function stubTelefon(telefon: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes('max-width') ? telefon : !telefon,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
}

afterEach(() => {
  // Die Attrappe darf keine andere Datei erreichen.
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
  vi.useRealTimers();
});

describe('Erklär-Blatt: Zählung und Aufbau', () => {
  it('zählt wie das Skript des Konzepts: Wörter, Zahlen und Daten, aber kein „-“ und kein „·“', () => {
    expect(woerter('Energiepolitik, Fassung 2 - entschieden am 20.03.2029.')).toBe(6);
    expect(woerter('4 Teile offen · 6 Fristen überfällig')).toBe(6);
    expect(woerter('  ')).toBe(0);
  });

  it('hält das Beispiel des Konzepts unter der Grenze von 45 Wörtern', () => {
    expect(erklaerWoerter(NACHWEIS)).toBe(42);
    expect(erklaerWoerter(NACHWEIS)).toBeLessThanOrEqual(ERKLAER_WOERTER_HOECHSTENS);
  });

  it('stellt die Zeilen immer in derselben Reihenfolge, das Normwort zuletzt (Entscheid 18)', () => {
    expect(erklaerZeilen(NACHWEIS)).toEqual([
      'Was ist ein Nachweis?',
      NACHWEIS.klartext,
      `Bei Ihnen: ${NACHWEIS.beiIhnen}`,
      `Nicht verwechseln: ${NACHWEIS.nichtVerwechseln}`,
      'Normwort: dokumentierte Information',
    ]);
    // Ohne Daten kein erfundenes Beispiel: die Zeile entfällt.
    expect(erklaerZeilen({ frage: 'Was ist ein Teil?', klartext: 'Ein Thema.', beiIhnen: null })).toEqual([
      'Was ist ein Teil?',
      'Ein Thema.',
    ]);
  });
});

describe('i-Knopf', () => {
  it('erklärt erst auf Antippen und heißt für Vorleser wie seine Frage', () => {
    render(<ErklaerKnopf erklaerung={NACHWEIS} />);
    expect(screen.queryByText(NACHWEIS.klartext)).toBeNull();
    const knopf = screen.getByRole('button', { name: 'Was ist ein Nachweis?' });
    expect(knopf).toHaveAttribute('aria-haspopup', 'dialog');

    fireEvent.click(knopf);
    const blatt = screen.getByRole('dialog');
    expect(within(blatt).getByRole('heading', { name: 'Was ist ein Nachweis?' })).toBeInTheDocument();
    const zeilen = [...within(blatt).getByTestId('erklaer-blatt').querySelectorAll('p')].map((p) => p.textContent);
    expect(zeilen).toEqual([
      NACHWEIS.klartext,
      `Bei Ihnen: ${NACHWEIS.beiIhnen}`,
      `Nicht verwechseln: ${NACHWEIS.nichtVerwechseln}`,
      'Normwort: dokumentierte Information',
    ]);
  });

  it('am Rechner ein Dialog in der Mitte: schließt mit Escape und gibt den Fokus an den Knopf zurück', () => {
    vi.useFakeTimers();
    render(<ErklaerKnopf erklaerung={NACHWEIS} />);
    const knopf = screen.getByRole('button', { name: 'Was ist ein Nachweis?' });
    knopf.focus();
    fireEvent.click(knopf);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('vp-modal');
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    act(() => {
      vi.runAllTimers();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(knopf);
  });

  it('am Telefon ein Blatt von unten, das sich über „Schließen“ schließt', () => {
    stubTelefon(true);
    vi.useFakeTimers();
    render(<ErklaerKnopf erklaerung={NACHWEIS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Was ist ein Nachweis?' }));
    const blatt = screen.getByRole('dialog');
    expect(blatt).toHaveClass('vp-bs', 'vp-nw-blatt');
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.click(within(blatt).getByRole('button', { name: 'Schließen' }));
    act(() => {
      vi.runAllTimers();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });

  it('kennt die kleine Form für den Kopf einer Karte', () => {
    render(<ErklaerKnopf erklaerung={NACHWEIS} klein />);
    expect(screen.getByRole('button', { name: 'Was ist ein Nachweis?' })).toHaveClass('vp-nw-ikn', 'is-klein');
  });
});

describe('Seitenkopf', () => {
  it('trägt den Titel als Überschrift - ohne den Namen des i-Knopfs - und die Kurzzeile leise darunter', () => {
    const zurueck = vi.fn();
    render(
      <NwKopf
        titel="Überblick"
        erklaerung={NACHWEIS}
        kurzzeile="Stand 30.04.2029"
        menue={<button type="button">Weitere Aktionen</button>}
        zurueck={{ label: 'Nachweisen', onClick: zurueck }}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Überblick' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Was ist ein Nachweis?' })).toBeInTheDocument();
    expect(screen.getByText('Stand 30.04.2029')).toHaveClass('vp-nw-kurz');
    fireEvent.click(screen.getByRole('button', { name: 'Nachweisen' }));
    expect(zurueck).toHaveBeenCalledOnce();
  });

  it('das Kennzeichen steht leise im Titel (am Telefon blendet es die Breite aus, Entscheid 25)', () => {
    render(<NwKopf titel="Energiepolitik" kennzeichen="D-0001" />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('EnergiepolitikD-0001');
    expect(screen.getByText('D-0001')).toHaveClass('vp-nw-kopf-kz');
  });

  it('ohne Erklärung kein Knopf, ohne Kurzzeile keine leere Zeile', () => {
    const { container } = render(<NwKopf titel="Berichte" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('.vp-nw-kurz')).toBeNull();
    expect(container.querySelector('.vp-nw-kopf-status')).toBeNull();
  });
});

describe('Zeichen und Zähler-Chips', () => {
  it('ein Zeichen spricht sein Wort, in einer Reihe schweigt es', () => {
    render(
      <>
        <NwZeichen art="offen" />
        <NwZeichen art="ueber" stumm />
      </>,
    );
    expect(screen.getByRole('img', { name: 'offen' })).toHaveClass('vp-nw-zei', 'is-offen');
    expect(screen.queryByRole('img', { name: 'überfällig' })).toBeNull();
  });

  it('die Legende nennt nur die Arten, die vorkommen', () => {
    render(<NwZeichenLegende arten={['festgehalten', 'offen', 'ueber']} />);
    expect(screen.getByTestId('zeichen-legende')).toHaveTextContent('festgehaltenoffenüberfällig');
  });

  it('ein Zähler-Chip ist ein Knopf, wenn er etwas öffnet - sonst nur Text', () => {
    const tippen = vi.fn();
    render(
      <>
        <ZaehlerChip anzahl={6} wort="Fristen überfällig" zeichen="ueber" ton="warn" onClick={tippen} blatt />
        <ZaehlerChip anzahl={4} wort="Teile offen" zeichen="offen" testId="still" />
      </>,
    );
    const chip = screen.getByRole('button', { name: '6 Fristen überfällig' });
    expect(chip).toHaveClass('vp-nw-zchip', 'is-warn');
    expect(chip).toHaveAttribute('aria-haspopup', 'dialog');
    fireEvent.click(chip);
    expect(tippen).toHaveBeenCalledOnce();
    expect(screen.getByTestId('still').tagName).toBe('SPAN');
    expect(screen.getByTestId('still')).toHaveTextContent('4Teile offen');
  });
});

describe('Als Nächstes', () => {
  const frist = { wort: 'seit', tag: '03.04.', jahr: '2028', satz: 'fällig seit 03.04.2028', ton: 'ueber' as const };

  it('genau ein Schritt mit Datumsblock und Knopf', () => {
    const entscheiden = vi.fn();
    render(
      <AlsNaechstes frist={frist} titel="Leistungsvergleich Dezember 2027 entscheiden" knopf={{ label: 'Entscheiden', onClick: entscheiden }} />,
    );
    const karte = screen.getByRole('region', { name: 'Als Nächstes' });
    expect(within(karte).getByRole('img', { name: 'fällig seit 03.04.2028' })).toHaveClass('vp-fd', 'is-ueber');
    fireEvent.click(within(karte).getByRole('button', { name: 'Entscheiden' }));
    expect(entscheiden).toHaveBeenCalledOnce();
  });

  it('„Kann noch nicht beginnen“ ist gestrichelt und hat keinen Knopf', () => {
    render(
      <AlsNaechstes
        kannNochNicht
        frist={{ ...frist, wort: 'bis', tag: '12.02.', jahr: '2030', satz: 'fällig bis 12.02.2030', ton: 'plan' }}
        titel="Managementbewertung 2029"
        warum="ab Januar 2030"
        knopf={{ label: 'Vorbereiten', onClick: () => {} }}
      />,
    );
    const karte = screen.getByRole('region', { name: 'Kann noch nicht beginnen' });
    expect(karte).toHaveClass('vp-nw-naechst', 'is-kann-nicht');
    expect(within(karte).queryByRole('button')).toBeNull();
    expect(karte).toHaveTextContent('ab Januar 2030');
  });
});
