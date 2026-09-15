import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type Kennzahl } from '../api';
import { UEMS_VERANTWORTLICH, UEMS_ZWECK } from '../glossar';
import * as E from '../kennzahlAendern';
import { ablehnungSatz } from '../kennzahlAnlegen';
import './Gesamtwert.css';
import './KennzahlAnlegen.css';

/**
 * „Stammdaten ändern“ an der Kennzahl-Seite (UEMS AP-11 IP-15, §5.4, V4): Name, Zweck und Verantwortlich — OHNE neue
 * Fassung. `PUT /api/v1/kennzahlen/{id}` schreibt die ganzen Stammdaten mit unverändertem Kennzeichen, die Route trägt
 * den Protokolleintrag ein. Geltungsbereich und Rechenform bleiben fest; „Speichern“ erst, wenn sich etwas geändert hat.
 *
 * Render-only: jede Ableitung liegt im reinen `src/kennzahlAendern.ts`.
 */
export function KennzahlStammdatenDialog({
  open,
  kennzahl,
  onClose,
  onGespeichert,
}: {
  open: boolean;
  kennzahl: Kennzahl;
  onClose: () => void;
  onGespeichert: (neu: Kennzahl) => void;
}) {
  const [entwurf, setEntwurf] = useState<E.StammdatenEntwurf>(() => E.stammdatenEntwurf(kennzahl));
  const [laeuft, setLaeuft] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setEntwurf(E.stammdatenEntwurf(kennzahl));
    setFehler(null);
  }, [open, kennzahl]);

  const speicherbar = E.stammdatenSpeicherbar(kennzahl, entwurf);
  const speichern = async () => {
    if (!speicherbar || laeuft) return;
    setLaeuft(true);
    setFehler(null);
    try {
      onGespeichert(await api.kennzahlAendern(kennzahl.id, E.stammdatenAnfrage(kennzahl, entwurf)));
    } catch (e) {
      setFehler(ablehnungSatz(e, E.SPEICHERN_FEHLER));
    } finally {
      setLaeuft(false);
    }
  };
  const setze = (patch: Partial<E.StammdatenEntwurf>) => setEntwurf((e) => ({ ...e, ...patch }));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={E.KNOPF_STAMMDATEN}
      footer={
        <div className="vp-gw-foot">
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button onClick={speichern} disabled={!speicherbar || laeuft}>
            {laeuft ? E.SPEICHERN_LAEUFT : E.SPEICHERN}
          </Button>
        </div>
      }
    >
      <div className="vp-gw vp-kza" data-testid="kennzahl-stammdaten-dialog">
        <div className="vp-gw-step-body vp-kza-felder">
          <p className="vp-kza-kontext">
            <b>{kennzahl.kennzeichen}</b> · {kennzahl.name}
          </p>
          <p className="vp-kza-fein">{E.STAMMDATEN_SUB}</p>
          <Input
            label={E.NAME}
            value={entwurf.name}
            onChange={(ev) => setze({ name: ev.target.value })}
            error={entwurf.name.trim() === '' ? E.PFLICHT : undefined}
          />
          <Input
            label={UEMS_VERANTWORTLICH}
            value={entwurf.verantwortlich}
            onChange={(ev) => setze({ verantwortlich: ev.target.value })}
            error={entwurf.verantwortlich.trim() === '' ? E.PFLICHT : undefined}
          />
          <Input label={UEMS_ZWECK} value={entwurf.zweck} onChange={(ev) => setze({ zweck: ev.target.value })} />
          <p className="vp-kza-fein">{E.STAMMDATEN_FEST}</p>
          {fehler && (
            <p className="vp-gw-error" role="alert">
              {fehler}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
