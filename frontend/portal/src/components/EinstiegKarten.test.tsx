import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { energiemanagementRoute, pageRoute, standortBereichRoute, standortMessstellenRoute, verbesserungRoute } from '../nav';
import { BelegeKarte, StandortKarte } from './EinstiegKarten';

/** K6 (Konzept „Energiemanagement ohne Fachsprache“): die Einstiege je Rolle führen nur auf Seiten, die es gibt. */
describe('K6 · Einstiegs-Karten', () => {
  it('„Belege finden“: Berichte immer, Dokumente und Managementbewertung nur mit dem Energiemanagement', () => {
    const onNavigate = vi.fn();
    const { rerender } = render(<BelegeKarte berichte energiemanagement onNavigate={onNavigate} />);
    expect(screen.getAllByRole('button').map((b) => b.querySelector('.vp-ub-name')?.textContent)).toEqual(['Berichte', 'Dokumente', 'Managementbewertung']);
    fireEvent.click(screen.getByTestId('belege-dokumente'));
    expect(onNavigate).toHaveBeenCalledWith(energiemanagementRoute('dokumente'));
    rerender(<BelegeKarte berichte energiemanagement={false} onNavigate={onNavigate} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('belege-berichte'));
    expect(onNavigate).toHaveBeenLastCalledWith(pageRoute('portfolio-berichte'));
    rerender(<BelegeKarte berichte={false} energiemanagement={false} onNavigate={onNavigate} />);
    expect(screen.queryByTestId('baustein-belege')).toBeNull();
  });

  it('„Ihr Standort“: Aufbau nur mit Messfunktion, Messstellen immer, Abweichungen nur mit dem Recht', () => {
    const onNavigate = vi.fn();
    const { rerender } = render(
      <StandortKarte standorte={[{ id: 'st2', name: 'Werk Lindach', misst: true }]} abweichungen onNavigate={onNavigate} />,
    );
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Ihr Standort Werk Lindach');
    expect(screen.getAllByRole('button').map((b) => b.querySelector('.vp-ub-name')?.textContent)).toEqual(['Aufbau', 'Messstellen', 'Abweichungen']);
    fireEvent.click(screen.getByTestId('standort-aufbau-st2'));
    expect(onNavigate).toHaveBeenCalledWith(standortBereichRoute('st2', 'aufbau'));
    fireEvent.click(screen.getByTestId('standort-messstellen-st2'));
    expect(onNavigate).toHaveBeenCalledWith(standortMessstellenRoute('st2'));
    fireEvent.click(screen.getByTestId('standort-abweichungen'));
    expect(onNavigate).toHaveBeenCalledWith(verbesserungRoute('abweichungen'));
    rerender(
      <StandortKarte
        standorte={[
          { id: 'st1', name: 'Werk Ahrenberg', misst: false },
          { id: 'st2', name: 'Werk Lindach', misst: true },
        ]}
        abweichungen={false}
        onNavigate={onNavigate}
      />,
    );
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Ihre Standorte');
    expect(screen.getAllByRole('button').map((b) => b.querySelector('.vp-ub-name')?.textContent)).toEqual([
      'Werk Ahrenberg: Messstellen',
      'Werk Lindach: Aufbau',
      'Werk Lindach: Messstellen',
    ]);
    rerender(<StandortKarte standorte={[]} abweichungen onNavigate={onNavigate} />);
    expect(screen.queryByTestId('baustein-standort')).toBeNull();
  });
});
