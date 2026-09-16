import { Recht } from './Recht';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import {
  api,
  type Device,
  type Funktionen,
  type MessstelleRegisterZeile,
  type MessstelleVorschlagsliste,
  type OrtsbaumAmStichtag,
  type Site,
  type StandortAmStichtag,
  type StandorteAmStichtag,
  type Unternehmen,
} from '../api';
import { standortWahl } from '../anlageStandort';
import {
  adresseFehlt,
  adresseFehltSatz,
  alleGewaehlt,
  ANDEREN_STANDORT,
  anlagenAmStandort,
  auswahlSatz,
  browserSpeicher,
  entwurfLesen,
  entwurfSchreiben,
  entwurfVerwerfen,
  ERNEUT_PRUEFEN,
  FERTIG,
  FERTIG_AUSWERTUNG,
  FERTIG_WEITERE,
  fertigSatz,
  GEBAUTE_SCHRITTE,
  GERAET_ANBINDEN,
  GERAET_ANBINDEN_SATZ,
  GERAET_VERBINDEN,
  GERAET_VERBINDEN_SATZ,
  hauptzaehlerFehlt,
  istBereitsAngelegt,
  istVorschlagGeaendert,
  KENNZEICHEN_AUTOMATISCH,
  keineAnlageSatz,
  keineAnlageWeg,
  komponentenSatz,
  MESSEN_SCHRITTE,
  MESSEN_TITEL,
  MESSEN_TITEL_KURZ,
  messenEingerichtet,
  messenPruefliste,
  MESSSTELLEN_ANSEHEN,
  mussEinrichten,
  nameLeerSatz,
  NICHT_VORGESCHLAGEN,
  ortFehlerSatz,
  ortKorrekturen,
  ortWahlenAm,
  SCHRITT1_FRAGE,
  SCHRITT1_SATZ,
  SCHRITT2_FRAGE,
  SCHRITT2_SATZ,
  SCHRITT3_FRAGE,
  SCHRITT3_SATZ,
  SCHRITT4_FRAGE,
  SCHRITT4_SATZ,
  SPAETER_FORTSETZEN,
  SPAETER_SATZ,
  STANDORT_ANLEGEN,
  STANDORT_KEINER,
  STANDORT_WAEHLEN,
  standortMessenSatz,
  startSchritt,
  stellungWort,
  UEBERNEHMEN,
  UEBERNEHMEN_FEHLER,
  uebernahmeSatz,
  uebernehmenAnfrage,
  vor,
  VORSCHLAG_LADEFEHLER,
  vorschlaegeJeAnlage,
  vorschlagSchluessel,
  ZUR_DATENQUELLE,
  zurueck,
  type EntwurfSpeicher,
  type MessenSchritt,
  type MessenWegZiel,
} from '../messenAssistent';
import { ortOptionen } from '../messstelleDialog';
import { hashForRoute, standortMessstellenRoute } from '../nav';
import { useIsPhone } from '../useIsPhone';
import { AnlegenDialog } from './AnlegenDialog';
import { AnlegenFlow } from './AnlegenFlow';
import { AddDeviceDrawer } from './DeviceDrawers';
import { StandortDialog } from './StandortDialog';
import { VpPicker } from './VpPicker';
import './MessenAssistent.css';

/**
 * Der Assistent „Messen & Auswerten" je Standort (UEMS AP-01 IP-9a/IP-9b,
 * Konzept §5.2) — der RAHMEN mit den Schritten 1 und 2 (IP-9a) und die
 * Schritte 3 bis 5 (IP-9b): die Vorschlagsliste des Servers wird gewählt,
 * umbenannt, verortet und über die AP-04-Routen gespeichert; die Prüfliste
 * urteilt mit den Wörtern der Regel `messen()` und spricht in Fakten; „Fertig"
 * löscht den Entwurf. Kein Start-Knopf — Messen wird mit der Einrichtung aktiv.
 *
 *
 * <b>Nichts ist nachgebaut.</b> Die Schale ist der Anlege-Dialog
 * (`AnlegenDialog`: Schrittleiste am Rechner, „Schritt n von 5" plus Balken am
 * Telefon, Fokusfalle, klebender Fuß). Schritt 1 wählt über `VpPicker` und legt
 * über den Standort-Dialog aus AP-02 an; „Weiter" erzeugt die Standort-Funktion
 * (`PUT …/funktionen/messen`). Schritt 2 öffnet je Anlage die bestehenden Wege
 * „Gerät verbinden" (`AddDeviceDrawer`) und „Gerät anbinden" (der
 * Komponenten-Assistent `AnlegenFlow`). Solange ein Unterablauf offen ist,
 * ERSETZT er die Schale: das Haus-`Modal` liegt mit seinem Schleier auf Ebene 60,
 * die Schale auf 61 — gestapelt stünde „Gerät hinzufügen" UNTER dem Assistenten
 * (im Browser-Durchstich bei 1440 px gefunden). Zustand, Wahl und Schritt leben
 * hier, nicht in der Schale; nach dem Schließen steht sie wieder da und liest nach.
 *
 * <b>⚠ Steuern-Regel (Captain 14./15.09.2026).</b> Kein Schritt spricht von
 * Steuern oder Geld. Darum bindet Schritt 2 den Anlage-Assistenten NICHT ein
 * (er fragt nach Netzladen, Einspeiseleistung und Betriebsmodell): hängt am
 * Standort keine Anlage, nennt der Schritt den Zustand und den Weg dorthin —
 * als Hinweis ohne Knopf (firstmate 002, Entscheid A).
 *
 * <b>⚠ Schritte 3 bis 5 (IP-9b).</b> Die Leiste zeigt alle fünf; betreten wird
 * nur, was `gebaut` nennt. Ein neuer Schritt rendert hier seinen Rumpf und
 * ergänzt `GEBAUTE_SCHRITTE` — der Fuß von Schritt 2 wird dann von selbst
 * „Weiter" statt „Später fortsetzen".
 *
 * Schließen ist Abbrechen: der Entwurf (Standort + Schritt) bleibt im Browser,
 * die Funktion am Server — der Wiedereinstieg landet auf dem richtigen Schritt.
 */

type Unterfluss =
  | { art: 'standort'; standort: StandortAmStichtag | null }
  | { art: 'geraet'; site: Site }
  | { art: 'komponente'; siteId: string };

const LADEFEHLER = 'Die Standorte konnten nicht geladen werden.';
const EINRICHTEN_FEHLER = 'Messen & Auswerten konnte nicht angelegt werden. Bitte versuchen Sie es erneut.';
const ANLAGE_FEHLER = 'Die Anlage konnte nicht geladen werden. Bitte versuchen Sie es erneut.';
const ORT_FEHLER = 'Der Ort konnte nicht gespeichert werden.';
const PRUEF_LADEFEHLER = 'Die Prüfliste konnte nicht geladen werden. Bitte versuchen Sie es erneut.';

export function MessenAssistent({
  standortId: vorwahl = null,
  gebaut = GEBAUTE_SCHRITTE,
  speicher,
  onClose,
}: {
  /** Der Standort, aus dessen Zeile der Assistent geöffnet wurde; ohne: der des Entwurfs. */
  standortId?: string | null;
  /** Die Schritte, die eine Fläche trägt (IP-9a: 1 und 2). */
  gebaut?: readonly MessenSchritt[];
  /** Wo der Entwurf liegt; ohne Angabe der Speicher des Browsers, `null` = keiner. */
  speicher?: EntwurfSpeicher | null;
  /** Schließen = Abbrechen; der Entwurf bleibt. */
  onClose: () => void;
}) {
  const basis = `vp-ma-${useId().replace(/:/g, '')}`;
  const isPhone = useIsPhone();
  const [ablage] = useState<EntwurfSpeicher | null>(() => (speicher === undefined ? browserSpeicher() : speicher));
  const [liste, setListe] = useState<StandorteAmStichtag | null>(null);
  const [unternehmen, setUnternehmen] = useState<Unternehmen | null>(null);
  const [funktionen, setFunktionen] = useState<Funktionen | null>(null);
  /** Standorte, deren Funktion diese Sitzung schon kennt — Schritt 1 fragt dort nie ein zweites Mal. */
  const [angelegt, setAngelegt] = useState<ReadonlySet<string>>(() => new Set());
  const [ladeFehler, setLadeFehler] = useState<string | null>(null);
  const [runde, setRunde] = useState(0);
  /** `null` = der Start ist noch nicht bestimmt (es wird geladen). */
  const [schritt, setSchritt] = useState<MessenSchritt | null>(null);
  const [standortId, setStandortId] = useState<string | null>(null);
  const [pflicht, setPflicht] = useState<string | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unterfluss, setUnterfluss] = useState<Unterfluss | null>(null);
  const [sites, setSites] = useState<Site[] | null>(null);
  const [komponenten, setKomponenten] = useState<Record<string, number | null>>({});
  // Schritt 3: die Liste des Servers, die Wahl je Zeile (gewählt, Name, Ort) und der Ortsbaum.
  const [vorschlag, setVorschlag] = useState<MessstelleVorschlagsliste | null>(null);
  const [vorschlagFehler, setVorschlagFehler] = useState<string | null>(null);
  const [vorschlagRunde, setVorschlagRunde] = useState(0);
  const [gewaehlt, setGewaehlt] = useState<ReadonlySet<string>>(() => new Set());
  const [namen, setNamen] = useState<Record<string, string>>({});
  const [orte, setOrte] = useState<Record<string, string>>({});
  const [baum, setBaum] = useState<OrtsbaumAmStichtag | null>(null);
  /** Ort-Korrekturen, die nach der Übernahme scheiterten — die Messstellen stehen, nur ihr Ort nicht. */
  const [ortFehler, setOrtFehler] = useState<string[] | null>(null);
  const [uebernommen, setUebernommen] = useState<{ neu: number; unveraendert: number } | null>(null);
  // Schritt 4: die Fakten der Prüfliste, frisch gelesen.
  const [register, setRegister] = useState<MessstelleRegisterZeile[] | null>(null);
  const [geraete, setGeraete] = useState<Device[] | null>(null);
  const [geprueft, setGeprueft] = useState(false);
  const [pruefRunde, setPruefRunde] = useState(0);
  const gestartet = useRef(false);
  const fehlerRef = useRef<HTMLParagraphElement | null>(null);

  // Standorte, Unternehmen und Funktionen; der Start wird EINMAL bestimmt, danach liest jede Runde nur nach.
  useEffect(() => {
    let aktiv = true;
    setLadeFehler(null);
    Promise.all([api.standorte(), api.unternehmen().catch(() => null), api.funktionen().catch(() => null)]).then(
      ([l, u, f]) => {
        if (!aktiv) return;
        setListe(l);
        setUnternehmen(u);
        setFunktionen(f);
        if (gestartet.current) return;
        gestartet.current = true;
        const start = startSchritt({ standortId: vorwahl, funktionen: f, entwurf: entwurfLesen(ablage), gebaut });
        setStandortId(start.standortId ?? standortWahl(l)?.vorbelegt ?? null);
        setSchritt(start.schritt);
      },
      (e: unknown) => {
        if (aktiv) setLadeFehler(e instanceof Error && e.message ? e.message : LADEFEHLER);
      },
    );
    return () => {
      aktiv = false;
    };
  }, [runde, vorwahl, ablage, gebaut]);

  // Der Entwurf folgt jeder Wahl und jedem Schritt — ein Abbruch verliert nichts.
  // „Fertig" löscht ihn: danach gibt es nichts mehr fortzusetzen.
  useEffect(() => {
    if (schritt === null) return;
    if (schritt === 5) entwurfVerwerfen(ablage);
    else entwurfSchreiben(ablage, { standortId, schritt });
  }, [ablage, standortId, schritt]);

  const st = liste?.standorte.find((s) => s.id === standortId) ?? null;
  const wahl = standortWahl(liste);
  const fs = standortId ? (funktionen?.standorte.find((s) => s.id === standortId) ?? null) : null;
  const anlagen = anlagenAmStandort(st);
  const anlagenKennung = anlagen.map((a) => a.id).join(',');

  // Schritt 2: die Anlagen für „Gerät verbinden" und je Anlage die Zahl ihrer Komponenten.
  useEffect(() => {
    if (schritt !== 2 || !anlagenKennung) return;
    let aktiv = true;
    api.listSites().then((antwort) => antwort.eintraege).then(
      (s) => {
        if (aktiv) setSites(s);
      },
      () => {
        if (aktiv) setSites(null);
      },
    );
    for (const id of anlagenKennung.split(',')) {
      api.siteComponents(id).then(
        (r) => {
          if (aktiv) setKomponenten((k) => ({ ...k, [id]: r.components.length }));
        },
        () => {
          if (aktiv) setKomponenten((k) => ({ ...k, [id]: null }));
        },
      );
    }
    return () => {
      aktiv = false;
    };
  }, [schritt, anlagenKennung, runde]);

  // Schritt 3: die Vorschläge des Servers und der Ortsbaum des Standorts (für Gebäude und Bereich).
  useEffect(() => {
    if (schritt !== 3 || !standortId) return;
    let aktiv = true;
    setVorschlag(null);
    setVorschlagFehler(null);
    setOrtFehler(null);
    api.messstellenVorschlag(standortId).then(
      (l) => {
        if (!aktiv) return;
        setVorschlag(l);
        setGewaehlt(alleGewaehlt(l));
        setNamen({});
        setOrte({});
      },
      (e: unknown) => {
        if (aktiv) setVorschlagFehler(e instanceof Error && e.message ? e.message : VORSCHLAG_LADEFEHLER);
      },
    );
    api.standortOrte(standortId).then(
      (b) => {
        if (aktiv) setBaum(b);
      },
      () => {
        if (aktiv) setBaum(null);
      },
    );
    return () => {
      aktiv = false;
    };
  }, [schritt, standortId, vorschlagRunde]);

  // Schritt 4: das Urteil (Funktion, Standort) und die Fakten (Register, Boxen) frisch vom Server.
  useEffect(() => {
    if (schritt !== 4 || !standortId) return;
    let aktiv = true;
    setGeprueft(false);
    Promise.all([
      api.funktionen().catch(() => null),
      api.standorte().catch(() => null),
      api.messstellenRegister({ standort: standortId }).then(
        (r) => r.register,
        () => null,
      ),
      api.listDevices().then((antwort) => antwort.eintraege).catch(() => null),
    ]).then(([f, l, r, d]) => {
      if (!aktiv) return;
      if (f) setFunktionen(f);
      if (l) setListe(l);
      setRegister(r);
      setGeraete(d);
      setGeprueft(true);
    });
    return () => {
      aktiv = false;
    };
  }, [schritt, standortId, pruefRunde, runde]);

  useEffect(() => {
    if (fehler) fehlerRef.current?.focus();
  }, [fehler]);

  async function weiterAusStandort() {
    const naechster = vor(1, gebaut);
    if (!naechster || busy) return;
    if (!standortId) {
      setPflicht(STANDORT_WAEHLEN);
      document.getElementById(`${basis}-standort`)?.focus();
      return;
    }
    setFehler(null);
    if (angelegt.has(standortId) || !mussEinrichten(fs)) {
      setSchritt(naechster);
      return;
    }
    const id = standortId;
    setBusy(true);
    try {
      const r = await api.funktionMessenEinrichten(id);
      setFunktionen((f) => f && { ...f, standorte: f.standorte.map((s) => (s.id === r.standort.id ? r.standort : s)) });
      setAngelegt((a) => new Set(a).add(id));
      setSchritt(naechster);
    } catch (e) {
      if (istBereitsAngelegt(e)) {
        // Ein anderer Weg war schneller: die Funktion gibt es — nachlesen und weiter, kein Fehler.
        setAngelegt((a) => new Set(a).add(id));
        setRunde((n) => n + 1);
        setSchritt(naechster);
      } else {
        setFehler(e instanceof Error && e.message ? e.message : EINRICHTEN_FEHLER);
      }
    } finally {
      setBusy(false);
    }
  }

  function oeffneGeraet(siteId: string) {
    const site = sites?.find((s) => s.id === siteId);
    if (!site) {
      setFehler(ANLAGE_FEHLER);
      setRunde((n) => n + 1);
      return;
    }
    setFehler(null);
    setUnterfluss({ art: 'geraet', site });
  }

  function zurueckAusUnterfluss() {
    setUnterfluss(null);
    setRunde((n) => n + 1);
  }

  function umschalten(schluessel: string) {
    setFehler(null);
    setGewaehlt((g) => {
      const n = new Set(g);
      if (n.has(schluessel)) n.delete(schluessel);
      else n.add(schluessel);
      return n;
    });
  }

  /** Schritt 3 speichert: erst die Übernahme (eine Transaktion), dann je gewähltem Gebäude/Bereich der Ort. */
  async function uebernehmen() {
    if (!vorschlag || !standortId || busy) return;
    const regel = hauptzaehlerFehlt(vorschlag, gewaehlt);
    if (regel.size > 0) {
      setFehler([...regel.values()][0]);
      return;
    }
    const anfrage = uebernehmenAnfrage(vorschlag, gewaehlt, namen);
    setFehler(null);
    if (anfrage.vorschlaege.length === 0) {
      setSchritt(4);
      return;
    }
    const liste3 = vorschlag;
    setBusy(true);
    try {
      const r = await api.messstellenVorschlagUebernehmen(standortId, anfrage);
      setUebernommen((u) => ({ neu: (u?.neu ?? 0) + r.neu, unveraendert: (u?.unveraendert ?? 0) + r.unveraendert }));
      const gescheitert: string[] = [];
      for (const k of ortKorrekturen(liste3, anfrage, r, orte)) {
        try {
          await api.messstelleOrtAendern(k.messstelle, k.anfrage);
        } catch (e) {
          const satz = e instanceof Error && e.message ? e.message : ORT_FEHLER;
          gescheitert.push(ortFehlerSatz(k.kennzeichen, liste3.standort_name, satz));
        }
      }
      if (gescheitert.length > 0) setOrtFehler(gescheitert);
      else setSchritt(4);
    } catch (e) {
      // Hat sich die Lage geändert, gilt die gezeigte Liste nicht mehr: neu laden, der Satz bleibt stehen.
      if (istVorschlagGeaendert(e)) setVorschlagRunde((n) => n + 1);
      setFehler(e instanceof Error && e.message ? e.message : UEBERNEHMEN_FEHLER);
    } finally {
      setBusy(false);
    }
  }

  /** Der Weg einer roten Prüfzeile: zurück in den Schritt, der sie grün macht — oder in den Standort-Dialog. */
  function gehe(ziel: MessenWegZiel) {
    setFehler(null);
    if (ziel === 'adresse') {
      if (st) setUnterfluss({ art: 'standort', standort: st });
      return;
    }
    setSchritt(ziel);
  }

  function waehle(id: string) {
    setStandortId(id);
    setPflicht(null);
    setFehler(null);
  }

  const fehlerZeile = fehler && (
    <p className="vp-ma-fehler" role="alert" tabIndex={-1} ref={fehlerRef}>
      {fehler}
    </p>
  );

  let rumpf: ReactNode = null;
  if (ladeFehler) {
    rumpf = (
      <div className="vp-ma-schritt">
        <p className="vp-ma-fehler" role="alert">
          {ladeFehler}
        </p>
        <div>
          <Button variant="outline" onClick={() => setRunde((n) => n + 1)}>
            Erneut versuchen
          </Button>
        </div>
      </div>
    );
  } else if (schritt === null) {
    rumpf = <p className="vp-ma-satz">Wird geladen …</p>;
  } else if (schritt === 1) {
    rumpf = (
      <section className="vp-ma-schritt" aria-labelledby={`${basis}-frage`} data-schritt="standort">
        <h3 id={`${basis}-frage`} className="vp-ma-frage">
          {SCHRITT1_FRAGE}
        </h3>
        <p className="vp-ma-satz">{SCHRITT1_SATZ}</p>
        {wahl ? (
          <VpPicker
            id={`${basis}-standort`}
            label="Standort"
            options={wahl.optionen}
            value={standortId}
            onChange={waehle}
            createLabel={STANDORT_ANLEGEN}
            onCreate={() => setUnterfluss({ art: 'standort', standort: null })}
            hint={standortMessenSatz(fs) ?? undefined}
            error={pflicht ?? undefined}
          />
        ) : (
          <div className="vp-ma-leer">
            <p>{STANDORT_KEINER}</p>
            <Recht aktion="standort.verwalten"><Button variant="outline" onClick={() => setUnterfluss({ art: 'standort', standort: null })}>
              {STANDORT_ANLEGEN}
            </Button></Recht>
          </div>
        )}
        {st && adresseFehlt(st) && (
          <p className="vp-ma-hinweis">
            <span>{adresseFehltSatz(st.name)}</span>
            <Recht aktion="standort.verwalten"><Button variant="ghost" size="sm" onClick={() => setUnterfluss({ art: 'standort', standort: st })}>
              Adresse nachtragen
            </Button></Recht>
          </p>
        )}
        {fehlerZeile}
      </section>
    );
  } else if (schritt === 2) {
    const name = st?.name ?? '';
    rumpf = (
      <section className="vp-ma-schritt" aria-labelledby={`${basis}-frage`} data-schritt="datenquelle">
        <h3 id={`${basis}-frage`} className="vp-ma-frage">
          {SCHRITT2_FRAGE}
        </h3>
        {st && (
          <p className="vp-ma-ort">
            <span className="vp-ma-ort-wort">Standort: </span>
            {`${st.name} (${st.kurzzeichen})`}
          </p>
        )}
        {anlagen.length === 0 ? (
          <>
            <div className="vp-ma-leer" data-testid="messen-keine-anlage">
              <p>{keineAnlageSatz(name)}</p>
              <p>
                <span className="vp-ma-weg-wort">Nächster Schritt:</span>{' '}
                {keineAnlageWeg(name, unternehmen?.anlagenZahl ?? null)}
              </p>
            </div>
            {/* Im Rumpf, nicht im Fuß: dort war der Knopf bei 375 px breiter als sein halber Platz. */}
            <div>
              <Button variant="outline" size="sm" onClick={() => setSchritt(1)}>
                {ANDEREN_STANDORT}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="vp-ma-satz">{SCHRITT2_SATZ}</p>
            <ul className="vp-ma-anlagen">
              {anlagen.map((a) => {
                const zahl = komponentenSatz(komponenten[a.id] ?? null);
                return (
                  <li key={a.id} className="vp-ma-anlage" data-anlage={a.id}>
                    <div className="vp-ma-anlage-kopf">
                      <span className="vp-ma-anlage-name">{a.name}</span>
                      {zahl && <span className="vp-ma-anlage-zahl">{zahl}</span>}
                    </div>
                    <div className="vp-ma-wege">
                      <Recht aktion="geraet.einrichten"><button
                        type="button"
                        className="vp-ma-weg"
                        aria-label={`${GERAET_VERBINDEN} für ${a.name}`}
                        onClick={() => oeffneGeraet(a.id)}
                      >
                        <span className="vp-ma-weg-titel">{GERAET_VERBINDEN}</span>
                        <span className="vp-ma-weg-satz">{GERAET_VERBINDEN_SATZ}</span>
                      </button></Recht>
                      <Recht aktion="geraet.einrichten"><button
                        type="button"
                        className="vp-ma-weg"
                        aria-label={`${GERAET_ANBINDEN} für ${a.name}`}
                        onClick={() => {
                          setFehler(null);
                          setUnterfluss({ art: 'komponente', siteId: a.id });
                        }}
                      >
                        <span className="vp-ma-weg-titel">{GERAET_ANBINDEN}</span>
                        <span className="vp-ma-weg-satz">{GERAET_ANBINDEN_SATZ}</span>
                      </button></Recht>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {fehlerZeile}
        {(!vor(2, gebaut) || anlagen.length === 0) && <p className="vp-ma-spaeter">{SPAETER_SATZ}</p>}
      </section>
    );
  }
  if (!ladeFehler && schritt === 3) {
    const ortOptionenHier = standortId ? ortOptionen(ortWahlenAm(liste, baum, standortId)) : [];
    const regel = vorschlag ? hauptzaehlerFehlt(vorschlag, gewaehlt) : new Map<string, string>();
    const gruppen = vorschlag ? vorschlaegeJeAnlage(vorschlag) : [];
    rumpf = (
      <section className="vp-ma-schritt" aria-labelledby={`${basis}-frage`} data-schritt="messstellen">
        <h3 id={`${basis}-frage`} className="vp-ma-frage">
          {SCHRITT3_FRAGE}
        </h3>
        {st && (
          <p className="vp-ma-ort">
            <span className="vp-ma-ort-wort">Standort: </span>
            {`${st.name} (${st.kurzzeichen})`}
          </p>
        )}
        {vorschlagFehler ? (
          <>
            <p className="vp-ma-fehler" role="alert">
              {vorschlagFehler}
            </p>
            <div>
              <Button variant="outline" onClick={() => setVorschlagRunde((n) => n + 1)}>
                Erneut versuchen
              </Button>
            </div>
          </>
        ) : !vorschlag ? (
          <p className="vp-ma-satz">Wird geladen …</p>
        ) : ortFehler ? (
          <div className="vp-ma-leer" data-testid="messen-ort-fehler">
            {uebernommen && <p>{uebernahmeSatz(uebernommen.neu, uebernommen.unveraendert)}</p>}
            <ul className="vp-ma-details">
              {ortFehler.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        ) : vorschlag.vorschlaege.length === 0 ? (
          <div className="vp-ma-leer" data-testid="messen-vorschlag-leer">
            <p>{vorschlag.text}</p>
            {vorschlag.leer === 'keine_komponente' && (
              <div>
                <Button variant="outline" size="sm" onClick={() => setSchritt(2)}>
                  {ZUR_DATENQUELLE}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <>
            <p className="vp-ma-satz">{SCHRITT3_SATZ}</p>
            <p className="vp-ma-auswahl" aria-live="polite">
              {auswahlSatz(gewaehlt.size, vorschlag.vorschlaege.length)}
            </p>
            {gruppen.map((g) => (
              <div key={g.anlage} className="vp-ma-gruppe">
                {gruppen.length > 1 && <h4 className="vp-ma-gruppe-titel">{g.name}</h4>}
                <ul className="vp-ma-vorschlaege" aria-label={g.name ? `Vorschläge für ${g.name}` : 'Vorschläge'}>
                  {g.vorschlaege.map((v) => {
                    const schluessel = vorschlagSchluessel(v);
                    const feld = `${basis}-v-${vorschlag.vorschlaege.indexOf(v)}`;
                    const an = gewaehlt.has(schluessel);
                    const name = namen[schluessel] ?? v.name;
                    const satz = regel.get(schluessel);
                    const quelle = [v.komponente_name, v.quelle.anzeigename ?? v.quelle.kanal].filter(Boolean).join(' · ');
                    return (
                      <li
                        key={schluessel}
                        className="vp-ma-vorschlag"
                        data-vorschlag={v.kennzeichen}
                        data-gewaehlt={an ? 'ja' : 'nein'}
                      >
                        <div className="vp-ma-vorschlag-kopf">
                          <label className="vp-ma-wahl">
                            <input
                              type="checkbox"
                              checked={an}
                              onChange={() => umschalten(schluessel)}
                              aria-describedby={satz ? `${feld}-regel` : undefined}
                            />
                            <span className="vp-ma-kennzeichen">{v.kennzeichen}</span>
                            <span className="vp-sr-only">{` ${v.name} übernehmen`}</span>
                          </label>
                          <span className="vp-ma-auto">{KENNZEICHEN_AUTOMATISCH}</span>
                          <span className="vp-ma-stellung">{stellungWort(v)}</span>
                        </div>
                        {!an && <p className="vp-ma-vorschlag-name">{v.name}</p>}
                        {quelle && <p className="vp-ma-quelle">{quelle}</p>}
                        {an && (
                          <div className="vp-ma-felder">
                            <Input
                              id={`${feld}-name`}
                              label="Name"
                              value={name}
                              autoComplete="off"
                              onChange={(e) => setNamen((n) => ({ ...n, [schluessel]: e.target.value }))}
                              hint={name.trim() ? undefined : nameLeerSatz(v.name)}
                            />
                            {ortOptionenHier.length > 0 ? (
                              <VpPicker
                                id={`${feld}-ort`}
                                label="Ort"
                                options={ortOptionenHier}
                                value={orte[schluessel] ?? v.ort}
                                onChange={(o) => setOrte((x) => ({ ...x, [schluessel]: o }))}
                              />
                            ) : (
                              <p className="vp-ma-quelle">{`Ort: ${vorschlag.standort_name}`}</p>
                            )}
                          </div>
                        )}
                        {v.hinweise.map((h) => (
                          <p key={h.code} className="vp-ma-vorschlag-hinweis">
                            {h.text}
                          </p>
                        ))}
                        {satz && (
                          <p id={`${feld}-regel`} className="vp-ma-regel">
                            {satz}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </>
        )}
        {vorschlag && !ortFehler && vorschlag.ausgelassen.length > 0 && (
          <details className="vp-ma-ausgelassen">
            <summary>{`${NICHT_VORGESCHLAGEN} (${vorschlag.ausgelassen.length.toLocaleString('de-DE')})`}</summary>
            <ul className="vp-ma-details">
              {vorschlag.ausgelassen.map((a, i) => (
                <li key={`${a.komponente}|${a.kanal ?? ''}|${i}`}>{a.text}</li>
              ))}
            </ul>
          </details>
        )}
        {fehlerZeile}
      </section>
    );
  }

  if (!ladeFehler && schritt === 4) {
    const zeilen = st && fs ? messenPruefliste({ standort: st, funktion: fs, geraete, register }) : [];
    const eingerichtet = messenEingerichtet(fs);
    rumpf = (
      <section className="vp-ma-schritt" aria-labelledby={`${basis}-frage`} data-schritt="pruefen">
        <h3 id={`${basis}-frage`} className="vp-ma-frage">
          {SCHRITT4_FRAGE}
        </h3>
        {!geprueft ? (
          <p className="vp-ma-satz">Wird geprüft …</p>
        ) : !st || !fs ? (
          <p className="vp-ma-fehler" role="alert">
            {PRUEF_LADEFEHLER}
          </p>
        ) : (
          <>
            <p className="vp-ma-satz">{SCHRITT4_SATZ}</p>
            <ul className="vp-ma-pruefliste" aria-label="Prüfliste">
              {zeilen.map((z) => (
                <li
                  key={z.art}
                  className="vp-ma-pruefzeile"
                  data-pruefung={z.art}
                  data-bestanden={z.bestanden === null ? 'offen' : z.bestanden ? 'ja' : 'nein'}
                >
                  <span className="vp-ma-marke" aria-hidden="true">
                    {z.bestanden ? '✓' : z.bestanden === null ? '–' : '!'}
                  </span>
                  <div className="vp-ma-pruefinhalt">
                    <span className="vp-ma-prueftext">
                      {z.text}
                      <span className="vp-sr-only">
                        {z.bestanden ? ' — erfüllt' : z.bestanden === null ? ' — nicht prüfbar' : ' — nicht erfüllt'}
                      </span>
                    </span>
                    {z.details.length > 0 ? (
                      <ul className="vp-ma-details">
                        {z.details.map((d) => (
                          <li key={d}>{d}</li>
                        ))}
                      </ul>
                    ) : z.fehlt.length > 0 ? (
                      <span className="vp-ma-pruefsatz">{`Es fehlt: ${z.fehlt.join(', ')}`}</span>
                    ) : null}
                    {z.weg && (
                      <div>
                        <Button variant="outline" size="sm" onClick={() => gehe(z.weg!.ziel)}>
                          {z.weg.text}
                        </Button>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {!eingerichtet && (
              <>
                <p className="vp-ma-spaeter">{SPAETER_SATZ}</p>
                <div>
                  <Button variant="ghost" size="sm" onClick={() => setPruefRunde((n) => n + 1)}>
                    {ERNEUT_PRUEFEN}
                  </Button>
                </div>
              </>
            )}
          </>
        )}
        {fehlerZeile}
      </section>
    );
  }

  if (!ladeFehler && schritt === 5) {
    const zahl = uebernommen ? uebernommen.neu + uebernommen.unveraendert : 0;
    rumpf = (
      <section className="vp-ma-schritt" aria-labelledby={`${basis}-frage`} data-schritt="fertig">
        <h3 id={`${basis}-frage`} className="vp-ma-frage">
          {fertigSatz(st?.name ?? '')}
        </h3>
        <p className="vp-ma-satz">{FERTIG_AUSWERTUNG}</p>
        {(fs?.messen.datenlage || zahl > 0) && (
          <ul className="vp-ma-fakten">
            {fs?.messen.datenlage && <li>{fs.messen.datenlage}</li>}
            {uebernommen && zahl > 0 && <li>{uebernahmeSatz(uebernommen.neu, uebernommen.unveraendert)}</li>}
          </ul>
        )}
        <p className="vp-ma-ort">{FERTIG_WEITERE}</p>
        {standortId && (
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                window.location.hash = hashForRoute(standortMessstellenRoute(standortId));
                onClose();
              }}
            >
              {MESSSTELLEN_ANSEHEN}
            </Button>
          </div>
        )}
      </section>
    );
  }

  let fuss: ReactNode = null;
  if (schritt === 1) {
    fuss = (
      <>
        <Button variant="ghost" onClick={onClose}>
          Abbrechen
        </Button>
        <Recht aktion="funktion.messen_einrichten"><Button variant="primary" onClick={() => void weiterAusStandort()} aria-busy={busy || undefined}>
          {busy ? 'Wird angelegt …' : 'Weiter'}
        </Button></Recht>
      </>
    );
  } else if (schritt === 2) {
    // Ohne Anlage gibt es nichts zu messen: kein „Weiter" in eine leere Vorschlagsliste (Entscheid 002 = A).
    const naechster = anlagen.length > 0 ? vor(2, gebaut) : null;
    fuss = (
      <>
        <Button variant="ghost" onClick={() => setSchritt(1)}>
          Zurück
        </Button>
        {naechster ? (
          <Button variant="primary" onClick={() => setSchritt(naechster)}>
            Weiter
          </Button>
        ) : (
          <Button variant="primary" onClick={onClose}>
            {SPAETER_FORTSETZEN}
          </Button>
        )}
      </>
    );
  } else if (schritt === 3) {
    const uebernehmbar = !!vorschlag && !ortFehler && vorschlag.vorschlaege.length > 0 && gewaehlt.size > 0;
    fuss = (
      <>
        <Button variant="ghost" onClick={() => setSchritt(2)}>
          Zurück
        </Button>
        {uebernehmbar ? (
          <Recht aktion="messstelle.bearbeiten"><Button variant="primary" onClick={() => void uebernehmen()} aria-busy={busy || undefined}>
            {busy ? 'Wird übernommen …' : UEBERNEHMEN}
          </Button></Recht>
        ) : (
          <Button
            variant="primary"
            onClick={() => {
              setFehler(null);
              setSchritt(4);
            }}
          >
            Weiter
          </Button>
        )}
      </>
    );
  } else if (schritt === 4) {
    fuss = (
      <>
        <Button variant="ghost" onClick={() => setSchritt(3)}>
          Zurück
        </Button>
        {geprueft && messenEingerichtet(fs) ? (
          <Button variant="primary" onClick={() => setSchritt(5)}>
            Weiter
          </Button>
        ) : (
          <Button variant="primary" onClick={onClose}>
            {SPAETER_FORTSETZEN}
          </Button>
        )}
      </>
    );
  } else if (schritt === 5) {
    fuss = (
      <Button variant="primary" onClick={onClose}>
        {FERTIG}
      </Button>
    );
  }

  // Auf „Fertig" gibt es kein Zurück mehr: der Entwurf ist gelöscht, die Funktion aktiv.
  const vorher = schritt === null || schritt === 5 ? null : zurueck(schritt);

  return (
    <>
      {!unterfluss && (
        <AnlegenDialog
          titel={isPhone ? MESSEN_TITEL_KURZ : MESSEN_TITEL}
          schritte={[...MESSEN_SCHRITTE]}
          aktiv={schritt ?? 1}
          onClose={onClose}
          onBack={vorher ? () => setSchritt(vorher) : null}
          footer={fuss}
        >
          {rumpf}
        </AnlegenDialog>
      )}

      {unterfluss?.art === 'standort' && liste && (
        <StandortDialog
          open
          standort={unterfluss.standort}
          unternehmen={unternehmen}
          standorte={liste.standorte}
          heute={liste.stichtag}
          onClose={() => setUnterfluss(null)}
          onGespeichert={(s) => {
            setUnterfluss(null);
            waehle(s.id);
            setRunde((n) => n + 1);
          }}
          onOeffnen={(s) => {
            setUnterfluss(null);
            waehle(s.id);
          }}
        />
      )}
      {unterfluss?.art === 'geraet' && (
        <AddDeviceDrawer
          open
          sites={[unterfluss.site]}
          onClose={zurueckAusUnterfluss}
          onClaimed={() => setRunde((n) => n + 1)}
        />
      )}
      {unterfluss?.art === 'komponente' && (
        <AnlegenFlow
          siteId={unterfluss.siteId}
          onClose={zurueckAusUnterfluss}
          onSaved={(r) => setKomponenten((k) => ({ ...k, [unterfluss.siteId]: r.components.length }))}
        />
      )}
    </>
  );
}
