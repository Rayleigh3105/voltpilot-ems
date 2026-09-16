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
 *
 * Seit AP-13 IP-5 (E6 = A) trägt sie den VERGLEICH: der Umschalter `aus · Vorperiode · Vorjahr` (Adresse `v=`) legt die
 * eigene Vergangenheit blass hinter die Reihe und setzt die Δ-Zeile unter die Karte; „Weitere Messstelle“ legt bis zwei
 * PASSENDE Reihen daneben, jede mit ihrer eigenen Karte. Zwischen zwei Messstellen steht nie eine Differenz (VG4);
 * gerechnet wird ausschließlich im Zwilling `uemsBericht` (AP-12 IP-3). Ohne Register (der Dialog an den
 * Gesamtwert-Karten) gibt es den Vergleich nicht — „passend“ braucht die Hauptgrößen der anderen Messstellen.
 *
 * Seit AP-13 IP-6 sagt die Sektion, WARUM eine Zahl fehlt: unter dem Strich der Karte der Satz des Grundes (mit den
 * Namen der Bindungen aus dem Register des Wirts, `quelle`); eine abgelehnte Anfrage (400), eine Messstelle, die es
 * nicht gibt (404), und ein nicht mehr gespeicherter Wert sind AUSKÜNFTE ohne „Erneut versuchen“ — nur eine Route, die
 * nicht antwortet, ist eine Störung. Hat der ganze Zeitraum keine Datenquelle, steht statt Karte, Verlauf und Liste der
 * Leerzustand mit seinem nächsten Schritt (Z4).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, ApiError, type MessstelleRegisterZeile, type MessstelleWerte } from '../api';
import { UEMS_ZEITRAEUME } from '../glossar';
import { isoTag, verschiebe } from '../picker/datum';
import { VERLAUF_NICHT_ABRUFBAR, WERTE_NICHT_ABRUFBAR, ZEITRAEUME, auskunft, type Auskunft, type Zeitraum } from '../uemsOberflaechen';
import { LISTE_TITEL, blaettere, ersterTag, gleicheAnfrage, heuteOderSpaeter, kernaussage, wertAm, zeitraumAnfragen } from '../uemsVerlauf';
import { einstieg, type Einstieg } from '../uemsWertVersionen';
import {
  berechneteHerkunft,
  HERKUNFT_TITEL,
  karte,
  liste,
  ohneQuelle,
  ohneQuelleWeg,
  quellenNamen,
  versionHinweis,
  zeitenKopf,
  type Anfrage,
  type BerechneteHerkunft,
  type OhneQuelle,
  type OhneQuelleWeg,
} from '../uemsWerteKarte';
import { bestehenAus, VERGLEICH_AUS, wahlAus, type ReihenWahl, type VergleichWahl } from '../uemsVergleich';
import { HerkunftsZeile } from './HerkunftsZeile';
import { ZeitSegment } from './HistorieWelt';
import { MessstellenVerlauf } from './MessstellenVerlauf';
import { DeltaZeile, ReihenKarten, useVergleich, VergleichLeiste } from './WerteVergleich';
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

/** Was eine gescheiterte Anfrage sagt: Status und Körper des Servers, sonst eine Störung. */
const auskunftAus = (e: unknown, raster: Anfrage['raster']): Auskunft =>
  e instanceof ApiError ? auskunft(e.status, e.body, raster) : auskunft(null, null, raster);

export function WerteSektion({
  kennzeichen,
  messstelle,
  kopf,
  anfang,
  version = null,
  heute = isoTag(new Date()),
  standortName = null,
  quelle = null,
  register = [],
  vergleich = null,
  onVergleich,
  onQuelleZuordnen,
  onZeitraum,
  rahmen = (inhalt) => inhalt,
}: {
  /**
   * Das Register von heute — die Hauptgrößen der anderen Messstellen. Nur damit kann der Picker „Weitere Messstelle“
   * sagen, WELCHE passt und warum die anderen nicht (AP-13 IP-5, O12); ohne Register gibt es keinen Vergleich.
   */
  register?: readonly MessstelleRegisterZeile[];
  /**
   * Die Wahl des Umschalters aus der Adresse (`v=`), ROH — welche Wahl ein Zeitraum anbietet, entscheidet
   * `uemsVergleich.wahlAus`: im Jahr gibt es keine eigene „Vorperiode“ (AP-13 IP-5).
   */
  vergleich?: string | null;
  /** Eine neue Wahl des Umschalters; der Wirt schreibt sie in die Adresse. */
  onVergleich?: (w: VergleichWahl) => void;
  /**
   * Die Quelle der Messstelle im Register von heute — nur, wo der Wirt das Register kennt (die Messstellen-Seite). Sie
   * gibt dem Grund-Satz die Namen der Bindungen und dem Leerzustand ohne Datenquelle seinen nächsten Schritt.
   */
  quelle?: MessstelleRegisterZeile['quelle'] | null;
  /** „Quelle zuordnen“ im Leerzustand — nur mit Recht; ohne steht der Satz, wer es kann. */
  onQuelleZuordnen?: () => void;
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
  const [fehler, setFehler] = useState<Auskunft | null>(null);
  const [neu, setNeu] = useState(0);
  const [verlauf, setVerlauf] = useState<{ schluessel: string; antwort: MessstelleWerte } | null>(null);
  const [verlaufFehler, setVerlaufFehler] = useState<Auskunft | null>(null);
  const [verlaufNeu, setVerlaufNeu] = useState(0);
  const [versionen, setVersionen] = useState<{ einstieg: Einstieg; periode: string } | null>(null);
  // AP-13 IP-5: die gewählten weiteren Reihen leben auf der Fläche; in der Adresse steht nur die Wahl des Umschalters.
  const [reihen, setReihen] = useState<ReihenWahl[]>([]);

  const anfragen = zeitraumAnfragen(art, wert);
  const verlaufIstListe = gleicheAnfrage(anfragen.liste, anfragen.verlauf);
  const schluessel = `${kennzeichen}|${art}|${wert}|${gewaehlt ?? 'neueste'}|${neu}`;
  const verlaufSchluessel = `${kennzeichen}|${art}|${wert}|${verlaufNeu}`;

  useEffect(() => {
    if (!kennzeichen) return;
    let aktiv = true;
    setFehler(null);
    const a = zeitraumAnfragen(art, wert);
    Promise.all([a.karte ? hole(kennzeichen, a.karte, gewaehlt) : Promise.resolve(null), hole(kennzeichen, a.liste)])
      .then(([k, l]) => aktiv && setGeladen({ schluessel, karte: k, liste: l }))
      .catch((e: unknown) => aktiv && setFehler(auskunftAus(e, (a.karte ?? a.liste).raster)));
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
    setVerlaufFehler(null);
    hole(kennzeichen, a.verlauf)
      .then((antwort) => aktiv && setVerlauf({ schluessel: verlaufSchluessel, antwort }))
      .catch((e: unknown) => aktiv && setVerlaufFehler(auskunftAus(e, a.verlauf.raster)));
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
  const namen = quellenNamen(quelle);
  const k = aktuell?.karte ? karte(aktuell.karte, namen) : null;
  // Z4: der ganze Zeitraum ohne Datenquelle — Karte (falls der Zeitraum eine hat) UND Liste.
  const leer = aktuell && (aktuell.karte === null || ohneQuelle(aktuell.karte)) ? ohneQuelle(aktuell.liste) : null;
  const weg = leer ? ohneQuelleWeg(quelle, anfragen.liste.bis, heute, onQuelleZuordnen !== undefined) : null;
  const e = aktuell?.karte ? einstieg(aktuell.karte) : null;
  const hinweis = aktuell?.karte ? versionHinweis(aktuell.karte, gewaehlt) : null;
  const frueher = hinweis !== null && gewaehlt !== aktuell?.karte?.werte[0]?.versionen;
  // Die Zone steht, sobald EINE Antwort da ist; beim Blättern bleibt die Zeile stehen, statt zu springen.
  const zone = geladen ? zeitenKopf(geladen.karte ?? geladen.liste, standortName) : null;
  // AP-13 IP-11 (D4): die Herkunfts-Hülle des Schritts, den die Karte zeigt — die Periode der Sprünge ist
  // die der ADRESSE (`wert`), nicht die der Liste darunter.
  const herkunft = aktuell?.karte?.werte[0]
    ? berechneteHerkunft(aktuell.karte.werte[0], aktuell.karte.zeitzone, wert)
    : null;
  // AP-13 IP-5: die Vergleichsperiode und die weiteren Reihen — nur mit Register (der Dialog hat keines).
  // Die Hauptgröße für „passend“ kommt aus dem REGISTER — dort steht sie für jede Messstelle in derselben Schreibweise.
  const eigeneZeile = register.find((z) => z.kennzeichen === kennzeichen) ?? null;
  const vergleichbar = register.length > 0 && eigeneZeile !== null;
  const wahl = wahlAus(vergleich, art);
  const vg = useVergleich({
    kennzeichen: vergleichbar ? kennzeichen : null,
    zeitraum: art,
    wert,
    heute,
    wahl: vergleichbar ? wahl : VERGLEICH_AUS,
    reihen: vergleichbar ? reihen : [],
    eigenKarte: aktuell?.karte ?? null,
    bestehen: bestehenAus(quelle),
    register,
  });
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
          <WerteAuskunft
            auskunft={fehler}
            stoerung={WERTE_NICHT_ABRUFBAR}
            onRetry={() => setNeu((n) => n + 1)}
            onNeueste={() => waehle(art, wert)}
          />
        ) : !aktuell ? (
          <div aria-busy="true">
            <Skeleton height={148} />
          </div>
        ) : leer ? (
          <WerteLeer leer={leer} weg={weg} onAb={(tag) => waehle(art, wertAm(art, tag))} onQuelleZuordnen={onQuelleZuordnen} />
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
            {/* O11: die Δ-Zeile steht DIREKT unter der Karte — die Zahl und ihre Einordnung gehören zusammen. */}
            {vergleichbar && <DeltaZeile delta={vg.eigenDelta} />}
            {/* AP-13 IP-11 (D4): eine BERECHNETE Zahl spricht ihre Herkunft — Formel, Zeitpunkt, Version und je
                Eingang eine Zeile, die auf ihre Messstelle springt (mit dieser Periode und SEINER Version).
                An einer gemessenen Zahl trägt die Route die Hülle nicht, und dann steht hier nichts. */}
            {herkunft && <BerechneteHerkunftBlock herkunft={herkunft} />}
            {vergleichbar && (
              <VergleichLeiste
                zeitraum={art}
                wahl={wahl}
                onWahl={(w) => onVergleich?.(w)}
                basis={eigeneZeile?.hauptgroesse ?? null}
                eigenKennzeichen={kennzeichen}
                register={register}
                reihen={reihen}
                onReihen={setReihen}
                laufend={vg.laufend}
                fehler={vg.fehler}
                onErneut={vg.erneut}
              />
            )}
            {verlaufFehler && !verlaufIstListe ? (
              <WerteAuskunft auskunft={verlaufFehler} stoerung={VERLAUF_NICHT_ABRUFBAR} onRetry={() => setVerlaufNeu((n) => n + 1)} />
            ) : verlaufAntwort ? (
              <MessstellenVerlauf
                key={`${art}|${wert}`}
                antwort={verlaufAntwort}
                namen={namen}
                eigenName={messstelle}
                vergleich={vg.ueberlagerung}
                weitere={vg.reihenImBild}
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
            {/* O12: jede weitere Reihe hat ihre EIGENE Karte und ihre eigene Δ-Zeile — nie eine Differenz dazwischen. */}
            {vergleichbar && <ReihenKarten reihen={vg.weitere} />}
          </>
        )}
      </div>
      {!fehler && aktuell && !leer && <WerteListe titel={LISTE_TITEL[art]} zeilen={liste(aktuell.liste)} />}
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

/**
 * Eine gescheiterte Anfrage: eine Störung mit „Erneut versuchen“ — oder eine Auskunft (400, 404, nicht mehr gespeichert)
 * als ruhiger Satz ohne Wiederholung, denn dieselbe Anfrage gäbe dieselbe Antwort. Die Zeit-Leiste darüber bleibt der Weg.
 */
function WerteAuskunft({
  auskunft: a,
  stoerung,
  onRetry,
  onNeueste,
}: {
  auskunft: Auskunft;
  stoerung: string;
  onRetry: () => void;
  onNeueste?: () => void;
}) {
  if (a.art === 'nicht_abrufbar') return <ErrorState message={stoerung} onRetry={onRetry} />;
  return (
    <p className="vp-wk-auskunft" role="status" data-testid="werte-auskunft" data-art={a.art}>
      <span>{a.satz}</span>
      {a.art === 'abgelehnt' && a.neueste && onNeueste && (
        <button type="button" className="vp-wk-neueste" onClick={onNeueste}>
          {NEUESTE_ZEIGEN}
        </button>
      )}
    </p>
  );
}

/** Z4 · der Zeitraum ohne Datenquelle: Titel · Satz des Grundes · der nächste Schritt (kein Knopf ohne Ziel). */
function WerteLeer({
  leer,
  weg,
  onAb,
  onQuelleZuordnen,
}: {
  leer: OhneQuelle;
  weg: OhneQuelleWeg | null;
  onAb: (tag: string) => void;
  onQuelleZuordnen?: () => void;
}) {
  return (
    <section className="vp-wk-leer" aria-label={leer.titel} data-testid="werte-leer">
      <h3 className="vp-wk-leer-titel">{leer.titel}</h3>
      <p>{leer.satz}</p>
      {(weg?.art === 'ab' || weg?.art === 'hinweis') && <p data-testid="werte-leer-weg">{weg.satz}</p>}
      {weg?.art === 'ab' && weg.knopf && (
        <Button variant="outline" onClick={() => onAb(weg.tag)}>
          {weg.knopf}
        </Button>
      )}
      {weg?.art === 'zuordnen' && onQuelleZuordnen && (
        <Button variant="outline" onClick={onQuelleZuordnen}>
          {weg.knopf}
        </Button>
      )}
    </section>
  );
}

/**
 * AP-13 IP-11 (D4) — die Herkunft einer berechneten Zahl unter der Karte: die Kopfzeilen (Formel,
 * Zeitpunkt, Version), je Eingang eine Zeile mit seinem Sprung, und „ohne Angabe: …“, wo die Hülle
 * eine Lücke meldet. Ohne Satz UND ohne Lücke steht nichts — eine leere Karte ist keine Auskunft.
 */
function BerechneteHerkunftBlock({ herkunft }: { herkunft: BerechneteHerkunft }) {
  if (herkunft.zeilen.length === 0 && herkunft.eingaenge.length === 0 && herkunft.fehlt === null) return null;
  return (
    <details className="vp-wk-herkunft" data-testid="werte-herkunft">
      <summary>{HERKUNFT_TITEL}</summary>
      {herkunft.zeilen.map((z) => (
        <p key={z} className="vp-wk-herkunft-zeile">
          {z}
        </p>
      ))}
      {herkunft.eingaenge.length > 0 && (
        <ul className="vp-wk-herkunft-eingaenge">
          {herkunft.eingaenge.map((stuecke, i) => (
            <li key={stuecke.map((t) => t.text).join('') || i}>
              <HerkunftsZeile stuecke={stuecke} />
            </li>
          ))}
        </ul>
      )}
      {herkunft.fehlt && <p className="vp-wk-herkunft-fehlt">{herkunft.fehlt}</p>}
    </details>
  );
}
