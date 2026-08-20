import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { api, ApiError, type Site } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { LadeBudgetBand } from '../components/LadeBudgetBand';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { fmtNum } from '../format';
import {
  ANBINDEN_ALLOWLIST,
  ANBINDEN_SCHRITTE,
  ausfallSchutz,
  BOOST_INTRO,
  boostbar,
  boostFolgen,
  budgetBand,
  chargerName,
  chargerView,
  connectorName,
  idleLine,
  kombinationsStreifen,
  ladevorgangRows,
  sonnenDeckung,
  surplusLine,
  type ChargePoint,
  type LadevorgangRow,
  type SiteCharging,
} from '../ladepunkte';
import './Ladevorgaenge.css';

/**
 * Die Ladevorgänge einer Anlage (`#/anlage/{id}/ladevorgaenge`) - die Fläche 1
 * der abgenommenen Mockups als Seite: die Budget-Bühne, die Ladevorgangs-Zeilen,
 * die Säulen mit ihrem Zustand, der Ausfall-Schutz mit seiner RECHNUNG und der
 * Weg, eine weitere Säule anzubinden.
 *
 * ⚠ Jede Zahl und jeder Grund kommt aus der BOX und wird nur weitergereicht
 * (`ladepunkte.ts`); diese Seite rendert, sie entscheidet nichts. Es gibt hier
 * bewusst keinen Knopf, der eine Ladegrenze setzt - Grenzen entstehen allein im
 * Lastmanagement der Box.
 */
export function LadevorgaengeSection({ site }: { site: Site }) {
  const [charging, setCharging] = useState<SiteCharging | null>(null);
  const [error, setError] = useState<string | null>(null);
  // „Jetzt voll laden": die EINE Aktion dieser Seite. Sie setzt keine Grenze -
  // sie nimmt EINEN Ladevorgang von der Quellen-Politik aus.
  const [dialog, setDialog] = useState<LadevorgangRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setCharging(null);
    setError(null);
    const load = () =>
      api.siteChargers(site.id).then(
        (c) => active && setCharging(c),
        (e) => active && setError(e instanceof ApiError ? e.message : 'Fehler'),
      );
    load();
    // Ladevorgänge ändern sich im Sekundentakt; 30 s ist die Kadenz des Hauses.
    const timer = window.setInterval(load, 30000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [site.id]);

  async function boost(row: LadevorgangRow, cancel: boolean) {
    setBusy(true);
    setActionError(null);
    try {
      await api.chargingBoost(site.id, {
        chargePointId: row.chargePointId,
        connectorId: row.connectorId,
        cancel,
      });
      setCharging(await api.siteChargers(site.id));
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Das hat gerade nicht geklappt.');
    } finally {
      setBusy(false);
      setDialog(null);
    }
  }

  if (error) return <ErrorState message={error} />;
  if (!charging) return <Skeleton height={160} />;

  const band = budgetBand(charging.budget);
  const rows = ladevorgangRows(charging.chargers);
  const idle = idleLine(charging);
  const steps = ausfallSchutz(charging.budget);
  const quelle = surplusLine(charging.budget);
  const kombi = kombinationsStreifen(charging.budget);
  const sonne = sonnenDeckung(charging.budget);

  return (
    <div className="vp-lade-page">
      {band && (
        <Card>
          <h2 className="vp-lade-h2">Ladeleistung</h2>
          <LadeBudgetBand band={band} />
          {/* BEIDE Wahrheiten: was die Sonne erlaubt und was der Anschluss
              erlaubt. Ohne beide läse eine Drosselung an einem freien Anschluss
              wie ein Defekt (Mockups §1a). */}
          {sonne && <p className="vp-lade-note">Laden · {sonne}.</p>}
          {quelle && <p className="vp-lade-note">{quelle}</p>}
          {kombi && <p className="vp-lade-note">{kombi}</p>}
          {charging.budget && !charging.budget.controlEnabled && charging.budget.controlNote && (
            <p className="vp-lade-note">{charging.budget.controlNote}</p>
          )}
        </Card>
      )}

      <Card>
        <h2 className="vp-lade-h2">Ladevorgänge</h2>
        {idle && <p className="vp-lade-idle">{idle}</p>}
        {actionError && <p className="vp-lade-note">{actionError}</p>}
        {rows.length > 0 && (
          <ul className="vp-lade-rows">
            {rows.map((r) => (
              <li key={r.key} className={`vp-lade-row tone-${r.tone}`}>
                <span className="vp-lade-dot" aria-hidden="true" />
                <span className="vp-lade-row-title">
                  {r.title}
                  {r.priority && <Badge variant="tint">Vorrang</Badge>}
                </span>
                <span className="vp-lade-row-word">{r.word}</span>
                <span className="vp-lade-row-values">
                  {r.powerKw != null ? fmtNum(r.powerKw, 'kW') : '-'}
                  {r.allocatedKw != null && (
                    <span className="vp-lade-row-alloc">
                      zugeteilt {fmtNum(r.allocatedKw, 'kW')}
                    </span>
                  )}
                  {r.socPct != null && (
                    <span className="vp-lade-row-soc">Fahrzeug {fmtNum(r.socPct, '%', 0)}</span>
                  )}
                  {r.since && <span className="vp-lade-row-since">{r.since}</span>}
                </span>
                {(r.reason || r.nextTurn) && (
                  <span className="vp-lade-row-reason">
                    {[r.reason, r.nextTurn].filter(Boolean).join(' · ')}
                  </span>
                )}
                {/* ⚠ Der Knopf wird nur angeboten, wo er etwas ändern KANN. Ein
                    Knopf, der strukturell nichts bewirkt, ist Lärm. */}
                {boostbar(charging.budget, r) && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setDialog(r)}
                  >
                    Jetzt voll laden
                  </Button>
                )}
                {r.boost && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void boost(r, true)}
                  >
                    Wieder Ihre Priorität
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="vp-lade-h2">Ladesäulen</h2>
        {charging.chargers.length === 0 ? (
          <EmptyState
            title="Noch keine Ladesäule verbunden"
            description={ANBINDEN_SCHRITTE[0]}
          />
        ) : (
          <ul className="vp-lade-stations">
            {charging.chargers.map((c) => (
              <StationCard key={c.chargePointId} charger={c} />
            ))}
          </ul>
        )}
      </Card>

      {steps.length > 0 && (
        <Card>
          <h2 className="vp-lade-h2">Ausfall-Schutz</h2>
          <ol className="vp-lade-steps">
            {steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          <p className="vp-lade-always">Immer aktiv - unabhängig davon, was VoltPilot gerade tut.</p>
        </Card>
      )}

      <Card>
        <h2 className="vp-lade-h2">Weitere Säule anbinden</h2>
        <ol className="vp-lade-steps">
          {ANBINDEN_SCHRITTE.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
        <p className="vp-lade-note">{ANBINDEN_ALLOWLIST}</p>
      </Card>

      {/* Der Haus-Dialog mit der Folgenliste - sie sagt auch, was GLEICH bleibt. */}
      <ConfirmDialog
        open={dialog != null}
        title="Jetzt voll laden"
        intro={BOOST_INTRO}
        consequences={boostFolgen()}
        confirmLabel="Jetzt voll laden"
        busy={busy}
        onConfirm={() => dialog && void boost(dialog, false)}
        onCancel={() => setDialog(null)}
      />
    </div>
  );
}

/** Eine Säule mit ihrem Zustand, ihrer Selbstauskunft und ihren Steckern. */
function StationCard({ charger }: { charger: ChargePoint }) {
  const view = chargerView(charger);
  const self = [charger.vendor, charger.model].filter(Boolean).join(' ');
  return (
    <li className={`vp-lade-station tone-${view.tone}`}>
      <div className="vp-lade-station-head">
        <span className="vp-lade-dot" aria-hidden="true" />
        <strong>{chargerName(charger)}</strong>
        <span className="vp-lade-station-word">{view.word}</span>
        {charger.priority && <Badge variant="tint">Vorrang</Badge>}
      </div>
      <p className="vp-lade-note">{view.detail}</p>
      <details className="vp-lade-details">
        <summary>Technische Angaben</summary>
        <dl className="vp-lade-dl">
          <dt>Kennung</dt>
          <dd>{charger.chargePointId}</dd>
          <dt>Verbindung</dt>
          <dd>OCPP 1.6J - die Säule wählt VoltPilot an</dd>
          {self && (
            <>
              <dt>Angabe der Säule</dt>
              <dd>{self}</dd>
            </>
          )}
          {charger.firmware && (
            <>
              <dt>Firmware</dt>
              <dd>{charger.firmware}</dd>
            </>
          )}
        </dl>
        <ul className="vp-lade-plugs">
          {(charger.connectors ?? []).map((con) => (
            <li key={con.connectorId}>
              {connectorName(con.connectorId)}
              {con.status ? ` · ${con.status}` : ''}
              {con.readback === 'abweichend' && ' · Grenze nicht bestätigt'}
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}
