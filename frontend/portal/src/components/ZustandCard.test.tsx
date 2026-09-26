import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { ZustandCard } from './ZustandCard';
import { healthChecklist } from '../health';

/**
 * Dünner Render-Beweis der Zustand-Fläche (die pure Abdeckung liegt in
 * `health.test.ts` `zustandView`): grün = EINE Zeile + Details-Aufklapper,
 * Befund = laute Karte mit Ursache + Hebel, und der Modus-Fuß wohnt in
 * BEIDEN Zuständen in der Fläche (D6) mit unverändertem Wortlaut.
 */

const ALL_OK = healthChecklist({
  deviceCount: 1,
  onlineCount: 1,
  waitingCount: 0,
  hasPlanToday: true,
  hasAnyPlan: true,
  controlState: 'healthy',
  batteryWithoutDevice: false,
  batteryLinked: true,
});

const WARN = healthChecklist({
  deviceCount: 1,
  onlineCount: 0,
  waitingCount: 0,
  hasPlanToday: true,
  hasAnyPlan: true,
  controlState: 'healthy',
  batteryWithoutDevice: false,
  batteryLinked: true,
});

describe('ZustandCard', () => {
  it('grün: die eine Zeile, die Checkliste erst hinter „Details"', () => {
    const { container, getByRole, getByText } = render(
      <ZustandCard items={ALL_OK} onOpenSub={() => {}} onOpenModus={() => {}} />,
    );
    expect(container.textContent).toContain('Alles in Ordnung');
    expect(container.textContent).toContain('arbeiten zusammen');
    // Nicht laut, keine vier Zeilen sichtbar …
    expect(container.querySelector('.vp-zustand.befund')).toBeNull();
    expect(container.querySelector('.vp-health-list')).toBeNull();
    // … bis Details aufklappt (nichts ist gelöscht, nur still).
    const details = getByRole('button', { name: /Details/ });
    expect(details).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(details);
    expect(container.querySelector('.vp-health-list')).not.toBeNull();
    expect(getByText('Sollwert bestätigt')).toBeInTheDocument();
  });

  it('Befund: laute Karte mit Titel, Badge-Wort, Ursache und Hebel', () => {
    const onOpenSub = vi.fn();
    const { container, getByRole } = render(
      <ZustandCard items={WARN} onOpenSub={onOpenSub} onOpenModus={() => {}} />,
    );
    expect(container.querySelector('.vp-zustand.befund')).not.toBeNull();
    expect(container.textContent).toContain('Zustand der Anlage');
    expect(container.textContent).toContain('Warnung');
    expect(container.textContent).toContain('Gerät: meldet sich nicht');
    // Die gesunden Reste als EINE gedämpfte Zeile.
    expect(container.textContent).toContain('Fahrplan, Steuerung und Speicher: in Ordnung.');
    // Der Hebel führt zur Unterseite.
    fireEvent.click(getByRole('button', { name: /Aufbau/ }));
    expect(onOpenSub).toHaveBeenCalledWith('modell');
  });

  it('der Modus-Fuß wohnt in BEIDEN Zuständen in der Fläche, Wortlaut unverändert', () => {
    for (const items of [ALL_OK, WARN]) {
      const onOpenModus = vi.fn();
      const { container, unmount, getByRole } = render(
        <ZustandCard items={items} onOpenSub={() => {}} onOpenModus={onOpenModus} />,
      );
      const foot = container.querySelector('.vp-zustand-foot .vp-toolbox-line');
      expect(foot).not.toBeNull();
      expect(foot?.textContent).toContain('Ihre Anlage kann mehr');
      fireEvent.click(getByRole('button', { name: /Betriebsmodell wählen/ }));
      expect(onOpenModus).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it('ohne einen einzigen Fakt rendert nichts', () => {
    const { container } = render(
      <ZustandCard items={[]} onOpenSub={() => {}} onOpenModus={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
