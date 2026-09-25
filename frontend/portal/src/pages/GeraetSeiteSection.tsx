import { useCallback, useEffect, useMemo, useState } from 'react';
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
  istIoModul,
  ioVerbraucherGeraetId,
  ioVerbraucherIdOf,
  NOT_AUS_LABEL,
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
  typWort,
  type Gesicht,
} from '../geraetGesicht';
import { ioBindungenAus, plantModel, type PlantComponent } from '../komponenten';
import { fmtNum } from '../format';
import { deviceLimitLine, exportGuardView, WAECHTER_LABEL } from '../curtailment';
import type { IconName } from '../../designsystem/components/core/Icon';
import { EmptyState, ErrorState, TextSkeleton } from '../components/States';
import { GeraetProtokoll } from '../components/GeraetProtokoll';
import { GeraetGefahrenzone, gefahrMenueLabel } from '../components/GeraetGefahrenzone';
import { GeraetSummenwerte } from '../components/GeraetSummenwerte';
import { gefahrenzone } from '../geraetLoeschen';
import {
  anlageRoute,
  befehleGeraetHash,
  befehleHash,
  geraetBearbeitenKomponente,
  geraetSeiteHash,
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
  genauigkeitsSatz,
  NUR_LESEN,
} from '../befehle';
import { BefehleVerlauf, useBefehleVerlauf } from '../components/BefehleVerlauf';
import {
  DAUERN,
  endeVon,
  handeingriffFolgen,
  planVerzicht,
  type HandeingriffAktion,
} from '../handeingriff';
import { HandeingriffDialog } from '../components/HandeingriffDialog';
import { ConsumerOverrideDialog } from '../components/ConsumerOverrideDialog';
import { consumersApi } from '../consumers/consumersApi';
import { ioBelegung, ioBelegungSatz, VERALTET_MS } from '../consumers/ioZustand';
import type { ConsumerRuntimeStatus } from '../consumers/status';
import type { Consumer } from '../consumers/types';
import {
  fulfilmentSummary,
  type ConsumerFulfilment,
  type ManualOverride,
  type SofortAktion,
} from '../consumers/fulfillment';
import { consumerHasMeasurement, consumerNachweis } from '../consumers/questions';
import { controlStrip } from '../control';
import { geraetZeile, speicherZeile } from '../steuerungJetzt';
import {
  speicherSteuerung,
  verbraucherSteuerung,
  type SegmentAktion,
  type SteuerungView,
} from '../geraetSteuerung';
import { heuteKanal } from '../geraetHeute';
import { verlaufHash } from '../verlauf';
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
import {
  GeraetRahmen,
  type BausteinInhalt,
  type KernSymbol,
  type MenueEintrag,
  type TechnikTeil,
} from '../components/GeraetRahmen';
import { GeraetBuehne, grosseZahl, nebenKacheln, type BuehneGrafik } from '../components/GeraetBuehne';
import { GeraetSteuerung } from '../components/GeraetSteuerung';
import { GeraetHeute } from '../components/GeraetHeute';
import { IoKlemmenplan, useIoModulZustand } from '../components/IoKlemmenplan';
import { kopfHinweis, parseKachel, type Befund } from '../geraetRahmen';
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
// Aktivität rendert den VERLAUF, dessen Regeln in `Befehle.css` wohnen - ohne
// diesen Import stünde er ungestylt da, sobald ein Kunde direkt auf einer
// Geräteseite ankommt (im Browser gefunden).
import './Befehle.css';
import './GeraetSeite.css';
import { AUFBAU_REITER } from '../anlageNav';

/**
 * Die GERÄTE-DETAILSEITE der Anlagen-Zentrale
 * (`#/anlage/{siteId}/geraet/{ref}[/{geraetId}]`).
 *
 * Seit dem Konzept „Geräteseiten: Ein Blick, eine Antwort" (25.09.2026) steht
 * sie auf dem gemeinsamen KERN (`components/GeraetRahmen`): Kopf, Jetzt,
 * Steuerung, Heute, Aktivität, Gerät &amp; Verbindung - und „Technik &amp;
 * Diagnose" als eigene Ansicht (`?ansicht=technik`). Jeder Typ bringt nur
 * seine Grafik und seine Knöpfe mit.
 *
 * **Kunde und Plattform-Admin sehen DIESELBE Seite**; der Admin bekommt
 * additiv die Plattform-Sicht hinter dem EINEN Tor `rollen.showTechnicalLayer()`.
 *
 * Diese Datei RENDERT nur. Jede Regel, jeder Satz und jedes Urteil liegt in
 * den reinen Ableitungen (`geraetSeite`, `geraetGesicht`, `geraetRahmen`,
 * `geraetSteuerung`, `geraetHeute`); die Komponenten kommen aus `plantModel` -
 * dieselbe Ableitung, die die Zentrale rendert.
 *
 * **Jeder Nebenabruf ist fail-soft.** Fällt einer aus, fällt sein Baustein
 * still weg, statt die Seite unbenutzbar zu machen - nur der Entitäts-Abruf
 * trägt die Seite.
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
  const [charging, setCharging] = useState<SiteCharging | null>(null);
  const [chargingLoadedRequest, setChargingLoadedRequest] = useState<string | null>(null);
  const [strategies, setStrategies] = useState<Record<string, EntityStrategy[]> | null>(null);
  const [interventions, setInterventions] = useState<SiteInterventions | null>(null);
  const [consumers, setConsumers] = useState<Consumer[]>([]);
  const [consumerStatus, setConsumerStatus] = useState<ConsumerRuntimeStatus[]>([]);
  const [overrides, setOverrides] = useState<ManualOverride[]>([]);
  // Die Erfüllungs-Zeile der Bühne. Sie wird NUR geholt, wenn es wirklich
  // einen Verbraucher gibt - sonst gäbe es nichts zu erfüllen.
  const [fulfilment, setFulfilment] = useState<ConsumerFulfilment | null>(null);
  const [plan, setPlan] = useState<SchedulePlan | null>(null);
  const [regOffen, setRegOffen] = useState(false);
  const [hand, setHand] = useState<HandeingriffAktion | null>(null);
  const [handDauer, setHandDauer] = useState('2h');
  const [eingriff, setEingriff] = useState<{ consumer: Consumer; aktion: SofortAktion } | null>(null);
  const [aktionBusy, setAktionBusy] = useState(false);
  const [entfernenOffen, setEntfernenOffen] = useState(false);
  const [heuteAusfall, setHeuteAusfall] = useState(false);
  const [targets, setTargets] = useState<RegisterWriteTarget[] | null>(null);
  const [writes, setWrites] = useState<RegisterWriteEvent[] | null>(null);
  const [knowledge, setKnowledge] = useState<RegisterKnowledgeFamily[] | null>(null);
  /**
   * Die BRÜCKE (Stufe 3a §7.2 Teil 3): eine gelesene Zeile wird zur
   * Beobachtung. Sie reist als ZUSTAND durch den Wirt, weil Lesung und
   * Beobachtungs-Liste zwei Bauteile sind - und wird nach dem Öffnen des
   * Formulars wieder abgeräumt, damit derselbe Vorschlag nicht bei jedem
   * Render erneut aufspringt.
   */
  const [bruecke, setBruecke] = useState<BrueckeVorschlag | null>(null);
  const brueckeVerbraucht = useCallback(() => setBruecke(null), []);
  /**
   * Trägt dieses Gerät die PV-Produktion der Anlage (eine Rollen-Zuordnung,
   * vp-agg-konzept3-r8)? Nur für die ehrliche Entfernen-Folge; der Zähler
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
    setEntfernenOffen(false);
    setHeuteAusfall(false);
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
    // Alles Übrige fail-soft: ein Ausfall nimmt nur seinen Baustein weg.
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
    // K4: die Verbraucher der Anlage - auch für die BINDUNG an I/O-Ausgänge,
    // ohne die `plantModel` einen Verbraucher am Ausgang dem Wechselrichter
    // zuschlüge. Fail-soft: ohne sie gilt die bisherige Zuordnung.
    void consumersApi.list(site.id).then(
      (v) => { if (active) setConsumers(v ?? []); },
      () => { if (active) setConsumers([]); },
    );
    // Die gelesenen Register kommen AUS DEM BESTAND - das Journal trägt die
    // einzigen Rohwörter, die es heute gibt, das Register-Wissen den Namen.
    soft(api.registerWriteHistory(site.id, boxDevice?.id), setWrites);
    soft(api.registerKnowledge(site.id), setKnowledge);
    // ⚠ Die Ziele des Register-Werkzeugs bewusst NICHT über `soft`: dort
    // fallen „lädt noch" und „Abruf gescheitert" in denselben Zustand. Ein
    // Fehlschlag ist hier eine LEERE Ziel-Liste - dann sagt die Technik
    // ehrlich, dass kein Schreibweg bekannt ist.
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
      // Admin-Sicht - eine halbe Sicht wäre eine Aussage über ein Gerät, das
      // wir nicht vollständig kennen.
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
      api.topology(site.id).catch(() => null),
    ]).then(([s, c, cu, ch, t]) => {
      if (s !== null) setSources(s);
      setControl(c);
      setCurtailment(cu);
      if (ch !== null) setCharging(ch);
      if (t !== null) setTopology(t);
      setNow(Date.now());
    });
  }, LIVE_POLL_MS);

  /** K4: welche Verbraucher an welchem I/O-Ausgang hängen - aus ihren Profilen. */
  const ioBindungen = useMemo(() => ioBindungenAus(consumers), [consumers]);

  const model = useMemo(
    () => (data ? plantModel(data.entities, topology, data.localSetup, sources, ioBindungen) : null),
    [data, topology, sources, ioBindungen],
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
      charging,
      strategies,
      model,
      now,
    });
  }, [
    data, geraeteRef, geraetId, site.name, site.id, devices, devicesFetchedAt,
    sources, components, control, curtailment, charging, strategies, model, now,
  ]);

  const box = boxDevice;
  /** K4: diese Seite ist die eines Verbrauchers am Ausgang eines I/O-Moduls. */
  const ioVerbraucherSeite = ioVerbraucherIdOf(geraetId) != null;
  /**
   * Die Komponenten, die diesem Gerät SELBST gehören. Am Modul hängen seit K4
   * auch die Verbraucher an seinen Ausgängen - sie haben ihre eigene Seite und
   * werden dort gesteuert und entfernt, nicht hier.
   */
  const eigeneKomponenten = useMemo(
    () => (view?.komponenten ?? []).filter((c) => !c.io || ioVerbraucherSeite),
    [view, ioVerbraucherSeite],
  );
  const editRow: SiteComponentRow | null = useMemo(() => {
    // Ein Verbraucher am Ausgang hat keine eigene Verbindung - bearbeitet wird
    // sein Profil in der Steuerung, nicht eine Geräte-Einrichtung.
    if (!view || !geraetId || ioVerbraucherSeite) return null;
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
   * Der Verbraucher DIESES Geräts - die Grundlage von Bühne (Erfüllung,
   * Nachweis) UND Steuerung.
   *
   * ⚠ Er steht VOR dem Gesicht: die Gattung hängt an Rolle und Entitätstyp,
   * nie an dieser Liste, also konvergiert es in zwei Läufen - eine Schleife
   * gibt es nicht. Umgekehrt wäre es ein TDZ-Fehler.
   */
  const eigenerVerbraucher = useMemo(() => {
    const ids = new Set(eigeneKomponenten.map((c) => c.entityId));
    return consumers.find((c) => ids.has(c.id)) ?? null;
  }, [consumers, eigeneKomponenten]);

  // Das I/O-Modul: Bühnen-Zahl und Klemmenplan aus DERSELBEN Meldung - und am
  // Verbraucher eines Ausgangs der gemeldete Zustand seines Relais (K4).
  const setupHier = (data?.localSetup ?? []).find((l) => l.id === geraetId);
  const rowHier = (components?.components ?? []).find(
    (r) => r.edgeSourceId === geraetId
      || (view?.komponenten ?? []).some((c) => !c.io && c.entityId === r.id),
  );
  const kommunikation = ioVerbraucherSeite
    ? null
    : rowHier?.communication ?? setupHier?.communication ?? null;
  const istModul = istIoModul(kommunikation);
  // Die Entität des Moduls: die gepflegte Zeile, sonst seine eigene Komponente
  // (die Box meldet es auch an einer box-verwalteten Anlage) - nie geraten.
  const modulEntityId = istModul
    ? editRow?.id ?? eigeneKomponenten.find((c) => !c.io)?.entityId ?? null
    : null;
  const io = useIoModulZustand(
    site.id,
    istModul ? modulEntityId : ioVerbraucherSeite ? eigenerVerbraucher?.ioEntityId ?? null : null,
  );
  /** Der gemeldete Zustand DIESES Ausgangs - nur, solange die Meldung aktuell ist. */
  const ioAusgangAn = useMemo(() => {
    if (!ioVerbraucherSeite || !eigenerVerbraucher || !io.dto) return null;
    const at = io.dto.receivedAt ? Date.parse(io.dto.receivedAt) : Number.NaN;
    if (!Number.isFinite(at) || now - at > VERALTET_MS) return null;
    const k = io.dto.outputs.find((o) => o.consumerId === eigenerVerbraucher.id);
    return k?.on ?? null;
  }, [ioVerbraucherSeite, eigenerVerbraucher, io.dto, now]);

  // ------------------------------------------------------------------
  // Das GESICHT dieser Seite - was die Bühne zeigt und welche Fächer es gibt.
  // ------------------------------------------------------------------
  const gesichtView: Gesicht | null = useMemo(() => {
    if (!view || !view.gefunden) return null;
    return gesicht({
      art: view.art,
      geraetId: geraetId ?? geraeteRef,
      rolle: setupHier?.role ?? null,
      // Das gepflegte SOLL führt, sonst das gemeldete Ist - dieselbe Reihenfolge
      // wie `geraetSeite.verbindungsWeg`.
      communication: kommunikation,
      komponenten: eigeneKomponenten,
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
      regeln: regelNamenOf(strategies, eigeneKomponenten),
      topologie: topology?.entities ?? null,
      speicherKnoten: topology?.topology.nodes.find((n) => n.role === 'storage') ?? null,
      // WÖRTLICH die geteilte Erfüllungs-Kopfzeile bzw. die geteilte
      // D3-Regel - ein zweites Urteil hier wäre eine zweite Wahrheit.
      erfuellung: fulfilment ? fulfilmentSummary(fulfilment).headline : null,
      gemessen: eigenerVerbraucher ? consumerHasMeasurement(eigenerVerbraucher) : null,
      nachweis: eigenerVerbraucher ? consumerNachweis(eigenerVerbraucher) : null,
      ioAusgangAn,
      now,
    });
  }, [view, data, sources, charging, control, curtailment, strategies, topology, fulfilment,
    eigenerVerbraucher, geraetId, geraeteRef, box?.id, now, setupHier, kommunikation,
    eigeneKomponenten, ioAusgangAn]);

  /**
   * Die Katalog-Familien DIESES Geräts - der Filter der Messbibliothek.
   * Dieselbe Soll-vor-Ist-Reihenfolge wie `communication` oben; ein Ladepunkt
   * spricht per Konstruktion OCPP.
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
    // Fläche auf die Box-Semantik zurück (`null`) statt die Messbibliothek zu
    // verstecken. Auf jedem anderen Gerät bleibt es bei der Ausblende-Regel.
    if (familien.length === 0 && geraetId === 'inverter') return null;
    return familien;
  }, [view, data, components, geraetId, gesichtView]);

  // Die Grenzen-Zeilen - abgeleitet aus dem, was schon geladen ist; jede
  // Zeile nennt ihren Grund, keine wird erfunden.
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

  /**
   * Ein Gerät ohne Modbus-Register kann trotzdem MESSWERTE beobachten (D3):
   * dann gibt es Technik › Register, sie heißt nur „Messwerte".
   */
  const hatMessbibliothek = Boolean(
    view?.gefunden && (messFamilien == null || messFamilien.length > 0),
  );
  const registerSektion = Boolean(gesichtView?.sektionen.includes('register'));
  /**
   * Die Messbibliothek hängt am TRANSPORT der Box (dort wohnt die Selektion),
   * zeigt aber den Katalog DIESES Geräts - und auf dem Ladepunkt-Pfad in
   * dessen OCPP-Technik.
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
    />
  ) : null;

  // ------------------------------------------------------------------
  // Aktivität: der Server entscheidet, was zu diesem Gerät gehört
  // (`?device=`) - die Fläche schneidet nichts selbst zurecht.
  // ------------------------------------------------------------------
  // K4: ein Verbraucher am Relais eines Moduls ist KEINE Quelle der Box - der
  // Server kennt `io-…` nicht als Gerät. Seine Befehle hängen an seiner
  // Komponente, also fragt die Seite nach ihr.
  const ioVerbraucherEntity = ioVerbraucherIdOf(geraetId);
  const verlauf = useBefehleVerlauf({
    siteId: site.id,
    entityId: ioVerbraucherEntity,
    geraetRef: geraetId ?? geraeteRef,
  });

  /**
   * Was die STEUERUNG braucht - fail-soft und GATTUNGS-GETAKTET: ein Zähler
   * oder ein PV-Melder bezahlt die Abrufe nie, weil er keinen Schalter hat.
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
      // Der Fahrplan trägt Quelle und Grund der Speicher-Zeile UND den
      // Plan-Verzicht der Folgen-Karte. Ohne ihn sagt sie ehrlich „nicht
      // abschätzbar" - eine Zahl wird nie erfunden.
      soft(api.schedule(site.id), setPlan, null);
    }
    if (brauchtVerbraucher) {
      soft(consumersApi.overrides(site.id), setOverrides, []);
      soft(consumersApi.status(site.id), setConsumerStatus, []);
    }
    return () => { active = false; };
  }, [site.id, brauchtSpeicher, brauchtVerbraucher, reloadKey]);

  /**
   * Die Erfüllung DIESES Verbrauchers. Eigener Effekt, weil sie an der
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
   * Der Register-Zugang DIESES Geräts - er entscheidet, ob Technik › Register
   * „Schreiben vorbereiten" anbietet. `targets == null` heisst „lädt noch" -
   * dann wird NICHTS behauptet, weder ein Weg noch sein Fehlen.
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

  /** Der Beleg der Speicher-Steuerung - nur der, den DIESE Box gemeldet hat. */
  const eigenerBeleg = control && box?.id && control.deviceId === box.id ? control : null;

  /**
   * Der Baustein „Steuerung" (K1): Zustand, Quelle, Grund und die Handlungen
   * WÖRTLICH aus `steuerungJetzt` - dieselbe Zeile wie in der Jetzt-Zone der
   * Steuerungs-Seite.
   */
  const steuerung: SteuerungView | null = useMemo(() => {
    if (!view?.gefunden || !gesichtView) return null;
    if (gesichtView.gattung === 'wechselrichter-speicher') {
      const speicher = view.komponenten.find((c) => c.role === 'storage');
      const eingriffJetzt = interventions?.interventions.find((i) => i.entityId != null) ?? null;
      const zeile = speicherZeile({
        name: speicher?.alias ?? null,
        control: eigenerBeleg,
        // Ein Plan MIT Gerät heißt: diese Anlage wird wirklich gesteuert.
        expectControl: plan?.deviceId != null || Boolean(speicher?.control),
        slots: plan?.slots ?? null,
        curtail: curtailment,
        plantKind: site.plantKind === 'direktvermarktung' ? 'direktvermarktung' : 'eigenverbrauch',
        // `entity-strategies` nennt die AKTIVEN Regeln je Komponente - ein
        // Server-Fakt, nie geraten.
        regelHaeltAn: Boolean(speicher && (strategies?.[speicher.entityId] ?? []).length > 0),
        eingriff: eingriffJetzt,
        pausiert: interventions?.automationPaused === true,
        now: new Date(now),
      });
      return zeile ? speicherSteuerung(zeile, eingriffJetzt) : null;
    }
    if (eigenerVerbraucher && (gesichtView.gattung === 'verbraucher' || gesichtView.gattung === 'geraet')) {
      const override = overrides.find((o) => o.entityId === eigenerVerbraucher.id) ?? null;
      const zeile = geraetZeile({
        consumer: eigenerVerbraucher,
        status: consumerStatus.find((s) => s.entityId === eigenerVerbraucher.id) ?? null,
        override,
        anyStatusReported: consumerStatus.length > 0,
      }, new Date(now));
      return verbraucherSteuerung(zeile, override);
    }
    return null;
  }, [view, gesichtView, interventions, eigenerBeleg, plan, curtailment, site.plantKind,
    strategies, now, eigenerVerbraucher, overrides, consumerStatus]);

  const segmentAusloesen = useCallback((a: SegmentAktion) => {
    if (a.art === 'speicher') setHand(a.wert);
    else if (a.art === 'verbraucher' && eigenerVerbraucher) {
      setEingriff({ consumer: eigenerVerbraucher, aktion: a.wert });
    }
  }, [eigenerVerbraucher]);

  /**
   * Die Folgen-Karte des Speicher-Eingriffs - dieselbe Komposition wie in der
   * Jetzt-Zone der Steuerung (`handeingriffFolgen`).
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

  /**
   * Der EINE Kopf-Hinweis: der schlimmste anstehende Befund.
   *
   * ⚠ Jeder Satz kommt WÖRTLICH aus seiner geteilten Ableitung - der Kern
   * formuliert keinen, er WÄHLT nur den schlimmsten und verlinkt seinen Ort.
   */
  const istWechselrichter = gattung === 'wechselrichter-speicher' || gattung === 'wechselrichter';
  const erzeugt = Boolean(view?.komponenten.some((c) => c.role === 'pv'));
  const hinweis = useMemo(() => {
    const waechter = exportGuardView(curtailment, new Date(now));
    const befunde: (Befund | null)[] = [
      // K3: das Rücklesen gilt der SPEICHER-Steuerung des Wechselrichters -
      // über einen Heizstab sagt es nichts.
      (() => {
        if (!istWechselrichter || !eigenerBeleg) return null;
        const strip = controlStrip(eigenerBeleg, new Date(now));
        return strip?.state === 'mismatch'
          ? { art: 'ruecklesen' as const, satz: strip.sentence, ton: 'warn' as const }
          : null;
      })(),
      // Der Einspeise-Wächter nur an einem ERZEUGENDEN Gerät - an einem Zähler
      // wäre er eine Aussage über ein fremdes Gerät.
      erzeugt && waechter?.tone === 'warn' ? { art: 'waechter', satz: waechter.line, ton: 'warn' } : null,
      view?.art === 'hauptgeraet'
        ? (() => {
          const satz = deviceLimitLine(curtailment);
          return satz ? { art: 'grenze' as const, satz, ton: 'warn' as const } : null;
        })()
        : null,
    ];
    return kopfHinweis(befunde, {
      bausteine: ['buehne', 'steuerung', 'heute', 'aktivitaet', 'details'],
      technik: registerSektion || hatMessbibliothek ? ['register'] : [],
    });
  }, [curtailment, eigenerBeleg, istWechselrichter, erzeugt, view?.art, now, registerSektion,
    hatMessbibliothek]);

  /**
   * Die angesprungene Kachel - sie kommt als PARAMETER im Hash, nie als zweites
   * `#`. Gelesen beim Aufbau UND bei jedem Hash-Wechsel.
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

  /** Der Hilfetext dieses Blatts: eine Wärmepumpe ist ein schaltbarer Verbraucher. */
  const hinweisSatz = useMemo(() => {
    if (!view?.gefunden || !gesichtView) return null;
    return blattHinweis(gesichtView, {
      komponenten: view.komponenten,
      entities: data?.entities ?? null,
    });
  }, [view, gesichtView, data]);

  /**
   * Das ENTFERNEN dieses Geräts (vp-loeschen-konzept-l3, E4) - seit V7 im Menü
   * „⋯", mit derselben Rückfrage und denselben Folgen. Nie für eine Ladesäule.
   */
  const gefahr = useMemo(() => {
    if (!view || !view.gefunden || view.art === 'ladepunkt') return null;
    return gefahrenzone(eigeneKomponenten, (id) => data?.entities.find((e) => e.id === id), pvZugeordnet);
  }, [view, eigeneKomponenten, data, pvZugeordnet]);
  const gefahrName =
    gefahr?.kind === 'entfernen' ? gefahr.component.label : view?.kopf.titel ?? '';

  /**
   * Die Entität, mit der der Summenwert-Assistent „PV-Produktion dieses Geräts"
   * startet (vp-agg-konzept3-r8, Fix (b)) - null heißt: das Gerät erzeugt nichts.
   */
  const erzeugungEntityId = useMemo(
    () => (view?.gefunden ? pvEinstiegEntityId(view) : null),
    [view],
  );

  // Die PV-Rollen-Zuordnung dieses Geräts - für die Entfernen-Folge.
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


  const anlageHref = hashForRoute(anlageRoute(site.id));
  const komponentenHref = hashForRoute(anlageRoute(site.id, 'modell'));

  return (
    <div className="vp-geraet">
      {/* GENAU EIN Rückweg: im gefundenen Fall trägt ihn der Kern selbst -
          hier steht die Brotkrume nur über den Lade-/Fehler-/Leer-Zuständen,
          damit auch die einen Rückweg haben. */}
      {gesichtView?.gattung !== 'ladepunkt' && !(view && view.gefunden) && (
        <GeraetBrotkrume
          anlageHref={anlageHref}
          komponentenHref={komponentenHref}
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
          backHref={komponentenHref}
          siteHref={anlageHref}
          settingsHref={hashForRoute(anlageRoute(site.id, 'ladevorgaenge'))}
          charger={(charging?.chargers ?? []).find(
            (item) => item.chargePointId === chargePointIdOf(geraetId),
          ) ?? null}
          budget={charging?.budget ?? null}
          onRename={chargerRenameTarget ? () => {
            setEditNotice(null);
            setEditError(null);
            setRenameTarget(chargerRenameTarget);
          } : undefined}
          messwerte={beobachtung}
          heute={heuteBaustein(site.id, gesichtView, view, setHeuteAusfall, heuteAusfall)}
          ladeparkZeilen={[...ladepark, ...ausfallschutz.map((z) => ({ ...z, label: `Ausfall-Schutz · ${z.label}` }))]}
          onDatenGeaendert={() => setReloadKey((k) => k + 1)}
        />
      )}

      {view && view.gefunden && renameTarget && (
        <>
          <GeraetBrotkrume
            anlageHref={anlageHref}
            komponentenHref={komponentenHref}
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
            anlageHref={anlageHref}
            komponentenHref={komponentenHref}
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

      {view && view.gefunden && gesichtView && gesichtView.gattung !== 'ladepunkt' && !editOpen && !renameTarget && (() => {
        const held = gesichtView.held;
        const zahl = grosseZahl(held);
        const src = (sources ?? []).find((s) => s.sourceId === geraetId) ?? null;
        const bearbeitbar = components?.componentAuthority === 'portal' && Boolean(editRow);
        const bearbeiten = () => {
          setEditNotice(null);
          setEditError(null);
          setEditOpen(true);
        };
        const menue: MenueEintrag[] = [];
        if (bearbeitbar) menue.push({ key: 'bearbeiten', label: 'Bearbeiten', icon: 'pencil', onClick: bearbeiten });
        const gefahrLabel = gefahrMenueLabel(gefahr);
        if (gefahrLabel) {
          menue.push({ key: 'entfernen', label: gefahrLabel, icon: 'trash', danger: true, onClick: () => setEntfernenOffen(true) });
        }

        const massgeblich = held.werte.massgeblich;
        const grafik: BuehneGrafik | null = gesichtView.ioModul
          ? null
          : gesichtView.gattung === 'wechselrichter-speicher'
            ? { art: 'speicher', werte: held.werte }
            : gesichtView.gattung === 'wechselrichter' || gesichtView.gattung === 'pv-melder'
              ? { art: 'sonne', werte: held.werte }
              : gesichtView.gattung === 'zaehler' && !gesichtView.eigenbau
                ? { art: 'netz', werte: held.werte }
                : gesichtView.gattung === 'verbraucher'
                  ? {
                    art: 'verbraucher',
                    werte: held.werte,
                    freigabe: eigenerVerbraucher ? consumerNachweis(eigenerVerbraucher) === 'freigabe' : false,
                  }
                  : null;
        const belegung = gesichtView.ioModul ? ioBelegung(io.dto) : null;

        const buehne: BausteinInhalt = {
          inhalt: gesichtView.ioModul ? (
            <GeraetBuehne
              zahl={belegung ? {
                zahl: String(belegung.verbraucher),
                einheit: belegung.verbraucher === 1 ? 'Verbraucher' : 'Verbraucher',
                wort: null,
                ton: null,
                key: 'belegung',
              } : null}
              satz={ioBelegungSatz(io.dto, now)}
              inhalt={modulEntityId ? (
                <IoKlemmenplan
                  siteId={site.id}
                  entityId={modulEntityId}
                  dto={io.dto}
                  fehler={io.fehler}
                  now={now}
                  onNeuLaden={io.neuLaden}
                  verbraucherHref={(consumerId) => geraetSeiteHash(site.id, geraeteRef, ioVerbraucherGeraetId(consumerId))}
                />
              ) : null}
              hinweis={modulEntityId ? null : held.hinweis}
            />
          ) : (
            <GeraetBuehne
              zahl={zahl}
              satz={held.satz}
              satzTon={held.satzTon}
              grafik={grafik}
              chips={nebenKacheln(held, zahl, grafik)}
              zeilen={held.zeilen}
              hinweis={held.hinweis}
              markiert={angesprungeneKachel}
            />
          ),
        };

        // --- Steuerung ------------------------------------------------------
        const notAus = view.steuerung.find((z) => z.label === NOT_AUS_LABEL) ?? null;
        const eigenEinspeisung = abregelungDiesesGeraets(curtailment, geraetId ?? '');
        const steuerungBaustein: BausteinInhalt | null = steuerung
          ? {
            inhalt: (
              <GeraetSteuerung
                view={steuerung}
                busy={aktionBusy}
                onAktion={segmentAusloesen}
                zusatz={notAus ? (
                  <p className="vp-steuer-hinweis" role="status">
                    <Icon name="alert-triangle" size={15} />
                    <span>{`${notAus.label}: ${notAus.wert}`}</span>
                  </p>
                ) : null}
              />
            ),
            kopfRechts: steuerung.zeile.quelle === 'handeingriff' ? 'Handeingriff' : null,
          }
          : gesichtView.gattung === 'pv-melder' && eigenEinspeisung
            ? {
              titel: 'Einspeise-Begrenzung',
              kopfRechts: 'automatisch',
              inhalt: <ZeilenListe zeilen={einspeiseZeilen} />,
            }
            : null;

        // --- Heute ----------------------------------------------------------
        const heute = heuteBaustein(site.id, gesichtView, view, setHeuteAusfall, heuteAusfall);

        // --- Aktivität ------------------------------------------------------
        const history = verlauf.history;
        const aktivitaet: BausteinInhalt | null = gesichtView.sektionen.includes('befehle')
          ? {
            info: (
              <>
                <p>
                  {aufzeichnungSeit(history?.recordingSince ?? null)}
                  {' · '}
                  {genauigkeitsSatz(history?.accuracySeconds ?? 15)}
                </p>
                {history?.deviceIsBox === false && <p>{ANLAGENWEITE_BEFEHLE}</p>}
              </>
            ),
            kopfRechts: (
              <a href={ioVerbraucherEntity
                ? befehleHash(site.id, ioVerbraucherEntity)
                : befehleGeraetHash(site.id, geraetId ?? geraeteRef)}
              >
                Alle <Icon name="chevron-right" size={14} />
              </a>
            ),
            inhalt: (
              <>
                {history && !history.writes && (
                  <p className="vp-geraet-readonly">
                    <Icon name="shield" size={15} /> {NUR_LESEN}
                  </p>
                )}
                <BefehleVerlauf state={verlauf} max={3} />
              </>
            ),
          }
          : null;

        // --- Gerät & Verbindung --------------------------------------------
        const bezuege = view.steuerung.filter(
          (z) => z.label !== NOT_AUS_LABEL
            // ⚠ Der Einspeise-Wächter steht dort, wo die Gattung ihn führt -
            // nie zweimal auf einem Bildschirm.
            && !(steuerungBaustein?.titel === 'Einspeise-Begrenzung' && z.label === WAECHTER_LABEL),
        );
        // Ein I/O-Modul misst keine Größe - seine Zustände stehen im
        // Klemmenplan, und „Misst: I/O-Modul Keller" nennte nur sich selbst.
        const misst = gesichtView.ioModul ? [] : eigeneKomponenten
          .filter((c) => (c.aspect === 'main' || c.role === 'pv') && !c.io)
          .map((c) => (c.primary ? `${c.label} (maßgeblich)` : c.label));
        // K4: was an den Ausgängen dieses Moduls hängt - geschaltet, nicht gemessen.
        const schaltet = view.komponenten
          .filter((c) => c.io && !ioVerbraucherSeite)
          .map((c) => `${c.label} (DO${c.io?.kanal})`);
        const detailZeilen: Zeile[] = [
          ...(view.kopf.modell ? [{ label: 'Modell', wert: view.kopf.modell }] : []),
          ...view.verbindung,
          ...(misst.length > 0
            ? [{ label: 'Misst', wert: Array.from(new Set(misst)).join(' · ') }]
            : []),
          ...(schaltet.length > 0 ? [{ label: 'Schaltet', wert: schaltet.join(' · ') }] : []),
          ...(gesichtView.sektionen.includes('grenzen') ? grenzen : []),
          ...bezuege,
        ];
        const details = {
          kurz: [view.verbindung.find((z) => z.label === 'Anbindung')?.wert,
            view.verbindung.find((z) => z.label === 'Lesetakt')?.wert]
            .filter(Boolean).join(' · ') || null,
          inhalt: (
            <>
              {hinweisSatz && <p className="vp-note">{hinweisSatz}</p>}
              {view.verbindungLeer && <p className="vp-note">{view.verbindungLeer}</p>}
              {view.komponentenLeer && <p className="vp-note">{view.komponentenLeer}</p>}
              <ZeilenListe zeilen={detailZeilen} />
              {view.bms.length > 0 && (
                <Block titel="BMS" icon="battery">
                  <p className="vp-note">
                    Diese Werte meldet der Wechselrichter über die Batterie, die per CAN an ihm
                    angemeldet ist - er misst sie nicht selbst.
                  </p>
                  <ZeilenListe zeilen={view.bms} />
                </Block>
              )}
              <p className="vp-geraet-sec-sub">
                <a href={komponentenHref}>In der Zentrale ansehen →</a>
                {/* Der Wohnort der Regeln bleibt die Steuerung (PR 3c) - der Weg
                    steht an jedem Gerät, das VoltPilot steuert oder eine Regel nutzt. */}
                {(view.kopf.steuerAbzeichen || steuerung
                  || bezuege.some((z) => z.label === 'Regeln, die dieses Gerät nutzen')) && (
                  <>
                    {' · '}
                    <a href={hashForRoute(anlageRoute(site.id, 'steuerung'))}>Regeln dieser Anlage →</a>
                  </>
                )}
              </p>
            </>
          ),
        };

        // --- Technik & Diagnose -------------------------------------------
        const technik: TechnikTeil[] = [];
        if (registerSektion || hatMessbibliothek) {
          technik.push({
            id: 'register',
            // D3: „Register" wäre an einem HTTP-Gerät das falsche Wort, die
            // Fähigkeit ist es nicht.
            titel: registerSektion ? null : 'Messwerte',
            inhalt: (
              <>
                {beobachtung}
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
                    source={src}
                    familie={(targets ?? []).find((t) => (geraetId
                      ? t.entityId != null
                        && view.komponenten.some((c) => c.entityId === t.entityId)
                      : t.lane === 'primary'))?.family ?? null}
                    knowledge={knowledge}
                    now={now}
                  />
                )}
              </>
            ),
          });
        }
        const summenwert = summenwertEinstieg(view);
        if (summenwert && boxDevice?.id && geraetId) {
          technik.push({
            id: 'auswertung',
            inhalt: (
              <>
                <GeraetSummenwerte
                  siteId={site.id}
                  deviceId={boxDevice.id}
                  entityId={summenwert}
                  entityIds={[...new Set(view.komponenten.map((k) => k.entityId))]}
                  geraetName={view.kopf.titel}
                  geraetId={geraetId}
                  onZuordnungGeaendert={() => setPvReload((x) => x + 1)}
                />
                {/* Das ÄNDERUNGSPROTOKOLL (UEMS AP-04 IP-21): was sich an Quellen,
                    Einstellungen und Ein-/Ausbau dieses Geräts geändert hat. */}
                <GeraetProtokoll
                  siteId={site.id}
                  entityIds={view.komponenten.map((c) => c.entityId)}
                />
              </>
            ),
          });
        }
        if (editRow || view.einrichtung.length > 0 || gefahr?.kind === 'geschuetzt') {
          technik.push({
            id: 'einrichtung',
            inhalt: (
              <>
                {/* Die Karte HEISST schon „Einrichtung" - ihr Stand steht als Satz,
                    nicht noch einmal unter derselben Überschrift. */}
                {view.einrichtung.map((z) => (
                  <p key={z.label} className="vp-geraet-einrichtung">
                    {`${z.wert.charAt(0).toUpperCase()}${z.wert.slice(1)}.`}
                  </p>
                ))}
                {editRow && (
                  <div className="vp-geraet-versionen" data-testid="geraet-fassungen">
                    <p className="vp-geraet-sec-sub">
                      {(() => {
                        const stand = editRow.syncStatus === 'in_sync' ? 'auf der Box aktiv'
                          : editRow.syncStatus === 'pending' ? 'Aktivierung läuft'
                            : 'Bestätigung der Box ausstehend';
                        return view.einrichtung.length > 0
                          ? `${stand.charAt(0).toUpperCase()}${stand.slice(1)}`
                          : `Fassung ${editRow.definitionVersion} · ${stand}`;
                      })()}
                    </p>
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
                  </div>
                )}
                {gefahr?.kind === 'geschuetzt' && <p className="vp-note">{gefahr.grund}</p>}
              </>
            ),
          });
        }
        if (view.diagnose.length > 0) {
          technik.push({ id: 'rohdaten', inhalt: <ZeilenListe zeilen={view.diagnose} /> });
        }
        if (showTechnicalLayer() && adminView) {
          technik.push({
            id: 'plattform',
            inhalt: (
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
            ),
          });
        }

        return (
          <GeraetRahmen
            testId="geraet-rahmen"
            geraetKey={`${site.id}:${geraetId ?? geraeteRef}`}
            brotkrume={{ anlageHref, komponentenHref }}
            kopf={{
              titel: view.kopf.titel,
              typ: typWort(gesichtView),
              modell: view.kopf.anschluss ?? view.kopf.modell,
              symbol: kopfSymbol(gesichtView),
              zustand: view.kopf.zustand,
              frische: src?.readAt ?? null,
              hinweis,
              abzeichen: (
                <>
                  {view.kopf.steuerAbzeichen && (
                    <span className="vp-kern-abzeichen is-steuert">
                      <Icon name="zap" size={13} /> {view.kopf.steuerAbzeichen}
                    </span>
                  )}
                  {/* „nur Messung" steht NUR hier - die Bühne wiederholt es nicht. */}
                  {!view.kopf.steuerAbzeichen && !gesichtView.ioModul
                    && (gesichtView.gattung === 'zaehler' || gesichtView.gattung === 'pv-melder'
                      || gesichtView.gattung === 'wechselrichter'
                      || gesichtView.gattung === 'wechselrichter-speicher') && (
                    <span className="vp-kern-abzeichen" title={NUR_LESEN}>
                      <Icon name="activity" size={13} /> nur Messung
                    </span>
                  )}
                  {gesichtView.gattung === 'zaehler' && massgeblich && (
                    <span className="vp-kern-abzeichen">maßgeblich für die Bilanz</span>
                  )}
                </>
              ),
            }}
            menue={menue}
            kopfAktion={bearbeitbar ? (
              <button type="button" className="vp-btn vp-btn--outline vp-btn--md" onClick={bearbeiten}>
                <Icon name="pencil" size={15} /> Bearbeiten
              </button>
            ) : null}
            veraltet={view.kopf.zustand.ton === 'warn'}
            bausteine={{
              buehne,
              steuerung: steuerungBaustein,
              heute,
              aktivitaet,
            }}
            details={details}
            technik={technik}
          />
        );
      })()}

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
      {gefahr && (
        <GeraetGefahrenzone
          siteId={site.id}
          zustand={gefahr}
          name={gefahrName}
          offen={entfernenOffen}
          onSchliessen={() => setEntfernenOffen(false)}
          onDone={() => {
            setEntfernenOffen(false);
            setEditNotice(gefahr.kind === 'batterie'
              ? 'Die Batterie wurde am Standort abgemeldet.'
              : 'Die Komponente wurde entfernt.');
            setData(null);
            setReloadKey((key) => key + 1);
          }}
        />
      )}
      {/* Die zwei BESTEHENDEN Dialoge der Steuerung - kein neuer Weg, nur ein
          weiterer Wirt. */}
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

/** Symbol und Farbe im Kopf - aus der Energiefluss-Familie. */
function kopfSymbol(g: Gesicht): KernSymbol {
  if (g.ioModul) return { icon: 'sliders', farbe: 'io' };
  if (g.eigenbau) return { icon: 'code', farbe: 'neutral' };
  switch (g.gattung) {
    case 'wechselrichter-speicher':
      return { icon: 'battery-charging', farbe: 'batt' };
    case 'wechselrichter':
    case 'pv-melder':
      return { icon: 'sun', farbe: 'pv' };
    case 'zaehler':
      return { icon: 'activity', farbe: 'grid' };
    case 'verbraucher':
      return { icon: 'zap', farbe: 'load' };
    case 'ladepunkt':
      return { icon: 'zap', farbe: 'ev' };
    default:
      return { icon: 'cpu', farbe: 'neutral' };
  }
}

/**
 * Der Baustein „Heute" - oder null, wenn dieses Gerät keine Hauptgröße hat
 * oder ihr Abruf ausgefallen ist (dann fällt er still weg).
 */
function heuteBaustein(
  siteId: string,
  g: Gesicht | null,
  view: GeraetSeiteView,
  setAusfall: (v: boolean) => void,
  ausfall: boolean,
): BausteinInhalt | null {
  if (!g || ausfall) return null;
  const kanal = heuteKanal(g, view.komponenten, g.held.werte.massgeblich);
  if (!kanal) return null;
  return {
    titel: `Heute · ${kanal.titel}`,
    kopfRechts: (
      <a href={verlaufHash(siteId, { entityId: kanal.entityId, channel: kanal.channel }, 'day')}>
        Verlauf <Icon name="chevron-right" size={14} />
      </a>
    ),
    inhalt: <GeraetHeute siteId={siteId} kanal={kanal} onAusfall={setAusfall} />,
  };
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
                  <a href={hashForRoute(anlageRoute(siteId, 'modell'))}>Zum {AUFBAU_REITER} →</a>
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

