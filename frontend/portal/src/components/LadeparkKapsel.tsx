import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { api, ApiError, type Site } from '../api';
import { ConfirmDialog } from './ConfirmDialog';
import { fmtNum } from '../format';
import {
  aktivierenFolgen,
  chargerName,
  GRENZE_FEHLT,
  grenzeFehler,
  LADEPARK_LINE,
  PV_UEBERSCHUSS_LINE,
  PV_UEBERSCHUSS_OHNE_PV,
  VERTEILUNG_TEXT,
  VORRANG_OHNE_AUSWAHL,
  VORRANG_TEXT,
  type ChargingConfig,
  type SiteCharging,
} from '../ladepunkte';
import './LadeparkKapsel.css';

/**
 * Die Ladepark-Kapsel im Bereich STEUERUNG (Captain-Entscheid aus dem
 * Mockup-Zyklus: die zwei benannten Nutzungen sind Strategie-KARTEN hier -
 * nicht im Anlege-Assistenten und nicht auf einer Optimierungs-Seite).
 *
 * Die Autoritäts-Stufen des Hauses, unverändert:
 *  - „fest eingebaut": die dynamisch faire Verteilung - sie läuft auf der Box
 *    und schützt den Anschluss; es gibt hier keinen Schalter dafür.
 *  - „Ihre Wahl": die Anschlussgrenze und die Vorrang-Stufe.
 *
 * ⚠ Ohne PV wird die Überschuss-Karte SICHTBAR ausgegraut MIT Grund - nie
 * versteckt (Mockups §2a). Und der Hinweis ohne Vorrang-Auswahl nennt die
 * FOLGE für die Wartezeit der anderen, statt nur „keine Auswahl" zu sagen.
 */
export function LadeparkKapsel({
  site,
  charging,
  hasPv,
  onSaved,
}: {
  site: Site;
  charging: SiteCharging;
  hasPv: boolean;
  onSaved?: () => void;
}) {
  const [config, setConfig] = useState<ChargingConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api.chargingConfig(site.id).then(
      (c) => {
        if (!active) return;
        setConfig(c);
        setDraft(c.gridLimitKw == null ? '' : String(c.gridLimitKw));
      },
      () => active && setConfig(null),
    );
    return () => {
      active = false;
    };
  }, [site.id]);

  const limit = config?.gridLimitKw ?? null;
  const priorities = new Set(config?.priorityChargePointIds ?? []);
  const inputError = draft.trim() === '' ? null : grenzeFehler(draft);

  async function save(body: { gridLimitKw?: number; priorityChargePointIds?: string[] }) {
    setBusy(true);
    setError(null);
    try {
      const next = await api.saveChargingConfig(site.id, body);
      setConfig(next);
      setDraft(next.gridLimitKw == null ? '' : String(next.gridLimitKw));
      onSaved?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Speichern fehlgeschlagen.');
    } finally {
      setBusy(false);
      setDialog(false);
    }
  }

  function togglePriority(id: string) {
    const next = new Set(priorities);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    void save({ priorityChargePointIds: [...next] });
  }

  const parsed = Number(draft.replace(',', '.').trim());

  return (
    <section className="vp-ladepark" aria-label="Ladepark">
      <Card padding="lg" radius="lg">
        <div className="vp-ladepark-cards">
          <article className="vp-ladepark-card">
            <div className="vp-ladepark-card-head">
              <h3>Ladepark-Lastmanagement</h3>
              <Badge variant="ok">aktiv</Badge>
            </div>
            <p>{LADEPARK_LINE}</p>
          </article>
          <article className="vp-ladepark-card off">
            <div className="vp-ladepark-card-head">
              <h3>PV-Überschussladen</h3>
              <Badge variant="off">nicht verfügbar</Badge>
            </div>
            <p>{PV_UEBERSCHUSS_LINE}</p>
            <p className="vp-ladepark-reason">
              {hasPv
                ? 'Für Ladepunkte kann VoltPilot den Sonnenstrom heute noch nicht bevorzugen - Ihre Anschlussgrenze wird trotzdem jederzeit gehalten.'
                : PV_UEBERSCHUSS_OHNE_PV}
            </p>
          </article>
        </div>

        <div className="vp-ladepark-row">
          <div>
            <h4>Anschlussgrenze</h4>
            <p className="vp-ladepark-managed">
              {limit == null ? GRENZE_FEHLT : `${fmtNum(limit, 'kW')} am Netzverknüpfungspunkt.`}
            </p>
          </div>
          <div className="vp-ladepark-edit">
            <label htmlFor="vp-grenze">kW</label>
            <input
              id="vp-grenze"
              inputMode="decimal"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-invalid={inputError ? true : undefined}
            />
            <Button
              variant="outline"
              disabled={busy || draft.trim() === '' || inputError != null}
              onClick={() => setDialog(true)}
            >
              Übernehmen
            </Button>
          </div>
        </div>
        {inputError && <p className="vp-ladepark-error">{inputError}</p>}
        {error && <p className="vp-ladepark-error">{error}</p>}

        <div className="vp-ladepark-row">
          <div>
            <h4>Verteilung</h4>
            <p className="vp-ladepark-managed">{VERTEILUNG_TEXT}</p>
          </div>
        </div>

        <div className="vp-ladepark-row">
          <div>
            <h4>Vorrang</h4>
            <p className="vp-ladepark-managed">{VORRANG_TEXT}</p>
            <ul className="vp-ladepark-chips">
              {charging.chargers.map((c) => (
                <li key={c.chargePointId}>
                  <button
                    type="button"
                    className={`vp-ladepark-chip${priorities.has(c.chargePointId) ? ' on' : ''}`}
                    aria-pressed={priorities.has(c.chargePointId)}
                    disabled={busy}
                    onClick={() => togglePriority(c.chargePointId)}
                  >
                    {chargerName(c)}
                  </button>
                </li>
              ))}
            </ul>
            {priorities.size === 0 && <p className="vp-ladepark-hint">{VORRANG_OHNE_AUSWAHL}</p>}
          </div>
        </div>
      </Card>

      <ConfirmDialog
        open={dialog}
        title="Anschlussgrenze übernehmen"
        intro={`VoltPilot rechnet ab sofort mit ${fmtNum(parsed, 'kW')} als Grenze Ihres Netzanschlusses.`}
        consequences={aktivierenFolgen(Number.isFinite(parsed) ? parsed : null)}
        confirmLabel="Übernehmen"
        busy={busy}
        onConfirm={() => void save({ gridLimitKw: parsed })}
        onCancel={() => setDialog(false)}
      />
    </section>
  );
}
