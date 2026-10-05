import { Icon } from '../../designsystem/components/core/Icon';
import { seitenSprung, springeUeberHash, sprungKlick, type Sprung } from '../entscheid';
import { UEMS_KEINE_FRIST_UEBERFAELLIG, UEMS_NAECHSTE_FRISTEN, UEMS_WOHER_FRISTEN } from '../glossar';
import { energiemanagementRoute } from '../nav';
import {
  danachSatz,
  markeBald,
  markeUeberfaellig,
  nichtsBald,
  WAS_STEHT_AN,
  WAS_STEHT_AN_SATZ,
  weitereAufgaben,
  WOHER_SATZ,
  ZUR_WIEDERVORLAGE,
  type WasStehtAnBild,
} from '../wiedervorlage';
import { FristDatum, Kennzeichentext } from './FristDatum';
import { GrenzSatz } from './GrenzSatz';
import './kacheln/Kacheln.css';
import './UebersichtBausteine.css';
import './Wiedervorlage.css';

/**
 * „Was steht an“ auf der Übersicht des Unternehmens (UEMS AP-19 IP-21, WV5; Konzept Wiedervorlage w1, Variante A):
 * ruhig im Normalfall, deutlich bei Überfälligem. Ein Satz sagt, was das ist; Marken zählen Einträge; bei Überfälligem
 * höchstens vier Zeilen, gebündelt nach Aufgabe („4 Bezugsbasen überprüfen“), je mit Datum und Grund. Eine Zeile mit
 * einem Eintrag öffnet sein Objekt mit offenem Entscheid, ein Bündel die Wiedervorlage mit genau diesem Filter. Ist
 * nichts überfällig, stehen die nächsten Fristen da. Kalender-Abzug und Hinweise wohnen in der Wiedervorlage; Grenz-
 * und Verantwortungs-Satz stehen auf der Übersicht einmal unten (K7: `GrenzSatz` schweigt im Bereich).
 */
export function EnergiemanagementBaustein({
  bild,
  onOeffnen,
  springe = springeUeberHash,
}: {
  bild: WasStehtAnBild;
  onOeffnen: () => void;
  /** Der Sprung einer Zeile; ohne Angabe über die Adresse (`entscheid.ts`). */
  springe?: (s: Sprung) => void;
}) {
  const ruhig = bild.ueberfaellig === 0;
  const zurListe = seitenSprung(energiemanagementRoute('wiedervorlage'));
  return (
    <section className="vp-ub-baustein vp-wsa" aria-labelledby="vp-ub-energiemanagement" data-testid="baustein-energiemanagement">
      <div className="vp-ub-kopf">
        <h2 id="vp-ub-energiemanagement" className="vp-ub-titel">
          {WAS_STEHT_AN}
        </h2>
        <button type="button" className="vp-ub-alle" onClick={onOeffnen}>
          {ZUR_WIEDERVORLAGE}
          <Icon name="chevron-right" size={16} />
        </button>
      </div>
      <div className="vp-wsa-lead">
        <p className="vp-wsa-satz">{WAS_STEHT_AN_SATZ}</p>
        <div className="vp-wv-marken vp-k-farben" data-testid="energiemanagement-marken">
          {ruhig ? (
            <span className="vp-k-marke is-ok">
              <span className="vp-wv-punkt" aria-hidden="true" />
              {UEMS_KEINE_FRIST_UEBERFAELLIG}
            </span>
          ) : (
            <span className="vp-k-marke is-warn">{markeUeberfaellig(bild.ueberfaellig)}</span>
          )}
          {bild.bald > 0 && <span className="vp-k-marke">{markeBald(bild.bald, bild.vorschauTage)}</span>}
        </div>
      </div>
      {ruhig && bild.zeilen.length > 0 && <p className="vp-wsa-unter">{UEMS_NAECHSTE_FRISTEN}</p>}
      {bild.zeilen.length > 0 ? (
        <ul className="vp-fzl" data-testid="was-steht-an">
          {bild.zeilen.map((z) => {
            const inhalt = (
              <>
                <FristDatum {...z.frist} ton={z.frist.ueberfaellig ? 'ueber' : 'bald'} />
                <span className="vp-fz-text">
                  <span className="vp-fz-titel">
                    <Kennzeichentext text={z.aufgabe} />
                  </span>
                  <span className="vp-fz-grund">
                    <Kennzeichentext text={z.frist.relativ && !z.frist.ueberfaellig ? `${z.grund} · ${z.frist.relativ}` : z.grund} />
                  </span>
                </span>
              </>
            );
            return (
              <li key={z.key}>
                {z.sprung ? (
                  <a className="vp-fz" href={z.sprung.hash} onClick={sprungKlick(z.sprung, springe)} data-testid={`was-steht-an-${z.key}`}>
                    {inhalt}
                    <span className="vp-fz-schritt">
                      {z.schritt}
                      <span aria-hidden="true"> ›</span>
                    </span>
                    <span className="vp-fz-chev" aria-hidden="true">
                      <Icon name="chevron-right" size={18} />
                    </span>
                  </a>
                ) : (
                  <div className="vp-fz" data-testid={`was-steht-an-${z.key}`}>
                    {inhalt}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="vp-wsa-ruhe" data-testid="was-steht-an-ruhe">
          {[nichtsBald(bild.fensterBis), bild.spaeter > 0 ? danachSatz(bild.spaeter) : null].filter(Boolean).join(' ')}
        </p>
      )}
      {bild.weitere > 0 && (
        <p className="vp-wsa-weitere">
          <a className="vp-wv-link" href={zurListe.hash} onClick={sprungKlick(zurListe, springe)} data-testid="was-steht-an-weitere">
            {weitereAufgaben(bild.weitere)}
            <span aria-hidden="true"> ›</span>
          </a>
        </p>
      )}
      <details className="vp-wv-woher" data-testid="was-steht-an-woher">
        <summary>
          <Icon name="info" size={15} />
          {UEMS_WOHER_FRISTEN}
        </summary>
        <p>{WOHER_SATZ}</p>
      </details>
      <GrenzSatz className="vp-ub-hinweis" verantwortung />
    </section>
  );
}
