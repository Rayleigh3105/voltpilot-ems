import { Recht } from './Recht';
import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  api,
  ApiError,
  type MastrLokationApplyInput,
  type MastrLokationEinheit,
  type MastrPreview,
  type RegisterEinheit,
  type Site,
} from '../api';
import { validateSeeNummer } from '../anlageFlow';
import { fmtNum } from '../format';
import { VpPicker } from './VpPicker';

/**
 * „Anlage verknüpfen" (S2/S3, vp-mastr-mehrere-einheiten-konzept, E2=A: eine
 * Nummer genügt): der Kunde tippt EINE SEE-Nummer, wir lesen ihre Lokation
 * und finden JEDE Einheit an diesem Anschluss (auch den Speicher) - drei
 * Schritte wie im Konzept-Bericht Abschnitt 6: Nummer -> "Im Register
 * gefunden: N Einheiten" mit Vorauswahl -> "Richtung prüfen" nur dort, wo das
 * Register grob ist (keine Himmelsrichtung bekannt). Erst „Übernehmen"
 * speichert; eine andere Betreibernummer bleibt sichtbar, aber abgewählt.
 * Ein zweites Feld bleibt für eine Einheit an einer ANDEREN Lokation (z. B.
 * ein getrennt angemeldeter Speicher) - die Lokations-Suche findet nur, was
 * an EINEM Anschluss hängt.
 */

// The SEE-number validator now lives in ../anlageFlow (shared with the
// register-first AnlageFlow); re-exported here for existing importers.
export { validateSeeNummer };

const NOT_IN_REGISTRY = <span className="vp-muted">nicht im Register hinterlegt</span>;

/** Die 8 exakten Himmelsrichtungen des Registers (MastrCatalog.AZIMUTH_LABEL). */
const RICHTUNGEN = [
  { value: '0', label: 'Nord' },
  { value: '45', label: 'Nord-Ost' },
  { value: '90', label: 'Ost' },
  { value: '135', label: 'Süd-Ost' },
  { value: '180', label: 'Süd' },
  { value: '225', label: 'Süd-West' },
  { value: '270', label: 'West' },
  { value: '315', label: 'Nord-West' },
];

function PreviewCard({
  preview,
  auswahl,
}: {
  preview: MastrPreview;
  /** Checkbox-Zeile statt reiner Anzeige (Schritt „Im Register gefunden"). */
  auswahl?: { gewaehlt: boolean; onToggle: () => void; grund: string | null };
}) {
  const isPv = preview.kind === 'pv';
  return (
    <div style={{ border: '1px solid var(--vp-border)', borderRadius: 'var(--vp-radius-md)', padding: 'var(--vp-space-4)', marginBottom: 'var(--vp-space-3)' }}>
      <div style={{ display: 'flex', gap: 'var(--vp-space-2)', alignItems: 'center', marginBottom: 'var(--vp-space-3)', flexWrap: 'wrap' }}>
        {auswahl && (
          <input
            type="checkbox"
            id={`einheit-${preview.mastrNummer}`}
            checked={auswahl.gewaehlt}
            onChange={auswahl.onToggle}
            aria-label={`${preview.mastrNummer} übernehmen`}
          />
        )}
        <Badge variant="tint">{isPv ? 'PV-Anlage' : 'Batteriespeicher'}</Badge>
        {preview.status && (
          <Badge variant={preview.status === 'In Betrieb' ? 'ok' : 'warn'} dot>
            {preview.status}
          </Badge>
        )}
        <span className="vp-mono vp-note" style={{ marginLeft: 'auto' }}>{preview.mastrNummer}</span>
      </div>
      {auswahl?.grund === 'anderer_betreiber' && (
        <div className="vp-alert vp-alert-warn" style={{ marginBottom: 'var(--vp-space-3)' }}>
          Diese Einheit ist im Register auf einen anderen Betreiber eingetragen - deshalb nicht
          vorausgewählt. Gehört sie trotzdem zu Ihrer Anlage, können Sie sie ankreuzen.
        </div>
      )}
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
              {preview.plz || preview.ort ? `${preview.plz ?? ''} ${preview.ort ?? ''}`.trim() : NOT_IN_REGISTRY}
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

type Schritt = 'nummer' | 'auswahl' | 'richtung' | 'fertig';
type Richtung = { azimuthDeg: number; tiltDeg: number | null };

export function MastrDrawer({
  site,
  open,
  onClose,
  onApplied,
  initialNummer,
}: {
  site: Site;
  open: boolean;
  onClose: () => void;
  onApplied: (einheiten: RegisterEinheit[]) => void;
  /** Vorbelegt die Nummer (z. B. ein Vorschlag des Hintergrund-Abgleichs, E5). */
  initialNummer?: string | null;
}) {
  const [schritt, setSchritt] = useState<Schritt>('nummer');
  const [pvNummer, setPvNummer] = useState('');
  const [storageNummer, setStorageNummer] = useState('');

  useEffect(() => {
    if (open && initialNummer) setPvNummer(initialNummer);
  }, [open, initialNummer]);
  const [gefunden, setGefunden] = useState<MastrLokationEinheit[] | null>(null);
  const [gewaehlt, setGewaehlt] = useState<Set<string>>(new Set());
  const [richtungByNummer, setRichtungByNummer] = useState<Record<string, Richtung>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pvHint = validateSeeNummer(pvNummer);
  const storageHint = validateSeeNummer(storageNummer);
  const canLookup = !busy && !pvHint && !storageHint && (pvNummer.trim() !== '' || storageNummer.trim() !== '');

  function reset() {
    setSchritt('nummer');
    setGefunden(null);
    setGewaehlt(new Set());
    setRichtungByNummer({});
    setError(null);
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
      const pvNorm = pvNummer.replace(/\s+/g, '').toUpperCase();
      const storageNorm = storageNummer.replace(/\s+/g, '').toUpperCase();
      let einheiten: MastrLokationEinheit[] = [];
      if (pvNorm) {
        const preview = await api.mastrLokationLookup(site.id, pvNorm);
        einheiten = preview.einheiten;
      }
      if (storageNorm && !einheiten.some((e) => e.vorschau.mastrNummer === storageNorm)) {
        const storagePreview = await api.mastrLookup(site.id, storageNorm);
        einheiten = [...einheiten, { vorschau: storagePreview, vorausgewaehlt: true, grund: null }];
      }
      if (einheiten.length === 0) {
        setError('Bitte geben Sie mindestens eine MaStR-Nummer ein.');
        return;
      }
      setGefunden(einheiten);
      setGewaehlt(new Set(einheiten.filter((e) => e.vorausgewaehlt).map((e) => e.vorschau.mastrNummer)));
      setSchritt('auswahl');
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

  function toggle(nummer: string) {
    setGewaehlt((prev) => {
      const next = new Set(prev);
      if (next.has(nummer)) next.delete(nummer);
      else next.add(nummer);
      return next;
    });
  }

  /** Einheiten, die eine Richtung brauchen, weil das Register keine kennt (grob/Ost-West/nachgeführt). */
  function brauchenRichtung(): MastrLokationEinheit[] {
    if (!gefunden) return [];
    return gefunden.filter(
      (e) => gewaehlt.has(e.vorschau.mastrNummer) && e.vorschau.kind === 'pv' && e.vorschau.azimuthDeg == null,
    );
  }

  function weiterZurAuswahl() {
    if (gewaehlt.size === 0) {
      setError('Bitte wählen Sie mindestens eine Einheit aus.');
      return;
    }
    setError(null);
    // Nur zum Richtung-Schritt, wenn tatsächlich eine Einheit ohne bekannte
    // Himmelsrichtung ausgewählt ist - sonst direkt übernehmen.
    if (brauchenRichtung().length > 0) {
      setSchritt('richtung');
    } else {
      void apply();
    }
  }

  async function apply() {
    if (!gefunden) return;
    setBusy(true);
    setError(null);
    try {
      const input: MastrLokationApplyInput = { pv: [], storage: [] };
      for (const e of gefunden) {
        if (!gewaehlt.has(e.vorschau.mastrNummer)) continue;
        const p = e.vorschau;
        if (p.kind === 'pv') {
          const richtung = richtungByNummer[p.mastrNummer];
          input.pv!.push({
            mastrNummer: p.mastrNummer,
            capacityKwp: p.powerKw,
            moduleCount: p.moduleCount,
            azimuthDeg: richtung ? richtung.azimuthDeg : p.azimuthDeg,
            tiltDeg: richtung ? richtung.tiltDeg : p.tiltDeg,
            commissionedOn: p.commissionedOn,
          });
        } else {
          input.storage!.push({
            mastrNummer: p.mastrNummer,
            capacityKwh: p.storageCapacityKwh,
            maxChargeKw: p.chargePowerKw,
            maxDischargeKw: p.powerKw,
            commissionedOn: p.commissionedOn,
          });
        }
      }
      if (input.pv!.length === 0) delete input.pv;
      if (input.storage!.length === 0) delete input.storage;
      const einheiten = await api.mastrLokationApply(site.id, input);
      setSchritt('fertig');
      onApplied(einheiten);
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
    <Modal
      open={open}
      onClose={close}
      title="Anlage verknüpfen"
      icon={
        <IconTile category="solar" size={40}>
          <Icon name="sun" size={20} />
        </IconTile>
      }
      footer={
        schritt === 'fertig' ? (
          <Button variant="primary" onClick={close}>
            Fertig
          </Button>
        ) : schritt === 'richtung' ? (
          <>
            <Button variant="ghost" onClick={() => setSchritt('auswahl')} disabled={busy}>
              Zurück
            </Button>
            <Recht aktion="anlage.verwalten">
              <Button
                variant="primary"
                onClick={apply}
                disabled={busy || brauchenRichtung().some((e) => !richtungByNummer[e.vorschau.mastrNummer])}
              >
                {busy ? 'Wird übernommen…' : 'Übernehmen'}
              </Button>
            </Recht>
          </>
        ) : schritt === 'auswahl' ? (
          <>
            <Button variant="ghost" onClick={reset} disabled={busy}>
              Zurück
            </Button>
            <Button variant="primary" onClick={weiterZurAuswahl} disabled={busy}>
              Weiter
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
      {schritt === 'fertig' ? (
        <>
          <div className="vp-alert vp-alert-ok" style={{ marginTop: 0 }}>
            Die Anlagendaten wurden übernommen. Prognose und Optimierung nutzen ab
            sofort die Werte aus dem Marktstammdatenregister.
          </div>
          <p className="vp-note">
            Sie können die Verknüpfung jederzeit über „Anlage verknüpfen“ aktualisieren.
          </p>
        </>
      ) : schritt === 'richtung' ? (
        <>
          <p className="vp-note" style={{ marginTop: 0 }}>
            Für die folgenden Einheiten kennt das Register keine feste Himmelsrichtung
            (z. B. „Ost-West“ oder „nachgeführt“). Bitte wählen Sie die Richtung, in die das
            Dach überwiegend zeigt - die Prognose rechnet damit genauer.
          </p>
          {brauchenRichtung().map((e) => (
            <div key={e.vorschau.mastrNummer} className="vp-form-stack" style={{ marginBottom: 'var(--vp-space-4)' }}>
              <p className="vp-note" style={{ marginTop: 0, marginBottom: 'var(--vp-space-2)' }}>
                <b>{e.vorschau.mastrNummer}</b> ({e.vorschau.azimuthLabel ?? 'unbekannt'})
              </p>
              <VpPicker
                label="Ausrichtung"
                options={RICHTUNGEN}
                value={richtungByNummer[e.vorschau.mastrNummer] ? String(richtungByNummer[e.vorschau.mastrNummer].azimuthDeg) : null}
                onChange={(v) =>
                  setRichtungByNummer((prev) => ({
                    ...prev,
                    [e.vorschau.mastrNummer]: { azimuthDeg: Number(v), tiltDeg: prev[e.vorschau.mastrNummer]?.tiltDeg ?? e.vorschau.tiltDeg },
                  }))
                }
              />
            </div>
          ))}
          {error && <div className="vp-alert vp-alert-err">{error}</div>}
        </>
      ) : schritt === 'auswahl' && gefunden ? (
        <>
          <p className="vp-note" style={{ marginTop: 0 }}>
            Im Register gefunden: {gefunden.length === 1 ? 'eine Einheit' : `${gefunden.length} Einheiten`} an Ihrem
            Anschluss. Bitte kurz prüfen und die richtigen Einheiten ankreuzen - erst „Übernehmen“ speichert die
            Werte für <b>{site.name}</b>.
          </p>
          {gefunden.map((e) => (
            <PreviewCard
              key={e.vorschau.mastrNummer}
              preview={e.vorschau}
              auswahl={{
                gewaehlt: gewaehlt.has(e.vorschau.mastrNummer),
                onToggle: () => toggle(e.vorschau.mastrNummer),
                grund: e.grund,
              }}
            />
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
            Verknüpfen Sie Ihre Anlage mit dem Marktstammdatenregister - eine Nummer genügt,
            wir finden jede weitere Einheit an Ihrem Anschluss selbst (auch den Speicher). Die
            SEE-Nummer finden Sie in Ihrer Registrierungsbestätigung der Bundesnetzagentur.
          </p>
          <div className="vp-form-stack">
            <Input
              label="MaStR-Nummer Ihrer Anlage"
              placeholder="z. B. SEE966831669444"
              value={pvNummer}
              error={pvHint}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPvNummer(e.target.value)}
            />
            <Input
              label="MaStR-Nummer einer weiteren Einheit an anderem Anschluss (optional)"
              placeholder="z. B. SEE972142227037"
              value={storageNummer}
              error={storageHint}
              hint="Nur nötig, wenn eine Einheit NICHT an demselben Anschluss wie oben hängt."
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setStorageNummer(e.target.value)}
            />
          </div>
          {error && <div className="vp-alert vp-alert-err">{error}</div>}
        </>
      )}
    </Modal>
  );
}
