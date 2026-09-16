import { Recht } from './Recht';
/**
 * Die FAHRZEUGE eines Ladeparks (Verbrauchsmanagement v1 / P7) — die
 * Render-Hälfte. Jede Regel und jeder Satz liegt rein in `src/fahrzeugProfile.ts`
 * (das `VerbraucherZone`/`RanglisteKarte`-Muster); hier wird NUR gerendert.
 *
 * ⚠ Sie steht IM Ladepunkt-Abschnitt, nicht daneben: ein Fahrzeug-Profil ist
 * eine Abweichung von der Steuerart des Ladepunkts, und zwei entfernte Orte
 * für dieselbe Frage wären genau die Doppeldeutigkeit, gegen die das Programm
 * gebaut ist.
 *
 * ⚠ Ohne `onSpeichern` ist die Karte reine ANZEIGE — kein „Ändern", kein
 * Dialog. Dieselbe Haus-Regel wie bei der Rangliste: was strukturell nichts
 * bewirken kann, wird nicht angeboten.
 */
import { useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  ABSCHNITT_INTRO,
  ABSCHNITT_TITEL,
  KEINE_KARTEN,
  WAS_IST_DAS,
  fahrzeugZeilen,
  type FahrzeugWunsch,
  type SiteFahrzeuge,
} from '../fahrzeugProfile';
import { FahrzeugDialog } from './FahrzeugDialog';
import './FahrzeugeKarte.css';

export interface FahrzeugeKarteProps {
  daten: SiteFahrzeuge | null;
  /** Der NAME einer Säule, wo einer bekannt ist - nie eine erfundene Kennung. */
  ladepunktName?: (chargePointId: string) => string | null;
  /** Speichert Name und/oder Steuerart. Fehlt sie, ist die Karte lesend. */
  onSpeichern?: (tagRef: string, wunsch: FahrzeugWunsch) => Promise<void>;
  /** Nimmt das Profil zurück (die Sichtung bleibt). */
  onEntfernen?: (tagRef: string) => Promise<void>;
}

export function FahrzeugeKarte({
  daten, ladepunktName, onSpeichern, onEntfernen,
}: FahrzeugeKarteProps) {
  const [offen, setOffen] = useState(false);
  const [dialog, setDialog] = useState<string | null>(null);
  const zeilen = fahrzeugZeilen(daten, ladepunktName);
  const laden = zeilen.filter((z) => z.laedt).length;
  const gewaehlt = zeilen.find((z) => z.tagRef === dialog) ?? null;

  return (
    <div className="vp-fz">
      <button
        type="button"
        className="vp-vz-fold"
        aria-expanded={offen}
        onClick={() => setOffen((o) => !o)}
      >
        {ABSCHNITT_TITEL}
        <small className="vp-vz-sub">{zusammenfassung(zeilen.length, laden)}</small>
        <Icon name={offen ? 'chevron-down' : 'chevron-right'} size={14} />
      </button>

      {offen && (
        <div className="vp-fz-body">
          <p className="vp-fz-intro">{ABSCHNITT_INTRO}</p>
          {zeilen.length === 0 ? (
            <p className="vp-vz-quiet">{KEINE_KARTEN}</p>
          ) : (
            <>
              <p className="vp-fz-note">{WAS_IST_DAS}</p>
              <ul className="vp-vz-rows">
                {zeilen.map((z) => {
                  const inhalt = (
                    <>
                      <span className="vp-vz-name">
                        {z.name}
                        {z.laedt && <span className="vp-vz-chip on">lädt</span>}
                      </span>
                      <span className="vp-vz-chips">
                        <span className={`vp-vz-chip ${z.hatProfil ? 'src' : 'own'}`}>
                          {z.chip}
                        </span>
                        {z.sichtung && <span className="vp-vz-sub">{z.sichtung}</span>}
                        {z.ort && <span className="vp-vz-sub">{z.ort}</span>}
                      </span>
                    </>
                  );
                  return (
                    <li className="vp-vz-row" key={z.key}>
                      {onSpeichern ? (
                        <Recht aktion="ladepunkt.betrieb"><button
                          type="button"
                          className="vp-vz-text is-klick"
                          onClick={() => setDialog(z.tagRef)}
                        >
                          {inhalt}
                          <Icon name="chevron-right" size={16} />
                        </button></Recht>
                      ) : (
                        <span className="vp-vz-text">{inhalt}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}

      {gewaehlt && onSpeichern && (
        <FahrzeugDialog
          zeile={gewaehlt}
          fahrzeug={daten?.fahrzeuge.find((f) => f.tagRef === gewaehlt.tagRef) ?? null}
          onClose={() => setDialog(null)}
          onSpeichern={onSpeichern}
          onEntfernen={onEntfernen}
        />
      )}
    </div>
  );
}

/** „3 Karten · 1 lädt gerade" — nie eine Zahl ohne ihren Gegenstand. */
function zusammenfassung(anzahl: number, laden: number): string {
  if (anzahl === 0) return 'noch keine gesehen';
  const karten = `${anzahl} ${anzahl === 1 ? 'Karte' : 'Karten'}`;
  return laden > 0 ? `${karten} · ${laden} lädt gerade` : karten;
}
