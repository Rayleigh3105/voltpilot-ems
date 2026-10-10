/**
 * Das ÄNDERUNGSPROTOKOLL eines Ortes (UEMS AP-02 IP-14, Mockup H2) — Gebäude, Bereich oder
 * Standort — nach dem Muster des Befehls-Verlaufs: Zeit · Was (alt → neu) · gilt ab · Wer, mit
 * dem Kennzeichen „rückwirkend (n Tage)“.
 *
 * Kein neues Bauteil: die EINE Protokoll-Liste im EINEN Dialog (`ProtokollDialog`, AP-04 IP-21),
 * geladen über `GET /api/v1/orte/{id}/aenderungen` bzw. `GET /api/v1/standorte/{id}/aenderungen`.
 * Jeder Satz kommt vom Server bzw. aus `uemsProtokoll.ts`. Entschieden ist hier nur, WIE die Liste
 * für einen Ort gelesen wird:
 * - sortiert nach dem EINTRAG — eine rückwirkende Änderung von heute steht oben und trägt ihr
 *   Kennzeichen, statt zwischen den Einträgen des Tages zu verschwinden, ab dem sie gilt;
 * - am Standort nennt jede Zeile ihr Objekt (Gebäude, Bereich, Anlage), der Standort selbst nicht;
 * - hat das Objekt nur seinen Anlege-Eintrag, sagt ein Satz es (AP-02 §5.9).
 */
import { ProtokollDialog } from './ProtokollDialog';
import type { ProtokollOptionen, ProtokollZiel } from './ProtokollListe';

/** Die Achse der Orts-Protokolle: wann jemand etwas geändert hat. */
export const ORT_PROTOKOLL_ACHSE = 'eintrag' as const;

export interface OrtProtokollObjekt {
  art: 'standort' | 'gebaeude' | 'bereich';
  id: string;
  name: string;
}

export function ortProtokollOptionen(objekt: OrtProtokollObjekt): ProtokollOptionen {
  return {
    achse: ORT_PROTOKOLL_ACHSE,
    mitBezug: objekt.art === 'standort',
    ohneBezug: objekt.id,
    anlegeSatz: true,
  };
}

export function OrtAenderungen({
  open,
  objekt,
  onClose,
}: {
  open: boolean;
  objekt: OrtProtokollObjekt;
  onClose: () => void;
}) {
  const ziel: ProtokollZiel =
    objekt.art === 'standort' ? { art: 'standort', id: objekt.id } : { art: 'ort', id: objekt.id };
  return (
    <ProtokollDialog
      open={open}
      titel={objekt.name}
      ziel={ziel}
      optionen={ortProtokollOptionen(objekt)}
      onClose={onClose}
    />
  );
}
