import { useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { VpPicker } from './VpPicker';
import { actorLabel, eventLabel, type EdgeUpdatesRelease } from '../adminEdgeUpdates';
import type { GeraetView, Zeile } from '../adminGeraet';
import type { Tone } from '../adminFleet';

/**
 * Die ADMIN-KARTEN eines Geräts - Software, Vertrauen, Steuerungs-Freigabe,
 * Grenzen, Verbindung, Journal (Anlagen-Zentrale Stufe 1 PR 1f, Konzept
 * `data/vp-anlagen-zentrale-konzept-h6` §7.7).
 *
 * <p><b>⚠ Sie leben hier, weil sie ZWEI Wirte haben:</b> die
 * Plattform-Geräteseite und - seit dieser Stufe - die Geräteseite der Anlage
 * hinter dem EINEN Tor `rollen.showTechnicalLayer()`. Sie zweimal zu schreiben
 * hiesse, jede Handlung (Zuweisen, Anwenden, Zurücknehmen) und jede ihrer
 * Zusagen an zwei Orten zu pflegen - dieselbe Begründung, aus der der
 * Register-Aufklapper der Zentrale in PR 1c ERSETZT statt ergänzt wurde.
 *
 * <p>Sie RENDERN nur: jedes Urteil, jeder Satz und jede Ehrlichkeitsregel liegt
 * in der reinen `adminGeraet.ts`. Ein Knopf ohne seinen Rückruf wird gar nicht
 * erst angeboten - ein Wirt, der eine Handlung nicht anbietet, zeigt sie nicht.
 */
export function AdminGeraetKarten({
  view,
  busy,
  onNavigateSteuerung,
  onAssign,
  onRevert,
}: {
  view: GeraetView;
  busy: boolean;
  onNavigateSteuerung: () => void;
  onAssign?: (releaseSeq: number) => Promise<void>;
  onRevert?: () => Promise<void>;
}) {
  const { software, vertrauen, steuerung, grenzen, verbindung, verlauf } = view;
  return (
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
              {software.hebel && (
                <p className="vp-text-sm vp-lever" data-testid="geraet-hebel">
                  Hebel: {software.hebel}
                </p>
              )}
              {onAssign && (
                <ZuweisungsForm
                  releases={software.signierteReleases}
                  sollSeq={view.device.sollSeq}
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
  );
}

export function Sektion({
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
export function badgeVariant(tone: Tone): 'ok' | 'warn' | 'off' {
  return tone;
}

/**
 * Release zuweisen / Zuweisung zurücknehmen.
 *
 * Seit dem Ein-Schritt-Umbau ist das ALLES: kein Kanal, kein Festnageln, kein
 * zweiter Knopf „Auf Gerät anwenden" - das Gerät wendet selbst an.
 */
function ZuweisungsForm({
  releases,
  sollSeq,
  hatSoll,
  busy,
  onAssign,
  onRevert,
}: {
  releases: EdgeUpdatesRelease[];
  sollSeq: number | null;
  hatSoll: boolean;
  busy: boolean;
  onAssign: (releaseSeq: number) => Promise<void>;
  onRevert?: () => Promise<void>;
}) {
  const [seq, setSeq] = useState<number | null>(sollSeq ?? releases[0]?.releaseSeq ?? null);

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
      <VpPicker
        label="Release"
        options={releases.map((r) => ({ value: String(r.releaseSeq), label: r.version }))}
        value={seq == null ? '' : String(seq)}
        onChange={(v) => setSeq(Number(v))}
      />
      <p className="vp-muted vp-text-sm">
        Das Gerät lädt und tauscht danach von selbst. Es ist kein weiterer Schritt nötig.
      </p>
      <div className="vp-row-gap">
        <Button
          variant="primary"
          disabled={busy || seq == null}
          onClick={() => void onAssign(seq as number)}
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
