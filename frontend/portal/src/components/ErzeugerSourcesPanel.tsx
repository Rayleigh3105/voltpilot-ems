import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { api, ApiError, type MeasurementPoint } from '../api';
import { fmtNum } from '../format';

/**
 * "Weitere Erzeuger" - record ADDITIONAL read-only PV sources of an Anlage
 * (multi-source): a site with a battery-hybrid inverter PLUS a separate
 * AC-coupled PV records the second PV here so its kWp sums into the Anlage's
 * total PV. Master data only - NO second device claim (the source is read
 * through the Anlage's one connected device). Read-only by construction.
 */

/** One-line description of a recorded source (pure, unit-tested). */
export function sourceSummary(p: MeasurementPoint): string {
  const bits: string[] = [];
  if (p.capacityKwp != null) bits.push(fmtNum(p.capacityKwp, 'kWp', 1));
  if (p.registryUnitId) bits.push(p.registryUnitId);
  bits.push('nur Lesen');
  return bits.join(' · ');
}

export function ErzeugerSourcesPanel({ siteId }: { siteId: string }) {
  const [points, setPoints] = useState<MeasurementPoint[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState(false);
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
        if (alive) setPoints(list);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [siteId]);

  function resetForm() {
    setLabel('');
    setKwp('');
    setSee('');
    setError(null);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    const kwpNum = kwp.trim() === '' ? undefined : Number(kwp.replace(',', '.'));
    if (kwpNum !== undefined && (Number.isNaN(kwpNum) || kwpNum < 0)) {
      setError('Bitte geben Sie eine gültige Leistung in kWp an.');
      setBusy(false);
      return;
    }
    try {
      const list = await api.addMeasurementPoint(siteId, {
        role: 'pv-generation',
        label: label.trim() || undefined,
        capacityKwp: kwpNum,
        registryUnitId: see.trim() || undefined,
      });
      setPoints(list);
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
      setPoints(list);
    } catch {
      // leave the list; a reload re-syncs
    }
  }

  if (failed) return null; // never block the Technik page on this optional panel

  return (
    <div className="vp-erzeuger">
      <p className="vp-note" style={{ marginTop: 0 }}>
        Hat diese Anlage neben dem Wechselrichter oben eine <strong>separate PV-Anlage</strong>
        {' '}(z.&nbsp;B. eine ältere, AC-gekoppelte Anlage), erfassen Sie sie hier. Ihre Leistung
        zählt dann zur Gesamt-PV der Anlage. Nur Lesen - gesteuert wird nichts.
      </p>

      {points != null && points.length > 0 && (
        <ul className="vp-erzeuger-list">
          {points.map((p) => (
            <li key={p.id} className="vp-erzeuger-item">
              <span className="vp-erzeuger-main">
                <span className="vp-erzeuger-name">{p.label || 'PV-Erzeuger'}</span>
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
          Erzeuger hinzufügen
        </Button>
      ) : (
        <div className="vp-erzeuger-form">
          <Input
            label="Bezeichnung (optional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="z. B. PV Dach Süd"
          />
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
