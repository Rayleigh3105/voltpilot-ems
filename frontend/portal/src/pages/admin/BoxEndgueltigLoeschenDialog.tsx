import { useEffect, useState } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Input } from '../../../designsystem/components/forms/Input';
import { ApiError } from '../../api';
import { adminApi, type BoxEndgueltigBefund } from '../../admin/adminApi';
import { bleibtSatz, loeschenFolgen, NIE_DATEN_SATZ } from '../../boxEndgueltig';

/**
 * „Endgültig löschen" (vierter Löschweg, vp-box-endgueltig-loeschen): EIN Dialog für beide Einstiege
 * der Geräteakte (Karte „Ausgebaut" und Menü ⋯). Das Urteil kommt vom Server (nie vom Portal
 * behauptet); hat die Box Daten, zeigt der Dialog nur die ruhige Erklärung - kein Formular, kein
 * destruktiver Knopf. Löschbar wird erst nach dem ABTIPPEN der Kennung bestätigt (Gefahren-Stil,
 * Muster „Kunde endgültig entfernen" mit Namens-Abschrift).
 */
export function BoxEndgueltigLoeschenDialog({ open, boxRef, befund, onClose, onGeloescht }: {
  open: boolean;
  boxRef: string;
  /** Der Befund des Wirts (die Karte lädt ihn ohnehin); `null` = lädt noch oder ließ sich nicht laden. */
  befund: BoxEndgueltigBefund | null;
  onClose: () => void;
  onGeloescht: () => void;
}) {
  const [abschrift, setAbschrift] = useState('');
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAbschrift('');
    setFehler(null);
  }, [open]);

  async function bestaetigen() {
    if (busy || befund == null) return;
    if (abschrift.trim() !== boxRef) {
      setFehler('Die Kennung stimmt nicht überein - bitte genau abtippen.');
      return;
    }
    setBusy(true);
    setFehler(null);
    try {
      await adminApi.geraeteEndgueltigLoeschen(boxRef, befund.deviceId);
      onGeloescht();
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : 'Löschen ist gerade nicht möglich.');
      setBusy(false);
    }
  }

  const geladen = befund != null;
  const loeschbar = befund?.loeschbar === true;
  const intro = !geladen
    ? 'Der Befund ließ sich nicht laden - bitte erneut öffnen.'
    : loeschbar
      ? NIE_DATEN_SATZ
      : bleibtSatz(befund.daten);
  const folgen = loeschbar
    ? loeschenFolgen(boxRef)
    : ['Eine Box mit Daten bleibt als Historie - sie verschwindet erst mit ihrer Anlage.',
        'Soll sie nur aus den Live-Flächen verschwinden: das tut der Ausbau bereits.'];

  return (
    <ConfirmDialog
      open={open}
      title="Endgültig löschen"
      intro={intro}
      consequences={folgen}
      confirmLabel={loeschbar ? (busy ? 'Wird gelöscht …' : 'Endgültig löschen') : 'Verstanden'}
      tone={loeschbar ? 'danger' : 'neutral'}
      busy={busy || !geladen}
      onConfirm={!geladen ? () => {} : loeschbar ? bestaetigen : onClose}
      onCancel={onClose}
      extra={loeschbar && (
        <div className="vp-endgueltig-abschrift">
          <Input value={abschrift} onChange={(e) => setAbschrift(e.target.value)}
            placeholder={boxRef} aria-label="Zum Bestätigen die Kennung abtippen"
            autoComplete="off" spellCheck={false} />
          <p className="vp-muted vp-text-sm" style={{ margin: '4px 0 0' }}>
            Zum Bestätigen die Kennung <span className="vp-mono">{boxRef}</span> abtippen.
          </p>
          {fehler && <p className="vp-feld-fehler" role="alert" style={{ marginBottom: 0 }}>{fehler}</p>}
        </div>
      )}
    />
  );
}
