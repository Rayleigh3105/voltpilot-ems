import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import HelpPage from './HelpPage';
import { HelpProvider, HelpLink } from './HelpProvider';
import { useState } from 'react';

afterEach(() => { cleanup(); window.history.replaceState(null, '', '#/hilfe'); });

describe('help experience', () => {
  it('offers all categories and searches with an actionable empty state', () => {
    render(<HelpPage />);
    expect(screen.getByRole('heading', { name: 'VoltPilot verstehen' })).toBeVisible();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'unbekannteswort' } });
    expect(screen.getByRole('status')).toHaveTextContent('Keine Treffer');
    fireEvent.click(screen.getByRole('button', { name: 'zeigen Sie alle Themen an' }));
    expect(screen.getByRole('heading', { name: 'Erste Schritte' })).toBeVisible();
  });
  it('renders a useful not-found view instead of falling into the dashboard', () => {
    render(<HelpPage articleId="nicht-vorhanden" />);
    expect(screen.getByRole('heading', { name: 'Artikel nicht gefunden' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Zum Hilfe-Center' })).toHaveAttribute('href', '#/hilfe');
  });
  it('keeps edited input mounted while reading and following related articles', async () => {
    function WorkingPage() {
      const [value, setValue] = useState('');
      return <HelpProvider><input aria-label="Anlagenname" value={value} onChange={(e) => setValue(e.target.value)} /><HelpLink article="anlage-anlegen" /></HelpProvider>;
    }
    render(<WorkingPage />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Mein noch ungespeicherter Name' } });
    const link = screen.getByRole('link', { name: 'Diese Ansicht verstehen' });
    link.focus();
    fireEvent.click(link);
    expect(await screen.findByRole('heading', { name: 'Eine Anlage anlegen', level: 1 })).toBeVisible();
    fireEvent.click(screen.getByRole('link', { name: /Betriebsmodelle und Voraussetzungen/ }));
    expect(await screen.findByRole('heading', { name: 'Betriebsmodelle und Voraussetzungen', level: 1 })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Vorheriger Artikel' }));
    expect(await screen.findByRole('heading', { name: 'Eine Anlage anlegen', level: 1 })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(input).toHaveValue('Mein noch ungespeicherter Name');
    expect(link).toHaveFocus();
  });
});
