import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { benutzerApi } from '../benutzer';
import { rechteSeed } from '../test/rollenFixtures';
import { setSelbstauskunft } from '../rollen';
import { BenutzerAnlegenDialog } from './BenutzerAnlegenDialog';
import { StartpasswortNeuVergeben } from './StartpasswortNeuVergeben';

vi.mock('../benutzer', async (original) => ({ ...(await original<typeof import('../benutzer')>()),
  benutzerApi: { anlegen: vi.fn(), startpasswort: vi.fn() } }));
const konto = { sub: 'IK', anzeigename: 'Ines Kaltenbach', email: 'ines@ahrenberg.example', zustand: 'angelegt' as const };
const anlage = { username: 'ines', email: konto.email, vorname: 'Ines', nachname: 'Kaltenbach', rolle: 'energiemanager', standorte: [] };
const erstellt = vi.fn();
function Anlage() {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Anlegen öffnen</button>
    <BenutzerAnlegenDialog open={open} onClose={() => setOpen(false)} anlage={anlage} rollenname="Energiemanager"
      standortnamen={[]} onCreated={erstellt} /></>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('localStorage', { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn() });
  vi.stubGlobal('sessionStorage', { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn() });
  setSelbstauskunft(rechteSeed('JW').me);
  vi.mocked(benutzerApi.anlegen).mockResolvedValue({ benutzer: konto, startpasswort: 'NurEinmal-Testpasswort-23!' });
  vi.mocked(benutzerApi.startpasswort).mockResolvedValue({ benutzer: konto, startpasswort: 'NeuEinmal-Testpasswort-24!' });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe('N3 und der Hebel in N1', () => {
  it('zeigt und kopiert das Passwort einmal; nach Schließen ist es verworfen', async () => {
    render(<Anlage />);
    const ausloeser = screen.getByRole('button', { name: 'Anlegen öffnen' });
    fireEvent.click(ausloeser);
    fireEvent.click(screen.getByRole('button', { name: 'Benutzer anlegen' }));
    expect(await screen.findByText(/Nach dem Schließen können Sie es nicht wieder anzeigen/)).toBeInTheDocument();
    expect(erstellt).not.toHaveBeenCalled();
    expect(benutzerApi.anlegen).toHaveBeenCalledWith(anlage);
    fireEvent.click(screen.getByRole('button', { name: 'Startpasswort kopieren' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Startpasswort kopiert.')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Schließen' }).at(-1)!);
    expect(erstellt).toHaveBeenCalledWith(konto);
    fireEvent.click(ausloeser);
    expect(screen.queryByLabelText('Startpasswort')).not.toBeInTheDocument();
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(sessionStorage.setItem).not.toHaveBeenCalled();
  });

  it('fragt vor der Neuvergabe; Escape verwirft auch deren Anzeige', async () => {
    render(<StartpasswortNeuVergeben sub="IK" name="Ines Kaltenbach" />);
    fireEvent.click(screen.getByRole('button', { name: 'Startpasswort neu vergeben' }));
    expect(benutzerApi.startpasswort).not.toHaveBeenCalled();
    expect(screen.getByText(/Das bisherige Passwort wird ersetzt/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Startpasswort vergeben' }));
    await screen.findByLabelText('Startpasswort');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('Startpasswort')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Startpasswort neu vergeben' }));
    expect(screen.queryByLabelText('Startpasswort')).not.toBeInTheDocument();
    expect(benutzerApi.startpasswort).toHaveBeenCalledWith('IK');
  });

  it('zeigt den Hebel ohne Kundenadministratorrecht nicht', () => {
    setSelbstauskunft(rechteSeed('IK').me);
    render(<StartpasswortNeuVergeben sub="IK" name="Ines Kaltenbach" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('gibt keine technischen Fehlertexte aus und lässt einen neuen Versuch zu', async () => {
    vi.mocked(benutzerApi.anlegen).mockRejectedValueOnce(new Error('upstream technical secret'));
    render(<Anlage />); fireEvent.click(screen.getByRole('button', { name: 'Anlegen öffnen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Benutzer anlegen' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Bitte versuchen Sie es erneut.');
    expect(screen.queryByText(/upstream technical secret/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Benutzer anlegen' })).not.toBeDisabled();
  });
});
