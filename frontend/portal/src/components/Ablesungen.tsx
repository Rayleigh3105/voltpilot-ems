import { useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import type { Ablesung, AblesungAntwort } from '../api';
import { ABLESUNGEN, alleText, type AblesungZeile } from '../messstelleSeite';
import { useRollen } from '../rollen';
import { betrag, periodenText, zeitText } from '../werteEingabe';
import { RowMenu } from './RowMenu';
import './WerteEingabe.css';

/** So viele Ablesungen stehen, bis jemand „Alle n“ öffnet (Konzept Messen m1, §6.4 Punkt 6). */
export const SICHTBAR = 3;

/**
 * Die Ablesungen einer Messstelle (Konzept Messen m1, §6.4 Punkt 6): die neueste zuerst, drei mit Datumsblock, dem
 * Monat, zu dem sie zählt, und dessen Menge; „Alle n“ öffnet die übrigen. Berichtigen und die Fassungen liegen im Menü
 * der Zeile. Eingetragen wird oben auf der Seite („Ablesung eintragen“); den Dialog hält die Seite, hier wird nur gezeigt.
 */
export function Ablesungen({
  kennzeichen,
  einheit,
  zone,
  archiviert = false,
  alle,
  zeilen,
  fehler,
  antwort,
  onErneut,
  onBerichtigen,
}: {
  kennzeichen: string;
  einheit: string;
  zone: string;
  archiviert?: boolean;
  /** Alle Fassungen aller Ablesungen (die Fassungen je Zeile); `null` = lädt. */
  alle: Ablesung[] | null;
  /** Die wirksamen Ablesungen, die neueste zuerst (`messstelleSeite.ablesungZeilen`). */
  zeilen: AblesungZeile[];
  fehler: boolean;
  /** Die Antwort des Servers auf die letzte Eintragung - bestätigt mit der Menge des Zeitraums. */
  antwort: AblesungAntwort | null;
  onErneut: () => void;
  onBerichtigen: (a: Ablesung, ausloeser: HTMLElement | null) => void;
}) {
  const [offen, setOffen] = useState(false);
  const [fassungen, setFassungen] = useState<string | null>(null);
  const { darf } = useRollen();
  const erlaubt = !archiviert && darf('ablesung.erfassen');
  const sichtbar = offen ? zeilen : zeilen.slice(0, SICHTBAR);
  return (
    <section className="vp-mss-karte vp-mss-ablesungen" aria-labelledby={`vp-mss-ablesungen-${kennzeichen}`} data-testid="ablesungen">
      <div className="vp-mss-karte-kopf">
        <h2 id={`vp-mss-ablesungen-${kennzeichen}`}>{ABLESUNGEN}</h2>
        {zeilen.length > SICHTBAR && (
          <button type="button" className="vp-mss-link" aria-expanded={offen} onClick={() => setOffen((o) => !o)}>
            {offen ? 'Weniger' : `${alleText(zeilen.length)} ›`}
          </button>
        )}
      </div>
      {fehler ? (
        <>
          <p role="alert">Die Ablesungen konnten nicht geladen werden.</p>
          <Button variant="outline" onClick={onErneut}>
            Erneut versuchen
          </Button>
        </>
      ) : !alle ? (
        <p role="status">Ablesungen werden geladen …</p>
      ) : (
        <>
          {antwort && <AntwortSatz antwort={antwort} einheit={einheit} zone={zone} />}
          {zeilen.length === 0 && (
            <p className="vp-mss-leise">
              Noch keine Ablesungen.{erlaubt && ' Tragen Sie den ersten Zählerstand ein.'}
            </p>
          )}
          <ol className="vp-mss-ablesung-liste">
            {sichtbar.map((z) => (
              <li key={z.zeitpunkt} className="vp-mss-ablesung" data-testid="ablesung-zeile">
                <span className="vp-mss-datum" aria-hidden="true">
                  <b>{z.tag}</b>
                  <span>{z.jahr}</span>
                </span>
                <span className="vp-mss-ablesung-text">
                  <strong>{z.stand}</strong>
                  <span className="vp-mss-leise">{z.neben}</span>
                  <span className="vp-sr-only">{zeitText(z.zeitpunkt, zone)}</span>
                </span>
                <RowMenu
                  label={`Ablesung vom ${zeitText(z.zeitpunkt, zone)}`}
                  items={[
                    ...(erlaubt
                      ? [{ label: 'Berichtigen', icon: 'pencil' as const, onClick: () => onBerichtigen(z.ablesung, document.activeElement as HTMLElement | null) }]
                      : []),
                    {
                      label: fassungen === z.zeitpunkt ? 'Fassungen ausblenden' : 'Fassungen ansehen',
                      icon: 'history' as const,
                      onClick: () => setFassungen((f) => (f === z.zeitpunkt ? null : z.zeitpunkt)),
                    },
                  ]}
                />
                {fassungen === z.zeitpunkt && (
                  <div className="vp-mss-fassungen">
                    {alle
                      .filter((f) => f.zeitpunkt === z.zeitpunkt)
                      .map((f) => (
                        <div className="vp-wert-fassung" key={f.fassung}>
                          <strong>
                            Fassung {f.fassung} · {betrag(f.stand)} {einheit}
                          </strong>
                          <p>
                            {f.woher === 'import' ? 'Importiert' : 'Eingegeben'} · {f.urheber.name} · {zeitText(f.eingetragen_am, zone)}
                          </p>
                          <p>
                            {f.monat ? `Gilt für ${periodenText(f.monat.slice(0, 7), 'monat')}` : 'Keinem Monat zugeordnet'}
                            {f.korrektur ? ` · ${f.korrektur}` : ''}
                          </p>
                        </div>
                      ))}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

/**
 * Nach dem Speichern bestätigt die Antwort des Servers mit der Menge des Zeitraums (Konzept §6.5): „Ablesung
 * gespeichert · 13.700 kWh seit der letzten Ablesung“. Ein Vorschlag und eine Wiederholung sagen, was gilt.
 */
function AntwortSatz({ antwort, einheit, zone }: { antwort: AblesungAntwort; einheit: string; zone: string }) {
  const satz =
    antwort.urteil === 'vorschlag'
      ? 'Vorschlag gesendet — bis zur Freigabe gilt der bisherige Stand.'
      : antwort.urteil === 'wiederholung'
        ? 'Diese Ablesung ist bereits gespeichert.'
        : 'Ablesung gespeichert.';
  const menge = antwort.ablesezeitraum?.menge;
  return (
    <div role="status" className="vp-mss-antwort">
      <p>
        {satz} {antwort.korrektur}
      </p>
      {antwort.ablesezeitraum && (
        <p className="vp-mss-leise">
          {menge === null || menge === undefined ? antwort.ablesezeitraum.zustand : `${betrag(menge)} ${einheit} seit der letzten Ablesung`}
          {' · '}
          {zeitText(antwort.ablesung.zeitpunkt, zone)}
        </p>
      )}
    </div>
  );
}
