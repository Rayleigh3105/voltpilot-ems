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
 * Hat die Zahl der Karte zwei oder mehr Versionen, öffnet ihr Einstieg die Historie in einem gestapelten
 * Dialog (`WertVersionen`, AP-08 IP-18) — NEBEN dem Rahmen gerendert, nicht darin: React-Ereignisse
 * blubbern durch Portale, Escape und Klicks gehören dem oberen.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type MessstelleWerte } from '../api';
import { isoMonat, isoTag, verschiebe } from '../picker/datum';
import { einstieg } from '../uemsWertVersionen';
import { anfragen, karte, liste, versionHinweis, zeitenKopf, type Anfrage, type KartenArt } from '../uemsWerteKarte';
import { ZeitSegment } from './HistorieWelt';
import { ErrorState, Skeleton } from './States';
import { VpDatePicker } from './VpDatePicker';
import { VersionenDialog, VersionenEinstieg } from './WertVersionen';
import { WerteKarte, WerteListe } from './WerteKarte';

const ARTEN = [
  { id: 'tag', label: 'Tag' },
  { id: 'monat', label: 'Monat' },
] as const;

/** Der Weg zurück aus einer früheren Version der Adresse. */
export const NEUESTE_ZEIGEN = 'Neueste zeigen';

interface Geladen {
  schluessel: string;
  karte: MessstelleWerte;
  liste: MessstelleWerte;
}

// Ohne Version genau die Anfrage von vorher — die Version hängt nur an der Karte.
const hole = (kennzeichen: string, a: Anfrage, version: number | null = null) =>
  version === null
    ? api.messstelleWerte(kennzeichen, a.raster, a.von, a.bis)
    : api.messstelleWerte(kennzeichen, a.raster, a.von, a.bis, version);

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
  anfang?: { art: KartenArt; wert: string } | null;
  /** Die Version der Adresse (`version=n`) — gilt nur für die Periode, mit der die Sektion öffnet. */
  version?: number | null;
  /** Der heutige Tag (JJJJ-MM-TT) — die Grenze des Blätterns. */
  heute?: string;
  /** Der Name des Standorts für den Zone-Satz — nur, wo der Wirt ihn kennt. */
  standortName?: string | null;
  /** Die neu gewählte Periode (`JJJJ-MM-TT` bzw. `JJJJ-MM`) — die Version gilt dann nicht mehr. */
  onZeitraum?: (periode: string) => void;
  /** Der Rahmen um den Inhalt (der Dialog: sein `Modal`); die Versionen stehen daneben. */
  rahmen?: (inhalt: ReactNode) => ReactNode;
}) {
  const [art, setArt] = useState<KartenArt>(anfang?.art ?? 'tag');
  const [tag, setTag] = useState(anfang?.art === 'tag' ? anfang.wert : verschiebe(heute, -1));
  const [monat, setMonat] = useState(anfang?.art === 'monat' ? anfang.wert : heute.slice(0, 7));
  const [gewaehlt, setGewaehlt] = useState<number | null>(version);
  const [geladen, setGeladen] = useState<Geladen | null>(null);
  const [fehler, setFehler] = useState(false);
  const [neu, setNeu] = useState(0);
  const [versionenOffen, setVersionenOffen] = useState(false);

  const wert = art === 'tag' ? tag : monat;
  const schluessel = `${kennzeichen}|${art}|${wert}|${gewaehlt ?? 'neueste'}|${neu}`;

  useEffect(() => {
    if (!kennzeichen) return;
    let aktiv = true;
    setFehler(false);
    const a = anfragen(art, wert);
    Promise.all([hole(kennzeichen, a.karte, gewaehlt), hole(kennzeichen, a.liste)])
      .then(([k, l]) => aktiv && setGeladen({ schluessel, karte: k, liste: l }))
      .catch(() => aktiv && setFehler(true));
    return () => {
      aktiv = false;
    };
  }, [kennzeichen, art, wert, gewaehlt, schluessel]);

  // Jede Wahl eines Zeitraums zeigt die neueste Version und wird dem Wirt gemeldet.
  const waehle = (neuArt: KartenArt, neuWert: string) => {
    if (neuArt === 'tag') setTag(neuWert);
    else setMonat(neuWert);
    setArt(neuArt);
    setGewaehlt(null);
    onZeitraum?.(neuWert);
  };

  const blaettern = (schritt: number) =>
    art === 'tag'
      ? waehle('tag', verschiebe(tag, schritt))
      : waehle('monat', isoMonat(new Date(Number(monat.slice(0, 4)), Number(monat.slice(5, 7)) - 1 + schritt, 1, 12)));

  // Umschalten behält den gewählten Zeitraum: vom Tag in SEINEN Monat, vom Monat auf einen Tag darin.
  const umschalten = (neuArt: KartenArt) =>
    neuArt === 'monat' ? waehle('monat', tag.slice(0, 7)) : waehle('tag', tag.slice(0, 7) === monat ? tag : `${monat}-01`);

  const vorGesperrt = art === 'tag' ? tag >= heute : monat >= heute.slice(0, 7);
  const aktuell = geladen?.schluessel === schluessel ? geladen : null;
  const k = aktuell ? karte(aktuell.karte) : null;
  const e = aktuell ? einstieg(aktuell.karte) : null;
  const hinweis = aktuell ? versionHinweis(aktuell.karte, gewaehlt) : null;
  const frueher = hinweis !== null && gewaehlt !== aktuell?.karte.werte[0]?.versionen;
  // Die Zone steht, sobald EINE Antwort da ist; beim Blättern bleibt die Zeile stehen, statt zu springen.
  const zone = geladen ? zeitenKopf(geladen.karte, standortName) : null;

  // Oben Kopf, Zone, Zeit-Leiste und Karte; die Liste darunter — auf der Seite am Rechner daneben.
  const inhalt = (
    <div className="vp-wk">
      <div className="vp-wk-oben">
        {kopf}
        <p className="vp-wk-zone" data-testid="werte-zone" aria-hidden={zone ? undefined : true}>
          {zone ?? ' '}
        </p>
        {/* EIN Bedienelement (Captain 14.09.2026, Variante B): ein Kasten, oben Tag|Monat, darunter ‹ Datum ›. */}
        <div className="vp-wk-zeitwahl" role="group" aria-label="Zeitraum">
          <ZeitSegment label="Tag oder Monat" optionen={ARTEN} wert={art} onWert={umschalten} />
          <div className="vp-wk-datumzeile">
            <button type="button" className="vp-wk-schritt" aria-label="Vorheriger Zeitraum" onClick={() => blaettern(-1)}>
              <Icon name="chevron-left" size={18} />
            </button>
            <VpDatePicker
              ariaLabel={art === 'tag' ? 'Tag wählen' : 'Monat wählen'}
              art={art}
              value={wert}
              max={art === 'tag' ? heute : heute.slice(0, 7)}
              onChange={(w) => waehle(art, w)}
              className="vp-wk-datum"
            />
            <button
              type="button"
              className="vp-wk-schritt"
              aria-label="Nächster Zeitraum"
              disabled={vorGesperrt}
              onClick={() => blaettern(1)}
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
                versionen={e && <VersionenEinstieg einstieg={e} onOeffnen={() => setVersionenOffen(true)} />}
              />
            )}
          </>
        )}
      </div>
      {!fehler && aktuell && <WerteListe titel={art === 'tag' ? 'Stunden' : 'Tage'} zeilen={liste(aktuell.liste)} />}
    </div>
  );

  return (
    <>
      {rahmen(inhalt)}
      {/* Neben dem Rahmen, nicht darin: React-Ereignisse blubbern durch Portale — Escape und Klicks gehören dem oberen. */}
      {kennzeichen && k && (
        <VersionenDialog
          open={versionenOffen && e !== null}
          kennzeichen={kennzeichen}
          einstieg={e}
          messstelle={messstelle}
          periode={k.titel}
          onClose={() => setVersionenOffen(false)}
        />
      )}
    </>
  );
}
