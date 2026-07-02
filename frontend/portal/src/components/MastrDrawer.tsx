import { useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Input } from '../../designsystem/components/forms/Input';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import { api, ApiError, type MastrApplyInput, type MastrPreview, type Site, type SiteAsset } from '../api';
import { fmtNum } from '../format';

/**
 * "Anlage verknüpfen" (optional MaStR onboarding step): the customer enters
 * their SEE unit number(s) from the BNetzA registration confirmation, we fetch
 * the public registry record, show it in plain German for CONFIRMATION, and
 * only "Übernehmen" persists the values onto the site's assets. Registry data
 * is a prefill the customer confirms - never silently applied.
 */

/** Client-side prefix validation with the same friendly hints as the backend. */
export function validateSeeNummer(raw: string): string | null {
  const cleaned = raw.replace(/\s+/g, '').toUpperCase();
  if (!cleaned) return null;
  if (/^SEE\d{12}$/.test(cleaned)) return null;
  const prefix = cleaned.slice(0, 3);
  if (prefix === 'SES') {
    return 'SES-Nummern kennzeichnen keine Einheit. Auch Batteriespeicher haben eine SEE-Nummer.';
  }
  if (prefix === 'SSE') {
    return 'Das ist die Nummer der Speicher-Anlage. Bitte die SEE-Nummer der Speicher-Einheit eingeben.';
  }
  if (prefix === 'EEG') {
    return 'Das ist die Nummer der EEG-Anlage. Bitte die SEE-Nummer der Einheit eingeben.';
  }
  if (prefix === 'ABR') {
    return 'Das ist Ihre Betreibernummer. Bitte die SEE-Nummer der Einheit eingeben.';
  }
  return 'Eine Einheitennummer beginnt mit SEE, gefolgt von 12 Ziffern (z. B. SEE966831669444).';
}

const NOT_IN_REGISTRY = <span className="vp-muted">nicht im Register hinterlegt</span>;

function PreviewCard({ preview }: { preview: MastrPreview }) {
  const isPv = preview.kind === 'pv';
  return (
    <div style={{ border: '1px solid var(--vp-border)', borderRadius: 'var(--vp-radius-card)', padding: 'var(--vp-space-4)', marginBottom: 'var(--vp-space-3)' }}>
      <div style={{ display: 'flex', gap: 'var(--vp-space-2)', alignItems: 'center', marginBottom: 'var(--vp-space-3)', flexWrap: 'wrap' }}>
        <Badge variant="tint">{isPv ? 'PV-Anlage' : 'Batteriespeicher'}</Badge>
        {preview.status && (
          <Badge variant={preview.status === 'In Betrieb' ? 'ok' : 'warn'} dot>
            {preview.status}
          </Badge>
        )}
        <span className="vp-mono vp-note" style={{ marginLeft: 'auto' }}>{preview.mastrNummer}</span>
      </div>
      <table className="vp-table">
        <tbody>
          {preview.plantType && (
            <tr>
              <th scope="row">Typ</th>
              <td>{preview.plantType}</td>
            </tr>
          )}
          {isPv ? (
            <>
              <tr>
                <th scope="row">Leistung</th>
                <td>{preview.powerKw != null ? fmtNum(preview.powerKw, 'kWp', 2) : NOT_IN_REGISTRY}</td>
              </tr>
              <tr>
                <th scope="row">Module</th>
                <td>{preview.moduleCount != null ? preview.moduleCount : NOT_IN_REGISTRY}</td>
              </tr>
              <tr>
                <th scope="row">Ausrichtung</th>
                <td>{preview.azimuthLabel ?? NOT_IN_REGISTRY}</td>
              </tr>
              <tr>
                <th scope="row">Neigungswinkel</th>
                <td>{preview.tiltLabel ?? NOT_IN_REGISTRY}</td>
              </tr>
            </>
          ) : (
            <>
              <tr>
                <th scope="row">Speicherkapazität</th>
                <td>{preview.storageCapacityKwh != null ? fmtNum(preview.storageCapacityKwh, 'kWh', 1) : NOT_IN_REGISTRY}</td>
              </tr>
              <tr>
                <th scope="row">Entladeleistung</th>
                <td>{preview.powerKw != null ? fmtNum(preview.powerKw, 'kW', 2) : NOT_IN_REGISTRY}</td>
              </tr>
              <tr>
                <th scope="row">Ladeleistung</th>
                <td>{preview.chargePowerKw != null ? fmtNum(preview.chargePowerKw, 'kW', 2) : NOT_IN_REGISTRY}</td>
              </tr>
              <tr>
                <th scope="row">Technologie</th>
                <td>{preview.batteryTechnology ?? NOT_IN_REGISTRY}</td>
              </tr>
            </>
          )}
          <tr>
            <th scope="row">Inbetriebnahme</th>
            <td>{preview.commissionedOn ?? NOT_IN_REGISTRY}</td>
          </tr>
          <tr>
            <th scope="row">Standort laut Register</th>
            <td>
              {preview.plz || preview.ort ? (
                `${preview.plz ?? ''} ${preview.ort ?? ''}`.trim()
              ) : (
                NOT_IN_REGISTRY
              )}
            </td>
          </tr>
        </tbody>
      </table>
      {preview.warnings.map((w) => (
        <div key={w} className="vp-alert vp-alert-info" style={{ marginBottom: 0 }}>
          {w}
        </div>
      ))}
    </div>
  );
}

export function MastrDrawer({
  site,
  open,
  onClose,
  onApplied,
}: {
  site: Site;
  open: boolean;
  onClose: () => void;
  onApplied: (assets: SiteAsset[]) => void;
}) {
  const [pvNummer, setPvNummer] = useState('');
  const [storageNummer, setStorageNummer] = useState('');
  const [previews, setPreviews] = useState<MastrPreview[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const pvHint = validateSeeNummer(pvNummer);
  const storageHint = validateSeeNummer(storageNummer);
  const canLookup =
    !busy && !pvHint && !storageHint && (pvNummer.trim() !== '' || storageNummer.trim() !== '');

  function reset() {
    setPreviews(null);
    setError(null);
    setDone(false);
  }

  function close() {
    reset();
    setPvNummer('');
    setStorageNummer('');
    onClose();
  }

  async function lookup() {
    setBusy(true);
    setError(null);
    try {
      const numbers = [pvNummer, storageNummer]
        .map((n) => n.replace(/\s+/g, '').toUpperCase())
        .filter(Boolean);
      const found = await Promise.all(numbers.map((n) => api.mastrLookup(site.id, n)));
      const kinds = found.map((p) => p.kind);
      if (new Set(kinds).size !== kinds.length) {
        setError(
          'Beide Nummern gehören zur gleichen Einheitenart. Bitte geben Sie die SEE-Nummer der PV-Anlage und optional die des Speichers an.',
        );
        return;
      }
      setPreviews(found);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'Die Registerabfrage ist fehlgeschlagen. Bitte versuchen Sie es später erneut.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!previews) return;
    setBusy(true);
    setError(null);
    try {
      const input: MastrApplyInput = {};
      for (const p of previews) {
        if (p.kind === 'pv') {
          input.pv = {
            mastrNummer: p.mastrNummer,
            capacityKwp: p.powerKw,
            moduleCount: p.moduleCount,
            azimuthDeg: p.azimuthDeg,
            tiltDeg: p.tiltDeg,
            commissionedOn: p.commissionedOn,
          };
        } else {
          input.storage = {
            mastrNummer: p.mastrNummer,
            capacityKwh: p.storageCapacityKwh,
            maxChargeKw: p.chargePowerKw,
            maxDischargeKw: p.powerKw,
            commissionedOn: p.commissionedOn,
          };
        }
      }
      const assets = await api.mastrApply(site.id, input);
      setDone(true);
      onApplied(assets);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'Die Daten konnten nicht übernommen werden. Bitte versuchen Sie es erneut.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={close}
      title="Anlage verknüpfen"
      icon={
        <IconTile category="solar" size={40}>
          <Icon name="sun" size={20} />
        </IconTile>
      }
      footer={
        done ? (
          <Button variant="primary" onClick={close}>
            Fertig
          </Button>
        ) : previews ? (
          <>
            <Button variant="ghost" onClick={reset} disabled={busy}>
              Zurück
            </Button>
            <Button variant="primary" onClick={apply} disabled={busy}>
              {busy ? 'Wird übernommen…' : 'Übernehmen'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Abbrechen
            </Button>
            <Button variant="primary" onClick={lookup} disabled={!canLookup}>
              {busy ? 'Wird abgefragt…' : 'Im Register nachschlagen'}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <>
          <div className="vp-alert vp-alert-ok" style={{ marginTop: 0 }}>
            Die Anlagendaten wurden übernommen. Prognose und Optimierung nutzen ab
            sofort die Werte aus dem Marktstammdatenregister.
          </div>
          <p className="vp-note">
            Sie können die Verknüpfung jederzeit über „Anlage verknüpfen“ aktualisieren.
          </p>
        </>
      ) : previews ? (
        <>
          <p className="vp-note" style={{ marginTop: 0 }}>
            Gefunden im Marktstammdatenregister - bitte prüfen Sie, ob das Ihre
            Anlage ist. Erst „Übernehmen“ speichert die Werte für{' '}
            <b>{site.name}</b>.
          </p>
          {previews.map((p) => (
            <PreviewCard key={p.mastrNummer} preview={p} />
          ))}
          <p className="vp-note">
            Straße und Koordinaten sind für private Betreiber im Register nicht
            öffentlich; Ihre Standort-Koordinaten bleiben unverändert.
          </p>
          <p className="vp-note">
            Datenquelle: Marktstammdatenregister der Bundesnetzagentur (dl-de/by-2-0).
          </p>
          {error && <div className="vp-alert vp-alert-err">{error}</div>}
        </>
      ) : (
        <>
          <p className="vp-note" style={{ marginTop: 0 }}>
            Optional: Verknüpfen Sie Ihre Anlage mit dem Marktstammdatenregister,
            damit Prognose und Optimierung mit den amtlich registrierten Werten
            rechnen. Die SEE-Nummern finden Sie in Ihrer Registrierungsbestätigung
            der Bundesnetzagentur.
          </p>
          <div className="vp-form-stack">
            <Input
              label="MaStR-Nummer der PV-Anlage"
              placeholder="z. B. SEE966831669444"
              value={pvNummer}
              error={pvHint}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPvNummer(e.target.value)}
            />
            <Input
              label="MaStR-Nummer des Speichers (optional)"
              placeholder="z. B. SEE972142227037"
              value={storageNummer}
              error={storageHint}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setStorageNummer(e.target.value)}
            />
          </div>
          {error && <div className="vp-alert vp-alert-err">{error}</div>}
        </>
      )}
    </Drawer>
  );
}
