import { useEffect, useMemo, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  api,
  type Device,
  type Site,
  type SiteEntities,
  type SiteSource,
  type SiteTopology,
  type UemsDatenquelle,
  type UemsGeraet,
} from '../api';
import { aufbauDerAnlage } from '../boxGeraete';
import { consumersApi } from '../consumers/consumersApi';
import type { Consumer } from '../consumers/types';
import { AnbindungAbschnitt, AnbindungVerlauf } from '../components/GeraetAnbindung';
import { DatenquelleWechselDialog } from '../components/DatenquelleWechselDialog';
import { GeraetBrotkrume } from '../components/GeraetBrotkrume';
import { GeraetRahmen, type BausteinInhalt } from '../components/GeraetRahmen';
import { Recht } from '../components/Recht';
import { EmptyState, ErrorState, TextSkeleton } from '../components/States';
import { anbindungKurz } from '../geraetAnbindung';
import { gatewaySeite, type GatewayGeraet } from '../gatewaySeite';
import type { SiteCharging } from '../ladepunkte';
import { anlageRoute, hashForRoute } from '../nav';
import { LIVE_POLL_MS } from '../pollCadence';
import { useFreshnessPoll } from '../useFreshnessPoll';
import './GeraetSeite.css';
import './BoxSeite.css';

/**
 * Die GATEWAY-SEITE (Konzept „Ein Gerät, ein Eintrag", GE-5): ein Weg mit mehreren Geräten ist ein Kasten und hat
 * seine Seite im Geräteseiten-Rahmen (`…/geraet/{ref}/dq-<n>`) — die Geräte dahinter, die Anbindung (Box-Wechsel
 * und Last gelten hier für alle), ihr Verlauf und „Gerät an diesem Gateway hinzufügen".
 *
 * Diese Datei RENDERT nur: welche Geräte dahinter stehen und was eine Zeile sagt, legt `gatewaySeite.ts` fest —
 * aus derselben Zuordnung wie der Aufbau (`aufbauDerAnlage`, nur gespeicherte Verweise).
 */
export function GatewaySeiteSection({
  site,
  boxRef,
  kennzeichen,
  devices,
  devicesFetchedAt,
}: {
  site: Site;
  boxRef: string;
  kennzeichen: string;
  devices: Device[] | null;
  devicesFetchedAt?: number | null;
}) {
  const [data, setData] = useState<SiteEntities | null>(null);
  const [error, setError] = useState(false);
  const [sources, setSources] = useState<SiteSource[] | null>(null);
  const [topology, setTopology] = useState<SiteTopology | null>(null);
  const [consumers, setConsumers] = useState<Consumer[] | null>(null);
  const [charging, setCharging] = useState<SiteCharging | null>(null);
  // `undefined` = noch nicht beantwortet; null = nicht geladen — dann ist die Zuordnung unbekannt (GE-1).
  const [uemsGeraete, setUemsGeraete] = useState<UemsGeraet[] | null | undefined>(undefined);
  const [datenquellen, setDatenquellen] = useState<UemsDatenquelle[] | null>(null);
  const [gemeinsamZustand, setGemeinsamZustand] = useState<string | null>(null);
  const [wechselQuelle, setWechselQuelle] = useState<UemsDatenquelle | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    setData(null);
    setDatenquellen(null);
    setUemsGeraete(undefined);
    setError(false);
    // Die tragenden Abrufe: die Geräte der Anlage und ihre Wege. Ohne sie gibt es kein Gateway zu zeigen.
    Promise.all([api.siteEntities(site.id), api.datenquellen(site.id)]).then(
      ([d, q]) => {
        if (!active) return;
        setData(d);
        setDatenquellen(q.datenquellen);
      },
      () => active && setError(true),
    );
    const soft = <T,>(p: Promise<T | null>, set: (v: T | null) => void) => {
      void p.then(
        (v) => active && set(v ?? null),
        () => active && set(null),
      );
    };
    soft(api.siteSources(site.id), setSources);
    soft(api.topology(site.id), setTopology);
    soft(consumersApi.list(site.id), setConsumers);
    soft(api.siteChargers(site.id), setCharging);
    void api.uemsGeraete(site.id).then(
      (a) => active && setUemsGeraete(a.geraete),
      () => active && setUemsGeraete(null),
    );
    setNow(Date.now());
    return () => {
      active = false;
    };
  }, [site.id, reloadKey]);

  // Empfang und Last ändern sich laufend — die Wege und die Quellen der Box frisch halten.
  useFreshnessPoll(() => {
    Promise.all([
      api.datenquellen(site.id).then((a) => a.datenquellen).catch(() => null),
      api.siteSources(site.id).catch(() => null),
    ]).then(([q, s]) => {
      if (q !== null) setDatenquellen(q);
      if (s !== null) setSources(s);
      setNow(Date.now());
    });
  }, LIVE_POLL_MS);

  const quelle = datenquellen?.find((q) => q.kennzeichen === kennzeichen) ?? null;
  const steuerquelle = Boolean(quelle?.steuerquelle);
  useEffect(() => {
    let aktiv = true;
    setGemeinsamZustand(null);
    // Nur eine Steuerquelle fragt die Gemeinsame Steuerung (die Weiche der Box-Seite, AP-15 T6).
    if (!steuerquelle) return;
    api.gemeinsameSteuerung(site.id).then(
      (z) => aktiv && setGemeinsamZustand(z?.zustand ?? null),
      () => aktiv && setGemeinsamZustand(null),
    );
    return () => {
      aktiv = false;
    };
  }, [site.id, steuerquelle]);

  const view = useMemo(() => {
    if (!data || datenquellen == null || uemsGeraete === undefined) return null;
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
      now,
    });
    return gatewaySeite({
      siteId: site.id,
      ref: boxRef,
      kennzeichen,
      anlage,
      datenquellen,
      zuordnung: uemsGeraete != null,
      devices: devices ?? [],
      gemeinsamZustand,
    });
  }, [data, datenquellen, uemsGeraete, site.id, site.name, topology, sources, charging, consumers, devices,
    devicesFetchedAt, now, boxRef, kennzeichen, gemeinsamZustand]);

  const anlageHref = hashForRoute(anlageRoute(site.id));
  const komponentenHref = hashForRoute(anlageRoute(site.id, 'modell'));

  return (
    <div className="vp-geraet vp-gateway">
      {/* GENAU EIN Rückweg: im gefundenen Fall trägt ihn der Kern. */}
      {view?.art !== 'gefunden' && (
        <GeraetBrotkrume anlageHref={anlageHref} komponentenHref={komponentenHref} titel={`Gateway ${kennzeichen}`} />
      )}

      {!view && !error && (
        <Card padding="lg" radius="lg">
          <TextSkeleton lines={6} />
        </Card>
      )}
      {error && (
        <Card padding="lg" radius="lg">
          <ErrorState message="Dieses Gateway konnte nicht geladen werden." onRetry={() => setReloadKey((k) => k + 1)} />
        </Card>
      )}

      {view?.art === 'fehlt' && (
        <Card padding="lg" radius="lg">
          <div data-testid="gateway-fehlt">
            <EmptyState
              icon="link"
              category="primary"
              title={view.titel}
              description={view.satz}
              action={view.weiter && <a className="vp-btn vp-btn--outline vp-btn--sm" href={view.weiter.href}>{view.weiter.text}</a>}
            />
          </div>
        </Card>
      )}

      {view?.art === 'gefunden' && (() => {
        const modul: BausteinInhalt = {
          titel: 'Geräte an diesem Gateway',
          inhalt: (
            <div className="vp-box-geraete-block" data-testid="gateway-geraete-block">
              <p className="vp-box-last" data-testid="gateway-geraete-satz">{view.geraeteSatz}</p>
              <ul className="vp-geraet-liste vp-box-liste" data-testid="gateway-geraete">
                {view.geraete.map((g) => <GatewayGeraetZeile key={g.id} geraet={g} />)}
              </ul>
              {/* Ein Ort zum Anlegen: das Gerät entsteht im Aufbau, mit diesem Weg vorbelegt (`?neu=geraet&an=…`). */}
              <Recht aktion="geraet.einrichten">
                <a className="vp-box-quellen-aktion" href={view.hinzufuegenHref} data-testid="gateway-hinzufuegen">
                  <Icon name="plus" size={14} /> Gerät an diesem Gateway hinzufügen
                </a>
              </Recht>
            </div>
          ),
        };
        return (
          <GeraetRahmen
            testId="gateway-rahmen"
            geraetKey={`${site.id}:gateway:${view.quelle.kennzeichen}`}
            brotkrume={{ anlageHref, komponentenHref }}
            kopf={{
              titel: view.titel,
              typ: 'Gateway',
              symbol: { icon: 'link', farbe: 'neutral' },
              zustand: view.zustand,
              frische: view.quelle.rueckmeldung?.gelesen_am ?? null,
            }}
            bausteine={{ modul }}
            modulSpalte="links"
            details={{
              kurz: anbindungKurz([view.anbindung]),
              inhalt: <AnbindungAbschnitt anbindung={view.anbindung} onWechseln={() => setWechselQuelle(view.quelle)} />,
            }}
            technik={[{
              id: 'anbindung',
              inhalt: <AnbindungVerlauf siteId={site.id} quellen={[view.quelle]} devices={devices ?? []} />,
            }]}
          />
        );
      })()}

      {/* „Zuständige Box wechseln" - der Dialog der Box-Seite, kein zweiter; er gilt für alle Geräte dahinter. */}
      {wechselQuelle && (
        <DatenquelleWechselDialog
          quelle={wechselQuelle}
          devices={devices ?? []}
          onClose={() => setWechselQuelle(null)}
          onChanged={(neu) => {
            setDatenquellen((alt) => alt?.map((q) => (q.id === neu.id ? neu : q)) ?? [neu]);
            setWechselQuelle(neu);
          }}
        />
      )}
    </div>
  );
}

/** Ein Gerät hinter dem Gateway: Punkt · Name, Art, Geräte-ID und Zustand · Pfeil auf seine Seite. */
function GatewayGeraetZeile({ geraet: g }: { geraet: GatewayGeraet }) {
  const inhalt = (
    <>
      <span className={`vp-health-dot vp-health-${g.ton}`} />
      <span className="tx">
        <span className="nm">{g.titel}</span>
        <span className="ty">{g.typ}</span>
        {g.geraeteId && <span className="an">{g.geraeteId}</span>}
        <span className="st">{g.zustand}</span>
      </span>
    </>
  );
  return (
    <li data-gateway-geraet={g.id}>
      {g.href ? (
        <a className="vp-geraet-zeile vp-box-geraet" href={g.href}>
          {inhalt}
          <Icon name="chevron-right" size={16} />
        </a>
      ) : (
        <div className="vp-geraet-zeile vp-box-geraet">{inhalt}</div>
      )}
    </li>
  );
}
