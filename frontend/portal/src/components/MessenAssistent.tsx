import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import {
  api,
  type Funktionen,
  type Site,
  type StandortAmStichtag,
  type StandorteAmStichtag,
  type Unternehmen,
} from '../api';
import { standortWahl } from '../anlageStandort';
import {
  adresseFehlt,
  ANDEREN_STANDORT,
  anlagenAmStandort,
  browserSpeicher,
  entwurfLesen,
  entwurfSchreiben,
  GEBAUTE_SCHRITTE,
  GERAET_ANBINDEN,
  GERAET_ANBINDEN_SATZ,
  GERAET_VERBINDEN,
  GERAET_VERBINDEN_SATZ,
  istBereitsAngelegt,
  keineAnlageSatz,
  keineAnlageWeg,
  komponentenSatz,
  MESSEN_SCHRITTE,
  MESSEN_TITEL,
  mussEinrichten,
  SCHRITT1_FRAGE,
  SCHRITT1_SATZ,
  SCHRITT2_FRAGE,
  SCHRITT2_SATZ,
  SPAETER_FORTSETZEN,
  SPAETER_SATZ,
  STANDORT_ANLEGEN,
  STANDORT_KEINER,
  STANDORT_WAEHLEN,
  standortMessenSatz,
  startSchritt,
  vor,
  zurueck,
  type EntwurfSpeicher,
  type MessenSchritt,
} from '../messenAssistent';
import { AnlegenDialog } from './AnlegenDialog';
import { AnlegenFlow } from './AnlegenFlow';
import { AddDeviceDrawer } from './DeviceDrawers';
import { StandortDialog } from './StandortDialog';
import { VpPicker } from './VpPicker';
import './MessenAssistent.css';

/**
 * Der Assistent „Messen & Auswerten" je Standort (UEMS AP-01 IP-9a, Konzept
 * §5.2) — der RAHMEN mit den Schritten 1 und 2.
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
  useEffect(() => {
    if (schritt !== null) entwurfSchreiben(ablage, { standortId, schritt });
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
    api.listSites().then(
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
            <Button variant="outline" onClick={() => setUnterfluss({ art: 'standort', standort: null })}>
              {STANDORT_ANLEGEN}
            </Button>
          </div>
        )}
        {st && adresseFehlt(st) && (
          <p className="vp-ma-hinweis">
            <span>{`Für ${st.name} fehlt noch die Adresse.`}</span>
            <Button variant="ghost" size="sm" onClick={() => setUnterfluss({ art: 'standort', standort: st })}>
              Adresse nachtragen
            </Button>
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
          <div className="vp-ma-leer" data-testid="messen-keine-anlage">
            <p>{keineAnlageSatz(name)}</p>
            <p>
              <span className="vp-ma-weg-wort">Nächster Schritt:</span>{' '}
              {keineAnlageWeg(name, unternehmen?.anlagenZahl ?? null)}
            </p>
          </div>
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
                      <button
                        type="button"
                        className="vp-ma-weg"
                        aria-label={`${GERAET_VERBINDEN} für ${a.name}`}
                        onClick={() => oeffneGeraet(a.id)}
                      >
                        <span className="vp-ma-weg-titel">{GERAET_VERBINDEN}</span>
                        <span className="vp-ma-weg-satz">{GERAET_VERBINDEN_SATZ}</span>
                      </button>
                      <button
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
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {fehlerZeile}
        {!vor(2, gebaut) && <p className="vp-ma-spaeter">{SPAETER_SATZ}</p>}
      </section>
    );
  }
  // IP-9b hängt hier ein: 3 · Messstellen, 4 · Prüfen, 5 · Fertig (und in GEBAUTE_SCHRITTE).

  let fuss: ReactNode = null;
  if (schritt === 1) {
    fuss = (
      <>
        <Button variant="ghost" onClick={onClose}>
          Abbrechen
        </Button>
        <Button variant="primary" onClick={() => void weiterAusStandort()} aria-busy={busy || undefined}>
          {busy ? 'Wird angelegt …' : 'Weiter'}
        </Button>
      </>
    );
  } else if (schritt === 2) {
    const naechster = vor(2, gebaut);
    fuss = (
      <>
        <Button variant="ghost" onClick={() => setSchritt(1)}>
          {anlagen.length === 0 ? ANDEREN_STANDORT : 'Zurück'}
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
  }

  const vorher = schritt === null ? null : zurueck(schritt);

  return (
    <>
      {!unterfluss && (
        <AnlegenDialog
          titel={MESSEN_TITEL}
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
