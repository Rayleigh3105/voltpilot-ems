/**
 * Das TAGESBILD der Fahrplan-Seite (Konzept „Tagesuhr und Bildfahrplan",
 * Entscheide E1–E11 vom 24.09.2026) — im AUFBAU DES PROTOTYPS:
 *
 *  - Telefon: Kopfsatz und Stand, die Uhr, die Werte am Zeiger, die Zeile zum
 *    Moment, die Antworten (E1, alle im ersten Bildschirm, E9), „Warum?", der
 *    Zustand mit „Eingreifen …", darunter Waage, Stationen und „Worauf Ihr
 *    Plan achtet".
 *  - 640–899 px: Uhr, Werte, Moment und Waage links (mitlaufend), Antworten,
 *    Stationen und Annahmen rechts.
 *  - ab 900 px Inhaltsbreite (E10): Kopfsatz, das Jetzt-Band, der
 *    Bildfahrplan, die Antworten in einer Reihe, darunter Waage | Stationen
 *    und Annahmen.
 *
 * Das bisherige Diagramm steht nicht mehr daneben (es wäre ein zweites Bild
 * desselben Tages); die Annahmen-Karte führt zu ihm („Alle Werte").
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
import type { AnnahmeZeile } from '../fahrplanAnnahmen';
import { antworten, type Antwort } from '../fahrplanAntworten';
import { phaseVon, uhrzeit, viertelBei, type TagModell } from '../fahrplanTag';
import {
  BILD_AB_PX,
  EINFUEHRUNG_KEY,
  ROLLEN_SYMBOL,
  ZWEISPALTIG_AB_PX,
  ebenenSatz,
  einfuehrungFuer,
  kopfsatz,
  momentBand,
  stationen,
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
import { InfoTip } from './InfoTip';
import { FahrplanAntworten, FahrplanWaage } from './FahrplanAntworten';
import { FahrplanBildfahrplan } from './FahrplanBildfahrplan';
import { JetztMesswerte } from './FahrplanJetzt';
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
  /** Das Erklär-Panel einer Station (Phase `phaseIndex` von `tag.phasenRoh`); null = keins. */
  phasenPanel?: ((phaseIndex: number, schliessen: () => void) => ReactNode) | null;
  /** Wohin der Nachtrag-Satz der Geld-Antwort führt. */
  nachtragHref?: string;
  /**
   * Die Jetzt-Aussage (Ausführung und Messung, `jetztHeld`). Steht der
   * Zeiger auf „jetzt", spricht sie im Jetzt-Band bzw. in der Zeile unter der
   * Uhr — der Plan allein sagt nicht, was das Gerät tut. null = nur der Plan.
   */
  held?: JetztHeldView | null;
  /** „14:00" — wann der jüngste Lauf entstand; null = unbekannt. */
  planVon?: string | null;
  /** „Worauf Ihr Plan achtet" (`fahrplanAnnahmen.planAnnahmen`). */
  annahmen?: AnnahmeZeile[];
  /** Wie der Fahrplan berechnet wird — klein unter den Annahmen. */
  berechnung?: string | null;
  /** Öffnet das bisherige Diagramm mit allen Werten; null = kein Verweis. */
  onAlleWerte?: (() => void) | null;
  /** Der Hinweis auf morgen unter den Stationen („Morgen · 3 weitere Phasen"). */
  morgen?: string | null;
  /** Nur für Tests: wo die „gesehen"-Marke der Einführung wohnt. */
  einfuehrung?: EinfuehrungQuelle;
}

/** Rollen, deren Farbe hell ist: ihr Symbol steht dunkel (wie an der Uhr). */
const RUHE_ROLLEN = new Set(['warten', 'reserve_halten', 'abregeln']);

export function FahrplanTagesbild({
  tag,
  plantKind,
  speicher,
  siteId,
  slotFuerWarum,
  warumPanel,
  phasenPanel = null,
  nachtragHref,
  held = null,
  planVon = null,
  annahmen = [],
  berechnung = null,
  onAlleWerte = null,
  morgen = null,
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
  // Die aufgeklappte Station (Index in `tag.phasenRoh`); null = keine.
  const [station, setStation] = useState<number | null>(null);
  const waageRef = useRef<HTMLElement | null>(null);
  const stationenRef = useRef<HTMLElement | null>(null);
  // Die Einführung erklärt nur Ringe, die es gibt (ohne Preis vier Schritte).
  const tourSchritte = useMemo(() => einfuehrungFuer(tag), [tag]);

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
  const tourSchritt = tour == null ? null : (tourSchritte[tour] ?? null);
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
  const werte = werteAmZeiger(tag, auswahl);
  const warumSlot = slotFuerWarum(auswahl);
  const w = warumSlot ? waage(warumSlot, plantKind) : null;
  const band = momentBand(tag, auswahl, istJetzt, held, w?.urteil ?? null);
  const satz = useMemo(() => kopfsatz(tag), [tag]);
  const halte = useMemo(() => stationen(tag, plantKind), [tag, plantKind]);
  const v = tag.viertel[auswahl];
  const erloeseHref = `#/anlage/${siteId}/erloese`;
  const phaseAmZeiger = phaseVon(tag, auswahl);

  if (n === 0) return null;

  const beruehrt = () => {
    anhalten();
    animStopp();
    if (tour != null) tourEnde();
  };

  const hin = (el: HTMLElement | null) =>
    el?.scrollIntoView({ behavior: chartMotion().scale > 0 ? 'smooth' : 'auto', block: 'start' });

  // ---- Bausteine ------------------------------------------------------------------------------

  /**
   * Kopfsatz und Stand: was der Speicher heute tut, von wann der Plan ist. Am
   * Telefon läuft der Stand am Ende des Satzes mit - eine eigene Zeile kostete
   * dort den ersten Bildschirm der Antworten (E9).
   */
  const stand = planVon ? `Plan von ${planVon} Uhr` : null;
  const kopf = (mitlaufend: boolean) =>
    satz || stand ? (
      <div className="vp-tb-kopf">
        {satz && (
          <p className="vp-tb-titel">
            {satz}
            {mitlaufend && stand && (
              <>
                {' '}
                <span className="vp-tb-stand-mit">{stand}</span>
              </>
            )}
          </p>
        )}
        {(!mitlaufend || !satz) && stand && (
          <p className="vp-tb-stand">
            <b>{stand}</b>
          </p>
        )}
      </div>
    ) : null;

  const zurueckKnopfEl =
    !istJetzt && jetztI >= 0 ? (
      <button type="button" className="vp-tb-zurueck" onClick={zurueckKnopf}>
        <Icon name="history" size={14} />
        Zurück zu jetzt
      </button>
    ) : null;

  const eingreifen = (
    <a className="vp-tb-knopf" href={`#/anlage/${siteId}/steuerung`}>
      Eingreifen …
    </a>
  );

  /** Der Zustand des Geräts in Worten (F5: „nichts zu tun" steht wörtlich da). */
  const zustand =
    istJetzt && held ? (
      <p className={`vp-kompakt-status is-${held.tone}`} role="status" aria-live="polite">
        <i aria-hidden="true" />
        {held.status}
      </p>
    ) : null;

  const farbe: Record<TagesbildEbene, string> = {
    sonne: t.pv,
    preis: t.price,
    taetigkeit: phaseAmZeiger ? roleColor(phaseAmZeiger.role, t) : t.neutral,
    ladestand: t.soc,
  };

  /** Die Werte am Zeiger — die Legende, die zugleich ablesbar ist. */
  const werteLeiste = (
    <div className="vp-tb-werte" role="group" aria-label="Werte am Zeiger">
      {werte.map((x) => {
        const inhalt = (
          <>
            <span className="vp-tb-werte-k">{x.label}</span>
            <span className="vp-tb-werte-v">
              <i className="vp-tb-werte-farbe" style={{ background: farbe[x.ebene] }} aria-hidden="true" />
              {x.wert}
            </span>
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

  /** Die Zeile zum Moment am Zeiger unter der Uhr (Telefon, Tablet). */
  const momentText = band ? (
    <div className="vp-tb-moment" aria-live="polite">
      {!istJetzt && <span className="vp-tb-moment-kopf">{band.kopf}</span>}
      {band.was && <span className="vp-tb-moment-was">{band.was}</span>}
      {band.zahl && <span className="vp-tb-moment-zahl">{band.zahl}</span>}
      {istJetzt && held?.adjust && <span className="vp-tb-moment-zahl">{held.adjust}</span>}
    </div>
  ) : null;

  /** „Warum?" — ein Satz, der Weg zur Waage. */
  const warumZeile = band?.warum ? (
    <button type="button" className="vp-tb-warumsatz" onClick={() => hin(waageRef.current)}>
      <b>Warum?</b> {band.warum} <span className="vp-tb-mehr">Zur Waage ›</span>
    </button>
  ) : null;

  // Am Telefon liegt die Einführung als Blatt über dem unteren Rand: die Uhr,
  // die sie erklärt, bleibt ganz sichtbar, und nichts darunter verrutscht.
  const tourKarte = tourSchritt ? (
    <div
      className={`vp-tb-tour${zweispaltig ? '' : ' is-blatt'}`}
      role="group"
      aria-label={`Die Uhr erklärt, Schritt ${tour! + 1} von ${tourSchritte.length}`}
      onKeyDown={(ev: KeyboardEvent<HTMLDivElement>) => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          tourEnde();
        }
      }}
    >
      <span className="vp-tb-tour-k">
        Die Uhr erklärt · {tour! + 1} von {tourSchritte.length}
      </span>
      <b>{tourSchritt.titel}</b>
      <p>{ebenenSatz(tag, tourSchritt.ebene)}</p>
      <div className="vp-tb-tour-reihe">
        <button type="button" className="vp-tb-link" onClick={tourEnde}>
          Beenden
        </button>
        <span className="vp-tb-tour-punkte" aria-hidden="true">
          {tourSchritte.map((s, k) => (
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
          onClick={() => (tour! >= tourSchritte.length - 1 ? tourEnde() : setTour(tour! + 1))}
        >
          {tour! >= tourSchritte.length - 1 ? 'Fertig' : 'Weiter'}
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
          <button type="button" className="vp-tb-link" onClick={() => hin(stationenRef.current)}>
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

  // EIN Weg zu allen Gründen der Viertelstunde (dem Erklär-Panel): in der Waage.
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
  const panel = warumOffen ? warumPanel(auswahl, () => setWarumOffen(false)) : null;

  /** Die Waage der Viertelstunde am Zeiger (E5) — mit dem Weg zu allen Gründen. */
  const waageKarte = (
    <section ref={waageRef} className="vp-tb-karte2 vp-tb-waagekarte" aria-label="Die Waage">
      <div className="vp-tb-karte2-kopf">
        <span className="vp-tb-kicker">Die Waage · {istJetzt ? 'jetzt' : v ? `${uhrzeit(v.von)} Uhr` : ''}</span>
        <ProvBadge art="geplant" />
      </div>
      {w ? (
        <FahrplanWaage waage={w} />
      ) : (
        <p className="vp-tb-fein">Für diese Viertelstunde ist keine Abwägung aufgezeichnet.</p>
      )}
      <div className="vp-tb-reihe">{warumKnopf}</div>
      {panel}
    </section>
  );

  /** Der Tag in Stationen — dieselben Phasen wie das Bild, Tipp für das Warum. */
  const stationenKarte = (
    <section ref={stationenRef} className="vp-tb-karte2" aria-label="Der Tag in Stationen">
      <div className="vp-tb-karte2-kopf">
        <h3 className="vp-tb-karte2-titel">Der Tag in Stationen</h3>
        <ProvBadge art="geplant" />
      </div>
      <ol className="vp-st">
        {halte.map((st) => {
          const offen = station === st.phaseIndex;
          return (
            <li
              key={st.phaseIndex}
              className={`vp-st-halt${st.vorbei ? ' is-vorbei' : ''}${st.laeuft ? ' is-jetzt' : ''}${RUHE_ROLLEN.has(st.role) ? ' is-ruhe' : ''}`}
              style={{ ['--vp-st-farbe' as string]: roleColor(st.role, t) }}
            >
              <span className="vp-st-punkt" aria-hidden="true">
                <Icon
                  name={ROLLEN_SYMBOL[st.role]}
                  size={13}
                  strokeWidth={2.2}
                  stroke={RUHE_ROLLEN.has(st.role) ? t.ink : '#FFFFFF'}
                />
              </span>
              <button
                type="button"
                className="vp-st-zeile"
                aria-expanded={offen}
                onClick={() => (phasenPanel ? setStation(offen ? null : st.phaseIndex) : undefined)}
              >
                <span className="vp-st-haupt">
                  <span className="vp-st-zeit">
                    {st.vorbei && <Icon name="check" size={12} aria-hidden="true" />}
                    {st.zeit}
                  </span>
                  <span className="vp-st-name">
                    {st.laeuft && <span className="vp-st-jetzt">Jetzt</span>}
                    {st.label}
                  </span>
                </span>
                {st.ladestand && <span className="vp-st-soc">{st.ladestand}</span>}
                {st.grund && <span className="vp-st-grund">{st.grund}</span>}
              </button>
              {offen && phasenPanel && (
                <div className="vp-st-detail">{phasenPanel(st.phaseIndex, () => setStation(null))}</div>
              )}
            </li>
          );
        })}
      </ol>
      {morgen && <p className="vp-tb-fein">{morgen}</p>}
      <p className="vp-tb-fein">
        Vergangenes ist der Plan, der damals galt. Was wirklich passiert ist, steht unter{' '}
        <a href={`#/anlage/${siteId}/messwerte`}>Messwerte</a>.
      </p>
    </section>
  );

  /** Worauf der Plan achtet — Eingaben, Grenzen, Hinweise; und der Weg zu allen Werten. */
  const annahmenKarte =
    annahmen.length > 0 || onAlleWerte ? (
      <section className="vp-tb-karte2" aria-label="Worauf Ihr Plan achtet">
        <div className="vp-tb-karte2-kopf">
          <h3 className="vp-tb-karte2-titel">Worauf Ihr Plan achtet</h3>
          {berechnung && <InfoTip title="Wie der Fahrplan berechnet wird">{berechnung}</InfoTip>}
        </div>
        <ul className="vp-annahmen">
          {annahmen.map((a) => (
            <li key={a.key}>
              <Icon name={a.icon} size={16} aria-hidden="true" />
              <span>
                <b>{a.titel}:</b> {a.text}
                {a.link && (
                  <>
                    {' '}
                    <a href={a.link.href}>{a.link.text} ›</a>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
        {onAlleWerte && (
          <div className="vp-tb-reihe">
            <button type="button" className="vp-tb-link" onClick={onAlleWerte}>
              Alle Werte im Diagramm ›
            </button>
          </div>
        )}
      </section>
    ) : null;

  if (bild) {
    // Das Jetzt-Band (Prototyp): links was geschieht, in der Mitte warum,
    // rechts der Zustand und der Weg zum Eingreifen - oder zurück zu jetzt.
    const bandKarte = band ? (
      <section className="vp-tb-band" aria-live="polite">
        <div className="vp-tb-band-l">
          {band.role && (
            <span
              className="vp-tb-band-ic"
              style={{ background: roleColor(band.role, t), color: RUHE_ROLLEN.has(band.role) ? t.ink : '#FFFFFF' }}
              aria-hidden="true"
            >
              <Icon name={ROLLEN_SYMBOL[band.role]} size={20} strokeWidth={2.1} />
            </span>
          )}
          <div className="vp-tb-band-t">
            <span className="vp-tb-moment-kopf">
              {band.kopf}
              {istJetzt && held && <ProvBadge art={held.badgeArt} />}
            </span>
            {band.was && <span className="vp-tb-band-was">{band.was}</span>}
            {band.zahl && <span className="vp-tb-moment-zahl">{band.zahl}</span>}
            {istJetzt && held?.adjust && <span className="vp-tb-moment-zahl">{held.adjust}</span>}
            {istJetzt && held && <JetztMesswerte view={held} />}
          </div>
        </div>
        {band.warum ? (
          <button type="button" className="vp-tb-warumsatz" onClick={() => hin(waageRef.current)}>
            <b>Warum?</b> {band.warum} <span className="vp-tb-mehr">Zur Waage ›</span>
          </button>
        ) : (
          <span />
        )}
        <div className="vp-tb-band-r">
          {istJetzt ? (
            <>
              {zustand}
              {eingreifen}
            </>
          ) : (
            zurueckKnopfEl
          )}
        </div>
      </section>
    ) : null;

    return (
      <div ref={huelle} className="vp-tb is-bild">
        {kopf(false)}
        {bandKarte}
        <section className="vp-tb-bildkarte" aria-label="Tagesverlauf">
          <div className="vp-tb-bildleiste">
            <span className="vp-tb-legende" aria-hidden="true">
              <i className="vp-tb-legende-soc" />
              Ladestand, geplant
              <span className="vp-tb-hinweis">Maus darüber: Einzelheiten · Klick wählt den Moment</span>
            </span>
            {werteLeiste}
          </div>
          <FahrplanBildfahrplan
            tag={tag}
            breite={Math.max(0, breite - 2 * BILDKARTE_RAND)}
            auswahl={auswahl}
            istJetzt={istJetzt}
            markierung={antwort?.ziel ?? null}
            fokus={bildFokus}
            onWahl={waehlen}
            onJetzt={zurueckZuJetzt}
          />
        </section>
        {antwortListe}
        {antwortBanner}
        <div className="vp-tb-unten">
          <div className="vp-tb-spalte">
            {waageKarte}
            {stationenKarte}
          </div>
          <div className="vp-tb-spalte">{annahmenKarte}</div>
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

  // Unter der Uhr: die angetippte Antwort ersetzt die Zeile zum Moment (Prototyp).
  const unterDerUhr = (
    <>
      {antwortBanner ?? momentText}
      {!antwortBanner && zurueckKnopfEl && <div className="vp-tb-reihe is-mitte">{zurueckKnopfEl}</div>}
    </>
  );

  const zustandZeile = istJetzt ? (
    <div className="vp-tb-todo">
      {zustand}
      {held && <JetztMesswerte view={held} />}
      {eingreifen}
    </div>
  ) : null;

  if (zweispaltig) {
    return (
      <div ref={huelle} className="vp-tb is-uhr is-zweispaltig">
        {kopf(false)}
        <div className="vp-tb-spalten">
          <div className="vp-tb-bildspalte">
            {uhrTeil}
            {werteLeiste}
            {ebenenNotiz}
            {unterDerUhr}
            {waageKarte}
          </div>
          <div className="vp-tb-textspalte">
            {tourKarte}
            {antwortListe}
            {warumZeile}
            {zustandZeile}
            {stationenKarte}
            {annahmenKarte}
          </div>
        </div>
      </div>
    );
  }

  // Telefon (E1/E9): Kopfsatz, die Uhr, Werte und Moment, direkt darunter die
  // Antworten — alle im ersten Bildschirm. Warum, Zustand, Waage, Stationen
  // und Annahmen folgen darunter.
  return (
    <div ref={huelle} className="vp-tb is-uhr">
      {kopf(true)}
      {uhrTeil}
      {werteLeiste}
      {ebenenNotiz}
      {unterDerUhr}
      {antwortListe}
      {warumZeile}
      {zustandZeile}
      {waageKarte}
      {stationenKarte}
      {annahmenKarte}
      {tourKarte}
    </div>
  );
}

/** Innenrand der Bildkarte (px, 14 px Polster + 1 px Rand) — das Bild zeichnet 1 : 1 auf die Breite darin. */
const BILDKARTE_RAND = 15;
