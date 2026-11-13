import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { AufklapperKarte } from '../../components/AufklapperKarte';
import { useReiterRand } from '../../reiterRand';
import { VpPicker } from '../../components/VpPicker';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ApiError } from '../../api';
import {
  adminApi, type AdminDeviceRow, type AdminGeraeteAkte, type BoxEndgueltigBefund,
  type ControlCandidate, type PendingEnrollment, type Tenant,
} from '../../admin/adminApi';
import { ausgebautZeile, bleibtSatz, NIE_DATEN_SATZ } from '../../boxEndgueltig';
import { EmptyState, ErrorState, TableSkeleton } from '../../components/States';
import {
  BOX_ART_LABELS, BOX_ART_UNBEKANNT, crossoverState, freshnessLabel, releaseBoxArt,
  type BoxVerlauf, type EdgeUpdates, type EdgeUpdatesRelease, type FleetRow,
} from '../../adminEdgeUpdates';
import {
  boxFakten, linieDerBox, messwerteLuecke, stufe1Hinweis, verbindungSicht, verlaufSicht,
  type BoxVerbindungSicht,
} from '../../geraeteUpdates';
import { PENDING_KONTEXT, pendingErreichbarText, pendingRows } from '../../onboardingFunnel';
import { fmtRelative } from '../../format';
import { useFreshnessPoll } from '../../useFreshnessPoll';
import { LIVE_POLL_MS } from '../../pollCadence';
import { FernwartungKarte } from '../../components/FernwartungKarte';
import { ProtokollListe } from './FernwartungPage';
import { type FernwartungProtokollEintrag } from '../../adminFernwartung';
import { liesDienst, uebersicht, type UebersichtZeile, type WerkstattDienst, type WerkstattFreigabe } from '../../werkstattBank';
import type { WerkstattBox } from '../../werkstatt';
import { fleetApi, type AdminFleetSite } from '../../admin/fleetApi';
import { controlMatrixRow, planCell } from '../../adminFleet';
import {
  activateConsequences, certSourceLabel, deactivateConsequences, plantCertView,
} from '../../controlCertification';
import { ablehnung, pflegeOrt, quellenText, sollIst, type FlottenAnlage } from '../../adminKomponentenFlotte';
import { OptimizerPage } from './OptimizerPage';
import { FlowsPage } from './FlowsPage';
import {
  anlageRoute, geraeteAkteRoute, pageRoute,
  type AnlageWerkzeug, type GeraeteAkteReiter, type Route,
} from '../../nav';
import { BoxArtChip } from './BoxArtChip';
import { BoxLoesenDialog } from './BoxLoesenDialog';
import { BoxEndgueltigLoeschenDialog } from './BoxEndgueltigLoeschenDialog';
import { AdminPageHead } from './AdminPageHead';
import { Zeitleiste } from './Zeitleiste';
import { WerkstattBoxSeite } from './WerkstattBoxSeite';
import '../GeraetSeite.css';
import './BoxVersions.css';
import './Fernwartung.css';
import './GeraeteAkte.css';

/**
 * Die GERÄTEAKTE (Konzept `vp-adminview-konzept-k1` §4.4, Scheiben S2/S3):
 * EIN Ort für alles, was zu einer Box gehört. Sie adressiert die Box-KENNUNG
 * (nicht die UUID, §4.2) und setzt sich aus vorhandenen Antworten zusammen
 * (`/admin/edge-updates`, `/admin/devices`, `/admin/enrollments/pending`,
 * `/admin/fernwartung*`, `/admin/werkstatt/*`, `/admin/fleet`,
 * `/admin/control-candidates`, `/admin/component-fleet`); nur eine AUSGEBAUTE
 * Box lädt dazu den Befund `/admin/geraete/{ref}/endgueltig-loeschen`
 * (vierter Löschweg, vp-box-endgueltig-loeschen).
 *
 * E1 = A: bearbeitet wird inline, auf dieser Seite - kein Fenster.
 * E4 = A: die Kundenseiten verlinken nur noch hierher.
 */
export function GeraeteAktePage({
  boxRef,
  reiter,
  werkzeug = null,
  onNavigate,
  onJumpToTenant,
  tenants = [],
}: {
  boxRef: string;
  reiter: GeraeteAkteReiter | null;
  /** Nur unter `reiter === 'anlage'` (§4.4, Scheibe S3): öffnet das Werkzeug direkt. */
  werkzeug?: AnlageWerkzeug | null;
  onNavigate?: (target: Route) => void;
  /** Reiter „Anlage": „Prognose"/„Gemeinsame Steuerung" öffnen „Wie der Kunde es sieht". */
  onJumpToTenant?: (tenantId: string, target: Route) => void;
  tenants?: Tenant[];
}) {
  const [edgeUpdates, setEdgeUpdates] = useState<EdgeUpdates | null>(null);
  const [devices, setDevices] = useState<AdminDeviceRow[] | null>(null);
  const [pending, setPending] = useState<PendingEnrollment[] | null>(null);
  const [werkstattBoxen, setWerkstattBoxen] = useState<WerkstattBox[] | null>(null);
  const [werkstattDienst, setWerkstattDienst] = useState<WerkstattDienst | null>(null);
  const [werkstattFreigaben, setWerkstattFreigaben] = useState<WerkstattFreigabe[] | null>(null);
  const [verlauf, setVerlauf] = useState<BoxVerlauf | null>(null);
  const [fwProtokoll, setFwProtokoll] = useState<FernwartungProtokollEintrag[] | null>(null);
  const [akte, setAkte] = useState<AdminGeraeteAkte | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [jetzt, setJetzt] = useState(() => new Date());
  // Beobachtungswerkzeug (§5.2): Bezugszeit des letzten ERFOLGS, nie eine
  // laufende Uhr über einem stehenden Schnappschuss (`liveness.ts`).
  const [fetchedAt, setFetchedAt] = useState<number>(() => Date.now());
  const [tick, setTick] = useState<number>(() => Date.now());
  const [pollFehler, setPollFehler] = useState(false);
  // §5.4: der Herzschlag-Punkt schlägt EINMAL, wenn eine Antwort einen
  // NEUEREN Herzschlag trägt als die vorige - ein Beleg, keine Dauer-Animation.
  const [pulsiert, setPulsiert] = useState(false);
  const letzterHerzschlag = useRef<string | null>(null);
  const hatteDaten = useRef(false);
  // L1/L2 (Konzept vp-plattform-admin-box-benutzer-konzept): „Vom Kunden lösen" - der Dialog
  // teilt sich die Kopf-Karte UND den Menüeintrag (B4 = A, dieselbe Handlung, zwei Einstiege).
  const [loesenOffen, setLoesenOffen] = useState(false);
  // Endgültig löschen (vierter Löschweg, vp-box-endgueltig-loeschen): nur für AUSGEBAUTE Boxen.
  // Der Befund kommt EINMAL vom Server und speist Karte und Dialog - das Portal behauptet nichts.
  const [endgueltigOffen, setEndgueltigOffen] = useState(false);
  const [endgueltigBefund, setEndgueltigBefund] = useState<BoxEndgueltigBefund | null>(null);

  async function laden() {
    const [eu, dv, pe, wb, wd, wf, fw, ak] = await Promise.allSettled([
      adminApi.edgeUpdates(), adminApi.listDevices(), adminApi.listPendingEnrollments(),
      adminApi.werkstattBoxen(), adminApi.werkstattDienst(), adminApi.werkstattFreigaben(),
      adminApi.fernwartungProtokoll({ box: boxRef, limit: 100 }), adminApi.geraeteAkte(boxRef),
    ]);
    if (eu.status === 'fulfilled') setEdgeUpdates(eu.value);
    if (dv.status === 'fulfilled') setDevices(dv.value);
    if (pe.status === 'fulfilled') setPending(pe.value);
    if (wb.status === 'fulfilled') setWerkstattBoxen(wb.value);
    if (wd.status === 'fulfilled') setWerkstattDienst(liesDienst(wd.value));
    if (wf.status === 'fulfilled') setWerkstattFreigaben(wf.value);
    if (fw.status === 'fulfilled') setFwProtokoll(fw.value);
    if (ak.status === 'fulfilled') {
      const neu = ak.value.kopf?.herzschlagAm ?? null;
      if (neu && letzterHerzschlag.current != null && neu !== letzterHerzschlag.current) setPulsiert(true);
      if (neu) letzterHerzschlag.current = neu;
      setAkte(ak.value);
    }
    const erfolg = eu.status === 'fulfilled' || dv.status === 'fulfilled' || ak.status === 'fulfilled';
    if (erfolg) {
      hatteDaten.current = true;
      setPollFehler(false);
      setLoadError(null);
      setFetchedAt(Date.now());
      setJetzt(new Date());
    } else if (hatteDaten.current) {
      // Ein fehlgeschlagener Abruf ist keine Datenlage (§5.2/`liveness.ts`):
      // die Werte und ihre Bezugszeit bleiben stehen, nur die Fehlerzeile
      // erscheint - die Seite blendet sich nie auf eine leere Fehlerseite um,
      // sobald sie einmal etwas zu zeigen hatte.
      setPollFehler(true);
    } else {
      setLoadError('Diese Box ließ sich nicht laden.');
    }
    setLoading(false);
  }

  useEffect(() => {
    setLoading(true);
    hatteDaten.current = false;
    letzterHerzschlag.current = null;
    void laden();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxRef]);
  // Tabelle 5.1 nennt für Software/Verbindung/Einrichtung eigene, LANGSAMERE
  // Takte (30 s, 20 s, 5 s nur während eines Werkstatt-Laufs) - `laden()` holt
  // aber ohnehin alle Reiter in EINER Runde, also bekommt die ganze Akte den
  // schnellsten Takt (Kopf/Überblick, 10 s). Das ist immer MINDESTENS so
  // frisch wie die Tabelle verspricht, nie weniger - ein eigener, langsamerer
  // Takt je Reiter wäre ein zweiter Lauf über dieselbe Antwort.
  useFreshnessPoll(() => void laden(), LIVE_POLL_MS, !loading);
  useEffect(() => {
    const t = window.setInterval(() => setTick(Date.now()), 5_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    if (!pulsiert) return;
    const t = window.setTimeout(() => setPulsiert(false), 650);
    return () => window.clearTimeout(t);
  }, [pulsiert]);

  const row = useMemo(() => edgeUpdates?.fleet.find((r) => r.externalRef === boxRef) ?? null, [edgeUpdates, boxRef]);
  const deviceRow = useMemo(() => devices?.find((d) => d.externalRef === boxRef) ?? null, [devices, boxRef]);
  const pendingRow = useMemo(() => pending?.find((p) => p.externalRef === boxRef) ?? null, [pending, boxRef]);
  const ersterLeerLauf = row == null;
  // B1-B4: „Verbunden, aber nie gemeldet" - verbunden (ein Kopf existiert), aber weder Herzschlag
  // noch Messwert je gesehen. Dieselbe Bedingung entscheidet die Karte (N8-sicher) UND das Menü.
  const nieGemeldet = akte?.kopf != null && akte.kopf.herzschlagAm == null && akte.kopf.messwertAm == null;
  const ausgebaut = akte?.lebensabschnitt === 'ausgebaut';

  useEffect(() => {
    if (!ausgebaut) {
      setEndgueltigBefund(null);
      return;
    }
    let aktiv = true;
    adminApi.geraeteEndgueltigBefund(boxRef)
      .then((b) => { if (aktiv) setEndgueltigBefund(b); })
      .catch(() => { /* ohne Befund keine Behauptung - Karte und Dialog sagen es dann selbst */ });
    return () => { aktiv = false; };
  }, [ausgebaut, boxRef]);

  useEffect(() => {
    if (!row) return;
    let aktiv = true;
    adminApi.boxVerlauf(row.deviceId).then((v) => { if (aktiv) setVerlauf(v); }).catch(() => { /* ohne Verlauf keine Behauptung */ });
    return () => { aktiv = false; };
  }, [row?.deviceId]);

  async function act(fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await laden();
      return true;
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Die Aktion ist fehlgeschlagen.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const werkstattZeile: UebersichtZeile | null = useMemo(() => {
    if (!werkstattBoxen) return null;
    const z = uebersicht(werkstattBoxen, werkstattDienst?.laeufe ?? []).find((z) => z.box === boxRef);
    return z ?? null;
  }, [werkstattBoxen, werkstattDienst, boxRef]);

  const nav = (r: GeraeteAkteReiter | null) => onNavigate?.({ page: 'geraete-registry', siteId: null, sub: null, geraeteAkte: { ref: boxRef, reiter: r } });

  if (loading) {
    return (
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <TableSkeleton rows={6} cols={1} />
      </Card>
    );
  }
  if (loadError) return <ErrorState message={loadError} onRetry={() => void laden()} />;

  return (
    <div className="vp-admin-page vp-geraete-akte" data-testid="geraete-akte">
      <AktenKopf boxRef={boxRef} row={row} deviceRow={deviceRow} pendingRow={pendingRow} jetzt={jetzt}
        reiter={reiter} onReiter={nav} onNavigate={onNavigate} pulsiert={pulsiert} nieGemeldet={nieGemeldet}
        onLoesenOeffnen={() => setLoesenOffen(true)}
        ausgebautAm={ausgebaut ? (akte?.kopf?.ausgebautAm ?? akte?.lebensabschnittSeit ?? null) : null}
        onEndgueltigOeffnen={() => setEndgueltigOffen(true)}
        stand={pollFehler ? freshnessLabel(fetchedAt, tick, true) : `${freshnessLabel(fetchedAt, tick)} · alle 10 s`} />
      {actionError && <div className="vp-alert vp-alert-warn" role="alert">{actionError}</div>}
      <BoxLoesenDialog open={loesenOffen} boxRef={boxRef} jetzt={jetzt} onClose={() => setLoesenOffen(false)}
        onGeloescht={() => { setLoesenOffen(false); onNavigate?.(pageRoute('geraete-registry')); }}
        onAusgebaut={() => { setLoesenOffen(false); void laden(); }} />
      <BoxEndgueltigLoeschenDialog open={endgueltigOffen} boxRef={boxRef} befund={endgueltigBefund}
        onClose={() => setEndgueltigOffen(false)}
        onGeloescht={() => { setEndgueltigOffen(false); onNavigate?.(pageRoute('geraete-registry')); }} />

      {reiter === 'software' ? (
        <SoftwareReiter row={row} ersterLeerLauf={ersterLeerLauf} verlauf={verlauf} jetzt={jetzt} busy={busy}
          releases={edgeUpdates?.releases ?? []} onAssign={(seq) => act(() => adminApi.setUpdateTarget(row!.deviceId, { releaseSeq: seq }))}
          onRevert={() => act(() => adminApi.revertUpdateTarget(row!.deviceId))} />
      ) : reiter === 'verbindung' ? (
        <VerbindungReiter boxRef={boxRef} row={row} jetzt={jetzt} akte={akte} />
      ) : reiter === 'anlage' ? (
        <AnlageReiter boxRef={boxRef} row={row} tenants={tenants} jetzt={jetzt} onNavigate={onNavigate}
          onJumpToTenant={onJumpToTenant} werkzeug={werkzeug}
          onWerkzeug={(w) => onNavigate?.(geraeteAkteRoute(boxRef, 'anlage', w))} />
      ) : reiter === 'einrichtung' ? (
        <EinrichtungReiter boxRef={boxRef} deviceRow={deviceRow} pendingRow={pendingRow} werkstattZeile={werkstattZeile}
          werkstattBoxen={werkstattBoxen ?? []} werkstattFreigaben={werkstattFreigaben ?? []} jetzt={jetzt}
          onNavigate={onNavigate} onGeloescht={() => onNavigate?.(pageRoute('geraete-registry'))} />
      ) : reiter === 'verlauf' ? (
        <VerlaufReiter verlauf={verlauf} jetzt={jetzt} fwProtokoll={fwProtokoll ?? []} />
      ) : (
        <UeberblickReiter row={row} ersterLeerLauf={ersterLeerLauf} jetzt={jetzt} onReiter={nav} akte={akte}
          onJumpToTenant={onJumpToTenant} nieGemeldet={nieGemeldet} onLoesenOeffnen={() => setLoesenOffen(true)}
          ausgebaut={ausgebaut} endgueltigBefund={endgueltigBefund}
          onEndgueltigOeffnen={() => setEndgueltigOffen(true)} />
      )}
    </div>
  );
}

// ── Kopf ──────────────────────────────────────────────────────────────────

const REITER: { id: GeraeteAkteReiter | null; label: string }[] = [
  { id: null, label: 'Überblick' },
  { id: 'software', label: 'Software' },
  { id: 'verbindung', label: 'Verbindung' },
  { id: 'anlage', label: 'Anlage' },
  { id: 'einrichtung', label: 'Einrichtung' },
  { id: 'verlauf', label: 'Verlauf' },
];

/**
 * Die fünf Zustände aus Konzept §5.3, EIN Ort für ihren Wortlaut und ihre
 * Farbe (`Badge`-Varianten; der Punkt übernimmt dieselbe Farbe über
 * `currentColor`). „Verzögert" (E6) und „Meldet sich nicht" sind zwei
 * verschiedene Ernste - zwei verschiedene Töne, nie derselbe wie ein Fehler.
 */
function zustandBadgeAusVerbindung(v: BoxVerbindungSicht): { variant: 'ok' | 'warn' | 'offline' | 'off'; text: string } {
  switch (v.zustand) {
    case 'online': return { variant: 'ok', text: `Verbunden${v.gesehen ? ` · ${v.gesehen}` : ''}` };
    case 'verzoegert': return { variant: 'warn', text: `Verzögert${v.gesehen ? ` · ${v.gesehen}` : ''}` };
    case 'offline': return { variant: 'offline', text: `Meldet sich nicht${v.gesehen ? ` · ${v.gesehen}` : ''}` };
    case 'nie': return { variant: 'off', text: 'Wartet auf erste Meldung' };
    default: return { variant: 'off', text: 'Stand unbekannt' };
  }
}

function AktenKopf({
  boxRef, row, deviceRow, pendingRow, jetzt, reiter, onReiter, onNavigate, pulsiert, stand, nieGemeldet,
  onLoesenOeffnen, ausgebautAm, onEndgueltigOeffnen,
}: {
  boxRef: string;
  row: FleetRow | null;
  deviceRow: AdminDeviceRow | null;
  pendingRow: PendingEnrollment | null;
  jetzt: Date;
  reiter: GeraeteAkteReiter | null;
  onReiter: (r: GeraeteAkteReiter | null) => void;
  onNavigate?: (target: Route) => void;
  /** §5.4: der Punkt schlägt einmal, wenn eine Antwort einen neueren Herzschlag trägt. */
  pulsiert: boolean;
  /** §5.2: „Stand vor 3 s · alle 10 s", bei gescheiterter Abfrage „Aktualisierung schlägt fehl · Stand 14:02". */
  stand: string;
  /** B1-B4: verbunden, aber weder Herzschlag noch Messwert je gesehen (N8: dann keine Fernwartung/Update). */
  nieGemeldet: boolean;
  onLoesenOeffnen: () => void;
  /** Ausgebaut (vierter Löschweg): der Kopf sagt es, das Menü bietet „Endgültig löschen …" an. */
  ausgebautAm: string | null;
  onEndgueltigOeffnen: () => void;
}) {
  const [menuOffen, setMenuOffen] = useState(false);
  const reiterRand = useReiterRand<HTMLDivElement>();
  const verbindung = row ? verbindungSicht(row, jetzt) : null;
  const name = row?.siteName?.trim() || deviceRow?.label || boxRef;
  const zustandBadge = ausgebautAm != null
    ? { variant: 'off' as const, text: `Ausgebaut · ${fmtRelative(ausgebautAm, jetzt)}` }
    : verbindung
      ? zustandBadgeAusVerbindung(verbindung)
      : pendingRow
        ? { variant: 'off' as const, text: 'Meldet sich, wartet auf Zuordnung' }
        : { variant: 'off' as const, text: 'Noch nicht verbunden' };

  return (
    <>
      <AdminPageHead
        icon="cpu"
        category="primary"
        title={name}
        description={
          <span className="vp-row-gap vp-akte-kennung" style={{ alignItems: 'center' }}>
            <BoxArtChip boxArt={row?.boxArt ?? null} />
            <span className="vp-mono">{boxRef}</span>
            {row && (
              <span>
                {row.tenantName} › {row.siteName}
              </span>
            )}
          </span>
        }
        actions={
          // Am Telefon: Zustand und Stand in EINER Zeile, darunter die Knöpfe in einer Reihe
          // (vorher verteilten sich Stand, Zustand und drei Knöpfe auf drei unordentliche Zeilen).
          <div className="vp-row-gap vp-akte-aktionen" style={{ alignItems: 'center' }}>
            <span className="vp-akte-status">
              <span className="vp-muted vp-text-sm" data-testid="akte-stand">{stand}</span>
              <Badge variant={zustandBadge.variant} dot pulse={pulsiert} data-testid="akte-zustand">
                {zustandBadge.text}
              </Badge>
            </span>
            {/* N8: eine Box, die sich nie gemeldet hat, hat weder einen Tunnel noch einen Software-
                Stand zu öffnen - die Knöpfe boten vorher zwei Reiter an, deren Inhalt nie entstehen
                kann, und am Telefon klebte „Fernwartung öffnen" zusätzlich am Rand. */}
            {row && !nieGemeldet && (
              <Button variant="outline" size="sm" onClick={() => onReiter('verbindung')}>Fernwartung öffnen</Button>
            )}
            {row && !nieGemeldet && !(row.stand === 'hand' || row.stufe1) && (
              <Button variant="outline" size="sm" onClick={() => onReiter('software')}>Aktualisieren</Button>
            )}
            <div className="vp-akte-menu" style={{ position: 'relative' }}>
              <Button variant="ghost" size="sm" aria-label="Weitere Handlungen" onClick={() => setMenuOffen((v) => !v)}>⋯</Button>
              {menuOffen && (
                <div className="vp-akte-menu-liste" role="menu" style={{ position: 'absolute', right: 0, top: '100%', zIndex: 5 }}>
                  <button type="button" role="menuitem" onClick={() => { void navigator.clipboard?.writeText(boxRef); setMenuOffen(false); }}>
                    Kennung kopieren
                  </button>
                  {row && onNavigate && (
                    <button type="button" role="menuitem" onClick={() => { setMenuOffen(false); onNavigate(pageRoute('geraete-registry')); }}>
                      Zur Geräte-Liste
                    </button>
                  )}
                  {/* vp-admin-box-ausbauen: EIN Einstieg für beide Ergebnisse - hat die Box schon Daten
                      (kein nieGemeldet), bietet der Dialog selbst "Box ausbauen" statt "Lösen" an. */}
                  {row && ausgebautAm == null && (
                    <button type="button" role="menuitem" onClick={() => { setMenuOffen(false); onLoesenOeffnen(); }}>
                      Vom Kunden lösen …
                    </button>
                  )}
                  {ausgebautAm != null && (
                    <button type="button" role="menuitem"
                      onClick={() => { setMenuOffen(false); onEndgueltigOeffnen(); }}>
                      Endgültig löschen …
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        }
      />
      <div ref={reiterRand} className="vp-seg vp-bereich-tabs" role="tablist" aria-label="Geräteakte" data-testid="akte-reiter">
        {REITER.map((t) => (
          <button key={t.id ?? 'ueberblick'} type="button" role="tab" aria-selected={reiter === t.id}
            className={reiter === t.id ? 'active' : ''} onClick={() => onReiter(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
    </>
  );
}

// ── Überblick ───────────────────────────────────────────────────────────────

function UeberblickReiter({ row, ersterLeerLauf, jetzt, onReiter, akte, onJumpToTenant, nieGemeldet,
  onLoesenOeffnen, ausgebaut, endgueltigBefund, onEndgueltigOeffnen }: {
  row: FleetRow | null;
  ersterLeerLauf: boolean;
  jetzt: Date;
  onReiter: (r: GeraeteAkteReiter) => void;
  /** §5.3-Sonderfall L2: Herzschlag und Messwert getrennt, aus der Akte-in-einer-Antwort (L3). */
  akte: AdminGeraeteAkte | null;
  /** „Wie der Kunde es sieht": öffnet die Anlage dieser Box in der Kundensicht (Live-Werte). */
  onJumpToTenant?: (tenantId: string, target: Route) => void;
  nieGemeldet: boolean;
  onLoesenOeffnen: () => void;
  /** Der vierte Löschweg (vp-box-endgueltig-loeschen): die Karte „Ausgebaut" spricht den Befund. */
  ausgebaut: boolean;
  endgueltigBefund: BoxEndgueltigBefund | null;
  onEndgueltigOeffnen: () => void;
}) {
  if (ausgebaut) {
    return (
      <AusgebautKarte akte={akte} befund={endgueltigBefund} jetzt={jetzt}
        onEndgueltigOeffnen={onEndgueltigOeffnen} />
    );
  }
  if (ersterLeerLauf) {
    return (
      <Card padding="lg" radius="lg">
        <p className="vp-muted" style={{ marginTop: 0 }}>
          Noch bei keinem Kunden. Verbunden wird die Box beim Kunden: in seiner Anlage unter Aufbau mit
          „VoltPilot-Box hinzufügen“ und der Kennung von ihrem Aufkleber.
        </p>
        <Button variant="outline" size="sm" onClick={() => onReiter('einrichtung')}>Zur Einrichtung</Button>
      </Card>
    );
  }
  const verbindung = verbindungSicht(row!, jetzt);
  const brauchtDich = row!.state === 'fehlgeschlagen' || row!.state === 'zurueckgerollt' || row!.state === 'blockiert'
    || (verbindung.zustand === 'offline' && row!.rolloutId != null);
  // L2-Sonderfall (§5.3): der Herzschlag ist in Ordnung, aber die Messwerte
  // stehen - das bleibt eine Aussage über die DATENANNAHME, nicht über die
  // Box, also kippt der Kopf dafür nicht auf „Meldet sich nicht".
  const luecke = verbindung.zustand === 'online' ? messwerteLuecke(akte?.kopf?.messwertAm, jetzt) : null;

  return (
    <div className="vp-geraet-grid">
      {nieGemeldet && (
        <Card padding="lg" radius="lg" className="vp-geraet-sek" data-testid="akte-nie-gemeldet">
          <h2><Icon name="plug" size={18} /> Verbunden, aber nie gemeldet</h2>
          <p className="vp-muted" style={{ marginTop: 0 }}>
            {row!.tenantName} › {row!.siteName} · Verbunden {fmtRelative(akte?.lebensabschnittSeit ?? null, jetzt)}
            {' '}· Herzschlag nie · Messwerte keine.
          </p>
          <Button variant="outline" size="sm" onClick={onLoesenOeffnen}>Vom Kunden lösen …</Button>
        </Card>
      )}
      {brauchtDich && (
        <Card padding="lg" radius="lg" className="vp-geraet-sek">
          <h2><Icon name="alert-triangle" size={18} /> Braucht dich</h2>
          <p>{row!.reason ?? 'Diese Box braucht Aufmerksamkeit - Einzelheiten im Reiter „Software".'}</p>
          <Button variant="outline" size="sm" onClick={() => onReiter('software')}>Zur Software</Button>
        </Card>
      )}
      <Card padding="lg" radius="lg" className="vp-geraet-sek">
        <h2><Icon name="activity" size={18} /> Jetzt</h2>
        {luecke ? (
          <p className="vp-alert vp-alert-warn" data-testid="akte-messwert-luecke">
            Messwerte {luecke.seit} aus - die Datenannahme braucht einen Blick, nicht die Box.
          </p>
        ) : (
          // Der frühere Satz verwies auf „Wie der Kunde es sieht im Menü ⋯ des Kopfes" - dieses Menü
          // trägt den Eintrag nicht. Jetzt führt der Knopf darunter selbst dorthin.
          <p className="vp-muted">Live-Werte (PV, Netz, Speicher, Haus) zeigt die Kundensicht dieser Anlage.</p>
        )}
        {onJumpToTenant && (
          <Button variant="outline" size="sm" iconLeft={<Icon name="eye" size={16} />}
            onClick={() => onJumpToTenant(row!.tenantId, anlageRoute(row!.siteId))}>
            Wie der Kunde es sieht
          </Button>
        )}
      </Card>
      <Card padding="lg" radius="lg" className="vp-geraet-sek">
        <h2>Reiter dieser Box</h2>
        <dl className="vp-kv-list">
          <div className="vp-kv-row">
            <dt>Software</dt>
            <dd><button type="button" className="vp-linklike" onClick={() => onReiter('software')}>{row!.ist ?? 'nichts gemeldet'}</button></dd>
          </div>
          <div className="vp-kv-row">
            <dt>Verbindung</dt>
            <dd><button type="button" className="vp-linklike" onClick={() => onReiter('verbindung')}>{verbindung.text}{verbindung.gesehen ? ` · ${verbindung.gesehen}` : ''}</button></dd>
          </div>
          <div className="vp-kv-row">
            <dt>Anlage</dt>
            <dd><button type="button" className="vp-linklike" onClick={() => onReiter('anlage')}>Plan, Steuerung, Fassung ansehen</button></dd>
          </div>
          <div className="vp-kv-row">
            <dt>Einrichtung</dt>
            <dd><button type="button" className="vp-linklike" onClick={() => onReiter('einrichtung')}>ansehen</button></dd>
          </div>
          <div className="vp-kv-row">
            <dt>Verlauf</dt>
            <dd><button type="button" className="vp-linklike" onClick={() => onReiter('verlauf')}>ansehen</button></dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}

// ── Vom Kunden lösen (L1/L2): der Dialog wohnt in `BoxLoesenDialog.tsx` - die Kundenakte
// (Karte „Anlagen und Boxen") teilt ihn seit dem Befund vp-kundenakte-fremde-personen (Punkt 7).

/**
 * Die Karte „Ausgebaut" (vierter Löschweg, vp-box-endgueltig-loeschen): sie spricht den SERVER-Befund.
 * Nie Daten geliefert → der Gefahren-Knopf „Endgültig löschen …" (Dialog mit Kennung-Abschrift);
 * hat die Box Daten → die ruhige Erklärung, warum sie als Historie bleibt - nie ein toter Knopf.
 */
function AusgebautKarte({ akte, befund, jetzt, onEndgueltigOeffnen }: {
  akte: AdminGeraeteAkte | null;
  befund: BoxEndgueltigBefund | null;
  jetzt: Date;
  onEndgueltigOeffnen: () => void;
}) {
  const kopf = akte?.kopf ?? null;
  const zeile = befund
    ? ausgebautZeile(befund, jetzt)
    : kopf
      ? `${kopf.tenantName} › ${kopf.siteName} · Ausgebaut ${fmtRelative(kopf.ausgebautAm, jetzt)}`
      : `Ausgebaut ${fmtRelative(akte?.lebensabschnittSeit ?? null, jetzt)}`;
  return (
    <div className="vp-geraet-grid">
      <Card padding="lg" radius="lg" className="vp-geraet-sek" data-testid="akte-ausgebaut">
        <h2><Icon name="archive" size={18} /> Ausgebaut</h2>
        <p className="vp-muted" style={{ marginTop: 0 }}>{zeile}</p>
        {befund == null ? (
          <p className="vp-muted" data-testid="akte-ausgebaut-laedt">Der Datenbestand wird geprüft …</p>
        ) : befund.loeschbar ? (
          <>
            <p data-testid="akte-ausgebaut-loeschbar">{NIE_DATEN_SATZ}</p>
            <Button variant="outline" size="sm" className="vp-btn-danger"
              onClick={onEndgueltigOeffnen}>
              Endgültig löschen …
            </Button>
          </>
        ) : (
          // Nie ein toter Knopf: eine Box mit Daten bekommt die Erklärung statt eines gesperrten Wegs.
          <p data-testid="akte-ausgebaut-bleibt">
            {bleibtSatz(befund.daten)} Sie verschwindet erst mit ihrer Anlage.
          </p>
        )}
      </Card>
      <Card padding="lg" radius="lg" className="vp-geraet-sek">
        <h2><Icon name="history" size={18} /> Verlauf bleibt lesbar</h2>
        <p className="vp-muted" style={{ marginTop: 0 }}>
          Werkstatt-, Fernwartungs- und Software-Protokolle dieser Kennung zeigt der Reiter „Verlauf“ weiter.
        </p>
      </Card>
    </div>
  );
}

// ── Software ──────────────────────────────────────────────────────────────

function SoftwareReiter({ row, ersterLeerLauf, verlauf, jetzt, busy, releases, onAssign, onRevert }: {
  row: FleetRow | null;
  ersterLeerLauf: boolean;
  verlauf: BoxVerlauf | null;
  jetzt: Date;
  busy: boolean;
  releases: EdgeUpdatesRelease[];
  onAssign: (releaseSeq: number) => Promise<boolean>;
  onRevert: () => Promise<boolean>;
}) {
  if (ersterLeerLauf || !row) {
    return <EmptyState icon="refresh-cw" category="primary" title="Noch nicht verbunden"
      description="Software-Fakten gibt es erst, sobald ein Kundenkonto diese Box verbunden hat." />;
  }
  const linie = linieDerBox(row);
  const stufe1 = row.stand === 'hand' || row.stufe1 === true;
  const hinweis = stufe1 ? stufe1Hinweis(row) : null;
  const vertrauen = crossoverState(row.trust, row.boxArt, row.loader);
  const fakten = boxFakten(row, verlauf?.eintraege ?? null, jetzt);
  const passend = releases.filter((r) => r.signed && (linie == null || releaseBoxArt(r) === linie) && r.releaseSeq !== row.sollSeq)
    .sort((a, b) => b.releaseSeq - a.releaseSeq);
  const [seq, setSeq] = useState<number | null>(passend[0]?.releaseSeq ?? null);

  return (
    <div className="vp-geraet-grid">
      <Card padding="lg" radius="lg" className="vp-geraet-sek">
        <h2><Icon name="refresh-cw" size={18} /> Linie und Stand</h2>
        <p><Badge variant="tint">{linie ? BOX_ART_LABELS[linie] : BOX_ART_UNBEKANNT}</Badge></p>
        <dl className="vp-kv-list">
          {fakten.map((f) => (
            <div className="vp-kv-row" key={f.wer}>
              <dt>{f.wer}</dt>
              <dd><span className="vp-mono">{f.wert}</span>{f.satz && <span className="vp-cell-sub">{f.satz}</span>}</dd>
            </div>
          ))}
        </dl>
      </Card>

      {hinweis ? (
        <Card padding="lg" radius="lg" className="vp-geraet-sek">
          <h2><Icon name="hand" size={18} /> Nimmt keine Updates aus dem Portal an (Stufe 1)</h2>
          <p>{hinweis.grund}</p>
          <p className="vp-muted vp-text-sm">{hinweis.fertig}</p>
        </Card>
      ) : (
        <Card padding="lg" radius="lg" className="vp-geraet-sek">
          <h2>Aktualisieren</h2>
          {passend.length === 0 ? (
            <p className="vp-muted">Kein passendes, signiertes Release für diese Linie im Register.</p>
          ) : (
            <>
              <VpPicker label="Release" options={passend.map((r) => ({ value: String(r.releaseSeq), label: r.version }))}
                value={seq == null ? '' : String(seq)} onChange={(v) => setSeq(Number(v))} />
              <p className="vp-muted vp-text-sm">Das Gerät lädt und tauscht danach von selbst. Kein weiterer Schritt nötig.</p>
              <Button variant="primary" disabled={busy || seq == null} onClick={() => seq != null && void onAssign(seq)}>
                Aktualisieren
              </Button>
            </>
          )}
          {row.sollSeq != null && (
            <Button variant="outline" disabled={busy} onClick={() => void onRevert()} style={{ marginTop: 8 }}>
              Zuweisung zurücknehmen
            </Button>
          )}
        </Card>
      )}

      <AufklapperKarte icon="shield" titel="Vertrauen" urteil={vertrauen.label} className="vp-geraet-sek">
        <p><Badge variant={vertrauen.tone === 'ok' ? 'ok' : vertrauen.tone === 'warn' ? 'warn' : 'off'} dot>{vertrauen.label}</Badge></p>
        {vertrauen.detail && <p className="vp-muted vp-text-sm">{vertrauen.detail}</p>}
      </AufklapperKarte>

      <AufklapperKarte icon="history" titel="Update-Verlauf" className="vp-geraet-sek"
        urteil={verlauf == null ? 'wird geladen' : verlauf.eintraege.length === 0 ? 'nichts verzeichnet' : `${verlauf.eintraege.length} Einträge`}>
        {verlauf == null ? (
          <p className="vp-muted vp-text-sm">Der Verlauf wird geladen …</p>
        ) : verlauf.eintraege.length === 0 ? (
          <p className="vp-muted vp-text-sm">Für diese Box ist noch nichts verzeichnet.</p>
        ) : (
          <Zeitleiste zeilen={verlaufSicht(verlauf.eintraege, jetzt)} testId="akte-software-verlauf" />
        )}
      </AufklapperKarte>
    </div>
  );
}

// ── Verbindung ────────────────────────────────────────────────────────────

function VerbindungReiter({ boxRef, row, jetzt, akte }: {
  boxRef: string;
  row: FleetRow | null;
  jetzt: Date;
  /** Lücke L4 (S6): das Zertifikats-Ablaufdatum - aus der Akte-in-einer-Antwort (L3), vom Wirt geladen. */
  akte: AdminGeraeteAkte | null;
}) {
  const verbindung = row ? verbindungSicht(row, jetzt) : null;
  const zertifikat = akte?.einrichtung ? {
    ausgestelltAm: akte.einrichtung.zertifikatAusgestelltAm,
    gueltigBis: akte.einrichtung.zertifikatGueltigBis,
  } : null;
  return (
    <div className="vp-geraet-grid">
      <Card padding="lg" radius="lg" className="vp-geraet-sek">
        <h2><Icon name="link" size={18} /> Herzschlag zur Cloud</h2>
        {verbindung ? (
          <p>
            <Badge variant={zustandBadgeAusVerbindung(verbindung).variant} dot>{verbindung.text}</Badge>
            {verbindung.gesehen && <span className="vp-cell-sub"> {verbindung.gesehen}</span>}
          </p>
        ) : <p className="vp-muted">Diese Box hat sich der Cloud noch nie gemeldet.</p>}
        {zertifikat?.gueltigBis && (
          <dl className="vp-kv" data-testid="akte-zertifikat">
            <dt>Zertifikat gültig bis</dt>
            <dd>{new Date(zertifikat.gueltigBis).toLocaleDateString('de-DE')}</dd>
          </dl>
        )}
      </Card>
      <Card padding="lg" radius="lg" className="vp-geraet-sek vp-geraet-breit" data-testid="akte-wartung">
        <FernwartungKarte edgeRef={boxRef} />
      </Card>
    </div>
  );
}

// ── Anlage (§4.4, Scheibe S3) ────────────────────────────────────────────

/**
 * Reiter „Anlage": Plan, Steuerung & Abregelung mit Beleg, Scharfschalten/
 * Zurücknehmen, Pflege-Hinweise, Komponenten-Fassung Soll/Ist, Werkzeuge
 * (Plan erklären/Optimizer, Flows, Prognose, Gemeinsame Steuerung) - alles aus
 * vorhandenen Antworten (`/admin/fleet`, `/admin/control-candidates`,
 * `/admin/component-fleet`), keine neue Schnittstelle.
 *
 * E2 = A: steht diese Box NICHT an der Spitze ihrer Anlage (`fuehrtAnlage ===
 * false`), zeigt der Reiter nur einen Satz und den Weg zur führenden Box -
 * der Fakt bleibt an EINEM Ort.
 */
function AnlageReiter({
  boxRef, row, tenants, jetzt, werkzeug, onWerkzeug, onNavigate, onJumpToTenant,
}: {
  boxRef: string;
  row: FleetRow | null;
  tenants: Tenant[];
  jetzt: Date;
  werkzeug: AnlageWerkzeug | null;
  onWerkzeug: (w: AnlageWerkzeug | null) => void;
  onNavigate?: (target: Route) => void;
  onJumpToTenant?: (tenantId: string, target: Route) => void;
}) {
  const [site, setSite] = useState<AdminFleetSite | null>(null);
  const [candidate, setCandidate] = useState<ControlCandidate | null>(null);
  const [komponenten, setKomponenten] = useState<FlottenAnlage | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [arming, setArming] = useState(false);
  const [disarming, setDisarming] = useState(false);

  useEffect(() => {
    if (!row) return;
    let active = true;
    setLoadError(false);
    Promise.all([fleetApi.fleet(), adminApi.controlCandidates(), adminApi.componentFleet()]).then(
      ([fleet, candidates, komponentenFlotte]) => {
        if (!active) return;
        setSite(fleet.sites.find((s) => s.siteId === row.siteId) ?? null);
        setCandidate((candidates ?? []).find((c) => c.deviceId === row.deviceId) ?? null);
        setKomponenten((komponentenFlotte ?? []).find((k) => k.siteId === row.siteId) ?? null);
      },
      () => { if (active) setLoadError(true); },
    );
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.siteId, row?.deviceId, reloadKey]);

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      setReloadKey((k) => k + 1);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Die Aktion ist fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  if (!row) {
    return (
      <Card padding="lg" radius="lg">
        <p className="vp-muted" style={{ marginTop: 0 }}>
          Diese Box ist noch nicht mit einem Kundenkonto verbunden - eine Anlage gibt es erst danach.
        </p>
      </Card>
    );
  }

  // Werkzeuge öffnen mit vorgewählter Anlage - die Auswahl Mandant → Anlage entfällt (E2 = A).
  if (werkzeug === 'plan') {
    return (
      <OptimizerPage tenants={tenants} onBack={() => onWerkzeug(null)}
        preselect={{ tenantId: row.tenantId, siteId: row.siteId, siteName: row.siteName }} />
    );
  }
  if (werkzeug === 'flows') {
    return (
      <FlowsPage tenants={tenants} onBack={() => onWerkzeug(null)}
        preselect={{ tenantId: row.tenantId, siteId: row.siteId, siteName: row.siteName }} />
    );
  }

  // E2 = A: eine weitere Box derselben Anlage zeigt nur einen Satz und den Weg zur führenden Box.
  const dieseBox = site?.boxes?.find((b) => b.externalRef === boxRef) ?? null;
  const fuehrendeBox = site?.boxes?.find((b) => b.fuehrtAnlage === true) ?? null;
  if (dieseBox?.fuehrtAnlage === false && fuehrendeBox) {
    return (
      <Card padding="lg" radius="lg">
        <p style={{ marginTop: 0 }}>
          Die Anlage führt Box{' '}
          <button type="button" className="vp-linklike"
            onClick={() => onNavigate?.(geraeteAkteRoute(fuehrendeBox.externalRef, 'anlage'))}>
            {fuehrendeBox.name ?? fuehrendeBox.externalRef} ›
          </button>
        </p>
      </Card>
    );
  }

  if (loadError) {
    return <ErrorState message="Die Anlage ließ sich nicht laden." onRetry={() => setReloadKey((k) => k + 1)} />;
  }
  if (!site) {
    return <TableSkeleton rows={4} cols={1} />;
  }

  const plan = planCell(site.lastPlanGeneratedAt, jetzt, site.hasStorage);
  const matrix = controlMatrixRow(
    { siteId: site.siteId, siteName: site.siteName, tenantId: site.tenantId, tenantName: site.tenantName, control: site.control, curtailment: site.curtailment },
    jetzt,
  );
  const certView = candidate ? plantCertView(candidate.activated, candidate.platformCertVerdict) : null;
  const ort = komponenten ? pflegeOrt(komponenten.componentAuthority) : null;
  const soll = komponenten ? sollIst(komponenten.syncStatus) : null;

  return (
    <div className="vp-geraet-grid">
      {actionError && <div className="vp-alert vp-alert-warn" role="alert">{actionError}</div>}

      <AufklapperKarte icon="calendar" titel="Plan" urteil={plan.text} className="vp-geraet-sek">
        <p><Badge variant={plan.tone} dot>{plan.text}</Badge></p>
        <p className="vp-muted vp-text-sm">
          {site.hasStorage ? 'Letzter Lauf des Optimierers für diese Anlage.' : 'Der Optimierer plant nur Anlagen mit Speicher.'}
        </p>
      </AufklapperKarte>

      <Card padding="lg" radius="lg" className="vp-geraet-sek">
        <h2><Icon name="sliders" size={18} /> Steuerung und Abregelung</h2>
        <dl className="vp-kv-list">
          <div className="vp-kv-row">
            <dt>Batterie-Steuerung</dt>
            <dd>
              <Badge variant={matrix.battery.tone} dot>{matrix.battery.text}</Badge>
              {matrix.battery.detail && <span className="vp-cell-sub">{matrix.battery.detail}</span>}
            </dd>
          </div>
          <div className="vp-kv-row">
            <dt>Abregelung</dt>
            <dd>
              <Badge variant={matrix.curtail.tone} dot>{matrix.curtail.text}</Badge>
              {matrix.curtail.detail && <span className="vp-cell-sub">{matrix.curtail.detail}</span>}
            </dd>
          </div>
          <div className="vp-kv-row"><dt>Ausführung jetzt</dt><dd>{matrix.executionText}</dd></div>
          <div className="vp-kv-row">
            <dt>Beleg</dt>
            <dd>{matrix.belegText}{matrix.belegStale && <span className="vp-cell-sub"> · zu alt für eine Aussage</span>}</dd>
          </div>
        </dl>
      </Card>

      <Card padding="lg" radius="lg" className="vp-geraet-sek">
        <h2><Icon name="shield" size={18} /> Scharfschalten</h2>
        {candidate && certView ? (
          <>
            <p><Badge variant={certView.tone} dot>{certView.label}</Badge></p>
            {certView.hint && <p className="vp-muted vp-text-sm">{certView.hint}</p>}
            {candidate.activated && candidate.activatedBy && (
              <p className="vp-muted vp-text-sm">aktiviert durch {candidate.activatedBy}</p>
            )}
            {certSourceLabel(candidate.certSource) && (
              <p className="vp-muted vp-text-sm">Freigabe: {certSourceLabel(candidate.certSource)}</p>
            )}
            {candidate.activated ? (
              <Button variant="ghost" disabled={busy} onClick={() => setDisarming(true)}>Zurücknehmen</Button>
            ) : (
              certView.canActivate && (
                <Button variant={certView.state === 'bereit' ? 'primary' : 'outline'} disabled={busy} onClick={() => setArming(true)}>
                  Steuerung aktivieren
                </Button>
              )
            )}
          </>
        ) : (
          <p className="vp-muted">Für dieses Gerät steht noch keine Steuerungs-Freigabe an.</p>
        )}
      </Card>

      {site.pflege.length > 0 && (
        <AufklapperKarte icon="alert-triangle" titel="Pflege-Hinweise" urteil={`${site.pflege.length} Hinweis${site.pflege.length === 1 ? '' : 'e'}`} className="vp-geraet-sek">
          <ul className="vp-komp-hinweise">
            {site.pflege.map((p) => (
              <li key={p.code}>
                <strong>{p.label}</strong>
                {p.detail && <div className="vp-muted vp-text-sm">{p.detail}</div>}
              </li>
            ))}
          </ul>
        </AufklapperKarte>
      )}

      <AufklapperKarte icon="cpu" titel="Komponenten-Fassung" urteil={soll?.label ?? 'Noch nichts gemeldet'} className="vp-geraet-sek">
        {komponenten && ort && soll ? (
          <dl className="vp-kv-list">
            <div className="vp-kv-row"><dt>Gepflegt</dt><dd><Badge variant={ort.ton} dot>{ort.label}</Badge></dd></div>
            <div className="vp-kv-row">
              <dt>Soll/Ist</dt>
              <dd>
                <Badge variant={soll.ton}>{soll.label}</Badge>
                {ablehnung(komponenten) && <div className="vp-cell-sub">{ablehnung(komponenten)}</div>}
              </dd>
            </div>
            <div className="vp-kv-row"><dt>Herkunft</dt><dd className="vp-muted">{quellenText(komponenten.sources)}</dd></div>
          </dl>
        ) : (
          <p className="vp-muted">Noch keine Komponenten gemeldet.</p>
        )}
      </AufklapperKarte>

      <AufklapperKarte icon="settings" titel="Werkzeuge" className="vp-geraet-sek vp-geraet-breit">
        <div className="vp-row-gap">
          <Button variant="outline" size="sm" onClick={() => onWerkzeug('plan')}>Plan erklären (Optimizer)</Button>
          <Button variant="outline" size="sm" onClick={() => onWerkzeug('flows')}>Flows</Button>
          {onJumpToTenant && (
            <>
              <Button variant="outline" size="sm" onClick={() => onJumpToTenant(site.tenantId, anlageRoute(site.siteId, 'prognose'))}>
                Prognose
              </Button>
              <Button variant="outline" size="sm" onClick={() => onJumpToTenant(site.tenantId, anlageRoute(site.siteId, 'technik'))}>
                Gemeinsame Steuerung
              </Button>
            </>
          )}
        </div>
      </AufklapperKarte>

      <ConfirmDialog
        open={arming}
        title="Steuerung für diese Anlage aktivieren?"
        intro={`VoltPilot darf danach den Wechselrichter von „${site.siteName}" ansteuern.`}
        consequences={activateConsequences(site.siteName)}
        confirmLabel="Steuerung aktivieren"
        busy={busy}
        onCancel={() => setArming(false)}
        onConfirm={() => {
          setArming(false);
          if (candidate) void run(() => adminApi.activateControl(candidate.deviceId));
        }}
      />

      <ConfirmDialog
        open={disarming}
        title="Steuerung dieser Anlage zurücknehmen?"
        intro={`„${site.siteName}" wird danach nur noch ausgelesen.`}
        consequences={deactivateConsequences(site.siteName)}
        confirmLabel="Zurücknehmen"
        tone="danger"
        busy={busy}
        onCancel={() => setDisarming(false)}
        onConfirm={() => {
          setDisarming(false);
          if (candidate) void run(() => adminApi.deactivateControl(candidate.deviceId));
        }}
      />
    </div>
  );
}

// ── Einrichtung ───────────────────────────────────────────────────────────

function EinrichtungReiter({ boxRef, deviceRow, pendingRow, werkstattZeile, werkstattBoxen, werkstattFreigaben, jetzt, onNavigate, onGeloescht }: {
  boxRef: string;
  deviceRow: AdminDeviceRow | null;
  pendingRow: PendingEnrollment | null;
  werkstattZeile: UebersichtZeile | null;
  werkstattBoxen: WerkstattBox[];
  werkstattFreigaben: WerkstattFreigabe[];
  jetzt: Date;
  onNavigate?: (target: Route) => void;
  onGeloescht: (ref: string) => void;
}) {
  if (werkstattZeile) {
    return (
      <WerkstattBoxSeite
        zeile={werkstattZeile}
        boxen={werkstattBoxen}
        freigaben={werkstattFreigaben}
        jetzt={jetzt}
        onZurueck={() => onNavigate?.(werkstattHashRoute())}
        onGeloescht={onGeloescht}
      />
    );
  }
  return (
    <div className="vp-geraet-grid">
      <Card padding="lg" radius="lg" className="vp-geraet-sek">
        <h2><Icon name="cpu" size={18} /> Aufkleber-ID und Registrierung</h2>
        {deviceRow ? (
          <dl className="vp-kv-list">
            <div className="vp-kv-row"><dt>Registriert</dt><dd>{deviceRow.provisioned ? fmtRelative(deviceRow.provisionedAt, jetzt) : 'nicht über die Registry'}</dd></div>
            {deviceRow.note && <div className="vp-kv-row"><dt>Notiz</dt><dd>{deviceRow.note}</dd></div>}
            <div className="vp-kv-row">
              <dt>Kopplung</dt>
              <dd>{deviceRow.deviceId != null ? `${deviceRow.tenantName ?? '–'} · ${deviceRow.siteName ?? '–'}` : 'noch nicht verbunden'}</dd>
            </div>
          </dl>
        ) : (
          <p className="vp-muted">Für diese Referenz steht nichts in der Aufkleber-Registry.</p>
        )}
      </Card>
      {pendingRow && (() => {
        const p = pendingRows([pendingRow], jetzt)[0];
        return (
          <Card padding="lg" radius="lg" className="vp-geraet-sek">
            <h2><Icon name="wifi" size={18} /> Meldet sich, wartet auf Zuordnung</h2>
            {p && (
              <div className={`vp-gu-verb ${p.erreichbar.zustand}`} data-testid="akte-wartet-erreichbar">
                <b><i aria-hidden="true" />{pendingErreichbarText(p.erreichbar)}</b>
                <small>{p.erreichbar.lastSeenText}</small>
              </div>
            )}
            <p className="vp-muted">{PENDING_KONTEXT}.</p>
            <p>{p?.hint}</p>
            <p className="vp-muted vp-text-sm">Meldet sich seit {fmtRelative(pendingRow.csrUpdatedAt, jetzt)}{pendingRow.deviceInfo ? ` · ${pendingRow.deviceInfo}` : ''}.</p>
          </Card>
        );
      })()}
      {!deviceRow && !pendingRow && (
        <Card padding="lg" radius="lg" className="vp-geraet-sek">
          <p className="vp-muted" style={{ margin: 0 }}>Für „{boxRef}“ ist nichts in der Einrichtung verzeichnet.</p>
        </Card>
      )}
    </div>
  );
}

function werkstattHashRoute(): Route {
  return { page: 'werkstatt', siteId: null, sub: null };
}

// ── Verlauf ───────────────────────────────────────────────────────────────

function VerlaufReiter({ verlauf, jetzt, fwProtokoll }: { verlauf: BoxVerlauf | null; jetzt: Date; fwProtokoll: FernwartungProtokollEintrag[] }) {
  return (
    <div className="vp-geraet-grid">
      <Card padding="lg" radius="lg" className="vp-geraet-sek vp-geraet-breit">
        <h2><Icon name="refresh-cw" size={18} /> Software</h2>
        {verlauf == null ? (
          <p className="vp-muted">Der Verlauf wird geladen …</p>
        ) : verlauf.eintraege.length === 0 ? (
          <p className="vp-muted">Für diese Box ist noch nichts verzeichnet.</p>
        ) : (
          <Zeitleiste zeilen={verlaufSicht(verlauf.eintraege, jetzt)} testId="akte-verlauf-software" />
        )}
      </Card>
      <Card padding="lg" radius="lg" className="vp-geraet-sek vp-geraet-breit">
        <h2><Icon name="shield" size={18} /> Fernwartung</h2>
        <ProtokollListe eintraege={fwProtokoll} jetzt={jetzt} />
      </Card>
    </div>
  );
}
