import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  api,
  ApiError,
  type Kostenstelle,
  type Messstelle,
  type MessstelleProzessZuordnung,
  type MessstellenRegister,
  type MessstelleVerteilungAnteil,
  type OrtsbaumAmStichtag,
  type Prozess,
  type StandorteAmStichtag,
} from '../api';
import { MessstelleDialog } from '../components/MessstelleDialog';
import { PROTOKOLL_LABEL } from '../components/ProtokollDialog';
import { ProtokollListe, useProtokoll } from '../components/ProtokollListe';
import { ErrorState, Skeleton } from '../components/States';
import { WerteSektion } from '../components/WerteSektion';
import { ZuordnungAendernDialog } from '../components/ZuordnungAendernDialog';
import { UEMS_WERTE } from '../glossar';
import { lebenszyklusWort, zeileWoerter, type Lebenszyklus } from '../messstellen';
import {
  AENDERN_AB,
  AENDERN_TITEL,
  aenderbar,
  BEARBEITEN,
  bestandAus,
  elektrischKarte,
  gespeichertSatz,
  HISTORIE,
  kopf,
  LADEFEHLER,
  MESSSTELLE_PROTOKOLL_ACHSE,
  namenAus,
  NICHT_GEFUNDEN,
  organisationKarte,
  ortKarte,
  ZUR_LISTE,
  type AendernArt,
  type Kataloge,
  type KartenZeile,
  type ZuordnungsKarte,
} from '../messstelleZuordnung';
import { lokalerTag, VORGABE_ZEITZONE, type Tag } from '../uemsOrtsbaum';
import { periodeAus } from '../uemsWerteKarte';
import './MessstelleSeite.css';

interface Stamm {
  messstelle: Messstelle;
  /** `null` = nicht abrufbar (die Karte sagt es, statt eine leere Zuordnung zu zeigen). */
  prozesse: MessstelleProzessZuordnung[] | null;
  anteile: MessstelleVerteilungAnteil[] | null;
}

/**
 * Die Messstellen-Seite (UEMS AP-04 IP-8, Mockups R2 · Z4): Kopf mit Zustand und Quelle, drei
 * Zuordnungs-Karten Ort · Elektrisch · Organisation mit „Ändern ab …“ und der Historie je Karte,
 * darunter das Änderungsprotokoll nach dem Muster des Befehls-Verlaufs.
 *
 * Sie liest `GET /api/v1/messstellen/{id}` (Orte, Stellungen), `…/prozesse`, `…/verteilung`, das
 * Register von heute (Zustand, Quelle, „Unterzähler von …“), Standorte und Ortsbäume (Namen) und
 * die Kataloge Prozesse/Kostenstellen; das Protokoll `…/aenderungen?achse=eintrag`. Jede Ableitung
 * steht in `messstelleZuordnung.ts`; hier wird nur geladen und gerendert. Nach jedem Eintrag liest
 * die Seite neu — Karten, Historie und Protokoll zeigen dann den Stand des Servers.
 *
 * Das Ziel des Registers (`#/portfolio/messstellen/{id}`, `#/standort/{sid}/messstellen/{id}`).
 * Die Quelle-Karte mit ihrer Historie kommt mit AP-04 IP-14; hier steht nur die führende Quelle.
 *
 * Direkt unter dem Kopf steht der Abschnitt „Werte“ (UEMS AP-13 IP-3, E9 = A): die `WerteSektion`, die
 * auch der Dialog an den Gesamtwert-Karten öffnet — hier wohnt die Zahl einer Messstelle. Periode und
 * Version kommen aus der Adresse (`?periode=2026-10-25&version=2`); mit einer Periode holt die Seite den
 * Abschnitt in den Blick, und jede neue Wahl meldet sie dem Wirt, der die Adresse nachschreibt.
 */
export function MessstelleSeite({
  id,
  zone = VORGABE_ZEITZONE,
  werte = null,
  onWerteZeitraum,
  onListe,
}: {
  id: string;
  zone?: string;
  /** Periode und Version der Adresse für den Abschnitt „Werte“. */
  werte?: { periode: string | null; version: number | null } | null;
  /** Die neu gewählte Periode der Werte (`JJJJ-MM-TT` bzw. `JJJJ-MM`). */
  onWerteZeitraum?: (periode: string) => void;
  onListe: () => void;
}) {
  const [stamm, setStamm] = useState<Stamm | null>(null);
  const [stammFehler, setStammFehler] = useState<'fehlt' | 'fehler' | null>(null);
  const [register, setRegister] = useState<MessstellenRegister | null>(null);
  const [registerGelesen, setRegisterGelesen] = useState(false);
  const [standorte, setStandorte] = useState<StandorteAmStichtag | null>(null);
  const [baeume, setBaeume] = useState<Record<string, OrtsbaumAmStichtag | undefined>>({});
  const [prozessKatalog, setProzessKatalog] = useState<Prozess[]>([]);
  const [kostenstellen, setKostenstellen] = useState<Kostenstelle[]>([]);
  const [versuch, setVersuch] = useState(0);
  const [aendern, setAendern] = useState<AendernArt | null>(null);
  const [gespeichert, setGespeichert] = useState<{ art: AendernArt; satz: string } | null>(null);
  const [bearbeiten, setBearbeiten] = useState(false);
  const [bearbeitet, setBearbeitet] = useState(false);
  const protokoll = useProtokoll({ art: 'messstelle', id }, { achse: MESSSTELLE_PROTOKOLL_ACHSE, anlegeSatz: true });

  useEffect(() => {
    let aktiv = true;
    setStammFehler(null);
    Promise.all([
      api.messstelle(id),
      api.messstelleProzesse(id).then(
        (p) => p.prozesse,
        () => null,
      ),
      api.messstelleVerteilung(id).then(
        (v) => v.anteile,
        () => null,
      ),
    ]).then(
      ([messstelle, prozesse, anteile]) => aktiv && setStamm({ messstelle, prozesse, anteile }),
      (e) => aktiv && setStammFehler(e instanceof ApiError && e.status === 404 ? 'fehlt' : 'fehler'),
    );
    api.messstellenRegister().then(
      (r) => {
        if (!aktiv) return;
        setRegister(r);
        setRegisterGelesen(true);
      },
      // Ohne Register fehlen Zustand und Quelle im Kopf — die Karten stehen trotzdem.
      () => aktiv && setRegisterGelesen(true),
    );
    return () => {
      aktiv = false;
    };
  }, [id, versuch]);

  // Die Namen und Kataloge ändern sich durch einen Eintrag nicht — sie werden einmal gelesen.
  useEffect(() => {
    let aktiv = true;
    api.standorte().then(
      (s) => {
        if (!aktiv) return;
        setStandorte(s);
        for (const st of s.standorte) {
          api.standortOrte(st.id).then(
            (baum) => aktiv && setBaeume((alt) => ({ ...alt, [st.id]: baum })),
            () => undefined,
          );
        }
      },
      () => undefined,
    );
    api.prozesse().then(
      (p) => aktiv && setProzessKatalog(p.prozesse),
      () => undefined,
    );
    api.kostenstellen().then(
      (k) => aktiv && setKostenstellen(k.kostenstellen),
      () => undefined,
    );
    return () => {
      aktiv = false;
    };
  }, []);

  const zeilen = register?.register ?? [];
  const namen = useMemo(() => namenAus(standorte, baeume, zeilen), [standorte, baeume, zeilen]);
  const kataloge: Kataloge = useMemo(
    () => ({ namen, prozesse: prozessKatalog, kostenstellen }),
    [namen, prozessKatalog, kostenstellen],
  );

  // Ein Sprung mit Periode (Register, Herkunfts-Zeile) holt den Abschnitt „Werte“ in den Blick — einmal, und
  // nur so weit wie nötig: steht er schon im Bild, bleibt die Seite, wo sie ist.
  const werteRef = useRef<HTMLElement>(null);
  const gesprungen = useRef(false);
  const geladen = stamm !== null && registerGelesen;
  useEffect(() => {
    if (!werte?.periode || !geladen || gesprungen.current) return;
    gesprungen.current = true;
    werteRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [werte, geladen]);

  const zurueck = (
    <button type="button" className="vp-mss-zurueck" onClick={onListe}>
      <Icon name="chevron-left" size={18} />
      {ZUR_LISTE}
    </button>
  );

  if (stammFehler === 'fehlt') {
    return (
      <div className="vp-mss" data-testid="messstelle-seite">
        {zurueck}
        <p className="vp-mss-leer">{NICHT_GEFUNDEN}</p>
      </div>
    );
  }
  if (stammFehler) {
    return (
      <div className="vp-mss" data-testid="messstelle-seite">
        {zurueck}
        <ErrorState message={LADEFEHLER} onRetry={() => setVersuch((v) => v + 1)} />
      </div>
    );
  }
  // „heute“ ist der Stichtag des Servers (das Register von heute) — erst mit ihm stehen die Karten.
  if (!stamm || !registerGelesen) {
    return (
      <div className="vp-mss" data-testid="messstelle-seite" aria-busy="true">
        {zurueck}
        <Skeleton height={220} />
      </div>
    );
  }

  const m = stamm.messstelle;
  const heute: Tag = register?.stichtag ?? lokalerTag(new Date().toISOString(), zone);
  const k = kopf(m);
  const zeile = zeilen.find((r) => r.id === m.id) ?? null;
  const w =
    zeile && register
      ? zeileWoerter(zeile, { ebene: { art: 'unternehmen', name: '' }, zone, zeitpunkt: register.zeitpunkt })
      : null;
  const bestand = bestandAus(m, stamm.prozesse, stamm.anteile);
  const karten: ZuordnungsKarte[] = [
    ortKarte(m, heute, namen),
    elektrischKarte(m, heute, namen),
    organisationKarte(stamm.prozesse, stamm.anteile, heute),
  ];
  const darfAendern = aenderbar(m);
  const werteAnfang = periodeAus(werte?.periode);

  return (
    <div className="vp-mss" data-testid="messstelle-seite">
      {zurueck}
      <header className="vp-mss-kopf">
        <div className="vp-mss-kopf-text">
          <span className="vp-mss-kz">{k.kennzeichen}</span>
          <h1>{k.titel}</h1>
          <p>
            {[k.unter, lebenszyklusWort(m.lebenszyklus as Lebenszyklus)].filter(Boolean).join(' · ')}
          </p>
          {w?.beobachtung && <p className={`vp-mss-beob is-${w.beobachtung.ton}`}>{w.beobachtung.text}</p>}
          {w?.quelle.art === 'gebunden' && (
            <p className="vp-mss-quelle">
              Quelle: {[w.quelle.geraet, w.quelle.messwert, w.quelle.seit].join(' · ')}
            </p>
          )}
        </div>
        {darfAendern && (
          <Button variant="outline" onClick={() => setBearbeiten(true)}>
            {BEARBEITEN}
          </Button>
        )}
      </header>

      <section className="vp-mss-werte" aria-labelledby="vp-mss-werte-titel" data-testid="werte" ref={werteRef}>
        <WerteSektion
          kennzeichen={m.kennzeichen}
          messstelle={`${k.kennzeichen} · ${k.titel}`}
          kopf={<h2 id="vp-mss-werte-titel">{UEMS_WERTE}</h2>}
          anfang={werteAnfang}
          // Die Version gehört zu GENAU der Periode der Adresse — ohne sie gibt es nichts zu wählen.
          version={werteAnfang ? (werte?.version ?? null) : null}
          heute={heute}
          standortName={zeile?.ort.standort_name ?? null}
          onZeitraum={onWerteZeitraum}
        />
      </section>

      <div className="vp-mss-karten">
        {karten.map((karte) => (
          <Karte
            key={karte.art}
            karte={karte}
            darfAendern={darfAendern}
            gespeichert={gespeichert}
            onAendern={(art) => {
              setGespeichert(null);
              setAendern(art);
            }}
          />
        ))}
      </div>

      <section className="vp-mss-protokoll" aria-labelledby="vp-mss-protokoll-titel">
        <h2 id="vp-mss-protokoll-titel">{PROTOKOLL_LABEL}</h2>
        <ProtokollListe state={protokoll} />
      </section>

      {aendern && (
        <ZuordnungAendernDialog
          art={aendern}
          messstelle={m}
          bestand={bestand}
          kataloge={kataloge}
          standorte={standorte}
          baeume={baeume}
          register={zeilen}
          heute={heute}
          zone={zone}
          onClose={() => setAendern(null)}
          onGespeichert={(art, tag) => {
            setAendern(null);
            setGespeichert({ art, satz: gespeichertSatz(art, tag, heute, zone) });
            setVersuch((v) => v + 1);
            protokoll.reload();
          }}
        />
      )}
      <MessstelleDialog
        open={bearbeiten}
        messstelleId={m.id}
        heute={heute}
        onClose={() => {
          setBearbeiten(false);
          if (!bearbeitet) return;
          setBearbeitet(false);
          setVersuch((v) => v + 1);
          protokoll.reload();
        }}
        onGespeichert={() => setBearbeitet(true)}
      />
    </div>
  );
}

function Karte({
  karte,
  darfAendern,
  gespeichert,
  onAendern,
}: {
  karte: ZuordnungsKarte;
  darfAendern: boolean;
  gespeichert: { art: AendernArt; satz: string } | null;
  onAendern: (art: AendernArt) => void;
}) {
  const titelId = `vp-mss-karte-${karte.art}`;
  return (
    <section className="vp-mss-karte" aria-labelledby={titelId} data-testid={`karte-${karte.art}`}>
      <h2 id={titelId}>{karte.titel}</h2>
      {karte.zeilen.map((z) => (
        <Zeile
          key={z.art}
          zeile={z}
          darfAendern={darfAendern}
          gespeichert={gespeichert?.art === z.art ? gespeichert.satz : null}
          onAendern={() => onAendern(z.art)}
        />
      ))}
    </section>
  );
}

function Zeile({
  zeile: z,
  darfAendern,
  gespeichert,
  onAendern,
}: {
  zeile: KartenZeile;
  darfAendern: boolean;
  gespeichert: string | null;
  onAendern: () => void;
}) {
  return (
    <div className="vp-mss-zeile">
      {z.titel && <h3>{z.titel}</h3>}
      {z.heute ? (
        <>
          <p className="vp-mss-wert">{z.heute.wert}</p>
          <p className="vp-mss-neben">{[z.heute.neben, z.heute.zeitraum].filter(Boolean).join(' · ')}</p>
        </>
      ) : (
        <p className="vp-mss-leer">{z.leer}</p>
      )}
      {z.danach && (
        <p className="vp-mss-danach">
          <span>{z.danach.text}</span>
          <Badge variant="tint">{z.danach.marke}</Badge>
        </p>
      )}
      {gespeichert && (
        <p className="vp-mss-gespeichert" role="status">
          {gespeichert}
        </p>
      )}
      {z.geladen && darfAendern && (
        <button type="button" className="vp-mss-aendern" aria-label={`${AENDERN_TITEL[z.art]} ab …`} onClick={onAendern}>
          {AENDERN_AB}
        </button>
      )}
      {z.historie.length > 1 && (
        <details className="vp-mss-historie">
          <summary>
            {HISTORIE} ({z.historie.length})
          </summary>
          <ol>
            {z.historie.map((h) => (
              <li key={h.schluessel} className={`vp-mss-h is-${h.zustand}`}>
                <span className="vp-mss-punkt" aria-hidden="true" />
                <span className="vp-mss-h-text">
                  <span className="vp-mss-h-wert">{h.wert}</span>
                  {h.neben && <span className="vp-mss-h-neben">{h.neben}</span>}
                  <span className="vp-mss-h-zeit">{h.zeitraum}</span>
                </span>
                {h.marke && <Badge variant={h.zustand === 'geplant' ? 'tint' : 'ok'}>{h.marke}</Badge>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
