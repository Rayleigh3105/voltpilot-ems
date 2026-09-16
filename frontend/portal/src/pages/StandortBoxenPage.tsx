import { useEffect, useMemo, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  api,
  type Device,
  type EdgeVersion,
  type Site,
  type StandortAmStichtag,
  type UemsDatenquelle,
} from '../api';
import { boxUebersicht } from '../boxUebersicht';
import { EmptyState, ErrorState, TextSkeleton } from '../components/States';
import { boxSeiteHash, hashForRoute, pageRoute } from '../nav';
import './StandortBereichPage.css';
import './StandortBoxenPage.css';

export function StandortBoxenPage({
  standort,
  sites,
  devices,
}: {
  standort: StandortAmStichtag;
  sites: Site[];
  devices: Device[];
}) {
  const anlagen = new Set(standort.anlagen.map((a) => a.id));
  const boxen = devices.filter((d) => anlagen.has(d.siteId));
  const [versionen, setVersionen] = useState<EdgeVersion[] | null>(null);
  const [quellen, setQuellen] = useState<UemsDatenquelle[] | null>(null);
  const [fehler, setFehler] = useState(false);
  const [neu, setNeu] = useState(0);

  useEffect(() => {
    let aktiv = true;
    setFehler(false);
    Promise.all([
      api.edgeVersions().then((a) => a.eintraege),
      Promise.all(standort.anlagen.map((a) => api.datenquellen(a.id).then((d) => d.datenquellen))),
    ]).then(
      ([v, q]) => {
        if (!aktiv) return;
        setVersionen(v);
        setQuellen(q.flat());
      },
      () => aktiv && setFehler(true),
    );
    return () => { aktiv = false; };
  }, [standort.id, neu]);

  const namen = useMemo(() => new Map(sites.map((s) => [s.id, s.name])), [sites]);
  const karten = useMemo(
    () => boxUebersicht(boxen, versionen ?? [], quellen ?? [], namen),
    [boxen, versionen, quellen, namen],
  );
  const geladen = versionen !== null && quellen !== null;

  return (
    <div className="vp-sb vp-standort-boxen" data-testid="standort-boxen">
      <header className="vp-sb-kopf">
        <h1>Boxen</h1>
        <p>{standort.name} · Verbindung, Datenquellen und Software je VoltPilot-Box</p>
      </header>

      {!geladen && !fehler && <Card padding="lg" radius="lg"><TextSkeleton lines={7} /></Card>}
      {fehler && (
        <Card padding="lg" radius="lg">
          <ErrorState message="Die Boxen dieses Standorts konnten nicht geladen werden." onRetry={() => setNeu((n) => n + 1)} />
        </Card>
      )}
      {geladen && karten.length === 0 && (
        <Card padding="lg" radius="lg">
          <EmptyState
            icon="cpu"
            category="primary"
            title="Noch keine VoltPilot-Box an diesem Standort"
            description="Verbinden Sie eine Box in einer Anlage dieses Standorts."
            action={standort.anlagen[0] ? (
              <a className="vp-boxen-oeffnen" href={`#/anlage/${standort.anlagen[0].id}/modell`}>
                Box verbinden <Icon name="chevron-right" size={14} />
              </a>
            ) : undefined}
          />
        </Card>
      )}
      {geladen && karten.length > 0 && (
        <div className="vp-boxen-raster">
          {karten.map((box) => (
            <Card key={box.id} padding="lg" radius="lg" className="vp-boxen-karte">
              <div className="vp-boxen-kopf">
                <div>
                  <span className="vp-card-label">VoltPilot-Box</span>
                  <h2>{box.name}</h2>
                </div>
                <span className={`vp-boxen-status is-${box.verbindungTon}`}>{box.verbindung}</span>
              </div>
              {box.verbindungDetail && <p className="vp-boxen-detail">{box.verbindungDetail}</p>}
              <p className="vp-boxen-rolle">{box.rolle}</p>
              <div className="vp-boxen-software">
                <b>{box.faehigkeiten}</b>
                {box.updateNoetig && (
                  <a href={hashForRoute(pageRoute('edge-updates'))}>Update planen <Icon name="chevron-right" size={14} /></a>
                )}
              </div>
              <div className="vp-boxen-quellen-kopf">
                <h3>{box.quellenSatz}</h3>
                {box.budgetSumme && <span>{box.budgetSumme}</span>}
              </div>
              {box.quellen.length === 0 ? (
                <p className="vp-boxen-leer">Datenquelle anlegen</p>
              ) : (
                <ul className="vp-boxen-quellen">
                  {box.quellen.map((q) => (
                    <li key={q.id}>
                      <span className={`vp-health-dot vp-health-${q.ton}`} />
                      <div>
                        <b>{q.kennzeichen} · {q.name}</b>
                        <span>{[q.zustand, q.fehlerklasse, q.seit].filter(Boolean).join(' · ')}</span>
                        <small>{q.budget}</small>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <a className="vp-boxen-oeffnen" href={boxSeiteHash(box.siteId, box.ref)}>
                Box-Seite öffnen <Icon name="chevron-right" size={14} />
              </a>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
