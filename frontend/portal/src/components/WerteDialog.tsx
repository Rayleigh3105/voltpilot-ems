/**
 * Die Tages- und Monatswerte einer Messstelle in einem Dialog (UEMS AP-08 IP-11) — der Wirt an den
 * Gesamtwert-Karten der Anlage.
 *
 * Seit AP-13 IP-3 (E9 = A) wohnt der Inhalt als `WerteSektion` auf der Messstellen-Seite; der Dialog
 * öffnet DIESELBE Sektion im zentrierten `Modal` des Hauses (am Telefon Vollbild), mit dem Namen der
 * Messstelle als erster Zeile. Kein zweiter Aufbau — was die Sektion zeigt, zeigt der Dialog.
 */
import { Modal } from '../../designsystem/components/shell/Modal';
import { isoTag } from '../picker/datum';
import type { KartenArt } from '../uemsWerteKarte';
import { WerteSektion } from './WerteSektion';

/** Die EINE Beschriftung — im Menü und im Kopf des Dialogs. */
export const WERTE_LABEL = 'Tages- und Monatswerte';

export function WerteDialog({
  open,
  kennzeichen,
  titel,
  onClose,
  anfang,
  heute = isoTag(new Date()),
}: {
  open: boolean;
  /** Das Kennzeichen, das die Messstelle HEUTE trägt; null = nichts gewählt, nichts geladen. */
  kennzeichen: string | null;
  /** Die Messstelle („MS-10 · Netzbezug Halle 2“) — erste Zeile des Dialogs, sie bricht um statt abzuschneiden. */
  titel: string;
  onClose: () => void;
  /** Womit der Dialog öffnet; ohne Angabe der Vortag. */
  anfang?: { art: KartenArt; wert: string };
  /** Der heutige Tag (JJJJ-MM-TT) — die Grenze des Blätterns. */
  heute?: string;
}) {
  if (!open) return null;
  return (
    <WerteSektion
      kennzeichen={kennzeichen}
      messstelle={titel}
      anfang={anfang}
      heute={heute}
      // Nicht im Kopf des Dialogs: dort schnitte die Kopfzeile den Namen bei 375 px ab.
      kopf={<p className="vp-wk-messstelle">{titel}</p>}
      rahmen={(inhalt) => (
        <Modal open onClose={onClose} title={WERTE_LABEL}>
          {inhalt}
        </Modal>
      )}
    />
  );
}
