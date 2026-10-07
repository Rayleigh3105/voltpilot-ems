import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type BewertungRangliste } from '../api';
import { setSelbstauskunft } from '../rollen';
import { ahrenbergEinsaetze, ahrenbergRangliste } from '../test/bewertungFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import { VERBRAUCH_FEHLER, VERBRAUCH_GESPERRT, VERBRAUCH_LEER, VERLAUF_FEHLER } from '../verbrauch';
import { VerbrauchPage } from './VerbrauchPage';

/** Zwölf Monate bis Oktober 2026: dieselben Bereiche, je Monat der Hauptzähler als Herkunft (wie die Route). */
function zwoelf(von: string): BewertungRangliste {
  const r = ahrenbergRangliste();
  const [j, m] = von.split('-').map(Number);
  const bilanzwerte = Array.from({ length: 12 }, (_, i) => {
    const idx = j * 12 + (m - 1) + i;
    const mo = `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
    return { anlage: 'Halle 1', von: `${mo}-01`, bis: `${mo}-28`, wert: String(180000 + i * 1000), version: 1, zustand: 'vollständig', eingaenge: [] };
  });
  return {
    ...r, von, monate: 12,
    nenner: { ...r.nenner, gesamt: 1, vorhanden: 1, anlagen: '1 von 1', wert: '2226000' },
    anlagen: [r.anlagen[0]],
    einsaetze: r.einsaetze.map((e) => ({ ...e, herkunft: { ...e.herkunft, nenner: { wert: '2226000', anlagen: '1 von 1', bilanzwerte } } })),
  };
}

function verdrahte(rangliste: (von: string, bis: string) => Promise<BewertungRangliste> = async (von, bis) =>
  von.slice(0, 7) === bis.slice(0, 7) ? ahrenbergRangliste() : zwoelf(von)) {
  const ee = ahrenbergEinsaetze();
  const abruf = vi.spyOn(api, 'bewertungRangliste').mockImplementation(rangliste);
  vi.spyOn(api, 'bewertungMessabdeckung').mockRejectedValue(new ApiError(503, 'aus'));
  vi.spyOn(api, 'energieeinsatzEinstufungen').mockImplementation(async (id) => ({
    fassungen: id === ee[0].id
      ? [{ fassung: 1, einstufung: 'wesentlich', begruendung: 'Größter Bereich.', grund: ['K1'], herkunft: {} as never, vorgeschlagen_ab: '2026-11-06', gueltig_ab: '2026-11-06',
          gueltig_bis: null, rueckwirkend: false, akteur: { sub: 'ik', name: 'Ines Kaltenbach', rolle: null, art: 'kunde' }, vieraugen: false, freigabe_status: 'freigegeben',
          entschieden_von: null, entschieden_am: null, created_at: '2026-11-06T09:00:00Z' }]
      : [],
  }));
  vi.spyOn(api, 'messbedarfeAlle').mockResolvedValue({ messbedarfe: [] });
  vi.spyOn(api, 'energieeinsaetze').mockResolvedValue({ energieeinsaetze: ee });
  return { abruf, ee };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // Letzter voller Monat: Oktober 2026 — der Monat der Ahrenberg-Rangliste.
  vi.setSystemTime(new Date('2026-11-05T09:00:00+01:00'));
  window.location.hash = '#/portfolio/verbrauch';
  setSelbstauskunft(rechteSeed('IK').me);
});

afterEach(() => {
  setSelbstauskunft(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('VerbrauchPage — Wo geht die Energie hin?', () => {
  it('Monat: Antwortsatz, Kachel, sortierte Bereiche mit „wesentlich“, Rest und Gas; eine Reihe öffnet den Bereich', async () => {
    const { abruf, ee } = verdrahte();
    const oeffnen = vi.fn();
    render(<VerbrauchPage onOeffnen={oeffnen} onListe={vi.fn()} onNavigate={vi.fn()} />);
    const antwort = await screen.findByTestId('verbrauch-antwort');
    // Am Rechner (jsdom kennt keine Telefon-Breite) der Satz mit der Zuordnung.
    expect(antwort).toHaveTextContent(`${ee[0].name} braucht mit 42 % den größten Teil des Stroms; 68 % des Stroms sind einem Bereich zugeordnet.`);
    expect(antwort).toHaveTextContent('Strom · Oktober 2026 · alle Zähler vollständig');
    expect(abruf).toHaveBeenCalledWith('2026-10-01', '2026-10-31');
    expect(abruf).toHaveBeenCalledWith('2025-10-01', '2025-10-31');
    expect(screen.getByLabelText('Strom im Oktober 2026')).toHaveTextContent('185.380');
    const liste = screen.getByTestId('verbrauch-bereiche');
    expect(within(liste).getByText('6 Bereiche · Oktober 2026')).toBeInTheDocument();
    const erste = screen.getByTestId(`verbrauch-reihe-${ee[0].kennzeichen}`);
    // Die Einstufungen kommen nach der Rangliste; `toHaveTextContent` faltet das geschützte Leerzeichen zu einem.
    await waitFor(() => expect(within(erste).getByText('wesentlich')).toBeInTheDocument());
    expect(erste).toHaveTextContent(`${ee[0].name}wesentlich77.500kWh41,8 %`);
    expect(screen.getByTestId('verbrauch-rest')).toHaveTextContent(`Keinem Bereich zugeordnet59.640kWh32,2 %`);
    expect(screen.getByTestId('verbrauch-traeger-Gas')).toHaveTextContent(`1.240 m³`);
    fireEvent.click(within(erste).getByRole('button', { name: new RegExp(`^${ee[0].name}`) }));
    expect(oeffnen).toHaveBeenCalledWith(ee[0].id);
    // Fuß: Zeitzone einmal, und der Grenz-Satz der Fläche.
    expect(screen.getByTestId('verbrauch-fuss')).toHaveTextContent('Stand 05.11.2026');
    expect(screen.getByText(/Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden/)).toBeInTheDocument();
  });

  it('12 Monate: ein Abruf über zwölf Monate, Vorjahr ein Jahr früher; die Infozeile wechselt mit den Pfeiltasten; die Adresse merkt sich die Wahl', async () => {
    const { abruf } = verdrahte();
    render(<VerbrauchPage onOeffnen={vi.fn()} onListe={vi.fn()} onNavigate={vi.fn()} />);
    await screen.findByTestId('verbrauch-antwort');
    act(() => {
      fireEvent.click(screen.getByRole('tab', { name: '12 Monate' }));
    });
    await waitFor(() => expect(abruf).toHaveBeenCalledWith('2025-11-01', '2026-10-31'));
    expect(abruf).toHaveBeenCalledWith('2024-11-01', '2025-10-31');
    expect(window.location.hash).toBe('#/portfolio/verbrauch?zeitraum=12monate');
    // Bis der neue Stand da ist, steht der alte gedimmt (aria-busy) — dann der Satz über zwölf Monate.
    await waitFor(() => expect(screen.getByTestId('verbrauch-inhalt')).toHaveAttribute('aria-busy', 'false'));
    expect(screen.getByTestId('verbrauch-antwort')).toHaveTextContent('In zwölf Monaten 2,2 Millionen kWh Strom');
    expect(screen.getByTestId('verbrauch-zeitraum')).toHaveTextContent('Nov 2025 – Okt 2026');
    const info = screen.getByTestId('verbrauch-infozeile');
    expect(info).toHaveTextContent(`Oktober 2026191.000 kWh`);
    fireEvent.keyDown(screen.getByTestId('verbrauch-verlauf-flaeche'), { key: 'ArrowLeft' });
    expect(info).toHaveTextContent(`September 2026190.000 kWh`);
    // Über den letzten vollen Monat hinaus blättert die Leiste nicht.
    expect(screen.getByRole('button', { name: 'Die zwölf Monate danach' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Die zwölf Monate davor' }));
    await waitFor(() => expect(abruf).toHaveBeenCalledWith('2024-11-01', '2025-10-31'));
    expect(window.location.hash).toBe('#/portfolio/verbrauch?zeitraum=12monate&bis=2025-10');
  });

  it('die Wahl aus der Adresse gilt beim Öffnen', async () => {
    window.location.hash = '#/portfolio/verbrauch?bis=2026-08';
    const { abruf } = verdrahte();
    render(<VerbrauchPage onOeffnen={vi.fn()} onListe={vi.fn()} onNavigate={vi.fn()} />);
    await screen.findByTestId('verbrauch-antwort');
    expect(abruf).toHaveBeenCalledWith('2026-08-01', '2026-08-31');
    expect(screen.getByTestId('verbrauch-zeitraum')).toHaveTextContent('August 2026');
  });

  it('noch keine Bereiche: erst der Satz, wozu, dann der Knopf', async () => {
    verdrahte(async () => ahrenbergRangliste(true));
    render(<VerbrauchPage onOeffnen={vi.fn()} onListe={vi.fn()} onNavigate={vi.fn()} />);
    const leer = await screen.findByTestId('verbrauch-leer');
    expect(leer).toHaveTextContent(VERBRAUCH_LEER);
    expect(within(leer).getByRole('button', { name: 'Energieeinsatz anlegen' })).toBeInTheDocument();
  });

  it('Fehler: ein Satz und „Erneut versuchen“; ohne Freigabe kein Versuch, sondern der Grund', async () => {
    const { abruf } = verdrahte(async () => {
      throw new ApiError(500, 'kaputt');
    });
    render(<VerbrauchPage onOeffnen={vi.fn()} onListe={vi.fn()} onNavigate={vi.fn()} />);
    expect(await screen.findByText(VERBRAUCH_FEHLER)).toBeInTheDocument();
    abruf.mockImplementation(async (von, bis) => (von.slice(0, 7) === bis.slice(0, 7) ? ahrenbergRangliste() : zwoelf(von)));
    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findByTestId('verbrauch-antwort')).toBeInTheDocument();
  });

  it('scheitert der Monatsverlauf, sagt die Fläche das mit „Erneut versuchen“ - kein Skelett ohne Ende (Review r3)', async () => {
    let kaputt = true;
    verdrahte(async (von, bis) => {
      if (von.slice(0, 7) === bis.slice(0, 7)) return ahrenbergRangliste();
      if (kaputt) throw new ApiError(500, 'kaputt');
      return zwoelf(von);
    });
    render(<VerbrauchPage onOeffnen={vi.fn()} onListe={vi.fn()} onNavigate={vi.fn()} />);
    await screen.findByTestId('verbrauch-antwort');
    const fehler = await screen.findByTestId('verbrauch-verlauf-fehler');
    expect(fehler).toHaveTextContent(VERLAUF_FEHLER);
    expect(document.querySelector('.vp-vb-f-verlauf-platz')).toBeNull();
    kaputt = false;
    fireEvent.click(within(fehler).getByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findByTestId('verbrauch-verlauf')).toBeInTheDocument();
    expect(screen.queryByTestId('verbrauch-verlauf-fehler')).toBeNull();
  });

  it('ohne Recht: der Grund statt eines Versuchs', async () => {
    verdrahte(async () => {
      throw new ApiError(403, 'verboten');
    });
    render(<VerbrauchPage onOeffnen={vi.fn()} onListe={vi.fn()} onNavigate={vi.fn()} />);
    expect(await screen.findByText(VERBRAUCH_GESPERRT)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Erneut versuchen' })).toBeNull();
  });
});
