import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  api,
  ApiError,
  type ControlStatus,
  type CurtailmentStatus,
  type Device,
  type EdgeVersion,
  type Site,
  type SiteEntities,
  type SiteSource,
  type SiteTopology,
  type StandorteAmStichtag,
  type UemsDatenquelle,
  type UemsGemeinsameSteuerungZustand,
  type UemsGeraet,
} from '../api';
import { gemeinsameSteuerungAendern, wegDesWechsels } from '../uemsDatenquelle';
import type { SiteCharging } from '../ladepunkte';
import {
  BOX_ROLLE,
  boxSeite,
  GERAETE_HINWEIS,
  type BoxSeiteView,
} from '../boxSeite';
import { aufbauDerAnlage, type BoxEintrag } from '../boxGeraete';
import { consumersApi } from '../consumers/consumersApi';
import type { Consumer } from '../consumers/types';
import type { Zeile } from '../geraetSeite';
import { GeraetBrotkrume } from '../components/GeraetBrotkrume';
import {
  GeraetRahmen,
  type BausteinInhalt,
  type MenueEintrag,
  type TechnikTeil,
} from '../components/GeraetRahmen';
import { GeraetBuehne } from '../components/GeraetBuehne';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { AddDeviceDrawer, unclaimConsequences } from '../components/DeviceDrawers';
import { DatenquelleWechselDialog } from '../components/DatenquelleWechselDialog';
import { DatenquelleAnlegen } from '../components/DatenquelleAnlegen';
import { Recht } from '../components/Recht';
import { EmptyState, ErrorState, TextSkeleton } from '../components/States';
import { anlageRoute, aufbauHash, boxSeiteHash, hashForRoute, pageRoute } from '../nav';
import { einstellungenHash } from '../settingsNav';
import { UEMS_GATEWAY_ANBINDEN } from '../glossar';
import {
  aufzeichnungSeit,
  genauigkeitsSatz,
  GERAETE_BEFEHLE,
} from '../befehle';
import { BefehleVerlauf, useBefehleVerlauf } from '../components/BefehleVerlauf';
import { useFreshnessPoll } from '../useFreshnessPoll';
import { useAnlagensteuerung } from '../useAnlagensteuerung';
// LIVE: die Box-Seite zeigt gemessene Ist-Werte und Steuer-Rückmeldungen.
import { LIVE_POLL_MS } from '../pollCadence';
import { showTechnicalLayer } from '../rollen';
import { FernwartungKarte } from '../components/FernwartungKarte';
import { AdminGeraetKarten } from '../components/AdminGeraetKarten';
import { geraetView, type GeraetView } from '../adminGeraet';
import { adminApi } from '../admin/adminApi';
import { fleetApi } from '../admin/fleetApi';
import './GeraetSeite.css';
import './BoxSeite.css';

/**
 * Die BOX-Seite (`#/anlage/{siteId}/box[/{ref}]`, Scout
 * `vp-geraeteseite-rev-b8` §4.1 Gattung A · E3).
 *
 * <p>Die Box ist ein TOR, kein Gerät - und seit den Geräteseiten „Ein Blick,
 * eine Antwort" steht sie auf DEMSELBEN Kern wie jedes Gerät: ihre Bühne ist
 * die Kette Geräte → Box → VoltPilot, ihr Zusatz die GERÄTE als
 * Absprungliste, ihre Aktivität das, was sie überbringt. Software, Adresse im
 * Netzwerk und „Schutz &amp; Grenzen" stehen unter „Gerät &amp; Verbindung",
 * die Technik in ihrer eigenen Ansicht, das Entfernen im Menü „⋯" (V7).
 *
 * <p><b>Was hier bewusst FEHLT</b>, weil es die Box nie betraf: „Gelesene
 * Register" (ein Rechner hat keine), „Register schreiben" (der Auftrag ginge an
 * den Wechselrichter - sein Knopf wohnt auf SEINER Seite), Live-Werte und
 * „Misst &amp; steuert". Wer dorthin will, klickt das Gerät an - die Liste
 * steht direkt darüber.
 *
 * <p>Diese Datei RENDERT nur; jede Regel und jeder Satz liegt in der reinen
 * `src/boxSeite.ts`. Jeder Nebenabruf ist fail-soft.
 */
export function BoxSeiteSection({
  site,
  boxRef,
  devices,
  devicesFetchedAt = null,
  onDeviceRemoved,
}: {
  site: Site;
  /** Die Referenz aus der Adresse; null = die eine Box der Anlage. */
  boxRef: string | null;
  devices?: Device[];
  /** Bezugszeit der Geräteliste - die Box altert dagegen (`liveness.ts`). */
  devicesFetchedAt?: number | null;
  onDeviceRemoved?: () => void;
}) {
  const eigene = (devices ?? []).filter((d) => d.siteId === site.id);
  const boxDevice = boxRef
    ? eigene.find((d) => d.externalRef === boxRef)
    : eigene.length === 1
      ? eigene[0]
      : undefined;

  const [data, setData] = useState<SiteEntities | null>(null);
  const [sources, setSources] = useState<SiteSource[] | null>(null);
  // Dieselben Abrufe wie Anlage › Aufbau (GE-4): die Geräte an der Box kommen aus DERSELBEN Zuordnung.
  const [topology, setTopology] = useState<SiteTopology | null>(null);
  const [consumers, setConsumers] = useState<Consumer[] | null>(null);
  // Die UEMS-Geräte: ihr `data_source_id` ist der einzige Verweis Weg → Gerät (GE-1); undefined = lädt, null = unbekannt.
  const [uemsGeraete, setUemsGeraete] = useState<UemsGeraet[] | null | undefined>(undefined);
  const [control, setControl] = useState<ControlStatus | null>(null);
  const [curtailment, setCurtailment] = useState<CurtailmentStatus | null>(null);
  const [edgeVersions, setEdgeVersions] = useState<EdgeVersion[] | null>(null);
  const [charging, setCharging] = useState<SiteCharging | null>(null);
  const [datenquellen, setDatenquellen] = useState<UemsDatenquelle[] | null>(null);
  const [gemeinsameSteuerung, setGemeinsameSteuerung] = useState<UemsGemeinsameSteuerungZustand | null>(null);
  // Wohin der Wechsel einer Steuerquelle zu einem Mitglied führt (T6) — ohne Gemeinsame Steuerung der Bestand.
  const steuerquelleWeg = wegDesWechsels(true, gemeinsameSteuerung?.zustand ?? null, false, true);
  const [adminView, setAdminView] = useState<GeraetView | null>(null);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminFehler, setAdminFehler] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [loeschen, setLoeschen] = useState<'purge' | 'entfernen' | null>(null);
  const [wechselQuelle, setWechselQuelle] = useState<UemsDatenquelle | null>(null);
  // „Datenquelle anlegen“ braucht den Standort der Anlage (Box-Wahl und Netzlage gelten je Standort).
  const [standorte, setStandorte] = useState<StandorteAmStichtag | null>(null);
  const [quelleAnlegen, setQuelleAnlegen] = useState(false);
  const [tauschOffen, setTauschOffen] = useState(false);

  useEffect(() => {
    let active = true;
    setData(null);
    setError(false);
    // Der EINE tragende Abruf - er trägt die Geräte-Liste, also die Seite.
    api.siteEntities(site.id).then(
      (d) => active && setData(d),
      () => active && setError(true),
    );
    const soft = <T,>(p: Promise<T | null>, set: (v: T | null) => void) => {
      void p.then(
        (v) => {
          if (active) set(v ?? null);
        },
        () => {
          if (active) set(null);
        },
      );
    };
    soft(api.siteSources(site.id), setSources);
    soft(api.topology(site.id), setTopology);
    soft(consumersApi.list(site.id), setConsumers);
    setUemsGeraete(undefined);
    void api.uemsGeraete(site.id).then(
      (a) => active && setUemsGeraete(a.geraete),
      () => active && setUemsGeraete(null),
    );
    soft(api.controlStatus(site.id), setControl);
    soft(api.curtailmentStatus(site.id), setCurtailment);
    soft(api.edgeVersions().then((antwort) => antwort.eintraege), setEdgeVersions);
    soft(api.siteChargers(site.id), setCharging);
    soft(api.gemeinsameSteuerung(site.id), setGemeinsameSteuerung);
    soft(api.standorte(), setStandorte);
    setNow(Date.now());
    if (showTechnicalLayer() && boxDevice) {
      void Promise.all([
        adminApi.listDevices(),
        fleetApi.fleet(),
        adminApi.controlCandidates().catch(() => null),
        adminApi.edgeUpdates().catch(() => null),
      ]).then(
        ([devs, flotte, candidates, updates]) => {
          if (!active) return;
          setAdminView(geraetView({
            ref: boxDevice.externalRef,
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
  }, [site.id, boxDevice?.id, boxDevice?.externalRef, reloadKey]);

  // Die Wege aller Anlagen am Standort (wie im Aufbau): die Last einer Box zählt alles, was sie liest — auch für eine
  // Nachbaranlage. Bis die Standorte da sind, nur die eigene Anlage.
  const standortDerAnlage = standorte?.standorte.find((st) => st.anlagen.some((a) => a.id === site.id)) ?? null;
  const anlagenIds = (standortDerAnlage ? standortDerAnlage.anlagen.map((a) => a.id) : [site.id]).join(',');
  useEffect(() => {
    let active = true;
    // Wie im Aufbau: fehlt die Antwort einer Anlage, fehlen genau ihre Wege, nie die der anderen.
    Promise.all(anlagenIds.split(',').map((id) => api.datenquellen(id).then((a) => a.datenquellen, () => [] as UemsDatenquelle[])))
      .then((listen) => active && setDatenquellen(listen.flat()));
    return () => {
      active = false;
    };
  }, [anlagenIds, reloadKey]);

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

  // Zustand UND Bezugszeit ZUSAMMEN (die `liveness.ts`-Lehre); ein Fehlschlag
  // lässt beides unberührt.
  useFreshnessPoll(() => {
    Promise.all([
      api.siteSources(site.id).catch(() => null),
      api.controlStatus(site.id).catch(() => null),
      api.curtailmentStatus(site.id).catch(() => null),
      api.siteChargers(site.id).catch(() => null),
      api.topology(site.id).catch(() => null),
    ]).then(([s, c, cu, ch, t]) => {
      if (s !== null) setSources(s);
      if (t !== null) setTopology(t);
      setControl(c);
      setCurtailment(cu);
      if (ch !== null) setCharging(ch);
      setNow(Date.now());
    });
  }, LIVE_POLL_MS);

  const anlagenNamen = useMemo(
    () => new Map((standortDerAnlage?.anlagen ?? []).map((a) => [a.id, a.name])),
    [standortDerAnlage],
  );
  // GE-3: die Wechselrichter hinter einer Anlagensteuerung zählen hier wie im Aufbau (dieselbe Zählweise).
  const steuerungen = useAnlagensteuerung(site.id, true, false);
  const view: BoxSeiteView | null = useMemo(() => {
    if (!data) return null;
    const anlage = aufbauDerAnlage({
      siteId: site.id,
      siteName: site.name,
      entities: data,
      topology,
      sources,
      charging,
      consumers,
      devices: devices ?? [],
      devicesFetchedAt,
      datenquellen,
      uemsGeraete,
      anlagensteuerungen: { liste: steuerungen.liste, werte: steuerungen.werte },
      now,
    });
    return boxSeite({
      ref: boxRef,
      siteName: site.name,
      siteId: site.id,
      devices: devices ?? [],
      devicesFetchedAt,
      edgeVersions,
      control,
      curtailment,
      anlage,
      zuordnung: uemsGeraete != null,
      localSetup: data.localSetup,
      datenquellen,
      anlagenNamen,
      now,
    });
  }, [
    data, boxRef, site.name, site.id, devices, devicesFetchedAt, edgeVersions, control,
    curtailment, topology, sources, charging, consumers, datenquellen, uemsGeraete, anlagenNamen, now,
    steuerungen.liste, steuerungen.werte,
  ]);

  // DERSELBE Verlauf wie überall - der Server entscheidet weiterhin, was der
  // Box gehört (`?device=`); die Fläche schneidet nichts selbst zurecht.
  const verlauf = useBefehleVerlauf({ siteId: site.id, geraetRef: boxDevice?.externalRef ?? null });

  const anlageHref = hashForRoute(anlageRoute(site.id));
  const komponentenHref = hashForRoute(anlageRoute(site.id, 'modell'));

  return (
    <div className="vp-geraet vp-box">
      {/* GENAU EIN Rückweg. Im GEFUNDENEN Fall trägt ihn der Kern selbst -
          hier steht die Brotkrume nur über den Lade-/Fehler-/Leer-Zuständen,
          damit auch die einen Rückweg haben. */}
      {!(view && view.gefunden) && (
        <GeraetBrotkrume
          anlageHref={anlageHref}
          komponentenHref={komponentenHref}
          titel="VoltPilot-Box"
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
            message="Diese Box konnte nicht geladen werden."
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        </Card>
      )}

      {view && !view.gefunden && (
        <Card padding="lg" radius="lg">
          <EmptyState
            icon="cpu"
            category="primary"
            title="Diese Box ist hier nicht (mehr) zu finden"
            description={view.grund ?? ''}
          />
          {view.auswahl.length > 0 && (
            <div className="vp-box-auswahl" aria-label="VoltPilot-Box wählen">
              {view.auswahl.map((b) => (
                <a key={b.ref} href={boxSeiteHash(site.id, b.ref)}>
                  {b.name}<Icon name="chevron-right" size={14} />
                </a>
              ))}
            </div>
          )}
        </Card>
      )}

      {view && view.gefunden && view.geraete && (() => {
        const verbunden = view.zustand.ton === 'ok';
        const block = view.geraete;
        const verbindung = view.kacheln.find((k) => k.key === 'verbindung');
        const software = view.kacheln.find((k) => k.key === 'software');
        const notAus = view.grenzen.find((z) => z.label === 'Not-Aus' && z.ton === 'warn') ?? null;

        // --- Jetzt: die Kette Geräte → Box → VoltPilot -----------------------
        const buehne: BausteinInhalt = {
          inhalt: (
            <GeraetBuehne
              zahl={{
                zahl: view.zustand.wort.charAt(0).toUpperCase() + view.zustand.wort.slice(1),
                einheit: null,
                wort: null,
                ton: view.zustand.ton,
                key: 'verbindung',
              }}
              satz={view.buehneSatz}
              satzTon={view.zustand.ton}
              grafik={{ art: 'box', verbunden, geraete: block.anzahl ?? 0 }}
              // Die Software-Version steht in „Gerät & Verbindung" (auch im
              // Kurztext) - nur eine WARNUNG zu ihr gehört auf die Bühne.
              chips={software && software.ton === 'warn' ? [{
                key: 'software', label: 'Software', wert: software.wert, wort: null, ton: 'warn',
              }] : []}
              zeilen={notAus ? [`${notAus.label}: ${notAus.wert}`] : []}
              hinweis={verbindung?.satz ?? null}
            />
          ),
        };

        // --- Zusatz: „Geräte an dieser Box" (GE-4) — dieselben Kästen wie im Aufbau unter dieser Box ---------
        // Der Weg (AP-06-Datenquelle) ist keine eigene Zeile mehr: er steht am Gerät (Anbindung und Last), als
        // Gateway mit den Geräten dahinter oder als „Anschluss ohne Gerät". Den Box-Wechsel trägt die Zeile, deren
        // Weg es ist — beim Gateway gilt er für alle Geräte dahinter.
        const wegAktion = (quelleId: string | null, name: string) => {
          const q = quelleId ? datenquellen?.find((d) => d.id === quelleId) : undefined;
          if (!q) return null;
          // AP-15 IP-26: der Weg zu einem Mitglied — vor dem Scharfschalten bleibt der Knopf, der Server urteilt je
          // Ziel-Box; scharf oder angehalten nur „Gemeinsame Steuerung ändern“.
          if (q.steuerquelle && steuerquelleWeg !== 'innerhalb_der_gemeinsamen_steuerung') {
            return steuerquelleWeg === 'gemeinsame_steuerung_aendern'
              ? <small data-testid="steuerquelle-weg">
                <a href={einstellungenHash(site.id, 'gemeinsam')}>{gemeinsameSteuerungAendern(q.kennzeichen)}</a>
              </small>
              : <small>Diese Quelle steuert — ihre Box kann erst mit der gemeinsamen Optimierung mehrerer Boxen wechseln.</small>;
          }
          return (
            <Recht aktion="datenquelle.zustaendigkeit"><button type="button" className="vp-box-quellen-aktion"
              aria-label={`Zuständige Box wechseln für ${name}`} onClick={() => setWechselQuelle(q)}>
              Zuständige Box wechseln
            </button></Recht>
          );
        };
        const liste = block.eintraege.length + block.gateways.length + block.offen.length > 0;
        const modul: BausteinInhalt = {
          titel: 'Geräte an dieser Box',
          inhalt: (
            <div className="vp-box-geraete-block" data-testid="box-geraete-block">
              {block.summe && <p className="vp-box-last" data-testid="box-last">{block.summe}</p>}
              {block.summeLeer && <p className="vp-note">{block.summeLeer}</p>}
              {view.geraeteLeer && <p className="vp-note">{view.geraeteLeer}</p>}
              {liste && (
                <ul className="vp-geraet-liste vp-box-liste" data-testid="box-geraete">
                  {block.eintraege.map((e) => (
                    <BoxEintragZeile key={e.id} eintrag={e} aktion={wegAktion(e.quelleId, e.titel)} />
                  ))}
                  {block.gateways.map((w) => (
                    <li key={w.id} className="vp-box-weg is-gateway" data-box-weg={w.kennzeichen}>
                      <div className="vp-geraet-zeile vp-box-geraet">
                        <span className={`vp-health-dot vp-health-${w.ton}`} />
                        <span className="tx">
                          <span className="nm">{w.titel}</span>
                          <span className="ty">Gateway</span>
                          <span className="an">{w.weg}</span>
                          <span className="an">{w.zeile}</span>
                          <span className="st">{w.zustand}</span>
                        </span>
                      </div>
                      <div className="vp-box-zeile-aktion">{wegAktion(w.id, w.titel)}</div>
                      <ul className="vp-box-gateway-geraete" aria-label={`Geräte hinter ${w.titel}`}>
                        {w.geraete.map((e) => <BoxEintragZeile key={e.id} eintrag={e} aktion={null} />)}
                      </ul>
                    </li>
                  ))}
                  {block.offen.map((w) => (
                    <li key={w.id} className="vp-box-weg is-offen" data-box-weg={w.kennzeichen}>
                      <div className="vp-geraet-zeile vp-box-geraet">
                        <span className={`vp-health-dot vp-health-${w.ton}`} />
                        <span className="tx">
                          <span className="nm">{w.titel}</span>
                          <span className="an">{w.weg}</span>
                          <span className="st">{w.zustand}</span>
                        </span>
                      </div>
                      <div className="vp-box-zeile-aktion">
                        {/* Ein Ort zum Anlegen: das Gerät entsteht im Aufbau (`?neu=geraet`). */}
                        <Recht aktion="geraet.einrichten">
                          <a className="vp-box-quellen-aktion" href={aufbauHash(site.id, 'geraet')}
                            aria-label={`Gerät an Anschluss ${w.kennzeichen} hinzufügen`}>
                            Gerät hinzufügen
                          </a>
                        </Recht>
                        {wegAktion(w.id, `Anschluss ${w.kennzeichen}`)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {block.gemeldet > 0 && (
                <p className="vp-note">
                  {block.gemeldet === 1
                    ? 'Die Box meldet ein weiteres Gerät, das noch nicht übernommen ist.'
                    : `Die Box meldet ${block.gemeldet} weitere Geräte, die noch nicht übernommen sind.`}{' '}
                  <a href={aufbauHash(site.id)}>Im Aufbau übernehmen</a>
                </p>
              )}
              {block.zuordnungUnbekannt && (
                <p className="vp-note">
                  Welches Gerät hinter den Anschlüssen dieser Box steht, ist gerade nicht bekannt — ihre Last zählt oben mit.
                </p>
              )}
              {block.fremd && <p className="vp-note">{block.fremd}</p>}
              {liste && <p className="vp-note">{GERAETE_HINWEIS}</p>}
              {/* Datenquellen entstehen hier, an der Box, die sie liest — nicht mehr nur im Messen-Assistenten.
                  GE-6 (GD-5): von Hand ist das ein Gateway oder Logger; ein einzelnes Gerät kommt über „Gerät hinzufügen“. */}
              {standortDerAnlage && (
                <Recht aktion="datenquelle.bearbeiten"><button type="button" className="vp-box-quellen-aktion" onClick={() => setQuelleAnlegen(true)}>
                  <Icon name="plus" size={14} /> {UEMS_GATEWAY_ANBINDEN}
                </button></Recht>
              )}
            </div>
          ),
        };

        // --- Aktivität: was die Box ÜBERBRINGT --------------------------------
        const history = verlauf.history;
        const aktivitaet: BausteinInhalt = {
          info: (
            <>
              <p>{GERAETE_BEFEHLE}</p>
              <p>
                {aufzeichnungSeit(history?.recordingSince ?? null)}
                {' · '}
                {genauigkeitsSatz(history?.accuracySeconds ?? 15)}
              </p>
            </>
          ),
          kopfRechts: (
            <a href={hashForRoute(anlageRoute(site.id, 'befehle'))}>
              Alle <Icon name="chevron-right" size={14} />
            </a>
          ),
          inhalt: <BefehleVerlauf state={verlauf} max={3} />,
        };

        // --- Gerät & Verbindung ------------------------------------------------
        const netzwerk = view.kacheln.find((k) => k.key === 'netzwerk');
        const detailZeilen: Zeile[] = view.kacheln.map((k) => ({
          label: k.label,
          wert: k.wert,
          detail: [k.satz, ...k.zeilen].filter(Boolean).join(' ') || null,
          ton: k.ton === 'warn' ? 'warn' : null,
          mono: k.mono,
        }));
        const details = {
          kurz: [software ? `Software ${software.wert}` : null, netzwerk && netzwerk.ton !== 'off' ? netzwerk.wert : null]
            .filter(Boolean).join(' · ') || null,
          inhalt: (
            <>
              <ZeilenListe zeilen={detailZeilen} />
              {view.faehigkeiten && (
                <div className="vp-box-faehigkeiten" data-testid="box-faehigkeiten">
                  <b>{view.faehigkeiten}</b>
                  {view.updateNoetig && (
                    <a href={hashForRoute(pageRoute('edge-updates'))}>
                      Update planen <Icon name="chevron-right" size={14} />
                    </a>
                  )}
                </div>
              )}
              {netzwerk?.url && (
                <p className="vp-geraet-sec-sub">
                  <a className="vp-box-oberflaeche" href={netzwerk.url} target="_blank" rel="noreferrer">
                    Lokale Oberfläche öffnen <Icon name="chevron-right" size={14} />
                  </a>
                </p>
              )}
              <h3 className="vp-box-zwischen">Schutz &amp; Grenzen der ganzen Anlage</h3>
              {view.grenzenLeer && <p className="vp-note">{view.grenzenLeer}</p>}
              <ZeilenListe zeilen={view.grenzen} />
            </>
          ),
        };

        // --- Technik & Diagnose -------------------------------------------------
        const technik: TechnikTeil[] = [{ id: 'rohdaten', inhalt: <ZeilenListe zeilen={view.technik} /> }];
        if (showTechnicalLayer() && (adminView || boxDevice)) {
          technik.push({
            id: 'plattform',
            inhalt: (
              <div data-testid="box-admin">
                {adminView && <AdminGeraetKarten
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
                />}
                {adminFehler && <p className="vp-alert vp-alert-err">{adminFehler}</p>}
                {/* Fernwartung (E5): nur Plattform-Admins - der Kunde sieht
                    die Fenster nicht (O3). Lädt selbst, unabhängig davon, ob
                    die übrigen Plattform-Karten geladen sind. */}
                {boxDevice && <FernwartungKarte edgeRef={boxDevice.externalRef} />}
              </div>
            ),
          });
        }

        // V7: das Unumkehrbare im Menü „⋯" - mit denselben Folgen wie bisher;
        // „Box tauschen" (UEMS AP-06, E7 = A) steht als Handlung davor. Jeder
        // Eintrag trägt die Rechte-Weiche (AP-03 IP-12) wie vorher sein Knopf.
        const menue: MenueEintrag[] = boxDevice ? [
          { key: 'tauschen', label: 'Box tauschen', icon: 'refresh-cw', onClick: () => setTauschOffen(true), recht: 'datenquelle.zustaendigkeit' },
          { key: 'purge', label: 'Datenaufzeichnungen löschen …', icon: 'trash', danger: true, onClick: () => setLoeschen('purge'), recht: 'aufzeichnungen.loeschen' },
          { key: 'entfernen', label: 'Gerät entfernen …', icon: 'trash', danger: true, onClick: () => setLoeschen('entfernen'), recht: 'komponente.loeschen' },
        ] : [];

        return (
          <GeraetRahmen
            testId="box-rahmen"
            geraetKey={`${site.id}:box:${view.kennung}`}
            brotkrume={{ anlageHref, komponentenHref }}
            kopf={{
              titel: view.titel,
              typ: BOX_ROLLE,
              kennung: view.kennung,
              symbol: { icon: 'cpu', farbe: 'box' },
              zustand: view.zustand,
              frische: boxDevice?.lastSeenAt ?? null,
            }}
            menue={menue}
            veraltet={view.zustand.ton !== 'ok'}
            bausteine={{ buehne, modul, aktivitaet }}
            modulSpalte="links"
            details={details}
            technik={technik}
          />
        );
      })()}

      {boxDevice && (
        <BoxLoeschen
          device={boxDevice}
          was={loeschen}
          onSchliessen={() => setLoeschen(null)}
          onRemoved={onDeviceRemoved}
        />
      )}
      {wechselQuelle && <DatenquelleWechselDialog quelle={wechselQuelle} devices={devices ?? []}
        onClose={() => setWechselQuelle(null)} onChanged={(neu) => {
          setDatenquellen((alt) => alt?.map((q) => q.id === neu.id ? neu : q) ?? [neu]);
          setWechselQuelle(neu);
        }} />}
      {quelleAnlegen && standortDerAnlage && (
        <DatenquelleAnlegen
          anlage={{ id: site.id, name: site.name }}
          standortId={standortDerAnlage.id}
          anlagenAmStandort={standortDerAnlage.anlagen.map((a) => a.id)}
          onClose={() => {
            setQuelleAnlegen(false);
            setReloadKey((k) => k + 1);
          }}
        />
      )}
      {tauschOffen && boxDevice && <AddDeviceDrawer open onClose={() => setTauschOffen(false)}
        sites={[site]} onClaimed={() => {}} nachfolgerVon={boxDevice} datenquellen={datenquellen ?? []} />}
    </div>
  );
}

/**
 * Ein Gerät AN der Box - eine Zeile mit dem Weg auf seine eigene Seite, darunter Anbindung und Last (GE-4). Ein
 * Gerät ohne eigene Seite (Ersatzgerät) steht ohne Pfeil da; die Handlung zu seinem Weg steht neben der Zeile, nie
 * im Link.
 */
function BoxEintragZeile({ eintrag, aktion }: { eintrag: BoxEintrag; aktion: ReactNode }) {
  const inhalt = (
    <>
      <span className={`vp-health-dot vp-health-${eintrag.ton}`} />
      <span className="tx">
        <span className="nm">{eintrag.titel}</span>
        <span className="ty">{eintrag.typ}</span>
        {eintrag.anbindung && <span className="an">{eintrag.anbindung}</span>}
        <span className="st">{eintrag.zustand}</span>
      </span>
    </>
  );
  return (
    <li>
      {eintrag.href ? (
        <a className="vp-geraet-zeile vp-box-geraet" href={eintrag.href}>
          {inhalt}
          <Icon name="chevron-right" size={16} />
        </a>
      ) : (
        <div className="vp-geraet-zeile vp-box-geraet">{inhalt}</div>
      )}
      {aktion && <div className="vp-box-zeile-aktion">{aktion}</div>}
    </li>
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
 * Das UNUMKEHRBARE der Box - seit V7 aus dem Menü „⋯" geöffnet, mit denselben
 * Folgen wie der frühere rote Kasten am Seitenende. Es gibt es AUSSCHLIESSLICH
 * auf der Box (sie ist die eine Kiste, die beansprucht wird; ein Gerät
 * dahinter wird nicht „entfernt", es meldet sich schlicht nicht mehr).
 */
function BoxLoeschen({
  device,
  was,
  onSchliessen,
  onRemoved,
}: {
  device: Device;
  was: 'purge' | 'entfernen' | null;
  onSchliessen: () => void;
  onRemoved?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [purgeDone, setPurgeDone] = useState(false);
  const name = device.name || device.externalRef;

  const schliessen = () => {
    if (busy) return;
    setFehler(null);
    onSchliessen();
  };

  async function purge() {
    setBusy(true);
    setFehler(null);
    try {
      await api.purgeDeviceData(device.id);
      setPurgeDone(true);
      onSchliessen();
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : 'Die Aufzeichnungen konnten nicht gelöscht werden.');
    } finally {
      setBusy(false);
    }
  }

  async function entfernen() {
    setBusy(true);
    setFehler(null);
    try {
      await api.deleteDevice(device.id);
      onSchliessen();
      onRemoved?.();
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : 'Das Gerät konnte nicht entfernt werden.');
    } finally {
      setBusy(false);
    }
  }

  const fehlerZeile = fehler ? <div className="vp-alert vp-alert-err" role="alert">{fehler}</div> : null;
  return (
    <>
      {purgeDone && (
        <div className="vp-alert vp-alert-ok" role="status">
          <b>Datenaufzeichnungen gelöscht.</b> Neue Messwerte werden ab jetzt wieder normal
          aufgezeichnet.
        </div>
      )}
      <ConfirmDialog
        open={was === 'purge'}
        tone="danger"
        title="Datenaufzeichnungen löschen"
        intro="Löscht alle bisher aufgezeichneten Messdaten dieses Geräts unwiderruflich. Das Gerät bleibt verbunden und zeichnet ab sofort wieder neu auf."
        consequences={[
          `Alle Messdaten von „${name}" werden endgültig gelöscht - auch aus Verlauf, Historie und Statistiken`,
          'Auch der lokale Zwischenspeicher auf dem Gerät wird geleert; ist das Gerät gerade offline, passiert das automatisch beim nächsten Verbinden',
          'Das Gerät selbst bleibt verbunden und funktioniert unverändert weiter - neue Messwerte laufen normal ein',
        ]}
        confirmLabel={busy ? 'Wird gelöscht …' : 'Datenaufzeichnungen endgültig löschen'}
        busy={busy}
        extra={fehlerZeile}
        onConfirm={() => void purge()}
        onCancel={schliessen}
      />
      <ConfirmDialog
        open={was === 'entfernen'}
        tone="danger"
        title="Gerät entfernen"
        intro="Entfernt dieses Gerät aus Ihrer Anlage."
        consequences={unclaimConsequences(device)}
        confirmLabel={busy ? 'Wird entfernt …' : 'Gerät endgültig entfernen'}
        busy={busy}
        extra={fehlerZeile}
        onConfirm={() => void entfernen()}
        onCancel={schliessen}
      />
    </>
  );
}
