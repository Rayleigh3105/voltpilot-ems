import { useEffect, useMemo, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
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
  type SiteEntities,
  type SiteSource,
  type SiteTopology,
} from '../api';
import type { SiteCharging } from '../ladepunkte';
import {
  geraetSeite,
  type BoxGeraet,
  type GeraetSeiteView,
  type Zeile,
} from '../geraetSeite';
import { plantModel, type PlantComponent } from '../komponenten';
import { COMPONENT_ROLE_ICONS } from '../komponenten';
import type { IconName } from '../../designsystem/components/core/Icon';
import { unclaimConsequences } from '../components/DeviceDrawers';
import { DangerZone } from '../components/DangerZone';
import { EmptyState, ErrorState, TextSkeleton } from '../components/States';
import { anlageRoute, befehleGeraetHash, geraetSeiteHash, hashForRoute, pageRoute } from '../nav';
import {
  QUELLE_WORT,
  registerSicht,
} from '../geraetRegister';
import { klasseTon, klasseWort } from '../registerWrite';
import {
  EXPERTE_INTRO,
  geraeteVerlauf,
  KEIN_SCHREIBWEG,
  geraetRegisterZugang,
  type GeraetRegisterZugang,
} from '../registerWrite';
import { RegisterWriteDrawer } from '../components/RegisterWriteDrawer';
import {
  ANLAGENWEITE_BEFEHLE,
  aufzeichnungSeit,
  BEFEHLE_LABEL,
  genauigkeitsSatz,
  geraeteAusschnitt,
  NUR_LESEN,
} from '../befehle';
import { useFreshnessPoll } from '../useFreshnessPoll';
import { showTechnicalLayer } from '../rollen';
import { AdminGeraetKarten } from '../components/AdminGeraetKarten';
import { geraetView, type GeraetView } from '../adminGeraet';
import { adminApi } from '../admin/adminApi';
import { fleetApi } from '../admin/fleetApi';
import { NO_DATA } from '../nodata';
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
  onDeviceRemoved,
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
  /** Nach einem Unclaim: die Schale lädt neu und verlässt die Seite. */
  onDeviceRemoved?: () => void;
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

  return (
    <div className="vp-geraet">
      <a className="vp-geraet-back" href={hashForRoute(anlageRoute(site.id, 'modell'))}>
        <Icon name="chevron-left" size={16} /> Zurück zum Anlagen-Modell
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

      {view && view.gefunden && (
        <>
          <Card padding="lg" radius="lg" className="vp-geraet-kopf">
            <h1>{view.kopf.titel}</h1>
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
          </Card>

          <div className="vp-geraet-grid">
            <Sektion titel="Verbindung & Gesundheit" icon="wifi">
              {view.verbindungLeer && <p className="vp-note">{view.verbindungLeer}</p>}
              <ZeilenListe zeilen={view.verbindung} />
            </Sektion>

            {view.art === 'box' ? (
              <Sektion titel="Geräte an dieser Box" icon="cpu">
                {view.liveLeer && <p className="vp-note">{view.liveLeer}</p>}
                {view.boxGeraete.length > 0 && (
                  <ul className="vp-geraet-liste">
                    {view.boxGeraete.map((g) => (
                      <BoxGeraetZeile key={g.geraetId} geraet={g} siteId={site.id} ref_={geraeteRef} />
                    ))}
                  </ul>
                )}
              </Sektion>
            ) : (
              <Sektion
                titel="Live-Werte vom Gerät"
                icon="activity"
                zusatz={view.liveStand ? `Stand ${view.liveStand}` : null}
              >
                {view.liveLeer && <p className="vp-note">{view.liveLeer}</p>}
                {view.live.length > 0 && (
                  <div className="vp-geraet-kacheln">
                    {view.live.map((k) => (
                      <div className="vp-geraet-kachel" key={k.label}>
                        <span className="l">{k.label}</span>
                        <span className="v">{k.wert}</span>
                        {k.wort && <span className="w">{k.wort}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </Sektion>
            )}

            {view.art !== 'box' && (
              <Sektion titel="Misst & steuert" icon="layers" breit>
                {view.komponentenLeer && <p className="vp-note">{view.komponentenLeer}</p>}
                {view.komponenten.length > 0 && (
                  <ul className="vp-geraet-komps">
                    {view.komponenten.map((c) => (
                      <KomponentenZeile key={c.id} komponente={c} siteId={site.id} />
                    ))}
                  </ul>
                )}
              </Sektion>
            )}

            <GeleseneRegisterSektion
              art={view.art}
              exportLimit={view.art === 'hauptgeraet'
                ? curtailment?.deviceExportLimit ?? null
                : null}
              writes={writes}
              source={(sources ?? []).find((s) => s.sourceId === geraetId) ?? null}
              familie={(targets ?? []).find((t) => (geraetId
                ? t.entityId != null && view.komponenten.some((c) => c.entityId === t.entityId)
                : t.lane === 'primary'))?.family ?? null}
              knowledge={knowledge}
              entityIds={view.komponenten.map((c) => c.entityId)}
              now={now}
            />

            <RegisterSektion
              siteId={site.id}
              boxDeviceId={box?.id ?? null}
              geraetName={view.kopf.titel}
              box={view.art === 'box'}
              entityIds={view.komponenten.map((c) => c.entityId)}
              targets={targets}
            />

            <BefehleSektion
              siteId={site.id}
              geraetRef={geraetId ?? geraeteRef}
              history={commands}
              now={now}
            />

            <Sektion titel="Steuerungs-Bezüge" icon="shield">
              <ZeilenListe zeilen={view.steuerung} />
              {/* Anlagen-Zentrale Stufe 3 (PR 3c, §13.3): der Wohnort der
                  Regeln BLEIBT die Steuerung - die Geräteseite sagt nur, WELCHE
                  dieses Gerät nutzen, und führt dorthin. Ein zweiter Regel-Ort
                  wäre genau die Doppelung, die diese Stufe abräumt. */}
              <p className="vp-geraet-sec-sub">
                <a href={hashForRoute(anlageRoute(site.id, 'steuerung'))}>
                  Regeln und Modus dieser Anlage ansehen →
                </a>
              </p>
            </Sektion>

            <Sektion titel="Software" icon="settings">
              <ZeilenListe zeilen={view.software} />
              {view.diagnose.length > 0 && (
                <details className="vp-geraet-diagnose">
                  <summary>
                    <Icon name="chevron-right" size={12} /> Diagnose (technisch)
                  </summary>
                  <ZeilenListe zeilen={view.diagnose} />
                </details>
              )}
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

          {view.gefahrenzone && box && (
            <Card padding="lg" radius="lg">
              <span className="vp-card-label">Unumkehrbar</span>
              <GefahrenZone device={box} onRemoved={onDeviceRemoved} />
            </Card>
          )}
        </>
      )}
    </div>
  );
}

/**
 * D · Gelesene Register (Anlagen-Zentrale Stufe 1, Konzept §7.3).
 *
 * <p>Sie zeigt, was die Box von DIESEM Gerät liest - roh und dekodiert, jeder
 * Wert mit seiner Frische. **Die Zeilen entstehen aus dem BESTAND** (Journal,
 * Einspeisegrenze, laufende Messungen); jede Ehrlichkeitsregel steckt in der
 * reinen `geraetRegister.ts`, hier wird nur gerendert.
 */
function GeleseneRegisterSektion({
  art,
  exportLimit,
  writes,
  source,
  familie,
  knowledge,
  entityIds,
  now,
}: {
  art: string;
  exportLimit: DeviceExportLimit | null;
  writes: RegisterWriteEvent[] | null;
  source: SiteSource | null;
  familie: string | null;
  knowledge: RegisterKnowledgeFamily[] | null;
  entityIds: string[];
  now: number;
}) {
  const sicht = registerSicht({
    art,
    exportLimit,
    // Dieselbe Grenze wie beim Kommando-Verlauf: die Box hat jeden Vorgang,
    // ein Gerät dahinter nur die seiner Komponenten.
    writes: geraeteVerlauf(writes ?? [], { box: art === 'box', entityIds }),
    source,
    familie,
    knowledge,
    now,
  });
  return (
    <Sektion titel="Gelesene Register" icon="list" breit>
      {sicht.zeilen.length > 0 && (
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
            {sicht.zeilen.map((z) => (
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
      {sicht.leer && <p className="vp-note">{sicht.leer}</p>}
      {sicht.hinweis && <p className="vp-note">{sicht.hinweis}</p>}
    </Sektion>
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
  box,
  entityIds,
  targets,
}: {
  siteId: string;
  boxDeviceId: string | null;
  geraetName: string;
  box: boolean;
  entityIds: string[];
  targets: RegisterWriteTarget[] | null;
}) {
  const [offen, setOffen] = useState(false);
  // ⚠ Geschrieben wird IMMER über die Box - sie hält die Verbindung zum Gerät.
  // Ohne sie gibt es kein Ziel und damit keinen Knopf.
  const zugang: GeraetRegisterZugang = targets == null
    // Noch nicht geladen: es wird NICHTS behauptet - weder ein Weg noch sein
    // Fehlen.
    ? { moeglich: false, grund: null, vorwahl: null }
    : boxDeviceId
      ? geraetRegisterZugang(targets, { box, deviceId: box ? boxDeviceId : null, entityIds })
      // Ohne beanspruchte Box gibt es kein Gerät, über das geschrieben würde.
      : { moeglich: false, grund: KEIN_SCHREIBWEG, vorwahl: null };
  const verlaufFilter = useMemo(
    () => (rows: RegisterWriteEvent[]) => geraeteVerlauf(rows, { box, entityIds }),
    [box, entityIds.join('|')],
  );

  return (
    <Sektion titel="Register schreiben" icon="pencil" breit>
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
  const ausschnitt = geraeteAusschnitt(history, now, 5);
  return (
    <Sektion titel={BEFEHLE_LABEL} icon="activity" breit>
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
      <a className="vp-geraet-komp-link" href={befehleGeraetHash(siteId, geraetRef)}>
        {ausschnitt.weitere > 0 ? `Alle anzeigen (${ausschnitt.weitere} weitere)` : 'Alle anzeigen'}
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

/** Ein Gerät AN der Box - eine Zeile mit dem Weg auf seine eigene Seite. */
function BoxGeraetZeile({
  geraet,
  siteId,
  ref_,
}: {
  geraet: BoxGeraet;
  siteId: string;
  ref_: string;
}) {
  return (
    <li>
      <a className="vp-geraet-zeile" href={geraetSeiteHash(siteId, ref_, geraet.geraetId)}>
        <span className={`vp-health-dot vp-health-${geraet.ton}`} />
        <span className="nm">{geraet.name}</span>
        <span className="ty">{geraet.art}</span>
        <span className="st">{geraet.zustand}</span>
        <Icon name="chevron-right" size={16} />
      </a>
    </li>
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

/**
 * Die Gefahrenzone der BOX - Datenaufzeichnungen löschen und Gerät entfernen.
 * Beide Folgenlisten sind die BESTEHENDEN (`unclaimConsequences` + die Purge-
 * Liste des Geräte-Einschubs), damit die zwei Wege nie Verschiedenes
 * versprechen (die E3-Nebenwirkungs-Regel).
 */
function GefahrenZone({
  device,
  onRemoved,
}: {
  device: Device;
  onRemoved?: () => void;
}) {
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [purgeError, setPurgeError] = useState<string | null>(null);
  const [purgeDone, setPurgeDone] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const name = device.name || device.externalRef;

  return (
    <>
      {purgeDone ? (
        <div className="vp-alert vp-alert-ok">
          <b>Datenaufzeichnungen gelöscht.</b> Neue Messwerte werden ab jetzt wieder normal
          aufgezeichnet.
        </div>
      ) : (
        <DangerZone
          actionLabel="Datenaufzeichnungen löschen"
          description="Löscht alle bisher aufgezeichneten Messdaten dieses Geräts unwiderruflich. Das Gerät bleibt verbunden und zeichnet ab sofort wieder neu auf."
          consequences={[
            `Alle Messdaten von „${name}" werden endgültig gelöscht - auch aus Verlauf, Historie und Statistiken`,
            'Auch der lokale Zwischenspeicher auf dem Gerät wird geleert; ist das Gerät gerade offline, passiert das automatisch beim nächsten Verbinden',
            'Das Gerät selbst bleibt verbunden und funktioniert unverändert weiter - neue Messwerte laufen normal ein',
          ]}
          confirmLabel="Datenaufzeichnungen endgültig löschen"
          typeToConfirm={name}
          busy={purgeBusy}
          error={purgeError}
          onConfirm={() => {
            setPurgeBusy(true);
            setPurgeError(null);
            api.purgeDeviceData(device.id).then(
              () => {
                setPurgeDone(true);
                setPurgeBusy(false);
              },
              () => {
                setPurgeError(
                  'Die Datenaufzeichnungen konnten nicht gelöscht werden. Bitte versuchen Sie es erneut.',
                );
                setPurgeBusy(false);
              },
            );
          }}
        />
      )}

      <DangerZone
        actionLabel="Gerät entfernen"
        description="Falsches Gerät verbunden? Entfernen macht die Geräte-ID wieder frei - sie kann danach erneut (auch von einem anderen Konto) verbunden werden."
        consequences={unclaimConsequences(device)}
        confirmLabel="Gerät endgültig entfernen"
        busy={deleteBusy}
        error={deleteError}
        onConfirm={() => {
          setDeleteBusy(true);
          setDeleteError(null);
          api.deleteDevice(device.id).then(
            () => {
              setDeleteBusy(false);
              onRemoved?.();
            },
            () => {
              setDeleteError('Das Gerät konnte nicht entfernt werden. Bitte versuchen Sie es erneut.');
              setDeleteBusy(false);
            },
          );
        }}
      />
    </>
  );
}
