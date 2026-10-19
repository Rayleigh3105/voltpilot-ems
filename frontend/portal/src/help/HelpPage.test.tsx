import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
  it('zeigt die Gruppe 07 „MiSpeL“ und die Themenseite mit Kennzeile, Stand, Karten und Bildern (MP-50)', () => {
    render(<HelpPage />);
    const gruppe = screen.getByRole('heading', { name: 'MiSpeL', level: 2 }).closest('section')!;
    expect(gruppe).toHaveTextContent('07');
    expect(within(gruppe).getByRole('link', { name: /MiSpeL verstehen/ })).toHaveAttribute('href', '#/hilfe/mispel-verstehen');
    cleanup();
    render(<HelpPage articleId="mispel-verstehen" />);
    expect(screen.getByRole('heading', { name: 'Sonne und Netz in einem Speicher', level: 1 })).toBeVisible();
    expect(screen.getByText('MiSpeL · Speicher und Ladepunkte im Mischbetrieb')).toBeVisible();
    expect(screen.getByText(/^Stand Oktober 2026: /)).toBeVisible();
    for (const karte of ['Abgrenzungsoption', 'Pauschaloption']) expect(screen.getByRole('heading', { name: karte, level: 3 })).toBeVisible();
    for (const kette of ['Solaranlage → Stromnetz', 'Solaranlage → Speicher → Stromnetz', 'Stromnetz → Speicher → Stromnetz', 'Stromnetz → Haus oder Betrieb']) {
      expect(screen.getByRole('img', { name: kette })).toBeInTheDocument();
    }
    expect(screen.getByRole('img', { name: /^Schema eines Tages: 0 Uhr bis 5 Uhr: lädt günstigen Netzstrom; .*17 Uhr bis 21:30 Uhr: gibt ab: Haus und Netz$/ })).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'nein' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: /Begriffe einfach erklärt/ })).toHaveAttribute('href', '#/hilfe/glossar');
  });
});
