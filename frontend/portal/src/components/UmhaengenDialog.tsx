import { useState } from 'react';
import { Recht } from './Recht';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Modal } from '../../designsystem/components/shell/Modal';
import './AnlagenModell.css';
import { api, ApiError } from '../api';
import type { PlantComponent } from '../komponenten';
import { VpDatePicker } from './VpDatePicker';

/** 401/403/404 = die Kundenroute fehlt (älteres Backend) → ehrlicher Hinweis. */
function messageFor(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback;
}

/**
 * Zählerbaum-Konzept: wie tief ein Zähler im Baum hängt - für die Einrückung im Zielwähler.
 * Bricht einen Kreis ab, statt endlos zu laufen (R6 verhindert ihn serverseitig; hier nur eine
 * Schutzgrenze gegen einen fehlerhaften Stand). Dieselbe Rechnung wie `tiefeZaehler` in
 * `AnlegenFlow.tsx`.
 */
function tiefe(id: string, alle: readonly PlantComponent[]): number {
  let t = 0;
  let cur = alle.find((k) => k.id === id);
  const gesehen = new Set<string>();
  while (cur?.haengtAn && !gesehen.has(cur.id)) {
    gesehen.add(cur.id);
    t += 1;
    cur = alle.find((k) => k.id === cur!.haengtAn);
  }
  return t;
}

/** `kandidatId` ist `wurzelId` selbst oder hängt (direkt oder über mehrere Stufen) an ihr - ihn als neues Ziel zu wählen, wäre ein Kreis. */
function istSelbstOderNachfahre(kandidatId: string, wurzelId: string, alle: readonly PlantComponent[]): boolean {
  let cur = alle.find((k) => k.id === kandidatId);
  const gesehen = new Set<string>();
  while (cur && !gesehen.has(cur.id)) {
    if (cur.id === wurzelId) return true;
    gesehen.add(cur.id);
    cur = cur.haengtAn ? alle.find((k) => k.id === cur!.haengtAn) : undefined;
  }
  return false;
}

/**
 * Zählerbaum-Konzept (E1-E5 A, Captain-Nachtrag 10.11.2026): „Woanders anhängen …" im
 * Gerätemenü eines Zählers - derselbe `PUT .../haengt-an`, den das Anlegen schon verwendet
 * (`AnlegenFlow.tsx`, „Wo hängt er?"), nur mit der Tages-Mechanik eines Bestandswerts (R5):
 * „schon immer" rechnet frühere Tage neu, „umgebaut am …" lässt sie, wie sie waren.
 */
export function UmhaengenDialog({
  siteId,
  component,
  komponenten,
  heute: heuteVorgabe,
  onClose,
  onSaved,
}: {
  siteId: string;
  component: PlantComponent;
  komponenten: readonly PlantComponent[];
  /** Nur für Tests: das heutige Datum, statt `new Date()`. */
  heute?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const ziele = komponenten
    .filter((k) => (k.role === 'grid' || k.entityType === 'sub-meter') && !istSelbstOderNachfahre(k.id, component.entityId, komponenten))
    .slice()
    .sort((a, b) => tiefe(a.id, komponenten) - tiefe(b.id, komponenten));
  const netzanschluss = ziele.find((k) => k.role === 'grid') ?? null;
  const [ziel, setZiel] = useState<string | null>(component.haengtAn ?? netzanschluss?.id ?? null);
  const [seitWann, setSeitWann] = useState<'schon_immer' | 'ab_tag'>('schon_immer');
  const [ab, setAb] = useState(heuteVorgabe ?? new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.haengtAnSetzen(siteId, component.entityId, {
        haengtAn: ziel === netzanschluss?.id ? null : ziel,
        seitWann,
        ab: seitWann === 'ab_tag' ? ab : undefined,
      });
      onSaved();
    } catch (e) {
      setError(messageFor(e, 'Der Zähler konnte nicht umgehängt werden.'));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Woanders anhängen"
      icon={<Icon name="link" size={20} />}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Recht aktion="geraet.einrichten">
            <Button onClick={save} disabled={busy || (seitWann === 'ab_tag' && !ab)}>
              Übernehmen
            </Button>
          </Recht>
        </>
      }
    >
      <div className="vp-form-stack">
        <p className="vp-note" style={{ marginTop: 0 }}>
          Hinter welchem Zähler hängt <strong>„{component.label}“</strong>?
        </p>

        <div className="vp-zuo-list" role="radiogroup" aria-label="Zähler wählen">
          {ziele.map((k) => (
            <label
              key={k.id}
              className={`vp-zuo-opt${ziel === k.id ? ' picked' : ''}`}
              style={{ marginLeft: `${tiefe(k.id, komponenten) * 20}px` }}
            >
              <input type="radio" name="vp-umhaengen-ziel" value={k.id} checked={ziel === k.id} onChange={() => setZiel(k.id)} />
              <span className="vp-zuo-body">
                <span className="vp-zuo-name">
                  {k.label}
                  {k === netzanschluss && <em className="vp-zuo-tag">Netzanschluss</em>}
                </span>
              </span>
            </label>
          ))}
        </div>

        <p className="vp-note">Seit wann?</p>
        <div className="vp-zuo-list" role="radiogroup" aria-label="Seit wann">
          <label className={`vp-zuo-opt${seitWann === 'schon_immer' ? ' picked' : ''}`}>
            <input
              type="radio"
              name="vp-umhaengen-seitwann"
              checked={seitWann === 'schon_immer'}
              onChange={() => setSeitWann('schon_immer')}
            />
            <span className="vp-zuo-body">
              <span className="vp-zuo-name">Schon immer so</span>
              <span className="vp-zuo-sub">Frühere Tage werden neu berechnet.</span>
            </span>
          </label>
          <label className={`vp-zuo-opt${seitWann === 'ab_tag' ? ' picked' : ''}`}>
            <input type="radio" name="vp-umhaengen-seitwann" checked={seitWann === 'ab_tag'} onChange={() => setSeitWann('ab_tag')} />
            <span className="vp-zuo-body">
              <span className="vp-zuo-name">Umgebaut am …</span>
              <span className="vp-zuo-sub">Frühere Tage bleiben, wie sie waren.</span>
            </span>
          </label>
        </div>
        {seitWann === 'ab_tag' && (
          <VpDatePicker label="Umgebaut am" value={ab} onChange={setAb} max={heuteVorgabe} disabled={busy} />
        )}

        {error && (
          <div className="vp-alert vp-alert-err" role="alert" style={{ marginTop: 0 }}>
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
