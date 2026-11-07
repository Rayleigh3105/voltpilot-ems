import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { Modal } from '../../../designsystem/components/shell/Modal';
import { ApiError } from '../../api';
import { adminApi } from '../../admin/adminApi';
import { EmptyState, ErrorState, TableSkeleton } from '../../components/States';
import { useFreshnessPoll } from '../../useFreshnessPoll';
import { geraeteAkteRoute, pageRoute, type Route } from '../../nav';
import './BoxVersions.css';
import { AdminPageHead } from './AdminPageHead';
import { ReleaseSeite } from './ReleaseSeite';
import { BrauchtDich, LinienKarten, UpdatesLage } from './GeraeteUpdates';
import { VerteilDialog, type VerteilStart } from './VerteilDialog';
import {
  BOX_ART_LABELS,
  actorLabel,
  crossoverHint,
  crossoverState,
  eventLabel,
  freshnessLabel,
  releaseBoxArt,
  signatureLabel,
  visibleJournal,
  type BoxArt,
  type EdgeReleaseSeite,
  type EdgeUpdates,
  type EdgeUpdatesRelease,
  type UpdateTone,
} from '../../adminEdgeUpdates';
import { aufgaben, lage, linienKarten, type LageZiel } from '../../geraeteUpdates';
// LIST: eine Verwaltungs-Übersicht bewegt sich nicht sekündlich.
import { LIST_POLL_MS } from '../../pollCadence';

const toneVariant = (tone: UpdateTone): 'ok' | 'warn' | 'off' =>
  tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : 'off';

const fmtWhen = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '–';

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
  tabs,
}: {
  /** Auch für den Sprung in die Geräteakte einer Box (`geraeteAkteRoute`, Scheibe S2). */
  onNavigate?: (target: Route) => void;
  /** Die Tab-Leiste des Geräte-Bereichs - sie kommt vom Wirt und wird hier nur PLATZIERT. */
  tabs?: ReactNode;
} = {}) {
  const [data, setData] = useState<EdgeUpdates | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verteilen, setVerteilen] = useState<VerteilStart | null>(null);
  const [releasesFor, setReleasesFor] = useState<BoxArt | null>(null);
  const [releaseFor, setReleaseFor] = useState<number | null>(null);
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
  const journal = useMemo(() => visibleJournal(data?.journal ?? []), [data]);
  const crossover = useMemo(() => crossoverHint((data?.fleet ?? [])
    .filter((r) => crossoverState(r.trust, r.boxArt, r.loader).state !== 'von_hand')), [data]);

  /**
   * Die Boxenliste entfällt hier (§4.3, Scheibe S2) - jede Box-Zeile führt
   * seither in ihre Geräteakte (`geraeteAkteRoute`), nie mehr in ein Fenster.
   */
  const oeffneBox = (deviceId: string) => {
    setActionError(null);
    const ref = data?.fleet.find((r) => r.deviceId === deviceId)?.externalRef;
    if (ref && onNavigate) onNavigate(geraeteAkteRoute(ref, 'software'));
  };
  // „Fortschritt" und „Älter": die Boxenliste wohnt seither in der Geräte-Liste (Chips „Update läuft"/„Älter").
  const fortschritt = (_art?: BoxArt | null) => onNavigate?.({ page: 'geraete-registry', siteId: null, sub: null });
  const zuZiel = (ziel: LageZiel) => {
    if (ziel === 'braucht') zeige('vp-gu-braucht');
    else fortschritt();
  };

  return (
    <div className="vp-edge-updates">
      {tabs}
      <AdminPageHead
        icon="refresh-cw"
        category="primary"
        // N5 (Scheibe S1, Abschnitt 9): EIN Name für die Seite - vorher fünf
        // („Geräte", „Updates", „Geräte & Updates", „Edge-Updates", die Route
        // `edge-updates`). Die Route bleibt (Lesezeichen), der Name ist „Software".
        title="Software"
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

      {actionError && !verteilen && <div className="vp-alert vp-alert-warn" role="alert">{actionError}</div>}
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
            onVerteilen={(release) => { setActionError(null); setVerteilen({ art: releaseBoxArt(release), releaseSeq: release.releaseSeq }); }}
            onReleases={setReleasesFor}
            onFortschritt={fortschritt}
            onNachruesten={oeffneBox}
            onRelease={(seq) => setReleaseFor(seq)}
            onWeiter={(art, releaseSeq, uebrige) => {
              setActionError(null);
              setVerteilen({ art, releaseSeq, nur: uebrige, reihenfolge: 'alle' });
            }}
          />

          {/* Warn-first: was Aufmerksamkeit braucht, steht oben und NENNT die
              Box, den Grund und den nächsten Schritt. Ein Hinweis, keine
              Sperre - nichts hält deswegen an. */}
          <BrauchtDich
            aufgaben={brauchtDich}
            busy={busy}
            onBox={oeffneBox}
            onNochmal={(deviceId, releaseSeq) => void act(() => adminApi.setUpdateTarget(deviceId, { releaseSeq }))}
            onZurueckziehen={(ids) => void act(async () => {
              // Nacheinander: ein Fehlschlag hält an und nennt seinen Grund.
              for (const id of ids) await adminApi.revertUpdateTarget(id);
            })}
            onFernwartung={onNavigate ? () => onNavigate(pageRoute('fernwartung')) : undefined}
            onNachruesten={oeffneBox}
          />

          {/* Der ruhige TOFU-Hinweis: zählt nur BELEGT offene Crossover; Stufe 1
              steht schon in „Braucht dich". Ein Gerät, das nichts meldet, wird
              getrennt genannt - aus „unbekannt" lässt sich keine Aufgabe ableiten. */}
          {crossover && <p className="vp-muted vp-text-sm" data-testid="fleet-pointer" style={{ margin: 0 }}>{crossover}</p>}

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

      {releaseFor != null && data && (
        <ReleaseSeite
          releaseSeq={releaseFor}
          releases={data.releases}
          fleet={data.fleet}
          ladeSeite={(seq) => adminApi.edgeRelease(seq)}
          onClose={() => setReleaseFor(null)}
          onVerteilen={(release) => {
            setReleaseFor(null);
            setActionError(null);
            setVerteilen({ art: releaseBoxArt(release), releaseSeq: release.releaseSeq });
          }}
          onBox={(id) => { setReleaseFor(null); oeffneBox(id); }}
        />
      )}

      {releasesFor && data && (
        <LinienReleases
          art={releasesFor}
          releases={data.releases}
          busy={busy || data.fleet.length === 0}
          onClose={() => setReleasesFor(null)}
          onRelease={(seq) => { setReleasesFor(null); setReleaseFor(seq); }}
          onVerteilen={(release) => {
            setReleasesFor(null);
            setActionError(null);
            setVerteilen({ art: releaseBoxArt(release), releaseSeq: release.releaseSeq });
          }}
        />
      )}

      {verteilen && data && (
        <VerteilDialog
          start={verteilen}
          releases={data.releases}
          fleet={data.fleet}
          boxenDerLinie={karten.find((k) => k.boxArt === verteilen.art)?.gesamt ?? 0}
          ladeEignung={(seq) => adminApi.edgeEignung(seq)}
          busy={busy}
          error={actionError}
          onClose={() => { setVerteilen(null); setActionError(null); }}
          onStart={async (releaseSeq, devices) => {
            if (await act(() => adminApi.createRollout({ releaseSeq, devices }))) setVerteilen(null);
          }}
          onNachruesten={(deviceId) => { setVerteilen(null); oeffneBox(deviceId); }}
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
  art, releases, busy, onClose, onRelease, onVerteilen,
}: {
  art: BoxArt;
  releases: EdgeUpdatesRelease[];
  busy: boolean;
  onClose: () => void;
  /** Die Release-Seite öffnen (G7). */
  onRelease: (releaseSeq: number) => void;
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
        // Am Telefon (`vp-zeilen`): Version und Signatur oben, darunter Beschreibung, Commit, „Läuft auf“
        // und „Verteilen ▸“ - vorher Etikett/Wert-Karten, die Beschreibung ragte rechts aus dem Blatt.
        <table className="vp-table responsive vp-zeilen vp-releases-tabelle" data-testid="releases">
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
                  <td data-label="Version" data-zeile="haupt">
                    <button type="button" className="vp-gu-link" onClick={() => onRelease(r.releaseSeq)}>
                      <strong>{r.version}</strong>
                    </button>
                    {r.notes && <div className="vp-muted vp-text-sm">{r.notes}</div>}
                  </td>
                  <td data-label="Commit" data-zeile="neben" className="vp-muted vp-zeilen-etikett">{r.targetCommit ?? '–'}</td>
                  <td data-label="Signatur" data-zeile="marke">
                    <Badge variant={toneVariant(sig.tone)} dot>{sig.label}</Badge>
                  </td>
                  <td data-label="Läuft auf" data-zeile="neben" className="vp-zeilen-etikett">
                    {r.runningOnDevices === 0
                      ? '–'
                      : `${r.runningOnDevices} Gerät${r.runningOnDevices === 1 ? '' : 'e'}`}
                  </td>
                  <td data-zeile="fuss">
                    {r.signed ? (
                      <Button variant="primary" size="sm" disabled={busy} onClick={() => onVerteilen(r)}>
                        Verteilen ▸
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
