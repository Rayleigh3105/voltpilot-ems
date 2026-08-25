import { useEffect, useMemo, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { VpPicker } from '../components/VpPicker';
import {
  api,
  ApiError,
  type CommandHistory,
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
  type GeraetArt,
  type GeraetSeiteView,
  type Zeile,
} from '../geraetSeite';
import {
  abregelungDiesesGeraets,
  gesicht,
  OHNE_REGISTER_SATZ,
  type Gesicht,
  type Held,
  type HeldKachel,
  type SektionId,
} from '../geraetGesicht';
import { inUrl, LEER, type BefehlFilter } from '../befehleFilter';
import { plantModel, type PlantComponent } from '../komponenten';
import { fmtNum } from '../format';
import { deviceLimitLine, exportGuardView, WAECHTER_LABEL } from '../curtailment';
import { COMPONENT_ROLE_ICONS } from '../komponenten';
import type { IconName } from '../../designsystem/components/core/Icon';
import { EmptyState, ErrorState, TextSkeleton } from '../components/States';
import { anlageRoute, befehleGeraetHash, boxSeiteHash, hashForRoute, pageRoute } from '../nav';
import {
  ABRUF_HINWEIS,
  abrufZeile,
  KEINE_REGISTER,
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
  BEFEHLE_LABEL,
  genauigkeitsSatz,
  geraeteAusschnitt,
  NUR_LESEN,
} from '../befehle';
import { useFreshnessPoll } from '../useFreshnessPoll';
import { showTechnicalLayer } from '../rollen';
import { AdminGeraetKarten } from '../components/AdminGeraetKarten';
import { AnlegenFlow } from '../components/AnlegenFlow';
import { GeraetVerschiebenDialog } from '../components/GeraetVerschiebenDialog';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { geraetView, type GeraetView } from '../adminGeraet';
import { adminApi } from '../admin/adminApi';
import { fleetApi } from '../admin/fleetApi';
import { NO_DATA } from '../nodata';
import { OcppWallboxPage } from './OcppWallboxPage';
import '../components/AnlagenModell.css';
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
  const [topology, setTopology] = useState<SiteTopology | null>(null);
  const [sources, setSources] = useState<SiteSource[] | null>(null);
  const [components, setComponents] = useState<SiteComponents | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [versions, setVersions] = useState<ComponentDefinition[]>([]);
  const [rollbackTarget, setRollbackTarget] = useState<ComponentDefinition | null>(null);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [control, setControl] = useState<ControlStatus | null>(null);
  const [curtailment, setCurtailment] = useState<CurtailmentStatus | null>(null);
  const [edgeVersions, setEdgeVersions] = useState<EdgeVersion[] | null>(null);
  const [charging, setCharging] = useState<SiteCharging | null>(null);
  const [strategies, setStrategies] = useState<Record<string, EntityStrategy[]> | null>(null);
  const [commands, setCommands] = useState<CommandHistory | null>(null);
  const [targets, setTargets] = useState<RegisterWriteTarget[] | null>(null);
  const [writes, setWrites] = useState<RegisterWriteEvent[] | null>(null);
  const [knowledge, setKnowledge] = useState<RegisterKnowledgeFamily[] | null>(null);
  // Die PLATTFORM-Sicht: vier zusätzliche Reads, die es NUR hinter dem einen
  // Tor überhaupt gibt (M7 `showTechnicalLayer`) - ein Kunde holt sie nie.
  const [adminView, setAdminView] = useState<GeraetView | null>(null);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminFehler, setAdminFehler] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    setData(null);
    setError(false);
    // Der EINE tragende Abruf - ohne ihn gibt es kein Gerät zu zeigen.
    api.siteEntities(site.id).then(
      (d) => active && setData(d),
      () => active && setError(true),
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
    soft(api.siteComponents(site.id), setComponents);
    soft(api.controlStatus(site.id), setControl);
    soft(api.curtailmentStatus(site.id), setCurtailment);
    soft(api.edgeVersions(), setEdgeVersions);
    soft(api.siteChargers(site.id), setCharging);
    soft(api.entityStrategies(site.id), setStrategies);
    // Sektion F: der Verlauf DIESES Geräts. Der Server entscheidet, was zu ihm
    // gehört (`?device=`) - die Fläche schneidet nichts selbst zurecht.
    soft(api.commandHistory(site.id, { device: geraetId ?? geraeteRef }), setCommands);
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
  }, [site.id, geraeteRef, geraetId, boxDevice?.id, reloadKey]);

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
  }, 30_000);

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
      now,
    });
  }, [view, data, components, sources, charging, control, curtailment, strategies,
    geraetId, geraeteRef, box?.id, now]);

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
  const ohneRegisterSatz = gesichtView && !gesichtView.sektionen.includes('register')
    ? (gesichtView.gattung === 'ladepunkt' ? KEINE_REGISTER.ladepunkt : OHNE_REGISTER_SATZ)
    : null;

  return (
    <div className="vp-geraet">
      <a className="vp-geraet-back" href={hashForRoute(anlageRoute(site.id, 'modell'))}>
        <Icon name="chevron-left" size={16} /> Zurück zu den Komponenten
      </a>

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

      {view && view.gefunden && gesichtView?.gattung === 'ladepunkt' && chargePointIdOf(geraetId) && (
        <OcppWallboxPage
          siteId={site.id}
          chargePointId={chargePointIdOf(geraetId) as string}
          fallbackTitle={view.kopf.titel}
          backHref={hashForRoute(anlageRoute(site.id, 'modell'))}
        />
      )}

      {view && view.gefunden && gesichtView?.gattung !== 'ladepunkt' && (
        <>
          <Card padding="lg" radius="lg" className="vp-geraet-kopf">
            <div className="vp-geraet-titleline">
              <h1>{view.kopf.titel}</h1>
              {components?.componentAuthority === 'portal' && editRow && (
                <button type="button" className="vp-btn vp-btn--outline vp-btn--md" onClick={() => setEditOpen(true)}>
                  <Icon name="pencil" size={15} /> Bearbeiten
                </button>
              )}
              {components?.componentAuthority === 'portal' && boxDevice && (
                <button type="button" className="vp-btn vp-btn--outline vp-btn--md" onClick={() => setMoveOpen(true)}>
                  <Icon name="map-pin" size={15} /> Gerät verschieben
                </button>
              )}
            </div>
            <div className="vp-geraet-meta">
              <span>{view.kopf.unterzeile}</span>
              <span className="vp-mono vp-geraet-kennung">{view.kopf.kennung}</span>
              <span
                className={`vp-pill vp-pill-${view.kopf.zustand.ton}`}
                data-testid="geraet-zustand"
              >
                <span className={`vp-health-dot vp-health-${view.kopf.zustand.ton}`} />
                {view.kopf.zustand.wort}
                {view.kopf.zustand.detail && <small> · {view.kopf.zustand.detail}</small>}
              </span>
              {view.kopf.steuerAbzeichen && (
                <span className="vp-geraet-ctrl">
                  <Icon name="zap" size={13} /> {view.kopf.steuerAbzeichen}
                </span>
              )}
              {view.kopf.pflegeOrt && (
                <span className="vp-pill vp-pill-info">{view.kopf.pflegeOrt}</span>
              )}
            </div>
            {editRow && (
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
            )}
          </Card>

          {/* Der HELD: die Frage, die DIESE Gattung zuerst beantwortet. Er
              steht über dem Raster, weil er die ganze Breite trägt. */}
          {gesichtView?.sektionen.includes('jetzt') && (
            <HeldKarte held={gesichtView.held} stand={view.liveStand} />
          )}

          <div className="vp-geraet-grid">
            {(gesichtView?.sektionen ?? []).map((id: SektionId) => {
              switch (id) {
                case 'jetzt':
                  return null; // steht über dem Raster
                case 'befehle':
                  return (
                    <BefehleSektion
                      key={id}
                      siteId={site.id}
                      geraetRef={geraetId ?? geraeteRef}
                      history={commands}
                      now={now}
                    />
                  );
                case 'komponenten':
                  return (
                    <Sektion key={id} titel="Misst & steuert" icon="layers" breit>
                      {view.komponentenLeer && <p className="vp-note">{view.komponentenLeer}</p>}
                      {view.komponenten.length > 0 && (
                        <ul className="vp-geraet-komps">
                          {view.komponenten.map((c) => (
                            <KomponentenZeile key={c.id} komponente={c} siteId={site.id} />
                          ))}
                        </ul>
                      )}
                    </Sektion>
                  );
                case 'grenzen':
                  return (
                    <Sektion key={id} titel="Grenzen dieses Geräts" icon="shield" breit>
                      <ZeilenListe zeilen={grenzen} />
                    </Sektion>
                  );
                case 'einspeise':
                  return (
                    <Sektion key={id} titel="Einspeise-Begrenzung" icon="shield" breit>
                      <ZeilenListe zeilen={einspeiseZeilen} />
                    </Sektion>
                  );
                case 'ausfallschutz':
                  return (
                    <Sektion key={id} titel="Ausfall-Schutz" icon="shield">
                      <ZeilenListe zeilen={ausfallschutz} />
                    </Sektion>
                  );
                case 'register':
                  return (
                    <RegisterSektion
                      key={id}
                      siteId={site.id}
                      boxDeviceId={box?.id ?? null}
                      geraetName={view.kopf.titel}
                      art={view.art}
                      entityIds={view.komponenten.map((c) => c.entityId)}
                      targets={targets}
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
                  );
                case 'verbindung':
                  return (
                    <Sektion key={id} titel="Verbindung & Gesundheit" icon="wifi">
                      {view.verbindungLeer && <p className="vp-note">{view.verbindungLeer}</p>}
                      <ZeilenListe zeilen={view.verbindung} />
                    </Sektion>
                  );
                case 'ladepark':
                  return (
                    <Sektion key={id} titel="Diese Säule im Ladepark" icon="zap">
                      <ZeilenListe zeilen={ladepark} />
                      <p className="vp-geraet-sec-sub">
                        <a href={hashForRoute(anlageRoute(site.id, 'ladevorgaenge'))}>
                          Ladevorgänge dieser Anlage ansehen →
                        </a>
                      </p>
                    </Sektion>
                  );
                case 'software':
                  return (
                    <Sektion key={id} titel="Software" icon="settings">
                      <ZeilenListe zeilen={view.software} />
                      {(view.diagnose.length > 0 || ohneRegisterSatz) && (
                        <details className="vp-geraet-diagnose">
                          <summary>
                            <Icon name="chevron-right" size={12} /> Diagnose (technisch)
                          </summary>
                          {/* Die entfallene Register-Sektion VERSCHWINDET nicht,
                              ihr Grund zieht hierher (die Box-Lehre der Stufe 1). */}
                          {ohneRegisterSatz && <p className="vp-note">{ohneRegisterSatz}</p>}
                          <ZeilenListe zeilen={view.diagnose} />
                        </details>
                      )}
                    </Sektion>
                  );
                default:
                  return null;
              }
            })}
          </div>

          {/* Die Steuerungs-Bezüge stehen NACH den Gattungs-Sektionen: sie sind
              in jeder Gattung dieselbe Auskunft, und der Wohnort der REGELN
              bleibt die Steuerung (Anlagen-Zentrale Stufe 3, §13.3). */}
          <div className="vp-geraet-grid">
            <Sektion titel="Steuerungs-Bezüge" icon="shield">
              {/* ⚠ Der Einspeise-Wächter steht dort, wo die Gattung ihn führt -
                  nie zweimal auf einem Bildschirm (im Browser aufgefallen). */}
              <ZeilenListe zeilen={view.steuerung.filter(
                (z) => !(gesichtView?.sektionen.includes('einspeise')
                  && z.label === WAECHTER_LABEL),
              )} />
              <p className="vp-geraet-sec-sub">
                <a href={hashForRoute(anlageRoute(site.id, 'steuerung'))}>
                  Regeln und Betriebsmodelle dieser Anlage ansehen →
                </a>
              </p>
            </Sektion>
          </div>

          {/* Die PLATTFORM-Sicht: additiv, hinter dem EINEN Tor (M7). Ein Kunde
              sieht sie nie - und weil sie in ihrem eigenen, benannten Aufklapper
              steht, ist die Wiederholung des Software-Stands eine bewusste
              zweite LESEHÖHE, keine Doppelung auf derselben Karte (dasselbe
              Muster wie die Installateur-Ansicht der Zentrale). */}
          {showTechnicalLayer() && adminView && (
            <details className="vp-geraet-admin" data-testid="geraet-admin">
              <summary>
                <Icon name="shield" size={16} /> Plattform-Sicht (Admin)
              </summary>
              <AdminGeraetKarten
                view={adminView}
                busy={adminBusy}
                onNavigateSteuerung={() => {
                  window.location.hash = hashForRoute(pageRoute('steuerungs-freigabe'));
                }}
                onAssign={adminView.device.deviceId ? async (releaseSeq, channel, pinned) => {
                  await adminAktion(() => adminApi.setUpdateTarget(
                    adminView.device.deviceId as string, { releaseSeq, channel, pinned }));
                } : undefined}
                onRevert={adminView.device.deviceId && adminView.device.soll ? async () => {
                  await adminAktion(() => adminApi.revertUpdateTarget(
                    adminView.device.deviceId as string));
                } : undefined}
                onApply={adminView.device.deviceId && adminView.device.soll ? () => {
                  void adminAktion(() => adminApi.requestApply(
                    adminView.device.deviceId as string));
                } : undefined}
              />
              {adminFehler && <p className="vp-alert vp-alert-err">{adminFehler}</p>}
            </details>
          )}

          {editOpen && editRow && (
            <AnlegenFlow
              siteId={site.id}
              box={boxDevice}
              bearbeiten={editRow}
              onClose={() => setEditOpen(false)}
              onSaved={(result) => setComponents(result)}
            />
          )}
          {moveOpen && boxDevice && (
            <GeraetVerschiebenDialog
              device={boxDevice}
              onClose={() => setMoveOpen(false)}
              onMoved={(moved) => {
                window.location.hash = boxSeiteHash(moved.siteId, moved.externalRef);
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

        </>
      )}
    </div>
  );
}

/**
 * Der HELD einer Gattung - das Erste, was die Seite zeigt.
 *
 * <p>Er RENDERT nur: Kacheln, Satz, Hinweis und der ruhige Auslastungs-Balken
 * kommen aus `geraetGesicht.ts`. Ohne Kachel UND ohne Satz entsteht gar keine
 * Karte - ein leerer Held wäre die Box-Lehre in klein.
 */
function HeldKarte({ held, stand }: { held: Held; stand: string | null }) {
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
                k.ton ? ` is-${k.ton}` : ''}`}
              key={k.label}
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
              <th>Register</th>
              <th>Bedeutung</th>
              <th>Roh</th>
              <th>Dekodiert</th>
              <th>Gelesen</th>
              <th>Quelle</th>
            </tr>
          </thead>
          <tbody>
            {zeilen.map((z) => (
              <tr key={z.key}>
                <td data-label="Register">{z.register ?? NO_DATA}</td>
                <td data-label="Bedeutung">
                  {z.bedeutung}
                  {/* Die Warnklasse trägt ihr WORT, nie nur eine Farbe. */}
                  {klasseWort(z.klasse) && (
                    <span className={`vp-regklasse is-${klasseTon(z.klasse)}`}>
                      {klasseWort(z.klasse)}
                    </span>
                  )}
                </td>
                <td data-label="Roh">{z.roh}</td>
                <td data-label="Dekodiert">{z.dekodiert}</td>
                <td data-label="Gelesen">{z.gelesen}</td>
                <td data-label="Quelle">{QUELLE_WORT[z.quelle]}</td>
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
  exportLimit,
  writes,
  source,
  familie,
  knowledge,
  now,
}: {
  siteId: string;
  boxDeviceId: string | null;
  geraetName: string;
  /** Die Gattung entscheidet das Ziel - das Hauptgerät IST die primäre Lane. */
  art: GeraetArt;
  entityIds: string[];
  targets: RegisterWriteTarget[] | null;
  exportLimit: DeviceExportLimit | null;
  writes: RegisterWriteEvent[] | null;
  source: SiteSource | null;
  familie: string | null;
  knowledge: RegisterKnowledgeFamily[] | null;
  now: number;
}) {
  const [offen, setOffen] = useState(false);
  const [leseAdresse, setLeseAdresse] = useState('');
  const [leseArt, setLeseArt] = useState<'holding' | 'input' | 'coil'>('holding');
  const [liest, setLiest] = useState(false);
  const [leseFehler, setLeseFehler] = useState<string | null>(null);
  const [abruf, setAbruf] = useState<RegisterZeile[]>([]);
  // ⚠ Geschrieben wird IMMER über die Box - sie hält die Verbindung zum Gerät.
  // Ohne sie gibt es kein Ziel und damit keinen Knopf.
  const zugang: GeraetRegisterZugang = targets == null
    // Noch nicht geladen: es wird NICHTS behauptet - weder ein Weg noch sein
    // Fehlen.
    ? { moeglich: false, grund: null, vorwahl: null, weg: null }
    : boxDeviceId
      ? geraetRegisterZugang(targets, { art, deviceId: boxDeviceId, entityIds })
      // Ohne beanspruchte Box gibt es kein Gerät, über das geschrieben würde.
      : { moeglich: false, grund: KEIN_SCHREIBWEG, vorwahl: null, weg: null };
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
        setLeseFehler(sicht.satz);
        return;
      }
      setAbruf((bisher) => [
        abrufZeile(adresse, out, new Date()),
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
    <Sektion titel="Register" icon="list" breit>
      <GeleseneRegisterTabelle
        art={art}
        exportLimit={exportLimit}
        writes={writes}
        source={source}
        familie={familie}
        knowledge={knowledge}
        entityIds={entityIds}
        abruf={abruf}
        now={now}
      />
      {zugang.moeglich && (
        <div className="vp-geraet-lesen">
          <label>
            <span>Register jetzt lesen</span>
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
            label="Art"
            ariaLabel="Registerart"
            options={[
              { value: 'holding', label: 'Holding-Register' },
              { value: 'input', label: 'Input-Register' },
              { value: 'coil', label: 'Spule' },
            ]}
            value={leseArt}
            onChange={(v) => setLeseArt(v as 'holding' | 'input' | 'coil')}
          />
          <button
            type="button"
            className="vp-geraet-btn"
            onClick={() => void jetztLesen()}
            disabled={liest || !leseAdresse.trim()}
            data-testid="geraet-regread"
          >
            <Icon name="search" size={13} /> {liest ? LESE_LAEUFT : 'Jetzt lesen'}
          </button>
          {liest && <p className="vp-note">{LESE_DAUER_HINWEIS}</p>}
          {leseFehler && <p className="vp-alert vp-alert-warn">{leseFehler}</p>}
          {abruf.length > 0 && <p className="vp-note">{ABRUF_HINWEIS}</p>}
        </div>
      )}
      <p className="vp-text-sm">{EXPERTE_INTRO}</p>
      {zugang.moeglich ? (
        <button
          type="button"
          className="vp-geraet-btn"
          onClick={() => setOffen(true)}
          data-testid="geraet-regwrite"
        >
          <Icon name="pencil" size={13} /> Register schreiben
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
    </Sektion>
  );
}

/**
 * F · Befehle an dieses Gerät (Anlagen-Zentrale Stufe 1, Konzept §7.4).
 *
 * <p>Sie zeigt die JÜNGSTEN Zeilen des heutigen Tages und führt für alles
 * Weitere auf die Befehle-Seite (Captain-Entscheid D3: die Seite bleibt, die
 * Geräteseite zeigt die gefilterte Sicht) - es entsteht also keine zweite
 * Verlaufs-Fläche, nur ein Ausschnitt derselben.
 *
 * <p><b>Sie erfindet keinen Satz:</b> Zeilen, Leer-Satz und Aufzeichnungs-Beginn
 * kommen aus der reinen `src/befehle.ts`, die auch die Befehle-Seite rendert.
 * Was zu diesem Gerät gehört, entscheidet der SERVER (`?device=`).
 */
function BefehleSektion({
  siteId,
  geraetRef,
  history,
  now,
}: {
  siteId: string;
  geraetRef: string;
  history: CommandHistory | null;
  now: number;
}) {
  // Der Schnell-Chip (Geräteseiten Revision B §6): er filtert den MINI-Film
  // clientseitig - die Zeilen sind schon da, ein zweiter Abruf wäre Aufwand
  // ohne Gewinn - und reist im „Alle anzeigen"-Link als Filter mit, damit der
  // Zustand nicht am Sprung verloren geht.
  //
  // ⚠ Der zweite Chip der Spezifikation („Heute") fehlt hier BEWUSST: dieser
  // Ausschnitt IST der Tag (der Abruf oben nimmt den Vorgabe-Zeitraum), ein
  // Chip könnte also nichts ändern. Ein Bedienelement, das nichts bewirken
  // kann, wird nicht angeboten - dieselbe Regel wie beim Anwenden-Knopf.
  const [nurAbweichungen, setNurAbweichungen] = useState(false);
  const gefiltert = useMemo(
    () => ({
      ...history,
      entries: (history?.entries ?? []).filter(
        (e) => !nurAbweichungen || e.verdict === 'abweichend' || e.foreignInfluence === true,
      ),
    } as CommandHistory | null),
    [history, nurAbweichungen],
  );
  const ausschnitt = geraeteAusschnitt(history ? gefiltert : null, now, 5);
  const chipFilter: BefehlFilter = {
    ...LEER,
    ergebnis: nurAbweichungen ? ['abweichend'] : [],
  };
  return (
    <Sektion titel={BEFEHLE_LABEL} icon="activity" breit>
      {/* EIN Chip, mehr nicht: alles Weitere beantwortet die Befehle-Seite,
          und der Zustand reist über die Adresse mit. */}
      <div className="vp-bf-chips vp-geraet-befehl-chips">
        <button
          type="button"
          className={`vp-bf-chip${nurAbweichungen ? ' is-an' : ''}`}
          aria-pressed={nurAbweichungen}
          onClick={() => setNurAbweichungen((v) => !v)}
        >
          Nur Abweichungen
        </button>
      </div>
      {/* Die F4-Antwort: an dieses Gerät geht gar kein Befehl. Sie steht VOR
          der Liste, damit ein leerer Verlauf nicht als Zufall gelesen wird. */}
      {history && !history.writes && (
        <p className="vp-geraet-readonly">
          <Icon name="shield" size={15} /> {NUR_LESEN}
        </p>
      )}
      {ausschnitt.zeilen.length > 0 && (
        <ol className="vp-geraet-befehle">
          {ausschnitt.zeilen.map((z) => (
            <li key={z.id} className={`vp-geraet-befehl is-${z.ton}`}>
              <span className="zeit">{z.zeit}</span>
              <div className="tx">
                {z.strom && <span className="strom">{z.strom}</span>}
                <p>{z.satz}</p>
                {z.urteil && <span className="urteil">{z.urteil}</span>}
              </div>
            </li>
          ))}
        </ol>
      )}
      {ausschnitt.leer && <p className="vp-note">{ausschnitt.leer}</p>}
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
        href={inUrl(
          history?.deviceIsBox === true
            ? hashForRoute(anlageRoute(siteId, 'befehle'))
            : befehleGeraetHash(siteId, geraetRef),
          chipFilter,
        )}
      >
        {history?.deviceIsBox === true
          ? 'Alle Befehle dieser Anlage'
          : ausschnitt.weitere > 0
            ? `Alle anzeigen (${ausschnitt.weitere} weitere)`
            : 'Alle anzeigen'}
        <Icon name="chevron-right" size={14} />
      </a>
    </Sektion>
  );
}

/** Eine Sektion der Seite - Überschrift, optionaler Zusatz, Inhalt. */
function Sektion({
  titel,
  icon,
  zusatz,
  breit,
  children,
}: {
  titel: string;
  icon: IconName;
  zusatz?: string | null;
  breit?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card padding="lg" radius="lg" className={`vp-geraet-sec${breit ? ' breit' : ''}`}>
      <div className="vp-geraet-sec-head">
        <Icon name={icon} size={16} />
        <h2>{titel}</h2>
        {zusatz && <span className="vp-geraet-sec-sub">{zusatz}</span>}
      </div>
      {children}
    </Card>
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
