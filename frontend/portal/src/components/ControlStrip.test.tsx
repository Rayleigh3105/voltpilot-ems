import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ControlStrip } from './ControlStrip';
import type { ControlStripView } from '../control';

function view(over: Partial<ControlStripView> = {}): ControlStripView {
  return {
    state: 'healthy',
    tone: 'ok',
    sentence: 'Fahrplan-Sollwert 10,8 kW → Wechselrichter bestätigt 10,8 kW',
    agoNote: 'geprüft vor 3 s',
    reason: null,
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
    expect(screen.getByText(/Fahrplan-Sollwert/)).toBeInTheDocument();
  });
});
