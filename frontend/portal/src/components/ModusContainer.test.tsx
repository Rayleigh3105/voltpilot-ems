import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ModusContainer } from './ModusContainer';
import { activeModes, type ActiveMode } from '../surface';
import type { SiteProfile } from '../profiles';

/** The market mode (masterdata-driven), with its four claimed settings + views. */
function marktMode(): ActiveMode {
  const mode = activeModes({
    config: { plantKind: 'direktvermarktung', tarifArt: 'dynamisch' },
  }).find((m) => m.kind === 'marktvermarktung');
  if (!mode) throw new Error('expected a marktvermarktung mode');
  return mode;
}

function profile(over: Partial<SiteProfile> & { id: string; label: string }): SiteProfile {
  return {
    state: null,
    derivedActive: false,
    active: false,
    unlocks: { views: [], widgets: [], moneyStream: null },
    requirements: [],
    blockedReason: null,
    origin: null,
    flowRef: null,
    gatedNodeTypes: [],
    gatedNodesEnabled: true,
    ...over,
  };
}

const NOOP = {
  onToggle: vi.fn(),
  onBack: vi.fn(),
  onNavigate: vi.fn(),
  onOpenFlow: vi.fn(),
};

describe('ModusContainer (v3.1-M2)', () => {
  it('an ACTIVE mode shows read-only settings and the mode’s views', () => {
    const mode = marktMode();
    render(
      <ModusContainer
        profile={profile({ id: 'marktvermarktung', label: 'Marktvermarktung', active: true, origin: 'masterdata' })}
        mode={mode}
        activeModes={[mode]}
        earnings={null}
        busy={false}
        {...NOOP}
      />,
    );

    // Settings section renders read-only rows from settingsForMode().
    expect(screen.getByText('Einstellungen')).toBeInTheDocument();
    expect(screen.getByText('Netzladen des Speichers')).toBeInTheDocument();
    expect(screen.getByText('Anzulegender Wert')).toBeInTheDocument();

    // The mode's own views (= the sidebar group's entries).
    expect(screen.getByText('Ansichten dieses Modus')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Fahrplan/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Marktpreise/ })).toBeInTheDocument();

    // A masterdata mode is honestly labelled and never promises an editable flow.
    expect(screen.getByText('Von VoltPilot eingerichtet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Flow öffnen/ })).toBeNull();
  });

  it('clicking a view navigates via onNavigate (active mode)', () => {
    const mode = marktMode();
    const onNavigate = vi.fn();
    render(
      <ModusContainer
        profile={profile({ id: 'marktvermarktung', label: 'Marktvermarktung', active: true })}
        mode={mode}
        activeModes={[mode]}
        earnings={null}
        busy={false}
        onToggle={vi.fn()}
        onBack={vi.fn()}
        onNavigate={onNavigate}
        onOpenFlow={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Fahrplan/ }));
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'sub', sub: 'fahrplan' });
  });

  it('an INACTIVE mode shows NO settings section (owner correction: no teaser)', () => {
    render(
      <ModusContainer
        profile={profile({
          id: 'marktvermarktung',
          label: 'Marktvermarktung',
          active: false,
          requirements: [{ label: 'Dynamischer Tarif', met: false }],
        })}
        mode={null}
        activeModes={[]}
        earnings={null}
        busy={false}
        {...NOOP}
      />,
    );

    // No settings at all - not a locked teaser.
    expect(screen.queryByText('Einstellungen')).toBeNull();
    expect(screen.queryByText('Netzladen des Speichers')).toBeNull();

    // But benefit, prerequisites and the mode's views still render.
    expect(screen.getByText('Voraussetzungen')).toBeInTheDocument();
    expect(screen.getByText(/Dynamischer Tarif fehlt/)).toBeInTheDocument();
    expect(screen.getByText('Ansichten dieses Modus')).toBeInTheDocument();
    // Inactive views are shown but not clickable (no empty-state landings).
    expect(screen.queryByRole('button', { name: /Fahrplan/ })).toBeNull();
    expect(screen.getByText(/sobald Sie den Modus einschalten/)).toBeInTheDocument();
  });

  it('the head switch toggles the mode without navigating away', () => {
    const onToggle = vi.fn();
    const onBack = vi.fn();
    render(
      <ModusContainer
        profile={profile({ id: 'marktvermarktung', label: 'Marktvermarktung', active: false })}
        mode={null}
        activeModes={[]}
        earnings={null}
        busy={false}
        onToggle={onToggle}
        onBack={onBack}
        onNavigate={vi.fn()}
        onOpenFlow={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('switch', { name: /Marktvermarktung einschalten/ }));
    expect(onToggle).toHaveBeenCalledWith('marktvermarktung', 'an');
    expect(onBack).not.toHaveBeenCalled();
  });
});
