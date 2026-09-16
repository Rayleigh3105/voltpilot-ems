import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { KpiCard } from '../../../designsystem/components/shell/KpiCard';
import { adminApi } from '../../admin/adminApi';
import { fleetApi, type AdminFleetRelease, type AdminFleetSite } from '../../admin/fleetApi';
import {
  kpiText,
  kpiTone,
  kpiUnknownNote,
  loudBanner,
  type EdgeUpdates,
} from '../../adminEdgeUpdates';
import {
  controlMatrixInputs,
  controlMatrixRows,
  fleetPulse,
  fleetRows,
  type FleetRow,
} from '../../adminFleet';
import { EmptyState, ErrorState, TableSkeleton } from '../../components/States';
import { useFreshnessPoll } from '../../useFreshnessPoll';
import { anlageRoute, pageRoute, type Route } from '../../nav';
import { AdminPageHead } from './AdminPageHead';
// LIST: eine Verwaltungs-Übersicht bewegt sich nicht sekündlich.
import { LIST_POLL_MS } from '../../pollCadence';

/**
 * Plattform → Übersicht: der FLOTTEN-PULS (Bausteine B1 + B2 + B4).
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
 * **Seit Stufe 2 speist EIN Aufruf die ganze Seite** (`GET /api/v1/admin/fleet`)
 * - die Mandanten-Schleife und die Nachlade-Wellen der Stufe 1 sind entfallen,
 * die Ableitungen und die Oberfläche sind dieselben geblieben. Alle Ableitung
 * ist weiterhin das reine `adminFleet.ts`; hier wird nur geladen und gerendert.
 */
export function PlattformUebersichtPage({
  onJumpToTenant,
  onNavigate,
}: {
  onJumpToTenant: (tenantId: string, target: Route) => void;
  // Die Edge-Updates-Seite ist mandanten-UNABHÄNGIG - der Sprung dorthin darf
  // den Mandanten-Umschalter deshalb nicht anfassen (onJumpToTenant würde ihn
  // umstellen, und ein leerer Mandant löschte die Auswahl des Betreibers).
  onNavigate?: (target: Route) => void;
}) {
  const [unterstuetzungBis, setUnterstuetzungBis] = useState<Record<string, string> | null>(null);
  const [sites, setSites] = useState<AdminFleetSite[] | null>(null);
  // Das Release-Register aus derselben Antwort - der Maßstab für „veraltet".
  // Leer heißt kein Maßstab, und dann wird nichts als veraltet behauptet.
  const [releases, setReleases] = useState<AdminFleetRelease[]>([]);
  // Der Bezugszeitpunkt der Daten - jedes Alter wird DAGEGEN gerechnet, nie
  // gegen eine Uhr über einem stehenden Schnappschuss (die Lebendigkeits-Lehre).
  const [fetchedAt, setFetchedAt] = useState<number>(() => Date.now());
  const [loadError, setLoadError] = useState<string | null>(null);
  // OTA Stufe 2: der Update-Puls. FAIL-SOFT und in einem EIGENEN Zustand -
  // fällt er aus, fehlt die Karte, statt „0 fehlgeschlagen" zu behaupten.
  const [updates, setUpdates] = useState<EdgeUpdates | null>(null);

  const load = useCallback(async () => {
    try {
      const fleet = await fleetApi.fleet();
      setSites(fleet.sites);
      setUnterstuetzungBis(fleet.unterstuetzungBis ?? null);
      setReleases(fleet.releases ?? []);
      setFetchedAt(Date.now());
      setLoadError(null);
    } catch {
      // Ein Fehlschlag ist keine Datenlage: die Seite sagt, dass sie nichts
      // weiß, statt eine leere Flotte zu behaupten. Steht schon eine Tabelle,
      // bleibt sie mit ihrer alten Bezugszeit stehen (der stille Takt darf den
      // Zustand nie kippen).
      setLoadError('Die Plattform-Übersicht konnte nicht geladen werden.');
    }
    try {
      setUpdates(await adminApi.edgeUpdates());
    } catch {
      // Ein älteres Backend kennt die Route noch nicht - dann gibt es keine
      // Update-Karte, und das ist ehrlicher als eine erfundene Null.
      setUpdates(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Stiller 30-s-Takt: eine erfolgreiche Antwort setzt Zustand UND Bezugszeit,
  // ein Fehlschlag lässt beides unberührt (er kann den Zustand nicht kippen).
  useFreshnessPoll(() => void load(), LIST_POLL_MS, true);

  const rows = useMemo(
    () => (sites ? fleetRows(sites, new Date(fetchedAt), releases) : null),
    [sites, fetchedAt, releases],
  );

  const pulse = rows ? fleetPulse(rows) : null;
  const updateBanner = updates ? loudBanner(updates.fleet) : null;

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

      {loadError && rows != null && <div className="vp-alert vp-alert-warn">{loadError}</div>}

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
          {/* OTA Stufe 2: der Update-Puls. Der Zähler läuft über die
              ERREICHBARE Menge - ein Gerät ohne Meldung steht weder im Zähler
              noch im Nenner, und die Zusatzzeile sagt das. */}
          {updates && (
            <button
              type="button"
              className="vp-kpi-link"
              onClick={() => onNavigate?.(pageRoute('edge-updates'))}
              title={kpiUnknownNote(updates.kpi) ?? 'Zur Seite Edge-Updates'}
            >
              <KpiCard
                icon={<Icon name="refresh-cw" size={20} />}
                category={kpiTone(updates.kpi) === 'warn' ? 'industry' : 'primary'}
                value={kpiText(updates.kpi)}
                label="Edge-Updates"
              />
            </button>
          )}
        </div>
      )}

      {/* Warn-first wie überall im Puls: eine rote Zeile trägt ihren Grund und
          NENNT die betroffene Anlage. */}
      {updateBanner && <div className="vp-alert vp-alert-warn">{updateBanner}</div>}

      {loadError && rows == null ? (
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
                  <th>Unterstützung bis</th>
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
                  // Mandant + Anlage als Schlüssel: Anlagen-Ids sind global
                  // eindeutig, aber der Schlüssel soll auch dann tragen, wenn
                  // dieselbe Anlage je unter zwei Mandanten stünde.
                  <FleetTableRow key={`${r.tenantId}:${r.siteId}`} row={r} unterstuetzungBis={unterstuetzungBis === null ? undefined : unterstuetzungBis[r.tenantId] ?? null} onOpen={onJumpToTenant} />
                ))}
              </tbody>
            </table>
          </Card>

          <ControlMatrixSection
            sites={sites ?? []}
            fetchedAt={fetchedAt}
            onOpen={onJumpToTenant}
          />
        </>
      )}
    </>
  );
}

function FleetTableRow({
  unterstuetzungBis,
  row,
  onOpen,
}: {
  row: FleetRow;
  unterstuetzungBis?: string | null;
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
      <td data-label="Unterstützung bis">{unterstuetzungBis === undefined ? 'Nicht verfügbar' : unterstuetzungBis === null ? 'Keine aktive Unterstützung' : new Date(unterstuetzungBis).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}</td>
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
        {/*
          Soll-gegen-Ist (OTA Stufe 0): `<soll> ✓` wenn der gemeldete Stand DER
          Soll-Stand ist, `<ist> → <soll>` wenn er im Register davor liegt.
          „unbekannt" und „nicht registriert" sind eigene, ruhige Zustände - sie
          werden nie als veraltet gefärbt. Die Begründung reist als `title` mit;
          die Palette-Version bleibt daneben stehen, wo es eine gibt.
        */}
        <span
          className={row.edge.tone === 'warn' ? 'vp-mono vp-edge-stand-warn' : 'vp-mono vp-muted'}
          title={
            row.edge.paletteVersion
              ? `${row.edge.title} · Palette ${row.edge.paletteVersion}`
              : row.edge.title
          }
        >
          {row.edge.text}
        </span>
      </td>
      <td data-label="Signale">
        <div className="vp-fleet-signals">
          {row.signals.map((s) => (
            // Die Begründung reist am Chip mit (`title`) - ein Signal, das
            // seinen Grund nicht nennen kann, wäre nur ein Alarm.
            <span key={s.id} title={s.title}>
              <Badge variant={s.tone} dot>
                {s.label}
              </Badge>
            </span>
          ))}
        </div>
      </td>
    </tr>
  );
}

/**
 * B2 - die Steuerungs-/Abregel-Matrix als Sektion des Pulses.
 *
 * Sie beantwortet die Pilsting-Frage: „wo ist Steuerung frei UND zertifiziert,
 * wo klafft geplant gegen ausgeführt?" `certifiedUnits < units` („0 von 2
 * Wechselrichtern freigegeben") war wochenlang unsichtbar, obwohl der Beleg in
 * der DB lag.
 *
 * Nur Anlagen MIT Speicher - und seit Stufe 2 ohne eigenen Abruf: die beiden
 * Belege reisen im Flotten-Aggregat mit, das Aufklappen ist damit reine
 * Anzeige. Das Beleg-ALTER rechnet gegen dieselbe Bezugszeit wie der Puls
 * darüber; ein einfrierendes Alter wäre genau die Halbwahrheit, die diese
 * Matrix beenden soll.
 */
function ControlMatrixSection({
  sites,
  fetchedAt,
  onOpen,
}: {
  sites: AdminFleetSite[];
  fetchedAt: number;
  onOpen: (tenantId: string, target: Route) => void;
}) {
  const [open, setOpen] = useState(false);
  const candidates = useMemo(() => controlMatrixInputs(sites), [sites]);

  if (candidates.length === 0) return null;

  const matrix = controlMatrixRows(candidates, new Date(fetchedAt));

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
      {open && (
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
      )}
    </Card>
  );
}
