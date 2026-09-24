import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { VpPicker } from '../components/VpPicker';
import {
  api,
  ApiError,
  type SchedulePlan,
  type SiteInterventions,
  type DeviceExportLimit,
  type RegisterKnowledgeFamily,
  type RegisterWriteEvent,
  type RegisterWriteTarget,
  type ControlStatus,
  type CurtailmentStatus,
  type Device,
  type EdgeVersion,
  type EntityStrategy,
  type Site,
  type SiteComponents,
  type SiteComponentRow,
  type ComponentDefinition,
  type SiteEntities,
  type SiteEntity,
  type SiteSource,
  type SiteTopology,
} from '../api';
import { ausfallSchutz, type SiteCharging } from '../ladepunkte';
import {
  chargePointIdOf,
  geraetSeite,
  pvEinstiegEntityId,
  summenwertEinstieg,
  type GeraetArt,
  type GeraetSeiteView,
  type Zeile,
} from '../geraetSeite';
import {
  abregelungDiesesGeraets,
  blattHinweis,
  gesicht,
  type Gesicht,
  type Held,
  type HeldKachel,
  type SektionId,
} from '../geraetGesicht';
import { plantModel, type PlantComponent } from '../komponenten';
import { fmtNum } from '../format';
import { deviceLimitLine, exportGuardView, WAECHTER_LABEL } from '../curtailment';
import { COMPONENT_ROLE_ICONS } from '../komponenten';
import type { IconName } from '../../designsystem/components/core/Icon';
import { EmptyState, ErrorState, TextSkeleton } from '../components/States';
import { GeraetProtokoll } from '../components/GeraetProtokoll';
import { GeraetGefahrenzone } from '../components/GeraetGefahrenzone';
import { GeraetSummenwerte } from '../components/GeraetSummenwerte';
import { gefahrenzone } from '../geraetLoeschen';
import {
  anlageRoute,
  befehleGeraetHash,
  geraetBearbeitenKomponente,
  hashForRoute,
  istGeraetBearbeitenHash,
  ohneGeraetBearbeiten,
  pageRoute,
} from '../nav';
import {
  ABRUF_HINWEIS,
  abrufFehler,
  abrufZeile,
  LESE_FEHLGESCHLAGEN,
  QUELLE_WORT,
  registerSicht,
  type RegisterZeile,
} from '../geraetRegister';
import { klasseTon, klasseWort } from '../registerWrite';
import {
  EXPERTE_INTRO,
  geraeteVerlauf,
  KEIN_SCHREIBWEG,
  geraetRegisterZugang,
  LESE_DAUER_HINWEIS,
  LESE_LAEUFT,
  vorschau,
  zielInput,
  zielKey,
  type GeraetRegisterZugang,
} from '../registerWrite';
import { RegisterWriteDrawer } from '../components/RegisterWriteDrawer';
import {
  ANLAGENWEITE_BEFEHLE,
  aufzeichnungSeit,
  GERAETE_BEFEHLE,
  genauigkeitsSatz,
  NUR_LESEN,
} from '../befehle';
import {
  aktionsZeile,
  neuesteZeile,
  type VerlaufAktion,
} from '../befehleVerlauf';
import {
  BefehleAktionszeile,
  BefehleVerlauf,
  useBefehleVerlauf,
  type VerlaufState,
} from '../components/BefehleVerlauf';
import {
  DAUERN,
  endeVon,
  handeingriffFolgen,
  planVerzicht,
  speicherAktionen,
  type HandeingriffAktion,
} from '../handeingriff';
import { HandeingriffDialog } from '../components/HandeingriffDialog';
import { ConsumerOverrideDialog } from '../components/ConsumerOverrideDialog';
import { consumersApi } from '../consumers/consumersApi';
import { ioZustandView, type IoModulZustandDto } from '../consumers/ioZustand';
import type { Consumer } from '../consumers/types';
import {
  sofortAktionen,
  fulfilmentSummary,
  type ConsumerFulfilment,
  type ManualOverride,
  type SofortAktion,
} from '../consumers/fulfillment';
import { consumerHasMeasurement, consumerNachweis } from '../consumers/questions';
import { controlStrip } from '../control';
import { useFreshnessPoll } from '../useFreshnessPoll';
// LIVE: die Geräteseite zeigt gemessene Ist-Werte und Steuer-Rückmeldungen.
import { LIVE_POLL_MS } from '../pollCadence';
import { showTechnicalLayer } from '../rollen';
import { AdminGeraetKarten } from '../components/AdminGeraetKarten';
import { AnlegenFlow } from '../components/AnlegenFlow';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { UmbenennenDialog, type RenameTarget } from '../components/UmbenennenDialog';
import { geraetView, type GeraetView } from '../adminGeraet';
import { adminApi } from '../admin/adminApi';
import { fleetApi } from '../admin/fleetApi';
import { NO_DATA } from '../nodata';
import { replaceCurrentNavigation } from '../navigationBlocker';
import { OcppWallboxPage } from './OcppWallboxPage';
import { GeraetBrotkrume } from '../components/GeraetBrotkrume';
import { GeraetRahmen, RahmenSektion } from '../components/GeraetRahmen';
import {
  GESICHT_ZU_RAHMEN,
  kopfHinweis,
  kurz,
  rahmen,
  parseKachel,
  type Befund,
  type RahmenSektionId,
  type SektionAngebot,
} from '../geraetRahmen';
import { BeobachteteRegister } from '../components/BeobachteteRegister';
import {
  BRUECKE_LABEL,
  BRUECKE_NICHT_MOEGLICH,
  brueckeAusLesung,
  type BrueckeVorschlag,
} from '../beobachteteRegister';
import { beobachtenMoeglich, geraetFamilien } from '../registerFamilie';
import '../components/AnlagenModell.css';
// ⚠ Ein Bauteil bringt sein Stylesheet SELBST mit (die RegelKarten-Lehre): die
// Befehls-Sektion rendert den VERLAUF, dessen Regeln in `Befehle.css` wohnen -
// ohne diesen Import stünde er ungestylt da, sobald ein Kunde direkt auf einer
// Geräteseite ankommt (im Browser gefunden).
import './Befehle.css';
import './GeraetSeite.css';

/**
 * Die GERÄTE-DETAILSEITE der Anlagen-Zentrale
 * (`#/anlage/{siteId}/geraet/{ref}[/{geraetId}]`, Konzept
 * `vp-anlagen-zentrale-konzept-h6` §7, Stufe 1 PR 1a).
 *
 * Sie ist der eine ORT, den ein Gerät bis hierher nicht hatte: Anbindung,
 * Messwerte, seine Komponenten, seine Steuerungs-Bezüge, sein Software-Stand
 * und - auf der Box - die Gefahrenzone. **Kunde und Plattform-Admin sehen
 * DIESELBE Seite**; der Admin bekommt in einer späteren Stufe additive Karten
 * hinter dem EINEN Tor `rollen.showTechnicalLayer()`, nie eine zweite Fläche.
 *
 * Diese Datei RENDERT nur. Jede Regel, jeder Satz und jedes Urteil liegt in
 * der reinen `src/geraetSeite.ts`, und die Komponenten-Zeilen kommen aus
 * `plantModel` - dieselbe Ableitung, die die Zentrale rendert, damit die zwei
 * Flächen über dasselbe Gerät nie Verschiedenes behaupten können.
 *
 * **Jeder Nebenabruf ist fail-soft.** Fällt einer aus, wird seine Sektion
 * ehrlich leer (mit Grund) statt die Seite unbenutzbar zu machen - nur der
 * Entitäts-Abruf trägt die Seite.
 */
export function GeraetSeiteSection({
  site,
  boxRef: geraeteRef,
  geraetId,
  devices,
  devicesFetchedAt = null,
}: {
  site: Site;
  /**
   * Die Referenz der VoltPilot-Box aus der Adresse. Sie heisst `boxRef` und
   * nicht `ref`, weil `ref` in React reserviert ist - ein gleichnamiger Prop
   * erreicht eine Funktions-Komponente gar nicht.
   */
  boxRef: string;
  /** `inverter` · `src-…` · `cp-…`; null = die Box selbst. */
  geraetId: string | null;
  devices?: Device[];
  /** Bezugszeit der Geräteliste - die Box altert dagegen (`liveness.ts`). */
  devicesFetchedAt?: number | null;
}) {
  // Die BOX dieser Adresse - der Schlüssel, unter dem jedes Journal dieses
  // Geräts liegt (geschrieben wird immer über sie). Früh abgeleitet, weil die
  // Abrufe sie brauchen.
  const boxDevice = (devices ?? []).find(
    (d) => d.siteId === site.id && d.externalRef === geraeteRef,
  );
  const [data, setData] = useState<SiteEntities | null>(null);
  const [entitiesLoadedRequest, setEntitiesLoadedRequest] = useState<string | null>(null);
  const [topology, setTopology] = useState<SiteTopology | null>(null);
  const [sources, setSources] = useState<SiteSource[] | null>(null);
  const [components, setComponents] = useState<SiteComponents | null>(null);
  const [componentsLoadedRequest, setComponentsLoadedRequest] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editNotice, setEditNotice] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [versions, setVersions] = useState<ComponentDefinition[]>([]);
  const [rollbackTarget, setRollbackTarget] = useState<ComponentDefinition | null>(null);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [control, setControl] = useState<ControlStatus | null>(null);
  const [curtailment, setCurtailment] = useState<CurtailmentStatus | null>(null);
  const [edgeVersions, setEdgeVersions] = useState<EdgeVersion[] | null>(null);
  const [charging, setCharging] = useState<SiteCharging | null>(null);
  const [chargingLoadedRequest, setChargingLoadedRequest] = useState<string | null>(null);
  const [strategies, setStrategies] = useState<Record<string, EntityStrategy[]> | null>(null);
  // Geräteseiten Stufe 2: der VERLAUF lädt sich selbst (Fenster, Cursor,
  // stiller Takt) - dieselbe Mechanik wie auf der Befehle-Seite.
  const [interventions, setInterventions] = useState<SiteInterventions | null>(null);
  const [consumers, setConsumers] = useState<Consumer[]>([]);
  const [overrides, setOverrides] = useState<ManualOverride[]>([]);
  // §5.4: die Erfüllungs-Kopfzeile des Helden. Sie wird NUR geholt, wenn es
  // wirklich einen Verbraucher gibt - sonst gäbe es nichts zu erfüllen.
  const [fulfilment, setFulfilment] = useState<ConsumerFulfilment | null>(null);
  const [plan, setPlan] = useState<SchedulePlan | null>(null);
  const [regOffen, setRegOffen] = useState(false);
  const [hand, setHand] = useState<HandeingriffAktion | null>(null);
  const [handDauer, setHandDauer] = useState('2h');
  const [eingriff, setEingriff] = useState<{ consumer: Consumer; aktion: SofortAktion } | null>(null);
  const [aktionBusy, setAktionBusy] = useState(false);
  const [targets, setTargets] = useState<RegisterWriteTarget[] | null>(null);
  const [writes, setWrites] = useState<RegisterWriteEvent[] | null>(null);
  const [knowledge, setKnowledge] = useState<RegisterKnowledgeFamily[] | null>(null);
  /**
   * Die BRÜCKE (Stufe 3a §7.2 Teil 3): eine gelesene Zeile wird zur
   * Beobachtung. Sie reist als ZUSTAND durch den Wirt, weil Lesung (Teil 3)
   * und Beobachtungs-Liste (Teil 1) zwei Bauteile sind - und wird nach dem
   * Öffnen des Formulars wieder abgeräumt, damit derselbe Vorschlag nicht bei
   * jedem Render erneut aufspringt.
   */
  const [bruecke, setBruecke] = useState<BrueckeVorschlag | null>(null);
  const brueckeVerbraucht = useCallback(() => setBruecke(null), []);
  /** Die Kurzfassung der Register-Sektion - sie kommt aus der Beobachtungs-Fläche. */
  const [beobKurz, setBeobKurz] = useState<string | null>(null);
  /**
   * Trägt dieses Gerät die PV-Produktion der Anlage (eine Rollen-Zuordnung,
   * vp-agg-konzept3-r8)? Nur für die ehrliche Gefahrenzonen-Folge; der Zähler
   * frischt sie nach, wenn der Assistent die Zuordnung ändert.
   */
  const [pvZugeordnet, setPvZugeordnet] = useState(false);
  const [pvReload, setPvReload] = useState(0);
  // Die PLATTFORM-Sicht: vier zusätzliche Reads, die es NUR hinter dem einen
  // Tor überhaupt gibt (M7 `showTechnicalLayer`) - ein Kunde holt sie nie.
  const [adminView, setAdminView] = useState<GeraetView | null>(null);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminFehler, setAdminFehler] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const pageRequest = `${site.id}:${geraeteRef}:${geraetId ?? ''}:${reloadKey}`;

  // Ein offener Namensdialog gehört zur adressierten Säule. Bei einem
  // Gerätewechsel darf er nie mit dem Ziel der neuen Route wieder auftauchen.
  useEffect(() => {
    setRenameTarget(null);
    setEditOpen(false);
    setEditNotice(null);
    setEditError(null);
  }, [site.id, geraeteRef, geraetId]);

  useEffect(() => {
    let active = true;
    setData(null);
    setEntitiesLoadedRequest(null);
    setComponents(null);
    setComponentsLoadedRequest(null);
    setChargingLoadedRequest(null);
    setError(false);
    // Der EINE tragende Abruf - ohne ihn gibt es kein Gerät zu zeigen.
    api.siteEntities(site.id).then(
      (d) => {
        if (!active) return;
        setData(d);
        setEntitiesLoadedRequest(pageRequest);
      },
      () => {
        if (!active) return;
        setError(true);
        setEntitiesLoadedRequest(pageRequest);
      },
    );
    // Alles Übrige fail-soft: ein Ausfall macht seine Sektion ehrlich leer.
    const soft = <T,>(p: Promise<T | null>, set: (v: T | null) => void) => {
      // `Promise<T | null>`, weil zwei dieser Antworten selbst schon `null`
      // sein dürfen (204: „das Gerät hat sich dazu nie geäußert") - ein
      // Fehlschlag und ein ehrliches Nichts landen hier im selben Zustand.
      void p.then(
        (v) => {
          if (active) set(v ?? null);
        },
        () => {
          if (active) set(null);
        },
      );
    };
    soft(api.topology(site.id), setTopology);
    soft(api.siteSources(site.id), setSources);
    void api.siteComponents(site.id).then(
      (value) => {
        if (!active) return;
        setComponents(value);
        setComponentsLoadedRequest(pageRequest);
      },
      () => {
        if (!active) return;
        setComponents(null);
        setComponentsLoadedRequest(pageRequest);
      },
    );
    soft(api.controlStatus(site.id), setControl);
    soft(api.curtailmentStatus(site.id), setCurtailment);
    soft(api.edgeVersions(), setEdgeVersions);
    void api.siteChargers(site.id).then(
      (value) => {
        if (!active) return;
        setCharging(value ?? null);
        setChargingLoadedRequest(pageRequest);
      },
      () => {
        if (!active) return;
        setCharging(null);
        setChargingLoadedRequest(pageRequest);
      },
    );
    soft(api.entityStrategies(site.id), setStrategies);
    // Sektion E: die Ziele des Register-Werkzeugs. Ohne sie gibt es keinen
    // Knopf - nie einen, der ins Leere führt.
    //
    // ⚠ Bewusst NICHT über `soft`: dort fallen „lädt noch" und „Abruf
    // gescheitert" in denselben Zustand, und die Sektion müsste einen Satz
    // sagen, der in einem der beiden Fälle falsch ist. Ein Fehlschlag ist hier
    // eine LEERE Ziel-Liste - dann sagt sie ehrlich, dass kein Schreibweg
    // bekannt ist.
    // Sektion D: die gelesenen Register kommen AUS DEM BESTAND - das Journal
    // trägt die einzigen Rohwörter, die es heute gibt, das Register-Wissen den
    // Namen (nie einen ohne bekannte Familie).
    soft(api.registerWriteHistory(site.id, boxDevice?.id), setWrites);
    soft(api.registerKnowledge(site.id), setKnowledge);
    void api.registerWriteTargets(site.id).then(
      (rows) => {
        if (active) setTargets(rows);
      },
      () => {
        if (active) setTargets([]);
      },
    );
    setNow(Date.now());
    if (showTechnicalLayer()) {
      // Fail-soft und ALLES-ODER-NICHTS: ohne die Geräte-Zeile gibt es keine
      // Admin-Sicht - die Ableitung braucht sie, und eine halbe Sicht wäre
      // eine Aussage über ein Gerät, das wir nicht vollständig kennen.
      void Promise.all([
        adminApi.listDevices(),
        fleetApi.fleet(),
        adminApi.controlCandidates().catch(() => null),
        adminApi.edgeUpdates().catch(() => null),
      ]).then(
        ([devs, flotte, candidates, updates]) => {
          if (!active) return;
          setAdminView(geraetView({
            ref: geraeteRef,
            devices: devs,
            sites: flotte.sites,
            candidates,
            releases: updates?.releases ?? [],
            journal: updates?.journal ?? [],
          }, new Date()));
        },
        () => {
          if (active) setAdminView(null);
        },
      );
    }
    return () => {
      active = false;
    };
  }, [site.id, geraeteRef, geraetId, boxDevice?.id, reloadKey, pageRequest]);

  /**
   * Eine Admin-Handlung: ausführen, dann die Seite neu laden. Ein Fehlschlag
   * wird BENANNT - eine Handlung, die still nichts tut, ist die schlechteste
   * Rückmeldung.
   */
  async function adminAktion(fn: () => Promise<unknown>) {
    setAdminBusy(true);
    setAdminFehler(null);
    try {
      await fn();
      setReloadKey((k) => k + 1);
    } catch (e) {
      setAdminFehler(e instanceof ApiError ? e.message : 'Die Aktion ist fehlgeschlagen.');
    } finally {
      setAdminBusy(false);
    }
  }

  // Der stille Takt: Zustand UND Bezugszeit werden ZUSAMMEN gesetzt, ein
  // Fehlschlag lässt beides unberührt (die `liveness.ts`-Lehre).
  useFreshnessPoll(() => {
    Promise.all([
      api.siteSources(site.id).catch(() => null),
      api.controlStatus(site.id).catch(() => null),
      api.curtailmentStatus(site.id).catch(() => null),
      api.siteChargers(site.id).catch(() => null),
    ]).then(([s, c, cu, ch]) => {
      if (s !== null) setSources(s);
      setControl(c);
      setCurtailment(cu);
      if (ch !== null) setCharging(ch);
      setNow(Date.now());
    });
  }, LIVE_POLL_MS);

  const model = useMemo(
    () => (data ? plantModel(data.entities, topology, data.localSetup, sources) : null),
    [data, topology, sources],
  );

  const view: GeraetSeiteView | null = useMemo(() => {
    if (!data) return null;
    return geraetSeite({
      ref: geraeteRef,
      geraetId,
      siteName: site.name,
      devices: (devices ?? []).filter((d) => d.siteId === site.id),
      devicesFetchedAt,
      entities: data.entities,
      localSetup: data.localSetup,
      sources,
      components,
      control,
      curtailment,
      edgeVersions,
      charging,
      strategies,
      model,
      now,
    });
  }, [
    data, geraeteRef, geraetId, site.name, site.id, devices, devicesFetchedAt,
    sources, components, control, curtailment, edgeVersions, charging, strategies, model, now,
  ]);

  const box = boxDevice;
  const editRow: SiteComponentRow | null = useMemo(() => {
    if (!view || !geraetId) return null;
    return (components?.components ?? []).find(
      (row) => Boolean(row.templateRef) && (row.edgeSourceId === geraetId
        || view.komponenten.some((component) => component.entityId === row.id)),
    ) ?? null;
  }, [components, geraetId, view]);

  /**
   * Eine OCPP-Säule hat keine Portal-Verbindungsdefinition und deshalb keinen
   * ehrlichen vollständigen Geräte-Editor. Ihr Komponenten-Alias ist trotzdem
   * derselbe universelle Anzeigename wie bei jedem anderen Gerätetyp.
   */
  const chargerRenameTarget: RenameTarget | null = useMemo(() => {
    const chargePointId = chargePointIdOf(geraetId);
    if (!view || view.art !== 'ladepunkt' || !chargePointId) return null;
    const component = view.komponenten.find((row) => row.renameable && row.entityId);
    if (!component) return null;
    return {
      entityId: component.entityId,
      alias: component.alias,
      // Die technische Kennung ist der eindeutige, nie erfundene Rückfall der
      // Säulen-Anzeige. Sie wird gezeigt, aber nicht als Alias gespeichert.
      derivedLabel: chargePointId,
    };
  }, [geraetId, view]);

  /*
   * Der Bearbeiten-Link aus dem Anlagen-Modell führt an DIESEN einen Ort. Der
   * Parameter ist ein einmaliger Eintritt und wird sofort verbraucht, damit
   * Abbrechen/Speichern den Modus nicht durch einen alten Hash erneut öffnen.
   */
  useEffect(() => {
    if (typeof window === 'undefined' || !istGeraetBearbeitenHash(window.location.hash)) return;
    const requestedComponentId = geraetBearbeitenKomponente(window.location.hash);
    if (entitiesLoadedRequest !== pageRequest) return;
    const chargerDataSettled = !chargePointIdOf(geraetId)
      || chargingLoadedRequest === pageRequest;
    const componentDataSettled = componentsLoadedRequest === pageRequest;
    if (!chargerDataSettled) return;
    if (!requestedComponentId && !chargePointIdOf(geraetId) && !componentDataSettled) return;
    const requestedComponent = requestedComponentId
      ? view?.komponenten.find((row) => row.entityId === requestedComponentId && row.renameable)
      : null;
    const requestedTarget: RenameTarget | null = requestedComponent
      ? {
          entityId: requestedComponent.entityId,
          alias: requestedComponent.alias,
          derivedLabel: requestedComponent.derivedLabel,
        }
      : null;
    const componentEdit = !requestedComponentId
      && Boolean(editRow && components?.componentAuthority === 'portal');
    const renameEdit = requestedTarget ?? (!requestedComponentId ? chargerRenameTarget : null);
    setEditNotice(null);
    setEditError(null);
    if (componentEdit) setEditOpen(true);
    else if (renameEdit) setRenameTarget(renameEdit);
    else if (requestedComponentId) {
      setEditError('Diese Komponente ist an diesem Gerät nicht mehr verfügbar.');
    } else if (components === null && !chargePointIdOf(geraetId)) {
      setEditError('Die Bearbeitungsdaten dieses Geräts konnten nicht geladen werden. Versuchen Sie es erneut.');
    } else {
      setEditError('Dieses Gerät kann derzeit nicht im Portal bearbeitet werden.');
    }
    replaceCurrentNavigation(ohneGeraetBearbeiten(window.location.hash));
  }, [
    chargerRenameTarget, chargingLoadedRequest, components, componentsLoadedRequest,
    editRow?.id, entitiesLoadedRequest, geraetId, pageRequest, view,
  ]);

  useEffect(() => {
    if (!editRow) { setVersions([]); return; }
    let active = true;
    api.componentVersions(site.id, editRow.id).then(
      (rows) => active && setVersions(rows),
      () => active && setVersions([]),
    );
    return () => { active = false; };
  }, [editRow?.id, editRow?.definitionVersion, site.id]);

  async function rollback() {
    if (!editRow || !rollbackTarget) return;
    setRollbackBusy(true);
    setEditError(null);
    try {
      const result = await api.rollbackComponent(
        site.id, editRow.id, rollbackTarget.version, editRow.definitionVersion);
      setComponents(result);
      setRollbackTarget(null);
    } catch (cause) {
      setEditError(cause instanceof ApiError ? cause.message : 'Das Zurückrollen ist fehlgeschlagen.');
    } finally {
      setRollbackBusy(false);
    }
  }

  /**
   * Der Verbraucher DIESES Geräts - die Grundlage der §5.4-Zeilen (Erfüllung,
   * D3-Messfähigkeit) UND der Sofortaktion.
   *
   * ⚠ Er steht VOR dem Gesicht, obwohl `consumers` erst geladen wird, wenn das
   * Gesicht die Gattung `verbraucher` gesagt hat: die Gattung hängt an Rolle
   * und Entitätstyp, nie an dieser Liste, also konvergiert es in zwei Läufen -
   * eine Schleife gibt es nicht. Umgekehrt wäre es ein TDZ-Fehler.
   */
  const eigenerVerbraucher = useMemo(() => {
    const ids = new Set((view?.komponenten ?? []).map((c) => c.entityId));
    return consumers.find((c) => ids.has(c.id)) ?? null;
  }, [consumers, view]);

  // ------------------------------------------------------------------
  // Das GESICHT dieser Seite - was oben steht und welche Sektionen folgen.
  // Es entscheidet NUR die Auswahl; jede Sektion bleibt das geteilte Bauteil.
  // ------------------------------------------------------------------
  const gesichtView: Gesicht | null = useMemo(() => {
    if (!view || !view.gefunden) return null;
    const setup = (data?.localSetup ?? []).find((l) => l.id === geraetId);
    const row = (components?.components ?? []).find(
      (r) => r.edgeSourceId === geraetId
        || view.komponenten.some((c) => c.entityId === r.id),
    );
    return gesicht({
      art: view.art,
      geraetId: geraetId ?? geraeteRef,
      rolle: setup?.role ?? null,
      // Das gepflegte SOLL führt, sonst das gemeldete Ist - dieselbe Reihenfolge
      // wie `geraetSeite.verbindungsWeg`, damit die zwei nichts Verschiedenes
      // über denselben Weg annehmen.
      communication: row?.communication ?? setup?.communication ?? null,
      komponenten: view.komponenten,
      entities: data?.entities ?? null,
      src: (sources ?? []).find((s) => s.sourceId === geraetId) ?? null,
      charger: chargePointIdOf(geraetId)
        ? (charging?.chargers ?? []).find(
            (c) => c.chargePointId === chargePointIdOf(geraetId),
          ) ?? null
        : null,
      // ⚠ Die `eigenerBeleg`-Regel: ein Steuerungs-Beleg gehört dem Gerät, das
      // ihn GEMELDET hat - sonst wäre die Zuschreibung erfunden.
      control: control && box?.id && control.deviceId === box.id ? control : null,
      curtailment,
      regeln: regelNamenOf(strategies, view.komponenten),
      // §5.1/§5.3/§5.8: die EINZIGE Quelle mit einem Wert JE KANAL - die
      // Batterieleistung des Hybriden, der Relais-Zustand eines Schalters und
      // die selbst definierten Kanäle des Eigenbaus.
      topologie: topology?.entities ?? null,
      // P6: der SPEICHER-KNOTEN trägt als einziger, WOHER der Ladestand kommt
      // und was das BMS zulässt - beides muss nicht von diesem Gerät stammen.
      speicherKnoten: topology?.topology.nodes.find((n) => n.role === 'storage') ?? null,
      // §5.4: WÖRTLICH die geteilte Erfüllungs-Kopfzeile bzw. die geteilte
      // D3-Regel - ein zweites Urteil hier wäre eine zweite Wahrheit.
      erfuellung: fulfilment ? fulfilmentSummary(fulfilment).headline : null,
      gemessen: eigenerVerbraucher ? consumerHasMeasurement(eigenerVerbraucher) : null,
      // P8: die dritte Nachweisart, die ein Boolean nicht kennt - eine
      // SG-Ready-Wärmepumpe wird FREIGEGEBEN, nicht gemessen.
      nachweis: eigenerVerbraucher ? consumerNachweis(eigenerVerbraucher) : null,
      now,
    });
  }, [view, data, components, sources, charging, control, curtailment, strategies,
    topology, fulfilment, eigenerVerbraucher, geraetId, geraeteRef, box?.id, now]);

  /**
   * Die Katalog-Familien DIESES Geräts - der Filter der Messbibliothek
   * (Stufe 0, §7.3). Dieselbe Soll-vor-Ist-Reihenfolge wie `communication`
   * oben; ein Ladepunkt spricht per Konstruktion OCPP.
   */
  const messFamilien = useMemo<string[] | null>(() => {
    if (!view || !view.gefunden) return [];
    const setup = (data?.localSetup ?? []).find((l) => l.id === geraetId);
    const row = (components?.components ?? []).find(
      (r) => r.edgeSourceId === geraetId
        || view.komponenten.some((c) => c.entityId === r.id),
    );
    const familien = geraetFamilien({
      soll: row?.family ?? null,
      ist: setup?.family ?? null,
      ladepunkt: gesichtView?.gattung === 'ladepunkt',
    });
    // ⚠ Kennt niemand die Familie des PRIMÄREN Wechselrichters, fällt die
    // Fläche auf die Box-Semantik zurück (`null`) statt die Sektion zu
    // verstecken: die Familien-Vereinigung der Box IST auf dieser einen Seite
    // die richtige Antwort - genau deshalb sah der Fehler dort ja korrekt aus.
    // Auf jedem anderen Gerät bleibt es bei der Ausblende-Regel.
    if (familien.length === 0 && geraetId === 'inverter') return null;
    return familien;
  }, [view, data, components, geraetId, gesichtView]);

  // Die drei Gattungs-eigenen Sektionen - abgeleitet aus dem, was schon
  // geladen ist; jede Zeile nennt ihren Grund, keine wird erfunden.
  const grenzen: Zeile[] = useMemo(
    () => grenzenZeilen(view, curtailment, data?.entities ?? null),
    [view, curtailment, data],
  );
  const einspeiseZeilen: Zeile[] = useMemo(
    () => einspeiseSektion(curtailment, geraetId, now),
    [curtailment, geraetId, now],
  );
  const ausfallschutz: Zeile[] = useMemo(
    () => ausfallschutzZeilen(charging),
    [charging],
  );
  const ladepark: Zeile[] = useMemo(
    () => ladeparkZeilen(charging, geraetId),
    [charging, geraetId],
  );
  // ------------------------------------------------------------------
  // DER RAHMEN (Geräteseiten Stufe 1, Konzept §4)
  //
  // Das GESICHT entscheidet weiterhin, WELCHE Sektion es gibt; der Rahmen,
  // WO sie steht - die Ordnung ist auf jeder Geräteseite dieselbe. Vier
  // Gattungs-Sektionen gehen dabei in „Steuerung & Grenzen" auf, und der
  // Technik-Aufklapper des Software-Kastens wird eine eigene Sektion.
  // ------------------------------------------------------------------

  /** Ohne Kachel UND ohne Satz gibt es keinen Helden (die `HeldKarte`-Regel). */
  const heldTraegt = Boolean(
    gesichtView && (gesichtView.held.kacheln.length > 0 || gesichtView.held.satz),
  );
  /**
   * Ein Gerät ohne Modbus-Register kann trotzdem MESSWERTE beobachten (D3):
   * dann gibt es die Sektion, sie heißt nur anders. Ist auch das nichts, ist
   * sie strukturell leer und ihr Grund zieht in die Diagnose (§4.6).
   */
  const hatMessbibliothek = Boolean(
    view?.gefunden && (messFamilien == null || messFamilien.length > 0),
  );
  const registerSektion = Boolean(gesichtView?.sektionen.includes('register'));
  /**
   * Die Messbibliothek hängt am TRANSPORT der Box (dort wohnt die Selektion),
   * zeigt aber den Katalog DIESES Geräts (Stufe 0, §7.4 3a). Sie ist seit dem
   * Rahmen ein KNOTEN, weil sie in die Register-Sektion gehört (§4.4 Zeile 5)
   * - und auf dem Ladepunkt-Pfad in dessen eigene Messwert-Sektion.
   */
  const beobachtung = view?.gefunden ? (
    <BeobachteteRegister
      deviceId={boxDevice?.id}
      siteId={site.id}
      entityId={editRow?.id}
      familien={messFamilien ?? undefined}
      eigeneErlaubt={geraetId === 'inverter'}
      registerFaehig={registerSektion}
      geraetName={view.kopf.titel}
      lesbar={beobachtenMoeglich({ geraetId, familien: messFamilien ?? [] })}
      bruecke={bruecke}
      onBrueckeVerbraucht={brueckeVerbraucht}
      onKurzfassung={setBeobKurz}
    />
  ) : null;

  // ------------------------------------------------------------------
  // Sektion 2 · Befehle (Geräteseiten Stufe 2, Konzept §6)
  //
  // Der Server entscheidet, was zu diesem Gerät gehört (`?device=`) - die
  // Fläche schneidet nichts selbst zurecht. Der Haken lädt dieselbe Liste wie
  // die Befehle-Seite; gepollt wird hier NICHT (die Seite hat ihren eigenen
  // 30-s-Takt, ein zweiter daneben wäre doppelte Last).
  // ------------------------------------------------------------------
  const verlauf = useBefehleVerlauf({
    siteId: site.id, geraetRef: geraetId ?? geraeteRef,
  });
  const letzteZeile = useMemo(() => neuesteZeile(verlauf.view), [verlauf.view]);

  /**
   * Was dieses Blatt ABSETZEN kann (§6.2) - fail-soft und GATTUNGS-GETAKTET:
   * ein Zähler oder ein PV-Melder bezahlt die drei Abrufe nie, weil seine
   * Aktionszeile ohnehin leer bliebe.
   *
   * ⚠ Er hängt an der GATTUNG, nicht am Gerät: sie steht erst fest, wenn der
   * eine tragende Abruf zurück ist - deshalb ein EIGENER Effekt neben dem
   * Haupt-Abruf, kein zweiter Zweig darin.
   */
  const gattung = gesichtView?.gattung ?? null;
  const brauchtSpeicher = gattung === 'wechselrichter-speicher';
  const brauchtVerbraucher = gattung === 'verbraucher' || gattung === 'geraet';
  useEffect(() => {
    if (!brauchtSpeicher && !brauchtVerbraucher) return undefined;
    let active = true;
    const soft = <T,>(p: Promise<T>, set: (v: T) => void, leer: T) => {
      void p.then(
        (v) => { if (active) set(v); },
        () => { if (active) set(leer); },
      );
    };
    if (brauchtSpeicher) {
      soft(api.siteInterventions(site.id), setInterventions, null);
      // Der Fahrplan trägt den PLAN-VERZICHT der Folgen-Karte. Ohne ihn sagt
      // sie ehrlich „nicht abschätzbar" - eine Zahl wird nie erfunden.
      soft(api.schedule(site.id), setPlan, null);
    }
    if (brauchtVerbraucher) {
      soft(consumersApi.list(site.id), setConsumers, []);
      soft(consumersApi.overrides(site.id), setOverrides, []);
    }
    return () => { active = false; };
  }, [site.id, brauchtSpeicher, brauchtVerbraucher, reloadKey]);

  /**
   * Die Erfüllung DIESES Verbrauchers (§5.4). Eigener Effekt, weil sie an der
   * Verbraucher-KENNUNG hängt, nicht an der Anlage - und fail-soft wie jeder
   * Neben-Abruf: ohne sie fehlt die Zeile, die Seite bleibt.
   */
  useEffect(() => {
    const id = eigenerVerbraucher?.id;
    if (!id) { setFulfilment(null); return undefined; }
    let active = true;
    void consumersApi.fulfillment(site.id, id).then(
      (v) => { if (active) setFulfilment(v); },
      () => { if (active) setFulfilment(null); },
    );
    return () => { active = false; };
  }, [site.id, eigenerVerbraucher?.id, reloadKey]);

  /**
   * Der Register-Zugang DIESES Geräts - er entscheidet, ob die Aktionszeile
   * „Register schreiben" anbietet UND ob die Register-Sektion ihren Knopf
   * zeigt. Er wird EINMAL hier gerechnet: zwei Ableitungen könnten über
   * denselben Schreibweg Verschiedenes behaupten.
   *
   * ⚠ `targets == null` heisst „lädt noch" - dann wird NICHTS behauptet, weder
   * ein Weg noch sein Fehlen.
   */
  const zugang: GeraetRegisterZugang = useMemo(() => {
    if (!view?.gefunden) return { moeglich: false, grund: null, vorwahl: null, weg: null };
    if (targets == null) return { moeglich: false, grund: null, vorwahl: null, weg: null };
    if (!box?.id) return { moeglich: false, grund: KEIN_SCHREIBWEG, vorwahl: null, weg: null };
    return geraetRegisterZugang(targets, {
      art: view.art,
      deviceId: box.id,
      entityIds: view.komponenten.map((c) => c.entityId),
    });
  }, [view, targets, box?.id]);

  /**
   * Die AKTIONSZEILE über dem Verlauf (§6.2). Sie LÖST nur aus - geöffnet wird
   * jeweils der BESTEHENDE Dialog, es entsteht kein zweiter Auslöse-Pfad.
   *
   * ⚠ Was der Zustand nicht hergibt, wird nicht angeboten: die
   * Speicher-Handlungen kommen aus `speicherAktionen`, die Geräte-Handlungen
   * aus `sofortAktionen`, der Register-Weg aus dem Zugang oben.
   */
  const aktionen = useMemo(() => {
    if (!gesichtView) return [];
    const strip = control && box?.id && control.deviceId === box.id
      ? controlStrip(control, new Date(now))
      : null;
    return aktionsZeile({
      gattung: gesichtView.gattung,
      speicher: speicherAktionen({
        laufend: (interventions?.interventions ?? []).some((i) => i.entityId != null),
        // Steuerbar heisst: das Rücklesen dieses Geräts trägt wirklich - genau
        // die Bedingung, mit der auch die Jetzt-Zone der Steuerung urteilt.
        steuerbar: strip?.state === 'healthy' || strip?.state === 'mismatch',
        pausiert: interventions?.automationPaused === true,
      }),
      verbraucher: eigenerVerbraucher
        ? sofortAktionen({
            connected: eigenerVerbraucher.connection === 'connected',
            hasOverride: overrides.some((o) => o.entityId === eigenerVerbraucher.id),
          })
        : [],
      registerMoeglich: zugang.moeglich,
    });
  }, [gesichtView, control, box?.id, now, interventions, eigenerVerbraucher, overrides, zugang]);

  /**
   * Der EINE Auslöser der Aktionszeile. Er ÖFFNET nur - gehandelt wird in dem
   * Dialog, den die jeweilige Handlung schon hat (kein zweiter Auslöse-Pfad).
   */
  const aktionAusloesen = useCallback((a: VerlaufAktion) => {
    if (a.art === 'register') setRegOffen(true);
    else if (a.art === 'speicher') setHand(a.wert as HandeingriffAktion);
    else if (a.art === 'verbraucher' && eigenerVerbraucher) {
      setEingriff({ consumer: eigenerVerbraucher, aktion: a.wert as SofortAktion });
    }
  }, [eigenerVerbraucher]);

  /**
   * Die Folgen-Karte des Speicher-Eingriffs - dieselbe Komposition wie in der
   * Jetzt-Zone der Steuerung (`handeingriffFolgen`), damit die zwei Flächen
   * über dieselbe Handlung nichts Verschiedenes versprechen.
   */
  const handEnde = useCallback((key: string) => {
    const gewaehlt = DAUERN.find((d) => d.key === key) ?? DAUERN[2];
    return endeVon(gewaehlt, new Date(now));
  }, [now]);

  const handFolgen = useMemo(() => {
    if (!hand) return null;
    const ende = handEnde(handDauer);
    return handeingriffFolgen({
      aktion: hand,
      endeText: `${ende.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr`,
      // ⚠ Ladestand und Ladeleistung stehen auf DIESER Fläche nicht belegt zur
      // Verfügung - die Karte lässt die Klammern weg, statt eine Zahl zu
      // erfinden (wörtlich die Regel der Jetzt-Zone).
      socPct: null,
      leistungKw: null,
      verzicht: planVerzicht(plan?.slots ?? null, new Date(now), ende),
    });
  }, [hand, handDauer, handEnde, plan, now]);

  const handBestaetigen = useCallback(async (minutes: number | null) => {
    if (!hand) return;
    setAktionBusy(true);
    try {
      // ⚠ „bis morgen früh" reist als absolutes ENDE, jede andere Dauer als
      // Minuten - genau das, was der Server erwartet.
      const body = minutes == null
        ? { endsAt: handEnde(handDauer).toISOString() }
        : { durationMinutes: minutes };
      if (hand === 'resume') await api.clearBatteryOverride(site.id);
      else {
        await api.startBatteryOverride(site.id,
          { kind: hand as 'speicher_laden' | 'speicher_halten', ...body });
      }
      setReloadKey((k) => k + 1);
    } catch {
      // Ein abgelehnter Eingriff lässt die Seite stehen, wie sie war - nie ein
      // Schein-Erfolg.
    } finally {
      setAktionBusy(false);
      setHand(null);
    }
  }, [hand, handDauer, handEnde, site.id]);

  const eingriffBestaetigen = useCallback(async (minuten?: number) => {
    if (!eingriff) return;
    setAktionBusy(true);
    try {
      if (eingriff.aktion === 'resume') {
        await consumersApi.clearOverride(site.id, eingriff.consumer.id);
      } else {
        await consumersApi.startOverride(site.id, eingriff.consumer.id, {
          action: eingriff.aktion,
          durationMinutes: minuten,
        });
      }
      setReloadKey((k) => k + 1);
    } catch {
      // Wie oben: nie ein Schein-Erfolg.
    } finally {
      setAktionBusy(false);
      setEingriff(null);
    }
  }, [eingriff, site.id]);

  const rahmenView = useMemo(() => {
    if (!view?.gefunden || !gesichtView) return rahmen([]);
    const hat = (id: SektionId) => gesichtView.sektionen.includes(id);
    // ⚠ Der Grund einer entfallenen Sektion wird NICHT hier formuliert - das
    // Gesicht hat ihn schon gesagt (§4.6: er verschwindet nie, er zieht um).
    const entfallGrund = (id: RahmenSektionId) =>
      gesichtView.entfallen.find((e) => e.id === id)?.grund ?? null;
    const letzte = letzteZeile;
    const angebote: (SektionAngebot | null)[] = [
      heldTraegt ? { id: GESICHT_ZU_RAHMEN.jetzt, ton: view.kopf.zustand.ton } : null,
      hat('befehle')
        ? {
          id: GESICHT_ZU_RAHMEN.befehle,
          ton: letzte?.ton === 'warn' ? 'warn' : null,
          // ⚠ Ohne Zeile steht der Grund im KÖRPER - ihn hier zu wiederholen
          // wäre dieselbe Aussage zweimal auf einer Karte (die Haus-Regel).
          kurzfassung: letzte ? kurz(`zuletzt ${letzte.zeit}`, letzte.urteil) : null,
        }
        : { id: 'befehle', entfaellt: true, grund: entfallGrund('befehle') },
      // ⚠ „Steuerung & Grenzen" gibt es seit Stufe 4 NICHT mehr immer: ein
      // Zähler wird von niemandem gesteuert und trägt keine Grenze, die Sektion
      // erklärte dort nur ihre eigene Nicht-Zuständigkeit (§4.6). Entschieden
      // wird das im Gesicht - der Grund zieht mit in die Diagnose.
      gesichtView.steuerung
        ? {
          id: 'steuerung',
          kurzfassung: kurz(
            view.kopf.steuerAbzeichen,
            grenzen.length > 0 ? `${grenzen.length} Grenzen` : null,
          ),
        }
        : { id: 'steuerung', entfaellt: true, grund: entfallGrund('steuerung') },
      hat('komponenten')
        ? {
          id: GESICHT_ZU_RAHMEN.komponenten,
          kurzfassung: view.komponenten.length > 0
            ? `${view.komponenten.length} Komponente${view.komponenten.length === 1 ? '' : 'n'}`
            : null,
        }
        : null,
      registerSektion || hatMessbibliothek
        ? {
          id: 'register',
          // D3: „Register" wäre an einem HTTP-Gerät das falsche Wort, die
          // Fähigkeit ist es nicht.
          titel: registerSektion ? null : 'Messwerte',
          // ⚠ Die Beobachtungs-Kurzfassung kommt aus der Fläche, die sie kennt
          // (Stufe 3a); ohne eine einzige Beobachtung bleibt es beim Angebot.
          kurzfassung: beobKurz
            ?? (registerSektion ? 'lesen · beobachten · schreiben' : 'beobachten'),
        }
        : { id: 'register', entfaellt: true, grund: entfallGrund('register') },
      hat('verbindung')
        ? {
          id: GESICHT_ZU_RAHMEN.verbindung,
          ton: view.kopf.zustand.ton,
          kurzfassung: view.verbindung.length > 0
            ? kurz(...view.verbindung.slice(0, 2).map((z) => z.wert))
            : null,
        }
        : null,
      hat('software')
        ? {
          id: GESICHT_ZU_RAHMEN.software,
          kurzfassung: view.software.length > 0 ? view.software[0].wert : null,
        }
        : { id: 'software', entfaellt: true, grund: entfallGrund('software') },
      view.diagnose.length > 0
        ? { id: 'diagnose', kurzfassung: `${view.diagnose.length} Angaben` }
        : null,
      showTechnicalLayer() && adminView ? { id: 'plattform' } : null,
    ];
    return rahmen(angebote);
  }, [
    view, gesichtView, heldTraegt, letzteZeile, grenzen, registerSektion,
    hatMessbibliothek, adminView, beobKurz,
  ]);

  /**
   * Der EINE Kopf-Hinweis (§4.1 Zeile 3): der schlimmste anstehende Befund.
   *
   * ⚠ Jeder Satz kommt WÖRTLICH aus seiner geteilten Ableitung - der Rahmen
   * formuliert keinen, er WÄHLT nur den schlimmsten und verlinkt seine Sektion.
   */
  const hinweis = useMemo(() => {
    const waechter = exportGuardView(curtailment, new Date(now));
    const befunde: (Befund | null)[] = [
      // ⚠ Der Rücklese-Satz kommt WÖRTLICH aus `control.controlStrip` - der
      // Ableitung, die auch die Cockpit-Karte rendert; ein zweiter wäre ein
      // Zwilling, der abdriftet. Und der Beleg gehört dem Gerät, das ihn
      // GEMELDET hat (die `eigenerBeleg`-Regel).
      (() => {
        if (!control || !box?.id || control.deviceId !== box.id) return null;
        const strip = controlStrip(control, new Date(now));
        return strip?.state === 'mismatch'
          ? { art: 'ruecklesen' as const, satz: strip.sentence, ton: 'warn' as const }
          : null;
      })(),
      waechter?.tone === 'warn' ? { art: 'waechter', satz: waechter.line, ton: 'warn' } : null,
      view?.art === 'hauptgeraet'
        ? (() => {
          const satz = deviceLimitLine(curtailment);
          return satz ? { art: 'grenze' as const, satz, ton: 'warn' as const } : null;
        })()
        : null,
    ];
    return kopfHinweis(befunde, rahmenView.sektionen.map((s) => s.id));
  }, [control, curtailment, box?.id, view?.art, now, rahmenView]);

  /**
   * Die angesprungene Kachel (§5.3) - sie kommt als PARAMETER im Hash, nie als
   * zweites `#` (der HashRouter läse es als Route). Gelesen wird beim Aufbau
   * UND bei jedem Hash-Wechsel, wie der Abschnitts-Sprung des Rahmens: ein
   * Klick aus einer schon offenen Seite muss ebenfalls wirken.
   */
  const [angesprungeneKachel, setAngesprungeneKachel] = useState<string | null>(
    () => (typeof window === 'undefined' ? null : parseKachel(window.location.hash)),
  );
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const lesen = () => setAngesprungeneKachel(parseKachel(window.location.hash));
    lesen();
    window.addEventListener('hashchange', lesen);
    return () => window.removeEventListener('hashchange', lesen);
  }, []);

  /**
   * Der HILFETEXT dieses Blatts (§5.4): eine Wärmepumpe ist ein schaltbarer
   * Verbraucher - das steht als Satz da, nie als Titel (Captain-Entscheid).
   */
  const hinweisSatz = useMemo(() => {
    if (!view?.gefunden || !gesichtView) return null;
    return blattHinweis(gesichtView, {
      komponenten: view.komponenten,
      entities: data?.entities ?? null,
    });
  }, [view, gesichtView, data]);

  /**
   * Die PRIMÄRE Handlung des Verbraucher-Blatts (§5.4). Sie steht im JETZT,
   * damit sie nicht erst hinter der Aktionszeile auftaucht - und sie ist
   * dieselbe, die die Zeile darunter anbietet (kein zweiter Auslöse-Pfad).
   */
  const heldAktion = useMemo(() => {
    if (gesichtView?.gattung !== 'verbraucher') return null;
    const erste = aktionen.find((a) => a.art === 'verbraucher');
    if (!erste) return null;
    return { text: erste.label, onClick: () => aktionAusloesen(erste) };
  }, [gesichtView, aktionen, aktionAusloesen]);

  /**
   * Die GEFAHRENZONE dieses Geräts (vp-loeschen-konzept-l3, E4): ihr Zustand ist
   * eine reine Ableitung aus den Komponenten des Geräts und ihren Entitäten -
   * löschbar, geschützter Speicher (mit Weg) oder Grundausstattung ohne Weg.
   * Nie für die Box selbst oder eine Ladesäule (die haben hier keine eine
   * Aktion). Der Name zum Bestätigen ist der der Komponente, sonst des Geräts.
   */
  const gefahr = useMemo(() => {
    if (!view || !view.gefunden || view.art === 'ladepunkt') return null;
    return gefahrenzone(view.komponenten, (id) => data?.entities.find((e) => e.id === id), pvZugeordnet);
  }, [view, data, pvZugeordnet]);
  const gefahrName =
    gefahr?.kind === 'entfernen' ? gefahr.component.label : view?.kopf.titel ?? '';

  /**
   * Die Entität, mit der der Summenwert-Assistent „PV-Produktion dieses Geräts"
   * startet (Konzept vp-agg-konzept3-r8, Fix (b)): bevorzugt der PV-Aspekt, sonst
   * - wenn das Gerät nachweislich Erzeugung meldet - die Träger-Entität (Speicher
   * des Hybriden, sonst die eindeutige Haupt-Komponente). `null` heißt: kein Knopf,
   * weil das Gerät nichts erzeugt (das „nie ein toter Knopf"-Prinzip, aber auch
   * nie „gar kein Knopf" für genau ein erzeugendes Gerät ohne PV-Komponente).
   */
  const erzeugungEntityId = useMemo(
    () => (view?.gefunden ? pvEinstiegEntityId(view) : null),
    [view],
  );

  // Die PV-Rollen-Zuordnung dieses Geräts - für die Gefahrenzonen-Folge und den
  // Karten-Zustand; sie hängt an genau der Entität, mit der die Karte startet.
  useEffect(() => {
    let aktiv = true;
    if (!erzeugungEntityId) {
      setPvZugeordnet(false);
      return;
    }
    api.geraetRolle(site.id, erzeugungEntityId, 'pv').then(
      (r) => aktiv && setPvZugeordnet(r.zugeordnet != null),
      () => aktiv && setPvZugeordnet(false),
    );
    return () => {
      aktiv = false;
    };
  }, [erzeugungEntityId, site.id, pvReload]);

  return (
    <div className="vp-geraet">
      {/* GENAU EIN Rückweg (Stufe 0, §2.1/§4.2): der Knopf „Anlage {Name}" und
          die Bereichs-Reiter stehen über einer Geräteseite nicht mehr. Der
          RAHMEN trägt sie im gefundenen Fall selbst - hier steht sie nur über
          den Lade-/Fehler-/Leer-Zuständen, damit auch die einen Rückweg haben. */}
      {gesichtView?.gattung !== 'ladepunkt' && !(view && view.gefunden) && (
        <GeraetBrotkrume
          anlageHref={hashForRoute(anlageRoute(site.id))}
          komponentenHref={hashForRoute(anlageRoute(site.id, 'modell'))}
          titel={view?.gefunden ? view.kopf.titel : 'Gerät'}
        />
      )}

      {!data && !error && (
        <Card padding="lg" radius="lg">
          <TextSkeleton lines={6} />
        </Card>
      )}
      {error && (
        <Card padding="lg" radius="lg">
          <ErrorState
            message="Dieses Gerät konnte nicht geladen werden."
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        </Card>
      )}

      {editNotice && !editOpen && !renameTarget && (
        <div className="vp-alert vp-alert-ok" role="status">
          <Icon name="check" size={16} /> {editNotice}
        </div>
      )}

      {editError && !editOpen && !renameTarget && (
        <div className="vp-alert vp-alert-err" role="alert">{editError}</div>
      )}

      {view && !view.gefunden && (
        <Card padding="lg" radius="lg">
          <EmptyState
            icon="cpu"
            category="primary"
            title="Dieses Gerät ist hier nicht (mehr) zu finden"
            description={view.grund ?? ''}
          />
        </Card>
      )}

      {view && view.gefunden && gesichtView?.gattung === 'ladepunkt' && chargePointIdOf(geraetId) && !renameTarget && (
        <OcppWallboxPage
          siteId={site.id}
          chargePointId={chargePointIdOf(geraetId) as string}
          fallbackTitle={view.kopf.titel}
          backHref={hashForRoute(anlageRoute(site.id, 'modell'))}
          siteHref={hashForRoute(anlageRoute(site.id))}
          settingsHref={hashForRoute(anlageRoute(site.id, 'ladevorgaenge'))}
          charger={(charging?.chargers ?? []).find(
            (item) => item.chargePointId === chargePointIdOf(geraetId),
          ) ?? null}
          onRename={chargerRenameTarget ? () => {
            setEditNotice(null);
            setEditError(null);
            setRenameTarget(chargerRenameTarget);
          } : undefined}
          messwerte={beobachtung}
        />
      )}

      {view && view.gefunden && renameTarget && (
        <>
          <GeraetBrotkrume
            anlageHref={hashForRoute(anlageRoute(site.id))}
            komponentenHref={hashForRoute(anlageRoute(site.id, 'modell'))}
            titel={`${view.kopf.titel} bearbeiten`}
          />
          <UmbenennenDialog
            key={`rename:${site.id}:${renameTarget.entityId}`}
            inline
            siteId={site.id}
            siteName={site.name}
            geraetKennung={view.kopf.kennung || geraetId || undefined}
            target={renameTarget}
            onClose={() => setRenameTarget(null)}
            onSaved={() => {
              setRenameTarget(null);
              setEditError(null);
              setEditNotice('Anzeigename gespeichert. Verbindung und Steuerung bleiben unverändert.');
              setReloadKey((key) => key + 1);
            }}
          />
        </>
      )}

      {view && view.gefunden && gesichtView?.gattung !== 'ladepunkt' && editOpen && !renameTarget && editRow && (
        <>
          <GeraetBrotkrume
            anlageHref={hashForRoute(anlageRoute(site.id))}
            komponentenHref={hashForRoute(anlageRoute(site.id, 'modell'))}
            titel={`${view.kopf.titel} bearbeiten`}
          />
          <AnlegenFlow
            key={`edit:${site.id}:${editRow.id}`}
            siteId={site.id}
            box={boxDevice}
            bearbeiten={editRow}
            inlineBearbeitung
            siteName={site.name}
            geraetKennung={view.kopf.kennung || geraetId}
            onClose={() => setEditOpen(false)}
            onSaved={(result) => {
              const gespeichert = result.components.find((row) => row.id === editRow.id);
              setComponents(result);
              setData(null);
              setEditOpen(false);
              setEditError(null);
              setEditNotice(gespeichert?.syncStatus === 'in_sync'
                ? 'Änderungen gespeichert und auf der Box aktiv.'
                : 'Änderungen als neue Fassung gespeichert. Die bisherige Fassung läuft bis zur Bestätigung weiter.');
              setReloadKey((key) => key + 1);
            }}
          />
        </>
      )}

      {view && view.gefunden && gesichtView?.gattung !== 'ladepunkt' && !editOpen && !renameTarget && (
        <GeraetRahmen
          testId="geraet-rahmen"
          geraetKey={`${site.id}:${geraetId ?? geraeteRef}`}
          view={rahmenView}
          brotkrume={{
            anlageHref: hashForRoute(anlageRoute(site.id)),
            komponentenHref: hashForRoute(anlageRoute(site.id, 'modell')),
          }}
          kopf={{
            titel: view.kopf.titel,
            gattungWort: view.kopf.unterzeile,
            kennung: view.kopf.kennung,
            zustand: view.kopf.zustand,
            hinweis,
            abzeichen: (
              <>
                {view.kopf.steuerAbzeichen && (
                  <span className="vp-geraet-ctrl">
                    <Icon name="zap" size={13} /> {view.kopf.steuerAbzeichen}
                  </span>
                )}
                {view.kopf.pflegeOrt && (
                  <span className="vp-pill vp-pill-info">{view.kopf.pflegeOrt}</span>
                )}
              </>
            ),
          }}
          aktionen={(
            <>
              {components?.componentAuthority === 'portal' && editRow && (
                <button type="button" className="vp-btn vp-btn--outline vp-btn--md" onClick={() => {
                  setEditNotice(null);
                  setEditError(null);
                  setEditOpen(true);
                }}>
                  <Icon name="pencil" size={15} /> Bearbeiten
                </button>
              )}
            </>
          )}
          unterKopf={editRow ? (
            <details className="vp-geraet-versionen">
              <summary>
                Fassung {editRow.definitionVersion} · {
                  editRow.syncStatus === 'in_sync' ? 'auf der Box aktiv'
                    : editRow.syncStatus === 'pending' ? 'Aktivierung läuft'
                      : 'Bestätigung der Box ausstehend'
                }
              </summary>
              {components?.refusedReason && (
                <p className="vp-assist-error" role="alert">
                  Die Box hat die neue Fassung abgelehnt: {components.refusedReason}. Die vorige Fassung läuft weiter.
                </p>
              )}
              <p>Jede Änderung ist eine neue Fassung. Eine Rückkehr schreibt wiederum eine neue Fassung; nichts wird gelöscht.</p>
              <div className="vp-geraet-version-list">
                {versions.filter((version) => version.version < editRow.definitionVersion).slice(0, 4).map((version) => (
                  <button key={version.version} type="button" className="vp-btn vp-btn--outline vp-btn--sm" onClick={() => setRollbackTarget(version)}>
                    Fassung {version.version} zurückholen
                  </button>
                ))}
              </div>
              {editError && <p className="vp-assist-error" role="alert">{editError}</p>}
            </details>
          ) : null}
        >
          {/* 1 · Jetzt - ohne Klapp-Kopf (§4.5). */}
          <RahmenSektion id="jetzt">
            {gesichtView && (
              <HeldKarte
                held={gesichtView.held}
                stand={view.liveStand}
                markiert={angesprungeneKachel}
                aktion={heldAktion}
              />
            )}
            {editRow?.entityType === 'io-module' && (
              <IoModulBlock siteId={site.id} entityId={editRow.id} now={now} />
            )}
          </RahmenSektion>

          {/* Alle Summenwerte, deren aktuelle Formel dieses physische Gerät liest. */}
          {summenwertEinstieg(view) && boxDevice?.id && geraetId && (
            <GeraetSummenwerte
              siteId={site.id}
              deviceId={boxDevice.id}
              entityId={summenwertEinstieg(view)!}
              entityIds={[...new Set(view.komponenten.map(k => k.entityId))]}
              geraetName={view.kopf.titel}
              geraetId={geraetId}
              onZuordnungGeaendert={() => setPvReload((x) => x + 1)}
            />
          )}

          {/* 2 · Befehle */}
          <RahmenSektion id="befehle">
            <BefehleSektion
              siteId={site.id}
              geraetRef={geraetId ?? geraeteRef}
              state={verlauf}
              aktionen={aktionen}
              onAktion={aktionAusloesen}
            />
          </RahmenSektion>

          {/* 3 · Steuerung & Grenzen - VIER frühere Sektionen gehen hier auf. */}
          <RahmenSektion id="steuerung">
            {gesichtView?.sektionen.includes('grenzen') && (
              <Block titel="Grenzen dieses Geräts" icon="shield">
                <ZeilenListe zeilen={grenzen} />
              </Block>
            )}
            {gesichtView?.sektionen.includes('einspeise') && (
              <Block titel="Einspeise-Begrenzung" icon="shield">
                <ZeilenListe zeilen={einspeiseZeilen} />
              </Block>
            )}
            {gesichtView?.sektionen.includes('ausfallschutz') && (
              <Block titel="Ausfall-Schutz" icon="shield">
                <ZeilenListe zeilen={ausfallschutz} />
              </Block>
            )}
            {gesichtView?.sektionen.includes('ladepark') && (
              <Block titel="Diese Säule im Ladepark" icon="zap">
                <ZeilenListe zeilen={ladepark} />
                <p className="vp-geraet-sec-sub">
                  <a href={hashForRoute(anlageRoute(site.id, 'ladevorgaenge'))}>
                    Ladevorgänge dieser Anlage ansehen →
                  </a>
                </p>
              </Block>
            )}
            <Block titel="Steuerungs-Bezüge" icon="shield">
              {/* ⚠ Der Einspeise-Wächter steht dort, wo die Gattung ihn führt -
                  nie zweimal auf einem Bildschirm (im Browser aufgefallen). */}
              <ZeilenListe zeilen={view.steuerung.filter(
                (z) => !(gesichtView?.sektionen.includes('einspeise')
                  && z.label === WAECHTER_LABEL),
              )} />
              {hinweisSatz && <p className="vp-note">{hinweisSatz}</p>}
              <p className="vp-geraet-sec-sub">
                <a href={hashForRoute(anlageRoute(site.id, 'steuerung'))}>
                  Regeln und Betriebsmodelle dieser Anlage ansehen →
                </a>
              </p>
            </Block>
          </RahmenSektion>

          {/* 4 · Komponenten */}
          <RahmenSektion id="komponenten">
            {view.komponentenLeer && <p className="vp-note">{view.komponentenLeer}</p>}
            {view.komponenten.length > 0 && (
              <ul className="vp-geraet-komps">
                {view.komponenten.map((c) => (
                  <KomponentenZeile key={c.id} komponente={c} siteId={site.id} />
                ))}
              </ul>
            )}
            {/* ⚠ Der BMS-Block steht NUR da, wenn eine Batterie per CAN an
                diesem Gerät hängt (P4) - sonst gar nicht. Ein Kasten, der
                erklärt, dass er nichts weiß, ist genau die Wand, die dieser
                Rahmen beendet; und eine 0 wäre eine Messung, die niemand
                gemacht hat. */}
            {view.bms.length > 0 && (
              <Block titel="BMS" icon="battery">
                <p className="vp-note">
                  Diese Werte meldet der Wechselrichter über die Batterie, die per CAN an ihm
                  angemeldet ist - er misst sie nicht selbst.
                </p>
                <ZeilenListe zeilen={view.bms} />
              </Block>
            )}
            {/* Das ÄNDERUNGSPROTOKOLL dieses Geräts (UEMS AP-04 IP-21): was sich
                an seinen Quellen, seinen Einstellungen und seinem Ein- und Ausbau
                geändert hat. Es steht HIER, weil genau diese Sektion sagt, was das
                Gerät misst und steuert. Ohne auflösbares UEMS-Gerät rendert es
                gar nichts - dieselbe Regel wie der BMS-Block darüber. */}
            <GeraetProtokoll
              siteId={site.id}
              entityIds={view.komponenten.map((c) => c.entityId)}
            />
          </RahmenSektion>

          {/* 5 · Register - Lesen, Beobachten und Schreiben an EINEM Ort. */}
          <RahmenSektion id="register">
            {/* 1+2 · Beobachtete Register und der Katalog DIESES Geräts. */}
            {beobachtung}
            {/* 3 · Lesen und Schreiben - mit der Brücke „Beobachten" je Lesung. */}
            {registerSektion && (
              <RegisterSektion
                onBeobachten={setBruecke}
                siteId={site.id}
                boxDeviceId={box?.id ?? null}
                geraetName={view.kopf.titel}
                art={view.art}
                entityIds={view.komponenten.map((c) => c.entityId)}
                targets={targets}
                zugang={zugang}
                offen={regOffen}
                setOffen={setRegOffen}
                exportLimit={view.art === 'hauptgeraet'
                  ? curtailment?.deviceExportLimit ?? null
                  : null}
                writes={writes}
                source={(sources ?? []).find((s) => s.sourceId === geraetId) ?? null}
                familie={(targets ?? []).find((t) => (geraetId
                  ? t.entityId != null
                    && view.komponenten.some((c) => c.entityId === t.entityId)
                  : t.lane === 'primary'))?.family ?? null}
                knowledge={knowledge}
                now={now}
              />
            )}
          </RahmenSektion>

          {/* 6 · Verbindung */}
          <RahmenSektion id="verbindung">
            {view.verbindungLeer && <p className="vp-note">{view.verbindungLeer}</p>}
            <ZeilenListe zeilen={view.verbindung} />
          </RahmenSektion>

          {/* 7 · Software */}
          <RahmenSektion id="software">
            <ZeilenListe zeilen={view.software} />
          </RahmenSektion>

          {/* 8 · Diagnose - hier landen auch die Gründe der entfallenen
                 Sektionen (§4.6), damit keine still verschwindet. */}
          <RahmenSektion id="diagnose">
            {rahmenView.entfallen.map((grund) => (
              <p className="vp-note" key={grund}>{grund}</p>
            ))}
            <ZeilenListe zeilen={view.diagnose} />
          </RahmenSektion>

          {/* 9 · Plattform-Sicht - additiv, hinter dem EINEN Tor (M7). */}
          <RahmenSektion id="plattform">
            {adminView && (
              <div data-testid="geraet-admin">
                <AdminGeraetKarten
                  view={adminView}
                  busy={adminBusy}
                  onNavigateSteuerung={() => {
                    window.location.hash = hashForRoute(pageRoute('steuerungs-freigabe'));
                  }}
                  onAssign={adminView.device.deviceId ? async (releaseSeq: number) => {
                    await adminAktion(() => adminApi.setUpdateTarget(
                      adminView.device.deviceId as string, { releaseSeq }));
                  } : undefined}
                  onRevert={adminView.device.deviceId && adminView.device.soll ? async () => {
                    await adminAktion(() => adminApi.revertUpdateTarget(
                      adminView.device.deviceId as string));
                  } : undefined}
                />
                {adminFehler && <p className="vp-alert vp-alert-err">{adminFehler}</p>}
              </div>
            )}
          </RahmenSektion>
        </GeraetRahmen>
      )}

      {view && view.gefunden && gesichtView?.gattung !== 'ladepunkt' && !editOpen
        && !renameTarget && gefahr && (
        <GeraetGefahrenzone
          siteId={site.id}
          zustand={gefahr}
          name={gefahrName}
          onDone={() => {
            setEditNotice(gefahr.kind === 'batterie'
              ? 'Die Batterie wurde am Standort abgemeldet.'
              : 'Die Komponente wurde entfernt.');
            setData(null);
            setReloadKey((key) => key + 1);
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(rollbackTarget)}
        title={`Auf Fassung ${rollbackTarget?.version ?? ''} zurückrollen?`}
        intro="Die gewählte, bereits gespeicherte Definition wird als neue Fassung aktiviert."
        consequences={[
          'Geräte-ID, Messhistorie, Transaktionen, Befehle und Audit bleiben erhalten.',
          'Die aktuelle Fassung bleibt in der Historie und kann später wieder gewählt werden.',
          'Die bisher aktive Fassung läuft, bis die Box den Rollback vollständig bestätigt.',
        ]}
        confirmLabel={rollbackBusy ? 'Rolle zurück …' : 'Fassung zurückholen'}
        onCancel={() => !rollbackBusy && setRollbackTarget(null)}
        onConfirm={() => void rollback()}
      />
      {/* Die zwei BESTEHENDEN Dialoge der Aktionszeile - kein neuer Weg, nur
          ein weiterer Wirt (§6.2). */}
      <HandeingriffDialog
        folgen={handFolgen}
        busy={aktionBusy}
        withDuration={hand !== 'resume'}
        dauerKey={handDauer}
        onDauer={setHandDauer}
        onConfirm={(m) => void handBestaetigen(m)}
        onCancel={() => !aktionBusy && setHand(null)}
      />
      <ConsumerOverrideDialog
        action={eingriff?.aktion ?? null}
        consumerName={eingriff?.consumer.name ?? ''}
        effectivePowerKw={eingriff?.consumer.ratedPowerKw ?? null}
        busy={aktionBusy}
        onConfirm={(m) => void eingriffBestaetigen(m)}
        onCancel={() => !aktionBusy && setEingriff(null)}
      />
    </div>
  );
}

/**
 * Ein Unter-Block INNERHALB einer Rahmen-Sektion (§4.4).
 *
 * <p>„Steuerung &amp; Grenzen" fasst vier frühere Sektionen zusammen - die
 * Zwischen-Überschrift hält die vier Auskünfte trotzdem auseinander.
 */
/** Wie oft die Seite den Zustand eines I/O-Moduls nachliest. */
const IO_MODUL_TAKT_MS = 15_000;

/**
 * Die Ein- und Ausgänge eines I/O-Moduls (Ebyte M31) - zuletzt GEMELDET, je
 * Ausgang mit dem Verbraucher, der ihn schaltet. Die Ableitung ist
 * `consumers/ioZustand`; hier wird nur gerendert und nachgelesen.
 */
function IoModulBlock({ siteId, entityId, now }: { siteId: string; entityId: string; now: number }) {
  const [dto, setDto] = useState<IoModulZustandDto | null>(null);
  const [fehler, setFehler] = useState(false);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<number | null>(null);
  const [meldung, setMeldung] = useState<{ text: string; ok: boolean } | null>(null);
  useEffect(() => {
    let aktiv = true;
    const lesen = () => {
      consumersApi.ioModulZustand(siteId, entityId).then(
        (d) => { if (aktiv) { setDto(d); setFehler(false); } },
        () => { if (aktiv) setFehler(true); },
      );
    };
    lesen();
    const t = window.setInterval(lesen, IO_MODUL_TAKT_MS);
    return () => { aktiv = false; window.clearInterval(t); };
  }, [siteId, entityId, reload]);
  const v = ioZustandView(dto, now);
  const schalten = (channel: number, on: boolean) => {
    setBusy(channel);
    setMeldung(null);
    consumersApi.ioAusgangSchalten(siteId, entityId, channel, on).then(
      (r) => setMeldung({ text: r.message, ok: r.ok }),
      (e: unknown) => setMeldung({
        text: e instanceof Error && e.message ? e.message : 'Der Ausgang ließ sich nicht schalten.',
        ok: false,
      }),
    ).finally(() => {
      setBusy(null);
      // Die Box meldet den neuen Zustand binnen Sekunden - dann nachlesen.
      window.setTimeout(() => setReload((x) => x + 1), 1500);
    });
  };
  return (
    <Block titel="Eingänge & Ausgänge" icon="sliders">
      {fehler && !dto && (
        <p className="vp-note">Der Zustand des I/O-Moduls ließ sich gerade nicht laden.</p>
      )}
      {v.leer && <p className="vp-note">{v.leer}</p>}
      {v.stand && (
        <p className={v.veraltet ? 'vp-note is-warn' : 'vp-geraet-sec-sub'}>
          {v.stand}{v.veraltet ? ' — der gezeigte Zustand ist nicht aktuell.' : ''}
        </p>
      )}
      {meldung && (
        <p className={meldung.ok ? 'vp-geraet-sec-sub' : 'vp-note is-warn'} role="status">
          {meldung.text}
        </p>
      )}
      {v.ausgaenge.length > 0 && (
        <dl className="vp-geraet-kv vp-io-ausgaenge">
          {v.ausgaenge.map((z) => (
            <div key={z.label} className={z.ton ? `is-${z.ton}` : undefined}>
              <dt>{z.label}</dt>
              <dd>
                <span>{z.wert}</span>
                {z.detail && <small>{z.detail}</small>}
                {!z.schalten && <small>Schalten über den Handeingriff des Verbrauchers</small>}
                {z.schalten && (
                  <span className="vp-io-schalter">
                    {z.schalten.map((a) => (
                      <Button
                        key={a.label}
                        variant="outline"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => schalten(z.channel, a.on)}
                      >
                        {busy === z.channel ? 'Schaltet …' : a.label}
                      </Button>
                    ))}
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <p className="vp-geraet-sec-sub">
        Ein freier Ausgang bleibt so, wie du ihn schaltest. Ist die Box länger als eine Minute
        nicht erreichbar, schaltet das Modul alle Ausgänge zur Sicherheit aus.
      </p>
      <ZeilenListe zeilen={v.eingaenge} />
    </Block>
  );
}

function Block({
  titel,
  icon,
  children,
}: {
  titel: string;
  icon: IconName;
  children: React.ReactNode;
}) {
  return (
    <section className="vp-rahmen-block">
      <h3><Icon name={icon} size={14} />{titel}</h3>
      {children}
    </section>
  );
}

/**
 * Der HELD einer Gattung - das Erste, was die Seite zeigt.
 *
 * <p>Er RENDERT nur: Kacheln, Satz, Hinweis und der ruhige Auslastungs-Balken
 * kommen aus `geraetGesicht.ts`. Ohne Kachel UND ohne Satz entsteht gar keine
 * Karte - ein leerer Held wäre die Box-Lehre in klein.
 */
function HeldKarte({
  held, stand, markiert, aktion,
}: {
  held: Held;
  stand: string | null;
  /**
   * Die angesprungene Kachel (§5.3): die Batterie hat keine eigene Seite, ihre
   * Komponenten-Karte führt auf `?abschnitt=jetzt&kachel=speicher`. Markiert
   * wird über den STABILEN Schlüssel, nie über das Label - der Kunde darf eine
   * Komponente umbenennen.
   */
  markiert?: string | null;
  /**
   * Die primäre Handlung dieses Blatts (§5.4): am Verbraucher steht die
   * Sofortaktion im JETZT, nicht erst in der Aktionszeile darunter. Sie LÖST
   * nur aus - gehandelt wird im bestehenden Dialog.
   */
  aktion?: { text: string; onClick: () => void } | null;
}) {
  if (held.kacheln.length === 0 && !held.satz) return null;
  return (
    <Card padding="lg" radius="lg" className="vp-geraet-held" data-testid="geraet-held">
      <div className="vp-geraet-held-kopf">
        <h2>
          <Icon name="activity" size={16} /> {held.titel}
        </h2>
        {stand && <span className="vp-muted vp-text-sm">Stand {stand}</span>}
      </div>
      {held.kacheln.length > 0 && (
        <div className="vp-geraet-heldkacheln">
          {held.kacheln.map((k: HeldKachel) => (
            <div
              className={`vp-geraet-kachel${k.gross ? ' is-gross' : ''}${
                k.ton ? ` is-${k.ton}` : ''}${
                markiert && k.key === markiert ? ' is-markiert' : ''}`}
              key={k.key}
              data-kachel={k.key}
            >
              <span className="l">{k.label}</span>
              <span className="v">{k.wert}</span>
              {k.wort && <span className="w">{k.wort}</span>}
            </div>
          ))}
        </div>
      )}
      {held.balken && (
        <div className="vp-geraet-balken" title={`${held.balken.label} ${Math.round(held.balken.pct)} %`}>
          <span className="l">{held.balken.label}</span>
          <span className="bar">
            <i style={{ width: `${held.balken.pct}%` }} />
          </span>
          <span className="v">{Math.round(held.balken.pct)} %</span>
        </div>
      )}
      {held.satz && (
        <p className={`vp-geraet-heldsatz is-${held.satzTon}`} data-testid="geraet-heldsatz">
          {held.satz}
        </p>
      )}
      {held.zeilen.length > 0 && (
        <ul className="vp-geraet-heldzeilen">
          {held.zeilen.map((z) => <li key={z}>{z}</li>)}
        </ul>
      )}
      {aktion && (
        <div className="vp-geraet-heldaktion">
          <Button variant="outline" size="sm" onClick={aktion.onClick}>
            {aktion.text}
          </Button>
        </div>
      )}
      {held.hinweis && <p className="vp-note">{held.hinweis}</p>}
    </Card>
  );
}

/** Die Namen der Regeln, die eine Komponente dieses Geräts anfassen. */
function regelNamenOf(
  strategies: Record<string, EntityStrategy[]> | null,
  komponenten: PlantComponent[],
): string[] {
  if (!strategies) return [];
  const out = new Set<string>();
  for (const c of komponenten) {
    for (const st of strategies[c.entityId] ?? []) {
      if (st.flowName?.trim()) out.add(st.flowName.trim());
    }
  }
  return Array.from(out);
}

/**
 * „Grenzen dieses Geräts" (Gattung B/B', Konzept §4.2 Punkt 4).
 *
 * <p>Die Zeile, die einen Register-Schreibvorgang MOTIVIERT (die Grenze IM
 * Gerät gegen die hinterlegte), steht damit direkt über dem Werkzeug. Sie wird
 * WÖRTLICH durchgereicht (`deviceLimitLine`) - der Satz entsteht an genau einer
 * Stelle und lastet dem Gerät nie unsere eigene Kappe an.
 */
function grenzenZeilen(
  view: GeraetSeiteView | null,
  cu: CurtailmentStatus | null,
  entities: SiteEntity[] | null,
): Zeile[] {
  if (!view) return [];
  const out: Zeile[] = [];
  const limit = cu?.deviceExportLimit;
  if (limit) {
    out.push({
      label: 'Einspeisegrenze im Gerät',
      wert: fmtNum(limit.limitKw, 'kW'),
      detail: [limit.register ? `Register ${limit.register}` : null,
        limit.readAt ? `zuletzt gelesen ${new Date(limit.readAt)
          .toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` : null]
        .filter(Boolean).join(' · ') || null,
      mono: true,
    });
  }
  const abweichung = deviceLimitLine(cu);
  if (abweichung) out.push({ label: 'Hinterlegte Grenze', wert: abweichung, ton: 'warn' });
  // ⚠ Je ENTITÄT höchstens einmal: die PV-ASPEKT-Zeile eines Hybriden teilt
  // sich ihre Entität mit dem Speicher, ihre Grenzen stünden sonst zweimal
  // untereinander (im Browser aufgefallen).
  const gesehen = new Set<string>();
  for (const c of view.komponenten) {
    if (gesehen.has(c.entityId)) continue;
    gesehen.add(c.entityId);
    // ⚠ Die Guard-Grenzen wohnen an der ENTITÄT (die Komponenten-Zeile trägt
    // sie nicht) - sie werden gelesen, nie aus einem Messwert geschlossen.
    const g = (entities ?? []).find((e) => e.id === c.entityId)?.guards?.limits as
      Record<string, unknown> | undefined;
    if (!g) continue;
    const band = [g.max_charge_kw, g.max_discharge_kw]
      .map((v) => (typeof v === 'number' && Number.isFinite(v) ? fmtNum(v, 'kW') : null));
    if (band[0] || band[1]) {
      out.push({
        label: `Leistungsband ${c.label}`,
        wert: `${band[0] ?? NO_DATA} laden · ${band[1] ?? NO_DATA} abgeben`,
      });
    }
    const soc = [g.soc_min_pct, g.soc_max_pct]
      .map((v) => (typeof v === 'number' && Number.isFinite(v) ? `${v} %` : null));
    if (soc[0] || soc[1]) {
      out.push({
        label: `Ladestand-Fenster ${c.label}`,
        wert: `${soc[0] ?? NO_DATA} bis ${soc[1] ?? NO_DATA}`,
      });
    }
    const rated = g.max_consumption_kw ?? g.max_generation_kw;
    if (typeof rated === 'number' && Number.isFinite(rated)) {
      out.push({ label: `Nennleistung ${c.label}`, wert: fmtNum(rated, 'kW') });
    }
  }
  if (out.length === 0) {
    out.push({
      label: 'Grenzen',
      wert: 'Für dieses Gerät sind keine Grenzen hinterlegt.',
      ton: 'off',
    });
  }
  return out;
}

/**
 * „Einspeise-Begrenzung" AUS SICHT DIESES GERÄTS (Gattung C, Konzept §4.3).
 *
 * <p>Erst die Einheiten-Liste des Herzschlags (Geräteseiten Stufe 1) macht die
 * Aussage möglich; ohne sie steht dort die ehrliche anlagenweite Zahl - nie ein
 * geratener Name.
 */
function einspeiseSektion(
  cu: CurtailmentStatus | null,
  geraetId: string | null,
  now: number,
): Zeile[] {
  const eigen = abregelungDiesesGeraets(cu, geraetId ?? '');
  if (!eigen) {
    return [{
      label: 'Einspeise-Begrenzung',
      wert: 'Für dieses Gerät meldet Ihre Box keine Begrenzung.',
      ton: 'off',
    }];
  }
  const out: Zeile[] = [{ label: 'Dieses Gerät', wert: eigen.satz, ton: eigen.ton }];
  // ⚠ Der Wächter-Satz entsteht an GENAU EINER Stelle (`exportGuardView`) und
  // wird durchgereicht - zwei Formulierungen wären zwei Urteile.
  const guard = exportGuardView(cu, new Date(now));
  if (guard) {
    out.push({
      label: 'Am Netzanschluss',
      wert: guard.line,
      detail: guard.agoNote || null,
      ton: guard.tone,
    });
  }
  return out;
}

/**
 * „Ausfall-Schutz" einer Ladesäule (Gattung F, Konzept §4.6 Punkt 3).
 *
 * ⚠ Es wird NICHTS neu formuliert: die drei Schritte sind die bestehende
 * `ladepunkte.ausfallSchutz` - dieselbe Ableitung, die die Ladepark-Kapsel
 * rendert. Zwei Formulierungen über denselben Schutz wären zwei Zusagen.
 */
function ausfallschutzZeilen(charging: SiteCharging | null): Zeile[] {
  return ausfallSchutz(charging?.budget ?? null).map((satz, i) => ({
    label: `Schritt ${i + 1}`,
    wert: satz,
  }));
}

/** „Diese Säule im Ladepark" (Gattung F, Konzept §4.6 Punkt 5). */
function ladeparkZeilen(charging: SiteCharging | null, geraetId: string | null): Zeile[] {
  const id = chargePointIdOf(geraetId);
  const c = id ? (charging?.chargers ?? []).find((x) => x.chargePointId === id) : undefined;
  if (!c) return [];
  const out: Zeile[] = [{
    label: 'Vorrang',
    wert: c.priority ? 'hat Vorrang vor den anderen Säulen' : 'kein Vorrang',
  }];
  const budget = charging?.budget;
  if (budget) {
    if (typeof budget.gridLimitKw === 'number') {
      out.push({ label: 'Anschlussgrenze', wert: fmtNum(budget.gridLimitKw, 'kW') });
    }
    if (budget.budgetNote?.trim()) {
      out.push({ label: 'Verteilung', wert: budget.budgetNote.trim() });
    }
  }
  return out;
}

/**
 * D · Gelesene Register (Anlagen-Zentrale Stufe 1, Konzept §7.3).
 *
 * <p>Sie zeigt, was die Box von DIESEM Gerät liest - roh und dekodiert, jeder
 * Wert mit seiner Frische. **Die Zeilen entstehen aus dem BESTAND** (Journal,
 * Einspeisegrenze, laufende Messungen); jede Ehrlichkeitsregel steckt in der
 * reinen `geraetRegister.ts`, hier wird nur gerendert.
 */
function GeleseneRegisterTabelle({
  art,
  exportLimit,
  writes,
  source,
  familie,
  knowledge,
  entityIds,
  abruf,
  bruecken,
  onBeobachten,
  now,
}: {
  art: string;
  exportLimit: DeviceExportLimit | null;
  writes: RegisterWriteEvent[] | null;
  source: SiteSource | null;
  familie: string | null;
  knowledge: RegisterKnowledgeFamily[] | null;
  entityIds: string[];
  /** Die auf ABRUF gelesenen Zeilen dieser Sitzung - sie werden nie gespeichert. */
  abruf: RegisterZeile[];
  /**
   * Die BRÜCKE je gelesener Zeile: `null` heißt „aus dieser Lesung lässt sich
   * keine Beobachtung anlegen" (eine Spule), und der Grund steht dann dort -
   * ein Knopf, der nichts bewirken kann, wird nicht angeboten.
   */
  bruecken?: Record<string, BrueckeVorschlag | null>;
  onBeobachten?: (vorschlag: BrueckeVorschlag) => void;
  now: number;
}) {
  const sicht = registerSicht({
    art,
    exportLimit,
    // Dieselbe Grenze wie beim Kommando-Verlauf: die Box hat jeden Vorgang,
    // ein Gerät dahinter nur die seiner Komponenten.
    writes: geraeteVerlauf(writes ?? [], { box: false, entityIds }),
    source,
    familie,
    knowledge,
    now,
  });
  // Auf Abruf Gelesenes führt: es ist die frischeste Auskunft der Seite.
  const zeilen = [...abruf, ...sicht.zeilen];
  return (
    <>
      {zeilen.length > 0 && (
        <table className="vp-table responsive vp-geraet-register">
          <thead>
            <tr>
              <th>Bedeutung</th>
              <th>Wert</th>
              <th>Zuletzt gelesen</th>
              <th>Herkunft</th>
            </tr>
          </thead>
          <tbody>
            {zeilen.map((z) => (
              <tr key={z.key}>
                <td data-label="Bedeutung">
                  <span className="vp-register-name">{z.bedeutung}</span>
                  {/* Die Warnklasse trägt ihr WORT, nie nur eine Farbe. */}
                  {klasseWort(z.klasse) && (
                    <span className={`vp-regklasse is-${klasseTon(z.klasse)}`}>
                      {klasseWort(z.klasse)}
                    </span>
                  )}
                  <span className="vp-register-address vp-mono">
                    {z.register ? `Register ${z.register}` : 'Adresse nicht bekannt'}
                  </span>
                </td>
                <td data-label="Wert">
                  <strong className="vp-register-value">{z.dekodiert}</strong>
                  {z.roh !== NO_DATA && (
                    <span className="vp-register-raw">Rohwert {z.roh}</span>
                  )}
                </td>
                <td data-label="Zuletzt gelesen">{z.gelesen}</td>
                <td data-label="Herkunft">
                  {QUELLE_WORT[z.quelle]}
                  {/* Die Brücke: lesen, gut finden, behalten (§7.2 Teil 3). */}
                  {bruecken && z.key in bruecken && (
                    bruecken[z.key] ? (
                      <button
                        type="button"
                        className="vp-geraet-btn vp-beob-bruecke"
                        data-testid={`beob-bruecke-${z.key}`}
                        onClick={() => onBeobachten?.(bruecken[z.key]!)}
                      >
                        <Icon name="plus" size={12} /> {BRUECKE_LABEL}
                      </button>
                    ) : (
                      <span className="vp-muted vp-text-sm">{BRUECKE_NICHT_MOEGLICH}</span>
                    )
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {zeilen.length === 0 && sicht.leer && <p className="vp-note">{sicht.leer}</p>}
      {sicht.hinweis && <p className="vp-note">{sicht.hinweis}</p>}
    </>
  );
}

/**
 * E · Register schreiben (Anlagen-Zentrale Stufe 1, Konzept §7.5).
 *
 * <p>Sie hostet DENSELBEN `RegisterWriteDrawer` wie die Zentrale und die
 * Plattform-Geräteseite - **es entsteht keine zweite Strecke**, nur ein
 * dritter Wirt mit VORGEWÄHLTEM Ziel. Jede Regel aus `vp-reg-schreib-konzept-p8`
 * gilt wörtlich weiter: Zwei-Schritt-Strecke, Vorschau nie journalisiert,
 * Notiz-Pflicht, Verantwortungs-Satz in der Rückfrage, Cloud-Not-Aus.
 *
 * <p><b>Ein Knopf, der strukturell nichts bewirken kann, wird nicht
 * angeboten</b> - dort steht der Grund des Servers (die `applyView`-Regel).
 */
function RegisterSektion({
  siteId,
  boxDeviceId,
  geraetName,
  art,
  entityIds,
  targets,
  zugang,
  offen,
  setOffen,
  exportLimit,
  writes,
  source,
  familie,
  knowledge,
  onBeobachten,
  now,
}: {
  siteId: string;
  boxDeviceId: string | null;
  geraetName: string;
  /** Die Gattung entscheidet, welche Register die Tabelle erklären kann. */
  art: GeraetArt;
  entityIds: string[];
  targets: RegisterWriteTarget[] | null;
  /**
   * Der Register-Zugang DIESES Geräts - gerechnet EINMAL im Wirt, damit die
   * Aktionszeile über dem Verlauf und der Knopf hier nicht auseinanderlaufen.
   */
  zugang: GeraetRegisterZugang;
  /** Der Einschub wohnt im Wirt: er hat ZWEI Auslöser (Zeile + Knopf). */
  offen: boolean;
  setOffen: (offen: boolean) => void;
  exportLimit: DeviceExportLimit | null;
  writes: RegisterWriteEvent[] | null;
  source: SiteSource | null;
  familie: string | null;
  knowledge: RegisterKnowledgeFamily[] | null;
  /** Die Brücke nach Teil 1 - der Wirt reicht den Vorschlag weiter. */
  onBeobachten?: (vorschlag: BrueckeVorschlag) => void;
  now: number;
}) {
  const [leseAdresse, setLeseAdresse] = useState('');
  const [leseArt, setLeseArt] = useState<'holding' | 'coil'>('holding');
  const [liest, setLiest] = useState(false);
  const [leseFehler, setLeseFehler] = useState<string | null>(null);
  const [abruf, setAbruf] = useState<RegisterZeile[]>([]);
  /**
   * Je gelesener Zeile ihr Beobachtungs-Vorschlag. Er entsteht AM LESEN, wo
   * Adresse, Registerart und das gelesene Paar vorliegen - aus der fertigen
   * Tabellen-Zeile ließe er sich nicht mehr rekonstruieren, ohne zu raten.
   */
  const [bruecken, setBruecken] = useState<Record<string, BrueckeVorschlag | null>>({});
  const verlaufFilter = useMemo(
    () => (rows: RegisterWriteEvent[]) => geraeteVerlauf(rows, { box: false, entityIds }),
    [entityIds.join('|')],
  );

  const ziel = (targets ?? []).find((t) => zielKey(t) === zugang.vorwahl) ?? null;

  /**
   * „Register jetzt lesen" - die VORSCHAU-Route, Schritt 1 der bekannten
   * Zwei-Schritt-Strecke (Konzept `vp-anlagen-zentrale-konzept-h6` §7.3).
   *
   * ⚠ Sie schreibt NICHTS und wird NICHT journalisiert (die Vorschau-Regel).
   * Die Zeile lebt deshalb nur in dieser Sitzung - ein Neuladen räumt sie ab,
   * und genau das sagt die Fläche auch.
   */
  async function jetztLesen() {
    const adresse = leseAdresse.trim();
    if (!adresse || !boxDeviceId || !ziel) return;
    setLiest(true);
    setLeseFehler(null);
    try {
      const out = await api.registerWritePreview(siteId, {
        ...zielInput(ziel),
        deviceId: boxDeviceId,
        address: adresse,
        registerKind: leseArt,
      });
      const sicht = vorschau(out);
      if (!sicht.gelesen) {
        setLeseFehler(abrufFehler(out));
        return;
      }
      const zeile = abrufZeile(adresse, out, new Date());
      setBruecken((bisher) => ({
        ...bisher,
        [zeile.key]: brueckeAusLesung({
          adresse,
          art: leseArt,
          registerLabel: out.registerLabel,
          scaleUnit: out.scaleUnit,
          beforeRaw: out.beforeRaw,
          beforeScaled: out.beforeScaled,
        }),
      }));
      setAbruf((bisher) => [
        zeile,
        // Dieselbe Adresse zweimal zu lesen ersetzt die Zeile, statt sie zu
        // verdoppeln - zwei Stände desselben Registers wären zwei Wahrheiten.
        ...bisher.filter((z) => z.key !== `abruf:${adresse.toLowerCase()}`),
      ]);
      setLeseFehler(null);
    } catch (e) {
      setLeseFehler(e instanceof ApiError ? e.message : LESE_FEHLGESCHLAGEN);
    } finally {
      setLiest(false);
    }
  }

  return (
    <>
      <section className="vp-rahmen-block vp-register-values" aria-labelledby="vp-register-values-title">
        <h3 id="vp-register-values-title"><Icon name="activity" size={14} />Zuletzt bekannte Werte</h3>
        <p className="vp-register-block-intro">
          Der letzte Wert, den VoltPilot von diesem Gerät erhalten hat.
        </p>
        <GeleseneRegisterTabelle
          art={art}
          exportLimit={exportLimit}
          writes={writes}
          source={source}
          familie={familie}
          knowledge={knowledge}
          entityIds={entityIds}
          abruf={abruf}
          bruecken={bruecken}
          onBeobachten={onBeobachten}
          now={now}
        />
      </section>

      <section className="vp-rahmen-block vp-register-tools" aria-labelledby="vp-register-tools-title">
        <h3 id="vp-register-tools-title"><Icon name="settings" size={14} />Register direkt prüfen</h3>
        <p className="vp-register-block-intro">{EXPERTE_INTRO}</p>
        {zugang.moeglich && (
          <form className="vp-geraet-lesen" onSubmit={(event) => {
            event.preventDefault();
            void jetztLesen();
          }}>
            <label>
              <span>Registeradresse</span>
              <input
                value={leseAdresse}
                onChange={(e) => setLeseAdresse(e.target.value)}
                placeholder="z. B. 0x00E7"
                inputMode="text"
                aria-label="Adresse des Registers, das jetzt gelesen wird"
              />
            </label>
            <VpPicker
              className="vp-geraet-lesen-art"
              label="Registertyp"
              ariaLabel="Registerart"
              options={[
                { value: 'holding', label: 'Holding-Register' },
                { value: 'coil', label: 'Spule' },
              ]}
              value={leseArt}
              onChange={(v) => setLeseArt(v as 'holding' | 'coil')}
            />
            <button
              type="submit"
              className="vp-geraet-btn"
              disabled={liest || !leseAdresse.trim()}
              data-testid="geraet-regread"
            >
              <Icon name="search" size={13} /> {liest ? LESE_LAEUFT : 'Register lesen'}
            </button>
            {liest && <p className="vp-note">{LESE_DAUER_HINWEIS}</p>}
            {leseFehler && <p className="vp-alert vp-alert-warn" role="alert">{leseFehler}</p>}
            {abruf.length > 0 && <p className="vp-note">{ABRUF_HINWEIS}</p>}
          </form>
        )}
        <div className="vp-register-write-action">
          <div>
            <strong>Register schreiben</strong>
            <p>Mit Vorschau, einmaliger Ausführung und dauerhaftem Protokoll.</p>
          </div>
          {zugang.moeglich ? (
            <button
              type="button"
              className="vp-geraet-btn"
              onClick={() => setOffen(true)}
              data-testid="geraet-regwrite"
            >
              <Icon name="pencil" size={13} /> Schreiben vorbereiten
            </button>
          ) : (
            <p className="vp-muted vp-text-sm" data-testid="geraet-regwrite-grund">
              {zugang.grund ?? 'Die Ziele dieses Geräts werden geladen …'}
              {/* Ein Grund, der einen WEG nennt, führt auch hin - ein benannter
                  Weg ohne Klick wäre eine Aufgabe ohne Ort (§7). */}
              {zugang.weg === 'anlagen-modell' && (
                <>
                  {' '}
                  <a href={hashForRoute(anlageRoute(siteId, 'modell'))}>Zu den Komponenten →</a>
                </>
              )}
            </p>
          )}
        </div>
      </section>
      {offen && boxDeviceId && (
        <RegisterWriteDrawer
          open
          siteId={siteId}
          deviceId={boxDeviceId}
          geraetName={geraetName}
          vorwahl={zugang.vorwahl}
          verlaufFilter={verlaufFilter}
          onClose={() => setOffen(false)}
        />
      )}
    </>
  );
}

/**
 * F · Befehle an dieses Gerät (Geräteseiten Stufe 2, Konzept §6).
 *
 * <p>Der VERLAUF: neueste Zeile oben, {@link SEITE} Zeilen, „Ältere laden" bis
 * zur Aufbewahrungsgrenze - <b>keine Filter, keine Suche, kein Treffer-Zähler</b>
 * (Captain-Entscheid D4a). Die Liste ist DASSELBE Bauteil wie auf der
 * Befehle-Seite; zwei Verlaufs-Formen wären zwei Wahrheiten.
 *
 * <p><b>Absetzen steht OBEN</b> (§6.2): die Aktionszeile löst nur aus - geöffnet
 * wird jeweils der BESTEHENDE Dialog, es entsteht kein zweiter Auslöse-Pfad.
 * Die Antwort erscheint als neue oberste Zeile, sobald der Verlauf sie trägt.
 *
 * <p><b>Sie erfindet keinen Satz:</b> Zeilen, Leer-Satz und Aufzeichnungs-Beginn
 * kommen aus der reinen `src/befehle.ts` bzw. `src/befehleVerlauf.ts`.
 * Was zu diesem Gerät gehört, entscheidet der SERVER (`?device=`).
 */
function BefehleSektion({
  siteId,
  geraetRef,
  state,
  aktionen,
  onAktion,
}: {
  siteId: string;
  geraetRef: string;
  /** Der Verlauf kommt FERTIG vom Wirt - er baut daraus auch die Kurzfassung. */
  state: VerlaufState;
  /** Was dieses Blatt absetzen kann; leer ⇒ gar keine Zeile (§6.2). */
  aktionen: VerlaufAktion[];
  onAktion: (a: VerlaufAktion) => void;
}) {
  const { history } = state;
  return (
    <>
      {/* Absetzen steht OBEN - die Antwort erscheint darunter als neue Zeile. */}
      <BefehleAktionszeile aktionen={aktionen} onAktion={onAktion} />
      {/* Die F4-Antwort: an dieses Gerät geht gar kein Befehl. Sie steht VOR
          der Liste, damit ein leerer Verlauf nicht als Zufall gelesen wird. */}
      {history && !history.writes && (
        <p className="vp-geraet-readonly">
          <Icon name="shield" size={15} /> {NUR_LESEN}
        </p>
      )}
      <BefehleVerlauf state={state} />
      <p className="vp-note">
        {aufzeichnungSeit(history?.recordingSince ?? null)}
        {' · '}
        {genauigkeitsSatz(history?.accuracySeconds ?? 15)}
      </p>
      {/* Die Grenze wird ERKLÄRT, nicht nur gezogen (§7.4): eine anlagenweite
          Abregelung liest EIN Rücklesen über ALLE Einheiten zurück - sie einem
          von mehreren Geräten zuzuschreiben wäre eine erfundene Zuordnung. */}
      {history?.deviceIsBox === false && <p className="vp-note">{ANLAGENWEITE_BEFEHLE}</p>}
      {/* Die Gegenrichtung auf der Box: sie zeigt, was sie ÜBERBRINGT - was ein
          Gerät AUSFÜHRT, steht auf dessen Seite (Ziel-Attribution). */}
      {history?.deviceIsBox === true && <p className="vp-note">{GERAETE_BEFEHLE}</p>}
      {/* ⚠ „Alles" ist auf der Box die ganze ANLAGE, nicht ihr eigener,
          engerer Ausschnitt - sonst führte der Weg zurück auf dieselbe Liste. */}
      <a
        className="vp-geraet-komp-link"
        href={history?.deviceIsBox === true
          ? hashForRoute(anlageRoute(siteId, 'befehle'))
          : befehleGeraetHash(siteId, geraetRef)}
      >
        {history?.deviceIsBox === true ? 'Alle Befehle dieser Anlage' : 'Auf der Befehle-Seite'}
        <Icon name="chevron-right" size={14} />
      </a>
    </>
  );
}

/** Die Label/Wert-Liste einer Sektion. Am Telefon stapeln die zwei Spalten. */
function ZeilenListe({ zeilen }: { zeilen: Zeile[] }) {
  if (zeilen.length === 0) return null;
  return (
    <dl className="vp-geraet-kv">
      {zeilen.map((z) => (
        <div key={z.label} className={z.ton ? `is-${z.ton}` : undefined}>
          <dt>{z.label}</dt>
          <dd>
            <span className={z.mono ? 'vp-mono' : undefined}>{z.wert}</span>
            {z.detail && <small>{z.detail}</small>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Eine Komponente dieses Geräts - WÖRTLICH die Zeile aus dem Anlagen-Modell,
 * nur ohne ihr Menü: die Handlungen (Umbenennen, Zuordnung, Löschen) wohnen
 * dort, wo die Komponente verwaltet wird. „In der Zentrale ›" ist der Weg.
 */
function KomponentenZeile({
  komponente,
  siteId,
}: {
  komponente: PlantComponent;
  siteId: string;
}) {
  const c = komponente;
  return (
    <li className="vp-geraet-komp">
      <span className={`vp-geraet-rolle vp-am-${c.role}`} aria-hidden="true">
        <Icon name={COMPONENT_ROLE_ICONS[c.role] as IconName} size={14} />
      </span>
      <div className="tx">
        <span className="nm">
          {c.label}
          {c.primary && <span className="vp-pill vp-pill-info">maßgeblich</span>}
          {c.control && (
            <span className="vp-geraet-ctrl">
              <Icon name="zap" size={12} /> VoltPilot steuert
            </span>
          )}
        </span>
        <span className="s">
          {c.provenance ? `${c.provenance} · ${c.summary}` : c.summary}
        </span>
      </div>
      <span className="val">
        {c.reading ? `${c.reading.value.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${c.reading.unit}` : NO_DATA}
      </span>
      <a className="vp-geraet-komp-link" href={hashForRoute(anlageRoute(siteId, 'modell'))}>
        In der Zentrale
        <Icon name="chevron-right" size={14} />
      </a>
    </li>
  );
}
