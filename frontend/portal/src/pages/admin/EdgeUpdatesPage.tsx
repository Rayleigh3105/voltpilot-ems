import { useEffect, useMemo, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { Drawer } from '../../../designsystem/components/shell/Drawer';
import { ApiError } from '../../api';
import { adminApi } from '../../admin/adminApi';
import { EmptyState, ErrorState, TableSkeleton } from '../../components/States';
import { fmtRelative } from '../../format';
import { AdminPageHead } from './AdminPageHead';
import {
  actorLabel,
  bakeLine,
  eventLabel,
  advanceMode,
  crossoverHint,
  crossoverState,
  formatTrustStamp,
  loudBanner,
  promoteHint,
  rolloutStateLabel,
  signatureLabel,
  sortFleet,
  stateLabel,
  visibleJournal,
  type EdgeUpdates,
  type EdgeUpdatesRelease,
  type FleetRow,
  type UpdateTone,
} from '../../adminEdgeUpdates';

const toneVariant = (tone: UpdateTone): 'ok' | 'warn' | 'off' =>
  tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : 'off';

const fmtWhen = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '–';

/**
 * Plattform → **Edge-Updates** (OTA Stufe 2, Scout §7.3): Releases · aktiver
 * Rollout · Flotten-Matrix · Verlauf.
 *
 * **Diese Seite entscheidet NICHTS.** Ob eine Welle frei ist, was ein Gerät
 * gerade tut und warum eine Freigabe gesperrt ist, sagt der Server
 * (`RolloutStates`/`BakeGate`) - hier wird es gerendert. Die Freigabe ist
 * server-seitig gesperrt, nicht nur der Knopf: ein direkter Aufruf des
 * Endpunkts bekommt dieselbe 409 mit demselben Grund.
 *
 * Die Ehrlichkeitsregeln (§7): „unbekannt" ist nie „veraltet", „offline" ist
 * nie „fehlgeschlagen", Prozente laufen über die erreichbare Menge, und jede
 * rote Zeile trägt ihren Grund.
 */
export function EdgeUpdatesPage() {
  const [data, setData] = useState<EdgeUpdates | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rolloutFor, setRolloutFor] = useState<EdgeUpdatesRelease | null>(null);
  const [deviceFor, setDeviceFor] = useState<string | null>(null);

  async function load() {
    setLoadError(null);
    try {
      setData(await adminApi.edgeUpdates());
    } catch (e) {
      setLoadError(
        e instanceof ApiError ? e.message : 'Die Edge-Updates konnten nicht geladen werden.',
      );
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      // Der Server liefert seinen deutschen Grund mit - er wird gezeigt, nicht
      // durch eine allgemeine Floskel ersetzt.
      setActionError(e instanceof ApiError ? e.message : 'Die Aktion ist fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  const rollout = data?.activeRollout ?? null;
  const fleet = useMemo(() => sortFleet(data?.fleet ?? []), [data]);
  const banner = useMemo(() => loudBanner(data?.fleet ?? []), [data]);
  const journal = useMemo(() => visibleJournal(data?.journal ?? []), [data]);
  const hint = promoteHint(rollout);
  const mode = advanceMode(rollout);
  // OTA Stufe 4: der ruhige TOFU-Hinweis über der Flotte. Er zählt nur BELEGT
  // offene Crossover; ein Gerät, das nichts meldet, wird getrennt genannt -
  // aus „unbekannt" lässt sich keine Aufgabe ableiten.
  const crossover = useMemo(() => crossoverHint(data?.fleet ?? []), [data]);

  return (
    <>
      <AdminPageHead
        icon="refresh-cw"
        category="industry"
        title="Edge-Updates"
        description="Welches Release läuft wo, was ist zugewiesen - und was ist daraus geworden."
        actions={
          <Button
            variant="outline"
            iconLeft={<Icon name="refresh-cw" size={18} />}
            onClick={() => void load()}
          >
            Aktualisieren
          </Button>
        }
      />

      {/* Warn-first, wie im Flotten-Puls: was Aufmerksamkeit braucht, steht oben
          und NENNT die Geräte. Ein Alarm ohne Adresse ist Lärm. */}
      {banner && (
        <div className="vp-alert vp-alert-warn" data-testid="loud-banner">
          {banner}
        </div>
      )}
      {actionError && <div className="vp-alert vp-alert-warn">{actionError}</div>}

      {loadError && data == null ? (
        <ErrorState message={loadError} onRetry={() => void load()} />
      ) : data == null ? (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <TableSkeleton rows={5} cols={6} />
        </Card>
      ) : (
        <>
          {/* ── 1. Releases ─────────────────────────────────────────────── */}
          <Card padding="lg" radius="lg" style={{ marginBottom: 'var(--vp-space-6)' }}>
            <h3 style={{ marginTop: 0 }}>Releases</h3>
            {data.releases.length === 0 ? (
              <EmptyState
                title="Noch kein Release registriert"
                description="Ohne Register ist „veraltet“ keine Aussage. Ein Release wird nach der Signatur über die Admin-Schnittstelle eingetragen (docs/ota-signing.md)."
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
                  {data.releases.map((r) => {
                    const sig = signatureLabel(r);
                    return (
                      <tr key={r.releaseSeq}>
                        <td data-label="Version">
                          <strong>{r.version}</strong>
                          {r.notes && (
                            <div className="vp-muted vp-text-sm">{r.notes}</div>
                          )}
                        </td>
                        <td data-label="Commit" className="vp-muted">
                          {r.targetCommit ?? '–'}
                        </td>
                        <td data-label="Signatur">
                          <Badge variant={toneVariant(sig.tone)} dot>
                            {sig.label}
                          </Badge>
                        </td>
                        <td data-label="Läuft auf">
                          {r.runningOnDevices === 0
                            ? '–'
                            : `${r.runningOnDevices} Gerät${r.runningOnDevices === 1 ? '' : 'e'}`}
                        </td>
                        <td>
                          {/* Nur ein SIGNIERTES Release ist verteilbar: ohne
                              Manifest-Bytes hat ein Gerät nichts, was es gegen
                              seine eingebackene Wurzel prüfen könnte. */}
                          {r.signed ? (
                            <Button
                              variant="outline"
                              onClick={() => setRolloutFor(r)}
                              disabled={busy}
                            >
                              Rollout starten ▸
                            </Button>
                          ) : (
                            <span className="vp-muted vp-text-sm">
                              Nicht signiert – nicht verteilbar
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>

          {/* ── 2. Aktiver Rollout ──────────────────────────────────────── */}
          <Card padding="lg" radius="lg" style={{ marginBottom: 'var(--vp-space-6)' }}>
            <div className="vp-row-between">
              <h3 style={{ marginTop: 0 }}>Aktiver Rollout</h3>
              {rollout && (
                <Badge variant={toneVariant(rolloutStateLabel(rollout.state).tone)} dot>
                  {rolloutStateLabel(rollout.state).label}
                </Badge>
              )}
            </div>
            {!rollout ? (
              <EmptyState
                title="Kein Rollout"
                description="Es ist gerade keine Verteilung unterwegs."
              />
            ) : (
              <>
                <p className="vp-muted">
                  {rollout.releaseVersion} → {rollout.channel} · gestartet{' '}
                  {fmtWhen(rollout.createdAt)}
                  {rollout.createdBy ? ` von ${actorLabel(rollout.createdBy)}` : ''}
                </p>
                {rollout.haltedReason && (
                  <div className="vp-alert vp-alert-warn" data-testid="halted-reason">
                    {rollout.haltedReason}
                  </div>
                )}

                {rollout.waves.map((w) => (
                  <div key={w.index} style={{ marginBottom: 'var(--vp-space-4)' }}>
                    <div className="vp-text-sm" style={{ fontWeight: 600 }}>
                      Welle {w.index} · {w.name}{' '}
                      {!w.released && <span className="vp-muted">(noch nicht freigegeben)</span>}
                    </div>
                    <ul className="vp-plain-list">
                      {w.devices.map((d) => {
                        const st = stateLabel(d.state);
                        const bake = bakeLine(d);
                        return (
                          <li key={d.deviceId} className="vp-wave-device">
                            <Badge variant={toneVariant(st.tone)} dot>
                              {st.label}
                            </Badge>{' '}
                            <strong>{d.siteName ?? d.label}</strong>
                            {d.tenantName && <span className="vp-muted"> · {d.tenantName}</span>}
                            {d.since && (
                              <span className="vp-muted"> · seit {fmtRelative(d.since)}</span>
                            )}
                            {/* Jede nicht-grüne Zeile trägt ihren Grund. */}
                            {d.reason && <div className="vp-muted vp-text-sm">{d.reason}</div>}
                            {bake && <div className="vp-muted vp-text-sm">{bake}</div>}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}

                <div className="vp-row-gap">
                  {rollout.state === 'active' && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void act(() => adminApi.pauseRollout(rollout.id))}
                    >
                      ⏸ Pausieren
                    </Button>
                  )}
                  {rollout.state === 'paused' && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void act(() => adminApi.resumeRollout(rollout.id))}
                    >
                      ▶ Fortsetzen
                    </Button>
                  )}
                  {(rollout.state === 'active' || rollout.state === 'paused') && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        // Der Not-Aus ist ENDGÜLTIG - das steht in der Rückfrage,
                        // nicht erst hinterher.
                        if (
                          !window.confirm(
                            'Rollout einfrieren? Es wird nichts weiter verteilt. Bereits erteilte '
                              + 'Zuweisungen bleiben bestehen. Weitermachen ist danach ein NEUER Rollout.',
                          )
                        ) {
                          return;
                        }
                        void act(() => adminApi.haltRollout(rollout.id));
                      }}
                    >
                      ⛔ Einfrieren
                    </Button>
                  )}
                  <Button
                    variant="primary"
                    disabled={busy || !rollout.canPromote}
                    onClick={() => void act(() => adminApi.promoteRollout(rollout.id))}
                  >
                    Nächste Welle ▸
                  </Button>
                </div>
                {/* In welchem Modus läuft dieser Rollout - und was passiert als
                    Nächstes. Ohne diese Zeile wäre die Automatik ein
                    unsichtbarer Zustand. */}
                {mode && (
                  <div className="vp-row-gap" style={{ marginTop: 'var(--vp-space-3)' }}
                       data-testid="advance-mode">
                    <Badge variant={toneVariant(mode.tone)} dot>{mode.label}</Badge>
                    {(rollout.state === 'active' || rollout.state === 'paused') && (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          const on = rollout.autoAdvance !== true;
                          if (on && !window.confirm(
                            'Wellen automatisch weiterschalten?\n\nEs ändert sich NUR, wer '
                              + '„Nächste Welle" drückt: dasselbe Bake-Kriterium (24 h gesund '
                              + 'und ein echter Steuerzyklus), derselbe automatische Halt bei '
                              + 'jedem Fehlschlag, derselbe endgültige Not-Aus.',
                          )) {
                            return;
                          }
                          void act(() => adminApi.setAutoAdvance(rollout.id, on));
                        }}
                      >
                        {rollout.autoAdvance ? 'Auf Hand-Vorschub umstellen'
                          : 'Automatisch weiterschalten'}
                      </Button>
                    )}
                  </div>
                )}
                {mode?.note && (
                  <p className="vp-muted vp-text-sm" data-testid="advance-note">{mode.note}</p>
                )}
                {/* WARUM der Knopf gesperrt ist - ein deaktivierter Knopf ohne
                    Begründung ist eine Sackgasse. */}
                {hint && (
                  <p className="vp-muted vp-text-sm" data-testid="promote-hint">
                    {hint}
                  </p>
                )}
              </>
            )}
          </Card>

          {/* ── 3. Flotten-Matrix ───────────────────────────────────────── */}
          <Card padding="lg" radius="lg" style={{ marginBottom: 'var(--vp-space-6)' }}>
            <h3 style={{ marginTop: 0 }}>Flotten-Matrix</h3>
            {/* Der TOFU-Abschluss-Stand der Flotte: eine offene Aufgabe, kein
                Alarm - deshalb eine ruhige Zeile und kein Warn-Banner. */}
            {crossover && (
              <p className="vp-muted vp-text-sm" data-testid="crossover-hint">{crossover}</p>
            )}
            {fleet.length === 0 ? (
              <EmptyState title="Keine Geräte" description="Es ist kein Gerät verbunden." />
            ) : (
              <table className="vp-table responsive" data-testid="fleet">
                <thead>
                  <tr>
                    <th>Anlage</th>
                    <th>Mandant</th>
                    <th>Ist</th>
                    <th>Soll</th>
                    <th>Zustand</th>
                    <th>Vertrauen</th>
                    <th>seit</th>
                    <th>Grund</th>
                  </tr>
                </thead>
                <tbody>
                  {fleet.map((row) => (
                    <FleetTableRow
                      key={row.deviceId}
                      row={row}
                      onOpen={() => setDeviceFor(row.deviceId)}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          {/* ── 4. Verlauf ──────────────────────────────────────────────── */}
          <Card padding="lg" radius="lg">
            <h3 style={{ marginTop: 0 }}>Verlauf</h3>
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
          </Card>
        </>
      )}

      {deviceFor && data && (() => {
        const row = data.fleet.find((r) => r.deviceId === deviceFor);
        if (!row) return null;
        return (
          <DeviceTargetDrawer
            row={row}
            releases={data.releases}
            journal={data.journal}
            busy={busy}
            onClose={() => setDeviceFor(null)}
            onAssign={async (releaseSeq, channel, pinned) => {
              await act(() =>
                adminApi.setUpdateTarget(row.deviceId, { releaseSeq, channel, pinned }),
              );
              setDeviceFor(null);
            }}
            onRevert={async () => {
              await act(() => adminApi.revertUpdateTarget(row.deviceId));
              setDeviceFor(null);
            }}
          />
        );
      })()}

      {rolloutFor && data && (
        <StartRolloutDrawer
          release={rolloutFor}
          fleet={data.fleet}
          onClose={() => setRolloutFor(null)}
          onStart={async (waves, channel, autoAdvance) => {
            await act(() =>
              adminApi.createRollout({
                releaseSeq: rolloutFor.releaseSeq,
                channel,
                waves,
                autoAdvance,
              }),
            );
            setRolloutFor(null);
          }}
        />
      )}
    </>
  );
}

function FleetTableRow({ row, onOpen }: { row: FleetRow; onOpen: () => void }) {
  const st = stateLabel(row.state);
  const cross = crossoverState(row.trust);
  return (
    <tr className="vp-row-click" onClick={onOpen} title="Zuweisung dieses Geräts">
      <td data-label="Anlage">
        {row.siteName}
        {row.pinned && (
          <>
            {' '}
            <Badge variant="off">festgenagelt</Badge>
          </>
        )}
      </td>
      <td data-label="Mandant" className="vp-muted">
        {row.tenantName}
      </td>
      {/* Der gemeldete Stempel VERBATIM - „–" heißt unbekannt, nie veraltet. */}
      <td data-label="Ist">{row.ist ?? '–'}</td>
      <td data-label="Soll">{row.soll ?? '–'}</td>
      <td data-label="Zustand">
        <Badge variant={toneVariant(st.tone)} dot>
          {st.label}
        </Badge>
      </td>
      {/* OTA Stufe 4: trägt diese Box schon ein schlüsseltragendes Image?
          „unbekannt" ist hier ruhig und heißt NIE „nicht gekreuzt". */}
      <td data-label="Vertrauen">
        <Badge variant={toneVariant(cross.tone)} dot title={cross.detail ?? undefined}>
          {cross.label}
        </Badge>
      </td>
      <td data-label="seit" className="vp-muted">
        {row.since ? fmtRelative(row.since) : '–'}
      </td>
      <td data-label="Grund" className="vp-muted vp-text-sm">
        {row.reason ?? '–'}
      </td>
    </tr>
  );
}

/**
 * Die Zuweisung EINES Geräts (§7.1 „Geräte-Registry-Seite": Kanal + Pin +
 * „Jetzt aktualisieren" + die letzte Update-Historie).
 *
 * <p>Sie sitzt an der FLOTTEN-MATRIX, nicht an der Registry-Seite: die
 * Manufacturing-Registry kennt nur die Aufkleber-ID, eine Zuweisung braucht
 * aber die Geräte-Id - und die trägt genau diese Zeile.
 */
function DeviceTargetDrawer({
  row,
  releases,
  journal,
  busy,
  onClose,
  onAssign,
  onRevert,
}: {
  row: FleetRow;
  releases: EdgeUpdatesRelease[];
  journal: EdgeUpdates['journal'];
  busy: boolean;
  onClose: () => void;
  onAssign: (releaseSeq: number, channel: string, pinned: boolean) => Promise<void>;
  onRevert: () => Promise<void>;
}) {
  const signed = releases.filter((r) => r.signed);
  const [seq, setSeq] = useState<number | null>(row.sollSeq ?? signed[0]?.releaseSeq ?? null);
  const [channel, setChannel] = useState(row.channel ?? 'stable');
  const [pinned, setPinned] = useState(row.pinned);
  const history = journal.filter((e) => e.deviceId === row.deviceId).slice(0, 10);

  return (
    <Drawer open title={row.siteName} onClose={onClose}>
      <p className="vp-muted">
        {row.tenantName} · {row.label}
      </p>
      <dl className="vp-kv-list">
        <dt>Ist</dt>
        <dd>{row.ist ?? '–'}</dd>
        <dt>Soll</dt>
        <dd>{row.soll ?? '–'}</dd>
        <dt>Zustand</dt>
        <dd>{stateLabel(row.state).label}</dd>
        {/* Die Vertrauens-Identität dieses Geräts (OTA Stufe 4): trägt es ein
            schlüsseltragendes Image, und WELCHES Vertrauens-Set fährt es? Das
            zweite ist der Blick, den ein Rotations-Drill je Box braucht. */}
        <dt>Vertrauen</dt>
        <dd>{crossoverState(row.trust).label}</dd>
        {row.trust && row.trust.trustSetKeyIds.length > 0 && (
          <>
            <dt>Vertrauens-Set</dt>
            <dd>
              {row.trust.trustSetKeyIds.join(', ')}
              {row.trust.trustSetGeneratedAt
                && ` (vom ${formatTrustStamp(row.trust.trustSetGeneratedAt)})`}
            </dd>
          </>
        )}
      </dl>
      {/* Der Grund steht IMMER dabei - „Crossover offen" ohne die Erklärung,
          dass das der dokumentierte Vor-TOFU-Zustand ist, läse sich wie ein
          Defekt. */}
      {crossoverState(row.trust).detail && (
        <p className="vp-muted vp-text-sm" data-testid="trust-detail">
          {crossoverState(row.trust).detail}
        </p>
      )}
      {row.reason && <p className="vp-muted vp-text-sm">{row.reason}</p>}

      {signed.length === 0 ? (
        <p className="vp-muted">
          Kein signiertes Release im Register – ohne signiertes Manifest hat ein Gerät nichts,
          was es gegen seinen Vertrauensanker prüfen könnte.
        </p>
      ) : (
        <>
          <label className="vp-field-row">
            <span>Release</span>
            <select
              value={seq ?? ''}
              onChange={(e) => setSeq(Number(e.target.value))}
              aria-label="Release"
            >
              {signed.map((r) => (
                <option key={r.releaseSeq} value={r.releaseSeq}>
                  {r.version}
                </option>
              ))}
            </select>
          </label>
          <label className="vp-field-row">
            <span>Kanal</span>
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              aria-label="Kanal"
            >
              <option value="stable">stable</option>
              <option value="canary">canary</option>
            </select>
          </label>
          <label className="vp-check-row">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(e) => setPinned(e.target.checked)}
            />{' '}
            Festnageln – ein Rollout überschreibt dieses Gerät dann nicht, sondern
            überspringt es sichtbar.
          </label>
          <div className="vp-row-gap">
            <Button
              variant="primary"
              disabled={busy || seq == null}
              onClick={() => void onAssign(seq as number, channel, pinned)}
            >
              Jetzt aktualisieren
            </Button>
            {row.soll && (
              <Button variant="outline" disabled={busy} onClick={() => void onRevert()}>
                Zuweisung zurücknehmen
              </Button>
            )}
          </div>
        </>
      )}

      <h4>Update-Historie</h4>
      {history.length === 0 ? (
        <p className="vp-muted vp-text-sm">Für dieses Gerät ist noch nichts passiert.</p>
      ) : (
        <ul className="vp-plain-list">
          {history.map((e) => (
            <li key={e.id} className="vp-text-sm">
              <span className="vp-muted">{fmtWhen(e.at)}</span> · {actorLabel(e.actor)} ·{' '}
              {eventLabel(e.event)}
              {e.detail ? ` – ${e.detail}` : ''}
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}

/**
 * Die Wellen werden von HAND geschnitten (D4: hand-advanced ist bei ≤10
 * Geräten richtig) - wer die Wellen schneidet, trifft eine Entscheidung, die
 * niemand raten sollte. Deshalb: Canary auswählen, Rest bildet Welle 2.
 */
function StartRolloutDrawer({
  release,
  fleet,
  onClose,
  onStart,
}: {
  release: EdgeUpdatesRelease;
  fleet: FleetRow[];
  onClose: () => void;
  onStart: (
    waves: { name: string; devices: string[] }[],
    channel: string,
    autoAdvance: boolean,
  ) => Promise<void>;
}) {
  const [canary, setCanary] = useState<string[]>([]);
  // OTA Stufe 4: die Automatik ist eine OPTION und startet AUS - Hand-Vorschub
  // ist bei dieser Flottengröße die richtige Vorgabe (D4).
  const [autoAdvance, setAutoAdvance] = useState(false);
  const candidates = useMemo(() => sortFleet(fleet), [fleet]);
  const rest = candidates.filter((d) => !canary.includes(d.deviceId));

  const waves: { name: string; devices: string[] }[] = [];
  if (canary.length > 0) waves.push({ name: 'Canary', devices: canary });
  if (rest.length > 0) waves.push({ name: 'Flotte', devices: rest.map((d) => d.deviceId) });

  return (
    <Drawer open title={`Rollout ${release.version}`} onClose={onClose}>
      <p className="vp-muted">
        Welle 1 wird sofort zugewiesen, jede weitere erst nach Freigabe (24 Std. gesunder
        Betrieb und – wo VoltPilot steuert – ein bestätigter Steuerzyklus).
      </p>
      <p className="vp-muted vp-text-sm">
        Ein festgenageltes Gerät wird übersprungen, nicht überschrieben.
      </p>
      <fieldset style={{ border: 0, padding: 0 }}>
        <legend className="vp-text-sm" style={{ fontWeight: 600 }}>
          Welle 1 (Canary)
        </legend>
        {candidates.map((d) => (
          <label key={d.deviceId} className="vp-check-row">
            <input
              type="checkbox"
              checked={canary.includes(d.deviceId)}
              onChange={(e) =>
                setCanary((prev) =>
                  e.target.checked
                    ? [...prev, d.deviceId]
                    : prev.filter((id) => id !== d.deviceId),
                )
              }
            />{' '}
            {d.siteName} <span className="vp-muted">· {d.tenantName}</span>
          </label>
        ))}
      </fieldset>
      <p className="vp-muted vp-text-sm">
        {rest.length === 0
          ? 'Alle Geräte stehen in Welle 1.'
          : `Welle 2 „Flotte“: ${rest.length} Gerät${rest.length === 1 ? '' : 'e'}.`}
      </p>
      <label className="vp-check-row" style={{ marginTop: 'var(--vp-space-3)' }}>
        <input
          type="checkbox"
          checked={autoAdvance}
          onChange={(e) => setAutoAdvance(e.target.checked)}
        />{' '}
        Automatisch weiter, wenn das Bake-Kriterium erfüllt ist
      </label>
      <p className="vp-muted vp-text-sm">
        {autoAdvance
          ? 'Es ändert sich nur, WER „Nächste Welle“ drückt. Dasselbe Bake-Kriterium, '
            + 'derselbe automatische Halt bei jedem Fehlschlag, derselbe endgültige Not-Aus.'
          : 'Vorgabe: jede weitere Welle geben Sie von Hand frei. Umstellen geht auch '
            + 'später, während der Rollout läuft.'}
      </p>
      <Button
        variant="primary"
        disabled={waves.length === 0}
        onClick={() => void onStart(waves, canary.length > 0 ? 'canary' : 'stable', autoAdvance)}
      >
        Rollout starten
      </Button>
    </Drawer>
  );
}
