import { useEffect, useState } from 'react';
import { Card } from '../../../designsystem/components/core/Card';
import { ApiError } from '../../api';
import { adminApi, type ErstverbindungSchalterStand } from '../../admin/adminApi';

const BEREICHE = [
  { id: 'alle', label: 'Alle Linien' },
  { id: 'light', label: 'Edge Light' },
  { id: 'industrie', label: 'Edge Industrie' },
  { id: 'docker', label: 'Docker-Box' },
] as const;
type Bereich = (typeof BEREICHE)[number]['id'];

const wann = (iso: string) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

/**
 * Erstverbindung S1/S3: der Schalter des Betriebs für die Automatik beim ersten Verbinden (`ota.Erstverbindung`) -
 * je Linie oder für alle, ohne Deploy, ab Werk an. Jede Änderung steht im Verlauf der Seite.
 */
export function ErstverbindungSchalter({ onGeaendert }: { onGeaendert?: () => void }) {
  const [stand, setStand] = useState<ErstverbindungSchalterStand | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let aktiv = true;
    adminApi.erstverbindungSchalter().then(
      (s) => aktiv && setStand(s),
      () => aktiv && setFehler('Der Schalter ließ sich nicht laden.'),
    );
    return () => {
      aktiv = false;
    };
  }, []);

  async function schalten(bereich: Bereich, an: boolean) {
    setBusy(true);
    setFehler(null);
    try {
      setStand(await adminApi.erstverbindungSchalten(bereich, an));
      onGeaendert?.();
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : 'Das Umschalten hat nicht geklappt.');
    } finally {
      setBusy(false);
    }
  }

  const zuletzt = stand?.eintraege.slice().sort((a, b) => b.geaendertAm.localeCompare(a.geaendertAm))[0] ?? null;
  return (
    <Card padding="lg" radius="lg" data-testid="erstverbindung-schalter">
      <details>
        <summary className="vp-sec-summary">
          <h3 style={{ margin: 0, display: 'inline' }}>Automatik beim ersten Verbinden</h3>
          {stand && <span className="vp-muted"> · {stand.alle && stand.light && stand.industrie && stand.docker ? 'an' : 'teilweise aus'}</span>}
        </summary>
        <p className="vp-muted" style={{ marginTop: 'var(--vp-space-2)' }}>
          Neu verbundene Boxen holen sich mit ihrer ersten Meldung die neueste signierte Fassung ihrer Linie. Hier
          schaltest du das ohne Deploy ab; jede Änderung steht im Verlauf.
        </p>
        {stand && (
          <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 'var(--vp-space-2)' }}>
            <legend className="vp-sr-only">Automatik beim ersten Verbinden</legend>
            {BEREICHE.map((b) => (
              <label key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--vp-space-2)', minHeight: 44 }}>
                <input
                  type="checkbox"
                  checked={stand[b.id]}
                  onChange={(e) => void schalten(b.id, e.currentTarget.checked)}
                  data-testid={`erstverbindung-${b.id}`}
                />
                {b.label}
              </label>
            ))}
          </fieldset>
        )}
        {zuletzt && (
          <p className="vp-muted vp-text-sm" style={{ marginBottom: 0 }}>
            Zuletzt geändert {wann(zuletzt.geaendertAm)} von {zuletzt.geaendertVon}.
          </p>
        )}
        {fehler && <p className="vp-alert vp-alert-warn" role="alert" style={{ marginBottom: 0 }}>{fehler}</p>}
      </details>
    </Card>
  );
}
