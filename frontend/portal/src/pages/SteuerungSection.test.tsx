/**
 * Die Steuerung mit drei Reitern (Konzept `docs/konzepte/steuerung`, E1–E9 = A).
 *
 * Geprüft wird, was der Kunde tut: sehen, was jetzt läuft und warum; ein neu
 * verbundenes Gerät übernehmen oder nur messen lassen; die Reihenfolge ändern;
 * am Gerät Aus · Smart · Ein wählen; Regeln schalten; laden. Jeder Schreibweg
 * ist der bestehende - die Tests sehen nach, dass er genau einmal mit dem
 * richtigen Rumpf gerufen wird.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SteuerungSection } from './SteuerungSection';
import { api, type Site } from '../api';
import * as flowsApi from '../flows/flowsApi';
import { buildGuidedFlow } from '../flows/guidedBuilder';
import type { SiteVerbraucher } from '../verbraucherZone';

const cList = vi.fn();
const cStatus = vi.fn();
const cOverrides = vi.fn();
const cStartOverride = vi.fn();
const cClearOverride = vi.fn();
const cPatch = vi.fn();
vi.mock('../consumers/consumersApi', () => ({
  consumersApi: {
    list: (...a: unknown[]) => cList(...a),
    status: (...a: unknown[]) => cStatus(...a),
    overrides: (...a: unknown[]) => cOverrides(...a),
    startOverride: (...a: unknown[]) => cStartOverride(...a),
    clearOverride: (...a: unknown[]) => cClearOverride(...a),
    patch: (...a: unknown[]) => cPatch(...a),
  },
}));

const site: Site = {
  id: 's-1', name: 'Sonnenhof', biddingZone: 'DE-LU', latitude: null, longitude: null,
  plantKind: 'eigenverbrauch', anzulegenderWertCtKwh: null, tarifArt: 'dynamisch', tarifParamCtKwh: null,
  netzladenErlaubt: false, maxFeedInKw: null,
};

const optionen = (quellen: string[]) => ({
  schreibbar: true,
  quellen: quellen.map((id) => ({ id, gesperrt: false })),
  ziele: [{ id: 'laufzeit_bis', gesperrt: false }],
  vorgaben: { schwelleKw: 2, preisgrenzeCtKwh: 10 },
});

const VERBRAUCHER: SiteVerbraucher = {
  verbraucher: [
    { entityId: 'e-hs', name: 'Heizstab Warmwasser', typ: 'heating-rod', typLabel: 'Heizstab', ladepunkt: false, regeln: 0,
      steuerart: { quelle: 'ueberschuss', herkunft: 'policy', schwelleKw: 1 }, optionen: optionen(['ueberschuss', 'guenstig', 'sofort']) },
    { entityId: 'e-pool', name: 'Poolpumpe', typ: 'pump', typLabel: 'Pumpe', ladepunkt: false, regeln: 0,
      steuerart: { quelle: 'ueberschuss', herkunft: 'policy', schwelleKw: 0.75 }, optionen: optionen(['ueberschuss', 'guenstig']) },
    { entityId: 'e-ir', name: 'Infrarotheizung', typ: 'modbus-load', typLabel: 'Eigenes Schaltgerät', ladepunkt: false, regeln: 0,
      steuerart: { quelle: 'feste_zeiten', herkunft: 'policy', fenster: { tage: 'weekdays', von: '06:30', bis: '08:30' } }, optionen: optionen(['feste_zeiten']) },
    { entityId: 'e-spuel', name: 'Spülmaschine', typ: 'generic-load', typLabel: 'Steuerbare Last', ladepunkt: false, regeln: 0,
      steuerart: { quelle: 'eigene_regel', herkunft: 'ohne' }, optionen: optionen(['ueberschuss', 'guenstig']) },
    { entityId: 'e-lueft', name: 'Lüftung', typ: 'modbus-load', typLabel: 'Eigenes Schaltgerät', ladepunkt: false, regeln: 0,
      steuerart: { quelle: 'eigene_regel', herkunft: 'ohne' },
      optionen: { schreibbar: false, nichtSchreibbarGrund: 'Misst nur. Schalten ist noch nicht freigegeben.', quellen: [], ziele: [], vorgaben: {} } },
    { entityId: 'e-wb', name: 'Wallbox Werkstatt', typ: 'ev-charger', typLabel: 'Ladepunkt', ladepunkt: true, chargePointId: 'CP-1', regeln: 0,
      steuerart: { quelle: 'ueberschuss', herkunft: 'saeule', ueberschussModus: 'pausieren' },
      optionen: { schreibbar: true, quellen: [{ id: 'ueberschuss', gesperrt: false }, { id: 'guenstig', gesperrt: false }], ziele: [{ id: 'bis_uhrzeit', gesperrt: false }], vorgaben: { preisgrenzeCtKwh: 9 } } },
  ],
  ladepunkte: { standard: null, standardFolger: 0, gesamt: 1, rahmen: { netzanschlussKw: 22, effektivGrenzeKw: 22, hausLastKw: 1, sicherheitsabstandPct: 10, mindestleistungKw: 1.4 } },
  rangliste: [
    { position: 1, art: 'speicher', entityId: null, name: 'Speicher Scheune' },
    { position: 2, art: 'ladepunkt', entityId: 'e-wb', name: 'Wallbox Werkstatt' },
    { position: 3, art: 'verbraucher', entityId: 'e-hs', name: 'Heizstab Warmwasser' },
    { position: 4, art: 'verbraucher', entityId: 'e-pool', name: 'Poolpumpe' },
    { position: 5, art: 'verbraucher', entityId: 'e-ir', name: 'Infrarotheizung' },
  ],
};

const REGEL = buildGuidedFlow({ conditions: [{ kind: 'price', direction: 'below', threshold: 0 }], combinator: 'and',
  action: { kind: 'onoff', entityId: 'e-hs', ttlS: 300 } }, 'Negativpreise mitnehmen', 's-1');

const BOUND = {
  list: vi.fn(), entities: vi.fn(), activate: vi.fn(), deactivate: vi.fn(), create: vi.fn(), save: vi.fn(), remove: vi.fn(),
};

const JETZT = new Date();

beforeEach(() => {
  vi.spyOn(flowsApi, 'customerFlowApi').mockReturnValue(BOUND as unknown as ReturnType<typeof flowsApi.customerFlowApi>);
  BOUND.list.mockResolvedValue([
    { flowId: 'f-1', name: 'Negativpreise mitnehmen', runtime: 'edge', latestVersion: 1, latestLifecycle: 'active', activeVersion: 1, updatedAt: '', simulation: null, latestDocument: REGEL, versions: [1] },
  ]);
  BOUND.entities.mockResolvedValue([
    { id: 'grid', entityType: 'grid-meter', label: 'Netz', measure: ['power_kw'], actuate: [] },
    { id: 'e-hs', entityType: 'heating-rod', label: 'Heizstab Warmwasser', measure: ['power_kw'], actuate: ['on_off'] },
    { id: 'e-pool', entityType: 'pump', label: 'Poolpumpe', measure: ['power_kw'], actuate: ['on_off'] },
  ]);
  BOUND.deactivate.mockResolvedValue({ deactivated: true, published: true, message: 'aus', lifecycle: 'retired' });
  BOUND.activate.mockResolvedValue({ activated: true, published: true, message: 'aktiv', lifecycle: 'active' });
  BOUND.create.mockResolvedValue({ flowId: 'f-2', flowVersion: 1, name: 'x', runtime: 'edge', lifecycle: 'draft', document: REGEL, simulation: null, createdAt: '', updatedAt: '', simulatedAt: null, activatedAt: null, siteId: 's-1' });
  vi.spyOn(api, 'siteVerbraucher').mockResolvedValue(VERBRAUCHER);
  vi.spyOn(api, 'siteChargers').mockResolvedValue({ budget: null, chargers: [
    { deviceId: 'd', chargePointId: 'CP-1', entityId: 'e-wb', label: 'Wallbox Werkstatt', priority: true, connected: true, ready: true,
      connectors: [{ connectorId: 1, status: 'Charging', charging: true, powerKw: 3.2, meteredAt: JETZT.toISOString(), sessionSince: JETZT.toISOString(), sessionKwh: 4.6 }] },
  ] });
  vi.spyOn(api, 'siteInterventions').mockResolvedValue({ automationPaused: false, pausedUntil: null, interventions: [] });
  vi.spyOn(api, 'telemetry').mockResolvedValue([{ ts: JETZT.toISOString(), powerKw: -0.4, socPct: 100, pvPowerKw: 8, loadKw: 5, gridLimitKw: null }]);
  vi.spyOn(api, 'schedule').mockResolvedValue({ planId: null, deviceId: null, generatedAt: null, slotMinutes: 15, savingsEur: null, bankedValueEur: null, socStartPct: null, socEndPct: null, peakTargetKw: null, fallback14a: null, slots: [] });
  vi.spyOn(api, 'consumerSchedule').mockResolvedValue({ planId: null, generatedAt: null, slotMinutes: 15, entities: [] });
  vi.spyOn(api, 'history').mockRejectedValue(new Error('nicht da'));
  vi.spyOn(api, 'prices').mockResolvedValue({ biddingZone: 'DE-LU', currency: 'EUR', resolution: 'PT15M', points: [] });
  vi.spyOn(api, 'weather').mockResolvedValue({ runAt: null, points: [] });
  vi.spyOn(api, 'siteAssets').mockResolvedValue([{ id: 'b', type: 'battery', deviceId: 'd', capacityKwh: 10, maxChargeKw: 5, maxDischargeKw: 5, roundtripEfficiencyPct: 92, speicherschonung: null, pvCapacityKwp: null } as never]);
  vi.spyOn(api, 'siteProfiles').mockResolvedValue({ profiles: [] });
  vi.spyOn(api, 'siteFahrzeuge').mockResolvedValue({ fahrzeuge: [] });
  vi.spyOn(api, 'chargingConfig').mockResolvedValue({ gridLimitKw: 22, priorityChargePointIds: [], storagePriority: 'speicher_vor_auto' });
  vi.spyOn(api, 'siteRuleEvents').mockResolvedValue({ recordingSince: null, countsToday: true, accuracySeconds: 15, rules: [], events: [] });
  vi.spyOn(api, 'siteEntities').mockResolvedValue({ registry: null, entities: [], localSetup: [], staleOnDevice: [] });
  vi.spyOn(api, 'suggestionStates').mockResolvedValue({ states: [] });
  vi.spyOn(api, 'scene').mockResolvedValue({ scene: null, offen: [], message: null });
  vi.spyOn(api, 'entityHistory').mockRejectedValue(new Error('nicht da'));
  cList.mockResolvedValue([
    { id: 'e-hs', type: 'heating-rod', typeLabel: 'Heizstab', name: 'Heizstab Warmwasser', controlKind: 'on_off', ratedPowerKw: 3, minPowerKw: null, levelsKw: null, resolutionKw: null, powerRangesKw: null, storageRelation: 'storage_first', defaultGridEnergyPolicy: 'avoid', allowStorageDischarge: false, failsafe: 'off', enabled: true, version: 4, connection: 'connected', edgeSourceId: 's', controlActivation: 'active', hasDraftPolicy: false, draftPolicyVersion: null, confirmationChannel: 'power_kw' },
  ]);
  cStatus.mockResolvedValue([
    { entityId: 'e-hs', state: 'running_optimized', reasonCode: 'consumer_first', actualKw: 3, confirmed: true, reportedAt: JETZT.toISOString() },
    { entityId: 'e-pool', state: 'waiting', reasonCode: 'storage_first', reportedAt: JETZT.toISOString() },
  ]);
  cOverrides.mockResolvedValue([]);
  cStartOverride.mockResolvedValue({ applied: true, pushed: true, kind: 'start', endsAt: null, effectivePowerKw: 3, gridImportPossible: true, ttlCapped: false, message: 'ok' });
  cClearOverride.mockResolvedValue({ applied: true, pushed: true, kind: 'clear', endsAt: null, effectivePowerKw: null, gridImportPossible: false, ttlCapped: false, message: 'ok' });
  window.location.hash = '#/anlage/s-1/steuerung';
});

afterEach(() => {
  vi.restoreAllMocks();
});

const TABS = [
  { key: 'steuerung', label: 'Geräte', sub: 'steuerung' as const },
  { key: 'laden', label: 'Laden', sub: 'laden' as const },
  { key: 'regeln', label: 'Regeln', sub: 'regeln' as const },
];

function zeige(reiter: 'steuerung' | 'laden' | 'regeln' = 'steuerung', onOpenSub = vi.fn()) {
  render(<SteuerungSection site={site} reiter={reiter} tabs={TABS} onOpenSub={onOpenSub} />);
  return onOpenSub;
}

describe('Steuerung · Kopf und Reiter', () => {
  it('trägt „Steuerung", den Automatik-Knopf und die Reiter mit Zahl', async () => {
    const open = zeige();
    expect(screen.getByRole('heading', { level: 1, name: 'Steuerung' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Automatik an/ })).toBeInTheDocument();
    const reiter = screen.getByRole('tablist', { name: 'Reiter der Steuerung' });
    expect(within(reiter).getAllByRole('tab').map((t) => t.textContent?.replace(/\d/g, ''))).toEqual(['Geräte', 'Laden', 'Regeln']);
    expect(within(reiter).getByRole('tab', { name: /Geräte/ })).toHaveAttribute('aria-selected', 'true');
    // Zwei Geräte laufen: Heizstab und Wallbox.
    await waitFor(() => expect(within(reiter).getByRole('tab', { name: /Geräte/ })).toHaveTextContent('2'));
    fireEvent.click(within(reiter).getByRole('tab', { name: /Regeln/ }));
    expect(open).toHaveBeenCalledWith('regeln');
  });

  it('pausiert die Automatik erst nach der Wahl einer Dauer', async () => {
    const pause = vi.spyOn(api, 'pauseAutomation').mockResolvedValue({ applied: true, pushed: true, kind: 'pause', endsAt: null, effectivePowerKw: null, ttlRenewed: false, message: '' });
    zeige();
    fireEvent.click(screen.getByRole('button', { name: /Automatik an/ }));
    const blatt = await screen.findByRole('dialog', { name: /Automatik pausieren/ });
    expect(pause).not.toHaveBeenCalled();
    fireEvent.click(within(blatt).getByRole('button', { name: '1 Std' }));
    await waitFor(() => expect(pause).toHaveBeenCalledWith('s-1', { durationMinutes: 60 }));
  });
});

describe('Steuerung · Reiter Geräte', () => {
  it('sagt jetzt, wohin die Sonne geht, und wer wartet', async () => {
    zeige();
    const jetzt = await screen.findByRole('region', { name: 'Jetzt' });
    await waitFor(() => expect(jetzt).toHaveTextContent('Sonne 8,0 kW'));
    expect(jetzt).toHaveTextContent('Wohin geht der Sonnenstrom?');
    expect(jetzt).toHaveTextContent(/Poolpumpe wartet \(Platz 4\): braucht 0,8 kW/);
  });

  it('listet die Geräte als Reihenfolge und den Rest darunter', async () => {
    zeige();
    const liste = await screen.findByRole('region', { name: 'Geräte und Reihenfolge' });
    await waitFor(() => expect(within(liste).getByText('Heizstab Warmwasser')).toBeInTheDocument());
    const namen = within(liste).getAllByRole('button').map((b) => b.querySelector('.d-name b')?.textContent).filter(Boolean);
    expect(namen).toEqual(['Speicher Scheune', 'Wallbox Werkstatt', 'Heizstab Warmwasser', 'Poolpumpe', 'Infrarotheizung']);
    expect(within(liste).getByText('nach Zeit, Frist oder Preis')).toBeInTheDocument();
    // In der Anlage, aber nicht steuerbar: mit Grund, nie als Knopf ohne Wirkung.
    expect(within(liste).getByText('Misst nur. Schalten ist noch nicht freigegeben.')).toBeInTheDocument();
  });

  it('fragt bei einem neu verbundenen Gerät und übernimmt den Vorschlag', async () => {
    const setze = vi.spyOn(api, 'setzeSteuerart').mockResolvedValue({ steuerart: { quelle: 'ueberschuss', herkunft: 'policy' }, aktiv: true });
    zeige();
    const karte = await screen.findByRole('region', { name: 'Neu in Ihrer Anlage: Spülmaschine' });
    expect(karte).toHaveTextContent('Mit Sonnenstrom ab 2,0 kW');
    fireEvent.click(within(karte).getByRole('button', { name: /Übernehmen/ }));
    await waitFor(() => expect(setze).toHaveBeenCalledWith('s-1', 'e-spuel', { quelle: 'ueberschuss', schwelleKw: 2 }));
  });

  it('merkt sich „nur messen" dauerhaft, ohne Frist', async () => {
    const merke = vi.spyOn(api, 'setSuggestionState').mockResolvedValue({ key: 'k', state: 'nur_messen', mutedUntil: null, updatedAt: '' });
    zeige();
    const karte = await screen.findByRole('region', { name: 'Neu in Ihrer Anlage: Spülmaschine' });
    fireEvent.click(within(karte).getByRole('button', { name: 'Nicht steuern, nur messen' }));
    await waitFor(() => expect(merke).toHaveBeenCalledWith('s-1', 'steuerung-nur-messen:e-spuel', 'nur_messen'));
  });

  it('speichert eine geänderte Reihenfolge flach und übernimmt die Antwort', async () => {
    const speichern = vi.spyOn(api, 'saveRangliste').mockResolvedValue(VERBRAUCHER);
    zeige();
    fireEvent.click(await screen.findByRole('button', { name: /Ändern/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Poolpumpe nach oben' }));
    expect(screen.getByText(/Poolpumpe Platz 3 statt 4/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reihenfolge speichern' }));
    await waitFor(() => expect(speichern).toHaveBeenCalledTimes(1));
    expect(speichern.mock.calls[0][1]).toEqual([
      { art: 'speicher' },
      { art: 'ladepunkt', entityId: 'e-wb' },
      { art: 'verbraucher', entityId: 'e-pool' },
      { art: 'verbraucher', entityId: 'e-hs' },
      { art: 'verbraucher', entityId: 'e-ir' },
    ]);
  });

  it('am Gerät: Ein mit Dauer und Folgen, dann zurück zum Auslöser', async () => {
    zeige();
    const knopf = await screen.findByRole('button', { name: /Heizstab Warmwasser/ });
    knopf.focus();
    fireEvent.click(knopf);
    const blatt = await screen.findByRole('dialog', { name: /Heizstab Warmwasser/ });
    fireEvent.click(within(blatt).getByRole('button', { name: 'Ein' }));
    expect(within(blatt).getByText(/Das passiert:/)).toBeInTheDocument();
    expect(cStartOverride).not.toHaveBeenCalled();
    fireEvent.click(within(blatt).getByRole('button', { name: '2 Std' }));
    fireEvent.click(within(blatt).getByRole('button', { name: /^Ein bis/ }));
    await waitFor(() => expect(cStartOverride).toHaveBeenCalledWith('s-1', 'e-hs', { action: 'start', durationMinutes: 120 }));
    fireEvent.keyDown(blatt, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(knopf));
  });

  it('ändert den Smart-Auftrag erst mit „Übernehmen"', async () => {
    const setze = vi.spyOn(api, 'setzeSteuerart').mockResolvedValue({ steuerart: { quelle: 'guenstig', herkunft: 'policy' }, aktiv: true });
    zeige();
    fireEvent.click(await screen.findByRole('button', { name: /Heizstab Warmwasser/ }));
    const blatt = await screen.findByRole('dialog', { name: /Heizstab Warmwasser/ });
    fireEvent.click(within(blatt).getByRole('button', { name: /Günstige Stunden/ }));
    expect(setze).not.toHaveBeenCalled();
    expect(within(blatt).getByText(/Folgen ab jetzt:/)).toBeInTheDocument();
    fireEvent.click(within(blatt).getByRole('button', { name: /Übernehmen/ }));
    await waitFor(() => expect(setze).toHaveBeenCalledWith('s-1', 'e-hs', { quelle: 'guenstig', preisgrenzeCtKwh: 10 }));
  });
});

describe('Steuerung · Reiter Regeln', () => {
  it('zeigt eine Regel als Satz und schaltet sie ohne Rückfrage aus', async () => {
    zeige('regeln');
    const satz = await screen.findByText(/Wenn der Börsenpreis unter 0,0 ct\/kWh liegt/);
    expect(satz.closest('article')).toHaveTextContent('Heizstab Warmwasser einschalten');
    fireEvent.click(screen.getByRole('switch', { name: /Regel Negativpreise mitnehmen ausschalten/ }));
    await waitFor(() => expect(BOUND.deactivate).toHaveBeenCalledWith('f-1'));
  });

  it('baut eine neue Regel im Satzbaukasten und aktiviert sie nach den Folgen', async () => {
    zeige('regeln');
    fireEvent.click(await screen.findByRole('button', { name: /Neue Regel/ }));
    const blatt = await screen.findByRole('dialog', { name: 'Neue Regel' });
    expect(within(blatt).getByLabelText('Regel als Satz')).toHaveTextContent(/Börsenpreis.*unter.*10,0 ct\/kWh/);
    fireEvent.click(within(blatt).getByRole('button', { name: 'Weiter: Folgen' }));
    const folgen = await screen.findByRole('dialog', { name: 'Folgen prüfen' });
    fireEvent.click(within(folgen).getByRole('button', { name: /Regel aktivieren/ }));
    await waitFor(() => expect(BOUND.create).toHaveBeenCalledTimes(1));
    expect(BOUND.activate).toHaveBeenCalledWith('f-2', 1);
  });

  it('schaltet eine Szene mit gewählten Geräten ein und beendet sie ohne Rückfrage', async () => {
    const laeuft = { scene: { key: 'urlaub' as const, since: JETZT.toISOString(), pausedEntityIds: ['e-hs'] }, offen: [], message: 'Szene ist an. 1 Gerät pausiert.' };
    const an = vi.spyOn(api, 'startScene').mockImplementation(async () => {
      vi.mocked(api.scene).mockResolvedValue(laeuft);
      return laeuft;
    });
    const aus = vi.spyOn(api, 'endScene').mockImplementation(async () => {
      vi.mocked(api.scene).mockResolvedValue({ scene: null, offen: [], message: null });
      return { scene: null, offen: [], message: 'Szene beendet. Alles wieder wie vorher.' };
    });
    zeige('regeln');
    const szenen = await screen.findByRole('region', { name: 'Szenen' });
    fireEvent.click(within(szenen).getByRole('button', { name: /Urlaub/ }));
    const blatt = await screen.findByRole('dialog', { name: /Szene Urlaub/ });
    // Der Heizstab passt nicht zum Urlaub - er steht zur Wahl, ist aber aus.
    const einschalten = within(blatt).getByRole('button', { name: /Szene einschalten/ });
    expect(einschalten).toBeDisabled();
    fireEvent.click(within(blatt).getByRole('switch', { name: 'Heizstab Warmwasser in der Szene' }));
    fireEvent.click(einschalten);
    await waitFor(() => expect(an).toHaveBeenCalledWith('s-1', 'urlaub', ['e-hs']));
    await screen.findByText('Szene „Urlaub“ ist an.');
    expect(within(szenen).getByRole('button', { name: /Urlaub/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(szenen).getByRole('button', { name: /Urlaub/ }));
    await waitFor(() => expect(aus).toHaveBeenCalledWith('s-1'));
    await waitFor(() => expect(screen.queryByText('Szene „Urlaub“ ist an.')).not.toBeInTheDocument());
  });

  it('öffnet ein altes ?verbraucher=-Lesezeichen im Baukasten und räumt die Adresse auf', async () => {
    window.location.hash = '#/anlage/s-1/regeln?verbraucher=e-pool';
    zeige('regeln');
    const blatt = await screen.findByRole('dialog', { name: 'Neue Regel' });
    expect(within(blatt).getByLabelText('Regel als Satz')).toHaveTextContent('Poolpumpe');
    await waitFor(() => expect(window.location.hash).toBe('#/anlage/s-1/regeln'));
  });
});

describe('Steuerung · Reiter Laden', () => {
  it('stellt „Womit laden" über die Steuerart des Ladepunkts', async () => {
    const setze = vi.spyOn(api, 'setzeSteuerart').mockResolvedValue({ steuerart: { quelle: 'guenstig', herkunft: 'policy' }, aktiv: true });
    zeige('laden');
    const karte = await screen.findByRole('region', { name: 'Wallbox Werkstatt' });
    expect(within(karte).getByRole('button', { name: /Smart/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(karte).getByRole('button', { name: 'Günstig' }));
    await waitFor(() => expect(setze).toHaveBeenCalledWith('s-1', 'e-wb', { quelle: 'guenstig', preisgrenzeCtKwh: 9 }));
  });
});

describe('Steuerung · Reiter Laden · Sonne + Speicher', () => {
  const WB = VERBRAUCHER.verbraucher.find((v) => v.entityId === 'e-wb')!;
  const mitWallbox = (o: Partial<typeof WB>) => ({
    ...VERBRAUCHER, verbraucher: VERBRAUCHER.verbraucher.map((v) => (v.entityId === 'e-wb' ? { ...v, ...o } : v)),
  });
  const quellen = (speicher: { gesperrt: boolean; grund?: string }) => ({
    ...WB.optionen!, quellen: [{ id: 'ueberschuss', gesperrt: false }, { id: 'ueberschuss_speicher', ...speicher }, { id: 'guenstig', gesperrt: false }],
  });

  it('bietet „Sonne + Speicher“ unter „Womit laden“ an und schreibt den Überschuss-Modus speicher', async () => {
    vi.spyOn(api, 'siteVerbraucher').mockResolvedValue(mitWallbox({ optionen: quellen({ gesperrt: false }) }) as never);
    const setze = vi.spyOn(api, 'setzeSteuerart').mockResolvedValue({ steuerart: { quelle: 'ueberschuss', herkunft: 'saeule', ueberschussModus: 'speicher' }, aktiv: true });
    zeige('laden');
    const karte = await screen.findByRole('region', { name: 'Wallbox Werkstatt' });
    const gruppe = within(karte).getByRole('group', { name: 'Womit laden' });
    // „Smart“ bleibt das Wort der Moduswahl; die neue Quelle steht neben den drei bisherigen.
    expect(within(karte).getByRole('button', { name: /Smart/ })).toBeInTheDocument();
    expect(within(gruppe).getAllByRole('button').map((b) => b.textContent)).toEqual(['Nur Sonne', 'Sonne + Minimum', 'Sonne + Speicher', 'Günstig']);
    fireEvent.click(within(gruppe).getByRole('button', { name: 'Sonne + Speicher' }));
    await waitFor(() => expect(setze).toHaveBeenCalledWith('s-1', 'e-wb', { quelle: 'ueberschuss', ueberschussModus: 'speicher' }));
  });

  it('zeigt eine gesperrte Wahl mit ihrem Grund, statt sie verschwinden zu lassen', async () => {
    const grund = 'An dieser Anlage ist kein Speicher hinterlegt — ohne Speicher gibt es nichts freizugeben.';
    vi.spyOn(api, 'siteVerbraucher').mockResolvedValue(mitWallbox({ optionen: quellen({ gesperrt: true, grund }) }) as never);
    const setze = vi.spyOn(api, 'setzeSteuerart');
    zeige('laden');
    const karte = await screen.findByRole('region', { name: 'Wallbox Werkstatt' });
    const chip = within(karte).getByRole('button', { name: 'Sonne + Speicher' });
    expect(chip).toBeDisabled();
    expect(within(karte).getByText(`Sonne + Speicher: ${grund}`)).toBeInTheDocument();
    fireEvent.click(chip);
    expect(setze).not.toHaveBeenCalled();
    // Ohne freie Wahl an keinem Ladepunkt gibt es auch keine Reserve einzustellen.
    expect(screen.queryByRole('region', { name: 'Reserve für Sonne + Speicher' })).not.toBeInTheDocument();
  });

  it('erklärt mit der Meldung der Box und stellt die Reserve je Anlage ein', async () => {
    vi.spyOn(api, 'siteVerbraucher').mockResolvedValue(mitWallbox({
      steuerart: { quelle: 'ueberschuss', herkunft: 'saeule', ueberschussModus: 'speicher' }, optionen: quellen({ gesperrt: false }),
    }) as never);
    vi.spyOn(api, 'siteChargers').mockResolvedValue({ budget: {
      reportedAt: new Date().toISOString(),
      storageRelease: { active: true, kw: 3.8, floorSocPct: 22, socPct: 80, mode: 'frei', note: 'Satz der Box' },
    } as never, chargers: [] });
    vi.spyOn(api, 'chargingConfig').mockResolvedValue({ gridLimitKw: 22, priorityChargePointIds: [], storagePriority: 'speicher_vor_auto',
      storageReleaseReserveKwh: null, storageReleaseReserveStandardKwh: 1 });
    const speichern = vi.spyOn(api, 'saveStorageReleaseReserve').mockResolvedValue({ gridLimitKw: 22, priorityChargePointIds: [],
      storagePriority: 'speicher_vor_auto', storageReleaseReserveKwh: 2, storageReleaseReserveStandardKwh: 1 });
    zeige('laden');
    const karte = await screen.findByRole('region', { name: 'Wallbox Werkstatt' });
    expect(within(karte).getByRole('button', { name: 'Sonne + Speicher' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(karte).getByText(/Der Speicher gibt gerade bis 3,8 kW frei und darf bis 22 % entladen \(jetzt 80 %\)/)).toBeInTheDocument();
    const reserve = await screen.findByRole('region', { name: 'Reserve für Sonne + Speicher' });
    expect(within(reserve).getByText(/behält 1 kWh mehr.*\(Vorgabe\)/)).toBeInTheDocument();
    expect(within(reserve).getByRole('button', { name: '1 kWh · Vorgabe' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(reserve).getByRole('button', { name: '2 kWh' }));
    await waitFor(() => expect(speichern).toHaveBeenCalledWith('s-1', 2));
    await waitFor(() => expect(within(reserve).getByRole('button', { name: '2 kWh' })).toHaveAttribute('aria-pressed', 'true'));
    // Die Vorgabe zurück heißt: keine eigene Angabe (null), nicht „1 kWh fest“.
    fireEvent.click(within(reserve).getByRole('button', { name: '1 kWh · Vorgabe' }));
    await waitFor(() => expect(speichern).toHaveBeenLastCalledWith('s-1', null));
  });
});

describe('Steuerung · ehrlich ohne Daten', () => {
  it('nennt den Fehler mit Weg, wenn die Geräte-Liste fehlt', async () => {
    vi.spyOn(api, 'siteVerbraucher').mockRejectedValue(new Error('Die Anlage antwortet nicht.'));
    zeige();
    expect(await screen.findByText(/Die Anlage antwortet nicht\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeInTheDocument();
  });
});
