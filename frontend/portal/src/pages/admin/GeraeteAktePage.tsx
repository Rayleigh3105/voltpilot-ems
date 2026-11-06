import { useEffect, useMemo, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { VpPicker } from '../../components/VpPicker';
import { ApiError } from '../../api';
import { adminApi, type AdminDeviceRow, type PendingEnrollment } from '../../admin/adminApi';
import { EmptyState, ErrorState, TableSkeleton } from '../../components/States';
import {
  BOX_ART_LABELS, BOX_ART_UNBEKANNT, crossoverState, releaseBoxArt,
  type BoxVerlauf, type EdgeUpdates, type EdgeUpdatesRelease, type FleetRow,
} from '../../adminEdgeUpdates';
import { boxFakten, linieDerBox, stufe1Hinweis, verbindungSicht, verlaufSicht } from '../../geraeteUpdates';
import { pendingRows } from '../../onboardingFunnel';
import { fmtRelative } from '../../format';
import { FernwartungKarte } from '../../components/FernwartungKarte';
import { ProtokollListe } from './FernwartungPage';
import { type FernwartungProtokollEintrag } from '../../adminFernwartung';
import { liesDienst, uebersicht, type UebersichtZeile, type WerkstattDienst, type WerkstattFreigabe } from '../../werkstattBank';
import type { WerkstattBox } from '../../werkstatt';
import { pageRoute, type GeraeteAkteReiter, type Route } from '../../nav';
import { BoxArtChip } from './BoxArtChip';
import { AdminPageHead } from './AdminPageHead';
import { Zeitleiste } from './Zeitleiste';
import { WerkstattBoxSeite } from './WerkstattBoxSeite';
import '../GeraetSeite.css';
import './BoxVersions.css';
import './Fernwartung.css';
import './GeraeteAkte.css';

/**
 * Die GERÄTEAKTE (Konzept `vp-adminview-konzept-k1` §4.4, Scheibe S2): EIN
 * Ort für alles, was zu einer Box gehört. Sie adressiert die Box-KENNUNG
 * (nicht die UUID, §4.2) und setzt sich aus vorhandenen Antworten zusammen -
 * keine neue Schnittstelle (`/admin/edge-updates`, `/admin/devices`,
 * `/admin/enrollments/pending`, `/admin/fernwartung*`, `/admin/werkstatt/*`).
 *
 * Der Reiter „Anlage" fehlt bewusst - er kommt erst mit S3 (Plan, Steuerung,
 * Fassung, Werkzeuge); diese Scheibe reserviert nur seinen Platz in der
 * Reiterleiste nicht, um keinen leeren Reiter zu zeigen.
 *
 * E1 = A: bearbeitet wird inline, auf dieser Seite - kein Fenster.
 * E4 = A: die Kundenseiten verlinken nur noch hierher.
 */
export function GeraeteAktePage({
  boxRef,
  reiter,
  onNavigate,
}: {
  boxRef: string;
  reiter: GeraeteAkteReiter | null;
  onNavigate?: (target: Route) => void;
}) {
  const [edgeUpdates, setEdgeUpdates] = useState<EdgeUpdates | null>(null);
  const [devices, setDevices] = useState<AdminDeviceRow[] | null>(null);
  const [pending, setPending] = useState<PendingEnrollment[] | null>(null);
  const [werkstattBoxen, setWerkstattBoxen] = useState<WerkstattBox[] | null>(null);
  const [werkstattDienst, setWerkstattDienst] = useState<WerkstattDienst | null>(null);
  const [werkstattFreigaben, setWerkstattFreigaben] = useState<WerkstattFreigabe[] | null>(null);
  const [verlauf, setVerlauf] = useState<BoxVerlauf | null>(null);
  const [fwProtokoll, setFwProtokoll] = useState<FernwartungProtokollEintrag[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [jetzt, setJetzt] = useState(() => new Date());

  async function laden() {
    const [eu, dv, pe, wb, wd, wf, fw] = await Promise.allSettled([
      adminApi.edgeUpdates(), adminApi.listDevices(), adminApi.listPendingEnrollments(),
      adminApi.werkstattBoxen(), adminApi.werkstattDienst(), adminApi.werkstattFreigaben(),
      adminApi.fernwartungProtokoll({ box: boxRef, limit: 100 }),
    ]);
    if (eu.status === 'fulfilled') setEdgeUpdates(eu.value);
    if (dv.status === 'fulfilled') setDevices(dv.value);
    if (pe.status === 'fulfilled') setPending(pe.value);
    if (wb.status === 'fulfilled') setWerkstattBoxen(wb.value);
    if (wd.status === 'fulfilled') setWerkstattDienst(liesDienst(wd.value));
    if (wf.status === 'fulfilled') setWerkstattFreigaben(wf.value);
    if (fw.status === 'fulfilled') setFwProtokoll(fw.value);
    setLoadError(eu.status === 'rejected' && dv.status === 'rejected' ? 'Diese Box ließ sich nicht laden.' : null);
    setJetzt(new Date());
    setLoading(false);
  }

  useEffect(() => {
    setLoading(true);
    void laden();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxRef]);

  const row = useMemo(() => edgeUpdates?.fleet.find((r) => r.externalRef === boxRef) ?? null, [edgeUpdates, boxRef]);
  const deviceRow = useMemo(() => devices?.find((d) => d.externalRef === boxRef) ?? null, [devices, boxRef]);
  const pendingRow = useMemo(() => pending?.find((p) => p.externalRef === boxRef) ?? null, [pending, boxRef]);
  const ersterLeerLauf = row == null;

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
        reiter={reiter} onReiter={nav} onNavigate={onNavigate} />
      {actionError && <div className="vp-alert vp-alert-warn" role="alert">{actionError}</div>}

      {reiter === 'software' ? (
        <SoftwareReiter row={row} ersterLeerLauf={ersterLeerLauf} verlauf={verlauf} jetzt={jetzt} busy={busy}
          releases={edgeUpdates?.releases ?? []} onAssign={(seq) => act(() => adminApi.setUpdateTarget(row!.deviceId, { releaseSeq: seq }))}
          onRevert={() => act(() => adminApi.revertUpdateTarget(row!.deviceId))} />
      ) : reiter === 'verbindung' ? (
        <VerbindungReiter boxRef={boxRef} row={row} jetzt={jetzt} />
      ) : reiter === 'einrichtung' ? (
        <EinrichtungReiter boxRef={boxRef} deviceRow={deviceRow} pendingRow={pendingRow} werkstattZeile={werkstattZeile}
          werkstattBoxen={werkstattBoxen ?? []} werkstattFreigaben={werkstattFreigaben ?? []} jetzt={jetzt}
          onNavigate={onNavigate} onGeloescht={() => onNavigate?.(pageRoute('geraete-registry'))} />
      ) : reiter === 'verlauf' ? (
        <VerlaufReiter verlauf={verlauf} jetzt={jetzt} fwProtokoll={fwProtokoll ?? []} />
      ) : (
        <UeberblickReiter row={row} ersterLeerLauf={ersterLeerLauf} jetzt={jetzt} onReiter={nav} />
      )}
    </div>
  );
}

// ── Kopf ──────────────────────────────────────────────────────────────────

const REITER: { id: GeraeteAkteReiter | null; label: string }[] = [
  { id: null, label: 'Überblick' },
  { id: 'software', label: 'Software' },
  { id: 'verbindung', label: 'Verbindung' },
  { id: 'einrichtung', label: 'Einrichtung' },
  { id: 'verlauf', label: 'Verlauf' },
];

function AktenKopf({
  boxRef, row, deviceRow, pendingRow, jetzt, reiter, onReiter, onNavigate,
}: {
  boxRef: string;
  row: FleetRow | null;
  deviceRow: AdminDeviceRow | null;
  pendingRow: PendingEnrollment | null;
  jetzt: Date;
  reiter: GeraeteAkteReiter | null;
  onReiter: (r: GeraeteAkteReiter | null) => void;
  onNavigate?: (target: Route) => void;
}) {
  const [menuOffen, setMenuOffen] = useState(false);
  const verbindung = row ? verbindungSicht(row, jetzt) : null;
  const name = row?.siteName?.trim() || deviceRow?.label || boxRef;
  const zustandBadge = verbindung
    ? { ok: verbindung.zustand === 'online', text: verbindung.zustand === 'online' ? `Verbunden · ${verbindung.gesehen ?? ''}` : verbindung.zustand === 'offline' ? `Meldet sich nicht · ${verbindung.gesehen ?? ''}` : 'Wartet auf erste Meldung' }
    : pendingRow
      ? { ok: false, text: 'Meldet sich, wartet auf Zuordnung' }
      : { ok: false, text: 'Noch nicht verbunden' };

  return (
    <>
      <AdminPageHead
        icon="cpu"
        category="primary"
        title={name}
        description={
          <span className="vp-row-gap" style={{ alignItems: 'center' }}>
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
          <div className="vp-row-gap" style={{ alignItems: 'center' }}>
            <Badge variant={zustandBadge.ok ? 'ok' : 'off'} dot data-testid="akte-zustand">
              {zustandBadge.text}
            </Badge>
            {row && (
              <Button variant="outline" size="sm" onClick={() => onReiter('verbindung')}>Fernwartung öffnen</Button>
            )}
            {row && !(row.stand === 'hand' || row.stufe1) && (
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
                </div>
              )}
            </div>
          </div>
        }
      />
      <div className="vp-seg vp-bereich-tabs" role="tablist" aria-label="Geräteakte" data-testid="akte-reiter">
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

function UeberblickReiter({ row, ersterLeerLauf, jetzt, onReiter }: {
  row: FleetRow | null;
  ersterLeerLauf: boolean;
  jetzt: Date;
  onReiter: (r: GeraeteAkteReiter) => void;
}) {
  if (ersterLeerLauf) {
    return (
      <Card padding="lg" radius="lg">
        <p className="vp-muted" style={{ marginTop: 0 }}>
          Diese Box ist noch nicht mit einem Kundenkonto verbunden. Den Stand ihrer Einrichtung zeigt der Reiter „Einrichtung“.
        </p>
        <Button variant="outline" size="sm" onClick={() => onReiter('einrichtung')}>Zur Einrichtung</Button>
      </Card>
    );
  }
  const verbindung = verbindungSicht(row!, jetzt);
  const brauchtDich = row!.state === 'fehlgeschlagen' || row!.state === 'zurueckgerollt' || row!.state === 'blockiert'
    || (verbindung.zustand === 'offline' && row!.rolloutId != null);

  return (
    <div className="vp-geraet-grid">
      {brauchtDich && (
        <Card padding="lg" radius="lg" className="vp-geraet-sek">
          <h2><Icon name="alert-triangle" size={18} /> Braucht dich</h2>
          <p>{row!.reason ?? 'Diese Box braucht Aufmerksamkeit - Einzelheiten im Reiter „Software".'}</p>
          <Button variant="outline" size="sm" onClick={() => onReiter('software')}>Zur Software</Button>
        </Card>
      )}
      <Card padding="lg" radius="lg" className="vp-geraet-sek">
        <h2><Icon name="activity" size={18} /> Jetzt</h2>
        <p className="vp-muted">
          Live-Messwerte dieser Anlage (PV, Netz, Speicher, Haus) stehen in der Kundenansicht dieser Box - „Wie der Kunde es sieht“ im Menü „⋯“ des Kopfes.
        </p>
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

      <Card padding="lg" radius="lg" className="vp-geraet-sek">
        <h2><Icon name="shield" size={18} /> Vertrauen</h2>
        <p><Badge variant={vertrauen.tone === 'ok' ? 'ok' : vertrauen.tone === 'warn' ? 'warn' : 'off'} dot>{vertrauen.label}</Badge></p>
        {vertrauen.detail && <p className="vp-muted vp-text-sm">{vertrauen.detail}</p>}
      </Card>

      <Card padding="lg" radius="lg" className="vp-geraet-sek">
        <h2><Icon name="history" size={18} /> Update-Verlauf</h2>
        {verlauf == null ? (
          <p className="vp-muted vp-text-sm">Der Verlauf wird geladen …</p>
        ) : verlauf.eintraege.length === 0 ? (
          <p className="vp-muted vp-text-sm">Für diese Box ist noch nichts verzeichnet.</p>
        ) : (
          <Zeitleiste zeilen={verlaufSicht(verlauf.eintraege, jetzt)} testId="akte-software-verlauf" />
        )}
      </Card>
    </div>
  );
}

// ── Verbindung ────────────────────────────────────────────────────────────

function VerbindungReiter({ boxRef, row, jetzt }: { boxRef: string; row: FleetRow | null; jetzt: Date }) {
  const verbindung = row ? verbindungSicht(row, jetzt) : null;
  return (
    <div className="vp-geraet-grid">
      <Card padding="lg" radius="lg" className="vp-geraet-sek">
        <h2><Icon name="link" size={18} /> Herzschlag zur Cloud</h2>
        {verbindung ? (
          <p>
            <Badge variant={verbindung.zustand === 'online' ? 'ok' : 'off'} dot>{verbindung.text}</Badge>
            {verbindung.gesehen && <span className="vp-cell-sub"> {verbindung.gesehen}</span>}
          </p>
        ) : <p className="vp-muted">Diese Box hat sich der Cloud noch nie gemeldet.</p>}
      </Card>
      <Card padding="lg" radius="lg" className="vp-geraet-sek vp-geraet-breit" data-testid="akte-wartung">
        <FernwartungKarte edgeRef={boxRef} />
      </Card>
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
      {pendingRow && (
        <Card padding="lg" radius="lg" className="vp-geraet-sek">
          <h2><Icon name="wifi" size={18} /> Meldet sich, wartet auf Zuordnung</h2>
          <p>{pendingRows([pendingRow], jetzt)[0]?.hint}</p>
          <p className="vp-muted vp-text-sm">Meldet sich seit {fmtRelative(pendingRow.csrUpdatedAt, jetzt)}{pendingRow.deviceInfo ? ` · ${pendingRow.deviceInfo}` : ''}.</p>
        </Card>
      )}
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
