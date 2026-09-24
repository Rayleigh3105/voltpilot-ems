import { Icon } from '../../designsystem/components/core/Icon';
import { UEMS_NORMGRENZE } from '../glossar';
import {
  ZIELE_MASSNAHMEN_OEFFNEN,
  ZIELE_MASSNAHMEN_TITEL,
  type VerbesserungSprung,
  type VerbesserungUebersichtBild,
} from '../verbesserungUebersicht';
import './UebersichtBausteine.css';

/**
 * UEMS AP-18 IP-19 (F2/F3, R9, R13): der Übersichts-Baustein „Ziele und Maßnahmen“ am Unternehmen — die Summe aus §5.9,
 * die übrigen Zähler und je fälligem Vorgang eine Zeile mit Sprung. Keine Nachricht, kein Läufer: die Fristen leitet der
 * Server beim Abruf ab. Alle Sätze kommen aus `verbesserungUebersicht.ts`; hier wird nur gerendert. Grenz-Satz unten (SP3).
 */
export function VerbesserungUebersichtKarte({
  bild,
  onOeffnen,
  onSprung,
}: {
  bild: VerbesserungUebersichtBild;
  onOeffnen: () => void;
  onSprung: (sprung: NonNullable<VerbesserungSprung>) => void;
}) {
  return (
    <section className="vp-ub-baustein" aria-labelledby="vp-ub-ziele-massnahmen" data-testid="baustein-ziele-massnahmen">
      <div className="vp-ub-kopf">
        <h2 id="vp-ub-ziele-massnahmen" className="vp-ub-titel">
          {ZIELE_MASSNAHMEN_TITEL}
        </h2>
        <button type="button" className="vp-ub-alle" onClick={onOeffnen}>
          {ZIELE_MASSNAHMEN_OEFFNEN}
          <Icon name="chevron-right" size={16} />
        </button>
      </div>
      <p className={`vp-ub-summe${bild.faellig ? ' is-warn' : ''}`} data-testid="ziele-massnahmen-summe">
        {bild.summe}
      </p>
      {bild.zahlen && (
        <p className="vp-ub-unter" data-testid="ziele-massnahmen-zahlen">
          {bild.zahlen}
        </p>
      )}
      {bild.zeilen.length > 0 && (
        <ul className="vp-ub-zeilen" data-testid="ziele-massnahmen-faellig">
          {bild.zeilen.map((z) => {
            const sprung = z.sprung;
            const text = (
              <>
                <span className="vp-ub-punkt" aria-hidden="true" />
                <span className="vp-ub-text">
                  <span className="vp-ub-satz">{z.satz}</span>
                </span>
              </>
            );
            return (
              <li key={z.key}>
                {sprung ? (
                  <button type="button" className="vp-ub-zeile is-warn" onClick={() => onSprung(sprung)} data-testid={`faellig-${z.key}`}>
                    {text}
                    <Icon name="chevron-right" size={16} />
                  </button>
                ) : (
                  <div className="vp-ub-zeile is-warn" data-testid={`faellig-${z.key}`}>
                    {text}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="vp-ub-hinweis">{UEMS_NORMGRENZE}</p>
    </section>
  );
}
