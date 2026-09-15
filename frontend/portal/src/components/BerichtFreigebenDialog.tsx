import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type BerichtDetail, type BerichtEntwurf, type BerichtStand } from '../api';
import {
  ABBRECHEN,
  ENTWURF_LADEFEHLER,
  ENTWURF_NEU_LADEN,
  freigabeAntrag,
  freigabeFehler,
  freigabeVorschau,
  FREIGEBEN_TITEL,
  VORAUSSETZUNGEN_TITEL,
  WAS_SIE_FREIGEBEN,
} from '../berichtDialoge';
import { abzugAus, berichtTitel, gueltigerStand } from '../berichtSeite';
import './BerichtDialoge.css';

/**
 * „Berichtsstand freigeben“ (UEMS AP-12 IP-14, §5.2; mit gültigem Stand die Revision, §5.3): die Voraussetzungen als
 * LISTE (F1 in ihrer Reihenfolge, je mit Häkchen), der Datenstand im Text, darunter, was festgehalten wird, und der Knopf
 * „Berichtsstand Nr. n freigeben“.
 *
 * Freigegeben wird genau der Entwurf, den die Person sieht (F2): `POST …/freigeben` trägt seinen Datenstand. Hat die
 * Kaskade ihn inzwischen neu gebildet, antwortet die Route 409 `entwurf_veraltet` mit ihrem Satz — dann steht „Entwurf neu
 * laden“ da, der Dialog lädt ihn, und die Liste gilt für den neuen Datenstand. Jede Ablehnung spricht den Satz der Route.
 */
export function BerichtFreigebenDialog({
  open,
  onClose,
  detail,
  entwurf: gesehen,
  jetzt = () => Date.now(),
  onFreigegeben,
  onEntwurf,
}: {
  open: boolean;
  onClose: () => void;
  detail: BerichtDetail;
  entwurf: BerichtEntwurf;
  jetzt?: () => number;
  onFreigegeben: (stand: BerichtStand) => void;
  /** Der Dialog hat den Entwurf neu geladen — die Seite zeigt ihn dann auch. */
  onEntwurf?: (entwurf: BerichtEntwurf) => void;
}) {
  const [entwurf, setEntwurf] = useState(gesehen);
  const [fehler, setFehler] = useState<{ satz: string; neuLaden: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setEntwurf(gesehen), [gesehen]);

  const b = detail.bericht;
  const gueltig = gueltigerStand(detail.staende);
  const v = freigabeVorschau(
    freigabeAntrag(b, entwurf, detail.staende, jetzt()),
    gueltig?.nr ?? null,
    abzugAus(entwurf.abzug).kopf.darstellung.zahlenformat,
  );

  async function freigeben() {
    if (busy) return;
    setBusy(true);
    setFehler(null);
    try {
      onFreigegeben(await api.berichtFreigeben(b.kennung, entwurf.datenstand));
    } catch (e) {
      setFehler(freigabeFehler(e));
    } finally {
      setBusy(false);
    }
  }

  async function neuLaden() {
    setBusy(true);
    try {
      const neu = await api.berichtEntwurf(b.kennung);
      setEntwurf(neu);
      setFehler(null);
      onEntwurf?.(neu);
    } catch {
      setFehler({ satz: ENTWURF_LADEFEHLER, neuLaden: true });
    } finally {
      setBusy(false);
    }
  }

  const fuss = (
    <>
      <Button variant="ghost" onClick={onClose}>
        {ABBRECHEN}
      </Button>
      <Button onClick={() => void freigeben()} disabled={busy || !v.erlaubt} data-testid="bericht-freigeben-knopf">
        {v.knopf}
      </Button>
    </>
  );

  return (
    <Modal open={open} onClose={onClose} title={FREIGEBEN_TITEL} footer={fuss}>
      <div className="vp-bd" data-testid="bericht-freigeben">
        <p className="vp-bd-vorspann">
          <span className="vp-bd-kz">{b.kennung}</span>
          {berichtTitel(b)}
        </p>
        <section>
          <h3 className="vp-bd-titel">{VORAUSSETZUNGEN_TITEL}</h3>
          <ul className="vp-bd-punkte" data-testid="bericht-freigeben-voraussetzungen">
            {v.punkte.map((p) => (
              <li key={p.schluessel} className={p.erfuellt ? 'is-ok' : 'is-offen'}>
                <Icon name={p.erfuellt ? 'check' : 'x'} size={16} />
                <span>
                  {p.text}
                  <span className="vp-sr-only">{p.erfuellt ? ' — erfüllt' : ' — nicht erfüllt'}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
        {v.satz && <p className="vp-bd-satz">{v.satz}</p>}
        <section>
          <h3 className="vp-bd-titel">{WAS_SIE_FREIGEBEN}</h3>
          <p className="vp-bd-text">{v.festgehalten}.</p>
          {v.ersetzt && (
            <p className="vp-bd-ersetzt">
              <Badge variant="warn">{v.ersetzt}</Badge>
            </p>
          )}
        </section>
        {fehler && (
          <div className="vp-alert vp-alert-err vp-bd-fehler" role="alert">
            <span>{fehler.satz}</span>
            {fehler.neuLaden && (
              <Button variant="outline" size="sm" onClick={() => void neuLaden()} disabled={busy}>
                {ENTWURF_NEU_LADEN}
              </Button>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
