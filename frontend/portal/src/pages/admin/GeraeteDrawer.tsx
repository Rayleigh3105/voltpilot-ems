import { useState } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import { Drawer } from '../../../designsystem/components/shell/Drawer';
import { VpPicker } from '../../components/VpPicker';
import { deviceKindLabel, fmtRelative } from '../../format';
import { REGISTRY_AUFKLEBER, REGISTRY_SELBST } from '../../adminGeraet';
import { versionLabel } from '../../onboardingFunnel';
import {
  actorLabel,
  blockerLever,
  crossoverState,
  eventLabel,
  formatTrustStamp,
  stateLabel,
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
  onOpenGeraetseite,
}: {
  device: DrawerDevice;
  releases: EdgeUpdatesRelease[];
  journal: JournalEntry[];
  busy: boolean;
  onClose: () => void;
  onAssign?: (releaseSeq: number) => Promise<void>;
  onRevert?: () => Promise<void>;
  /**
   * Der Weg auf die EINE Geräteseite (Anlagen-Zentrale Stufe 3, PR 3b). Sie
   * liegt hinter dem RLS-Zaun in der Mandanten-Ansicht, der Drawer kann sie
   * also nicht selbst adressieren - der Wirt kennt Mandant und Anlage und
   * schaltet um. Ohne Aufrufer (gedruckte ID ohne Gerät) wird der Weg gar
   * nicht angeboten, statt ins Leere zu führen.
   */
  onOpenGeraetseite?: () => void;
}) {
  const signed = releases.filter((r) => r.signed);
  const [seq, setSeq] = useState<number | null>(device.sollSeq ?? signed[0]?.releaseSeq ?? null);
  const history = device.deviceId
    ? journal.filter((e) => e.deviceId === device.deviceId).slice(0, 10)
    : [];
  const cross = crossoverState(device.trust);
  const lever = blockerLever(device.blocker);
  const connected = device.deviceId != null;

  return (
    <Drawer open title={device.siteName ?? device.label ?? device.externalRef} onClose={onClose}>
      <p className="vp-muted">
        {[device.tenantName, device.externalRef].filter(Boolean).join(' · ')}
      </p>

      {/* Der Drawer bleibt der SCHNELLBLICK (mitten im Rollout will niemand
          die Fläche verlieren) - die Vollansicht mit Steuerung, Grenzen,
          Quellen und Anlagen-Kontext ist einen Klick entfernt. Seit Stufe 3
          zielt er auf die EINE Geräteseite in der Mandanten-Ansicht. */}
      {onOpenGeraetseite && (
        <p className="vp-text-sm">
          <button type="button" className="vp-linklike" onClick={onOpenGeraetseite}>
            Geräteseite öffnen →
          </button>
        </p>
      )}

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
            <h4>Aktualisieren</h4>
            <p className="vp-muted vp-text-sm">
              Ein Klick genügt: das Gerät holt die Images und tauscht sich selbst aus.
              Niemand muss an das Gerät.
            </p>
            <VpPicker
              label="Release"
              options={signed.map((r) => ({
                value: String(r.releaseSeq),
                label: r.version,
              }))}
              value={seq == null ? '' : String(seq)}
              onChange={(v) => setSeq(Number(v))}
            />
            <div className="vp-row-gap">
              {/* Seit dem Ein-Schritt-Umbau ist der Knopf die GANZE Handlung:
                  die Zuweisung geht retained hinaus, das Gerät wendet sie
                  selbst an. Es gibt keinen zweiten Schritt am Gerät. */}
              <Button
                variant="primary"
                disabled={busy || seq == null}
                onClick={() => void onAssign(seq as number)}
              >
                Aktualisieren
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
