import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { register, loginWithCredentials } = vi.hoisted(() => ({
  register: vi.fn(),
  loginWithCredentials: vi.fn(),
}));

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  register,
}));
vi.mock('./auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth')>()),
  loginWithCredentials,
}));

import { RegisterForm } from './App';
import { passwortFehler } from './passwortRegel';

// AP-20 E12: mindestens 12 Zeichen, nicht der Benutzername (= E-Mail).
describe('Passwort-Vorgabe der Selbstregistrierung', () => {
  beforeEach(() => {
    register.mockReset().mockResolvedValue({});
    loginWithCredentials.mockReset().mockResolvedValue(undefined);
  });

  function ausfuellen(passwort: string, email = 'erika@example.com') {
    render(<RegisterForm onBack={() => {}} />);
    fireEvent.change(screen.getByLabelText('Ihr Name oder Firmenname'), { target: { value: 'Erika Kaiser' } });
    fireEvent.change(screen.getByLabelText('E-Mail-Adresse'), { target: { value: email } });
    const feld = screen.getByLabelText('Passwort');
    fireEvent.change(feld, { target: { value: passwort } });
    fireEvent.blur(feld);
    fireEvent.click(screen.getByRole('button', { name: /Konto erstellen|Registrieren/ }));
  }

  it('lehnt 11 Zeichen ab und schickt nichts an die API', async () => {
    ausfuellen('abcdefghijk');
    expect(await screen.findByText('Noch 1 Zeichen – mindestens 12 sind nötig.')).toBeInTheDocument();
    expect(register).not.toHaveBeenCalled();
  });

  it('nimmt 12 Zeichen an', async () => {
    ausfuellen('abcdefghijkl');
    await waitFor(() => expect(register).toHaveBeenCalledWith({
      name: 'Erika Kaiser', email: 'erika@example.com', password: 'abcdefghijkl',
    }));
  });

  it('lehnt ein Passwort ab, das der E-Mail-Adresse (Benutzername) gleicht', async () => {
    ausfuellen('Erika@Example.com');
    expect(await screen.findByText('Das Passwort darf nicht Ihr Name oder Ihre E-Mail-Adresse sein.')).toBeInTheDocument();
    expect(register).not.toHaveBeenCalled();
  });

  it('nennt die Vorgabe im Hinweis mit 12 Zeichen', () => {
    render(<RegisterForm onBack={() => {}} />);
    expect(screen.getByText(/Mindestens 12 Zeichen/)).toBeInTheDocument();
  });

  it('lehnt auch den Namen als Passwort ab', () => {
    expect(passwortFehler('Erika Kaiser1', 'erika@example.com', 'erika kaiser1')).toBe(
      'Das Passwort darf nicht Ihr Name oder Ihre E-Mail-Adresse sein.',
    );
    expect(passwortFehler('', 'x')).toBe('Bitte wählen Sie ein Passwort mit mindestens 12 Zeichen.');
    expect(passwortFehler('abcdefghijkl', '', '')).toBeNull();
  });
});
