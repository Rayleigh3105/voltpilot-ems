/**
 * Das TAGESBILD der Fahrplan-Seite (Konzept „Tagesuhr und Bildfahrplan",
 * Entscheide E1–E11 vom 24.09.2026): am Telefon die Tagesuhr, ab 900 px
 * Inhaltsbreite der Bildfahrplan (E10) — darunter bzw. daneben die Zeile zum
 * Moment am Zeiger, die Antworten (E1) und die Waage (E5).
 *
 * Dieses Bauteil hält nur den Zustand der Bedienung (welche Viertelstunde,
 * welche Antwort, Abspielen, Einführung); jede Aussage kommt aus den reinen
 * Modulen `fahrplanTag`, `fahrplanUhr`, `fahrplanBildfahrplan`,
 * `fahrplanAntworten`, `fahrplanWaage` und `fahrplanTagesbild`.
 *
 * Die EINFÜHRUNG (E11) startet beim ersten Besuch einmal von selbst — nur mit
 * der Uhr, und nur, wenn die „gesehen"-Marke sicher gelesen ist (fehlt die
 * Antwort, wird nichts behauptet und nichts gestartet). Gemerkt wird sie im
 * Layout-Dokument der Organisation (`document.seen`, das Muster der
 * Steuerungs-Erklärung), nie über `localStorage`.
 */

import {

  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { api } from '../api';
import { chartMotion } from '../chartMotion';
import { chartTheme } from '../chartTheme';
import type { CockpitLayoutDocument } from '../cockpitLayout';
import { antworten, type Antwort } from '../fahrplanAntworten';
import { phaseVon, uhrzeit, viertelBei, type TagModell } from '../fahrplanTag';
import {
  BILD_AB_PX,
  EINFUEHRUNG,
  EINFUEHRUNG_KEY,
  ZWEISPALTIG_AB_PX,
  ebenenSatz,
  momentZeile,
  werteAmZeiger,
  type TagesbildEbene,
} from '../fahrplanTagesbild';
import { uhrModell } from '../fahrplanUhr';
import { waage } from '../fahrplanWaage';
import type { WhySlot } from '../fahrplanWhy';
import { haptik } from '../haptik';
import type { JetztHeldView } from '../fahrplanJetzt';
import type { PlanWordingKind } from '../schedule';
import type { SpeicherAussage } from '../speicherAussage';
import { introGesehen, mitGesehen } from '../steuerungIntro';
import { FahrplanAntworten, FahrplanWaage } from './FahrplanAntworten';
import { FahrplanBildfahrplan } from './FahrplanBildfahrplan';
import { JetztInhalt } from './FahrplanJetzt';
import { FahrplanUhr } from './FahrplanUhr';
import { roleColor } from './FahrplanWhy';
import { ProvBadge } from './HistorieWelt';
import './FahrplanTagesbild.css';

/** Wo die „gesehen"-Marke der Einführung wohnt. */
export interface EinfuehrungQuelle {
  laden: () => Promise<CockpitLayoutDocument | null>;
  merken: (document: CockpitLayoutDocument) => Promise<unknown>;
}

const ECHTE_QUELLE: EinfuehrungQuelle = {
  laden: () => api.tenantCockpitLayout('cockpit').then((r) => r.eigen?.document ?? null),
  merken: (document) => api.saveTenantCockpitLayout('eigen', document, 'cockpit'),
};

/**
 * Das Abspielen (▶) ist ein TEMPO, keine Übergangs-Dauer: Viertelstunde für
 * Viertelstunde läuft der Tag in rund sieben Sekunden durch. Ohne Bewegung
 * (`--vp-motion-scale: 0`) springt es stattdessen Phase für Phase, mit Zeit
 * zum Lesen — eine Folge ruhiger Bilder statt eines Flimmerns.
 */
const TAKT_VIERTEL_MS = 75;
const TAKT_PHASE_MS = 900;

export interface FahrplanTagesbildProps {
  tag: TagModell;
  plantKind: PlanWordingKind;
  /** Die Steuerungs-Aussage des Tages (E6); null = keine Antwort „Was bringt es heute?". */
  speicher: SpeicherAussage | null;
  siteId: string;
  /** Die Viertelstunde i, wie sie die Waage liest (jüngster Lauf, sonst der Tag). */
  slotFuerWarum: (i: number) => WhySlot | null;
  /** Das volle Erklär-Panel der Viertelstunde i. */
  warumPanel: (i: number, schliessen: () => void) => ReactNode;
  /** Führt zu den Stationen (Film des Tages) auf derselben Seite. */
  onStationen: () => void;
  /** Wohin der Nachtrag-Satz der Geld-Antwort führt. */
  nachtragHref?: string;
  /**
   * Die Jetzt-Aussage (Ausführung und Messung, `jetztHeld`). Steht der
   * Zeiger auf „jetzt", steht sie unter den Antworten — der Plan allein
   * sagt nicht, was das Gerät tut. null = nur der Plan.
   */
  held?: JetztHeldView | null;
  /** Die Lage-Zeile des Tages (am Rechner über dem Bild, sonst unter den Antworten). */
  lage?: ReactNode;
  /** Nur für Tests: wo die „gesehen"-Marke der Einführung wohnt. */
  einfuehrung?: EinfuehrungQuelle;
}

export function FahrplanTagesbild({
  tag,
  plantKind,
  speicher,
  siteId,
  slotFuerWarum,
  warumPanel,
  onStationen,
  nachtragHref,
  held = null,
  lage = null,
  einfuehrung = ECHTE_QUELLE,
}: FahrplanTagesbildProps) {
  const t = chartTheme();
  const huelle = useRef<HTMLDivElement | null>(null);
  const [breite, setBreite] = useState(0);
  const [wahl, setWahl] = useState<number | null>(null);
  const [anim, setAnim] = useState<number | null>(null);
  const [fokus, setFokus] = useState<TagesbildEbene | null>(null);
  const [antwort, setAntwort] = useState<Antwort | null>(null);
  const [tour, setTour] = useState<number | null>(null);
  const [spielt, setSpielt] = useState(false);
  const [warumOffen, setWarumOffen] = useState(false);
  const [gesehen, setGesehen] = useState<boolean | undefined>(undefined);
  const raf = useRef<number | null>(null);
  const spielTimer = useRef<number | null>(null);
  const autoGestartet = useRef(false);
  const tourWeiter = useRef<HTMLButtonElement | null>(null);
  const tourFokussieren = useRef(false);

  // ---- Breite: Uhr oder Bildfahrplan (E10) ------------------------------------
  useLayoutEffect(() => {
    const el = huelle.current;
    if (!el) return;
    const messen = () => setBreite(Math.round(el.getBoundingClientRect().width));
    messen();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(messen);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const bild = breite >= BILD_AB_PX;
  const zweispaltig = !bild && breite >= ZWEISPALTIG_AB_PX;

  // ---- Auswahl --------------------------------------------------------------------
  const jetztI = tag.jetztIndex;
  const n = tag.slots.length;
  const auswahl = Math.min(n - 1, wahl ?? (jetztI >= 0 ? jetztI : 0));
  const istJetzt = wahl == null && jetztI >= 0;
  const mitte = (i: number) => (tag.viertel[i] ? (tag.viertel[i].von + tag.viertel[i].bis) / 2 : 0);
  const zielMinute = istJetzt && tag.jetzt != null ? tag.jetzt : mitte(auswahl);
  const zeiger = anim ?? zielMinute;

  // Ein neuer Tag bzw. ein Lauf mit anderem Anfang: die Auswahl gilt nicht mehr.
  const erster = tag.slots[0]?.start ?? null;
  useEffect(() => {
    setWahl(null);
    setAntwort(null);
  }, [erster]);

  // ---- Bewegung des Zeigers ----------------------------------------------------------
  const animStopp = useCallback(() => {
    if (raf.current != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf.current);
    raf.current = null;
    setAnim(null);
  }, []);

  /** Dreht den Zeiger von `von` nach `nach` (Minuten); ohne Bewegung springt er. */
  const drehen = useCallback(
    (von: number, nach: number, fertig: () => void) => {
      animStopp();
      const { update } = chartMotion();
      const dauer = update * Math.min(2.6, 0.8 + Math.abs(nach - von) / 400);
      if (!(dauer > 0) || typeof requestAnimationFrame !== 'function') {
        fertig();
        return;
      }
      const t0 = performance.now();
      const schritt = (jetztMs: number) => {
        const k = Math.min(1, (jetztMs - t0) / dauer);
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        setAnim(von + (nach - von) * e);
        if (k < 1) {
          raf.current = requestAnimationFrame(schritt);
        } else {
          raf.current = null;
          setAnim(null);
          fertig();
        }
      };
      raf.current = requestAnimationFrame(schritt);
    },
    [animStopp],
  );

  const anhalten = useCallback(() => {
    if (spielTimer.current != null) window.clearTimeout(spielTimer.current);
    spielTimer.current = null;
    setSpielt(false);
  }, []);

  useEffect(
    () => () => {
      if (spielTimer.current != null) window.clearTimeout(spielTimer.current);
      if (raf.current != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf.current);
    },
    [],
  );

  const waehlen = useCallback(
    (i: number) => {
      setAntwort(null);
      setWahl(i === jetztI ? null : i);
    },
    [jetztI],
  );

  /**
   * Der Knopf „Zurück zu jetzt" fühlt sich an wie der Tipp in die Mitte: ein
   * Doppel-Impuls. (Den Mitte-Tipp spielt die Uhr selbst, darum hier getrennt.)
   */
  const zurueckKnopf = () => {
    haptik('jetzt');
    zurueckZuJetzt();
  };

  const zurueckZuJetzt = () => {
    anhalten();
    setAntwort(null);
    if (tag.jetzt == null) {
      setWahl(null);
      return;
    }
    drehen(zeiger, tag.jetzt, () => setWahl(null));
  };

  // ---- Einführung (E11) ----------------------------------------------------------------
  useEffect(() => {
    let aktiv = true;
    try {
      einfuehrung.laden().then(
        (d) => {
          if (aktiv) setGesehen(introGesehen(d, EINFUEHRUNG_KEY));
        },
        () => {
          if (aktiv) setGesehen(undefined);
        },
      );
    } catch {
      // Eine api-Attrappe ohne die Methode: dann wird nichts behauptet.
    }
    return () => {
      aktiv = false;
    };
    // Die Marke hängt am Kunden, nicht an der Anlage: einmal je Montierung.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const merkeGesehen = () => {
    if (gesehen !== false) return;
    setGesehen(true);
    // FRISCH laden und ADDITIV merken: was seit dem Öffnen woanders am
    // Dokument geändert wurde (Cockpit-Anordnung), bleibt erhalten.
    void einfuehrung
      .laden()
      .then((d) => einfuehrung.merken(mitGesehen(d, EINFUEHRUNG_KEY)))
      .catch(() => undefined);
  };

  const tourStarten = (fokussieren: boolean) => {
    anhalten();
    animStopp();
    setAntwort(null);
    setWarumOffen(false);
    setFokus(null);
    tourFokussieren.current = fokussieren;
    setTour(0);
  };
  const tourEnde = () => {
    animStopp();
    setTour(null);
    merkeGesehen();
  };

  // Beim ersten Besuch einmal von selbst — nur mit der Uhr.
  useEffect(() => {
    if (autoGestartet.current || gesehen !== false || breite === 0 || bild || n === 0) return;
    autoGestartet.current = true;
    tourStarten(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gesehen, breite, bild, n]);

  // Der Schritt „Der Zeiger" zeigt einmal, wie er sich bewegt.
  const tourSchritt = tour == null ? null : EINFUEHRUNG[tour];
  useEffect(() => {
    if (tourSchritt?.ebene !== 'zeiger') return;
    const basis = zielMinute;
    const vor = Math.min(1439, basis + 90);
    const zurueck = Math.max(0, basis - 90);
    drehen(basis, vor, () => drehen(vor, zurueck, () => drehen(zurueck, basis, () => undefined)));
    return animStopp;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourSchritt]);

  useEffect(() => {
    if (tour != null && tourFokussieren.current) tourWeiter.current?.focus({ preventScroll: true });
  }, [tour]);

  // ---- Abspielen (▶) --------------------------------------------------------------------
  const spielen = () => {
    if (spielt) {
      anhalten();
      return;
    }
    animStopp();
    setAntwort(null);
    setTour(null);
    setWarumOffen(false);
    if (n === 0) return;
    const bewegt = chartMotion().scale > 0;
    const schritte = bewegt
      ? tag.viertel.map((v) => v.i)
      : tag.phasen.map((p) => tag.phasenRoh[p.phaseIndex].startIdx);
    const takt = bewegt ? TAKT_VIERTEL_MS : TAKT_PHASE_MS;
    let k = 0;
    // Fühlbar abgespielt: ein Tick, sobald eine neue Phase beginnt, und am
    // Ende der Doppel-Impuls von „jetzt" (am Telefon; sonst geschieht nichts).
    let letztePhase = phaseVon(tag, auswahl)?.phaseIndex ?? null;
    setSpielt(true);
    const weiter = () => {
      if (k >= schritte.length) {
        spielTimer.current = window.setTimeout(() => {
          spielTimer.current = null;
          setSpielt(false);
          setWahl(null);
          if (jetztI >= 0) haptik('jetzt');
        }, TAKT_PHASE_MS / 2);
        return;
      }
      const i = schritte[k];
      const phase = phaseVon(tag, i)?.phaseIndex ?? null;
      if (phase !== letztePhase) haptik('tick');
      letztePhase = phase;
      setWahl(i === jetztI ? null : i);
      k += 1;
      spielTimer.current = window.setTimeout(weiter, takt);
    };
    weiter();
  };

  // ---- Antworten ----------------------------------------------------------------------------
  const liste = useMemo(
    () => antworten({ tag, auswahl, istJetzt, speicher }),
    [tag, auswahl, istJetzt, speicher],
  );

  /** Ein Tipp auf eine Antwort: ihre Stelle zeigen (Uhr: Zeiger dorthin) und sie ausführlich nennen. */
  const antwortWaehlen = (a: Antwort) => {
    haptik('ziel');
    if (bild) {
      setAntwort((cur) => (cur?.key === a.key ? null : a));
      return;
    }
    anhalten();
    if (tour != null) tourEnde();
    setWarumOffen(false);
    setAntwort(a);
    const ziel = a.ziel;
    if (!ziel) return;
    const i = viertelBei(tag, ziel.minute);
    if (i < 0) return;
    drehen(zeiger, ziel.minute, () => setWahl(i === jetztI ? null : i));
  };

  // ---- Was gerade hervorgehoben ist ----------------------------------------------------
  const wirkFokus: TagesbildEbene | 'zeiger' | null =
    tourSchritt?.ebene ?? (antwort?.ziel?.ebene === 'ladestand' ? 'ladestand' : null) ?? fokus;
  const bildFokus: TagesbildEbene | null = wirkFokus === 'zeiger' ? null : wirkFokus;

  const uhr = useMemo(() => uhrModell(tag), [tag]);
  const zeile = momentZeile(tag, auswahl, istJetzt);
  const werte = werteAmZeiger(tag, auswahl);
  const warumSlot = slotFuerWarum(auswahl);
  const w = warumSlot ? waage(warumSlot, plantKind) : null;
  const v = tag.viertel[auswahl];
  const erloeseHref = `#/anlage/${siteId}/erloese`;

  if (n === 0) return null;

  const beruehrt = () => {
    anhalten();
    animStopp();
    if (tour != null) tourEnde();
  };

  // ---- Bausteine ------------------------------------------------------------------------------

  /** Die Zeile direkt unter dem Bild: was am Zeiger geplant ist — und der Weg zurück. */
  const zeigerZeile = zeile ? (
    <div className="vp-tb-zeiger">
      <p className="vp-tb-zeiger-was">
        {zeile.role && <i aria-hidden="true" style={{ background: roleColor(zeile.role, t) }} />}
        <span>
          {zeile.art !== 'jetzt' && <span className="vp-tb-zeiger-zeit">{zeile.zeit} · </span>}
          {zeile.was ? (zeile.art === 'vorbei' ? `War geplant: ${zeile.was}` : zeile.was) : null}
        </span>
      </p>
      {!istJetzt && jetztI >= 0 && (
        <button type="button" className="vp-tb-zurueck" onClick={zurueckKnopf}>
          <Icon name="history" size={14} />
          Zurück zu jetzt
        </button>
      )}
    </div>
  ) : null;

  const werteLeiste = (
    <div className="vp-tb-werte" role="group" aria-label="Werte am Zeiger">
      {werte.map((x) => {
        const inhalt = (
          <>
            <span className="vp-tb-werte-k">{x.label}</span>
            <span className="vp-tb-werte-v">{x.wert}</span>
            {x.herkunft && <span className="vp-tb-werte-h">{x.herkunft}</span>}
          </>
        );
        return bild ? (
          <span key={x.ebene} className="vp-tb-wert">
            {inhalt}
          </span>
        ) : (
          <button
            key={x.ebene}
            type="button"
            className="vp-tb-wert"
            aria-pressed={fokus === x.ebene}
            aria-label={x.satz}
            title="Im Bild hervorheben"
            onClick={() => {
              haptik('tick');
              if (tour != null) tourEnde();
              setAntwort(null);
              setFokus((cur) => (cur === x.ebene ? null : x.ebene));
            }}
          >
            {inhalt}
          </button>
        );
      })}
    </div>
  );

  const ebenenNotiz =
    !bild && fokus && tour == null && !antwort ? <p className="vp-tb-notiz">{ebenenSatz(tag, fokus)}</p> : null;

  // Am Telefon liegt die Einführung als Blatt über dem unteren Rand: die Uhr,
  // die sie erklärt, bleibt ganz sichtbar, und nichts darunter verrutscht.
  const tourKarte = tourSchritt ? (
    <div
      className={`vp-tb-tour${zweispaltig ? '' : ' is-blatt'}`}
      role="group"
      aria-label={`Die Uhr erklärt, Schritt ${tour! + 1} von ${EINFUEHRUNG.length}`}
      onKeyDown={(ev: KeyboardEvent<HTMLDivElement>) => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          tourEnde();
        }
      }}
    >
      <span className="vp-tb-tour-k">
        Die Uhr erklärt · {tour! + 1} von {EINFUEHRUNG.length}
      </span>
      <b>{tourSchritt.titel}</b>
      <p>{ebenenSatz(tag, tourSchritt.ebene)}</p>
      <div className="vp-tb-tour-reihe">
        <button type="button" className="vp-tb-link" onClick={tourEnde}>
          Beenden
        </button>
        <span className="vp-tb-tour-punkte" aria-hidden="true">
          {EINFUEHRUNG.map((s, k) => (
            <i key={s.ebene} className={k === tour ? 'is-an' : ''} />
          ))}
        </span>
        {tour! > 0 && (
          <button type="button" className="vp-tb-knopf" onClick={() => setTour(tour! - 1)}>
            Zurück
          </button>
        )}
        <button
          type="button"
          ref={tourWeiter}
          className="vp-tb-knopf is-primaer"
          onClick={() => (tour! >= EINFUEHRUNG.length - 1 ? tourEnde() : setTour(tour! + 1))}
        >
          {tour! >= EINFUEHRUNG.length - 1 ? 'Fertig' : 'Weiter'}
        </button>
      </div>
    </div>
  ) : null;

  const antwortListe = (
    <FahrplanAntworten
      antworten={liste}
      gewaehlt={antwort?.key ?? null}
      onWahl={antwortWaehlen}
      form={bild ? 'reihe' : zweispaltig ? 'liste' : 'reihe-schmal'}
    />
  );

  /** Die angetippte Antwort ausführlich — mit ihrem Weg zu den Einzelheiten. */
  const antwortBanner = antwort ? (
    <div className="vp-tb-antwort" role="status">
      <p className="vp-tb-antwort-frage">
        <Icon name="map-pin" size={15} />
        {antwort.frage}
        {antwort.zeit && <span className="vp-tb-antwort-zeit"> · ab {antwort.zeit}</span>}
      </p>
      <p className="vp-tb-antwort-text">{antwort.antwort}</p>
      {antwort.zusatz &&
        (antwort.nachtrag && nachtragHref ? (
          <a className="vp-tb-antwort-zusatz" href={nachtragHref}>
            {antwort.zusatz}
          </a>
        ) : (
          <p className="vp-tb-antwort-zusatz">{antwort.zusatz}</p>
        ))}
      {antwort.notiz && <p className="vp-tb-antwort-notiz">{antwort.notiz}</p>}
      <div className="vp-tb-reihe">
        {antwort.details === 'erloese' ? (
          <a className="vp-tb-link" href={erloeseHref}>
            Zu den Erlösen ›
          </a>
        ) : (
          <button type="button" className="vp-tb-link" onClick={onStationen}>
            Alle Stationen ›
          </button>
        )}
        {!bild && !istJetzt && jetztI >= 0 ? (
          <button type="button" className="vp-tb-zurueck" onClick={zurueckKnopf}>
            <Icon name="history" size={14} />
            Zurück zu jetzt
          </button>
        ) : (
          <button type="button" className="vp-tb-zurueck" onClick={() => setAntwort(null)}>
            Schließen
          </button>
        )}
      </div>
    </div>
  ) : null;

  // EIN Weg zu allen Gründen der Viertelstunde (dem Erklär-Panel): unter der
  // Waage, oder allein, wenn die Viertelstunde keine Waage hat.
  const warumKnopf = (
    <button
      type="button"
      className="vp-tb-warum"
      aria-expanded={warumOffen}
      onClick={() => setWarumOffen((o) => !o)}
    >
      Alle Gründe ›
    </button>
  );

  // Steht der Zeiger auf jetzt, sagt der Block, was das GERÄT tut (Ausführung,
  // Messung, Warnungen); sonst, was für die gewählte Viertelstunde geplant ist.
  const moment =
    istJetzt && held ? (
      <div className="vp-kompakt vp-tb-jetzt">
        <JetztInhalt view={held} ohneWarnungen />
      </div>
    ) : zeile ? (
      <div className={`vp-tb-moment is-${zeile.art}`}>
        <p className="vp-tb-moment-zeit">
          <span>{zeile.zeit}</span>
          <ProvBadge art="geplant" />
        </p>
        {zeile.plan && <p className="vp-tb-moment-plan">{zeile.plan}</p>}
      </div>
    ) : null;

  const panel = warumOffen ? warumPanel(auswahl, () => setWarumOffen(false)) : null;
  const waageTeil =
    w && v ? (
      <FahrplanWaage
        waage={w}
        zeit={istJetzt ? 'jetzt' : `um ${uhrzeit(v.von)} Uhr`}
        fuss={<div className="vp-tb-reihe">{warumKnopf}</div>}
      />
    ) : (
      <div className="vp-tb-reihe vp-tb-warumzeile">{warumKnopf}</div>
    );

  if (bild) {
    return (
      <div ref={huelle} className="vp-tb is-bild">
        {lage}
        <FahrplanBildfahrplan
          tag={tag}
          breite={breite}
          auswahl={auswahl}
          istJetzt={istJetzt}
          markierung={antwort?.ziel ?? null}
          fokus={bildFokus}
          onWahl={waehlen}
          onJetzt={zurueckZuJetzt}
        />
        <div className="vp-tb-leiste">
          {zeigerZeile}
          {werteLeiste}
        </div>
        {antwortListe}
        {antwortBanner}
        <div className="vp-tb-unter">
          <div className="vp-tb-unter-links">{moment}</div>
          <div className="vp-tb-unter-rechts">
            {waageTeil}
            {panel}
          </div>
        </div>
      </div>
    );
  }

  const uhrTeil = (
    <FahrplanUhr
      tag={tag}
      modell={uhr}
      auswahl={auswahl}
      istJetzt={istJetzt}
      zeiger={zeiger}
      fokus={wirkFokus}
      markierung={antwort?.ziel ?? null}
      spielt={spielt}
      onWahl={waehlen}
      onJetzt={zurueckZuJetzt}
      onSpielen={spielen}
      onErklaeren={() => (tour != null ? tourEnde() : tourStarten(true))}
      onBeruehrt={beruehrt}
    />
  );

  if (zweispaltig) {
    return (
      <div ref={huelle} className="vp-tb is-uhr is-zweispaltig">
        <div className="vp-tb-bildspalte">
          {uhrTeil}
          {zeigerZeile}
          {werteLeiste}
          {ebenenNotiz}
        </div>
        <div className="vp-tb-textspalte">
          {tourKarte}
          {antwortListe}
          {antwortBanner}
          {moment}
          {waageTeil}
          {panel}
          {lage}
        </div>
      </div>
    );
  }

  // Telefon (E1/E9): die Uhr ganz oben, direkt darunter die Antworten — alle
  // im ersten Bildschirm. Jetzt-Aussage, Waage und Lage folgen darunter.
  return (
    <div ref={huelle} className="vp-tb is-uhr">
      {uhrTeil}
      {zeigerZeile}
      {werteLeiste}
      {ebenenNotiz}
      {antwortListe}
      {antwortBanner}
      {moment}
      {waageTeil}
      {panel}
      {lage}
      {tourKarte}
    </div>
  );
}
