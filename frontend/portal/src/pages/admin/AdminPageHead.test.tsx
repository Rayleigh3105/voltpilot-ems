import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AdminPageHead } from './AdminPageHead';

describe('AdminPageHead', () => {
  it('renders the title, description and an actions slot', () => {
    render(
      <AdminPageHead
        icon="building"
        title="Mandanten"
        description="Kunden plattformweit verwalten."
        actions={<button type="button">Mandant anlegen</button>}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Mandanten' })).toBeInTheDocument();
    expect(screen.getByText('Kunden plattformweit verwalten.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mandant anlegen' })).toBeInTheDocument();
  });

  it('omits the description and actions when not given', () => {
    const { container } = render(<AdminPageHead icon="settings" title="Optimizer" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Optimizer' })).toBeInTheDocument();
    expect(container.querySelector('.vp-page-head .actions')).toBeNull();
    // The leading IconTile is always present so the console reads consistently.
    expect(container.querySelector('.vp-admin-head-main')).not.toBeNull();
  });
});
