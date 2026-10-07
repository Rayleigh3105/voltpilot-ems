import { useEffect, useId, useState } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import { api, type Bericht, type BerichtAnstoss, type BerichtDetail, type BerichtEntwurf, type BerichtStand, type Kennzahl, type StandortAmStichtag, type Unternehmen } from '../../api';
import {
  anlegenAnfrage,
  anlegenFehler,
  anlegenPruefen,
  ANLEGEN_LADEFEHLER,
  begruendungFehler,
  BERICHT_OEFFNEN,
  BEWERTUNG_VORLAGE,
  darf,
  ENTWURF_LADEFEHLER,
  ENTWURF_NEU_LADEN,
  freigabeAntrag,
  freigabeFehler,
  freigabeVorschau,
  geltungen,
  kennzahlenDerGeltung,
  verwerfenFehler,
  vorlageKarten,
  zeitraumVorgabe,
  zeitraumVorschau,
  zeitraumWahlen,
  ZONE_VORGABE,
  type BerichtRechte,
} from '../../berichtDialoge';
import { abzugAus, gueltigerStand } from '../../berichtSeite';
import { KEINE_ENERGIELEISTUNG, kennzahlWahlen, LEISTUNGSVERGLEICH, ZEITRAUM_ART_WORT, ausgabeFehler } from '../../leistungsvergleichBericht';
import * as N from '../../nachweisBerichte';
import { berichtRoute, hashForRoute } from '../../nav';
import { VpPicker } from '../VpPicker';
import { dateiSpeichern } from './datei';
import { ErklaerKnopf } from './ErklaerKnopf';
import { Ablehnung, BlattFormular, Fuss, basisId } from './DokumentBlaetter';
import { NwBlatt } from './NwBlatt';
import { AntwortKarten, HinweisZeile, PruefZeilen, SchrittAnzeige, WahlChips, WerteAltNeu, type WertAltNeu } from './NwSchritte';
import { NwTextfeld } from './NwTextfeld';
import { seitenLink } from './teilen';
import { Weitergeben } from './Weitergeben';
import './NwSchritte.css';
import './NwBerichte.css';

const ABBRECHEN = 'Abbrechen';
const ZURUECK = 'Zurück';
const SPAETER = 'Später freigeben';
const FERTIG = 'Fertig';
const AENDERT_SICH_NIE = 'Ändert sich danach nie mehr';

/** „Stand 1 ist freigegeben“ - die Bestätigung mit PDF und Teilen (Konzept §6.4, GOV.UK Confirmation pages). */
function Bestaetigung({ bericht, stand }: { bericht: Bericht; stand: BerichtStand }) {
  const [satz, setSatz] = useState<string | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  const name = N.berichtName(bericht);
  const pdf = async () => {
    setLaeuft(true);
    setSatz(null);
    try {
      dateiSpeichern(await api.berichtDatei(bericht.kennung, stand.nr, 'pdf'), `bericht-${bericht.kennung}-nr${stand.nr}.pdf`);
    } catch (e) {
      setSatz(ausgabeFehler(e));
    } finally {
      setLaeuft(false);
    }
  };
  return (
    <div className="vp-nw-schritt-inhalt" data-testid="bericht-bestaetigung">
      <HinweisZeile icon="check" titel={`Stand ${stand.nr} ist freigegeben`} zusatz={N.zeitText(stand.freigegeben_am, bericht.zeitzone)} testid="bericht-bestaetigung-zeile" />
      <p className="vp-nw-br-name">
        {name.titel}, Stand {stand.nr}
      </p>
      <Weitergeben
        knoepfe={[{ symbol: 'file-text', text: N.PDF, onClick: () => void pdf(), laeuft, testId: 'bestaetigung-pdf' }]}
        teilenLink={{ titel: `${name.titel}, Stand ${stand.nr}`, url: seitenLink(hashForRoute(berichtRoute(bericht.kennung))) }}
      />
      <Ablehnung satz={satz} />
    </div>
  );
}

/**
 * „Prüfen“ vor der Freigabe (Konzept §6.4, Blatt „Bericht: prüfen und freigeben“): Bericht, Für und Daten als Zeilen,
 * darunter „Ändert sich danach nie mehr“. Die Voraussetzungen sind die von F1 (`freigabeVorschau`); was fehlt, steht als
 * Satz der Route da, und der Knopf bleibt aus.
 */
function FreigabePruefen({ detail, entwurf, jetzt, aendern }: { detail: BerichtDetail; entwurf: BerichtEntwurf; jetzt: number; aendern?: { bericht: () => void; fuer: () => void } }) {
  const b = detail.bericht;
  const gueltig = gueltigerStand(detail.staende);
  const v = freigabeVorschau(freigabeAntrag(b, entwurf, detail.staende, jetzt), gueltig?.nr ?? null, abzugAus(entwurf.abzug).kopf.darstellung.zahlenformat);
  const name = N.berichtName(b);
  const daten = `${N.freigabeKurz(v.punkte)} · ${N.zeitText(entwurf.datenstand, b.zeitzone) ?? ''}`;
  return (
    <>
      <PruefZeilen
        zeilen={[
          { etikett: 'Bericht', wert: name.titel, onAendern: aendern?.bericht },
          { etikett: 'Für', wert: b.geltung_name ?? '', onAendern: aendern?.fuer },
          { etikett: 'Daten', wert: daten },
        ]}
        testid="bericht-pruefen"
      />
      {v.erlaubt ? (
        <HinweisZeile icon="lock" titel={AENDERT_SICH_NIE} zusatz={gueltig ? `Stand ${gueltig.nr} bleibt lesbar` : null} testid="bericht-pruefen-hinweis" />
      ) : (
        // Was fehlt, in vier Wörtern in „Daten“; der Satz der Route (F1) liegt hinter dem i-Knopf (Erklären auf Antippen).
        <HinweisZeile
          icon="info"
          titel="Noch nicht freigebbar"
          knopf={<ErklaerKnopf klein erklaerung={{ frage: 'Warum noch nicht?', klartext: v.satz ?? N.freigabeKurz(v.punkte) }} testId="bericht-pruefen-warum" />}
          testid="bericht-pruefen-hinweis"
        />
      )}
    </>
  );
}

const vorschauAus = (detail: BerichtDetail, entwurf: BerichtEntwurf, jetzt: number) => {
  const gueltig = gueltigerStand(detail.staende);
  return freigabeVorschau(freigabeAntrag(detail.bericht, entwurf, detail.staende, jetzt), gueltig?.nr ?? null, abzugAus(entwurf.abzug).kopf.darstellung.zahlenformat);
};

/**
 * Freigeben am Entwurf und nach einer Korrektur („Ja, Stand 2 freigeben“): Prüfen, dann die Bestätigung mit PDF. Freigegeben
 * wird genau der Entwurf, den die Person sieht (F2); hat die Kaskade ihn neu gebildet (409 `entwurf_veraltet`), lädt
 * „Entwurf neu laden“ ihn, und die Prüfung gilt für den neuen Datenstand.
 */
export function BerichtFreigebenBlatt({
  detail,
  entwurf: gesehen,
  jetzt,
  onClose,
  onFertig,
}: {
  detail: BerichtDetail;
  entwurf: BerichtEntwurf;
  jetzt: () => number;
  onClose: () => void;
  /** Nach der Bestätigung (oder dem Schließen danach): die Seite lädt den neuen Stand. */
  onFertig: (stand: BerichtStand | null) => void;
}) {
  const [entwurf, setEntwurf] = useState(gesehen);
  const [stand, setStand] = useState<BerichtStand | null>(null);
  const [fehler, setFehler] = useState<{ satz: string; neuLaden: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const basis = basisId('bf', useId());
  const v = vorschauAus(detail, entwurf, jetzt());
  const nr = v.nr;

  async function freigeben() {
    if (busy || !v.erlaubt) return;
    setBusy(true);
    setFehler(null);
    try {
      setStand(await api.berichtFreigeben(detail.bericht.kennung, entwurf.datenstand));
    } catch (e) {
      setFehler(freigabeFehler(e));
    } finally {
      setBusy(false);
    }
  }
  async function neuLaden() {
    setBusy(true);
    try {
      setEntwurf(await api.berichtEntwurf(detail.bericht.kennung));
      setFehler(null);
    } catch {
      setFehler({ satz: ENTWURF_LADEFEHLER, neuLaden: true });
    } finally {
      setBusy(false);
    }
  }

  if (stand) {
    return (
      <NwBlatt
        open
        titel={N.berichtName(detail.bericht).titel}
        onClose={() => onFertig(stand)}
        testId="bericht-freigeben-blatt"
        fuss={
          <div className="vp-nw-blatt-fuss">
            <Button onClick={() => onFertig(stand)} data-testid="bericht-fertig">
              {FERTIG}
            </Button>
          </div>
        }
      >
        <Bestaetigung bericht={detail.bericht} stand={stand} />
      </NwBlatt>
    );
  }
  return (
    <NwBlatt
      open
      titel="Prüfen"
      onClose={onClose}
      testId="bericht-freigeben-blatt"
      fuss={
        <div className="vp-nw-blatt-fuss">
          <Button type="submit" form={`${basis}-form`} disabled={busy || !v.erlaubt} aria-busy={busy || undefined} data-testid="bericht-freigeben-senden">
            Als Stand {nr} freigeben
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
        </div>
      }
    >
      <BlattFormular id={`${basis}-form`} testid="bericht-freigeben-form" onSenden={() => void freigeben()}>
        <FreigabePruefen detail={detail} entwurf={entwurf} jetzt={jetzt()} />
        {fehler && (
          <>
            <Ablehnung satz={fehler.satz} />
            {fehler.neuLaden && (
              <Button variant="outline" size="sm" onClick={() => void neuLaden()} disabled={busy}>
                {ENTWURF_NEU_LADEN}
              </Button>
            )}
          </>
        )}
      </BlattFormular>
    </NwBlatt>
  );
}

/**
 * „Nein, Stand 1 behalten“ (Entscheid 16): eine Entscheidung für alle offenen Anstöße am gültigen Stand, mit Grund
 * (10 bis 500 Zeichen, wie die Route). Der Stand bleibt; der Vermerk wird „Anstoß verworfen“ mit diesem Grund.
 */
export function BerichtBehaltenBlatt({
  detail,
  anstoesse,
  onClose,
  onFertig,
}: {
  detail: BerichtDetail;
  anstoesse: readonly BerichtAnstoss[];
  onClose: () => void;
  onFertig: () => void;
}) {
  const [grund, setGrund] = useState('');
  const [fehler, setFehler] = useState<string | null>(null);
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const basis = basisId('bb', useId());
  const nr = gueltigerStand(detail.staende)?.nr ?? 1;
  async function senden() {
    const f = begruendungFehler(grund);
    setFehler(f);
    if (f) return;
    setBusy(true);
    setSatz(null);
    try {
      // Gebündelt: ein Grund für jeden offenen Anstoß; ein schon entschiedener (409) bricht ab und sagt seinen Satz.
      for (const a of anstoesse) await api.berichtAnstossVerwerfen(detail.bericht.kennung, a.id, grund.trim());
      onFertig();
    } catch (e) {
      setSatz(verwerfenFehler(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <NwBlatt
      open
      titel={`Stand ${nr} behalten`}
      onClose={onClose}
      testId="bericht-behalten-blatt"
      fuss={<Fuss form={`${basis}-form`} primaer="Behalten" busy={busy} sekundaer={ABBRECHEN} onSekundaer={onClose} testid="bericht-behalten-senden" />}
    >
      <BlattFormular id={`${basis}-form`} testid="bericht-behalten-form" onSenden={() => void senden()}>
        <HinweisZeile icon="lock" titel={`Stand ${nr} bleibt gültig`} zusatz="Die Änderung geht nicht in den Bericht" />
        <NwTextfeld label="Warum?" wert={grund} onWert={setGrund} mehrzeilig fehler={fehler} hoechstens={500} testid="bericht-behalten-grund" />
        <Ablehnung satz={satz} />
      </BlattFormular>
    </NwBlatt>
  );
}

/** Der Grund einer Änderung im Blatt: je Korrektur eine Zeile mit Warum, wer und wann (Erklären auf Antippen). */
export function BerichtGrundBlatt({ titel, zeilen, onClose }: { titel: string; zeilen: { etikett: string; wert: string }[]; onClose: () => void }) {
  return (
    <NwBlatt open titel={titel} onClose={onClose} testId="bericht-grund-blatt">
      <div className="vp-nw-schritt-inhalt">
        <PruefZeilen zeilen={zeilen} testid="bericht-grund" />
      </div>
    </NwBlatt>
  );
}

/** Alle Werte alt → neu, wenn es mehr sind als die drei der Karte. */
export function BerichtAenderungenBlatt({ titel, werte, onClose }: { titel: string; werte: WertAltNeu[]; onClose: () => void }) {
  return (
    <NwBlatt open titel={titel} onClose={onClose} testId="bericht-aenderungen-blatt">
      <div className="vp-nw-schritt-inhalt">
        <WerteAltNeu werte={werte} testid="bericht-aenderungen" />
      </div>
    </NwBlatt>
  );
}

// ------------------------------------------------------------------ Bericht erstellen

type Art = 'monat' | 'jahr' | typeof BEWERTUNG_VORLAGE | typeof LEISTUNGSVERGLEICH;

/** Schritt 1 „Welcher?“: die Art, nicht die Vorlage - Standort oder Unternehmen ist die Frage „Für wo?“ (§6.4). */
const ARTEN: ReadonlyArray<{ art: Art; titel: string; zusatz: string; vorlagen: readonly string[] }> = [
  { art: 'monat', titel: 'Monatsbericht', zusatz: 'ein Monat', vorlagen: ['monatsbericht_standort', 'monatsbericht_unternehmen'] },
  { art: 'jahr', titel: 'Jahresbericht', zusatz: 'ein Jahr', vorlagen: ['jahresbericht_standort', 'jahresbericht_unternehmen'] },
  { art: BEWERTUNG_VORLAGE, titel: 'Energetische Bewertung', zusatz: 'jährlich', vorlagen: [BEWERTUNG_VORLAGE] },
  { art: LEISTUNGSVERGLEICH, titel: 'Leistungsvergleich', zusatz: 'Kennzahl gegen Bezugsbasis', vorlagen: [LEISTUNGSVERGLEICH] },
];

/**
 * „Bericht erstellen“ (Konzept §6.4, Runde 2): 1 Welcher? · 2 Für wo und wann? · 3 Prüfen - dann die Bestätigung mit PDF.
 * Angelegt wird beim Schritt zu „Prüfen“ (die Route bildet den Entwurf sofort, und erst er sagt, ob die Daten endgültig
 * sind); wer dort „Später freigeben“ wählt, findet den Entwurf auf seiner Seite. Wer eine Vorlage oder einen Ort nicht
 * anlegen darf, sieht sie nicht (§5.5); „Diesen Bericht gibt es schon“ bietet den Bericht an. Die energetische Bewertung
 * führt nach dem Anlegen auf ihre Seite.
 */
export function BerichtErstellenBlatt({
  onClose,
  rechte,
  standortId = null,
  jetzt = () => Date.now(),
  onFertig,
  onOeffnen,
}: {
  onClose: () => void;
  rechte: BerichtRechte | null;
  standortId?: string | null;
  jetzt?: () => number;
  onFertig: (b: Bericht) => void;
  onOeffnen: (kennung: string) => void;
}) {
  const basis = basisId('be', useId());
  const [daten, setDaten] = useState<{ standorte: StandortAmStichtag[]; unternehmen: Unternehmen | null; kennzahlen: Kennzahl[] | null } | null>(null);
  const [ladeFehler, setLadeFehler] = useState(false);
  const [versuch, setVersuch] = useState(0);
  const [schritt, setSchritt] = useState<1 | 2 | 3>(1);
  const [art, setArt] = useState<Art | null>(null);
  const [geltung, setGeltung] = useState<string | null>(null);
  const [zeitraum, setZeitraum] = useState<string | null>(null);
  const [lvArt, setLvArt] = useState<Bericht['zeitraum_art'] | null>(null);
  const [kennzahl, setKennzahl] = useState<string | null>(null);
  const [abgewaehlt, setAbgewaehlt] = useState<string[]>([]);
  const [kennzahlenOffen, setKennzahlenOffen] = useState(false);
  const [versucht, setVersucht] = useState(false);
  const [fehler, setFehler] = useState<{ satz: string; kennung: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [angelegt, setAngelegt] = useState<{ detail: BerichtDetail; entwurf: BerichtEntwurf } | null>(null);
  const [stand, setStand] = useState<BerichtStand | null>(null);
  const [freigabeSatz, setFreigabeSatz] = useState<string | null>(null);

  useEffect(() => {
    let aktiv = true;
    setLadeFehler(false);
    Promise.allSettled([api.standorte(), api.unternehmen(), api.kennzahlen()]).then(([s, u, k]) => {
      if (!aktiv) return;
      if (s.status === 'rejected') return setLadeFehler(true);
      setDaten({ standorte: s.value.standorte, unternehmen: u.status === 'fulfilled' ? u.value : null, kennzahlen: k.status === 'fulfilled' ? k.value.kennzahlen : null });
    });
    return () => {
      aktiv = false;
    };
  }, [versuch]);

  const karten = daten ? vorlageKarten(rechte, daten.standorte.map((s) => s.id)).filter((k) => standortId === null || k.geltungArten.includes('standort')) : [];
  const arten = ARTEN.filter((a) => karten.some((k) => a.vorlagen.includes(k.schluessel)));
  const gewaehlt = arten.find((a) => a.art === art) ?? (arten.length === 1 ? arten[0] : null);
  const lv = gewaehlt?.art === LEISTUNGSVERGLEICH;
  // „Für wo?“: alle Orte der gewählten Art - je Ort die passende Vorlage (Standort oder Unternehmen).
  const orte = gewaehlt && daten
    ? karten
        .filter((k) => gewaehlt.vorlagen.includes(k.schluessel))
        .flatMap((k) =>
          (lv ? k.geltungArten : [k.geltungArt]).flatMap((ga) =>
            geltungen(ga, daten.standorte, daten.unternehmen, rechte, k.schluessel).map((g) => ({ ...g, art: ga, karte: k })),
          ),
        )
        .filter((g) => standortId === null || g.id === standortId)
    : [];
  const ort = orte.find((g) => g.id === geltung) ?? (orte.length === 1 ? orte[0] : null);
  const karte = ort?.karte ?? null;
  const zone = ort?.zone ?? ZONE_VORGABE;
  const jetztMs = jetzt();
  const zArt = karte ? (lv && lvArt && karte.zeitraumArten.includes(lvArt) ? lvArt : karte.zeitraumArt) : null;
  const zeitraeume = zArt ? zeitraumWahlen(zArt, jetztMs, zone) : [];
  const zeitraumWert = zArt ? (zeitraeume.some((z) => z.id === zeitraum) ? zeitraum : zeitraumVorgabe(zArt, jetztMs, zone)) : null;
  const vorschau = zArt && zeitraumWert ? zeitraumVorschau(zArt, zeitraumWert, zone, jetztMs) : null;
  const kennzahlen = karte && ort && !lv && karte.schluessel !== BEWERTUNG_VORLAGE && daten?.kennzahlen ? kennzahlenDerGeltung(daten.kennzahlen, karte.geltungArt, ort.id) : [];
  const lvKennzahlen = lv && ort && daten?.kennzahlen ? kennzahlWahlen(daten.kennzahlen, ort.art, ort.id) : [];
  const kennzahlWert = lvKennzahlen.some((k) => k.id === kennzahl) ? kennzahl : lvKennzahlen.length === 1 ? lvKennzahlen[0].id : null;
  const wahl = { vorlage: karte?.schluessel ?? null, geltungId: ort?.id ?? null, zeitraum: zeitraumWert, abgewaehlt, kennzahl: kennzahlWert };
  const pruefung = anlegenPruefen(wahl);
  const zeigen = versucht ? pruefung : {};

  async function anlegen() {
    setVersucht(true);
    setFehler(null);
    if (Object.values(pruefung).some(Boolean) || !karte) return;
    setBusy(true);
    try {
      const b = await api.berichtAnlegen(anlegenAnfrage(wahl, kennzahlen.map((k) => k.id)));
      if (b.vorlage === BEWERTUNG_VORLAGE) return onFertig(b);
      const [detail, entwurf] = await Promise.all([api.bericht(b.kennung), api.berichtEntwurf(b.kennung)]);
      setAngelegt({ detail, entwurf });
      setSchritt(3);
    } catch (err) {
      setFehler(anlegenFehler(err));
    } finally {
      setBusy(false);
    }
  }
  async function freigeben() {
    if (!angelegt) return;
    setBusy(true);
    setFreigabeSatz(null);
    try {
      setStand(await api.berichtFreigeben(angelegt.detail.bericht.kennung, angelegt.entwurf.datenstand));
    } catch (e) {
      setFreigabeSatz(freigabeFehler(e).satz);
    } finally {
      setBusy(false);
    }
  }

  // Bestätigung
  if (angelegt && stand) {
    return (
      <NwBlatt
        open
        titel={N.berichtName(angelegt.detail.bericht).titel}
        onClose={() => onFertig(angelegt.detail.bericht)}
        testId="bericht-erstellen-blatt"
        fuss={
          <div className="vp-nw-blatt-fuss">
            <Button onClick={() => onFertig(angelegt.detail.bericht)} data-testid="bericht-fertig">
              {FERTIG}
            </Button>
          </div>
        }
      >
        <Bestaetigung bericht={angelegt.detail.bericht} stand={stand} />
      </NwBlatt>
    );
  }

  // Schritt 3: Prüfen - der Bericht ist angelegt, sein Entwurf gebildet.
  if (angelegt) {
    const b = angelegt.detail.bericht;
    const v = vorschauAus(angelegt.detail, angelegt.entwurf, jetztMs);
    const darfFreigeben = darf(rechte, 'freigeben', b.geltung_art, b.geltung_id) && v.erlaubt;
    return (
      <NwBlatt
        open
        titel="Prüfen"
        onClose={() => onFertig(b)}
        testId="bericht-erstellen-blatt"
        fuss={
          <div className="vp-nw-blatt-fuss">
            {darfFreigeben ? (
              <Button onClick={() => void freigeben()} disabled={busy} aria-busy={busy || undefined} data-testid="bericht-erstellen-freigeben">
                Als Stand {v.nr} freigeben
              </Button>
            ) : (
              <Button onClick={() => onFertig(b)} data-testid="bericht-erstellen-oeffnen">
                {N.ENTWURF} öffnen
              </Button>
            )}
            {darfFreigeben && (
              <Button variant="ghost" onClick={() => onFertig(b)} data-testid="bericht-erstellen-spaeter">
                {SPAETER}
              </Button>
            )}
          </div>
        }
      >
        <div className="vp-nw-schritt-inhalt">
          <SchrittAnzeige nr={3} von={3} />
          <FreigabePruefen detail={angelegt.detail} entwurf={angelegt.entwurf} jetzt={jetztMs} />
          <Ablehnung satz={freigabeSatz} />
        </div>
      </NwBlatt>
    );
  }

  const weiter1 = () => {
    if (!gewaehlt) return setVersucht(true);
    setVersucht(false);
    setSchritt(2);
  };
  return (
    <NwBlatt
      open
      titel={schritt === 1 ? 'Bericht erstellen' : 'Für wo und wann?'}
      onClose={onClose}
      testId="bericht-erstellen-blatt"
      fuss={
        <div className="vp-nw-blatt-fuss">
          <Button type="submit" form={`${basis}-form`} disabled={busy || !daten || arten.length === 0} aria-busy={busy || undefined} data-testid="bericht-erstellen-weiter">
            {N.WEITER}
          </Button>
          <Button variant="ghost" onClick={schritt === 1 ? onClose : () => setSchritt(1)}>
            {schritt === 1 ? ABBRECHEN : ZURUECK}
          </Button>
        </div>
      }
    >
      <BlattFormular id={`${basis}-form`} testid="bericht-erstellen-form" onSenden={() => (schritt === 1 ? weiter1() : void anlegen())}>
        <SchrittAnzeige nr={schritt} von={gewaehlt?.art === BEWERTUNG_VORLAGE ? 2 : 3} />
        {ladeFehler ? (
          <>
            <p className="vp-nw-fehler" role="alert">
              {ANLEGEN_LADEFEHLER}
            </p>
            <Button variant="outline" size="sm" onClick={() => setVersuch((x) => x + 1)}>
              Erneut versuchen
            </Button>
          </>
        ) : !daten ? (
          <p className="vp-nw-leise" aria-busy="true">
            Wird geladen …
          </p>
        ) : schritt === 1 ? (
          <AntwortKarten
            label="Welcher Bericht?"
            optionen={arten.map((a) => ({ wert: a.art, titel: a.titel, zusatz: a.zusatz }))}
            wert={gewaehlt?.art ?? null}
            onWahl={(a) => {
              setArt(a);
              setGeltung(null);
              setZeitraum(null);
            }}
            testid="bericht-erstellen-art"
          />
        ) : (
          <>
            {orte.length > 4 ? (
              <VpPicker id={`${basis}-geltung`} label="Für" options={orte.map((g) => ({ value: g.id, label: g.name }))} value={ort?.id ?? null} onChange={setGeltung} error={zeigen.geltung} />
            ) : (
              <WahlChips frage="Für" optionen={orte.map((g) => ({ wert: g.id, label: g.name }))} wert={ort?.id ?? null} onWahl={setGeltung} fehler={zeigen.geltung} testid="bericht-erstellen-fuer" />
            )}
            {lv && karte && karte.zeitraumArten.length > 1 && (
              <WahlChips
                frage="Zeitraum"
                optionen={karte.zeitraumArten.map((a) => ({ wert: a, label: ZEITRAUM_ART_WORT[a] }))}
                wert={zArt}
                onWahl={(a) => setLvArt(a as Bericht['zeitraum_art'])}
                testid="bericht-erstellen-zeitraumart"
              />
            )}
            {karte && (
              <VpPicker
                id={`${basis}-zeitraum`}
                label="Wann?"
                options={zeitraeume.map((z) => ({ value: z.id, label: z.label }))}
                value={zeitraumWert}
                onChange={setZeitraum}
                error={zeigen.zeitraum}
              />
            )}
            {lv && ort && (
              lvKennzahlen.length === 0 ? (
                <p className="vp-nw-leise" data-testid="bericht-erstellen-kennzahl-leer">
                  {KEINE_ENERGIELEISTUNG}
                </p>
              ) : (
                <VpPicker
                  id={`${basis}-kennzahl`}
                  label="Kennzahl"
                  options={lvKennzahlen.map((k) => ({ value: k.id, label: `${k.kennzeichen} ${k.name}` }))}
                  value={kennzahlWert}
                  onChange={setKennzahl}
                  error={zeigen.kennzahl}
                />
              )
            )}
            {kennzahlen.length > 0 &&
              (kennzahlenOffen ? (
                <WahlChips
                  mehrfach
                  frage="Kennzahlen"
                  optionen={kennzahlen.map((k) => ({ wert: k.id, label: k.kennzeichen }))}
                  werte={kennzahlen.filter((k) => !abgewaehlt.includes(k.id)).map((k) => k.id)}
                  onWahl={(an) => setAbgewaehlt(kennzahlen.filter((k) => !an.includes(k.id)).map((k) => k.id))}
                  testid="bericht-erstellen-kennzahlen"
                />
              ) : (
                <PruefZeilen
                  zeilen={[{ etikett: 'Kennzahlen', wert: abgewaehlt.length ? `${kennzahlen.length - abgewaehlt.length} von ${kennzahlen.length}` : `alle ${kennzahlen.length}`, onAendern: () => setKennzahlenOffen(true) }]}
                  testid="bericht-erstellen-kennzahlen-zeile"
                />
              ))}
            {vorschau?.laeuft && <HinweisZeile icon="calendar" titel="Zeitraum läuft noch" zusatz="Freigeben erst danach" testid="bericht-erstellen-laeuft" />}
            {fehler && (
              <>
                <Ablehnung satz={fehler.satz} />
                {fehler.kennung && (
                  <Button variant="outline" size="sm" onClick={() => onOeffnen(fehler.kennung as string)} data-testid="bericht-erstellen-oeffnen-vorhanden">
                    {BERICHT_OEFFNEN}
                  </Button>
                )}
              </>
            )}
          </>
        )}
      </BlattFormular>
    </NwBlatt>
  );
}
