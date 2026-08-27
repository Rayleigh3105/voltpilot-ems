import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import { GeraetBrotkrume } from './GeraetBrotkrume';
import {
  ankerId,
  initialSektionOffen,
  parseAbschnitt,
  sektionKey,
  type KopfHinweis,
  type RahmenSektionId,
  type RahmenView,
  type SektionEintrag,
} from '../geraetRahmen';
import type { GeraetTon } from '../geraetSeite';
import './GeraetRahmen.css';

/**
 * DER RAHMEN einer Geräteseite - Brotkrume, Kopf, Sprungnavigation und die
 * klappbaren Sektionen (Konzept `data/vp-geraeteseite-rahmen-r2` §4,
 * Geräteseiten Stufe 1).
 *
 * <p>Diese Datei RENDERT nur. Welche Sektionen es gibt, in welcher Reihenfolge
 * sie stehen, welche offen beginnt und was mit einer leeren passiert, entscheidet
 * die reine `src/geraetRahmen.ts` - deshalb können Wechselrichter-, Box- und
 * Ladesäulen-Seite über dieselbe Sektion nichts Verschiedenes behaupten.
 *
 * <p><b>Drei Bewegungs-Regeln</b>, alle drei aus dem Bestand übernommen:
 * <ol>
 *   <li>⚠ Gesprungen wird über <code>id</code> + <code>scrollIntoView</code> +
 *       <code>focus({preventScroll:true})</code> - <b>NIE über einen
 *       <code>#anker</code></b>: die App ist hash-geroutet, ein zweites
 *       <code>#</code> läse der Router als Route (der OCPP-Präzedenzfall).</li>
 *   <li>Der Klapp-Zustand lebt je GERÄT und je Tab-Sitzung in
 *       <code>sessionStorage</code> (das <code>useChartDetail</code>-Muster);
 *       <code>localStorage</code> bleibt portalweit verboten.</li>
 *   <li>Ein Klick in der Sprungnavigation und ein Deep-Link
 *       (<code>?abschnitt=register</code>) KLAPPEN AUF und springen dann -
 *       ein Sprung in eine geschlossene Klappe landete auf ihrem Deckel.</li>
 * </ol>
 */

interface RahmenCtx {
  eintraege: ReadonlyMap<RahmenSektionId, SektionEintrag>;
  istOffen: (id: RahmenSektionId) => boolean;
  umschalten: (id: RahmenSektionId, offen: boolean) => void;
}

const Ctx = createContext<RahmenCtx | null>(null);

/** Der Kopf einer Geräteseite (§4.1) - drei Zeilen, für jedes Gerät gleich. */
export interface RahmenKopf {
  /** Der TECHNISCHE Gerätename - nie ein Kundenalias (die Haus-Regel). */
  titel: string;
  /** Das Gattungswort daneben („Hybrid-Wechselrichter · Hauptgerät …"). */
  gattungWort?: string | null;
  /** Die Kennung, wie sie auf der Box heißt (mono). */
  kennung?: string | null;
  /** Zustands-Pill mit Zeitbezug aus dem Frische-Anker DIESES Geräts. */
  zustand?: { wort: string; ton: GeraetTon; detail: string | null } | null;
  /** Ruhige Abzeichen rechts der Pill („⚡ VoltPilot steuert …", Pflege-Ort). */
  abzeichen?: React.ReactNode;
  /** Höchstens EINER (§4.1 Zeile 3) - nichts, wenn nichts ansteht. */
  hinweis?: KopfHinweis | null;
}

export function GeraetRahmen({
  brotkrume,
  kopf,
  aktionen,
  unterKopf,
  view,
  geraetKey,
  testId,
  children,
}: {
  brotkrume: { anlageHref: string; komponentenHref: string };
  kopf: RahmenKopf;
  /** „Bearbeiten", „Gerät verschieben" - rechts im Kopf. */
  aktionen?: React.ReactNode;
  /** Was unmittelbar unter dem Kopf steht (Fassungs-Aufklapper, Warnungen). */
  unterKopf?: React.ReactNode;
  view: RahmenView;
  /** Der Schlüssel, unter dem der Klapp-Zustand dieses GERÄTS lebt. */
  geraetKey: string;
  testId?: string;
  children: React.ReactNode;
}) {
  const { sektionen } = view;
  const ids = useMemo(() => sektionen.map((s) => s.id), [sektionen]);
  const eintraege = useMemo(
    () => new Map(sektionen.map((s) => [s.id, s] as const)),
    [sektionen],
  );

  // Der Klapp-Zustand: gespeicherte Wahl > Standard. Ein nicht verfügbarer
  // Speicher (privater Modus) ist kein Fehler - dann gilt der Standard.
  const [offen, setOffen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const next: Record<string, boolean> = {};
    for (const id of ids) {
      let stored: string | null = null;
      try {
        stored = sessionStorage.getItem(sektionKey(geraetKey, id));
      } catch {
        stored = null;
      }
      next[id] = initialSektionOffen(stored, id);
    }
    setOffen(next);
  }, [geraetKey, ids]);

  const istOffen = useCallback(
    (id: RahmenSektionId) => offen[id] ?? initialSektionOffen(null, id),
    [offen],
  );

  const umschalten = useCallback(
    (id: RahmenSektionId, wert: boolean) => {
      setOffen((prev) => (prev[id] === wert ? prev : { ...prev, [id]: wert }));
      try {
        sessionStorage.setItem(sektionKey(geraetKey, id), wert ? '1' : '0');
      } catch {
        /* Kein Speicher - der Zustand lebt dann nur in dieser Ansicht. */
      }
    },
    [geraetKey],
  );

  /** Aufklappen UND hinspringen - die eine Bewegung der Sprungnavigation. */
  const springen = useCallback(
    (id: RahmenSektionId) => {
      umschalten(id, true);
      // Erst im nächsten Bild ist die aufgeklappte Sektion gemessen; ohne das
      // spränge der Browser auf ihre noch geschlossene Höhe.
      const ziel = () => {
        const el = document.getElementById(ankerId(id));
        el?.focus({ preventScroll: true });
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      if (typeof window !== 'undefined' && window.requestAnimationFrame) {
        window.requestAnimationFrame(ziel);
      } else {
        ziel();
      }
    },
    [umschalten],
  );

  // Deep-Link `?abschnitt=`: beim Aufbau UND bei jedem Hash-Wechsel, damit ein
  // Klick aus einer bereits offenen Seite heraus ebenfalls wirkt (das
  // `useSettingsAnchor`-Muster). Je Adresse GENAU EINMAL - sonst risse der
  // Sprung dem Kunden bei jedem Zustands-Takt die Ansicht weg.
  const gesprungen = useRef<string | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const pruefen = () => {
      const ziel = parseAbschnitt(window.location.hash);
      if (!ziel || !ids.includes(ziel)) return;
      const marke = `${window.location.hash}#${ziel}`;
      if (gesprungen.current === marke) return;
      gesprungen.current = marke;
      springen(ziel);
    };
    pruefen();
    window.addEventListener('hashchange', pruefen);
    return () => window.removeEventListener('hashchange', pruefen);
  }, [ids, springen]);

  const aktiv = useScrollSpy(ids);
  const ctx = useMemo<RahmenCtx>(
    () => ({ eintraege, istOffen, umschalten }),
    [eintraege, istOffen, umschalten],
  );

  return (
    <div className="vp-geraet vp-rahmen" data-testid={testId}>
      <GeraetBrotkrume
        anlageHref={brotkrume.anlageHref}
        komponentenHref={brotkrume.komponentenHref}
        titel={kopf.titel}
      />

      <Card padding="lg" radius="lg" className="vp-geraet-kopf vp-rahmen-kopf">
        <div className="vp-geraet-titleline">
          <div className="vp-rahmen-titel">
            <h1>{kopf.titel}</h1>
            {kopf.gattungWort && <p className="vp-rahmen-gattung">{kopf.gattungWort}</p>}
          </div>
          {aktionen}
        </div>
        <div className="vp-geraet-meta">
          {kopf.kennung && <span className="vp-mono vp-geraet-kennung">{kopf.kennung}</span>}
          {kopf.zustand && (
            <span
              className={`vp-pill vp-pill-${kopf.zustand.ton}`}
              data-testid="geraet-zustand"
            >
              <span className={`vp-health-dot vp-health-${kopf.zustand.ton}`} />
              {kopf.zustand.wort}
              {kopf.zustand.detail && <small> · {kopf.zustand.detail}</small>}
            </span>
          )}
          {kopf.abzeichen}
        </div>
        {/* Höchstens EINER (§4.1): der schlimmste anstehende Befund, mit dem
            Weg in die Sektion, die ihn erklärt. Ohne diese Sektion steht der
            Satz allein - nie ein Knopf ins Leere. */}
        {kopf.hinweis && (
          <p
            className={`vp-rahmen-hinweis is-${kopf.hinweis.ton}`}
            data-testid="geraet-kopfhinweis"
          >
            <Icon name="alert-triangle" size={15} />
            <span>{kopf.hinweis.satz}</span>
            {kopf.hinweis.sektion && (
              <button
                type="button"
                className="vp-linkbtn"
                onClick={() => springen(kopf.hinweis!.sektion as RahmenSektionId)}
              >
                {eintraege.get(kopf.hinweis.sektion)?.titel ?? 'Dazu'} ansehen
              </button>
            )}
          </p>
        )}
        {unterKopf}
      </Card>

      {/* Telefon: eine klebende, waagerecht scrollende Chip-Leiste UNTER dem
          Kopf (der Ort, an dem die Historie ihre Zeit-Leiste klebt). */}
      <nav className="vp-rahmen-chips" aria-label="Abschnitte dieser Seite">
        <div className="vp-seg">
          {sektionen.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-pressed={aktiv === s.id}
              className={aktiv === s.id ? 'is-an' : undefined}
              onClick={() => springen(s.id)}
            >
              {s.titel}
              {s.ton && <span className={`vp-health-dot vp-health-${s.ton}`} />}
            </button>
          ))}
        </div>
      </nav>

      <div className="vp-rahmen-body">
        {/* Rechner: die schmale, klebende Anker-Spalte mit Scroll-Spy - genau
            das Muster der Einstellungs-Seite. */}
        <nav className="vp-rahmen-nav" aria-label="Abschnitte dieser Seite">
          {sektionen.map((s) => (
            <button
              key={s.id}
              type="button"
              className={aktiv === s.id ? 'on' : undefined}
              aria-current={aktiv === s.id ? 'true' : undefined}
              onClick={() => springen(s.id)}
            >
              <Icon name={s.icon as IconName} size={16} />
              <span className="nm">{s.titel}</span>
              {s.ton && <span className={`vp-health-dot vp-health-${s.ton}`} />}
              {s.klappbar && !istOffen(s.id) && (
                <span className="zu" title="eingeklappt" aria-label="eingeklappt">
                  <Icon name="chevron-down" size={13} />
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="vp-rahmen-sektionen">
          <Ctx.Provider value={ctx}>{children}</Ctx.Provider>
        </div>
      </div>
    </div>
  );
}

/**
 * EINE Sektion des Rahmens.
 *
 * <p>Sie rendert nichts, wenn der Rahmen sie nicht anbietet - so entscheidet
 * die reine Ableitung, was existiert, und der Wirt darf seine Bausteine
 * bedingungslos hinschreiben.
 *
 * <p>„Jetzt" hat keinen Klapp-Kopf (§4.5); jede andere ist ein `<details>` mit
 * Name · Zustands-Punkt · Kurzfassung im geschlossenen Zustand.
 */
export function RahmenSektion({
  id,
  children,
}: {
  id: RahmenSektionId;
  children: React.ReactNode;
}) {
  const ctx = useContext(Ctx);
  const eintrag = ctx?.eintraege.get(id);
  if (!ctx || !eintrag) return null;
  const offen = ctx.istOffen(id);

  if (!eintrag.klappbar) {
    return (
      <section
        id={ankerId(id)}
        tabIndex={-1}
        className="vp-rahmen-sek is-offen"
        data-testid={`sektion-${id}`}
        aria-label={eintrag.titel}
      >
        {children}
      </section>
    );
  }

  return (
    <details
      id={ankerId(id)}
      tabIndex={-1}
      className="vp-rahmen-sek"
      data-testid={`sektion-${id}`}
      open={offen}
      onToggle={(e) => ctx.umschalten(id, (e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        <Icon name="chevron-right" size={14} />
        <Icon name={eintrag.icon as IconName} size={16} />
        <span className="nm">{eintrag.titel}</span>
        {eintrag.ton && <span className={`vp-health-dot vp-health-${eintrag.ton}`} />}
        {/* Die Kurzfassung trägt die geschlossene Zeile: eine Klappe, die nicht
            sagt, was hinter ihr liegt, ist die Wand, die dieser Rahmen beendet.
            Ohne belegten Teil steht die Frage da, nie ein „—". */}
        <small className="kf">{eintrag.kurzfassung ?? eintrag.frage ?? ''}</small>
      </summary>
      <div className="vp-rahmen-sek-body">{children}</div>
    </details>
  );
}

/**
 * Zu einer Sektion springen, OHNE den Rahmen-Kontext zu halten - für einen
 * Aufrufer, der außerhalb von `RahmenSektion` sitzt (die Hauptaktion einer
 * Ladesäule zeigt in ihren Befehls-Abschnitt).
 *
 * ⚠ Sie setzt `details.open` DIREKT: der native `toggle`-Event feuert auch bei
 * einer programmatischen Änderung, also übernimmt der Rahmen den Zustand über
 * sein `onToggle` - es gibt keine zweite Zustands-Wahrheit. Und wie überall
 * hier wird über `id` gesprungen, nie über einen `#anker`.
 */
export function springeZuAbschnitt(id: RahmenSektionId): void {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(ankerId(id));
  if (!el) return;
  if (el instanceof HTMLDetailsElement) el.open = true;
  const ziel = () => {
    el.focus({ preventScroll: true });
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  if (typeof window !== 'undefined' && window.requestAnimationFrame) {
    window.requestAnimationFrame(ziel);
  } else {
    ziel();
  }
}

/**
 * Hebt den Eintrag der gerade sichtbaren Sektion hervor (Rechner + Telefon).
 *
 * <p>Wörtlich das `useScrollSpy` der Einstellungs-Seite: ohne
 * `IntersectionObserver` (jsdom) bleibt schlicht die erste Sektion aktiv - der
 * Rahmen bleibt bedienbar, nur die Hervorhebung wandert nicht mit.
 */
function useScrollSpy(ids: readonly RahmenSektionId[]): RahmenSektionId | null {
  const [aktiv, setAktiv] = useState<RahmenSektionId | null>(ids[0] ?? null);
  useEffect(() => {
    setAktiv((prev) => (prev && ids.includes(prev) ? prev : ids[0] ?? null));
    if (typeof IntersectionObserver === 'undefined') return;
    const beobachtet = ids
      .map((id) => document.getElementById(ankerId(id)))
      .filter((el): el is HTMLElement => el != null);
    if (beobachtet.length === 0) return;
    const gesehen = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) gesehen.set(e.target.id, e.intersectionRatio);
        let beste: { id: RahmenSektionId; ratio: number } | null = null;
        for (const id of ids) {
          const ratio = gesehen.get(ankerId(id)) ?? 0;
          if (ratio > 0 && (beste == null || ratio > beste.ratio)) beste = { id, ratio };
        }
        if (beste) setAktiv(beste.id);
      },
      { rootMargin: '-96px 0px -55% 0px', threshold: [0, 0.2, 0.5, 1] },
    );
    beobachtet.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [ids]);
  return aktiv;
}
