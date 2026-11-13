import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listUsers = vi.fn();
const listSites = vi.fn();
const resetPassword = vi.fn();
const updateUser = vi.fn();
const deleteUser = vi.fn();
const disableUser = vi.fn();
const enableUser = vi.fn();
const createUser = vi.fn();
const createPerson = vi.fn();
const selbstauskunft = vi.fn();
const beendenMandant = vi.fn();
const wiederaufnehmenMandant = vi.fn();
const benutzerListe = vi.fn();
const fleet = vi.fn();
const createTenant = vi.fn();
const deleteTenant = vi.fn();
// vp-kunde-sofort-loeschen-mit-daten: die Datenauskunft für den Löschdialog - gibt nie vor, ob gelöscht werden darf.
const kundeLoeschbarkeit = vi.fn();
// vp-kunde-loeschen-504: der Statusweg des serverseitigen Löschzugs.
const kundeLoeschlauf = vi.fn();

/** Ein fertiger Löschlauf, wie POST …/delete ihn liefert, wenn der Zug sofort durch ist. */
function fertigerLauf(bericht: unknown) {
  return {
    laufId: 'lauf-1', tenantId: 't-1', name: TENANT.name, stand: 'fertig',
    gestartetAm: '2026-11-12T10:50:00Z', beendetAm: '2026-11-12T10:51:00Z', fehler: null, bericht,
  };
}

vi.mock('../../admin/adminApi', () => ({
  adminApi: {
    listUsers: (...a: unknown[]) => listUsers(...a),
    listSites: (...a: unknown[]) => listSites(...a),
    resetPassword: (...a: unknown[]) => resetPassword(...a),
    updateUser: (...a: unknown[]) => updateUser(...a),
    deleteUser: (...a: unknown[]) => deleteUser(...a),
    disableUser: (...a: unknown[]) => disableUser(...a),
    enableUser: (...a: unknown[]) => enableUser(...a),
    createUser: (...a: unknown[]) => createUser(...a),
    createPerson: (...a: unknown[]) => createPerson(...a),
    createSite: vi.fn(),
    createTenant: (...a: unknown[]) => createTenant(...a),
    updateTenant: vi.fn(),
    deleteTenant: (...a: unknown[]) => deleteTenant(...a),
    beendenMandant: (...a: unknown[]) => beendenMandant(...a),
    wiederaufnehmenMandant: (...a: unknown[]) => wiederaufnehmenMandant(...a),
    kundeLoeschbarkeit: (...a: unknown[]) => kundeLoeschbarkeit(...a),
    kundeLoeschlauf: (...a: unknown[]) => kundeLoeschlauf(...a),
  },
}));

vi.mock('../../admin/fleetApi', () => ({
  fleetApi: { fleet: (...a: unknown[]) => fleet(...a) },
}));

vi.mock('../../benutzer', async () => {
  const actual = await vi.importActual<typeof import('../../benutzer')>('../../benutzer');
  return { ...actual, benutzerApi: { ...actual.benutzerApi, liste: (...a: unknown[]) => benutzerListe(...a) } };
});

vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof import('../../api')>('../../api');
  return { ...actual, api: { ...actual.api, selbstauskunft: (...a: unknown[]) => selbstauskunft(...a) } };
});

const { MandantenPage } = await import('./MandantenPage');

// Die Benutzer-Seite steht in der Adresse; jeder Fall beginnt auf der Liste.
beforeEach(() => {
  window.location.hash = '';
  fleet.mockReset().mockResolvedValue({ sites: [], unterstuetzungBis: {}, unterstuetzungStandorte: [], releases: [] });
  benutzerListe.mockReset().mockResolvedValue([]);
  kundeLoeschbarkeit.mockReset().mockResolvedValue({
    tenantId: 't-1', daten: ['messwerte'], beendetAm: null,
    folgen: { anlagen: 0, boxen: [], personen: 0 },
  });
  deleteTenant.mockReset();
  // Kein laufender Zug beim Öffnen des Dialogs (404 wie der Server ohne je einen Lauf).
  kundeLoeschlauf.mockReset().mockRejectedValue(Object.assign(new Error('Kein Löschzug'), { status: 404 }));
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
 * Admin-Umbau Scheibe S5 (Konzept `vp-adminview-konzept-k1` §4.5, E5 = A): die
 * Kundenakte zeigt Konto UND Rolle einer Person in EINER Liste statt in zwei
 * (Mandanten-Fenster und Benutzerseite der Kundenansicht).
 */
describe('MandantenPage - die Kundenakte', () => {
  beforeEach(() => {
    listUsers.mockResolvedValue([USER]);
    listSites.mockResolvedValue([]);
    resetPassword.mockReset().mockResolvedValue({ benutzer: { sub: 'u-1', anzeigename: 'Anna Berg', email: 'anna@example.com', zustand: 'aktiv' }, startpasswort: 'neues-geheim-456' });
    updateUser.mockReset().mockResolvedValue(undefined);
    createPerson.mockReset();
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

  it('fügt Konto und Rolle einer Person in EINER Zeile zusammen (E5)', async () => {
    benutzerListe.mockResolvedValue([
      { sub: 'u-1', anzeigename: 'Anna Berg', email: 'anna@example.com', zustand: 'aktiv',
        zuweisungen: [{ id: 'z-1', rolle: 'kundenadministrator', standort_id: null, standort_name: null, gueltig_ab: '2026-01-01', gueltig_bis: null }] },
    ]);
    openDetail();
    const zeile = (await screen.findByText('Anna Berg')).closest('tr');
    expect(zeile).not.toBeNull();
    // Dieselbe Zeile trägt sowohl die Konto-Aktionen (RowMenu) als auch die Rolle - keine zweite Liste.
    expect(within(zeile!).getByRole('button', { name: 'Aktionen für anna' })).toBeInTheDocument();
    expect(zeile!.textContent).toContain('Kundenadministrator');
  });

  it('bietet „Person hinzufügen" statt der alten Abgabe an den Kundenadministrator an (P2, W4 fällt)', async () => {
    openDetail();
    await screen.findByRole('button', { name: 'Aktionen für anna' });
    expect(screen.queryByText(/Weitere Personen lädt der Kundenadministrator ein/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Benutzer anlegen' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Person hinzufügen' })).toBeInTheDocument();
  });

  it('legt eine weitere Person mit Rolle und Standort an - inline, kein Fenster (P2)', async () => {
    listSites.mockResolvedValue([{ id: 's-1', name: 'Zuhause' }]);
    openDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Person hinzufügen' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.change(screen.getByLabelText('E-Mail'), { target: { value: 'sabine@example.com' } });
    createPerson.mockResolvedValue({
      benutzer: { sub: 'u-2', anzeigename: 'sabine', email: 'sabine@example.com', zustand: 'angelegt' },
      startpasswort: 'frisches-geheimnis',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Person anlegen' }));
    await waitFor(() => expect(createPerson).toHaveBeenCalledWith('t-1', expect.objectContaining({
      username: 'sabine',
      email: 'sabine@example.com',
      rolle: 'leser',
      standorte: ['s-1'],
    })));
    expect(await screen.findByLabelText('Startpasswort')).toHaveTextContent('frisches-geheimnis');
  });

  it('vergibt über das Zeilenmenü ein neues Startpasswort (N6: jetzt auch der Admin)', async () => {
    openDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Aktionen für anna' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Neues Startpasswort' }));
    const dlg = await screen.findByRole('dialog', { name: /Neues Startpasswort: anna/ });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Startpasswort vergeben' }));
    await waitFor(() => expect(resetPassword).toHaveBeenCalledWith('t-1', 'u-1'));
    expect(await screen.findByLabelText('Startpasswort')).toHaveTextContent('neues-geheim-456');
  });

  it('öffnet den ersten Kundenadministrator INLINE in der Personen-Karte, ohne Benutzer', async () => {
    listUsers.mockResolvedValue([]);
    openDetail();
    const knopf = await screen.findByRole('button', { name: 'Ersten Kundenadministrator anlegen' });
    fireEvent.click(knopf);
    // Inline, kein Fenster (E1 = A).
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.change(screen.getByLabelText('E-Mail *'), { target: { value: 'kunde@example.com' } });
    // Admin-Durchgang F8: der Anmeldename folgt der E-Mail wie bei „Person hinzufügen" ...
    expect(screen.getByLabelText('Anmeldename *')).toHaveValue('kunde');
    // ... und bleibt, sobald jemand ihn selbst ändert.
    fireEvent.change(screen.getByLabelText('Anmeldename *'), { target: { value: 'kunde-01' } });
    fireEvent.change(screen.getByLabelText('E-Mail *'), { target: { value: 'kunde@example.com' } });
    expect(screen.getByLabelText('Anmeldename *')).toHaveValue('kunde-01');
    createUser.mockResolvedValue({ benutzer: { sub: 'u-2', anzeigename: 'kunde-01', email: 'kunde@example.com', zustand: 'angelegt' }, startpasswort: 'geheim123' });
    fireEvent.click(screen.getByRole('button', { name: 'Kundenadministrator anlegen' }));
    await waitFor(() => expect(createUser).toHaveBeenCalledWith('t-1', { username: 'kunde-01', email: 'kunde@example.com', firstName: undefined, lastName: undefined }));
    expect(await screen.findByLabelText('Startpasswort')).toHaveTextContent('geheim123');
  });

  it('öffnet den Kunden als Seite mit Adresse im Raum Benutzer, nicht als Dialog, und führt zurück zur Liste', async () => {
    openDetail();
    expect(await screen.findByRole('region', { name: TENANT.name })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(window.location.hash).toBe('#/plattform/benutzer/t-1');
    expect(screen.queryByRole('button', { name: `Details zu ${TENANT.name}` })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Alle Kunden' }));
    expect(screen.getByRole('button', { name: `Details zu ${TENANT.name}` })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/plattform/benutzer');
  });

  it('bearbeitet einen Benutzer, ohne den Anmeldenamen anzufassen', async () => {
    openDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Aktionen für anna' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Bearbeiten' }));

    const edit = await screen.findByRole('dialog', { name: /Benutzer bearbeiten: anna/ });
    // P3: der Anmeldename ist jetzt änderbar - ohne Änderung bleibt er unverändert (kein Folgen-Satz).
    expect(within(edit).getByLabelText('Anmeldename')).not.toBeDisabled();
    expect(within(edit).queryByText(/gilt ab dem Speichern nicht mehr/)).toBeNull();
    fireEvent.change(within(edit).getByLabelText('E-Mail'), {
      target: { value: 'neu@example.com' },
    });
    fireEvent.click(within(edit).getByRole('button', { name: 'Änderungen speichern' }));
    await waitFor(() =>
      expect(updateUser).toHaveBeenCalledWith('t-1', 'u-1', {
        username: null,
        email: 'neu@example.com',
        firstName: 'Anna',
        lastName: 'Berg',
      }),
    );
  });

  it('ändert den Anmeldenamen und zeigt den Folgen-Satz (P3)', async () => {
    openDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Aktionen für anna' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Bearbeiten' }));

    const edit = await screen.findByRole('dialog', { name: /Benutzer bearbeiten: anna/ });
    fireEvent.change(within(edit).getByLabelText('Anmeldename'), { target: { value: 'anna.berg' } });
    expect(within(edit).getByText(/gilt ab dem Speichern nicht mehr/)).toBeInTheDocument();
    fireEvent.click(within(edit).getByRole('button', { name: 'Änderungen speichern' }));
    await waitFor(() =>
      expect(updateUser).toHaveBeenCalledWith('t-1', 'u-1', {
        username: 'anna.berg',
        email: 'anna@example.com',
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
    expect(dlg.textContent).toContain('Anlagen und Daten des Kunden bleiben unberührt');

    fireEvent.click(within(dlg).getByRole('button', { name: 'Benutzer löschen' }));
    await waitFor(() => expect(deleteUser).toHaveBeenCalledWith('t-1', 'u-1'));
  });

  it('zeigt bei einer 409 mit Code den echten Grund des Servers statt „eigenes Konto"', async () => {
    const { ApiError } = await import('../../api');
    deleteUser.mockRejectedValueOnce(new ApiError(409,
      'Der Vertrag dieses Kunden ist am 11.11.2026 beendet. Seine Daten lassen sich nur noch lesen; gelöscht werden sie frühestens am 12.11.2026.',
      { code: 'kundenbereich_beendet', message: 'Der Vertrag dieses Kunden ist am 11.11.2026 beendet. Seine Daten lassen sich nur noch lesen; gelöscht werden sie frühestens am 12.11.2026.' }));
    openDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Aktionen für anna' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Löschen' }));
    const dlg = await screen.findByRole('dialog', { name: /Benutzer löschen/ });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Benutzer löschen' }));
    expect(await screen.findByText(/Der Vertrag dieses Kunden ist am 11.11.2026 beendet/)).toBeInTheDocument();
    expect(screen.queryByText('Sie können Ihr eigenes Konto nicht löschen.')).not.toBeInTheDocument();
  });

  it('behält den Selbst-Sperre-Satz für die code-lose 409 (eigenes Konto)', async () => {
    const { ApiError } = await import('../../api');
    deleteUser.mockRejectedValueOnce(new ApiError(409, 'Der Server ist zurzeit nicht erreichbar. Bitte versuchen Sie es erneut.'));
    openDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Aktionen für anna' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Löschen' }));
    const dlg = await screen.findByRole('dialog', { name: /Benutzer löschen/ });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Benutzer löschen' }));
    expect(await screen.findByText('Sie können Ihr eigenes Konto nicht löschen.')).toBeInTheDocument();
  });

  it('bei einem beendeten Kunden sagt die Personen-Karte es vorher: kein Lösch-Knopf, nur Deaktivieren', async () => {
    selbstauskunft.mockResolvedValue({
      kundenbereich: {
        id: 't-1',
        name: TENANT.name,
        beendet: { beendet_am: '2026-11-11', liest: true, text: '' },
      },
    });
    openDetail();
    const akte = await screen.findByRole('region', { name: TENANT.name });
    expect(await within(akte).findByText(/Personen werden hier nicht mehr einzeln gelöscht/)).toBeInTheDocument();
    fireEvent.click(within(akte).getByRole('button', { name: 'Aktionen für anna' }));
    expect(screen.getByRole('menuitem', { name: 'Deaktivieren' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Löschen' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Bearbeiten' })).not.toBeInTheDocument();
    expect(within(akte).queryByRole('button', { name: 'Person hinzufügen' })).not.toBeInTheDocument();
  });

  it('ohne Datenbestand: Badge, Vertrag-Karte und Dialog mit Namens-Abschrift löschen sofort', async () => {
    selbstauskunft.mockResolvedValue({
      kundenbereich: {
        id: 't-1',
        name: TENANT.name,
        beendet: { beendet_am: '2026-11-11', liest: true, text: '' },
      },
    });
    kundeLoeschbarkeit.mockResolvedValue({
      tenantId: 't-1', daten: [], beendetAm: '2026-11-11',
      folgen: { anlagen: 1, boxen: ['edge-cyhchfr'], personen: 1 },
    });
    const report = {
      tenantId: 't-1', tenantName: TENANT.name, deletedSites: 1, deletedDevices: 1,
      deletedTelemetryRows: 0, deletedUsers: ['anna'], failedUsers: [],
      anlass: 'sofort_keine_daten', freigegebeneBoxen: ['edge-cyhchfr'], loeschnachweis: null,
    };
    deleteTenant.mockResolvedValue(fertigerLauf(report));
    const onReloadTenants = vi.fn();
    render(<MandantenPage tenants={[TENANT]} onReloadTenants={onReloadTenants} onJumpToTenant={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: `Details zu ${TENANT.name}` }));
    const akte = await screen.findByRole('region', { name: TENANT.name });
    expect(await within(akte).findByText('beendet')).toBeInTheDocument();

    fireEvent.click(within(akte).getAllByRole('button', { name: 'Kunde endgültig löschen …' })[0]);
    const dlg = await screen.findByRole('dialog', { name: 'Kunde endgültig löschen' });
    expect(dlg.textContent).toContain('keinen Datenbestand');
    expect(dlg.textContent).toContain('edge-cyhchfr');
    // Ohne Abschrift löscht nichts.
    fireEvent.click(within(dlg).getByRole('button', { name: 'Kunde endgültig löschen' }));
    expect(deleteTenant).not.toHaveBeenCalled();
    fireEvent.change(within(dlg).getByLabelText('Zum Bestätigen den Kundennamen abtippen'), {
      target: { value: TENANT.name },
    });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Kunde endgültig löschen' }));
    await waitFor(() => expect(deleteTenant).toHaveBeenCalledWith('t-1', TENANT.name));
    expect(await screen.findByText(/wurde vollständig entfernt/)).toBeInTheDocument();
    expect(screen.getByText('edge-cyhchfr - wieder anmeldbar')).toBeInTheDocument();
    // Admin-Durchgang F14: die Liste der Schale lädt sofort nach, ohne den Kunden zu wählen -
    // nicht erst bei „Zu den Kunden" (sonst blieb er in Umschalter und Zähler).
    expect(onReloadTenants).toHaveBeenCalledWith();
  });

  it('Admin-Durchgang F14: der Löschbericht bleibt stehen, auch wenn die nachgeladene Liste den Kunden nicht mehr kennt', async () => {
    const report = {
      tenantId: 't-1', tenantName: TENANT.name, deletedSites: 0, deletedDevices: 0,
      deletedTelemetryRows: 0, deletedUsers: ['anna'], failedUsers: [],
      anlass: 'sofort_mit_daten', freigegebeneBoxen: [], loeschnachweis: null,
    };
    deleteTenant.mockResolvedValue(fertigerLauf(report));
    const { rerender } = render(<MandantenPage tenants={[TENANT]} onReloadTenants={vi.fn()} onJumpToTenant={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: `Details zu ${TENANT.name}` }));
    const akte = await screen.findByRole('region', { name: TENANT.name });
    fireEvent.click(within(akte).getAllByRole('button', { name: 'Kunde endgültig löschen …' })[0]);
    const dlg = await screen.findByRole('dialog', { name: 'Kunde endgültig löschen' });
    fireEvent.change(within(dlg).getByLabelText('Zum Bestätigen den Kundennamen abtippen'), { target: { value: TENANT.name } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Kunde endgültig löschen' }));
    expect(await screen.findByText(/wurde vollständig entfernt/)).toBeInTheDocument();
    rerender(<MandantenPage tenants={[]} onReloadTenants={vi.fn()} onJumpToTenant={vi.fn()} />);
    expect(screen.getByText(/wurde vollständig entfernt/)).toBeInTheDocument();
    expect(screen.queryByText('Kunde nicht gefunden')).toBeNull();
  });

  it('Admin-Durchgang F13: die Akte zeigt eine laufende Unterstützung mit ihrem letzten Tag', async () => {
    fleet.mockResolvedValue({ sites: [], unterstuetzungBis: { 't-1': '2026-12-13T23:00:00Z' }, unterstuetzungStandorte: [], releases: [] });
    openDetail();
    const akte = await screen.findByRole('region', { name: TENANT.name });
    expect(await within(akte).findByText('Unterstützung bis 13.12.2026')).toBeInTheDocument();
  });

  it('Admin-Durchgang F6: ein Eintrag ohne Anmeldekonto steht nicht als „aktiv" in der Spalte Konto', async () => {
    benutzerListe.mockResolvedValue([{ sub: 'nur-eintrag', anzeigename: 'Robert Falk', email: 'robert@example.com', zustand: 'aktiv', zuweisungen: [] }]);
    openDetail();
    const zeile = (await screen.findByText('Robert Falk')).closest('tr')!;
    expect(within(zeile).getByText('ohne Konto')).toBeInTheDocument();
    expect(within(zeile).queryByText('aktiv')).toBeNull();
  });

  it('Admin-Durchgang F9: ohne Anlage sagt „Person hinzufügen" bei einer Standort-Rolle, warum es nicht geht', async () => {
    openDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Person hinzufügen' }));
    fireEvent.change(screen.getByLabelText('E-Mail'), { target: { value: 'lena@example.com' } });
    // Vorgabe „Leser" gilt je Standort - der Kunde hat keine Anlage (listSites: []).
    expect(screen.getByRole('note')).toHaveTextContent('Diese Rolle gilt je Standort, und der Kunde hat noch keine Anlage.');
    expect(screen.getByRole('button', { name: 'Person anlegen' })).toBeDisabled();
    expect(createPerson).not.toHaveBeenCalled();
  });

  it('mit Daten sagt der Dialog ehrlich, was verloren geht - und löscht trotzdem sofort', async () => {
    kundeLoeschbarkeit.mockResolvedValue({
      tenantId: 't-1', daten: ['herzschlag', 'messwerte'], beendetAm: '2026-11-11',
      folgen: { anlagen: 1, boxen: [], personen: 1 },
    });
    const report = {
      tenantId: 't-1', tenantName: TENANT.name, deletedSites: 1, deletedDevices: 0,
      deletedTelemetryRows: 12, deletedUsers: ['anna'], failedUsers: [],
      anlass: 'sofort_mit_daten', freigegebeneBoxen: [], loeschnachweis: null,
    };
    deleteTenant.mockResolvedValue(fertigerLauf(report));
    openDetail();
    const akte = await screen.findByRole('region', { name: TENANT.name });
    fireEvent.click(await within(akte).findByRole('button', { name: `Weitere Aktionen für ${TENANT.name}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Kunde endgültig löschen …' }));
    const dlg = await screen.findByRole('dialog', { name: 'Kunde endgültig löschen' });
    expect(dlg.textContent).toContain('Box-Herzschläge · Messwerte');
    expect(dlg.textContent).toContain('verloren');
    expect(dlg.textContent).toContain('Gesamtabzug');
    fireEvent.change(within(dlg).getByLabelText('Zum Bestätigen den Kundennamen abtippen'), {
      target: { value: TENANT.name },
    });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Kunde endgültig löschen' }));
    await waitFor(() => expect(deleteTenant).toHaveBeenCalledWith('t-1', TENANT.name));
    expect(await screen.findByText(/wurde vollständig entfernt/)).toBeInTheDocument();
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

  /**
   * Scheibe S5 (E3 = A, bereits in S1 umgesetzt): der Mandanten-Umschalter
   * weicht der Suche, und „Wie der Kunde es sieht" ersetzt „In
   * Mandanten-Ansicht springen" - die wortgleiche Formulierung des
   * Rückweg-Bands (`AppShell.tsx`). Der frühere F7-Wächter („keine
   * Umbenennung") galt der ALTEN Konzeptlage vor diesem Umbau und ist damit
   * überholt.
   */
  it('nennt den Sprung in die Kundenansicht „Wie der Kunde es sieht" (E3/E4, wortgleich zum Rückweg-Band)', async () => {
    const onJumpToTenant = vi.fn();
    render(<MandantenPage tenants={[TENANT]} onReloadTenants={vi.fn()} onJumpToTenant={onJumpToTenant} />);
    fireEvent.click(screen.getByRole('button', { name: `Details zu ${TENANT.name}` }));
    const akte = await screen.findByRole('region', { name: TENANT.name });
    const knopf = within(akte).getByRole('button', { name: 'Wie der Kunde es sieht' });
    expect(knopf).toBeEnabled();
    fireEvent.click(knopf);
    expect(onJumpToTenant).toHaveBeenCalledWith('t-1', 'uebersicht');
  });

  it('N1: beendet den Vertrag mit Frist - die Gefahrenzone bleibt immer offen (vp-kunde-sofort-loeschen-mit-daten)', async () => {
    openDetail();
    const akte = await screen.findByRole('region', { name: TENANT.name });
    // Löschen ist von Anfang an möglich, auch ohne Vertragsende - über EINEN Weg mit EINEM Namen
    // (Admin-Durchgang F5: daneben stand „Mandant löschen (Offboarding)", derselbe Server-Weg).
    expect(within(akte).getByRole('button', { name: 'Kunde endgültig löschen …' })).toBeInTheDocument();
    expect(within(akte).queryByRole('button', { name: /Offboarding/ })).toBeNull();
    expect(within(akte).getByRole('button', { name: 'Anlage anlegen' })).toBeInTheDocument();

    fireEvent.click(within(akte).getByRole('button', { name: 'Vertrag beenden …' }));
    const dlg = await screen.findByRole('dialog', { name: /Vertrag beenden/ });
    // Admin-Durchgang F11: kein „gelöscht frühestens nach der Frist" mehr - die Frist steuert nichts.
    expect(dlg.textContent).not.toContain('frühestens');
    expect(dlg.textContent).toContain('Die Frist aus dem Vertrag wird nur vermerkt');
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
        beendet: { beendet_am: '2029-01-01', liest: true, text: '' },
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
    expect(await within(akte).findByText(/am 01.01.2029 beendet/)).toBeInTheDocument();
    // Auch nach dem Beenden bleibt der Löschweg sofort erreichbar - keine Frist sperrt mehr.
    expect(within(akte).getByRole('button', { name: 'Kunde endgültig löschen …' })).toBeInTheDocument();
    // Admin-Durchgang F12: eine Anlage lehnt der Server jetzt ab (409) - der Knopf steht nicht mehr da.
    expect(within(akte).queryByRole('button', { name: 'Anlage anlegen' })).toBeNull();
    expect(within(akte).queryByText(/Frist/)).not.toBeInTheDocument();
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
    expect(screen.queryByText('Noch keine Kunden')).toBeNull();
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

describe('MandantenPage - die Kundenliste', () => {
  beforeEach(() => {
    listUsers.mockResolvedValue([USER]);
    selbstauskunft.mockResolvedValue({ kundenbereich: { id: 't-1', name: TENANT.name, beendet: null } });
  });

  it('zählt Personen, Anlagen und Boxen je Kunde, sobald die Listen geladen sind', async () => {
    fleet.mockResolvedValue({
      sites: [{ siteId: 's-1', siteName: 'Werk West', tenantId: 't-1', tenantName: TENANT.name, deviceCount: 3, worstStatus: 'online', boxes: [] }],
      unterstuetzungBis: {},
      unterstuetzungStandorte: [],
      releases: [],
    });
    render(<MandantenPage tenants={[TENANT]} onReloadTenants={vi.fn()} onJumpToTenant={vi.fn()} />);
    const zeile = (await screen.findByText(TENANT.name)).closest('tr')!;
    await waitFor(() => expect(zeile.querySelector('td[data-label="Personen"]')).toHaveTextContent('1'));
    expect(zeile.querySelector('td[data-label="Anlagen"]')).toHaveTextContent('1');
    expect(zeile.querySelector('td[data-label="Boxen"]')).toHaveTextContent('3');
    expect(zeile.querySelector('td[data-label="Zustand"]')).toHaveTextContent('aktiv');
  });

  it('fügt „Neuer Kunde" als Eingabezeile ein, ohne ein Fenster zu öffnen', async () => {
    render(<MandantenPage tenants={[TENANT]} onReloadTenants={vi.fn()} onJumpToTenant={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Neuer Kunde' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByLabelText('Name des neuen Kunden')).toBeInTheDocument();
  });

  /**
   * Doppelter Kunde (Befund vp-kundenakte-fremde-personen, Punkt 5): die Live-Liste zeigte
   * „Wüstholz Karl-Friedrich" ZWEIMAL. Drei Schutzwände: eine Anfrage-Kennung je Formular
   * (dieselbe bei jedem Versuch), ein Doppelklick-Riegel und die Warnung bei gleichem Namen.
   */
  it('sendet je Formular EINE Anfrage-Kennung - auch beim Wiederholen nach einem Fehler', async () => {
    createTenant.mockReset()
      .mockRejectedValueOnce(new Error('Netz weg'))
      .mockResolvedValue({ ...TENANT, id: 't-neu', name: 'Wüstholz Karl-Friedrich' });
    render(<MandantenPage tenants={[TENANT]} onReloadTenants={vi.fn()} onJumpToTenant={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Neuer Kunde' }));
    fireEvent.change(screen.getByLabelText('Name des neuen Kunden'), { target: { value: 'Wüstholz Karl-Friedrich' } });
    fireEvent.click(screen.getByRole('button', { name: 'Anlegen' }));
    await screen.findByText('Der Kunde konnte nicht angelegt werden. Bitte versuchen Sie es erneut.');
    fireEvent.click(screen.getByRole('button', { name: 'Anlegen' }));
    await waitFor(() => expect(createTenant).toHaveBeenCalledTimes(2));
    const [, kennung1] = createTenant.mock.calls[0];
    const [, kennung2] = createTenant.mock.calls[1];
    expect(kennung1).toMatch(/^portal-/);
    expect(kennung2).toBe(kennung1);
  });

  it('Admin-Durchgang F7: „Anlegen" öffnet die Akte des neuen Kunden und schaltet NICHT auf „Wie der Kunde es sieht"', async () => {
    const NEU = { ...TENANT, id: 't-neu', name: 'Durchgang Testkunde GmbH' };
    createTenant.mockReset().mockResolvedValue(NEU);
    listUsers.mockResolvedValue([]);
    listSites.mockResolvedValue([]);
    selbstauskunft.mockResolvedValue({ kundenbereich: { id: 't-neu', name: NEU.name, beendet: null } });
    const onReloadTenants = vi.fn();
    // Die Liste der Schale kennt den neuen Kunden erst nach dem Nachladen.
    render(<MandantenPage tenants={[TENANT]} onReloadTenants={onReloadTenants} onJumpToTenant={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Neuer Kunde' }));
    fireEvent.change(screen.getByLabelText('Name des neuen Kunden'), { target: { value: NEU.name } });
    fireEvent.click(screen.getByRole('button', { name: 'Anlegen' }));
    expect(await screen.findByRole('region', { name: NEU.name })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/plattform/benutzer/t-neu');
    expect(await screen.findByRole('button', { name: 'Ersten Kundenadministrator anlegen' })).toBeInTheDocument();
    // Eine Kennung hier wählte den Kunden in der Schale (Band „Wie der Kunde es sieht").
    expect(onReloadTenants).toHaveBeenCalledWith();
    expect(onReloadTenants).not.toHaveBeenCalledWith('t-neu');
  });

  it('legt bei einem Doppelklick nur einmal an', async () => {
    let fertig!: (t: typeof TENANT) => void;
    createTenant.mockReset().mockImplementation(() => new Promise((r) => { fertig = r; }));
    render(<MandantenPage tenants={[TENANT]} onReloadTenants={vi.fn()} onJumpToTenant={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Neuer Kunde' }));
    fireEvent.change(screen.getByLabelText('Name des neuen Kunden'), { target: { value: 'Wüstholz Karl-Friedrich' } });
    const anlegen = screen.getByRole('button', { name: 'Anlegen' });
    fireEvent.click(anlegen);
    fireEvent.click(anlegen);
    fertig({ ...TENANT, id: 't-neu' });
    await waitFor(() => expect(createTenant).toHaveBeenCalledTimes(1));
  });

  it('warnt bei gleichem Namen: Hinweis, „Trotzdem anlegen", Enter legt nicht an', async () => {
    createTenant.mockReset().mockResolvedValue({ ...TENANT, id: 't-neu' });
    render(<MandantenPage tenants={[TENANT]} onReloadTenants={vi.fn()} onJumpToTenant={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Neuer Kunde' }));
    const feld = screen.getByLabelText('Name des neuen Kunden');
    // Groß-/Kleinschreibung und Randleerzeichen zählen nicht als Unterschied.
    fireEvent.change(feld, { target: { value: '  nordwind gmbh ' } });
    expect(screen.getByText(/Einen Kunden mit diesem Namen gibt es schon/)).toBeInTheDocument();
    const trotzdem = screen.getByRole('button', { name: 'Trotzdem anlegen' });
    fireEvent.keyDown(feld, { key: 'Enter' });
    expect(createTenant).not.toHaveBeenCalled();
    fireEvent.click(trotzdem);
    await waitFor(() => expect(createTenant).toHaveBeenCalledTimes(1));
    expect(createTenant.mock.calls[0][0]).toEqual({ name: 'nordwind gmbh', segment: 'CI' });
  });

  it('findet eine Person über die bereits geladenen Konten (zunächst-Suche vor S6)', async () => {
    render(<MandantenPage tenants={[TENANT]} onReloadTenants={vi.fn()} onJumpToTenant={vi.fn()} />);
    await screen.findByText(TENANT.name);
    await waitFor(() => expect(listUsers).toHaveBeenCalledWith('t-1'));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Kunde oder Person suchen' }), { target: { value: 'anna@example.com' } });
    await waitFor(() => expect(screen.getByText(TENANT.name)).toBeInTheDocument());
    expect(screen.queryByText(/Kein Kunde und keine Person passt/)).toBeNull();
  });
});
