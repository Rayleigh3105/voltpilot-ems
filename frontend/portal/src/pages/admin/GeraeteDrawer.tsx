import { useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Drawer } from '../../../designsystem/components/shell/Drawer';
import { deviceKindLabel, fmtRelative } from '../../format';
import { REGISTRY_AUFKLEBER, REGISTRY_SELBST } from '../../adminGeraet';
import { geraetHash } from '../../nav';
import { versionLabel } from '../../onboardingFunnel';
import {
  actorLabel,
  applyView,
  blockerLever,
  crossoverState,
  eventLabel,
  formatTrustStamp,
  stateLabel,
  type DeviceApply,
  type EdgeUpdatesRelease,
  type JournalEntry,
} from '../../adminEdgeUpdates';

/**
 * Was der Drawer über EIN Gerät braucht - bewusst ein eigener, schmaler Typ
 * statt eines der beiden Server-DTOs.
 *
 * Der Drawer wird von ZWEI Seiten geöffnet (Geräte-Inventar und Wellen-Board),
 * deren Zeilen verschiedene Server-Aggregate sind. Ein gemeinsamer Eingabe-Typ
 * ist die Stelle, an der beide sich treffen - ohne ihn wäre der Drawer entweder
 * dupliziert (zwei Wahrheiten über dasselbe Gerät) oder an eines der beiden
 * Aggregate gefesselt.
 */
export interface DrawerDevice {
  deviceId: string | null;
  externalRef: string;
  label: string | null;
  siteName: string | null;
  tenantName: string | null;
  kind?: string | null;
  ist: string | null;
  soll: string | null;
  sollSeq: number | null;
  channel: string | null;
  pinned: boolean;
  state: string | null;
  reason: string | null;
  blocker?: string | null;
  /**
   * Wann das Gerät den GEZEIGTEN Ist-Stand gemeldet hat (`device_update_status.reported_at`) -
   * unabhängig davon, ob dieser Ist dem Soll entspricht. `undefined`/`null` heißt „noch nie
   * gemeldet" (Fahrplan-Update-Betreff, nicht die Telemetrie-Lebendigkeit von `lastSeenAt`).
   */
  reportedAt?: string | null;
  lastSeenAt?: string | null;
  provisioned?: boolean;
  note?: string | null;
  trust?: Parameters<typeof crossoverState>[0];
  apply?: DeviceApply | null;
}

/**
 * Der EINE Geräte-Drawer (UX-Konzept `vp-admin-geraete-ux-k2` §4, E1).
 *
 * <b>Er kehrt an die Stelle zurück, die der OTA-Scout §7.1 vorgesehen hatte.</b>
 * Die Implementierung war seinerzeit auf die Flotten-Matrix der Update-Seite
 * ausgewichen, weil die Registry-Zeile keine Geräte-Id trägt - und damit war
 * ein Gerät über drei Teil-Wahrheiten verstreut (Registry: der Aufkleber,
 * Matrix: das Update, Puls: die Anlage). Seit der Geräte-Read die beiden
 * Hälften vereinigt, gibt es EINEN Ort, und beide Seiten öffnen DENSELBEN
 * Drawer - eine zweite Fassung wäre eine zweite Wahrheit über dasselbe Gerät.
 *
 * Schreiben kann er nur, was ihm der Aufrufer erlaubt: ohne `onAssign` ist er
 * eine reine Ansicht (eine gedruckte, noch nicht verbundene ID hat nichts, dem
 * man etwas zuweisen könnte).
 */
export function GeraeteDrawer({
  device,
  releases,
  journal,
  busy,
  onClose,
  onAssign,
  onRevert,
  onApply,
}: {
  device: DrawerDevice;
  releases: EdgeUpdatesRelease[];
  journal: JournalEntry[];
  busy: boolean;
  onClose: () => void;
  onAssign?: (releaseSeq: number, channel: string, pinned: boolean) => Promise<void>;
  onRevert?: () => Promise<void>;
  /**
   * Die EINMALIGE Freigabe zum Anwenden. Ohne diesen Aufrufer rendert der
   * Knopf gar nicht - eine Fläche, die eine Handlung anbietet, die ihr Host
   * nicht ausführen kann, ist eine Attrappe.
   */
  onApply?: () => Promise<void>;
}) {
  const signed = releases.filter((r) => r.signed);
  const [seq, setSeq] = useState<number | null>(device.sollSeq ?? signed[0]?.releaseSeq ?? null);
  const [channel, setChannel] = useState(device.channel ?? 'stable');
  const [pinned, setPinned] = useState(device.pinned);
  const history = device.deviceId
    ? journal.filter((e) => e.deviceId === device.deviceId).slice(0, 10)
    : [];
  const cross = crossoverState(device.trust);
  const lever = blockerLever(device.blocker);
  const connected = device.deviceId != null;
  const apply = applyView(device);

  return (
    <Drawer open title={device.siteName ?? device.label ?? device.externalRef} onClose={onClose}>
      <p className="vp-muted">
        {[device.tenantName, device.externalRef].filter(Boolean).join(' · ')}
      </p>

      {/* Admin-Umbau Stufe 2: der Drawer bleibt der SCHNELLBLICK (mitten im
          Rollout will niemand die Fläche verlieren) - die Vollansicht mit
          Steuerung, Grenzen, Quellen und Anlagen-Kontext ist einen Klick
          entfernt und adressierbar. */}
      <p className="vp-text-sm">
        <a className="vp-linklike" href={geraetHash(device.externalRef)}>
          Geräteseite öffnen →
        </a>
      </p>

      <h4>Identität</h4>
      <dl className="vp-kv-list">
        <dt>Referenz</dt>
        <dd className="vp-mono">{device.externalRef}</dd>
        {device.kind && (
          <>
            <dt>Typ</dt>
            <dd>{deviceKindLabel(device.kind)}</dd>
          </>
        )}
        <dt>Registry</dt>
        <dd>
          {/* Eine `edge-`Referenz läuft per Konstruktion an der
              Aufkleber-Registry vorbei - das ist der Normalfall der
              Bestandsflotte und ausdrücklich kein Mangel. */}
          {device.provisioned === false ? REGISTRY_SELBST : REGISTRY_AUFKLEBER}
        </dd>
        {device.note && (
          <>
            <dt>Notiz</dt>
            <dd>{device.note}</dd>
          </>
        )}
        {device.lastSeenAt !== undefined && (
          <>
            <dt>Zuletzt gemeldet</dt>
            <dd>{device.lastSeenAt ? fmtRelative(device.lastSeenAt) : 'noch nie'}</dd>
          </>
        )}
      </dl>

      {connected ? (
        <>
          <h4>Stand</h4>
          <dl className="vp-kv-list">
            {/* Tag + Build getrennt: `edge-2026.08.0-3bf8c038e1d2` neben
                `edge-2026.08.0` sind zwei verschieden AUSSEHENDE Zeichenketten
                für dieselbe Frage. */}
            <dt>Ist</dt>
            <dd>{versionLabel(device.ist, releases)}</dd>
            <dt>Ist gemeldet</dt>
            <dd>{device.reportedAt ? fmtRelative(device.reportedAt) : 'noch nie'}</dd>
            <dt>Soll</dt>
            <dd>{device.soll ? versionLabel(device.soll, releases) : '–'}</dd>
            <dt>Zustand</dt>
            <dd>
              <span className={`vp-ustate vp-ustate-${stateLabel(device.state).cls}`}>
                <i className="vp-ustate-dot" aria-hidden="true" />
                {stateLabel(device.state).label}
              </span>
            </dd>
            <dt>Kanal</dt>
            <dd>
              {device.channel ?? '–'}
              {device.pinned && (
                <>
                  {' '}
                  <Badge variant="off">festgenagelt</Badge>
                </>
              )}
            </dd>
            <dt>Vertrauen</dt>
            <dd>{cross.label}</dd>
            {device.trust && device.trust.trustSetKeyIds.length > 0 && (
              <>
                <dt>Vertrauens-Set</dt>
                <dd>
                  {device.trust.trustSetKeyIds.join(', ')}
                  {device.trust.trustSetGeneratedAt
                    && ` (vom ${formatTrustStamp(device.trust.trustSetGeneratedAt)})`}
                </dd>
              </>
            )}
          </dl>
          {/* Der Grund steht IMMER dabei - „Crossover offen" ohne die
              Erklärung, dass das der dokumentierte Vor-TOFU-Zustand ist, läse
              sich wie ein Defekt. */}
          {cross.detail && (
            <p className="vp-muted vp-text-sm" data-testid="trust-detail">{cross.detail}</p>
          )}
          {device.reason && <p className="vp-muted vp-text-sm">{device.reason}</p>}
          {/* Die eindeutige Soll==Ist-Aussage: nur der Server-Zustand `bestaetigt`
              behauptet die Gleichheit (gemeldeter Ist entspricht dem Soll,
              releaseIsRunning-Präfixregel), also wird hier keine zweite
              Bewertung vorgenommen - nur der Zeitpunkt ergänzt. */}
          {device.state === 'bestaetigt' && (
            <p className="vp-text-sm" data-testid="drawer-confirmed">
              Ist entspricht dem Soll
              {device.reportedAt ? ` – bestätigt ${fmtRelative(device.reportedAt)}.` : '.'}
            </p>
          )}
          {lever && (
            <p className="vp-text-sm vp-lever" data-testid="drawer-lever">Hebel: {lever}</p>
          )}
          {/* Der Zustand einer schon ERTEILTEN Freigabe - er steht NEBEN dem
              Geräte-Zustand, weil beide verschiedene Fragen beantworten. */}
          {apply.approval && (
            <p className="vp-text-sm" data-testid="drawer-approval">
              <Badge variant={apply.approval.tone === 'busy' ? 'warn' : apply.approval.tone}>
                {apply.approval.label}
              </Badge>
              {apply.approval.reason ? ` ${apply.approval.reason}` : ''}
            </p>
          )}
          {onApply && connected && (
            <div className="vp-apply-block" data-testid="drawer-apply">
              {/* Was die Anwendung verhindern WIRD, steht VOR dem Knopf - eine
                  Verweigerung danach wäre ein Rätsel. */}
              {apply.warn && (
                <p className="vp-text-sm vp-lever" data-testid="drawer-apply-warn">
                  Achtung: {apply.warn}
                </p>
              )}
              {apply.hint && (
                <p className="vp-muted vp-text-sm" data-testid="drawer-apply-hint">
                  {apply.hint}
                </p>
              )}
              <Button
                variant="outline"
                disabled={busy || !apply.canClick}
                onClick={() => void onApply()}
              >
                {apply.label}
              </Button>
            </div>
          )}
        </>
      ) : (
        <p className="vp-muted">
          Diese Geräte-ID ist registriert, aber noch mit keinem Kundenkonto verbunden. Ein
          Release lässt sich erst zuweisen, wenn ein Kunde sie verbunden hat.
        </p>
      )}

      {connected && onAssign && (
        signed.length === 0 ? (
          <p className="vp-muted">
            Kein signiertes Release im Register – ohne signiertes Manifest hat ein Gerät nichts,
            was es gegen seinen Vertrauensanker prüfen könnte.
          </p>
        ) : (
          <>
            <h4>Release zuweisen</h4>
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
              {/* „Release zuweisen", nicht „Jetzt aktualisieren": der Knopf
                  veröffentlicht eine Zuweisung - das ANWENDEN bleibt
                  beaufsichtigt am Gerät. */}
              <Button
                variant="primary"
                disabled={busy || seq == null}
                onClick={() => void onAssign(seq as number, channel, pinned)}
              >
                Release zuweisen
              </Button>
              {device.soll && onRevert && (
                <Button variant="outline" disabled={busy} onClick={() => void onRevert()}>
                  Zuweisung zurücknehmen
                </Button>
              )}
            </div>
          </>
        )
      )}

      {connected && (
        <>
          <h4>Update-Historie</h4>
          {history.length === 0 ? (
            <p className="vp-muted vp-text-sm">Für dieses Gerät ist noch nichts passiert.</p>
          ) : (
            <ul className="vp-plain-list">
              {history.map((e) => (
                <li key={e.id} className="vp-text-sm">
                  <span className="vp-muted">
                    {new Date(e.at).toLocaleString('de-DE', {
                      dateStyle: 'short', timeStyle: 'short',
                    })}
                  </span>{' '}
                  · {actorLabel(e.actor)} · {eventLabel(e.event)}
                  {e.detail ? ` – ${e.detail}` : ''}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Drawer>
  );
}
