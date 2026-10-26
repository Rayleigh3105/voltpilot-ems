/**
 * Plattform → Geräte → **Werkstatt** (Entscheid des Kapitäns vom 26.10.2026, erster Schnitt aus dem
 * Bericht voltpilot-box-einrichtung-portal).
 *
 * Eine Box einrichten, wie es heute geht, ohne drei Dokumente danebenzulegen: die Schritte als Liste
 * mit fertigen Befehlen, die Liste der Boxen in der Werkstatt, die Werkstatt-Probe über ein Fenster
 * der Fernwartung und am Ende das Abnahmeprotokoll. Die Befehle laufen weiter am eigenen Rechner;
 * ob ein Passwort gesetzt ist oder welcher Schlüssel auf der Box liegt, kann das Portal nicht prüfen.
 * Die Abnahme beruht deshalb auf den Haken des Technikers und auf dem, was die Fernwartung über das
 * Fenster der Probe weiß.
 *
 * Der Ablauf endet mit der Abnahme, nicht mit dem Versand (Entscheid 5c). Die Docker-Box steht im
 * Register, einen eigenen Ablauf bekommt sie erst mit der nächsten Docker-Box (Entscheid 9a).
 *
 * Nur Plattform-Admins. Alle Ableitungen stehen im reinen `werkstatt.ts`.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { ApiError } from '../../api';
import { adminApi } from '../../admin/adminApi';
import {
  abrufLage,
  RUECKMELDUNG_TAKT_MS,
  rueckmeldungLage,
  serverLage,
  zeitpunkt,
  type FernwartungBox,
  type FernwartungFenster,
  type FernwartungTechniker,
  type FernwartungUebersicht,
} from '../../adminFernwartung';
import { LageZeile } from '../../components/FernwartungDialoge';
import { Befehl } from '../../components/FernwartungSsh';
import { ErrorState, TableSkeleton } from '../../components/States';
import {
  AbnahmeAnzeige,
  AbnahmeFormular,
  BeschriftungKarte,
  FensterZuWerkzeug,
  Haken,
  LanWerkzeug,
  PasswortWerkzeug,
  ProbeWerkzeug,
  ReferenzWerkzeug,
  TunnelSchluesselWerkzeug,
} from './WerkstattWerkzeuge';
import { fernwartungHash, parseFernwartungBox, werkstattHash } from '../../nav';
import { replaceCurrentNavigation } from '../../navigationBlocker';
import { useFreshnessPoll } from '../../useFreshnessPoll';
import {
  fortschritt,
  letzteAbnahme,
  probeFenster,
  schritte,
  VERSAND_SATZ,
  VOR_DER_REFERENZ,
  VORBEREITUNG,
  type Schritt,
  type SchrittId,
  type WerkstattBox,
  type WerkstattGrundlagen,
} from '../../werkstatt';
import { AdminPageHead } from './AdminPageHead';
import './Fernwartung.css';
import './Werkstatt.css';

/** `null` = die Liste; `'neu'` = eine Box, die noch keine Referenz hat; sonst ihre Referenz. */
type Auswahl = string | 'neu' | null;

const NEU = 'neu';

export function WerkstattPage({ tabs }: { tabs?: ReactNode } = {}) {
  const [boxen, setBoxen] = useState<WerkstattBox[] | null>(null);
  const [grundlagen, setGrundlagen] = useState<WerkstattGrundlagen | null>(null);
  const [uebersicht, setUebersicht] = useState<FernwartungUebersicht | null>(null);
  const [tunnel, setTunnel] = useState<FernwartungBox[] | null>(null);
  const [techniker, setTechniker] = useState<FernwartungTechniker[]>([]);
  const [fenster, setFenster] = useState<FernwartungFenster[]>([]);
  const [ladeFehler, setLadeFehler] = useState<string | null>(null);
  const [aktionsFehler, setAktionsFehler] = useState<string | null>(null);
  const [auswahl, setAuswahl] = useState<Auswahl>(() => parseFernwartungBox(window.location.hash));
  // Was vor der Referenz abgehakt ist, lebt nur hier: die Box steht erst ab Schritt 5 im Register.
  const [neuErledigt, setNeuErledigt] = useState<Set<SchrittId>>(new Set());
  const [jetzt, setJetzt] = useState(() => new Date());

  async function laden(ref: Auswahl = auswahl) {
    setLadeFehler(null);
    const mitFenster = ref && ref !== NEU ? ref : null;
    const [w, g, u, t, z, f] = await Promise.allSettled([
      adminApi.werkstattBoxen(),
      adminApi.werkstattGrundlagen(),
      adminApi.fernwartung(),
      adminApi.fernwartungBoxen(),
      adminApi.fernwartungTechniker(),
      mitFenster ? adminApi.fernwartungFenster(mitFenster) : Promise.resolve([] as FernwartungFenster[]),
    ]);
    if (w.status === 'fulfilled') setBoxen(w.value);
    if (g.status === 'fulfilled') setGrundlagen(g.value);
    if (u.status === 'fulfilled') setUebersicht(u.value);
    if (t.status === 'fulfilled') setTunnel(t.value);
    if (z.status === 'fulfilled') setTechniker(z.value);
    if (f.status === 'fulfilled') setFenster(f.value);
    const erster = [w, g, u, t, z, f].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    if (erster) {
      setLadeFehler(
        erster.reason instanceof ApiError ? erster.reason.message : 'Die Werkstatt ließ sich nicht laden. Bitte erneut versuchen.',
      );
    }
    setJetzt(new Date());
  }

  useEffect(() => {
    void laden();
    const onHash = () => {
      const a = parseFernwartungBox(window.location.hash);
      setAuswahl(a);
      void laden(a);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Die Probe hängt an dem, was der Tunnel-Dienst meldet: still nachladen wie die Fernwartung.
  useFreshnessPoll(() => void laden(), RUECKMELDUNG_TAKT_MS);

  function waehle(a: Auswahl) {
    setAuswahl(a);
    setAktionsFehler(null);
    replaceCurrentNavigation(werkstattHash(a && a !== NEU ? a : null));
    void laden(a);
    window.scrollTo?.({ top: 0 });
  }

  const tunnelJeRef = useMemo(() => new Map((tunnel ?? []).map((b) => [b.edgeRef, b])), [tunnel]);
  const geladen = boxen && grundlagen && tunnel;
  const box = auswahl && auswahl !== NEU ? (boxen ?? []).find((b) => b.edgeRef === auswahl) ?? null : null;

  return (
    <div className="vp-admin-page vp-fw vp-ws">
      <AdminPageHead
        icon="sliders"
        title="Werkstatt"
        description="Eine Box einrichten und prüfen, bevor sie die Werkstatt verlässt: die Schritte von heute, die Werkstatt-Probe über die Fernwartung und das Abnahmeprotokoll."
      />
      {tabs}

      {ladeFehler && !geladen ? (
        <ErrorState message={ladeFehler} onRetry={() => void laden()} />
      ) : !geladen ? (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <TableSkeleton rows={4} cols={4} />
        </Card>
      ) : (
        <>
          <p className="vp-alert vp-alert-warn vp-ws-versand" data-testid="ws-versand-oben">
            {VERSAND_SATZ}
          </p>
          {uebersicht && (
            <Card padding="md" radius="lg" className="vp-fw-lagen" data-testid="ws-lagen">
              <LageZeile lage={serverLage(uebersicht.server)} testId="ws-server" />
              <LageZeile lage={abrufLage(uebersicht, jetzt)} testId="ws-dienst" />
              <LageZeile lage={rueckmeldungLage(uebersicht, jetzt)} testId="ws-rueckmeldung" />
            </Card>
          )}
          {ladeFehler && <p className="vp-alert vp-alert-warn">{ladeFehler}</p>}
          {aktionsFehler && <p className="vp-alert vp-alert-err">{aktionsFehler}</p>}

          {auswahl == null ? (
            <Liste
              boxen={boxen}
              tunnelJeRef={tunnelJeRef}
              jetzt={jetzt}
              onWaehle={waehle}
            />
          ) : auswahl !== NEU && !box ? (
            <Card padding="md" radius="lg">
              <p style={{ marginTop: 0 }}>{auswahl} steht nicht in der Werkstatt-Liste.</p>
              <Button variant="outline" size="sm" onClick={() => waehle(null)}>
                Zur Liste
              </Button>
            </Card>
          ) : box && box.boxArt !== 'edge-light' ? (
            <DockerBox box={box} onZurueck={() => waehle(null)} />
          ) : (
            <Ablauf
              box={box}
              grundlagen={grundlagen}
              tunnel={box ? tunnelJeRef.get(box.edgeRef) ?? null : null}
              uebersicht={uebersicht}
              techniker={techniker}
              probe={box ? probeFenster(fenster, box.edgeRef) : null}
              neuErledigt={neuErledigt}
              jetzt={jetzt}
              onNeuErledigt={setNeuErledigt}
              onAufgenommen={(b) => {
                setNeuErledigt(new Set());
                setBoxen((alt) => [b, ...(alt ?? []).filter((x) => x.edgeRef !== b.edgeRef)]);
                waehle(b.edgeRef);
              }}
              onBox={(b) => setBoxen((alt) => (alt ?? []).map((x) => (x.edgeRef === b.edgeRef ? b : x)))}
              onFehler={setAktionsFehler}
              onNeuLaden={() => void laden()}
              onZurueck={() => waehle(null)}
            />
          )}
        </>
      )}
    </div>
  );
}

// ── Liste ──────────────────────────────────────────────────────────────────

function Liste({
  boxen,
  tunnelJeRef,
  jetzt,
  onWaehle,
}: {
  boxen: WerkstattBox[];
  tunnelJeRef: Map<string, FernwartungBox>;
  jetzt: Date;
  onWaehle: (a: Auswahl) => void;
}) {
  return (
    <>
      <details className="vp-ws-vorbereitung" data-testid="ws-vorbereitung">
        <summary>Einmal vorbereiten, bevor die erste Box kommt</summary>
        <div className="vp-ws-spalte">
          {VORBEREITUNG.map((v) => (
            <div key={v.titel} className="vp-ws-spalte">
              <strong>{v.titel}</strong>
              <span className="vp-muted">{v.text}</span>
              {v.befehle.map((b) => (
                <Befehl key={b} text={b} was={v.titel} />
              ))}
            </div>
          ))}
          <p className="vp-muted" style={{ margin: 0 }}>
            Im Portal: unter Geräte › Fernwartung muss „Tunnel-Dienst holt ab“ stehen und ein eigener Techniker-Zugang
            mit SSH-Schlüssel bestehen. Die Zeilen oben auf dieser Seite sagen, ob der Wartungsserver eingerichtet ist.
          </p>
        </div>
      </details>

      <section className="vp-fw-sektion" aria-labelledby="ws-sektion-boxen">
        <div className="vp-fw-sektion-kopf">
          <h2 id="ws-sektion-boxen">Boxen in der Werkstatt</h2>
          <Button variant="primary" size="sm" iconLeft={<Icon name="plus" size={16} />} onClick={() => onWaehle(NEU)}>
            Neue Box einrichten
          </Button>
        </div>
        {boxen.length === 0 ? (
          <Card padding="md" radius="lg">
            <p style={{ margin: 0 }} className="vp-muted">
              Noch keine Box. Eine Box kommt in die Liste, sobald sie ihre Referenz hat (Schritt 5 des Ablaufs).
            </p>
          </Card>
        ) : (
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            <div className="vp-table-scroll">
              <table className="vp-table responsive" data-testid="ws-boxen">
                <thead>
                  <tr>
                    <th>Box</th>
                    <th>Fortschritt</th>
                    <th>Tunnel</th>
                    <th>Abnahme</th>
                    <th aria-label="Aktionen" />
                  </tr>
                </thead>
                <tbody>
                  {boxen.map((b) => {
                    const f = fortschritt(b);
                    const a = letzteAbnahme(b);
                    const t = tunnelJeRef.get(b.edgeRef) ?? null;
                    return (
                      <tr key={b.id}>
                        <td data-label="Box">
                          <span className="vp-cell-main">
                            <span>{b.edgeRef}</span>
                            <span className="vp-cell-sub">{b.boxArt === 'edge-light' ? 'Edge Light' : 'Docker-Box'}</span>
                          </span>
                        </td>
                        <td data-label="Fortschritt">
                          {b.boxArt === 'edge-light' ? `${f.erledigt} von ${f.gesamt} Schritten` : 'kein Ablauf'}
                        </td>
                        <td data-label="Tunnel">{t ? t.adresse : <span className="vp-muted">keiner</span>}</td>
                        <td data-label="Abnahme">
                          {a ? (
                            <Badge variant="ok" dot>
                              {`abgenommen ${zeitpunkt(a.erfasstAm, jetzt)}`}
                            </Badge>
                          ) : (
                            <span className="vp-muted">offen</span>
                          )}
                        </td>
                        <td data-label="Aktionen">
                          <div className="vp-fw-aktionen">
                            <Button variant="outline" size="sm" onClick={() => onWaehle(b.edgeRef)}>
                              {a || b.boxArt !== 'edge-light' ? 'Ansehen' : 'Weiter'}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </section>
    </>
  );
}

function DockerBox({ box, onZurueck }: { box: WerkstattBox; onZurueck: () => void }) {
  return (
    <Card padding="md" radius="lg" data-testid="ws-docker">
      <h2 style={{ marginTop: 0 }}>{box.edgeRef} · Docker-Box</h2>
      <p>
        Die Docker-Box steht im Register. Einen eigenen Werkstatt-Ablauf bekommt sie, wenn die nächste Docker-Box
        ansteht (Entscheid 9a); eingerichtet wird sie bis dahin nach edge-app/DEPLOY.md. Für sie gibt es keinen
        Wartungstunnel und deshalb keine Werkstatt-Probe und keine Abnahme.
      </p>
      {box.notiz && <p className="vp-muted">{box.notiz}</p>}
      <Button variant="outline" size="sm" onClick={onZurueck}>
        Zur Liste
      </Button>
    </Card>
  );
}

// ── Ablauf einer Box ───────────────────────────────────────────────────────

function Ablauf({
  box,
  grundlagen,
  tunnel,
  uebersicht,
  techniker,
  probe,
  neuErledigt,
  jetzt,
  onNeuErledigt,
  onAufgenommen,
  onBox,
  onFehler,
  onNeuLaden,
  onZurueck,
}: {
  box: WerkstattBox | null;
  grundlagen: WerkstattGrundlagen;
  tunnel: FernwartungBox | null;
  uebersicht: FernwartungUebersicht | null;
  techniker: FernwartungTechniker[];
  probe: FernwartungFenster | null;
  neuErledigt: Set<SchrittId>;
  jetzt: Date;
  onNeuErledigt: (s: Set<SchrittId>) => void;
  onAufgenommen: (b: WerkstattBox) => void;
  onBox: (b: WerkstattBox) => void;
  onFehler: (f: string | null) => void;
  onNeuLaden: () => void;
  onZurueck: () => void;
}) {
  const [busy, setBusy] = useState<SchrittId | null>(null);
  const [nochmal, setNochmal] = useState(false);
  const liste = schritte({
    ref: box?.edgeRef ?? null,
    tunnelAdresse: tunnel?.adresse ?? null,
    server: uebersicht?.server ?? null,
    lanNetz: box?.lanNetz ?? null,
  });
  const erledigt = (id: SchrittId) => (box ? box.schritte[id] != null : neuErledigt.has(id));
  const abnahme = box ? letzteAbnahme(box) : null;

  async function haken(id: SchrittId, an: boolean) {
    onFehler(null);
    if (!box) {
      const neu = new Set(neuErledigt);
      if (an) neu.add(id);
      else neu.delete(id);
      onNeuErledigt(neu);
      return;
    }
    setBusy(id);
    try {
      onBox(await adminApi.werkstattSchritt(box.edgeRef, id, an));
    } catch (e) {
      onFehler(e instanceof ApiError ? e.message : 'Der Haken ließ sich nicht speichern.');
    } finally {
      setBusy(null);
    }
  }

  function werkzeug(s: Schritt): ReactNode {
    switch (s.werkzeug) {
      case 'passwort':
        return <PasswortWerkzeug erledigt={erledigt('passwort')} onAbgelegt={() => void haken('passwort', true)} />;
      case 'referenz':
        return (
          <ReferenzWerkzeug
            box={box}
            vorher={VOR_DER_REFERENZ.filter((id) => neuErledigt.has(id))}
            onAufgenommen={onAufgenommen}
          />
        );
      case 'tunnel_schluessel':
        return <TunnelSchluesselWerkzeug edgeRef={box?.edgeRef ?? null} tunnel={tunnel} onHinterlegt={onNeuLaden} />;
      case 'probe':
        return (
          <ProbeWerkzeug
            tunnel={tunnel}
            techniker={techniker}
            uebersicht={uebersicht}
            probe={probe}
            jetzt={jetzt}
            onGeaendert={onNeuLaden}
          />
        );
      case 'fenster_zu':
        return tunnel ? <FensterZuWerkzeug probe={probe} jetzt={jetzt} onGeaendert={onNeuLaden} /> : null;
      case 'lan':
        return <LanWerkzeug box={box} vorschlag={grundlagen.lanNetzVorschlag} onGespeichert={onBox} />;
      case 'befehlszeile':
        return liste.find((x) => x.id === 'tunnel')?.befehle.length ? (
          <p className="vp-muted" style={{ margin: 0 }}>
            Die Zeile gilt im Wurzelverzeichnis des Repositorys und bleibt hier stehen.
          </p>
        ) : null;
      default:
        return null;
    }
  }

  // Ohne Referenz lässt sich ab Schritt 5 nichts abhaken: Die Box steht dann noch nicht im Register.
  const abhakbar = (id: SchrittId) => (box ? true : VOR_DER_REFERENZ.includes(id));

  return (
    <section className="vp-fw-sektion" aria-labelledby="ws-ablauf-titel" data-testid="ws-ablauf">
      <div className="vp-fw-sektion-kopf">
        <h2 id="ws-ablauf-titel">{box ? `${box.edgeRef} · Edge Light` : 'Neue Box · Edge Light'}</h2>
        <Button variant="ghost" size="sm" onClick={onZurueck}>
          Zur Liste
        </Button>
      </div>
      {box && (
        <p className="vp-muted" style={{ margin: 0 }}>
          {`${fortschritt(box).erledigt} von ${fortschritt(box).gesamt} Schritten erledigt · in der Liste seit ${zeitpunkt(box.angelegtAm, jetzt)}`}
          {tunnel && ' · '}
          {tunnel && <a href={fernwartungHash(box.edgeRef)}>in der Fernwartung</a>}
        </p>
      )}

      <ol className="vp-ws-schritte">
        {liste.map((s) => {
          const fertig = erledigt(s.id);
          const stand = box?.schritte[s.id];
          return (
            <li key={s.id} className={`vp-ws-schritt${fertig ? ' vp-ws-fertig' : ''}`} data-testid={`ws-schritt-${s.id}`}>
              <details open={!fertig}>
                <summary>
                  <span className="vp-ws-nummer" aria-hidden="true">
                    {fertig ? <Icon name="check" size={14} /> : s.nummer}
                  </span>
                  <span className="vp-ws-titel">
                    <span className="vp-sr-only">{`Schritt ${s.nummer}: `}</span>
                    {s.titel}
                  </span>
                  {fertig && <Badge variant="ok">erledigt</Badge>}
                </summary>
                <div className="vp-ws-inhalt">
                  <p style={{ margin: 0 }}>{s.wozu}</p>
                  {s.befehle.map((b) => (
                    <Befehl key={b} text={b} was={`Befehl aus Schritt ${s.nummer}`} />
                  ))}
                  {s.fehlt && <p className="vp-note" style={{ margin: 0 }}>{s.fehlt}</p>}
                  {werkzeug(s)}
                  <p className="vp-ws-sehen">
                    <strong>Was man sehen sollte: </strong>
                    {s.sehen}
                  </p>
                  {s.werkzeug !== 'referenz' && (
                    <Haken
                      checked={fertig}
                      disabled={busy != null || !abhakbar(s.id)}
                      testId={`ws-haken-${s.id}`}
                      onChange={(an) => void haken(s.id, an)}
                    >
                      {fertig && stand
                        ? `Erledigt ${zeitpunkt(stand.am, jetzt)} von ${stand.von}`
                        : abhakbar(s.id)
                          ? 'Erledigt'
                          : 'Erledigt (erst mit der Referenz aus Schritt 5)'}
                    </Haken>
                  )}
                </div>
              </details>
            </li>
          );
        })}
      </ol>

      <Card padding="md" radius="lg" className="vp-ws-karte" data-testid="ws-karte-beschriftung">
        <h3>Beschriftung des Gehäuses</h3>
        <BeschriftungKarte edgeRef={box?.edgeRef ?? null} />
      </Card>

      <Card padding="md" radius="lg" className="vp-ws-karte" data-testid="ws-karte-abnahme">
        <h3>Abnahme</h3>
        {!box ? (
          <p className="vp-note" style={{ margin: 0 }}>Die Abnahme gehört zu einer Box in der Liste (ab Schritt 5).</p>
        ) : abnahme && !nochmal ? (
          <>
            <AbnahmeAnzeige a={abnahme} jetzt={jetzt} />
            {box.abnahmen.length > 1 && (
              <p className="vp-muted" style={{ margin: 0 }}>{`${box.abnahmen.length - 1} frühere Abnahme(n) bleiben im Protokoll.`}</p>
            )}
            <div>
              <Button variant="ghost" size="sm" onClick={() => setNochmal(true)}>
                Noch einmal abnehmen
              </Button>
            </div>
          </>
        ) : (
          <AbnahmeFormular
            box={box}
            tunnelAdresse={tunnel?.adresse ?? null}
            probe={probe}
            onAngelegt={() => {
              setNochmal(false);
              onNeuLaden();
            }}
          />
        )}
      </Card>

      <Card padding="md" radius="lg" className="vp-ws-karte" data-testid="ws-karte-versand">
        <h3>Verpacken und versenden</h3>
        <p className="vp-alert vp-alert-warn" style={{ margin: 0 }} data-testid="ws-versand">
          {VERSAND_SATZ}
        </p>
      </Card>
    </section>
  );
}
