import { useState } from 'react';
import type { UmzugMerkzettel, UmzugMerkzettelTeil } from '../api';
import { api } from '../apiVoll';
import './UmzugMerkzettelKarte.css';

export const MERKZETTEL_TITEL = 'Neues Haus? Bitte prüfen';

const TEILE: { teil: UmzugMerkzettelTeil; label: string }[] = [
  { teil: 'solaranlage', label: 'Solaranlage' },
  { teil: 'stromtarif', label: 'Stromtarif' },
  { teil: 'einspeiseverguetung', label: 'Einspeisevergütung' },
];

function erledigt(m: UmzugMerkzettel, teil: UmzugMerkzettelTeil): boolean {
  if (teil === 'solaranlage') return m.solaranlageErledigt;
  if (teil === 'stromtarif') return m.stromtarifErledigt;
  return m.einspeiseverguetungErledigt;
}

/**
 * Der Merkzettel "Neues Haus? Bitte prüfen" nach einem Umzug (vp-standort-konzept §7, E1 = B,
 * Bericht 6.6 Punkt 7) — je Anlage gespeichert, auf jedem Gerät sichtbar: dasselbe Stück steht auf
 * dem Ergebnis des Umzugs (`AnlageOrtBlatt`) UND als eigene Zeile auf "Meine Anlage"
 * (`AnlageTechnik`). "Geprüft" und "weggeklickt" sind dieselbe Handlung — ein Tipp auf einen Chip
 * erledigt NUR ihn; sind alle drei fort, verschwindet die ganze Karte (der Aufrufer liest das am
 * `onGeaendert`-Wert `null`).
 */
export function UmzugMerkzettelKarte({
  siteId,
  merkzettel,
  onGeaendert,
}: {
  siteId: string;
  merkzettel: UmzugMerkzettel;
  onGeaendert: (merkzettel: UmzugMerkzettel | null) => void;
}) {
  const [busy, setBusy] = useState<UmzugMerkzettelTeil | null>(null);
  const offen = TEILE.filter(({ teil }) => !erledigt(merkzettel, teil));
  if (offen.length === 0) return null;

  async function erledigen(teil: UmzugMerkzettelTeil) {
    setBusy(teil);
    try {
      await api.umzugMerkzettelErledigen(siteId, teil);
      const nochOffen = offen.filter(({ teil: t }) => t !== teil);
      if (nochOffen.length === 0) {
        onGeaendert(null);
        return;
      }
      const feld = teil === 'solaranlage' ? 'solaranlageErledigt'
        : teil === 'stromtarif' ? 'stromtarifErledigt' : 'einspeiseverguetungErledigt';
      onGeaendert({ ...merkzettel, [feld]: true });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="vp-umz-merkzettel" data-testid="umzug-merkzettel">
      <b>{MERKZETTEL_TITEL}</b>
      <div className="vp-umz-merkzettel-chips">
        {offen.map(({ teil, label }) => (
          <button
            key={teil}
            type="button"
            className="vp-umz-merkzettel-chip"
            disabled={busy === teil}
            aria-label={`${label}: geprüft`}
            onClick={() => void erledigen(teil)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
