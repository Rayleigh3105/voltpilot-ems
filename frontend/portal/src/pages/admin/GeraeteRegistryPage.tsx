import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { IconTile } from '../../../designsystem/components/core/IconTile';
import { Input } from '../../../designsystem/components/forms/Input';
import { Modal } from '../../../designsystem/components/shell/Modal';
import { VpPicker } from '../../components/VpPicker';
import { ApiError } from '../../api';
import {
  adminApi,
  type AdminDeviceRow,
  type PendingEnrollment,
} from '../../admin/adminApi';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState, ErrorState, TableSkeleton } from '../../components/States';
import { Blende } from '../../components/Lazy';
import { AdminPageHead } from './AdminPageHead';
import { normalizeDeviceIdInput } from '../../anlageFlow';
import { fmtRelative } from '../../format';
import { deviceRows, pendingRows, versionLabel } from '../../onboardingFunnel';
import {
  crossoverState,
  stateLabel,
  type EdgeUpdates,
} from '../../adminEdgeUpdates';
import { geraetLinkAusgang } from '../../adminGeraet';
import { parseGeraetRef, type Route } from '../../nav';
import { replaceCurrentNavigation } from '../../navigationBlocker';
import './BoxVersions.css';

/** Registration is secondary to the version overview. Unclaimed enrollments
 * remain available as a collapsed support detail below the inventory. */
export function GeraeteRegistryPage({
  onJumpToTenant,
  tabs,
}: {
  /** Sprung in die Mandanten-Ansicht der Anlage (bzw. auf ihre Befehle). */
  onJumpToTenant?: (tenantId: string, target: Route) => void;
  /** Die Tab-Leiste des Geräte-Bereichs, vom Wirt `GeraeteBereich`. */
  tabs?: ReactNode;
} = {}) {
  const [fleet, setFleet] = useState<AdminDeviceRow[] | null>(null);
  // Die Deep-Link-Referenz (`?geraet=<referenz>`). Sie ist der Zustand: ein
  // Lesezeichen darauf führt exakt dorthin, wohin es immer geführt hat - seit
  // Stufe 3 auf die EINE Geräteseite, statt auf eine zweite Vollansicht.
  const [geraetRef, setGeraetRef] = useState<string | null>(() =>
    parseGeraetRef(window.location.hash),
  );
  // Releases für die Spalte „Edge-Stand" (Tag + Build statt Roh-Stempel).
  // FAIL-SOFT in einem EIGENEN Zustand: fällt der Abruf aus, bleibt das
  // Inventar benutzbar, die Spalte zeigt dann eben den Roh-Stempel.
  const [updates, setUpdates] = useState<EdgeUpdates | null>(null);
  const [pending, setPending] = useState<PendingEnrollment[] | null>(null);
  // Getrennt von `pending === null` (= lädt noch), damit ein Fehlschlag als
  // Fehlschlag steht und nie als "niemand wartet" gelesen wird.
  const [pendingFailed, setPendingFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Load failure kept distinct from action errors (and from the loading `null`)
  // so a failed load shows a retryable ErrorState, not a permanent skeleton.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  // Der Sprung-Rückruf, stabil gehalten für den Weiterleitungs-Effekt unten.
  const jumpRef = useRef(onJumpToTenant);
  jumpRef.current = onJumpToTenant;

  async function reload() {
    setError(null);
    setLoadError(null);
    const [inventory, releases, enrollments] = await Promise.allSettled([
      adminApi.listDevices(), adminApi.edgeUpdates(), adminApi.listPendingEnrollments(),
    ]);
    if (inventory.status === 'fulfilled') setFleet(inventory.value);
    else setLoadError('Das Geräte-Inventar ist gerade nicht abrufbar. Bitte erneut versuchen.');
    setUpdates(releases.status === 'fulfilled' ? releases.value : null);
    setPending(enrollments.status === 'fulfilled' ? enrollments.value : null);
    setPendingFailed(enrollments.status === 'rejected');
    setLoading(false);
  }

  // Auch hier die Folgenliste des Hauses statt des nativen Ein-Satz-Dialogs:
  // das Entfernen macht eine gedruckte Aufkleber-ID unbrauchbar.
  async function remove(externalRef: string) {
    setError(null);
    try {
      await adminApi.deleteProvisionedDevice(externalRef);
      await reload();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? `„${externalRef}“ ist bereits mit einem Kundenkonto verbunden und kann nicht entfernt werden. Der Kunde (oder Sie über die Mandanten-Ansicht) muss das Gerät zuerst entfernen.`
          : e instanceof ApiError
            ? `Entfernen fehlgeschlagen: ${e.message}`
            : 'Entfernen fehlgeschlagen. Bitte versuchen Sie es erneut.',
      );
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  // Die Adresse ist der Zustand: ein Deep-Link, ein Klick auf den Nav-Punkt
  // (der den Parameter abräumt) und ein von Hand editierter Hash führen alle
  // durch DIESELBE Stelle.
  useEffect(() => {
    const onHash = () => setGeraetRef(parseGeraetRef(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  /**
   * Eine Zeile öffnet ihr Gerät - und zwar an seinem EINEN Ort, der
   * Geräteseite in der Mandanten-Ansicht (Stufe 3, PR 3b). Sie setzt dafür
   * denselben Zustand, den ein Lesezeichen setzt, damit Klick und Deep-Link
   * durch GENAU DIESELBE Stelle laufen und nie auseinanderdriften können.
   */
  function oeffneGeraet(ref: string | null) {
    setGeraetRef(ref);
    if (ref == null) {
      // Nur den Parameter abräumen - ein Verlaufseintrag je Klick wäre die
      // Zurück-Taste voller Zwischenschritte (die `?m=`-Disziplin).
      replaceCurrentNavigation('#/geraete-registry');
    }
  }

  const registerButton = (
    <Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setAddOpen(true)}>
      Geräte-ID registrieren
    </Button>
  );

  /**
   * Anlagen-Zentrale Stufe 3 (PR 3b): ein VERBUNDENES Gerät hat GENAU EINEN
   * Ort - seine Geräteseite in der Mandanten-Ansicht. Die Plattform-Liste ist
   * der Einstieg und FÜHRT dorthin; die frühere zweite Vollansicht desselben
   * Geräts ist entfallen. Eine gedruckte, noch nicht verbundene Aufkleber-ID
   * hat keine Geräteseite (sie ist noch kein Gerät) und bleibt Zeile mit
   * einem ehrlichen Satz darüber.
   */
  const ausgang = geraetRef ? geraetLinkAusgang(fleet, geraetRef) : null;
  const ziel = ausgang?.kind === 'weiterleiten' ? ausgang : null;
  // ⚠ Solange das Inventar noch lädt (`fleet == null`), wird NICHT geurteilt:
  // eine Referenz „nicht gefunden" zu nennen, bevor irgendetwas geladen ist,
  // wäre eine Behauptung über Daten, die niemand gesehen hat.
  const hinweis = fleet != null && ausgang?.kind === 'hinweis' ? ausgang.text : null;
  useEffect(() => {
    if (!ziel) return;
    jumpRef.current?.(ziel.tenantId, {
      page: 'anlagen',
      siteId: ziel.siteId,
      sub: 'geraet',
      geraet: { ref: ziel.ref, geraetId: null },
    });
    // Der Sprung-Rückruf liegt in einer Ref: ein Wirt, der ihn inline erzeugt,
    // würde den Effekt sonst bei JEDEM Render neu auslösen.
  }, [ziel?.tenantId, ziel?.siteId, ziel?.ref]);

  return (
    <>
      {tabs}
      <AdminPageHead
        icon="cpu"
        category="primary"
        title="Geräte registrieren"
        description="Geräte-IDs registrieren und die Zuordnung zu Kundenkonten prüfen."
        actions={registerButton}
      />

      {error && <div className="vp-alert vp-alert-err">{error}</div>}

      {/* Eine `?geraet=`-Adresse, die zu keiner Geräteseite führt, sagt WARUM -
          statt eine Seite voller „—" zu zeigen (Stufe 3, PR 3b). */}
      {hinweis && (
        <div className="vp-alert" role="status" data-testid="geraet-hinweis">
          {hinweis}{' '}
          <button type="button" className="vp-linklike" onClick={() => oeffneGeraet(null)}>
            Zur Geräte-Liste
          </button>
        </div>
      )}

      {loadError ? (
        <ErrorState message={loadError} onRetry={() => void reload()} />
      ) : (
        /* Bewegung P6: das Skelett blendet in den Inhalt über, im reservierten
           Rahmen — die Tabelle bestimmt vom ersten Frame an die Höhe, das
           Skelett verblasst darüber (`Blende`, `src/components/Lazy.tsx`). */
        <Blende
          laedt={loading}
          skelett={
            <Card style={{ padding: 0, overflow: 'hidden' }}>
              <TableSkeleton rows={4} cols={6} />
            </Card>
          }
        >
          <DeviceInventory
            fleet={fleet}
            releases={updates?.releases ?? []}
            onOpen={oeffneGeraet}
            onRemove={setRemoving}
            registerButton={registerButton}
          />
        </Blende>
      )}

      <PendingEnrollments rows={pending} failed={pendingFailed} onRetry={() => void reload()} />

      {removing && (
        <ConfirmDialog
          open
          tone="danger"
          title="Geräte-ID entfernen?"
          intro={`Die Aufkleber-ID „${removing}" wird aus der Registry gelöscht.`}
          consequences={[
            'Kein Kunde kann diese ID danach mehr verbinden - ein Versuch wird abgewiesen.',
            'Die gedruckte ID auf dem Gerät bleibt bestehen; sie ist dann unbrauchbar, bis '
              + 'sie erneut registriert wird.',
            'Erneut registrieren geht jederzeit - die Löschung ist also umkehrbar.',
          ]}
          confirmLabel="Geräte-ID entfernen"
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const ref = removing;
            setRemoving(null);
            void remove(ref);
          }}
        />
      )}

      <ProvisionDeviceDrawer
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={() => void reload()}
      />
    </>
  );
}

/**
 * **EINE Tabelle über alle Geräte** (UX-Konzept §4): gedruckte Aufkleber-IDs
 * und die verbundene Flotte, verbunden über die Referenz.
 *
 * Der behobene Befund: die Vorgänger-Tabelle listete ausschließlich
 * `VP-`Aufkleber-IDs. Die realen Bestandsboxen sind über selbst generierte
 * `edge-`Referenzen verbunden und tauchten hier mit NULL Zeilen auf — wer
 * „meine Geräte" suchte, fand sie nur als Nebenspalten anderer Seiten.
 *
 * Eine Zeile ist anklickbar, sobald es etwas zu zeigen gibt; das „Entfernen"
 * bleibt an der gedruckten, unverbundenen ID (nur sie darf aus der Registry).
 */
function DeviceInventory({
  fleet,
  releases,
  onOpen,
  onRemove,
  registerButton,
}: {
  fleet: AdminDeviceRow[] | null;
  releases: { version: string }[];
  onOpen: (ref: string) => void;
  onRemove: (externalRef: string) => void;
  registerButton: React.ReactNode;
}) {
  // ⚠ Ohne Inventar (älteres Backend, 404) wird die Registry NICHT als Ersatz
  // gerendert: eine beanspruchte Aufkleber-ID hat dort zwar `claimed`, aber
  // keine Geräte-Id - jede Zeile läse sich als „noch nicht verbunden", und das
  // wäre für genau die verbundenen Geräte eine sichtbare Lüge. Ein Fehlschlag
  // ist keine Datenlage (die `pending`-Disziplin): die Fläche sagt, dass sie
  // nichts weiß.
  if (fleet == null) {
    return (
      <Card padding="lg" radius="lg">
        <EmptyState
          icon="list"
          category="primary"
          title="Das Geräte-Inventar ist gerade nicht abrufbar"
          description="Die Liste aller Geräte konnte nicht geladen werden. Bitte erneut laden."
        />
      </Card>
    );
  }
  const rows = deviceRows(fleet);

  if (rows.length === 0) {
    return (
      <Card padding="lg" radius="lg">
        <EmptyState
          icon="list"
          category="primary"
          title="Noch kein Gerät"
          description="Registrieren Sie die erste Aufkleber-ID (Format VP-XXXX-XXXX), damit Kunden ihr Gerät verbinden können."
          action={registerButton}
        />
      </Card>
    );
  }

  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <div className="vp-admin-sec-head">
        <h2>Alle Geräte</h2>
        <p>
          Gedruckte Aufkleber-IDs und die verbundene Flotte. Eine Zeile öffnet das Gerät.
        </p>
      </div>
      <div className="vp-table-scroll">
        <table className="vp-table responsive" data-testid="devices">
          <thead>
            <tr>
              <th>Gerät</th>
              <th>Referenz</th>
              <th>Edge-Stand</th>
              <th>Vertrauen</th>
              <th aria-label="Aktionen" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const d = r.row;
              const connected = r.lifecycle === 'verbunden';
              const cross = crossoverState(d.trust);
              const st = stateLabel(d.state);

              return (
                <tr
                  key={r.key}
                  className={connected ? 'vp-row-click' : undefined}
                  onClick={connected ? () => onOpen(r.key) : undefined}
                  title={connected ? 'Gerät öffnen' : undefined}
                >
                  <td data-label="Gerät">
                    <span className="vp-cell-main">
                      <span>
                        {connected ? r.name : <span className="vp-muted">— noch nicht verbunden —</span>}
                      </span>
                      {r.context && <span className="vp-cell-sub">{r.context}</span>}
                    </span>
                  </td>
                  <td data-label="Referenz" className="vp-mono">{d.externalRef}</td>
                  <td data-label="Edge-Stand">
                    {connected ? (
                      <span className="vp-cell-main">
                        {/* Tag + Build getrennt statt Roh-Stempel. */}
                        <span>{versionLabel(d.ist, releases)}</span>
                        <span className="vp-cell-sub">
                          <span className={`vp-ustate vp-ustate-${st.cls}`}>
                            <i className="vp-ustate-dot" aria-hidden="true" />
                            {st.label}
                          </span>
                        </span>
                      </span>
                    ) : (
                      <span className="vp-muted">–</span>
                    )}
                  </td>
                  <td data-label="Vertrauen">
                    {connected ? (
                      <Badge variant={cross.tone === 'ok' ? 'ok' : cross.tone === 'warn' ? 'warn' : 'off'}
                             dot title={cross.detail ?? undefined}>
                        {cross.label}
                      </Badge>
                    ) : (
                      <span className="vp-muted">–</span>
                    )}
                  </td>
                  <td data-label="" style={{ textAlign: 'right' }}>
                    {/* Nur eine gedruckte, UNVERBUNDENE ID darf aus der
                        Registry - eine verbundene müsste der Kunde zuerst
                        trennen. Die Bedingung kommt aus der Zeile SELBST
                        (`provisioned`), nicht aus einer zweiten Liste: die
                        Vereinigung weiß es bereits. */}
                    {d.provisioned && !connected && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="vp-btn-danger"
                        iconLeft={<Icon name="trash" size={16} />}
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          onRemove(d.externalRef);
                        }}
                      >
                        Entfernen
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/**
 * Sektion „Wartet auf Zuordnung": Geräte, die sich gemeldet haben und auf
 * keinen Claim treffen. Read-only - von hier aus ist nichts zu klicken, weil
 * die Reparatur beim Kunden liegt (er tippt die richtige Referenz) bzw. beim
 * Support. Die Fläche macht den Zustand SICHTBAR, sie behauptet keine Lösung.
 */
function PendingEnrollments({
  rows,
  failed,
  onRetry,
}: {
  rows: PendingEnrollment[] | null;
  failed: boolean;
  onRetry: () => void;
}) {
  if (!failed && (rows == null || rows.length === 0)) return null;
  const list = pendingRows(rows ?? []);
  return (
    <Card className="vp-box-support">
      <details>
        <summary>
          {failed ? 'Zuordnung nicht abrufbar' : `${list.length} ${list.length === 1 ? 'Box ohne' : 'Boxen ohne'} Kundenkonto`}
          {' '}<small>· Support</small>
        </summary>
        {failed ? <ErrorState message="Die wartenden Geräte konnten nicht geladen werden." onRetry={onRetry} /> : <>
          <p className="vp-muted vp-text-sm">Diese Boxen haben sich gemeldet, sind aber noch keinem Kundenkonto zugeordnet. Bei Rückfragen die Referenz mit der im Kundenkonto verbundenen Box vergleichen.</p>
          <div className="vp-table-scroll">
            <table className="vp-table responsive">
              <thead><tr><th>Referenz</th><th>Geräte-Info</th><th>Meldet sich seit</th><th>Hinweis</th></tr></thead>
              <tbody>{list.map((r) => <tr key={r.externalRef}>
                <td data-label="Referenz" className="vp-mono">{r.externalRef}</td>
                <td data-label="Geräte-Info">{r.deviceInfo ?? '—'}</td>
                <td data-label="Meldet sich seit">{fmtRelative(r.csrUpdatedAt)}</td>
                <td data-label="Hinweis"><Badge variant={r.suspect ? 'warn' : 'off'} dot>{r.hint}</Badge></td>
              </tr>)}</tbody>
            </table>
          </div>
        </>}
      </details>
    </Card>
  );
}

function ProvisionDeviceDrawer({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [externalRef, setExternalRef] = useState('');
  const [kind, setKind] = useState('inverter');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = /^vp-/i.test(externalRef.trim());

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.provisionDevice({
        externalRef: externalRef.trim(),
        kind,
        note: note.trim() || undefined,
      });
      setExternalRef('');
      setNote('');
      onCreated();
      onClose();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 400
          ? 'Ungültige Geräte-ID. Sie muss mit VP- beginnen (Aufkleber-Format).'
          : 'Das Registrieren hat nicht geklappt. Bitte versuchen Sie es erneut.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Geräte-ID registrieren"
      icon={
        <IconTile category="primary" size={40}>
          <Icon name="zap" size={20} />
        </IconTile>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy || !valid}>
            {busy ? 'Registriere…' : 'Geräte-ID registrieren'}
          </Button>
        </>
      }
    >
      <p className="vp-note" style={{ marginTop: 0 }}>
        Die ID vom Geräte-Aufkleber (Format VP-XXXX-XXXX). Bereits registrierte IDs werden
        unverändert übernommen.
      </p>
      <div className="vp-form-stack">
        <Input
          label="Geräte-ID *"
          placeholder="z. B. VP-1234-ABCD"
          value={externalRef}
          autoComplete="off"
          spellCheck={false}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setExternalRef(normalizeDeviceIdInput(e.target.value))
          }
        />
        <VpPicker
          id="provision-kind"
          label="Typ"
          options={[
            { value: 'inverter', label: 'Wechselrichter' },
            { value: 'battery', label: 'Batteriespeicher' },
            { value: 'meter', label: 'Zähler' },
          ]}
          value={kind}
          onChange={setKind}
        />
        <Input
          label="Notiz"
          placeholder="z. B. Charge 2026-07"
          value={note}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNote(e.target.value)}
        />
      </div>
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
    </Modal>
  );
}
