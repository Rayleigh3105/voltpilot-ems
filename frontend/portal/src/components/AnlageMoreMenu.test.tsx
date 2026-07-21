import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AnlageMoreMenu } from './AnlageMoreMenu';
import { DEEP_VIEW_ITEMS } from '../anlageNav';

/**
 * M1 (#529): the interim access affordance. With the tab bar retired and the
 * block drill-ins still to come (M3), this menu is what proves no deep view is
 * orphaned - so the test asserts exactly that.
 */
describe('AnlageMoreMenu', () => {
  it('offers EVERY deep view once the menu is open', () => {
    render(<AnlageMoreMenu activeSub={null} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Mehr/ }));
    for (const item of DEEP_VIEW_ITEMS) {
      expect(screen.getByRole('menuitem', { name: item.label })).toBeInTheDocument();
    }
  });

  it('opens the picked deep view and closes', () => {
    const onOpen = vi.fn();
    render(<AnlageMoreMenu activeSub={null} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: /Mehr/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Lastspitzen' }));
    expect(onOpen).toHaveBeenCalledWith('lastspitzen');
    expect(screen.queryByRole('menuitem', { name: 'Lastspitzen' })).toBeNull();
  });

  it('marks the deep view currently open', () => {
    render(<AnlageMoreMenu activeSub="fahrplan" onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Mehr/ }));
    expect(screen.getByRole('menuitem', { name: 'Fahrplan' })).toHaveClass('active');
    expect(screen.getByRole('menuitem', { name: 'Wetter' })).not.toHaveClass('active');
  });

  it('renders nothing until opened', () => {
    render(<AnlageMoreMenu activeSub={null} onOpen={vi.fn()} />);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
