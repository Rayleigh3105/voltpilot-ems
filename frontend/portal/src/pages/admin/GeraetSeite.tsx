import { useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { EmptyState } from '../../components/States';
import { actorLabel, eventLabel, type EdgeUpdatesRelease } from '../../adminEdgeUpdates';
import {
  NICHT_GEFUNDEN,
  type GeraetView,
  type Zeile,
} from '../../adminGeraet';
import type { Tone } from '../../adminFleet';
import { registerZugang } from '../../registerWrite';
import { RegisterWriteDrawer } from '../../components/RegisterWriteDrawer';

/**
 * Die GERÄTE-DETAILSEITE - der Anker des Admin-Umbaus (Stufe 2, Konzept
 * `data/vp-admin-neu-konzept-a9` §4, Captain-Entscheid F2).
 *
 * Sie RENDERT nur: jedes Urteil, jeder Satz und jede Ehrlichkeitsregel liegt
 * in der reinen `adminGeraet.ts`, die ihrerseits die bestehenden Ableitungen
 * wiederverwendet - die Seite erfindet keine zweite Wahrheit über ein Gerät.
 *
 * Der Drawer bleibt der SCHNELLBLICK am Wellen-Board (mitten im Rollout will
 * niemand die Fläche verlieren); diese Seite ist die Vollansicht und über
 * `?geraet=<referenz>` adressierbar.
 */
export function GeraetSeite({
  view,
  busy,
  onZurueck,
  onJumpToTenant,
  onNavigateSteuerung,
  onAssign,
  onRevert,
  onApply,
}: {
  /** `null` = die Referenz kommt in keinem Inventar vor. */
  view: GeraetView | null;
  busy: boolean;
  onZurueck: () => void;
  /** Sprung in die Mandanten-Ansicht dieser Anlage (bzw. auf ihre Befehle-Seite). */
  onJumpToTenant: (tenantId: string, siteId: string, sub?: 'befehle') => void;
  onNavigateSteuerung: () => void;
  onAssign?: (releaseSeq: number, channel: string, pinned: boolean) => Promise<void>;
  onRevert?: () => Promise<void>;
  onApply?: () => void;
}) {
  if (!view) {
    return (
      <>
        <Zurueck onZurueck={onZurueck} />
        <Card padding="lg" radius="lg">
          <EmptyState
            icon="search"
            category="primary"
            title="Gerät nicht gefunden"
            description={NICHT_GEFUNDEN}
            action={
              <Button variant="outline" onClick={onZurueck}>
                Zur Geräte-Liste
              </Button>
            }
          />
        </Card>
      </>
    );
  }

  const { kopf, software, vertrauen, steuerung, grenzen, verbindung, verlauf } = view;

  return (
    <>
      <Zurueck onZurueck={onZurueck} />

      {/* ── Kopf ────────────────────────────────────────────────────────── */}
      <Card padding="lg" radius="lg" className="vp-geraet-kopf">
        <div className="vp-geraet-ident">
          <h1>{kopf.name}</h1>
          <p className="vp-muted">
            <span className="vp-mono">{kopf.ref}</span>
            {kopf.typ ? ` · ${kopf.typ}` : ''}
            {kopf.kontext ? ` · ${kopf.kontext}` : ''}
          </p>
          <p className="vp-geraet-live">
            <Badge variant={badgeVariant(kopf.lebendigkeit.tone)} dot>
              {kopf.lebendigkeit.label}
            </Badge>{' '}
            <span className="vp-muted vp-text-sm">{kopf.lebendigkeit.detail}</span>
          </p>
        </div>
        {/* Ein Sprung, der strukturell nirgends hinführt, wird nicht
            angeboten - eine gedruckte, unverbundene ID hat keine Anlage. */}
        {kopf.sprungAnlage && (
          <div className="vp-row-gap vp-geraet-aktionen">
            <Button
              variant="outline"
              iconLeft={<Icon name="sun" size={18} />}
              onClick={() =>
                onJumpToTenant(kopf.sprungAnlage!.tenantId, kopf.sprungAnlage!.siteId)
              }
            >
              Zur Anlage (Mandanten-Ansicht)
            </Button>
            {kopf.sprungBefehle && (
              <Button
                variant="ghost"
                iconLeft={<Icon name="file-text" size={18} />}
                onClick={() =>
                  onJumpToTenant(
                    kopf.sprungBefehle!.tenantId,
                    kopf.sprungBefehle!.siteId,
                    'befehle',
                  )
                }
              >
                Befehle ansehen
              </Button>
            )}
          </div>
        )}
      </Card>

      <div className="vp-geraet-grid">
        {/* ── Software ──────────────────────────────────────────────────── */}
        <Sektion titel="Software" icon="refresh-cw">
          {software.verbunden ? (
            <>
              <Zeilen zeilen={software.zeilen} />
              {software.grund && (
                <p className="vp-muted vp-text-sm" data-testid="geraet-grund">
                  {software.grund}
                </p>
              )}
              {/* Der Hebel steht genau EINMAL: trägt der Anwenden-Block
                  gleich denselben Satz, gehört er dorthin, wo geklickt wird. */}
              {software.hebel && !(onApply && software.hebelDoppelt) && (
                <p className="vp-text-sm vp-lever" data-testid="geraet-hebel">
                  Hebel: {software.hebel}
                </p>
              )}
              {software.apply.approval && (
                <p className="vp-text-sm" data-testid="geraet-freigabe">
                  <Badge
                    variant={
                      software.apply.approval.tone === 'busy'
                        ? 'warn'
                        : software.apply.approval.tone
                    }
                  >
                    {software.apply.approval.label}
                  </Badge>
                  {software.apply.approval.reason ? ` ${software.apply.approval.reason}` : ''}
                </p>
              )}
              {onApply && (
                <div className="vp-apply-block" data-testid="geraet-apply">
                  {/* Was die Anwendung verhindern WIRD, steht VOR dem Knopf. */}
                  {software.apply.warn && (
                    <p className="vp-text-sm vp-lever">Achtung: {software.apply.warn}</p>
                  )}
                  {software.apply.hint && (
                    <p className="vp-muted vp-text-sm">{software.apply.hint}</p>
                  )}
                  <Button
                    variant="outline"
                    disabled={busy || !software.apply.canClick}
                    onClick={onApply}
                  >
                    {software.apply.label}
                  </Button>
                </div>
              )}
              {onAssign && (
                <ZuweisungsForm
                  releases={software.signierteReleases}
                  sollSeq={view.device.sollSeq}
                  channel={view.device.channel}
                  pinned={view.device.pinned}
                  hatSoll={view.device.soll != null}
                  busy={busy}
                  onAssign={onAssign}
                  onRevert={onRevert}
                />
              )}
            </>
          ) : (
            <p className="vp-muted">
              Diese Geräte-ID ist registriert, aber noch mit keinem Kundenkonto verbunden. Ein
              Release lässt sich erst zuweisen, wenn ein Kunde sie verbunden hat.
            </p>
          )}
        </Sektion>

        {/* ── Vertrauen ─────────────────────────────────────────────────── */}
        <Sektion titel="Vertrauen" icon="shield">
          <p data-testid="geraet-crossover">
            <Badge
              variant={vertrauen.tone === 'busy' ? 'warn' : vertrauen.tone}
              dot
            >
              {vertrauen.label}
            </Badge>
          </p>
          {/* Der Grund steht IMMER dabei - „Crossover offen" ohne die
              Erklärung, dass das der dokumentierte Vor-TOFU-Zustand ist, läse
              sich wie ein Defekt. */}
          {vertrauen.detail && <p className="vp-muted vp-text-sm">{vertrauen.detail}</p>}
          {vertrauen.trustSet.length > 0 && (
            <p className="vp-text-sm vp-mono">
              {vertrauen.trustSet.join(', ')}
              {vertrauen.trustSetStand ? ` (${vertrauen.trustSetStand})` : ''}
            </p>
          )}
        </Sektion>

        {/* ── Steuerung ─────────────────────────────────────────────────── */}
        <Sektion titel="Steuerung" icon="settings">
          {steuerung.leerGrund ? (
            <p className="vp-muted">{steuerung.leerGrund}</p>
          ) : (
            <>
              {steuerung.freigabe && (
                <p data-testid="geraet-cert">
                  <Badge variant={steuerung.freigabe.tone} dot>
                    {steuerung.freigabe.label}
                  </Badge>
                  {steuerung.freigabe.hint && (
                    <span className="vp-muted vp-text-sm"> {steuerung.freigabe.hint}</span>
                  )}
                </p>
              )}
              <Zeilen zeilen={steuerung.zeilen} />
              {steuerung.beleg && (
                <p className="vp-text-sm" data-testid="geraet-beleg">
                  <Badge variant={badgeVariant(steuerung.beleg.tone)} dot>
                    {steuerung.beleg.text}
                  </Badge>
                  {steuerung.beleg.detail ? ` ${steuerung.beleg.detail}` : ''}
                  {steuerung.belegAlter && (
                    <span className={steuerung.belegStale ? ' vp-edge-stand-warn' : ' vp-muted'}>
                      {' '}
                      · Rücklesen {steuerung.belegAlter}
                    </span>
                  )}
                </p>
              )}
              <p className="vp-text-sm">
                <button type="button" className="vp-linklike" onClick={onNavigateSteuerung}>
                  → Steuerungs-Freigabe
                </button>
              </p>
            </>
          )}
        </Sektion>

        {/* ── Grenzen & Wächter ─────────────────────────────────────────── */}
        <Sektion titel="Grenzen & Wächter" icon="shield">
          {grenzen.leerGrund ? (
            <p className="vp-muted">{grenzen.leerGrund}</p>
          ) : (
            <>
              {grenzen.guard && (
                <div data-testid="geraet-guard">
                  {/* Die Sätze der Box werden DURCHGEREICHT, nie neu
                      formuliert - sonst benennen `:8484` und Portal dasselbe
                      Urteil verschieden. */}
                  <p className={grenzen.guard.tone === 'warn' ? 'vp-edge-stand-warn' : undefined}>
                    {grenzen.guard.line}
                  </p>
                  {grenzen.guard.agoNote && (
                    <p className="vp-muted vp-text-sm">{grenzen.guard.agoNote}</p>
                  )}
                  {grenzen.guard.deviceLimitLine && (
                    <p className="vp-text-sm" data-testid="geraet-device-limit">
                      {grenzen.guard.deviceLimitLine}
                    </p>
                  )}
                </div>
              )}
              {grenzen.abregelung && (
                <p className="vp-text-sm" data-testid="geraet-abregelung">
                  <Badge variant={badgeVariant(grenzen.abregelung.tone)} dot>
                    {grenzen.abregelung.text}
                  </Badge>
                  {grenzen.abregelung.detail ? ` ${grenzen.abregelung.detail}` : ''}
                </p>
              )}
              {grenzen.freigabeText && !grenzen.abregelung && (
                <p className="vp-text-sm">{grenzen.freigabeText}</p>
              )}
            </>
          )}
        </Sektion>

        {/* ── Register (Experte) ────────────────────────────────────────── */}
        <Sektion titel="Register (Experte)" icon="pencil">
          <RegisterSektion device={view.device} />
        </Sektion>

        {/* ── Verbindung & Onboarding ───────────────────────────────────── */}
        <Sektion titel="Verbindung & Onboarding" icon="link">
          <Zeilen zeilen={verbindung.zeilen} />
        </Sektion>

        {/* ── Verlauf ───────────────────────────────────────────────────── */}
        <Sektion titel="Verlauf" icon="history">
          {verlauf.length === 0 ? (
            <p className="vp-muted vp-text-sm">Für dieses Gerät ist noch nichts passiert.</p>
          ) : (
            <ul className="vp-plain-list" data-testid="geraet-verlauf">
              {verlauf.map((e) => (
                <li key={e.id} className="vp-text-sm">
                  <span className="vp-muted">
                    {new Date(e.at).toLocaleString('de-DE', {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </span>{' '}
                  · {actorLabel(e.actor)} · {eventLabel(e.event)}
                  {e.detail ? ` – ${e.detail}` : ''}
                </li>
              ))}
            </ul>
          )}
        </Sektion>
      </div>
    </>
  );
}

/**
 * Die Register-Strecke der Plattform-Geräteseite (Konzept
 * `vp-reg-schreib-konzept-p8` §2.7).
 *
 * Sie ist bewusst ein ruhiger EXPERTEN-Aufklapper, kein prominenter Knopf: die
 * Freiheit ist da, die Fläche bleibt es auch. Der eigentliche Weg (Ist lesen →
 * Vorschau → bestätigen → Beleg) wohnt im geteilten Drawer, damit die Kunden-
 * Fläche der Stufe 3 exakt denselben benutzt.
 */
function RegisterSektion({ device }: { device: GeraetView['device'] }) {
  const [offen, setOffen] = useState(false);
  const zugang = registerZugang(device);

  return (
    <>
      <p className="vp-text-sm">
        Ein einzelnes Geräte-Register aus der Ferne lesen und - nach einer
        Vorschau - genau einmal beschreiben. Jeder Schreibvorgang wird dauerhaft
        protokolliert und erscheint im Befehle-Verlauf der Anlage.
      </p>
      {zugang.moeglich ? (
        <Button variant="outline" onClick={() => setOffen(true)} data-testid="geraet-regwrite">
          Register schreiben
        </Button>
      ) : (
        <p className="vp-muted vp-text-sm" data-testid="geraet-regwrite-grund">{zugang.grund}</p>
      )}
      {offen && zugang.moeglich && (
        <RegisterWriteDrawer
          open
          siteId={zugang.siteId as string}
          deviceId={zugang.deviceId as string}
          tenantId={zugang.tenantId ?? undefined}
          geraetName={device.label ?? device.externalRef}
          onClose={() => setOffen(false)}
        />
      )}
    </>
  );
}

function Zurueck({ onZurueck }: { onZurueck: () => void }) {
  return (
    <button type="button" className="vp-linklike vp-geraet-back" onClick={onZurueck}>
      ‹ Alle Geräte
    </button>
  );
}

function Sektion({
  titel,
  icon,
  children,
}: {
  titel: string;
  icon: 'refresh-cw' | 'shield' | 'settings' | 'link' | 'history' | 'pencil';
  children: React.ReactNode;
}) {
  return (
    <Card padding="lg" radius="lg" className="vp-geraet-sek">
      <h2>
        <Icon name={icon} size={18} /> {titel}
      </h2>
      {children}
    </Card>
  );
}

function Zeilen({ zeilen }: { zeilen: Zeile[] }) {
  if (zeilen.length === 0) return null;
  return (
    <dl className="vp-kv-list">
      {zeilen.map((z) => (
        <div className="vp-kv-row" key={z.label}>
          <dt>{z.label}</dt>
          <dd>
            <span className={z.tone === 'warn' ? 'vp-edge-stand-warn' : undefined}>{z.wert}</span>
            {z.detail && <span className="vp-cell-sub">{z.detail}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Der Ton der Admin-Ableitungen auf die Badge-Varianten des Design-Systems. */
function badgeVariant(tone: Tone): 'ok' | 'warn' | 'off' {
  return tone;
}

/**
 * Release zuweisen / Zuweisung zurücknehmen - wortgleich mit dem Drawer
 * (derselbe Knopf-Wortlaut: er WEIST ZU, das Anwenden bleibt beaufsichtigt).
 */
function ZuweisungsForm({
  releases,
  sollSeq,
  channel: initialChannel,
  pinned: initialPinned,
  hatSoll,
  busy,
  onAssign,
  onRevert,
}: {
  releases: EdgeUpdatesRelease[];
  sollSeq: number | null;
  channel: string | null;
  pinned: boolean;
  hatSoll: boolean;
  busy: boolean;
  onAssign: (releaseSeq: number, channel: string, pinned: boolean) => Promise<void>;
  onRevert?: () => Promise<void>;
}) {
  const [seq, setSeq] = useState<number | null>(sollSeq ?? releases[0]?.releaseSeq ?? null);
  const [channel, setChannel] = useState(initialChannel ?? 'stable');
  const [pinned, setPinned] = useState(initialPinned);

  if (releases.length === 0) {
    return (
      <p className="vp-muted">
        Kein signiertes Release im Register – ohne signiertes Manifest hat ein Gerät nichts, was
        es gegen seinen Vertrauensanker prüfen könnte.
      </p>
    );
  }
  return (
    <>
      <h3>Release zuweisen</h3>
      <label className="vp-field-row">
        <span>Release</span>
        <select value={seq ?? ''} onChange={(e) => setSeq(Number(e.target.value))} aria-label="Release">
          {releases.map((r) => (
            <option key={r.releaseSeq} value={r.releaseSeq}>
              {r.version}
            </option>
          ))}
        </select>
      </label>
      <label className="vp-field-row">
        <span>Kanal</span>
        <select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Kanal">
          <option value="stable">stable</option>
          <option value="canary">canary</option>
        </select>
      </label>
      <label className="vp-check-row">
        <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />{' '}
        Festnageln – ein Rollout überschreibt dieses Gerät dann nicht, sondern überspringt es
        sichtbar.
      </label>
      <div className="vp-row-gap">
        <Button
          variant="primary"
          disabled={busy || seq == null}
          onClick={() => void onAssign(seq as number, channel, pinned)}
        >
          Release zuweisen
        </Button>
        {hatSoll && onRevert && (
          <Button variant="outline" disabled={busy} onClick={() => void onRevert()}>
            Zuweisung zurücknehmen
          </Button>
        )}
      </div>
    </>
  );
}
