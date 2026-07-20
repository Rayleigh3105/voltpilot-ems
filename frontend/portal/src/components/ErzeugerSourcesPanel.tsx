import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { api, ApiError, type MeasurementPoint } from '../api';
import { fmtNum } from '../format';

/**
 * "Weitere Energiequellen" - record ADDITIONAL read-only sources of an Anlage
 * (multi-source): a site with a battery-hybrid inverter PLUS a separate
 * AC-coupled PV records the second PV here (Erzeuger) so its kWp sums into the
 * Anlage's total PV; a Verbraucher (e.g. a go-e wallbox) records its load. Master
 * data only - NO second device claim (the source is read through the Anlage's one
 * connected device). Read-only by construction.
 */

/** The read-only source roles this panel creates + displays. */
type SourceRole = 'pv-generation' | 'consumer';

const ROLE_LABEL: Record<string, string> = {
  'pv-generation': 'PV-Erzeuger',
  'grid-meter': 'Netz-Zähler',
  consumer: 'Verbraucher',
};

/** One-line description of a recorded source (pure, unit-tested). */
export function sourceSummary(p: MeasurementPoint): string {
  const bits: string[] = [];
  if (p.capacityKwp != null) bits.push(fmtNum(p.capacityKwp, 'kWp', 1));
  if (p.registryUnitId) bits.push(p.registryUnitId);
  bits.push('nur Lesen');
  return bits.join(' · ');
}

/**
 * Only the read-only SOURCE roles belong in this panel. A `battery-hybrid`
 * measurement point (the v2 entity-registry row the admin bootstrap creates for
 * the primary inverter) is deliberately hidden here - it is not a "weitere
 * Energiequelle" and is managed platform-side. Erzeuger (PV), Netz (grid meter)
 * and Consumer (Verbraucher, e.g. a wallbox) are shown.
 */
function sourceRolesOnly(list: MeasurementPoint[]): MeasurementPoint[] {
  return list.filter(
    (p) => p.role === 'pv-generation' || p.role === 'grid-meter' || p.role === 'consumer',
  );
}

export function ErzeugerSourcesPanel({ siteId }: { siteId: string }) {
  const [points, setPoints] = useState<MeasurementPoint[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [role, setRole] = useState<SourceRole>('pv-generation');
  const [label, setLabel] = useState('');
  const [kwp, setKwp] = useState('');
  const [see, setSee] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .measurementPoints(siteId)
      .then((list) => {
        if (alive) setPoints(sourceRolesOnly(list));
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [siteId]);

  function resetForm() {
    setRole('pv-generation');
    setLabel('');
    setKwp('');
    setSee('');
    setError(null);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    const isErzeuger = role === 'pv-generation';
    // Only an Erzeuger carries a kWp nameplate; a Verbraucher never does.
    const kwpNum = !isErzeuger || kwp.trim() === '' ? undefined : Number(kwp.replace(',', '.'));
    if (kwpNum !== undefined && (Number.isNaN(kwpNum) || kwpNum < 0)) {
      setError('Bitte geben Sie eine gültige Leistung in kWp an.');
      setBusy(false);
      return;
    }
    try {
      const list = await api.addMeasurementPoint(siteId, {
        role,
        label: label.trim() || undefined,
        capacityKwp: kwpNum,
        registryUnitId: isErzeuger ? see.trim() || undefined : undefined,
      });
      setPoints(sourceRolesOnly(list));
      setAdding(false);
      resetForm();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Die Quelle konnte nicht gespeichert werden.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      const list = await api.deleteMeasurementPoint(siteId, id);
      setPoints(sourceRolesOnly(list));
    } catch {
      // leave the list; a reload re-syncs
    }
  }

  if (failed) return null; // never block the Technik page on this optional panel

  const isErzeuger = role === 'pv-generation';

  return (
    <div className="vp-erzeuger">
      <p className="vp-note" style={{ marginTop: 0 }}>
        Hat diese Anlage neben dem Wechselrichter oben eine <strong>separate PV-Anlage</strong>
        {' '}(z.&nbsp;B. eine ältere, AC-gekoppelte Anlage) oder einen{' '}
        <strong>eigenen Verbraucher</strong> (z.&nbsp;B. eine Wallbox), erfassen Sie sie hier. Eine
        PV-Anlage zählt dann zur Gesamt-PV der Anlage. Nur Lesen - gesteuert wird nichts.
      </p>

      {points != null && points.length > 0 && (
        <ul className="vp-erzeuger-list">
          {points.map((p) => (
            <li key={p.id} className="vp-erzeuger-item">
              <span className="vp-erzeuger-main">
                <span className="vp-erzeuger-name">
                  {p.label || ROLE_LABEL[p.role] || 'Energiequelle'}
                </span>
                <span className="vp-note">{sourceSummary(p)}</span>
              </span>
              <Button variant="ghost" size="sm" onClick={() => remove(p.id)}>
                Entfernen
              </Button>
            </li>
          ))}
        </ul>
      )}

      {!adding ? (
        <Button
          variant="outline"
          size="sm"
          iconLeft={<Icon name="plus" size={16} />}
          onClick={() => {
            resetForm();
            setAdding(true);
          }}
        >
          Energiequelle hinzufügen
        </Button>
      ) : (
        <div className="vp-erzeuger-form">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            <label htmlFor="vp-source-role" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
              Art der Energiequelle
            </label>
            <select
              id="vp-source-role"
              className="vp-select"
              value={role}
              onChange={(e) => setRole(e.target.value as SourceRole)}
            >
              <option value="pv-generation">PV-Erzeuger (z. B. AC-gekoppelte PV)</option>
              <option value="consumer">Verbraucher (z. B. Wallbox)</option>
            </select>
          </div>
          <Input
            label="Bezeichnung (optional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={isErzeuger ? 'z. B. PV Dach Süd' : 'z. B. Wallbox Garage'}
          />
          {isErzeuger && (
            <>
              <Input
                label="Anlagenleistung (kWp)"
                value={kwp}
                onChange={(e) => setKwp(e.target.value)}
                inputMode="decimal"
                placeholder="z. B. 70"
              />
              <Input
                label="MaStR-Nummer der Quelle (optional)"
                value={see}
                onChange={(e) => setSee(e.target.value)}
                placeholder="SEE…"
              />
            </>
          )}
          {error && <p className="vp-form-error">{error}</p>}
          <div className="vp-erzeuger-actions">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setAdding(false);
                resetForm();
              }}
            >
              Abbrechen
            </Button>
            <Button size="sm" onClick={submit} disabled={busy}>
              {busy ? 'Speichern…' : 'Quelle hinzufügen'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
