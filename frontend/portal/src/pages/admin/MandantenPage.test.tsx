import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listUsers = vi.fn();
const listSites = vi.fn();
const resetPassword = vi.fn();
const updateUser = vi.fn();
const deleteUser = vi.fn();
const disableUser = vi.fn();
const enableUser = vi.fn();

vi.mock('../../admin/adminApi', () => ({
  adminApi: {
    listUsers: (...a: unknown[]) => listUsers(...a),
    listSites: (...a: unknown[]) => listSites(...a),
    resetPassword: (...a: unknown[]) => resetPassword(...a),
    updateUser: (...a: unknown[]) => updateUser(...a),
    deleteUser: (...a: unknown[]) => deleteUser(...a),
    disableUser: (...a: unknown[]) => disableUser(...a),
    enableUser: (...a: unknown[]) => enableUser(...a),
    createUser: vi.fn(),
    createSite: vi.fn(),
    updateTenant: vi.fn(),
    deleteTenant: vi.fn(),
  },
}));

const { MandantenPage } = await import('./MandantenPage');

const TENANT = {
  id: 't-1',
  name: 'Nordwind GmbH',
  segment: 'CI',
  plan: 'basic',
  betriebsart: null,
  betriebsartEffective: 'betreiber' as const,
  createdAt: '2026-01-01T00:00:00Z',
};

const USER = {
  id: 'u-1',
  username: 'anna',
  email: 'anna@example.com',
  firstName: 'Anna',
  lastName: 'Berg',
  enabled: true,
};

function openDetail() {
  render(
    <MandantenPage tenants={[TENANT]} onReloadTenants={vi.fn()} onJumpToTenant={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole('button', { name: `Details zu ${TENANT.name}` }));
}

/**
 * Admin-Umbau Stufe 4 „Feinschliff" (Captain-Entscheid F5): die
 * Benutzer-Verwaltung wohnt im Mandanten-Drawer - inklusive des
 * Passwort-Resets, denn zwei halbe Wahrheiten sind schlechter als eine ganze.
 */
describe('MandantenPage - die gefaltete Benutzer-Verwaltung', () => {
  beforeEach(() => {
    listUsers.mockResolvedValue([USER]);
    listSites.mockResolvedValue([]);
    resetPassword.mockReset().mockResolvedValue(undefined);
    updateUser.mockReset().mockResolvedValue(undefined);
    deleteUser.mockReset().mockResolvedValue(undefined);
    disableUser.mockReset().mockResolvedValue(undefined);
    enableUser.mockReset().mockResolvedValue(undefined);
  });

  it('belässt die Profilhandlungen in der Plattformverwaltung', async () => {
    openDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Aktionen für anna' }));
    for (const label of ['Bearbeiten', 'Deaktivieren', 'Löschen']) {
      expect(screen.getByRole('menuitem', { name: label })).toBeInTheDocument();
    }
  });

  it('überlässt weitere Benutzer und Startpasswörter dem Kundenadministrator', async () => {
    openDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Aktionen für anna' }));
    expect(screen.queryByRole('menuitem', { name: 'Passwort zurücksetzen' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Benutzer anlegen' })).toBeDisabled();
  });

  it('bearbeitet einen Benutzer, ohne den Anmeldenamen anzufassen', async () => {
    openDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Aktionen für anna' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Bearbeiten' }));

    const edit = await screen.findByRole('dialog', { name: /Benutzer bearbeiten: anna/ });
    // Der Anmeldename ist Identität und bleibt gesperrt.
    expect(within(edit).getByLabelText('Benutzername')).toBeDisabled();
    fireEvent.change(within(edit).getByLabelText('E-Mail'), {
      target: { value: 'neu@example.com' },
    });
    fireEvent.click(within(edit).getByRole('button', { name: 'Änderungen speichern' }));
    await waitFor(() =>
      expect(updateUser).toHaveBeenCalledWith('t-1', 'u-1', {
        email: 'neu@example.com',
        firstName: 'Anna',
        lastName: 'Berg',
      }),
    );
  });

  it('fragt vor dem Löschen im HAUS-Muster - erst nach der Folgenliste wird gelöscht', async () => {
    openDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Aktionen für anna' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Löschen' }));

    // Der erste Klick löscht NICHTS - er stellt die Frage.
    expect(deleteUser).not.toHaveBeenCalled();
    const dlg = await screen.findByRole('dialog', { name: /Benutzer löschen/ });
    expect(dlg.textContent).toContain('lässt sich nicht rückgängig machen');
    // Und er sagt, was NICHT passiert.
    expect(dlg.textContent).toContain('Anlagen und Daten des Mandanten bleiben unberührt');

    fireEvent.click(within(dlg).getByRole('button', { name: 'Benutzer löschen' }));
    await waitFor(() => expect(deleteUser).toHaveBeenCalledWith('t-1', 'u-1'));
  });

  it('bricht die Rückfrage folgenlos ab', async () => {
    openDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Aktionen für anna' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Deaktivieren' }));
    const dlg = await screen.findByRole('dialog', { name: /Benutzer deaktivieren/ });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Abbrechen' }));
    expect(disableUser).not.toHaveBeenCalled();
  });

  it('zeigt einem deaktivierten Benutzer „Aktivieren" statt „Deaktivieren"', async () => {
    listUsers.mockResolvedValue([{ ...USER, enabled: false }]);
    openDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Aktionen für anna' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Aktivieren' }));
    // Ein Zugang WIEDER zu öffnen ist nicht destruktiv - es fragt nicht.
    await waitFor(() => expect(enableUser).toHaveBeenCalledWith('t-1', 'u-1'));
    expect(screen.queryByRole('dialog', { name: /deaktivieren/i })).toBeNull();
  });

  it('beschreibt „Automatisch" so, wie die Schale wirklich entscheidet (F7)', async () => {
    openDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Bearbeiten' }));
    // Seit dem Picker-System ist die Betriebsart der Haus-Picker, kein
    // Browser-Auswahlfeld: geöffnet wird der Auslöser, gelesen wird die Zeile.
    fireEvent.click(await screen.findByRole('combobox', { name: /Betriebsart/ }));
    // Die Vorgabe wird NICHT aus dem Segment abgeleitet (Audit HIGH-1: das
    // segment steht per Vorgabe auf CI und hätte jeden Bestandskunden in die
    // Betreiber-Schale gekippt) - die Schale zählt die Anlagen.
    expect(screen.getByRole('option', { name: /Automatisch/ }).textContent)
      .toContain('nach Anzahl Anlagen');
    expect(document.body.textContent).not.toContain('aus Segment abgeleitet');
    expect(document.body.textContent).not.toContain('B2C → Endkunde');
  });

  it('spricht durchgehend von der Mandanten-Ansicht (F7, keine Umbenennung)', async () => {
    openDetail();
    const drawer = await screen.findByRole('dialog', { name: TENANT.name });
    expect(
      within(drawer).getByRole('button', { name: /In Mandanten-Ansicht springen/ }),
    ).toBeInTheDocument();
    // Die drei früheren Wörter für DIESELBE Sache kommen nicht mehr vor.
    expect(document.body.textContent).not.toContain('Portal-Ansicht');
    expect(document.body.textContent).not.toContain('Kundensicht');
    expect(document.body.textContent).not.toContain('Kontext-Umschalter');
  });
});
