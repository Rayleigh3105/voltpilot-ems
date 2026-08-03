import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { KpiCard } from '../../../designsystem/components/shell/KpiCard';
import type { SiteSource } from '../../api';
import type { Tenant } from '../../admin/adminApi';
import { fleetApi } from '../../admin/fleetApi';
import {
  controlMatrixRows,
  fleetLoadNote,
  fleetPulse,
  fleetRows,
  type ControlMatrixInput,
  type FleetRow,
  type FleetTenantData,
} from '../../adminFleet';
import { EmptyState, ErrorState, TableSkeleton } from '../../components/States';
import { useFreshnessPoll } from '../../useFreshnessPoll';
import { anlageRoute, type Route } from '../../nav';
import { AdminPageHead } from './AdminPageHead';

/**
 * Plattform → Übersicht: der FLOTTEN-PULS (Admin-Umbau Stufe 1, Baustein B1).
 *
 * Die tägliche erste Frage eines EMS-Betreibers - „welche Anlage braucht heute
 * meine Aufmerksamkeit?" - hatte im Portal keinen Ort: alles Operative lag
 * hinter dem Mandanten-Umschalter, ein Mandant nach dem anderen. Diese Seite
 * ist genau dieser Ort: eine Zeile je Anlage über ALLE Mandanten, Störungen
 * zuerst, ein Klick springt in den Mandanten-Kontext dieser Anlage.
 *
 * **Bewusst ohne Geld** (Captain-Entscheid Q2): reiner Technik-Blick. Eine
 * Plattform-Summe über die absichtlich hold-last-veränderte Messreihe und eine
 * gemischte Flotte wäre schief und röche nach Abrechnung.
 *
 * **Alle Ableitung ist das reine `adminFleet.ts`** - hier wird nur geladen und
 * gerendert. Drei Ladewellen, damit ein Fehlschlag nie mehr als seine Zelle
 * kostet und der erste Blick schnell steht:
 *
 * 1. je Mandant `/overview` + Anlagen + `/edge-versions` (die Tabelle steht),
 * 2. je Anlage die Quellen-Gesundheit (füllt EINE Spalte nach),
 * 3. beim Aufklappen die Steuerungs-/Abregel-Matrix (B2, nur Speicher-Anlagen).
 */
export function PlattformUebersichtPage({
  tenants,
  onJumpToTenant,
}: {
  tenants: Tenant[];
  onJumpToTenant: (tenantId: string, target: Route) => void;
}) {
  const [data, setData] = useState<FleetTenantData[] | null>(null);
  const [sourcesBySite, setSourcesBySite] = useState<Record<string, SiteSource[]>>({});
  // Der Bezugszeitpunkt der Daten - jedes Alter wird DAGEGEN gerechnet, nie
  // gegen eine Uhr über einem stehenden Schnappschuss (die Lebendigkeits-Lehre).
  const [fetchedAt, setFetchedAt] = useState<number>(() => Date.now());
  const [loadError, setLoadError] = useState<string | null>(null);
  const tenantsKey = tenants.map((t) => t.id).join(',');

  const load = useCallback(async () => {
    if (tenants.length === 0) {
      setData([]);
      return;
    }
    try {
      // Welle 1 (je Mandant): die Tabelle steht.
      const perTenant = await Promise.all(
        tenants.map(async (t): Promise<FleetTenantData> => {
          const [overview, sites, edgeVersions] = await Promise.all([
            fleetApi.overview(t.id).catch(() => null),
            fleetApi.sites(t.id).catch(() => null),
            fleetApi.edgeVersions(t.id).catch(() => null),
          ]);
          return { tenant: { id: t.id, name: t.name }, overview, sites, edgeVersions };
        }),
      );
      setData(perTenant);
      setFetchedAt(Date.now());
      setLoadError(null);

      // Welle 2 (je Anlage): die Quellen-Gesundheit füllt EINE Spalte nach.
      // Sie hängt bewusst am SELBEN Ladevorgang wie Welle 1 - sonst stünde nach
      // dem ersten Abruf für immer ein alter Gesundheitsstand neben einer
      // frischen Bezugszeit (die Lebendigkeits-Lehre gilt für jede Zelle).
      const refs = perTenant.flatMap((d) =>
        (d.overview?.sites ?? []).map((s) => ({ tenantId: d.tenant.id, siteId: s.id })),
      );
      const pairs = await Promise.all(
        refs.map(async (r) => {
          const list = await fleetApi.sources(r.tenantId, r.siteId).catch(() => null);
          return list ? ([r.siteId, list] as const) : null;
        }),
      );
      const next: Record<string, SiteSource[]> = {};
      for (const p of pairs) if (p) next[p[0]] = p[1];
      setSourcesBySite(next);
    } catch {
      // Promise.all über .catch-te Aufrufe kann eigentlich nicht scheitern -
      // wenn doch, steht es da, statt still eine leere Flotte zu behaupten.
      setLoadError('Die Plattform-Übersicht konnte nicht geladen werden.');
    }
  }, [tenantsKey]);

  useEffect(() => {
    void load();
  }, [load]);

  // Stiller 30-s-Takt: eine erfolgreiche Antwort setzt Zustand UND Bezugszeit,
  // ein Fehlschlag lässt beides unberührt (er kann den Zustand nicht kippen).
  useFreshnessPoll(() => void load(), 30_000, tenants.length > 0);

  const rows = useMemo(
    () => (data ? fleetRows(data, sourcesBySite, new Date(fetchedAt)) : null),
    [data, sourcesBySite, fetchedAt],
  );

  const pulse = rows ? fleetPulse(rows) : null;
  const note = data ? fleetLoadNote(data) : null;

  return (
    <>
      <AdminPageHead
        icon="dashboard"
        category="primary"
        title="Plattform-Übersicht"
        description="Alle Anlagen aller Mandanten - Störungen zuerst. Eine Zeile öffnet die Anlage im Kontext ihres Mandanten."
        actions={
          <Button
            variant="ghost"
            iconLeft={<Icon name="refresh-cw" size={18} />}
            onClick={() => void load()}
          >
            Aktualisieren
          </Button>
        }
      />

      {note && <div className="vp-alert vp-alert-warn">{note}</div>}

      {pulse && (
        <div className="vp-kpis vp-admin-pulse" style={{ marginBottom: 'var(--vp-space-6)' }}>
          <KpiCard
            icon={<Icon name="sun" size={20} />}
            category="primary"
            value={String(pulse.sites)}
            label="Anlagen gesamt"
          />
          <KpiCard
            icon={<Icon name="alert-triangle" size={20} />}
            category={pulse.gestoert > 0 ? 'industry' : 'primary'}
            value={String(pulse.gestoert)}
            label="Gestört / meldet sich nicht"
          />
          <KpiCard
            icon={<Icon name="history" size={20} />}
            category={pulse.planAlt > 0 ? 'dynamic' : 'primary'}
            value={String(pulse.planAlt)}
            label="Plan älter als 2 Std."
          />
          <KpiCard
            icon={<Icon name="wifi" size={20} />}
            category="primary"
            value={String(pulse.wartet)}
            label="Wartet auf erste Daten"
          />
          <KpiCard
            icon={<Icon name="settings" size={20} />}
            category={pulse.pflegeOffen > 0 ? 'dynamic' : 'primary'}
            value={String(pulse.pflegeOffen)}
            label="Offene Pflege-Punkte"
          />
        </div>
      )}

      {loadError ? (
        <ErrorState message={loadError} onRetry={() => void load()} />
      ) : rows == null ? (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <TableSkeleton rows={5} cols={7} />
        </Card>
      ) : rows.length === 0 ? (
        <Card padding="lg" radius="lg">
          <EmptyState
            icon="sun"
            category="primary"
            title="Noch keine Anlage auf der Plattform"
            description="Sobald ein Mandant seine erste Anlage angelegt hat, steht sie hier."
          />
        </Card>
      ) : (
        <>
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            <table className="vp-table responsive vp-fleetpuls">
              <thead>
                <tr>
                  <th>Anlage</th>
                  <th>Geräte</th>
                  <th>Letzte Daten</th>
                  <th>Quellen</th>
                  <th>Plan</th>
                  <th>Edge-Stand</th>
                  <th>Signale</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  // Mandant + Anlage als Schlüssel: Anlagen-Ids sind zwar
                  // global eindeutig, aber der Puls fügt Listen aus mehreren
                  // Antworten zusammen - der Schlüssel soll nicht davon
                  // abhängen, dass zwei Server-Antworten sich nie überschneiden.
                  <FleetTableRow key={`${r.tenantId}:${r.siteId}`} row={r} onOpen={onJumpToTenant} />
                ))}
              </tbody>
            </table>
          </Card>

          <ControlMatrixSection rows={rows} refreshKey={fetchedAt} onOpen={onJumpToTenant} />
        </>
      )}
    </>
  );
}

function FleetTableRow({
  row,
  onOpen,
}: {
  row: FleetRow;
  onOpen: (tenantId: string, target: Route) => void;
}) {
  const open = () => onOpen(row.tenantId, anlageRoute(row.siteId));
  return (
    <tr className="clickable" onClick={open}>
      <td data-label="Anlage">
        <div className="vp-cell-main">
          <button
            type="button"
            className="vp-linklike"
            onClick={(e) => {
              e.stopPropagation();
              open();
            }}
          >
            {row.siteName}
          </button>
          <span className="vp-cell-sub">{row.tenantName}</span>
        </div>
      </td>
      <td data-label="Geräte">
        <Badge variant={row.deviceTone} dot>
          {row.deviceText}
        </Badge>
      </td>
      <td data-label="Letzte Daten">
        <span className={row.liveTone === 'ok' ? undefined : 'vp-muted'}>{row.liveText}</span>
      </td>
      <td data-label="Quellen">
        {row.sources ? (
          <Badge variant={row.sources.tone} dot>
            {row.sources.text}
          </Badge>
        ) : (
          <span className="vp-muted">—</span>
        )}
      </td>
      <td data-label="Plan">
        <span className={row.planTone === 'ok' ? undefined : 'vp-muted'}>{row.planText}</span>
      </td>
      <td data-label="Edge-Stand">
        <span
          className={row.edge.tone === 'ok' ? 'vp-mono' : 'vp-mono vp-muted'}
          title={row.edge.paletteVersion ? `Palette ${row.edge.paletteVersion}` : undefined}
        >
          {row.edge.text}
        </span>
      </td>
      <td data-label="Signale">
        <div className="vp-fleet-signals">
          {row.signals.map((s) => (
            <Badge key={s.id} variant={s.tone} dot>
              {s.label}
            </Badge>
          ))}
        </div>
      </td>
    </tr>
  );
}

/**
 * B2 - die Steuerungs-/Abregel-Matrix als LAZY Sektion des Pulses.
 *
 * Sie beantwortet die Pilsting-Frage: „wo ist Steuerung frei UND zertifiziert,
 * wo klafft geplant gegen ausgeführt?" `certifiedUnits < units` („0 von 2
 * Wechselrichtern freigegeben") war wochenlang unsichtbar, obwohl der Beleg in
 * der DB lag.
 *
 * Lazy und nur für Anlagen MIT Speicher: die zwei Belege sind je Anlage
 * abrufbar, das kostet also einen Aufruf je Zeile - der Puls darf davon beim
 * ersten Blick nicht ausgebremst werden.
 */
function ControlMatrixSection({
  rows,
  refreshKey,
  onOpen,
}: {
  rows: FleetRow[];
  /** Der Bezugszeitpunkt des Pulses - ändert er sich, holt auch die Matrix neu. */
  refreshKey: number;
  onOpen: (tenantId: string, target: Route) => void;
}) {
  const candidates = useMemo(() => rows.filter((r) => r.hasStorage), [rows]);
  const candidateKey = candidates.map((c) => `${c.tenantId}:${c.siteId}`).join(',');
  const [open, setOpen] = useState(false);
  const [inputs, setInputs] = useState<ControlMatrixInput[] | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number>(() => Date.now());

  // Geladen wird erst beim Aufklappen (zwei Abrufe je Zeile), danach im Takt
  // des Pulses - ein Beleg-Alter, das nach dem ersten Laden einfriert, wäre
  // genau die Halbwahrheit, die diese Matrix beenden soll.
  useEffect(() => {
    if (!open || candidates.length === 0) return;
    let cancelled = false;
    void Promise.all(
      candidates.map(async (c): Promise<ControlMatrixInput> => {
        const [control, curtailment] = await Promise.all([
          fleetApi.controlStatus(c.tenantId, c.siteId).catch(() => null),
          fleetApi.curtailmentStatus(c.tenantId, c.siteId).catch(() => null),
        ]);
        return {
          siteId: c.siteId,
          siteName: c.siteName,
          tenantId: c.tenantId,
          tenantName: c.tenantName,
          control,
          curtailment,
        };
      }),
    ).then((res) => {
      if (cancelled) return;
      setInputs(res);
      setFetchedAt(Date.now());
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, candidateKey, refreshKey]);

  if (candidates.length === 0) return null;

  const matrix = inputs ? controlMatrixRows(inputs, new Date(fetchedAt)) : null;

  return (
    <Card style={{ padding: 0, overflow: 'hidden', marginTop: 'var(--vp-space-6)' }}>
      <div className="vp-admin-sec-head">
        <h2>
          <button
            type="button"
            className="vp-linklike"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            Steuerung &amp; Abregelung ({candidates.length})
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={16} />
          </button>
        </h2>
        <p>
          Nur Anlagen mit Speicher. Der Beleg-Stand je Zeile - eine Begrenzung
          gilt erst als ausgeführt, wenn der Wechselrichter sie bestätigt hat.
        </p>
      </div>
      {open &&
        (matrix == null ? (
          <TableSkeleton rows={Math.min(candidates.length, 4)} cols={5} />
        ) : (
          <table className="vp-table responsive">
            <thead>
              <tr>
                <th>Anlage</th>
                <th>Batterie-Steuerung</th>
                <th>Abregelung</th>
                <th>Ausführung jetzt</th>
                <th>Beleg</th>
              </tr>
            </thead>
            <tbody>
              {matrix.map((m) => (
                <tr key={m.siteId}>
                  <td data-label="Anlage">
                    <div className="vp-cell-main">
                      <button
                        type="button"
                        className="vp-linklike"
                        onClick={() => onOpen(m.tenantId, anlageRoute(m.siteId))}
                      >
                        {m.siteName}
                      </button>
                      <span className="vp-cell-sub">{m.tenantName}</span>
                    </div>
                  </td>
                  <td data-label="Batterie-Steuerung">
                    <div className="vp-cell-main">
                      <Badge variant={m.battery.tone} dot>
                        {m.battery.text}
                      </Badge>
                      {m.battery.detail && <span className="vp-cell-sub">{m.battery.detail}</span>}
                    </div>
                  </td>
                  <td data-label="Abregelung">
                    <div className="vp-cell-main">
                      <Badge variant={m.curtail.tone} dot>
                        {m.curtail.text}
                      </Badge>
                      {m.curtail.detail && <span className="vp-cell-sub">{m.curtail.detail}</span>}
                    </div>
                  </td>
                  <td data-label="Ausführung jetzt">{m.executionText}</td>
                  <td data-label="Beleg">
                    <span className={m.belegStale ? 'vp-muted' : undefined}>{m.belegText}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </Card>
  );
}
