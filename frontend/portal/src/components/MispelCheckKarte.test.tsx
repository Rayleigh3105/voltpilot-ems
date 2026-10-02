import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import fixtures from '../../e2e/mispel-check-fixtures.json';
import { mispelCheckApi, type MispelCheckAnsicht } from '../mispelCheck';
import type { FoerderwegAnsicht } from '../mispelFoerderwegApi';
import { FoerderwegDialog } from './FoerderwegDialog';
import { MispelCheckKarte, MispelCheckPlatz } from './MispelCheckKarte';

const a4 = fixtures.a4 as MispelCheckAnsicht;
const a2 = fixtures.a2 as MispelCheckAnsicht;

const heute: FoerderwegAnsicht = {
  site_id: 's-1',
  am: '2026-10-20',
  quelle: 'bestand',
  foerderweg: 'marktpraemie_ausschliesslichkeit',
  begriff: 'Marktprämie mit Ausschließlichkeitsoption',
  rechtsgrundlage: '§ 19 Abs. 3 S. 1 Nr. 1, Abs. 3a EEG; A1 S. 11',
  formelsatz: null,
  formelsatz_gebunden_bis: null,
  einverstaendnis: null,
  gueltig_ab: null,
  netzladen: { moeglich: false, heute: false },
  fassungen: [],
  aw_regel: null,
  vormerkung: null,
  direktvermarkter: null,
  bilanzkreis_gesondert: null,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MispelCheckKarte (MP-48, BK-48 Variante A)', () => {
  it('Urteil zuerst; „Wie gerechnet?“ öffnet die Posten mit Vorzeichen und was die Abgrenzungsoption verlangt', () => {
    render(<MispelCheckKarte check={a2} anlageName="Autohaus Brenner" />);
    const karte = screen.getByTestId('mispel-check');
    expect(within(karte).getByText('MiSpeL-Check · Autohaus Brenner')).toBeTruthy();
    expect(screen.getByTestId('mispel-check-betrag').textContent).toContain('555');
    expect(karte.textContent).toContain('Lohnt sich für diese Anlage voraussichtlich nicht.');
    expect(karte.textContent).toContain('nie gegen „ohne Speicher“');
    expect(screen.queryByTestId('mispel-check-rechnung')).toBeNull();
    const wie = screen.getByRole('button', { name: 'Wie gerechnet?' });
    expect(wie.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(wie);
    const rechnung = screen.getByTestId('mispel-check-rechnung');
    expect(screen.getByRole('button', { name: 'Rechnung schließen' }).getAttribute('aria-expanded')).toBe('true');
    for (const wort of ['Netzladen-Handel mit Saldierung', 'Jahresmarktwert statt Monatsmarktwert', 'Zweiter Zähler Z2', 'Gesonderter Bilanzkreis', 'Unterschied im Jahr']) {
      expect(rechnung.textContent).toContain(wort);
    }
    expect(rechnung.querySelector('[data-art="jahresmarktwert"] dd')?.className).toBe('is-minus');
    expect(rechnung.textContent).toContain('Tenor Ziff. 9a');
    expect(rechnung.textContent).toContain('§ 20 S. 2 EEG');
    expect(rechnung.textContent).toContain('Angenommen, weil noch nicht gemessen: Jahresverbrauch');
  });

  it('ohne Ergebnis steht „wird gerechnet“ und kein Euro-Betrag', () => {
    render(<MispelCheckKarte check={null} anlageName="Werk Ahrenberg" />);
    const karte = screen.getByTestId('mispel-check');
    expect(karte.getAttribute('data-stand')).toBe('wird_gerechnet');
    expect(within(karte).getByRole('status').textContent).toBe('wird gerechnet');
    expect(karte.textContent).not.toContain('€');
    expect(screen.queryByRole('button', { name: 'Wie gerechnet?' })).toBeNull();
  });

  it('lädt den Check der Anlage nur lesend; ohne Antwort kein Betrag', async () => {
    const lesen = vi.spyOn(mispelCheckApi, 'lesen').mockResolvedValue(a4);
    render(<MispelCheckPlatz siteId="s-1" anlageName="Werk Ahrenberg" />);
    expect(screen.getByTestId('mispel-check').getAttribute('data-stand')).toBe('laedt');
    expect(screen.getByTestId('mispel-check').textContent).not.toContain('€');
    await waitFor(() => expect(screen.getByTestId('mispel-check').getAttribute('data-stand')).toBe('fertig'));
    expect(lesen).toHaveBeenCalledWith('s-1');
    expect(screen.getByTestId('mispel-check-betrag').textContent).toContain('1.899');
  });
});

describe('Förderweg-Dialog Schritt 1 mit MiSpeL-Check', () => {
  it('erst bei der Abgrenzungsoption; „Bleiben“ und „Weiter zur Einrichtung“ gleichwertig', () => {
    const onClose = vi.fn();
    render(
      <FoerderwegDialog
        siteId="s-1"
        ansicht={heute}
        onClose={onClose}
        onGespeichert={() => {}}
        mispelCheck={<MispelCheckKarte check={a4} anlageName="Werk Ahrenberg" />}
      />,
    );
    expect(screen.queryByTestId('mispel-check')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Weiter zur Einrichtung' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Marktprämie mit Abgrenzungsoption/ }));
    expect(screen.getByTestId('mispel-check')).toBeTruthy();
    const bleiben = screen.getByRole('button', { name: 'Beim heutigen Förderweg bleiben' });
    const weiter = screen.getByRole('button', { name: 'Weiter zur Einrichtung' });
    expect(bleiben.className).toContain('vp-fw-gleich');
    expect(weiter.className).toContain('vp-fw-gleich');
    fireEvent.click(bleiben);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('kein Check, wenn die Abgrenzungsoption schon heute gilt', () => {
    render(
      <FoerderwegDialog
        siteId="s-1"
        ansicht={{ ...heute, quelle: 'fassung', foerderweg: 'marktpraemie_abgrenzung', formelsatz: 'A1' }}
        onClose={() => {}}
        onGespeichert={() => {}}
        mispelCheck={<MispelCheckKarte check={a4} anlageName="Werk Ahrenberg" />}
      />,
    );
    expect(screen.queryByTestId('mispel-check')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Beim heutigen Förderweg bleiben' })).toBeNull();
  });
});
