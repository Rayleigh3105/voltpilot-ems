/**
 * Die WERTE einer Messstelle als EINE Sektion (UEMS AP-13 IP-3, E9 = A): der Kopf „Zeiten in … (Zeitzone
 * des …)“ (E12 = A), die Zeit-Leiste, darunter die Karte der Periode und ihre Liste — am Tag die Stunden,
 * im Monat die Tage.
 *
 * Sie wohnt auf der Messstellen-Seite direkt unter dem Kopf. Der `WerteDialog` an den Gesamtwert-Karten
 * öffnet DIESELBE Sektion in seinem `Modal` (`rahmen`) — ein Aufbau, eine Quelle. Bis AP-13 war das der
 * Inhalt des Dialogs (AP-08 IP-11).
 *
 * Kein eigenes Gestaltungssystem: das Zeitraum-Segment der Historie (`ZeitSegment`) und `VpDatePicker` —
 * beide in EINEM Rahmen verschmolzen. Sie LIEST nur — `GET /api/v1/messstellen/{kennzeichen}/werte`
 * (AP-08 IP-9); was sie zeigt, leitet `src/uemsWerteKarte.ts` ab. Die Zone kommt aus der Antwort, nie aus
 * dem Browser.
 *
 * Mit `version` (Adresse `version=n`) fragt die KARTE genau diese Version und sagt es („Sie sehen Version 2
 * — heute die neueste“); die Liste zeigt die heutigen Werte ihrer Zeilen, denn Stunden und Tage haben eigene
 * Versionen. Wer den Zeitraum wechselt, sieht wieder die neueste — der Wirt erfährt die neue Periode über
 * `onZeitraum` und schreibt die Adresse nach.
 *
 * Seit AP-13 IP-4 (= AP-08 IP-10) trägt die Zeit-Leiste die vier Zeiträume Tag · Woche · Monat · Jahr (E5 = A) und
 * unter der Karte steht der VERLAUF im Raster der Route (`MessstellenVerlauf`, abgeleitet in `uemsVerlauf.ts`): am Tag
 * die Viertelstunden, in der Woche die Stunden, im Monat die Tage, im Jahr die Monate. Im Monat und im Jahr ist der
 * Verlauf die Liste (EINE Anfrage); am Tag und in der Woche fragt er selbst — scheitert er, bleibt die Karte stehen.
 * Die Woche hat keine Karte: die Route kennt kein Wochen-Raster, und summiert wird nie.
 *
 * Hat die Zahl der Karte zwei oder mehr Versionen, öffnet ihr Einstieg die Historie in einem gestapelten
 * Dialog (`WertVersionen`, AP-08 IP-18) — NEBEN dem Rahmen gerendert, nicht darin: React-Ereignisse
 * blubbern durch Portale, Escape und Klicks gehören dem oberen.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type MessstelleWerte } from '../api';
import { UEMS_ZEITRAEUME } from '../glossar';
import { isoTag, verschiebe } from '../picker/datum';
import { ZEITRAEUME, type Zeitraum } from '../uemsOberflaechen';
import { LISTE_TITEL, blaettere, ersterTag, gleicheAnfrage, heuteOderSpaeter, kernaussage, wertAm, zeitraumAnfragen } from '../uemsVerlauf';
import { einstieg, type Einstieg } from '../uemsWertVersionen';
import { karte, liste, versionHinweis, zeitenKopf, type Anfrage } from '../uemsWerteKarte';
import { ZeitSegment } from './HistorieWelt';
import { MessstellenVerlauf } from './MessstellenVerlauf';
import { ErrorState, Skeleton } from './States';
import { VpDatePicker } from './VpDatePicker';
import { VersionenDialog, VersionenEinstieg } from './WertVersionen';
import { WerteKarte, WerteListe } from './WerteKarte';

const ARTEN = ZEITRAEUME.map((id) => ({ id, label: UEMS_ZEITRAEUME[id] }));

const WAEHLEN: Readonly<Record<Exclude<Zeitraum, 'jahr'>, string>> = {
  tag: 'Tag wählen',
  woche: 'Woche wählen',
  monat: 'Monat wählen',
};

/** Der Weg zurück aus einer früheren Version der Adresse. */
export const NEUESTE_ZEIGEN = 'Neueste zeigen';

interface Geladen {
  schluessel: string;
  /** `null` in der Woche — sie hat keine Karte. */
  karte: MessstelleWerte | null;
  liste: MessstelleWerte;
}

// Ohne Version genau die Anfrage von vorher — die Version hängt nur an der Karte.
const hole = async (kennzeichen: string, a: Anfrage, version: number | null = null): Promise<MessstelleWerte> => {
  const antwort =
    version === null
      ? await api.messstelleWerte(kennzeichen, a.raster, a.von, a.bis)
      : await api.messstelleWerte(kennzeichen, a.raster, a.von, a.bis, version);
  // Ohne Antwort ist nichts geladen — nie eine leere Zeichnung.
  if (!antwort) throw new Error('keine Antwort');
  return antwort;
};

export function WerteSektion({
  kennzeichen,
  messstelle,
  kopf,
  anfang,
  version = null,
  heute = isoTag(new Date()),
  standortName = null,
  onZeitraum,
  rahmen = (inhalt) => inhalt,
}: {
  /** Das Kennzeichen, das die Messstelle HEUTE trägt; null = nichts gewählt, nichts geladen. */
  kennzeichen: string | null;
  /** Die Messstelle („MS-10 · Netzbezug Halle 2“) — für den Kopf der Versionen. */
  messstelle: string;
  /** Was über der Zone steht: im Dialog der Name der Messstelle, auf der Seite die Überschrift „Werte“. */
  kopf?: ReactNode;
  /** Womit die Sektion öffnet; ohne Angabe der Vortag. */
  anfang?: { art: Zeitraum; wert: string } | null;
  /** Die Version der Adresse (`version=n`) — gilt nur für die Periode, mit der die Sektion öffnet. */
  version?: number | null;
  /** Der heutige Tag (JJJJ-MM-TT) — die Grenze des Blätterns. */
  heute?: string;
  /** Der Name des Standorts für den Zone-Satz — nur, wo der Wirt ihn kennt. */
  standortName?: string | null;
  /** Die neu gewählte Periode (`JJJJ-MM-TT` · `JJJJ-Www` · `JJJJ-MM` · `JJJJ`) — die Version gilt dann nicht mehr. */
  onZeitraum?: (periode: string) => void;
  /** Der Rahmen um den Inhalt (der Dialog: sein `Modal`); die Versionen stehen daneben. */
  rahmen?: (inhalt: ReactNode) => ReactNode;
}) {
  const start = anfang ?? { art: 'tag' as Zeitraum, wert: verschiebe(heute, -1) };
  const [art, setArt] = useState<Zeitraum>(start.art);
  const [wert, setWert] = useState(start.wert);
  // Der Tag, an dem die Wahl hängt: Umschalten behält den Zeitraum (Tag → SEINE Woche, SEIN Monat, SEIN Jahr).
  const [bezug, setBezug] = useState(ersterTag(start.art, start.wert));
  const [gewaehlt, setGewaehlt] = useState<number | null>(version);
  const [geladen, setGeladen] = useState<Geladen | null>(null);
  const [fehler, setFehler] = useState(false);
  const [neu, setNeu] = useState(0);
  const [verlauf, setVerlauf] = useState<{ schluessel: string; antwort: MessstelleWerte } | null>(null);
  const [verlaufFehler, setVerlaufFehler] = useState(false);
  const [verlaufNeu, setVerlaufNeu] = useState(0);
  const [versionen, setVersionen] = useState<{ einstieg: Einstieg; periode: string } | null>(null);

  const anfragen = zeitraumAnfragen(art, wert);
  const verlaufIstListe = gleicheAnfrage(anfragen.liste, anfragen.verlauf);
  const schluessel = `${kennzeichen}|${art}|${wert}|${gewaehlt ?? 'neueste'}|${neu}`;
  const verlaufSchluessel = `${kennzeichen}|${art}|${wert}|${verlaufNeu}`;

  useEffect(() => {
    if (!kennzeichen) return;
    let aktiv = true;
    setFehler(false);
    const a = zeitraumAnfragen(art, wert);
    Promise.all([a.karte ? hole(kennzeichen, a.karte, gewaehlt) : Promise.resolve(null), hole(kennzeichen, a.liste)])
      .then(([k, l]) => aktiv && setGeladen({ schluessel, karte: k, liste: l }))
      .catch(() => aktiv && setFehler(true));
    return () => {
      aktiv = false;
    };
  }, [kennzeichen, art, wert, gewaehlt, schluessel]);

  // Der Verlauf fragt nur, wo er nicht die Liste ist (Tag, Woche) — sein Fehler nimmt der Karte nichts.
  useEffect(() => {
    if (!kennzeichen) return;
    const a = zeitraumAnfragen(art, wert);
    if (gleicheAnfrage(a.liste, a.verlauf)) return;
    let aktiv = true;
    setVerlaufFehler(false);
    hole(kennzeichen, a.verlauf)
      .then((antwort) => aktiv && setVerlauf({ schluessel: verlaufSchluessel, antwort }))
      .catch(() => aktiv && setVerlaufFehler(true));
    return () => {
      aktiv = false;
    };
  }, [kennzeichen, art, wert, verlaufSchluessel]);

  // Jede Wahl eines Zeitraums zeigt die neueste Version und wird dem Wirt gemeldet.
  const waehle = (neuArt: Zeitraum, neuWert: string) => {
    setArt(neuArt);
    setWert(neuWert);
    setBezug((b) => (wertAm(neuArt, b) === neuWert ? b : ersterTag(neuArt, neuWert)));
    setGewaehlt(null);
    onZeitraum?.(neuWert);
  };

  const umschalten = (neuArt: Zeitraum) => waehle(neuArt, wertAm(neuArt, bezug));

  const vorGesperrt = heuteOderSpaeter(art, wert, heute);
  const aktuell = geladen?.schluessel === schluessel ? geladen : null;
  const k = aktuell?.karte ? karte(aktuell.karte) : null;
  const e = aktuell?.karte ? einstieg(aktuell.karte) : null;
  const hinweis = aktuell?.karte ? versionHinweis(aktuell.karte, gewaehlt) : null;
  const frueher = hinweis !== null && gewaehlt !== aktuell?.karte?.werte[0]?.versionen;
  // Die Zone steht, sobald EINE Antwort da ist; beim Blättern bleibt die Zeile stehen, statt zu springen.
  const zone = geladen ? zeitenKopf(geladen.karte ?? geladen.liste, standortName) : null;
  const verlaufAntwort = verlaufIstListe
    ? (aktuell?.liste ?? null)
    : verlauf?.schluessel === verlaufSchluessel
      ? verlauf.antwort
      : null;

  // Oben Kopf, Zone, Zeit-Leiste, Karte und Verlauf; die Liste darunter — auf der Seite am Rechner daneben.
  const inhalt = (
    <div className="vp-wk">
      <div className="vp-wk-oben">
        {kopf}
        <p className="vp-wk-zone" data-testid="werte-zone" aria-hidden={zone ? undefined : true}>
          {zone ?? '\u00a0'}
        </p>
        {/* EIN Bedienelement (Captain 14.09.2026, Variante B): ein Kasten, oben der Zeitraum, darunter ‹ Datum ›. */}
        <div className="vp-wk-zeitwahl" role="group" aria-label="Zeitraum">
          <ZeitSegment label="Zeitraum" optionen={ARTEN} wert={art} onWert={umschalten} />
          <div className="vp-wk-datumzeile">
            <button type="button" className="vp-wk-schritt" aria-label="Vorheriger Zeitraum" onClick={() => waehle(art, blaettere(art, wert, -1))}>
              <Icon name="chevron-left" size={18} />
            </button>
            {art === 'jahr' ? (
              // Ein Jahr hat kein Kalenderblatt — blättern genügt.
              <span className="vp-wk-datum vp-wk-jahr" aria-live="polite" data-testid="werte-jahr">
                {wert}
              </span>
            ) : (
              <VpDatePicker
                ariaLabel={WAEHLEN[art]}
                art={art}
                value={wert}
                max={wertAm(art, heute)}
                onChange={(w) => waehle(art, w)}
                className="vp-wk-datum"
              />
            )}
            <button
              type="button"
              className="vp-wk-schritt"
              aria-label="Nächster Zeitraum"
              disabled={vorGesperrt}
              onClick={() => waehle(art, blaettere(art, wert, 1))}
            >
              <Icon name="chevron-right" size={18} />
            </button>
          </div>
        </div>

        {fehler ? (
          <ErrorState message="Die Werte konnten nicht geladen werden." onRetry={() => setNeu((n) => n + 1)} />
        ) : !aktuell ? (
          <div aria-busy="true">
            <Skeleton height={148} />
          </div>
        ) : (
          <>
            {hinweis && (
              <p className="vp-wk-version" role="status" data-testid="werte-version">
                <span>{hinweis}</span>
                {frueher && (
                  <button type="button" className="vp-wk-neueste" onClick={() => waehle(art, wert)}>
                    {NEUESTE_ZEIGEN}
                  </button>
                )}
              </p>
            )}
            {k && (
              <WerteKarte
                karte={k}
                grund={k.grund}
                versionen={
                  e && <VersionenEinstieg einstieg={e} onOeffnen={() => setVersionen({ einstieg: e, periode: k.titel })} />
                }
              />
            )}
            {verlaufFehler && !verlaufIstListe ? (
              <ErrorState message="Der Verlauf konnte nicht geladen werden." onRetry={() => setVerlaufNeu((n) => n + 1)} />
            ) : verlaufAntwort ? (
              <MessstellenVerlauf
                key={`${art}|${wert}`}
                antwort={verlaufAntwort}
                kern={kernaussage(art, aktuell.karte)}
                versionen={(s) => {
                  const se = einstieg({ ...verlaufAntwort, werte: [s.wert] });
                  return se && <VersionenEinstieg einstieg={se} onOeffnen={() => setVersionen({ einstieg: se, periode: s.titel })} />;
                }}
              />
            ) : (
              <div aria-busy="true">
                <Skeleton height={190} />
              </div>
            )}
          </>
        )}
      </div>
      {!fehler && aktuell && <WerteListe titel={LISTE_TITEL[art]} zeilen={liste(aktuell.liste)} />}
    </div>
  );

  return (
    <>
      {rahmen(inhalt)}
      {/* Neben dem Rahmen, nicht darin: React-Ereignisse blubbern durch Portale — Escape und Klicks gehören dem oberen. */}
      {kennzeichen && (
        <VersionenDialog
          open={versionen !== null}
          kennzeichen={kennzeichen}
          einstieg={versionen?.einstieg ?? null}
          messstelle={messstelle}
          periode={versionen?.periode ?? ''}
          onClose={() => setVersionen(null)}
        />
      )}
    </>
  );
}
