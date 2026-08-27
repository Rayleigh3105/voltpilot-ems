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
import { boxGeraeteListe, boxSeite, GERAETE_HINWEIS, type BoxSeiteView } from '../boxSeite';
import type { BoxGeraet, Zeile } from '../geraetSeite';
import { GeraetBrotkrume } from '../components/GeraetBrotkrume';
import { GeraetRahmen, RahmenSektion } from '../components/GeraetRahmen';
import { DangerZone } from '../components/DangerZone';
import { unclaimConsequences } from '../components/DeviceDrawers';
import { EmptyState, ErrorState, TextSkeleton } from '../components/States';
import { anlageRoute, geraetSeiteHash, hashForRoute, pageRoute } from '../nav';
import {
  aufzeichnungSeit,
  genauigkeitsSatz,
  GERAETE_BEFEHLE,
} from '../befehle';
import { neuesteZeile } from '../befehleVerlauf';
import { BefehleVerlauf, useBefehleVerlauf } from '../components/BefehleVerlauf';
import { useFreshnessPoll } from '../useFreshnessPoll';
import { showTechnicalLayer } from '../rollen';
import { kurz, rahmen, type SektionAngebot } from '../geraetRahmen';
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
 * <p>Die Box ist ein TOR, kein Gerät - und seit Geräteseiten Stufe 1 sagt das
 * auch ihre Fläche: drei Kacheln (Verbindung · Software · Adresse im
 * Netzwerk), die GERÄTE als Absprungliste im Zentrum, „Was Ihre Box
 * überbringt" (die anlagenweiten Befehle), „Schutz &amp; Grenzen", ein
 * Technik-Aufklapper und die Gefahrenzone.
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
  }, 30_000);

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

  // Geräteseiten Stufe 2: DERSELBE Verlauf wie überall - neueste Zeile oben,
  // „Ältere laden", keine Filter. Der Server entscheidet weiterhin, was der Box
  // gehört (`?device=`); die Fläche schneidet nichts selbst zurecht.
  const verlauf = useBefehleVerlauf({ siteId: site.id, geraetRef: boxDevice?.externalRef ?? null });
  const letzteZeile = useMemo(() => neuesteZeile(verlauf.view), [verlauf.view]);

  /**
   * Der RAHMEN dieser Box (Geräteseiten Stufe 1, §4.4).
   *
   * ⚠ Die Box LÄSST AUS, was sie strukturell nicht hat - sie sortiert nie um.
   * „Register" entfällt (ein Rechner hat keine), und „Verbindung"/„Software"
   * entfallen, weil ihr INHALT der Held ist: die drei Kacheln oben SIND die
   * Verbindung zu VoltPilot, der Software-Stand und die Adresse im Netzwerk.
   * Sie ein zweites Mal als Sektion zu führen wäre dieselbe Aussage zweimal auf
   * einem Bildschirm (die Haus-Regel).
   */
  const rahmenView = useMemo(() => {
    const angebote: (SektionAngebot | null)[] = [
      { id: 'jetzt' },
      {
        id: 'befehle',
        kurzfassung: kurz(letzteZeile?.satz ?? null),
      },
      view?.gefunden && (view.grenzen.length > 0 || view.grenzenLeer)
        ? {
          // ⚠ „Steuerung & Grenzen" wäre hier falsch - die Box STEUERT nichts,
          // und die Grenzen gelten der ANLAGE. Wessen sie sind, sagt die
          // Kurzfassung; der Titel bleibt kurz genug für die Anker-Spalte.
          id: 'steuerung',
          titel: 'Schutz & Grenzen',
          kurzfassung: kurz(
            'der ganzen Anlage',
            view.grenzen.length > 0 ? `${view.grenzen.length} Angaben` : null,
          ),
        }
        : null,
      view?.gefunden
        ? {
          id: 'komponenten',
          titel: 'Geräte an dieser Box',
          kurzfassung: kurz(view.geraete.length > 0
            ? `${view.geraete.length} ${view.geraete.length === 1 ? 'Gerät' : 'Geräte'}`
            : null),
        }
        : null,
      { id: 'diagnose', titel: 'Technik' },
      showTechnicalLayer() && adminView ? { id: 'plattform' } : null,
    ];
    return rahmen(angebote);
  }, [view, letzteZeile, adminView]);

  return (
    <div className="vp-geraet vp-box">
      {/* GENAU EIN Rückweg (Stufe 0, §2.1/§4.2). Im GEFUNDENEN Fall trägt ihn
          der RAHMEN selbst - hier steht die Brotkrume nur über den
          Lade-/Fehler-/Leer-Zuständen, damit auch die einen Rückweg haben. */}
      {!(view && view.gefunden) && (
        <GeraetBrotkrume
          anlageHref={hashForRoute(anlageRoute(site.id))}
          komponentenHref={hashForRoute(anlageRoute(site.id, 'modell'))}
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

      {view && view.gefunden && (
        <GeraetRahmen
          testId="box-rahmen"
          geraetKey={`${site.id}:box:${view.kennung}`}
          view={rahmenView}
          brotkrume={{
            anlageHref: hashForRoute(anlageRoute(site.id)),
            komponentenHref: hashForRoute(anlageRoute(site.id, 'modell')),
          }}
          kopf={{
            titel: view.titel,
            gattungWort: view.unterzeile,
            kennung: view.kennung,
            zustand: view.zustand,
          }}
        >
          {/* 1 · Jetzt - der HELD: die drei Fragen, die eine Box beantwortet.
                 Ohne Klapp-Kopf (§4.5). */}
          <RahmenSektion id="jetzt">
            <div className="vp-box-kacheln" data-testid="box-kacheln">
              {view.kacheln.map((k) => (
                <Card key={k.key} padding="lg" radius="lg" className={`vp-box-kachel is-${k.ton}`}>
                  <span className="l">{k.label}</span>
                  <span className={`v${k.mono ? ' vp-mono' : ''}`}>{k.wert}</span>
                  {k.satz && <p className="s">{k.satz}</p>}
                  {k.zeilen.map((z) => (
                    <p className="z" key={z}>{z}</p>
                  ))}
                  {k.url && (
                    <a className="vp-box-oberflaeche" href={k.url} target="_blank" rel="noreferrer">
                      Lokale Oberfläche öffnen <Icon name="chevron-right" size={14} />
                    </a>
                  )}
                </Card>
              ))}
            </div>
          </RahmenSektion>

          {/* 2 · Befehle - was die Box ÜBERBRINGT (die anlagenweiten). */}
          <RahmenSektion id="befehle">
            {/* ⚠ Die Box trägt hier KEINE Aktionszeile - und zwar aus dem
                Grund, aus dem sie auch keine Register-Sektion hat: sie ist ein
                Rechner, an sie selbst geht kein Befehl. Sie ÜBERBRINGT nur;
                abgesetzt wird auf der Seite des Geräts, das ausführt (§6.2).
                Ein Knopf ohne Schreibweg wäre einer ins Leere. */}
            <BefehleVerlauf state={verlauf} />
            <p className="vp-note">{GERAETE_BEFEHLE}</p>
            <p className="vp-note">
              {aufzeichnungSeit(verlauf.history?.recordingSince ?? null)}
              {' · '}
              {genauigkeitsSatz(verlauf.history?.accuracySeconds ?? 15)}
            </p>
            <a
              className="vp-geraet-komp-link"
              href={hashForRoute(anlageRoute(site.id, 'befehle'))}
            >
              Alle Befehle dieser Anlage
              <Icon name="chevron-right" size={14} />
            </a>
          </RahmenSektion>

          {/* 3 · Steuerung & Grenzen - der Box-Titel benennt die ANLAGE, weil
                 die Grenzen ihr gelten und nicht dem Rechner. */}
          <RahmenSektion id="steuerung">
            {view.grenzenLeer && <p className="vp-note">{view.grenzenLeer}</p>}
            <ZeilenListe zeilen={view.grenzen} />
          </RahmenSektion>

          {/* 4 · Komponenten - die GERÄTE sind hier die Absprungliste. */}
          <RahmenSektion id="komponenten">
            {view.geraeteLeer && <p className="vp-note">{view.geraeteLeer}</p>}
            {view.geraete.length > 0 && (
              <>
                <ul className="vp-geraet-liste">
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
          </RahmenSektion>

          {/* 8 · Diagnose - hier landen auch die Gründe der entfallenen
                 Sektionen (§4.6), damit keine still verschwindet. */}
          <RahmenSektion id="diagnose">
            {rahmenView.entfallen.map((grund) => (
              <p className="vp-note" key={grund}>{grund}</p>
            ))}
            <ZeilenListe zeilen={view.technik} />
          </RahmenSektion>

          {/* 9 · Plattform-Sicht - additiv, hinter dem EINEN Tor (M7). */}
          <RahmenSektion id="plattform">
            {adminView && (
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
            )}
          </RahmenSektion>

          {/* Die Gefahrenzone gehört KEINER Sektion (§4.4 kennt sie nicht) und
              steht deshalb unter dem Stapel - wie zuvor. */}
          {boxDevice && (
            <Card padding="lg" radius="lg">
              <span className="vp-card-label">Unumkehrbar</span>
              <GefahrenZone device={boxDevice} onRemoved={onDeviceRemoved} />
            </Card>
          )}
        </GeraetRahmen>
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
 * Die Gefahrenzone - AUSSCHLIESSLICH auf der Box (sie ist die eine Kiste, die
 * beansprucht wird; ein Gerät dahinter wird nicht „entfernt", es meldet sich
 * schlicht nicht mehr).
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
          busy={purgeBusy}
          error={purgeError}
          onConfirm={async () => {
            setPurgeBusy(true);
            setPurgeError(null);
            try {
              await api.purgeDeviceData(device.id);
              setPurgeDone(true);
            } catch (e) {
              setPurgeError(
                e instanceof ApiError ? e.message : 'Die Aufzeichnungen konnten nicht gelöscht werden.',
              );
            } finally {
              setPurgeBusy(false);
            }
          }}
        />
      )}
      <DangerZone
        actionLabel="Gerät entfernen"
        description="Entfernt dieses Gerät aus Ihrer Anlage."
        consequences={unclaimConsequences(device)}
        confirmLabel="Gerät endgültig entfernen"
        busy={deleteBusy}
        error={deleteError}
        onConfirm={async () => {
          setDeleteBusy(true);
          setDeleteError(null);
          try {
            await api.deleteDevice(device.id);
            onRemoved?.();
          } catch (e) {
            setDeleteError(
              e instanceof ApiError ? e.message : 'Das Gerät konnte nicht entfernt werden.',
            );
          } finally {
            setDeleteBusy(false);
          }
        }}
      />
    </>
  );
}
