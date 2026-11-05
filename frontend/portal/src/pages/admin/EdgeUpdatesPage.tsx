import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { Modal } from '../../../designsystem/components/shell/Modal';
import { ApiError } from '../../api';
import { adminApi } from '../../admin/adminApi';
import { MiniShareBar } from '../../components/MiniChart';
import { EmptyState, ErrorState, TableSkeleton } from '../../components/States';
import { fmtRelative } from '../../format';
import { useFreshnessPoll } from '../../useFreshnessPoll';
import { pageRoute, type Route } from '../../nav';
import { BoxArtChip } from './BoxArtChip';
import './BoxVersions.css';
import { AdminPageHead } from './AdminPageHead';
import { GeraeteDrawer, UpdateActionError } from './GeraeteDrawer';
import { BoxenListe, BrauchtDich, LinienKarten, UpdatesLage } from './GeraeteUpdates';
import {
  BOX_ART_LABELS,
  actorLabel,
  blockerLever,
  candidates,
  crossoverHint,
  crossoverState,
  currentRolloutViews,
  eventLabel,
  freshnessLabel,
  progressBackbone,
  releaseBoxArt,
  rolloutDeviceName,
  rolloutStateLabel,
  signatureLabel,
  startSummary,
  stateLabel,
  visibleJournal,
  type BoxArt,
  type EdgeReleaseSeite,
  type EdgeUpdates,
  type EdgeUpdatesRelease,
  type FleetRow,
  type Rollout,
  type RolloutDevice,
  type UpdateTone,
} from '../../adminEdgeUpdates';
import {
  KEIN_FILTER, aufgaben, boxZeilen, lage, linienKarten, type BoxFilter, type LageZiel,
} from '../../geraeteUpdates';
// LIST: eine Verwaltungs-Übersicht bewegt sich nicht sekündlich.
import { LIST_POLL_MS } from '../../pollCadence';

const toneVariant = (tone: UpdateTone): 'ok' | 'warn' | 'off' =>
  tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : 'off';

const fmtWhen = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '–';

/**
 * Das Kleid EINES Zustands - die vier Klassen der Beobachtungs-Grammatik.
 *
 * Bewusst KEIN `Badge`: die Unterscheidung „läuft von selbst" (pulsiert) vs.
 * „ein Vorfall" ist der Punkt, und der Badge kennt nur ok/warn/off. Die Klasse
 * trägt sie, die Beschriftung bleibt die des reinen Moduls.
 */
function StateChip({ state }: { state: string }) {
  const st = stateLabel(state);
  return (
    <span className={`vp-ustate vp-ustate-${st.cls}`} data-testid={`state-${st.cls}`}>
      <i className="vp-ustate-dot" aria-hidden="true" />
      {st.label}
    </span>
  );
}

/** Das neueste Edge-Light-Release: seine Release-Seite sagt, welche Programme fertig im Portal liegen. */
function neuestesLightRelease(data: EdgeUpdates): number | null {
  const line = data.lines?.find((l) => l.boxArt === 'light');
  if (line) return line.newestReleaseSeq;
  const light = data.releases.filter((r) => releaseBoxArt(r) === 'light').sort((a, b) => b.releaseSeq - a.releaseSeq);
  return light[0]?.releaseSeq ?? null;
}

/** Zu einem Abschnitt der Seite springen - ohne Bewegung, die Seite rückt nur. */
function zeige(id: string) {
  window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView?.({ block: 'start' }));
}

/**
 * Plattform → **Geräte & Updates** (Geräte & Updates G5, Konzept vom 05.11.2026).
 *
 * Oben ein Satz zur Lage, dann je Software-Linie eine Karte (Docker-Box und
 * Edge Light nebeneinander, jede mit ihrem neuesten Release), darunter „Braucht
 * dich" mit Grund und nächstem Schritt, dann die Boxen nach Linie. Drei Wörter,
 * nie vermischt: angefragt (Portal) · angenommen (Box) · bestätigt (Box).
 *
 * <b>Verteilen bleibt EIN Schritt:</b> Release wählen, Geräte ankreuzen,
 * „Aktualisieren". Danach holen die Geräte ihre Images und tauschen sich
 * selbst aus - es gibt keinen zweiten Knopf, keine Welle, keine Freigabe und
 * keinen Handgriff am Gerät.
 *
 * <b>Diese Seite entscheidet NICHTS.</b> Was ein Gerät gerade tut, sagt der
 * Server (`RolloutStates`, `LinienStand`, `UpdateFakten`) - hier wird es
 * gerendert. „Unbekannt" ist nie „veraltet", „offline" ist nie
 * „fehlgeschlagen", Stufe 1 ist „nur von Hand" und kein Fehler, und jede
 * nicht-grüne Zeile trägt ihren Grund.
 */
export function EdgeUpdatesPage({
  onNavigate,
  onJumpToTenant,
  tabs,
}: {
  onNavigate?: (target: Route) => void;
  /**
   * Der Weg auf die EINE Geräteseite: sie liegt hinter dem RLS-Zaun, also muss
   * der Mandant gesetzt sein, bevor die Adresse gilt. Ohne diesen Rückruf
   * bietet der Drawer den Weg gar nicht erst an.
   */
  onJumpToTenant?: (tenantId: string, target: Route) => void;
  /** Die Tab-Leiste des Geräte-Bereichs - sie kommt vom Wirt und wird hier nur PLATZIERT. */
  tabs?: ReactNode;
} = {}) {
  const [data, setData] = useState<EdgeUpdates | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rolloutFor, setRolloutFor] = useState<EdgeUpdatesRelease | null>(null);
  const [deviceFor, setDeviceFor] = useState<string | null>(null);
  const [releasesFor, setReleasesFor] = useState<BoxArt | null>(null);
  const [filter, setFilter] = useState<BoxFilter>(KEIN_FILTER);
  // Zustand UND Bezugszeit werden ZUSAMMEN gesetzt - ein Alter, das gegen eine
  // Uhr über einem stehenden Schnappschuss rechnet, verfällt von selbst.
  const [fetchedAt, setFetchedAt] = useState<number>(() => Date.now());
  const [tick, setTick] = useState<number>(() => Date.now());
  // Die Release-Seiten der neuesten Edge-Light-Releases (welche Programme fertig
  // im Portal liegen). Nachgeladen, bis jedes Programm fertig ist; ein
  // Fehlschlag lässt die Chips weg, statt etwas zu behaupten.
  const [seiten, setSeiten] = useState<Map<number, EdgeReleaseSeite>>(() => new Map());
  const seitenRef = useRef(seiten);
  seitenRef.current = seiten;

  function ladeReleaseSeite(d: EdgeUpdates) {
    const seq = neuestesLightRelease(d);
    if (seq == null) return;
    const alt = seitenRef.current.get(seq);
    if (alt && alt.programme.every((p) => p.fertig)) return;
    adminApi.edgeRelease(seq)
      .then((s) => setSeiten((m) => new Map(m).set(seq, s)))
      .catch(() => { /* ohne Release-Seite keine Plattform-Chips - keine Behauptung */ });
  }

  async function load() {
    try {
      const d = await adminApi.edgeUpdates();
      setData(d);
      setFetchedAt(Date.now());
      setTick(Date.now());
      setLoadError(null);
      ladeReleaseSeite(d);
    } catch (e) {
      // Ein Fehlschlag ist keine Datenlage: steht schon eine Seite, bleibt sie
      // mit ihrer ALTEN Bezugszeit stehen - der stille Takt darf den Zustand
      // nie kippen.
      setLoadError(
        e instanceof ApiError ? e.message : 'Die Edge-Updates konnten nicht geladen werden.',
      );
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // Ein Beobachtungs-Werkzeug, das man von Hand aktualisieren muss, erzeugt
  // genau das „hängt es?"-Gefühl. 30 s still, beim Zurückkehren in den Tab
  // sofort (der Hook pausiert im Hintergrund).
  useFreshnessPoll(() => void load(), LIST_POLL_MS, true);
  // Der zweite, billige Takt lässt NUR die Bezugszeit-Zeile weiterzählen.
  useEffect(() => {
    const t = window.setInterval(() => setTick(Date.now()), 5_000);
    return () => window.clearInterval(t);
  }, []);

  /**
   * Eine Schreib-Handlung samt Neuladen. Gibt zurück, OB sie geklappt hat -
   * die Aufrufer schließen ihren Drawer nur dann. Ein Fehlschlag lässt die
   * Auswahl stehen, statt sie mit dem Grund zusammen wegzuräumen: der
   * Betreiber soll den Satz lesen und es erneut versuchen können.
   */
  async function act(fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      // Der Server liefert seinen deutschen Grund mit - er wird gezeigt, nicht
      // durch eine allgemeine Floskel ersetzt.
      setActionError(e instanceof ApiError ? e.message : 'Die Aktion ist fehlgeschlagen.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  // Alles Abgeleitete rechnet gegen die Bezugszeit der Daten, nie gegen eine
  // laufende Uhr über einem stehenden Schnappschuss.
  const jetzt = useMemo(() => new Date(fetchedAt), [fetchedAt]);
  const karten = useMemo(() => (data ? linienKarten(data, jetzt, seiten) : []), [data, jetzt, seiten]);
  const brauchtDich = useMemo(() => (data ? aufgaben(data, jetzt) : []), [data, jetzt]);
  const lageSatz = useMemo(() => (data ? lage(data, jetzt) : null), [data, jetzt]);
  const zeilen = useMemo(() => (data ? boxZeilen(data, jetzt) : []), [data, jetzt]);
  const journal = useMemo(() => visibleJournal(data?.journal ?? []), [data]);
  const crossover = useMemo(() => crossoverHint((data?.fleet ?? [])
    .filter((r) => crossoverState(r.trust, r.boxArt, r.loader).state !== 'von_hand')), [data]);
  // `data.rollouts` enthält bewusst auch jüngere Historie. Live-Zustände
  // gehören aber nur zu der Zuweisung, die das Gerät HEUTE besitzt; sonst
  // würde ein `.26`-Download auch in der alten `.25`-Karte als „lädt" stehen.
  const rollouts = useMemo(
    () => currentRolloutViews(data?.rollouts ?? [], data?.fleet ?? []),
    [data],
  );

  const oeffneBox = (deviceId: string) => { setActionError(null); setDeviceFor(deviceId); };
  // „Fortschritt": die Boxen mit laufendem Update, in ihrer Linie.
  const fortschritt = (art: BoxArt | null) => {
    setFilter({ linie: art ?? 'alle', status: 'lauf', suche: '' });
    zeige('vp-gu-boxen');
  };
  const zuZiel = (ziel: LageZiel) => {
    if (ziel === 'braucht') zeige('vp-gu-braucht');
    else if (ziel === 'aelter') { setFilter({ ...KEIN_FILTER, status: 'aelter' }); zeige('vp-gu-boxen'); }
    else fortschritt(null);
  };

  return (
    <div className="vp-edge-updates">
      {tabs}
      <AdminPageHead
        icon="refresh-cw"
        category="primary"
        title="Geräte & Updates"
        actions={
          <div className="vp-row-gap" style={{ alignItems: 'center' }}>
            {/* Die Bezugszeit der gezeigten Daten - ohne sie ist „nichts
                bewegt sich" von „niemand hat nachgesehen" nicht zu trennen. */}
            <span className="vp-muted vp-text-sm" data-testid="freshness">
              {data ? freshnessLabel(fetchedAt, tick) : 'Versionsstände werden geladen …'} · alle 30 s
            </span>
            <Button
              variant="outline"
              size="sm"
              iconLeft={<Icon name="refresh-cw" size={18} />}
              onClick={() => void load()}
            >
              Neu laden
            </Button>
          </div>
        }
      />

      {actionError && !rolloutFor && !deviceFor && <div className="vp-alert vp-alert-warn" role="alert">{actionError}</div>}
      {loadError && data && <div className="vp-alert vp-alert-warn" role="alert">
        Die Aktualisierung ist fehlgeschlagen. Die zuletzt geladenen Versionsstände bleiben sichtbar.
      </div>}

      {loadError && data == null ? (
        <ErrorState message={loadError} onRetry={() => void load()} />
      ) : data == null ? (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <TableSkeleton rows={5} cols={6} />
        </Card>
      ) : (
        <div className="vp-gu">
          {lageSatz && <UpdatesLage lage={lageSatz} onZiel={zuZiel} />}

          {/* Je Software-Linie eine Karte: ein Edge-Light-Release verdrängt das
              Docker-Release nicht mehr (Geräte & Updates S0/G5). */}
          <LinienKarten
            karten={karten}
            busy={busy || data.fleet.length === 0}
            onVerteilen={(release) => { setActionError(null); setRolloutFor(release); }}
            onReleases={setReleasesFor}
            onFortschritt={fortschritt}
            onNachruesten={oeffneBox}
          />

          {/* Warn-first: was Aufmerksamkeit braucht, steht oben und NENNT die
              Box, den Grund und den nächsten Schritt. Ein Hinweis, keine
              Sperre - nichts hält deswegen an. */}
          <BrauchtDich
            aufgaben={brauchtDich}
            onBox={oeffneBox}
            onFernwartung={onNavigate ? () => onNavigate(pageRoute('fernwartung')) : undefined}
            onNachruesten={oeffneBox}
          />

          <BoxenListe zeilen={zeilen} filter={filter} onFilter={setFilter} onOpen={oeffneBox} />
          {/* Der ruhige TOFU-Hinweis: zählt nur BELEGT offene Crossover; Stufe 1
              steht schon in „Braucht dich". Ein Gerät, das nichts meldet, wird
              getrennt genannt - aus „unbekannt" lässt sich keine Aufgabe ableiten. */}
          {crossover && <p className="vp-muted vp-text-sm" data-testid="fleet-pointer" style={{ margin: 0 }}>{crossover}</p>}

          {/* Laufende Verteilungen: ohne aktuelle Zuweisung gibt es die Karte
              GAR NICHT; ältere Aufträge bleiben im Verlauf, übernehmen aber nie
              den Live-Status eines neueren Releases. */}
          {rollouts.length > 0 && (
            <section id="vp-gu-laeufe" className="vp-gu-block" aria-labelledby="vp-gu-laeufe-titel" data-testid="laeufe">
              <div className="vp-gu-block-titel">
                <h2 id="vp-gu-laeufe-titel">Verteilungen</h2>
                <span className="vp-gu-leise vp-gu-klein">je Release, mit jeder Box</span>
              </div>
              {rollouts.map((r) => (
                <RolloutCard key={r.id} rollout={r} fleet={data.fleet} onOpenDevice={oeffneBox} />
              ))}
            </section>
          )}

          <Card padding="lg" radius="lg">
            <details>
            <summary className="vp-sec-summary"><h3 style={{ margin: 0, display: 'inline' }}>
              Verlauf
            </h3></summary>
            {journal.length === 0 ? (
              <EmptyState title="Noch nichts passiert" description="" />
            ) : (
              <ul className="vp-plain-list" data-testid="journal">
                {journal.slice(0, 50).map((e) => (
                  <li key={e.id}>
                    <span className="vp-muted">{fmtWhen(e.at)}</span> ·{' '}
                    <strong>{actorLabel(e.actor)}</strong> · {eventLabel(e.event)}
                    {e.detail ? ` – ${e.detail}` : ''}
                  </li>
                ))}
              </ul>
            )}
            </details>
          </Card>
        </div>
      )}

      {deviceFor && data && (() => {
        const row = data.fleet.find((r) => r.deviceId === deviceFor);
        if (!row) return null;
        return (
          <GeraeteDrawer
            device={row}
            releases={data.releases}
            journal={data.journal}
            busy={busy}
            error={actionError}
            onClose={() => { setDeviceFor(null); setActionError(null); }}
            onAssign={async (releaseSeq) => {
              if (await act(() => adminApi.setUpdateTarget(row.deviceId, { releaseSeq }))) {
                setDeviceFor(null);
              }
            }}
            onRevert={async () => {
              if (await act(() => adminApi.revertUpdateTarget(row.deviceId))) {
                setDeviceFor(null);
              }
            }}
            onOpenGeraetseite={
              onJumpToTenant
                ? () => {
                    setDeviceFor(null);
                    onJumpToTenant(row.tenantId, {
                      page: 'anlagen',
                      siteId: row.siteId,
                      sub: 'geraet',
                      geraet: { ref: row.externalRef, geraetId: null },
                    });
                  }
                : undefined
            }
          />
        );
      })()}

      {releasesFor && data && (
        <LinienReleases
          art={releasesFor}
          releases={data.releases}
          busy={busy || data.fleet.length === 0}
          onClose={() => setReleasesFor(null)}
          onVerteilen={(release) => { setReleasesFor(null); setActionError(null); setRolloutFor(release); }}
        />
      )}

      {rolloutFor && data && (
        <StartRolloutDrawer
          release={rolloutFor}
          fleet={data.fleet}
          busy={busy}
          error={actionError}
          onClose={() => { setRolloutFor(null); setActionError(null); }}
          onStart={async (devices) => {
            const ok = await act(() =>
              adminApi.createRollout({ releaseSeq: rolloutFor.releaseSeq, devices }),
            );
            if (ok) setRolloutFor(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Die Releases EINER Linie, neueste zuerst: je Release ein Knopf, der die
 * Geräte-Auswahl öffnet. Nur ein SIGNIERTES Release ist verteilbar - ohne
 * Manifest-Bytes hat ein Gerät nichts, was es gegen seine eingebackene Wurzel
 * prüfen könnte. Das ist das EINZIGE Tor am Release, nie am Zustand eines Geräts.
 */
function LinienReleases({
  art, releases, busy, onClose, onVerteilen,
}: {
  art: BoxArt;
  releases: EdgeUpdatesRelease[];
  busy: boolean;
  onClose: () => void;
  onVerteilen: (release: EdgeUpdatesRelease) => void;
}) {
  const liste = releases.filter((r) => releaseBoxArt(r) === art).sort((a, b) => b.releaseSeq - a.releaseSeq);
  return (
    <Modal open breit title={`Releases · ${BOX_ART_LABELS[art]}`} onClose={onClose}>
      {liste.length === 0 ? (
        <EmptyState
          title="Noch kein Release registriert"
          description="Ohne Register ist „veraltet“ keine Aussage. Ein Release trägt sich beim Bau selbst ein (CI signiert und registriert es)."
        />
      ) : (
        <table className="vp-table responsive" data-testid="releases">
          <thead>
            <tr>
              <th>Version</th>
              <th>Commit</th>
              <th>Signatur</th>
              <th>Läuft auf</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {liste.map((r) => {
              const sig = signatureLabel(r);
              return (
                <tr key={r.releaseSeq}>
                  <td data-label="Version">
                    <strong>{r.version}</strong>
                    {r.notes && <div className="vp-muted vp-text-sm">{r.notes}</div>}
                  </td>
                  <td data-label="Commit" className="vp-muted">{r.targetCommit ?? '–'}</td>
                  <td data-label="Signatur">
                    <Badge variant={toneVariant(sig.tone)} dot>{sig.label}</Badge>
                  </td>
                  <td data-label="Läuft auf">
                    {r.runningOnDevices === 0
                      ? '–'
                      : `${r.runningOnDevices} Gerät${r.runningOnDevices === 1 ? '' : 'e'}`}
                  </td>
                  <td>
                    {r.signed ? (
                      <Button variant="primary" size="sm" disabled={busy} onClick={() => onVerteilen(r)}>
                        Aktualisieren ▸
                      </Button>
                    ) : (
                      <span className="vp-muted vp-text-sm">Nicht signiert – nicht verteilbar</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

/**
 * EINE Aktualisierung: Kopf, Fortschritts-Rückgrat, Geräte-Zeilen.
 *
 * Es gibt hier keinen Knopf mehr. Die Karte ist reine BEOBACHTUNG - das war
 * bis zum Ein-Schritt-Umbau die Ausnahme und ist jetzt die Regel.
 */
function RolloutCard({
  rollout,
  fleet,
  onOpenDevice,
}: {
  rollout: Rollout;
  fleet: FleetRow[];
  onOpenDevice: (deviceId: string) => void;
}) {
  const st = rolloutStateLabel(rollout.state);
  const progress = useMemo(() => progressBackbone(rollout, fleet), [rollout, fleet]);
  const live = useMemo(
    () => new Map(fleet.map((r) => [r.deviceId, r] as const)),
    [fleet],
  );

  return (
    <Card padding="lg" radius="lg" style={{ marginBottom: 'var(--vp-space-6)' }}
          data-testid="rollout-card">
      <div className="vp-row-gap" style={{ alignItems: 'baseline' }}>
        <h3 style={{ marginTop: 0 }}>{rollout.releaseVersion}</h3>
        <Badge variant={toneVariant(st.tone)} dot>{st.label}</Badge>
        <span className="vp-muted vp-text-sm">
          gestartet {fmtRelative(rollout.createdAt)}
          {rollout.createdBy ? ` · ${actorLabel(rollout.createdBy)}` : ''}
        </span>
      </div>

      {/* Das Fortschritts-Rückgrat: wo steht die Verteilung, in einem Blick -
          über die ERREICHBARE Menge, offline daneben statt im Nenner. */}
      {progress && progress.total > 0 && (
        <div className="vp-backbone" data-testid="backbone">
          <MiniShareBar
            className="vp-backbone-bar"
            segments={progress.segments.map((s) => ({
              key: s.cls,
              weight: s.count,
              className: `vp-backbone-seg vp-ustate-${s.cls}`,
              title: `${s.count} ${s.label}`,
            }))}
          />
          <div className="vp-backbone-legend vp-text-sm">
            {progress.segments.map((s) => (
              <span key={s.cls} className="vp-backbone-key">
                <i className={`vp-ustate-dot vp-ustate-${s.cls}`} aria-hidden="true" />
                {s.count} {s.label}
              </span>
            ))}
            {progress.asideNote && (
              <span className="vp-muted" data-testid="backbone-aside">
                {progress.asideNote}
              </span>
            )}
          </div>
        </div>
      )}

      <table className="vp-table responsive" data-testid="rollout-devices">
        <thead>
          <tr>
            <th>Anlage</th>
            <th>Ist</th>
            <th>Zustand</th>
            <th>Grund</th>
          </tr>
        </thead>
        <tbody>
          {rollout.devices.map((d) => (
            <RolloutDeviceRow
              key={d.deviceId}
              device={d}
              row={live.get(d.deviceId) ?? null}
              onOpen={onOpenDevice}
            />
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/**
 * Eine Geräte-Zeile EINER Aktualisierung.
 *
 * Der Zustand kommt LIVE aus der Flotte, wo es sie gibt - eine Fläche, eine
 * Wahrheit. Fehlt das Gerät dort (Unclaim), bleibt der Schnappschuss der Zeile
 * stehen und sagt das ausdrücklich; eine UUID wird nie gerendert.
 */
function RolloutDeviceRow({
  device,
  row,
  onOpen,
}: {
  device: RolloutDevice;
  row: FleetRow | null;
  onOpen: (deviceId: string) => void;
}) {
  const name = rolloutDeviceName(device);
  const state = row?.state ?? device.state;
  const reason = row?.reason ?? device.reason;
  const lever = blockerLever(row?.blocker);
  return (
    <tr>
      <td data-label="Anlage">
        {row ? (
          <button type="button" className="vp-linkbtn" onClick={() => onOpen(device.deviceId)}>
            {name.name}
          </button>
        ) : (
          <span className={name.removed ? 'vp-muted' : undefined}>{name.name}</span>
        )}
        {device.tenantName && (
          <div className="vp-muted vp-text-sm">{device.tenantName}</div>
        )}
      </td>
      <td data-label="Ist">
        {row?.ist ?? '–'}
      </td>
      <td data-label="Zustand"><StateChip state={state} /></td>
      {/* Jede nicht-grüne Zeile trägt ihren Grund. Der HEBEL kommt aus dem
          maschinenlesbaren Namen, nie aus einer Stichwortsuche im Satz. */}
      <td data-label="Grund" className="vp-muted vp-text-sm">
        {reason ?? '–'}
        {lever && <div className="vp-lever">Hebel: {lever}</div>}
      </td>
    </tr>
  );
}

/**
 * Der EINE Schritt: Geräte ankreuzen, „Aktualisieren".
 *
 * Es gibt keine Welle, keinen Canary, keinen Kanal und keine Vorbedingung über
 * den Zustand eines Geräts. Ein Einwand an einem Gerät ist ein HINWEIS: ein
 * offline gegangenes Gerät holt die Zuweisung beim nächsten Verbindungsaufbau
 * selbst ab (sie liegt retained beim Broker).
 *
 * Die eine Sperre ist die Box-Art: ein Gerät, auf das dieses Release nicht
 * passt, steht ausgegraut mit Grund in der Liste („Alle passenden Geräte"
 * wählt es nicht mit) - die API würde es mit 409 ablehnen.
 */
function StartRolloutDrawer({
  release,
  fleet,
  busy,
  error,
  onClose,
  onStart,
}: {
  release: EdgeUpdatesRelease;
  fleet: FleetRow[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onStart: (devices: string[]) => Promise<void>;
}) {
  const cands = useMemo(() => candidates(fleet, release), [fleet, release]);
  const passend = useMemo(() => cands.filter((c) => !c.sperre), [cands]);
  const gesperrt = cands.length - passend.length;
  const [chosen, setChosen] = useState<string[]>([]);
  const summary = useMemo(() => startSummary(chosen, fleet), [chosen, fleet]);
  const allChosen = passend.length > 0 && chosen.length === passend.length;

  return (
    <Modal open title={`Aktualisieren auf ${release.version}`} onClose={onClose}>
      <UpdateActionError error={error} />
      <p className="vp-muted">
        Die gewählten Geräte bekommen das Release sofort zugewiesen und aktualisieren sich
        selbst. Es gibt keinen zweiten Schritt - niemand muss an ein Gerät.
      </p>
      <p className="vp-text-sm" data-testid="release-box-art">
        Release für <BoxArtChip boxArt={releaseBoxArt(release)} />
        {gesperrt > 0 && (
          <span className="vp-muted">
            {' '}· {gesperrt === 1
              ? '1 Gerät passt nicht dazu und ist ausgegraut.'
              : `${gesperrt} Geräte passen nicht dazu und sind ausgegraut.`}
          </span>
        )}
      </p>

      <label className="vp-check-row" data-testid="choose-all">
        <input
          type="checkbox"
          checked={allChosen}
          disabled={passend.length === 0}
          onChange={(e) =>
            setChosen(e.target.checked ? passend.map((c) => c.deviceId) : [])
          }
        />{' '}
        <strong>
          {gesperrt > 0 ? 'Alle passenden Geräte' : 'Alle Geräte'} ({passend.length})
        </strong>
      </label>

      <fieldset style={{ border: 0, padding: 0 }}>
        <legend className="vp-text-sm" style={{ fontWeight: 600 }}>Geräte</legend>
        {cands.map((c) => (
          <label key={c.deviceId}
            className={`vp-check-row vp-candidate${c.sperre ? ' vp-candidate-gesperrt' : ''}`}
            data-testid={c.sperre ? 'candidate-gesperrt' : 'candidate'}>
            <input
              type="checkbox"
              checked={chosen.includes(c.deviceId)}
              disabled={!!c.sperre}
              onChange={(e) =>
                setChosen((prev) =>
                  e.target.checked
                    ? [...prev, c.deviceId]
                    : prev.filter((id) => id !== c.deviceId),
                )
              }
            />{' '}
            <span className="vp-cell-main">
              <span>
                {c.name} <span className="vp-muted">· {c.tenantName}</span>{' '}
                <BoxArtChip boxArt={c.boxArt} />{' '}
                <span className={`vp-ustate vp-ustate-${c.cls}`}>
                  <i className="vp-ustate-dot" aria-hidden="true" />
                  {c.state}
                </span>
              </span>
              {/* Die Box-Art ist eine SPERRE (die API lehnt mit 409 ab) und
                  steht deshalb mit Grund an der ausgegrauten Zeile. */}
              {c.sperre && <span className="vp-cell-sub">{c.sperre}</span>}
              {/* Ein Einwand ist ein HINWEIS, nie eine Sperre - die Checkbox
                  bleibt wählbar. */}
              {!c.sperre && c.caveat && <span className="vp-cell-sub vp-lever">{c.caveat}</span>}
            </span>
          </label>
        ))}
      </fieldset>

      {/* Was dieser Klick konkret auslöst - inklusive dessen, was NICHT sofort
          passiert (offline nachholend). Das sieht später wie ein Fehler aus,
          wenn es hier nicht angekündigt wurde. */}
      {summary.length > 0 && (
        <>
          <h4>Das passiert jetzt</h4>
          <ul className="vp-plain-list vp-text-sm" data-testid="start-summary">
            {summary.map((l) => <li key={l}>{l}</li>)}
          </ul>
        </>
      )}

      <Button
        variant="primary"
        disabled={busy || chosen.length === 0}
        onClick={() => void onStart(chosen)}
      >
        Aktualisieren
      </Button>
    </Modal>
  );
}
