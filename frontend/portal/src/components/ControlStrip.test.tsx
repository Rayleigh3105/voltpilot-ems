import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ControlStrip } from './ControlStrip';
import type { ControlStripView } from '../control';
import type { ExportGuardView } from '../curtailment';
import type { SteuerSpalte } from '../kacheln';

function view(over: Partial<ControlStripView> = {}): ControlStripView {
  return {
    state: 'healthy',
    tone: 'ok',
    sentence: 'Ihr Gerät regelt gerade auf 10,8 kW → Wechselrichter bestätigt 10,8 kW',
    agoNote: 'geprüft vor 3 s',
    reason: null,
    execution: null,
    curtailment: null,
    outlook: null,
    ...over,
  };
}

function guard(over: Partial<ExportGuardView> = {}): ExportGuardView {
  return {
    line:
      'Einspeisegrenze 70,0 kW. Kein Wechselrichter ist für die Abregelung freigegeben ' +
      '(0 von 2) - die Einspeisegrenze wird berechnet, aber an KEIN Gerät geschrieben.',
    kurz: 'Einspeisegrenze 70,0 kW',
    tone: 'warn',
    agoNote: '',
    deviceLimitLine: null,
    ...over,
  };
}

describe('ControlStrip', () => {
  it('renders the reason under the sentence when the plan recorded one', () => {
    const reason = 'Lädt günstig aus dem Netz: Börsenpreis 3,3 ct/kWh liegt unter dem Wert gespeicherter Energie.';
    const { container } = render(<ControlStrip view={view({ reason })} />);
    expect(screen.getByText(reason)).toBeInTheDocument();
    // The reason belongs to the same card, one notch quieter - never a banner.
    expect(container.querySelector('.vp-control-reason')).not.toBeNull();
  });

  it('renders nothing extra without a reason (the pre-2026-07-30 card)', () => {
    const { container } = render(<ControlStrip view={view()} />);
    expect(container.querySelector('.vp-control-reason')).toBeNull();
    expect(screen.getByText(/regelt gerade auf/)).toBeInTheDocument();
  });

  it('nennt die vom Gerät gemeldete Korrektur - in BEIDEN Varianten (PR 3)', async () => {
    const execution =
      'Der Fahrplan sah 4,3 kW vor — Ihr Haus braucht gerade mehr. Die Entladung wurde auf ' +
      'den nach Solar verbleibenden Verbrauch (7,1 kW) angehoben, damit kein Netzstrom nötig ist.';
    const karte = render(<ControlStrip view={view({ execution })} />);
    expect(karte.container.textContent).toContain('angehoben');
    karte.unmount();
    render(<ControlStrip view={view({ execution })} variant="zeile" />);
    fireEvent.click(screen.getByRole('button', { name: /Warum\?/ }));
    expect(within(await screen.findByRole('dialog')).getByText(execution)).toBeInTheDocument();
  });

  it('behauptet ohne gemeldete Korrektur keine (ältere Edge-Version)', () => {
    const { container } = render(<ControlStrip view={view()} />);
    expect(container.textContent).not.toContain('angehoben');
    expect(container.querySelector('.vp-control-reason')).toBeNull();
  });

  it('renders the Ruhe outlook line (Teil 3) in the card and in the sheet, else nothing', async () => {
    const outlook = '→ Weiter laut Fahrplan: Laden ab ca. 11:15 Uhr.';
    const karte = render(<ControlStrip view={view({ outlook })} />);
    expect(karte.container.querySelector('.vp-outlook')?.textContent).toBe(outlook);
    karte.unmount();
    const zeile = render(<ControlStrip view={view({ outlook })} variant="zeile" />);
    fireEvent.click(screen.getByRole('button', { name: /Warum\?/ }));
    expect(within(await screen.findByRole('dialog')).getByText(outlook)).toBeInTheDocument();
    zeile.unmount();
    // No outlook → no line.
    const { container } = render(<ControlStrip view={view()} />);
    expect(container.querySelector('.vp-outlook')).toBeNull();
  });

  describe('Steuerzeile (variant="zeile", Konzept b1 vom 20.10.2026)', () => {
    const SPALTEN: SteuerSpalte[] = [
      { titel: 'Auftrag', text: 'Speicher abgeben 0,3 kW', ton: 'ruhig' },
      { titel: 'Gerät', text: 'bestätigt 13:46', ton: 'ok' },
      { titel: 'Wirkung', text: 'entlädt 0,6 kW gemessen', ton: 'warn' },
    ];
    const REASON = 'Der Speicher hält Energie für einen späteren, wertvolleren Einsatz zurück.';
    const EXECUTION = 'Der Fahrplan sah 0,0 kW vor — der nach Solar verbleibende Verbrauch (0,8 kW) wird gerade aus dem Speicher gedeckt.';
    const GRENZE = 'Ihr Wechselrichter begrenzt die Einspeisung am Netzpunkt auf 70,0 kW — hinterlegt sind 75,0 kW.';

    it('ist EINE Zeile Auftrag › Gerät › Wirkung - kein Absatz darunter, kein Kartenrahmen', () => {
      const { container } = render(
        <ControlStrip view={view({ reason: REASON, execution: EXECUTION })} variant="zeile" spalten={SPALTEN} guard={guard({ tone: 'ok' })} />,
      );
      const zeile = screen.getByRole('button', { name: /Warum\?/ });
      expect(zeile.textContent).toContain('Speicher abgeben 0,3 kW');
      expect(zeile.textContent).toContain('bestätigt 13:46');
      expect(zeile.textContent).toContain('entlädt 0,6 kW gemessen');
      expect(container.querySelectorAll('.vp-steuer-pfeil')).toHaveLength(2);
      // Gründe und Grenze stehen NICHT in der Zeile, erst im Blatt.
      expect(container.textContent).not.toContain(REASON);
      expect(container.textContent).not.toContain('Einspeisegrenze 70,0 kW.');
      expect(container.querySelector('.vp-control-reason, .vp-guard-line, .vp-card')).toBeNull();
      expect(container.querySelector('.vp-steuer-glied.tone-warn')?.textContent).toContain('entlädt 0,6 kW');
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('„Warum?“ gliedert dieselben Sätze je Herkunft - Plan, Gerät, Grenze - und führt weiter', async () => {
      const onOpenSub = vi.fn();
      render(
        <ControlStrip
          view={view({ reason: REASON, execution: EXECUTION })}
          variant="zeile"
          spalten={SPALTEN}
          guard={guard({ tone: 'ok' })}
          onOpenSub={onOpenSub}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Warum\?/ }));
      const blatt = await screen.findByRole('dialog', { name: 'Steuerung jetzt' });
      expect(within(blatt).getByText('Plan').nextSibling?.textContent).toBe(REASON);
      expect(within(blatt).getByText('Gerät', { selector: 'dt' }).nextSibling?.textContent).toBe(EXECUTION);
      expect(within(blatt).getByText(/^Einspeisegrenze 70,0 kW\./)).toBeInTheDocument();
      fireEvent.click(within(blatt).getByRole('button', { name: /Zur Steuerung/ }));
      expect(onOpenSub).toHaveBeenCalledWith('steuerung');
    });

    it('zählt die Abweichung der Einspeisegrenze als Hinweis und führt mit „Prüfen“ in die Einstellungen', async () => {
      const onOpenSub = vi.fn();
      const { container } = render(
        <ControlStrip view={view()} variant="zeile" spalten={SPALTEN} guard={guard({ tone: 'ok', deviceLimitLine: GRENZE })} onOpenSub={onOpenSub} />,
      );
      expect(container.querySelector('.vp-steuer-hinweis')?.textContent).toBe('1 Hinweis');
      expect(container.textContent).not.toContain('70,0 kW — hinterlegt');
      fireEvent.click(screen.getByRole('button', { name: /Warum\?/ }));
      const befund = within(await screen.findByRole('dialog')).getByRole('note');
      expect(befund.textContent).toContain(GRENZE);
      fireEvent.click(within(befund).getByRole('button', { name: /Prüfen/ }));
      expect(onOpenSub).toHaveBeenCalledWith('technik');
    });

    it('ohne Spalten trägt der eine Satz die Zeile; ohne Steuerung die Einspeisegrenze', () => {
      const satz = render(<ControlStrip view={view({ state: 'off', tone: 'off', sentence: 'Steuerung ist aus' })} variant="zeile" />);
      expect(satz.container.querySelector('.vp-steuer-kette')?.textContent).toContain('Steuerung ist aus');
      satz.unmount();
      const nurGrenze = render(<ControlStrip view={null} variant="zeile" guard={guard()} />);
      expect(nurGrenze.container.querySelector('.vp-steuer-kette')?.textContent).toBe('Einspeisegrenze 70,0 kW');
      expect(nurGrenze.container.querySelector('.vp-steuer-hinweis')?.textContent).toBe('1 Hinweis');
    });

    it('öffnet am Telefon ein Blatt (BottomSheet) statt des Modals', async () => {
      render(<ControlStrip view={view()} variant="zeile" spalten={SPALTEN} isPhone />);
      fireEvent.click(screen.getByRole('button', { name: /Warum\?/ }));
      expect(await screen.findByRole('dialog', { name: 'Steuerung jetzt' })).toBeInTheDocument();
    });
  });

  describe('Einspeisewächter („Grenzen & Wächter" Stufe 0)', () => {
    it('rendert die Wächter-Zeile in der Karte', () => {
      const { container } = render(<ControlStrip view={view()} guard={guard()} />);
      expect(container.querySelector('.vp-guard-line.tone-warn')?.textContent).toContain(
        'an KEIN Gerät geschrieben',
      );
    });

    it('rendert den Streifen AUCH ohne Steuerzeile - der Wächter hängt nicht an ihr', () => {
      // Genau die Herzogau-Konstellation: ein Gerät ohne Batterie-Rücklesung
      // liefert keine Steuerzeile, hält aber sehr wohl eine Einspeisegrenze.
      const { container } = render(<ControlStrip view={null} guard={guard()} />);
      expect(container.querySelector('.vp-guard-line')).not.toBeNull();
      // Kein Punkt, kein Satz über die Batterie - nur der Wächter.
      expect(container.querySelector('.vp-control-dot')).toBeNull();
      expect(container.textContent).toContain('Steuerung');
    });

    it('rendert GAR NICHTS, wenn weder Steuerung noch Wächter etwas melden', () => {
      const { container } = render(<ControlStrip view={null} guard={null} />);
      expect(container.firstChild).toBeNull();
    });

    it('hängt das Alter an, sobald der Block nicht mehr frisch ist', () => {
      const { container } = render(
        <ControlStrip view={view()} guard={guard({ agoNote: 'zuletzt gemeldet vor 12 Min.' })} />,
      );
      expect(container.querySelector('.vp-guard-ago')?.textContent).toContain('vor 12');
    });

    it('zeigt die Diskrepanz zum Geräte-Limit als eigene Zeile', () => {
      const { container } = render(
        <ControlStrip
          view={view()}
          guard={guard({
            deviceLimitLine:
              'Ihr Wechselrichter begrenzt die Einspeisung am Netzpunkt auf 33,0 kW — ' +
              'hinterlegt sind 70,0 kW.',
          })}
        />,
      );
      const lines = container.querySelectorAll('.vp-guard-line');
      expect(lines).toHaveLength(2);
      expect(lines[1].textContent).toContain('33,0');
    });

    it('behauptet ohne Wächter nichts über eine Einspeisegrenze', () => {
      const { container } = render(<ControlStrip view={view()} />);
      expect(container.querySelector('.vp-guard-line')).toBeNull();
    });
  });
});
