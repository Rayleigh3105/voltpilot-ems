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
import { api, type FunktionTeilnahme, type Funktionen, type Site } from '../api';
import { setSelbstauskunft } from '../rollen';
import { RUHE_VERBINDUNG_HINWEIS } from '../ruheHinweis';
import { STEUERN_EINSTIEG_SATZ } from '../steuernAssistent';
import { ahrenbergFunktionen } from '../test/funktionenFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import * as flowsApi from '../flows/flowsApi';
import { buildGuidedFlow } from '../flows/guidedBuilder';
import { RechteStandort, setSelbstauskunft } from '../rollen';
import { rechteSeed, STANDORT_IDS } from '../test/rollenFixtures';
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
  // Ohne Antwort von `/funktionen` behauptet die Seite nichts über „Steuern & Optimieren“.
  vi.spyOn(api, 'funktionen').mockRejectedValue(new Error('nicht da'));
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

  it('hält erst an, wenn eine Dauer gewählt und „Anhalten“ bestätigt ist (SZ-2 A)', async () => {
    const pause = vi.spyOn(api, 'pauseAutomation').mockResolvedValue({ applied: true, pushed: true, kind: 'pause', endsAt: null, effectivePowerKw: null, ttlRenewed: false, message: '' });
    zeige();
    fireEvent.click(screen.getByRole('button', { name: /Automatik an/ }));
    const blatt = await screen.findByRole('dialog', { name: /Steuerung anhalten/ });
    expect(within(blatt).getByRole('button', { name: /Anhalten/ })).toBeDisabled();
    // Ohne Antwort von `/funktionen` gibt es nur die Dauern, kein „Bis ich fortsetze“.
    expect(within(blatt).queryByRole('button', { name: /Bis ich fortsetze/ })).not.toBeInTheDocument();
    fireEvent.click(within(blatt).getByRole('button', { name: '1 Std' }));
    expect(within(blatt).getByRole('button', { name: '1 Std' })).toHaveAttribute('aria-pressed', 'true');
    expect(pause).not.toHaveBeenCalled();
    fireEvent.click(within(blatt).getByRole('button', { name: /Anhalten/ }));
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

  it('Safari: der angetippte Knopf bekommt keinen Fokus - nach Escape kehrt der Fokus trotzdem zu ihm zurück', async () => {
    // jsdom fokussiert beim Klick so wenig wie Safari/WebKit; den Auslöser muss der Öffner selbst fokussieren
    // (Gesamtlauf 04./05.10.2026, steuerung.spec.ts in mobile-webkit).
    zeige();
    const knopf = await screen.findByRole('button', { name: /Heizstab Warmwasser/ });
    expect(document.activeElement).not.toBe(knopf);
    fireEvent.click(knopf);
    const blatt = await screen.findByRole('dialog', { name: /Heizstab Warmwasser/ });
    fireEvent.click(within(blatt).getByRole('button', { name: 'Ein' }));
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });
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

describe('Steuerung · Rechte (AP-03 IP-12)', () => {
  // Grund und Weg aus /me statt eines Hebels; der Server sperrt ohnehin (403).
  const GRUND = /Dafür fehlt Ihnen das Recht\./;
  function zeigeAls(kennung: string, reiter: 'steuerung' | 'laden' | 'regeln' = 'steuerung') {
    setSelbstauskunft(rechteSeed(kennung).me);
    render(
      <RechteStandort.Provider value={STANDORT_IDS['ST-1']}>
        <SteuerungSection site={site} reiter={reiter} tabs={TABS} onOpenSub={vi.fn()} />
      </RechteStandort.Provider>,
    );
  }

  it('ohne Steuerrecht: der Automatik-Knopf zeigt den Zustand, ist aber gesperrt mit Grund', async () => {
    zeigeAls('IK');
    const auto = screen.getByRole('button', { name: /Automatik an/ });
    expect(auto).toBeDisabled();
    expect(auto.getAttribute('title')).toMatch(GRUND);
  });

  it('ohne Steuerrecht: am Gerät stehen Grund und Weg statt Aus · Smart · Ein, Übernehmen und Reihenfolge', async () => {
    zeigeAls('IK');
    fireEvent.click(await screen.findByRole('button', { name: /Heizstab Warmwasser/ }));
    const blatt = await screen.findByRole('dialog', { name: /Heizstab Warmwasser/ });
    expect(within(blatt).queryByRole('button', { name: 'Ein' })).not.toBeInTheDocument();
    expect(within(blatt).queryByRole('button', { name: /Auch wenn/ })).not.toBeInTheDocument();
    expect(within(blatt).queryByRole('button', { name: /Reihenfolge ändern/ })).not.toBeInTheDocument();
    fireEvent.click(within(blatt).getByRole('button', { name: /Günstige Stunden/ }));
    expect(within(blatt).queryByRole('button', { name: /Übernehmen/ })).not.toBeInTheDocument();
    const gruende = within(blatt).getAllByRole('note');
    expect(gruende.length).toBeGreaterThanOrEqual(3);
    for (const g of gruende) expect(g).toHaveTextContent(GRUND);
    expect(cStartOverride).not.toHaveBeenCalled();
  });

  it('ohne Steuerrecht: keine neue Regel, keine Vorlage, kein Regel-Schalter', async () => {
    zeigeAls('IK', 'regeln');
    await screen.findByText(/Wenn der Börsenpreis unter 0,0 ct\/kWh liegt/);
    expect(screen.queryByRole('button', { name: /Neue Regel/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /Regel Negativpreise mitnehmen/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Vorlagen' })?.querySelector('button.vk') ?? null).toBeNull();
    expect(screen.getAllByRole('note').every((n) => GRUND.test(n.textContent ?? ''))).toBe(true);
    expect(BOUND.deactivate).not.toHaveBeenCalled();
  });

  it('der Bedienberechtigte bedient und rahmt nicht: Lademodus ja, Anschlussgrenze nur mit Grund', async () => {
    zeigeAls('MD', 'laden');
    const karte = await screen.findByRole('region', { name: 'Wallbox Werkstatt' });
    expect(within(karte).getByRole('group', { name: 'Lademodus' })).toBeInTheDocument();
    expect(within(karte).getByRole('group', { name: 'Womit laden' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Automatik an/ })).toBeEnabled();
    fireEvent.click(within(screen.getByRole('region', { name: 'Netzanschluss' })).getByRole('button', { name: /Rahmen/ }));
    const blatt = await screen.findByRole('dialog', { name: /Netzanschluss und Laden/ });
    expect(within(blatt).queryByRole('button', { name: 'mehr' })).not.toBeInTheDocument();
    expect(within(blatt).queryByRole('button', { name: 'Übernehmen' })).not.toBeInTheDocument();
    expect(within(blatt).getByRole('note')).toHaveTextContent(GRUND);
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

/** `/funktionen` mit dieser Anlage (`s-1`) als Halle 1 (Werk Ahrenberg) bzw. Werk Lindach. */
function funktionenMit(t: Partial<FunktionTeilnahme>, standort: 0 | 1 = 0): Funktionen {
  const f = structuredClone(ahrenbergFunktionen());
  const anlage = f.standorte[standort].steuern.anlagen[0];
  anlage.id = 's-1';
  Object.assign(anlage.teilnahme, t);
  return f;
}

describe('Steuerung · Steuern & Optimieren (UEMS)', () => {
  it('angehalten: Plakette mit Zustand statt „Automatik an“, Band mit Ruhe-Satz, Eingriffe gesperrt mit Grund', async () => {
    vi.spyOn(api, 'funktionen').mockResolvedValue(funktionenMit({
      zustand: 'angehalten', seit: '2026-11-03T14:10:00+01:00', aktionen: ['fortsetzen', 'beenden'],
      ruhe_hinweis: { jetzt: true, beim_anhalten: false },
    }));
    const pause = vi.spyOn(api, 'pauseAutomation');
    zeige();
    expect(await screen.findByText('Angehalten seit 03.11.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Automatik an/ })).not.toBeInTheDocument();
    const band = screen.getByTestId('steuern-ruhe');
    expect(band).toHaveTextContent('Steuerung angehalten seit 03.11.2026 14:10.');
    expect(band).toHaveTextContent('Regeln und das Betriebsmodell des Speichers wirken nicht, bis Sie fortsetzen.');
    expect(screen.getByTestId('ruhe-verbindung-hinweis')).toHaveTextContent(RUHE_VERBINDUNG_HINWEIS);

    fireEvent.click(await screen.findByRole('button', { name: /Heizstab Warmwasser/ }));
    const blatt = await screen.findByRole('dialog', { name: /Heizstab Warmwasser/ });
    expect(within(blatt).getByRole('button', { name: 'Aus' })).toBeDisabled();
    expect(within(blatt).getByRole('button', { name: 'Ein' })).toBeDisabled();
    expect(within(blatt).getByRole('note')).toHaveTextContent('Eingriffe und Pause gibt es wieder, sobald die Steuerung fortgesetzt ist.');
    fireEvent.click(within(blatt).getByRole('button', { name: 'Ein' }));
    expect(within(blatt).queryByText(/Das passiert:/)).not.toBeInTheDocument();
    expect(cStartOverride).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });

  it('eingerichtet: „Noch nicht gestartet“, und am Ladepunkt sind Aus und Schnell gesperrt', async () => {
    vi.spyOn(api, 'funktionen').mockResolvedValue(funktionenMit({ zustand: 'eingerichtet', seit: '2026-10-01T09:00:00+02:00', aktionen: ['starten'] }));
    const boost = vi.spyOn(api, 'chargingBoost');
    zeige('laden');
    expect(await screen.findByText('Noch nicht gestartet')).toBeInTheDocument();
    expect(screen.getByTestId('steuern-ruhe')).toHaveTextContent('Eingerichtet am 01.10.2026 — Steuerung noch nicht gestartet.');
    expect(screen.queryByTestId('ruhe-verbindung-hinweis')).not.toBeInTheDocument();
    const karte = await screen.findByRole('region', { name: 'Wallbox Werkstatt' });
    expect(within(karte).getByRole('button', { name: /Aus/ })).toBeDisabled();
    expect(within(karte).getByRole('button', { name: /Schnell/ })).toBeDisabled();
    expect(within(karte).getByRole('button', { name: /Smart/ })).toBeEnabled();
    expect(within(karte).getByRole('note')).toHaveTextContent('Eingriffe und Pause gibt es, sobald die Steuerung gestartet ist.');
    expect(boost).not.toHaveBeenCalled();
  });

  it('SZ-1 A · nimmt nicht teil: Messen-Ansicht - Einstieg, nur Gemessenes, Geräte-Liste mit Weg zur Steuerart', async () => {
    vi.spyOn(api, 'funktionen').mockResolvedValue(funktionenMit({}, 1));
    zeige();
    const einstieg = await screen.findByTestId('steuern-einstieg');
    expect(einstieg).toHaveTextContent(STEUERN_EINSTIEG_SATZ);
    expect(einstieg).toHaveTextContent('VoltPilot misst hier. Steuern richten Sie für den Standort ein.');
    expect(within(einstieg).getByRole('button', { name: 'Steuern & Optimieren einrichten' })).toBeInTheDocument();
    expect(screen.queryByTestId('steuern-ruhe')).not.toBeInTheDocument();
    const liste = await screen.findByRole('region', { name: 'Gemessene Geräte' });
    await waitFor(() => expect(within(liste).getByRole('button', { name: /Heizstab Warmwasser/ })).toHaveTextContent('3,0 kW'));
    // Keine Plakette, keine Reihenfolge, kein Plan, keine Vorschläge, kein „Gerät fehlt?“.
    expect(document.querySelector('.stn-kopf .auto')).toBeNull();
    expect(document.querySelectorAll('.stn-reiter .n')).toHaveLength(0);
    expect(screen.queryByText(/Automatik/)).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Geräte und Reihenfolge' })).not.toBeInTheDocument();
    expect(screen.queryByText('Wer bekommt Sonnenstrom zuerst?')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /Neu in Ihrer Anlage/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Gerät fehlt\?/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Plan/)).not.toBeInTheDocument();
    const jetzt = screen.getByRole('region', { name: 'Jetzt' });
    expect(jetzt).toHaveTextContent('gemessen');
    expect(jetzt).toHaveTextContent('Die Anlage speist 0,4 kW ins Netz ein, die PV liefert 8,0 kW.');
    expect(jetzt).toHaveTextContent('Größter Verbraucher gerade: Heizstab Warmwasser 3,0 kW.');
    expect(within(liste).getAllByRole('button').map((b) => b.querySelector('.d-name b')?.textContent)).toEqual(
      ['Speicher Scheune', 'Heizstab Warmwasser', 'Poolpumpe', 'Infrarotheizung', 'Spülmaschine', 'Lüftung', 'Wallbox Werkstatt'],
    );
    expect(liste).toHaveTextContent('Antippen zeigt Messwerte und Steuerart des Geräts. Regeln stehen im Reiter Regeln.');
    // Der Weg zur Steuerart: Antippen öffnet das Geräte-Blatt.
    fireEvent.click(within(liste).getByRole('button', { name: /Spülmaschine/ }));
    const blatt = await screen.findByRole('dialog', { name: /Spülmaschine/ });
    expect(blatt).toHaveTextContent('Smart heißt hier');
  });

  it('SZ-2 A · aktiv: „Bis ich fortsetze“ im selben Blatt; erst „Anhalten“ hält über die Funktion an', async () => {
    vi.spyOn(api, 'funktionen').mockResolvedValue(funktionenMit({
      zustand: 'aktiv', aktionen: ['anhalten', 'beenden'], ruhe_hinweis: { jetzt: false, beim_anhalten: true },
    }));
    const steuern = vi.spyOn(api, 'funktionSteuern').mockResolvedValue({} as never);
    const pause = vi.spyOn(api, 'pauseAutomation');
    zeige();
    await waitFor(() => expect(api.funktionen).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Automatik an/ }));
    const blatt = await screen.findByRole('dialog', { name: /Steuerung anhalten/ });
    expect(within(blatt).getAllByRole('button').map((b) => b.textContent)).toEqual(expect.arrayContaining(['30 Min', '1 Std', '2 Std', '4 Std']));
    const offen = await within(blatt).findByRole('button', { name: /Bis ich fortsetze/ });
    expect(offen).toHaveTextContent('die Anlage bleibt ohne Enddatum angehalten, bis jemand fortsetzt');
    expect(within(blatt).queryByText(RUHE_VERBINDUNG_HINWEIS)).not.toBeInTheDocument();
    fireEvent.click(offen);
    expect(offen).toHaveAttribute('aria-pressed', 'true');
    // Eine ältere Box hält die Ruhe nur verbunden (#986) - das Blatt sagt es vor dem Anhalten.
    expect(within(blatt).getByText(RUHE_VERBINDUNG_HINWEIS)).toBeInTheDocument();
    expect(steuern).not.toHaveBeenCalled();
    fireEvent.click(within(blatt).getByRole('button', { name: /Anhalten/ }));
    await waitFor(() => expect(steuern).toHaveBeenCalledWith('s-1', 'anhalten'));
    expect(pause).not.toHaveBeenCalled();
  });

  it('SZ-2 A · ohne das Recht zum Anhalten ist „Bis ich fortsetze“ nicht wählbar, mit Grund; die Dauern bleiben', async () => {
    const me = structuredClone(rechteSeed().me);
    me.unternehmen_rechte = me.unternehmen_rechte.filter((r) => r !== 'steuerung.anhalten_fortsetzen');
    me.standorte = me.standorte.map((x) => ({ ...x, rechte: x.rechte.filter((r) => r !== 'steuerung.anhalten_fortsetzen') }));
    setSelbstauskunft(me);
    vi.spyOn(api, 'funktionen').mockResolvedValue(funktionenMit({ zustand: 'aktiv', aktionen: ['anhalten', 'beenden'] }));
    zeige();
    await waitFor(() => expect(api.funktionen).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Automatik an/ }));
    const blatt = await screen.findByRole('dialog', { name: /Steuerung anhalten/ });
    expect(await within(blatt).findByRole('button', { name: /Bis ich fortsetze/ })).toBeDisabled();
    expect(within(blatt).getByRole('note')).toHaveTextContent('Dafür fehlt Ihnen das Recht.');
    expect(within(blatt).getByRole('button', { name: '1 Std' })).toBeEnabled();
  });

  it('SZ-2 A · angehalten: Geräte, Laden und Regeln abgedimmt mit Grund, keine Reihenfolge zum Ändern; Fortsetzen im Band mit Bestätigung', async () => {
    vi.spyOn(api, 'funktionen').mockResolvedValue(funktionenMit({
      zustand: 'angehalten', seit: '2026-11-03T14:10:00+01:00', aktionen: ['fortsetzen', 'beenden'],
    }));
    const steuern = vi.spyOn(api, 'funktionSteuern').mockResolvedValue({} as never);
    zeige();
    const band = await screen.findByTestId('steuern-ruhe');
    const liste = await screen.findByRole('region', { name: 'Geräte und Reihenfolge' });
    const heizstab = await within(liste).findByRole('button', { name: /Heizstab Warmwasser/ });
    expect(heizstab).toHaveClass('matt');
    expect(heizstab).toHaveTextContent('VoltPilot schaltet nicht · sicherer Zustand');
    expect(heizstab).toHaveTextContent('angehalten');
    expect(within(liste).getByRole('button', { name: /Speicher Scheune/ })).toHaveTextContent('wirkt nicht — angehalten seit 03.11.2026 14:10');
    expect(within(liste).queryByRole('button', { name: /Ändern/ })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Jetzt' })).toHaveTextContent('VoltPilot steuert gerade nicht.');
    expect(document.querySelectorAll('.stn-reiter .n')).toHaveLength(0);
    fireEvent.click(within(band).getByRole('button', { name: 'Fortsetzen' }));
    const blatt = await screen.findByRole('dialog', { name: /Steuerung fortsetzen/ });
    expect(blatt).toHaveTextContent('VoltPilot prüft Box, Freigaben, Grenze, Hauptzähler und Betriebsweise erneut.');
    expect(steuern).not.toHaveBeenCalled();
    fireEvent.click(within(blatt).getByRole('button', { name: /Fortsetzen/ }));
    await waitFor(() => expect(steuern).toHaveBeenCalledWith('s-1', 'fortsetzen'));
  });

  it('SZ-2 A · angehalten: eine eingeschaltete Regel „wirkt nicht“, die Ladekarte steht abgedimmt', async () => {
    vi.spyOn(api, 'funktionen').mockResolvedValue(funktionenMit({
      zustand: 'angehalten', seit: '2026-11-03T14:10:00+01:00', aktionen: ['fortsetzen', 'beenden'],
    }));
    const { unmount } = render(<SteuerungSection site={site} reiter="regeln" tabs={TABS} onOpenSub={vi.fn()} />);
    await screen.findByTestId('steuern-ruhe');
    const regel = await waitFor(() => document.getElementById('regel-f-1')!);
    await waitFor(() => expect(regel).toHaveTextContent('wirkt nicht'));
    expect(regel).toHaveTextContent('bis Sie fortsetzen');
    expect(regel).toHaveClass('matt');
    unmount();
    zeige('laden');
    await screen.findByTestId('steuern-ruhe');
    expect(await screen.findByRole('region', { name: 'Wallbox Werkstatt' })).toHaveClass('matt');
  });

  it('SZ-2 A · befristet pausiert: die Plakette sagt „Pausiert bis …“, das Band setzt fort', async () => {
    // Fester Mittag statt der echten Uhr: nach 23 Uhr endete die Pause erst morgen
    // („Pausiert bis morgen 00:00“) - Gesamtlauf 04.10.2026. Nur Date, die Timer bleiben echt.
    vi.setSystemTime(new Date(2026, 9, 14, 12, 0));
    try {
      vi.spyOn(api, 'siteInterventions').mockResolvedValue({ automationPaused: true, pausedUntil: new Date(Date.now() + 3_600_000).toISOString(), interventions: [] });
      const weiter = vi.spyOn(api, 'resumeAutomation').mockResolvedValue({} as never);
      zeige();
      expect(await screen.findByRole('button', { name: /^Pausiert bis \d{2}:\d{2}$/ })).toBeEnabled();
      const band = screen.getByText(/^Automatik pausiert bis/).closest('.stn-band') as HTMLElement;
      fireEvent.click(within(band).getByRole('button', { name: 'Fortsetzen' }));
      await waitFor(() => expect(weiter).toHaveBeenCalledWith('s-1'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('Bestandsschutz: steuernd und nicht angehalten - die Seite ist dieselbe wie ohne „Steuern & Optimieren“', async () => {
    const bild = async () => {
      const { container, unmount } = render(<SteuerungSection site={site} reiter="steuerung" tabs={TABS} onOpenSub={vi.fn()} />);
      await screen.findByRole('button', { name: /Heizstab Warmwasser/ });
      await waitFor(() => expect(api.funktionen).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 30));
      const html = (container.querySelector('.stn') as HTMLElement).innerHTML.replace(/\d{2}:\d{2}/g, 'HH:MM');
      unmount();
      return html;
    };
    const ohne = await bild();
    vi.spyOn(api, 'funktionen').mockResolvedValue(funktionenMit({ zustand: 'aktiv', aktionen: ['anhalten', 'beenden'] }));
    const aktiv = await bild();
    expect(aktiv).toBe(ohne);
    expect(aktiv).toContain('Automatik an');
  });

  it('angehalten und ohne Recht: der Ruhe-Grund steht für alle, die Knöpfe folgen dem Recht', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    vi.spyOn(api, 'funktionen').mockResolvedValue(funktionenMit({
      zustand: 'angehalten', seit: '2026-11-03T14:10:00+01:00', aktionen: ['fortsetzen', 'beenden'],
    }));
    zeige();
    expect(await screen.findByText('Angehalten seit 03.11.')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /Heizstab Warmwasser/ }));
    const blatt = await screen.findByRole('dialog', { name: /Heizstab Warmwasser/ });
    expect(within(blatt).queryByRole('button', { name: 'Smart' })).not.toBeInTheDocument();
    const saetze = within(blatt).getAllByRole('note').map((n) => n.textContent ?? '');
    expect(saetze).toContain('Eingriffe und Pause gibt es wieder, sobald die Steuerung fortgesetzt ist.');
    expect(saetze.some((t) => t.startsWith('Dafür fehlt Ihnen das Recht.'))).toBe(true);
  });

  it('ohne Recht bleibt der Einstiegs-Satz, der Knopf fehlt (nur der Kundenadministrator richtet ein)', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    vi.spyOn(api, 'funktionen').mockResolvedValue(funktionenMit({}, 1));
    zeige();
    const einstieg = await screen.findByTestId('steuern-einstieg');
    expect(einstieg).toHaveTextContent(STEUERN_EINSTIEG_SATZ);
    expect(within(einstieg).queryByRole('button')).not.toBeInTheDocument();
  });
});
