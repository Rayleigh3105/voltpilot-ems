import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listUsers = vi.fn();
const listSites = vi.fn();
const resetPassword = vi.fn();
const updateUser = vi.fn();
const deleteUser = vi.fn();
const disableUser = vi.fn();
const enableUser = vi.fn();
const selbstauskunft = vi.fn();
const beendenMandant = vi.fn();
const wiederaufnehmenMandant = vi.fn();

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
    beendenMandant: (...a: unknown[]) => beendenMandant(...a),
    wiederaufnehmenMandant: (...a: unknown[]) => wiederaufnehmenMandant(...a),
  },
}));

vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof import('../../api')>('../../api');
  return { ...actual, api: { ...actual.api, selbstauskunft: (...a: unknown[]) => selbstauskunft(...a) } };
});

const { MandantenPage, mandantAusHash, mandantHash } = await import('./MandantenPage');

// Die Mandanten-Seite steht in der Adresse; jeder Fall beginnt auf der Liste.
beforeEach(() => {
  window.location.hash = '';
});

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
    selbstauskunft.mockReset().mockResolvedValue({ kundenbereich: { id: 't-1', name: TENANT.name, beendet: null } });
    beendenMandant.mockReset();
    wiederaufnehmenMandant.mockReset();
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
    // Der Grund steht sichtbar daneben, nicht nur ein grauer Knopf.
    expect(screen.getByRole('button', { name: 'Benutzer anlegen' })).toHaveAccessibleDescription(
      /Weitere Benutzer und Startpasswörter vergibt der Kundenadministrator im Portal/,
    );
  });

  it('öffnet den Mandanten als Seite mit Adresse, nicht als Dialog, und führt zurück zur Liste', async () => {
    openDetail();
    expect(await screen.findByRole('region', { name: TENANT.name })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(window.location.hash).toBe('#/mandanten?mandant=t-1');
    expect(screen.queryByRole('button', { name: `Details zu ${TENANT.name}` })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Alle Mandanten' }));
    expect(screen.getByRole('button', { name: `Details zu ${TENANT.name}` })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/mandanten');
  });

  it('liest den Mandanten nur aus der eigenen Adresse', () => {
    expect(mandantAusHash(mandantHash('a b'))).toBe('a b');
    expect(mandantAusHash('#/mandanten')).toBeNull();
    expect(mandantAusHash('#/werkstatt?mandant=x')).toBeNull();
    expect(mandantHash(null)).toBe('#/mandanten');
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
    const drawer = await screen.findByRole('region', { name: TENANT.name });
    expect(
      within(drawer).getByRole('button', { name: /In Mandanten-Ansicht springen/ }),
    ).toBeInTheDocument();
    // Die drei früheren Wörter für DIESELBE Sache kommen nicht mehr vor.
    expect(document.body.textContent).not.toContain('Portal-Ansicht');
    expect(document.body.textContent).not.toContain('Kundensicht');
    expect(document.body.textContent).not.toContain('Kontext-Umschalter');
  });

  it('N1: beendet den Vertrag mit Frist und schließt die Gefahrenzone bis zu deren Ablauf', async () => {
    openDetail();
    const drawer = await screen.findByRole('region', { name: TENANT.name });
    // Solange der Vertrag aktiv ist, ist Löschen nur möglich, wenn man zuerst beendet.
    expect(within(drawer).getByText(/erst, nachdem der Vertrag beendet wurde/)).toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: 'Mandant löschen (Offboarding)' })).not.toBeInTheDocument();

    fireEvent.click(within(drawer).getByRole('button', { name: 'Vertrag beenden' }));
    const dlg = await screen.findByRole('dialog', { name: /Vertrag beenden/ });
    fireEvent.change(within(dlg).getByLabelText('Auftrag'), { target: { value: 'TICKET-1' } });
    fireEvent.change(within(dlg).getByLabelText('Begründung'), { target: { value: 'Kunde hat gekündigt' } });
    fireEvent.change(within(dlg).getByLabelText(`Zur Bestätigung „${TENANT.name}" eintippen`), {
      target: { value: TENANT.name },
    });
    beendenMandant.mockResolvedValue({ zustand: 'beendet' });
    selbstauskunft.mockResolvedValue({
      kundenbereich: {
        id: 't-1',
        name: TENANT.name,
        beendet: { beendet_am: '2029-01-01', loeschung_fruehestens: '2029-04-01', liest: true, text: '' },
      },
    });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Vertrag beenden' }));
    await waitFor(() =>
      expect(beendenMandant).toHaveBeenCalledWith('t-1', {
        auftrag: 'TICKET-1',
        begruendung: 'Kunde hat gekündigt',
        confirmName: TENANT.name,
        fristTage: 90,
      }),
    );
    expect(await within(drawer).findByText(/am 01.01.2029 beendet/)).toBeInTheDocument();
    // Gelöscht wird erst nach der Frist (hier: in der Zukunft) - der Knopf bleibt deshalb aus.
    expect(within(drawer).queryByRole('button', { name: 'Mandant löschen (Offboarding)' })).not.toBeInTheDocument();
    expect(within(drawer).getByText(/Die Frist läuft noch bis 01.04.2029/)).toBeInTheDocument();
  });

  it('verspricht den Sprung wieder ohne Bedingung: Seite und Dialog nennen den Umschalter, keine Unterstützung', async () => {
    render(<MandantenPage tenants={[TENANT]} onReloadTenants={vi.fn()} onJumpToTenant={vi.fn()} />);
    // Seit dem 26.10.2026 ist der Umschalter wieder offen: die Plattform springt ohne Unterstützung hinein.
    expect(screen.getByText(/oben über den Mandanten-Umschalter in die Ansicht eines Mandanten springen/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `Details zu ${TENANT.name}` }));
    const drawer = await screen.findByRole('region', { name: TENANT.name });
    expect(within(drawer).getByText(/„In Mandanten-Ansicht springen“ zeigt Anlagen, Geräte und Übersicht wie der Kunde/)).toBeInTheDocument();
    expect(within(drawer).getByText(/Eine Unterstützung oder ein Notfall-Zugriff ist dafür\s+nicht nötig/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('öffnet sich nur');
    expect(document.body.textContent).not.toContain('beschränkt auf die Standorte Ihrer Unterstützung');
    expect(within(drawer).getByRole('button', { name: /In Mandanten-Ansicht springen/ })).toBeEnabled();
  });
});

/**
 * ⚠ SOLLTE-3/4-WÄCHTER: scheitert der Mandanten-Abruf (leer + Fehler), darf die
 * Seite NICHT ewig das Tabellen-Skelett zeigen (das läse sich wie „lädt noch")
 * und NICHT den Leer-Zustand „Noch keine Mandanten" behaupten (das wäre eine
 * erfundene Null über einer Störung). Sie zeigt die ehrliche Fehlerkarte mit
 * „Erneut versuchen", das `onReloadTenants` auslöst.
 */
describe('MandantenPage - Mandanten-Abruf gescheitert', () => {
  it('zeigt die Fehlerkarte statt Dauer-Skelett oder erfundenem Leer-Zustand', () => {
    render(
      <MandantenPage
        tenants={[]}
        tenantsLoaded
        tenantsError
        onReloadTenants={vi.fn()}
        onJumpToTenant={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/Die Mandantenliste ließ sich gerade nicht laden/),
    ).toBeInTheDocument();
    // Weder das Lade-Skelett (aria-busy) noch der ehrliche Leer-Zustand.
    expect(screen.queryByText('Noch keine Mandanten')).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('lädt auf „Erneut versuchen" die Mandanten neu', () => {
    const onReloadTenants = vi.fn();
    render(
      <MandantenPage
        tenants={[]}
        tenantsLoaded
        tenantsError
        onReloadTenants={onReloadTenants}
        onJumpToTenant={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Erneut versuchen/ }));
    expect(onReloadTenants).toHaveBeenCalledTimes(1);
  });
});
