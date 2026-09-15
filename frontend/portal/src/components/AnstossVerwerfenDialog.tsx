import { useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type BerichtAnstoss } from '../api';
import {
  ABBRECHEN,
  BEGRUENDUNG,
  BEGRUENDUNG_BEISPIEL,
  BEGRUENDUNG_HINWEIS,
  begruendungFehler,
  VERWERFEN,
  verwerfenFehler,
  verwerfenVorspann,
} from '../berichtDialoge';
import './BerichtDialoge.css';

/**
 * „Anstoß verwerfen“ (UEMS AP-12 IP-14, §5.3 Punkt 4, R4/F5): der gültige Berichtsstand bleibt, der Vermerk „Revision
 * nötig“ wird zu „Anstoß verworfen (…)“. Die Begründung ist Pflicht (10 bis 500 Zeichen, wie die Route) — erst nach dem
 * ersten Senden steht der Fehler am Feld, und der Fokus geht dorthin. Verwerfen ist kein Löschen: der Anstoß bleibt im
 * Verlauf der Stände sichtbar.
 */
export function AnstossVerwerfenDialog({
  open,
  onClose,
  kennung,
  anstoss,
  nr,
  onVerworfen,
}: {
  open: boolean;
  onClose: () => void;
  kennung: string;
  /** Der offene Anstoß mit dem Satz aus dem Banner. */
  anstoss: { id: string; text: string };
  /** Der gültige Stand, an dem der Anstoß hängt. */
  nr: number;
  onVerworfen: (anstoss: BerichtAnstoss) => void;
}) {
  const basis = `vp-bd-${useId().replace(/:/g, '')}`;
  const [text, setText] = useState('');
  const [versucht, setVersucht] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const feld = useRef<HTMLInputElement>(null);
  const feldFehler = versucht ? begruendungFehler(text) : null;

  async function senden(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    setVersucht(true);
    setFehler(null);
    if (begruendungFehler(text)) {
      feld.current?.focus();
      return;
    }
    setBusy(true);
    try {
      onVerworfen(await api.berichtAnstossVerwerfen(kennung, anstoss.id, text.trim()));
    } catch (err) {
      setFehler(verwerfenFehler(err));
    } finally {
      setBusy(false);
    }
  }

  const fuss = (
    <>
      <Button variant="ghost" onClick={onClose}>
        {ABBRECHEN}
      </Button>
      <Button type="submit" form={`${basis}-form`} disabled={busy}>
        {VERWERFEN}
      </Button>
    </>
  );

  return (
    <Modal open={open} onClose={onClose} title={VERWERFEN} footer={fuss}>
      <form id={`${basis}-form`} className="vp-bd" noValidate onSubmit={(e) => void senden(e)} data-testid="anstoss-verwerfen">
        <p className="vp-bd-vorspann">{verwerfenVorspann(nr)}</p>
        <p className="vp-bd-satz">{anstoss.text}</p>
        <Input
          ref={feld}
          label={BEGRUENDUNG}
          hint={BEGRUENDUNG_HINWEIS}
          placeholder={BEGRUENDUNG_BEISPIEL}
          value={text}
          autoComplete="off"
          error={feldFehler ?? undefined}
          onChange={(e) => setText(e.target.value)}
        />
        {fehler && (
          <div className="vp-alert vp-alert-err" role="alert">
            {fehler}
          </div>
        )}
      </form>
    </Modal>
  );
}
