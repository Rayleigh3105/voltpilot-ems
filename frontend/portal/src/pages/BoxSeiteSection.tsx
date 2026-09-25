import { useEffect, useMemo, useState } from 'react';
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
} from '../api';
import type { SiteCharging } from '../ladepunkte';
import {
  BOX_ROLLE,
  boxGeraeteListe,
  boxSeite,
  GERAETE_HINWEIS,
  type BoxSeiteView,
} from '../boxSeite';
import type { BoxGeraet, Zeile } from '../geraetSeite';
import { GeraetBrotkrume } from '../components/GeraetBrotkrume';
import {
  GeraetRahmen,
  type BausteinInhalt,
  type MenueEintrag,
  type TechnikTeil,
} from '../components/GeraetRahmen';
import { GeraetBuehne } from '../components/GeraetBuehne';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { unclaimConsequences } from '../components/DeviceDrawers';
import { EmptyState, ErrorState, TextSkeleton } from '../components/States';
import { anlageRoute, geraetSeiteHash, hashForRoute, pageRoute } from '../nav';
import {
  aufzeichnungSeit,
  genauigkeitsSatz,
  GERAETE_BEFEHLE,
} from '../befehle';
import { BefehleVerlauf, useBefehleVerlauf } from '../components/BefehleVerlauf';
import { useFreshnessPoll } from '../useFreshnessPoll';
// LIVE: die Box-Seite zeigt gemessene Ist-Werte und Steuer-Rückmeldungen.
import { LIVE_POLL_MS } from '../pollCadence';
import { showTechnicalLayer } from '../rollen';
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
  const [control, setControl] = useState<ControlStatus | null>(null);
  const [curtailment, setCurtailment] = useState<CurtailmentStatus | null>(null);
  const [edgeVersions, setEdgeVersions] = useState<EdgeVersion[] | null>(null);
  const [charging, setCharging] = useState<SiteCharging | null>(null);
  const [adminView, setAdminView] = useState<GeraetView | null>(null);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminFehler, setAdminFehler] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [loeschen, setLoeschen] = useState<'purge' | 'entfernen' | null>(null);

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
    soft(api.controlStatus(site.id), setControl);
    soft(api.curtailmentStatus(site.id), setCurtailment);
    soft(api.edgeVersions(), setEdgeVersions);
    soft(api.siteChargers(site.id), setCharging);
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
    ]).then(([s, c, cu, ch]) => {
      if (s !== null) setSources(s);
      setControl(c);
      setCurtailment(cu);
      if (ch !== null) setCharging(ch);
      setNow(Date.now());
    });
  }, LIVE_POLL_MS);

  const view: BoxSeiteView | null = useMemo(() => {
    if (!data) return null;
    return boxSeite({
      ref: boxRef,
      siteName: site.name,
      siteId: site.id,
      devices: devices ?? [],
      devicesFetchedAt,
      edgeVersions,
      control,
      curtailment,
      geraete: boxGeraeteListe(data.localSetup, sources, charging?.chargers ?? null, now),
      localSetup: data.localSetup,
      now,
    });
  }, [
    data, boxRef, site.name, site.id, devices, devicesFetchedAt, edgeVersions, control,
    curtailment, sources, charging, now,
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
        </Card>
      )}

      {view && view.gefunden && (() => {
        const verbunden = view.zustand.ton === 'ok';
        const liefern = view.geraete.filter((g) => g.ton === 'ok').length;
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
              satz={view.geraete.length > 0
                ? `${liefern} von ${view.geraete.length} ${view.geraete.length === 1 ? 'Gerät liefert' : 'Geräten liefern'} Daten.`
                : view.geraeteLeer}
              satzTon={view.zustand.ton}
              grafik={{ art: 'box', verbunden, geraete: view.geraete.length }}
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

        // --- Zusatz: die Geräte AN der Box ------------------------------------
        const modul: BausteinInhalt = {
          titel: 'Geräte an dieser Box',
          inhalt: (
            <>
              {view.geraeteLeer && <p className="vp-note">{view.geraeteLeer}</p>}
              {view.geraete.length > 0 && (
                <>
                  <ul className="vp-geraet-liste" data-testid="box-geraete">
                    {view.geraete.map((g) => (
                      <BoxGeraetZeile
                        key={g.geraetId}
                        geraet={g}
                        siteId={site.id}
                        ref_={view.kennung}
                      />
                    ))}
                  </ul>
                  <p className="vp-note">{GERAETE_HINWEIS}</p>
                </>
              )}
            </>
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
        if (showTechnicalLayer() && adminView) {
          technik.push({
            id: 'plattform',
            inhalt: (
              <div data-testid="box-admin">
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

        // V7: das Unumkehrbare im Menü „⋯" - mit denselben Folgen wie bisher.
        const menue: MenueEintrag[] = boxDevice ? [
          { key: 'purge', label: 'Datenaufzeichnungen löschen …', icon: 'trash', danger: true, onClick: () => setLoeschen('purge') },
          { key: 'entfernen', label: 'Gerät entfernen …', icon: 'trash', danger: true, onClick: () => setLoeschen('entfernen') },
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
    </div>
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
      <a className="vp-geraet-zeile vp-box-geraet" href={geraetSeiteHash(siteId, ref_, geraet.geraetId)}>
        <span className={`vp-health-dot vp-health-${geraet.ton}`} />
        <span className="tx">
          <span className="nm">{geraet.name}</span>
          <span className="ty">{geraet.art}</span>
          <span className="st">{geraet.zustand}</span>
        </span>
        <Icon name="chevron-right" size={16} />
      </a>
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
