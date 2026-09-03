/**
 * Das gemeinsame SKELETT beider Historie-Welten (Konzept
 * `data/vp-historie-konzept-t4` §4.2, seit E3 in der Form von
 * `vp-erloese-lesbar-konzept-u3` §3.5): unsichtbare Überschrift → klebende
 * Zeit-Leiste (EINE Zeile) → Karten → Fußkarte. Reine Render-Bausteine; jede
 * Ableitung/Copy lebt im reinen `historieWelten.ts` (das
 * `PeakBand`/`FleetOverview`-Muster).
 *
 * ⚠ **Die Frage „was schaue ich gerade an?" beantworten die BEREICHS-REITER**
 * (`anlageNav` Verlauf › Messwerte · Erlöse), nicht mehr eine Kopf-Karte. Sie
 * kostete 189 px vor der ersten Zahl, und das Kartenpaar darin war der Reiter
 * ein zweites Mal — gemessen stand die Antwort dadurch bei 779 px (1440).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import { type IconCategory } from '../../designsystem/components/core/IconTile';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';
import type { HistoryCoverage, HistoryRange } from '../api';
import { vergleichName } from '../chartCopy';
import { useIsPhone } from '../useIsPhone';
import { useScrolledPast } from '../useScrolledPast';
import {
  PROVENIENZ,
  type Provenienz,
  type Welt,
} from '../historieWelten';
import {
  abdeckungView,
  ankerAusWert,
  sprungFeld,
  sprungGrenzen,
  sprungJahre,
  sprungLabel,
  sprungWert,
  streifenAnker,
  streifenSlots,
  zeigtStreifen,
} from '../historieZeit';
import {
  vergleichsChip,
  vergleichsOptionen,
  type DeltaView,
  type UeberlagerungLegende,
  type VergleichsModus,
} from '../historieVergleich';
import { PERIOD_RANGES, periodLabel, shiftAnchor } from '../periodNav';
import { MiniShareBar } from './MiniChart';
import { MonthStrip } from './MoneyView';

import './Historie.css';

/** Das Ehrlichkeits-Abzeichen einer Karte (genau eines je Karte, report §7). */
export function ProvBadge({ art }: { art: Provenienz }) {
  const info = PROVENIENZ[art];
  return (
    <span className={`vp-prov vp-prov-${art}`} title={info.satz}>
      {info.label}
    </span>
  );
}

/**
 * Der Kopf einer Karte: Überschrift, Abzeichen — die eine Zeile, die jede
 * Karte beider Welten gleich aufbaut.
 *
 * **⚠ Er trägt seit E9 KEINE Icon-Kachel mehr** (Konzept
 * `vp-erloese-lesbar-konzept-u3` §3.10 Punkt 6, Befund B5): fünf bis sechs
 * 40-px-Kacheln in je eigener Kategoriefarbe machten jede Karte gleich laut —
 * gemessen sprang das Auge im Fünf-Sekunden-Test Hero → grüne Fläche → grüne
 * Zahl → Chart, nie in die Reihenfolge der Fragen. Die Hierarchie trägt jetzt
 * Größe und Abstand (16/700 Titel), nicht Farbe. `icon`/`category` bleiben in
 * der Signatur, weil jede Aufrufstelle sie führt und sie die Karte weiterhin
 * BENENNEN (Tooltip/Debug) — sie rendern nur nichts mehr.
 *
 * **Das Abzeichen bleibt unangetastet** — es ist die Ehrlichkeitsregel
 * (report §7), nicht Zierrat.
 */
export function KartenKopf({
  icon,
  category = 'dynamic',
  titel,
  art,
  extra,
}: {
  icon: IconName;
  category?: IconCategory;
  titel: string;
  art: Provenienz;
  extra?: ReactNode;
}) {
  // `icon`/`category` sind seit E9 nur noch Metadaten der Aufrufstelle.
  void icon;
  void category;
  return (
    <div className="vp-section-head vp-kartenkopf">
      <h2>{titel}</h2>
      <ProvBadge art={art} />
      {extra}
    </div>
  );
}

/**
 * Der Welt-Kopf ist seit E3 **eine unsichtbare Überschrift und sonst nichts**
 * (Konzept `vp-erloese-lesbar-konzept-u3` §3.5, Befund B4).
 *
 * Was er war: eine Karte mit 44-px-Icon-Kachel, Titel, Abzeichen,
 * Einleitungssatz und dem Kartenpaar für den Welt-Wechsel — **189 px (1440)
 * VOR der Antwort**, und dahinter klebte die Zeit-Leiste. Was er sagte, sagen
 * die Bereichs-Reiter darüber schon (`anlageNav` Verlauf › Messwerte · Erlöse),
 * das Abzeichen sitzt seit je an jeder Karte (`KartenKopf`), und das Kartenpaar
 * war der Reiter ein zweites Mal.
 *
 * **Warum trotzdem ein `h1`:** ohne ihn hätte die Seite gar keine Überschrift —
 * die Schale trägt nur den Pfad, keine Titelzeile. Er bleibt für die
 * Dokumentstruktur und für Screenreader (`.vp-sr-only`), kostet 0 px und nennt
 * dieselben zwei Dinge wie das Abzeichen: Welt und Art der Zahlen.
 */
export function WeltKopf({ welt }: { welt: Welt }) {
  return (
    <h1 className="vp-sr-only">
      {welt.label} — {PROVENIENZ[welt.badge].label}
    </h1>
  );
}

/**
 * **Die geteilte Zeit-Leiste: EIN Rahmen für alle sechs Verlauf-Reiter**
 * (Konzept `vp-verlauf-sprache-konzept-v5` §3.2 V3, Paket P1).
 *
 * Vorher gab es DREI Zeitraum-Bedienungen und drei Reiter ganz ohne (Befund
 * B2): `ZeitLeiste` (Messwerte/Erlöse), die alte `.vp-seg` in einem zweiten
 * `vp-page-head` (Marktpreise) — und Lastspitzen/Prognose/Wetter hatten keine.
 * Dieser Rahmen ist der EINE Wirt; die Reiter füllen ihn nur mit ihren
 * Bedienelementen (`ZeitSegment`, `ZeitBlaetterer`), sie bauen ihn nicht nach.
 *
 * ⚠ **Er KLEBT am Telefon und kollabiert dabei auf die erste Zeile**
 * (Captain-Entscheid E4 b2, 03.09.2026, wörtlich: „b2) klebend, beim Scrollen
 * auf die Segment-Zeile (58 px) kollabiert"). Das löst den Widerspruchs-Kasten
 * W1 auf: die frühere Festlegung „am Telefon NICHT klebend" (E3 aus `u3`) gilt
 * für den Verlauf — und damit auch für die Erlöse-Seite — nicht mehr. Ohne
 * Kleben war der Zeitraum ab der ersten Karte (345 px) nicht mehr erreichbar;
 * mit zwei dauerhaft klebenden Zeilen (108 px) wäre das Bild kleiner geworden.
 *
 * ⚠ **Der Kollaps hängt an einem 1-px-WÄCHTER über der Leiste, nicht an einem
 * Scroll-Ereignis je Bild.** Ein `scroll`-Listener rechnete auf jedem Frame und
 * flackerte an der Umschaltschwelle; der `IntersectionObserver` feuert genau
 * zweimal je Richtung. Verlässt der Wächter das Bild, klebt die Leiste ⇒ zweite
 * Zeile weg; kommt er zurück, ist man wieder oben ⇒ zwei Zeilen.
 *
 * ⚠ **Die HÖHE wird NICHT animiert.** Eine Höhen-Transition auf einem
 * klebenden Element schiebt den Inhalt darunter für die Dauer der Bewegung —
 * genau der Layout-Sprung, den das Kleben verhindern soll. Bewegt werden nur
 * Deckkraft und ein 4-px-Versatz der zweiten Zeile (`--vp-c-motion`), und unter
 * `prefers-reduced-motion` gar nichts (Regel in `Historie.css`).
 */
export function ZeitLeisteRahmen({
  zeile1,
  zeile2,
  mobil,
  className,
  children,
}: {
  /** Die IMMER sichtbare Zeile (Segment bzw. Blätterer) — sie bleibt beim Kollaps. */
  zeile1: ReactNode;
  /** Die zweite Zeile am Telefon; am Schreibtisch steht sie in DERSELBEN Zeile. */
  zeile2?: ReactNode;
  /** Ohne `mobil` rendert der Rahmen die Schreibtisch-Fassung (eine 58-px-Zeile). */
  mobil: boolean;
  className?: string;
  /** Was NACH der Leiste im selben Fragment steht (Blatt/Popover). */
  children?: ReactNode;
}) {
  // ⚠ Der Wächter hängt an `useScrolledPast` — dem HAUS-Haken für genau diese
  // Frage (Mobil-Umbau Stufe 2). Er bringt zwei Lehren mit, die eine eigene
  // Fassung hier neu bezahlen müsste: die Anbindung ist ein CALLBACK-Ref (ein
  // Effekt auf `ref.current` liefe gegen `null`, solange die Leiste noch lädt —
  // im Browser genau so aufgefallen), und er zählt nur ein Hinausscrollen nach
  // OBEN. Ohne `IntersectionObserver` (jsdom) bleibt er `false`: dann kollabiert
  // nichts, statt dass etwas kollabiert, das niemand ausgelöst hat.
  const [wache, klebt] = useScrolledPast<HTMLDivElement>(mobil && zeile2 != null);

  if (mobil) {
    return (
      <>
        {/* Der 1-px-Wächter: er steht IM Fluss über der Leiste und sagt allein
            durch sein Verschwinden, dass die Leiste klebt. */}
        <div ref={wache} className="vp-zl-wache" aria-hidden="true" />
        <div
          className={`vp-zeitleiste vp-zeitleiste-mobil${className ? ` ${className}` : ''}`}
          data-kollabiert={klebt && zeile2 ? 'ja' : undefined}
        >
          <div className="vp-zl-row vp-zl-row-1">{zeile1}</div>
          {zeile2 && <div className="vp-zl-row vp-zl-row-2">{zeile2}</div>}
        </div>
        {children}
      </>
    );
  }

  return (
    <div className={`vp-zeitleiste${className ? ` ${className}` : ''}`}>
      <div className="vp-zl-row">
        {zeile1}
        {zeile2}
      </div>
      {children}
    </div>
  );
}

/**
 * Das Zeitraum-SEGMENT der Leiste — die 44-px-Bahn, die auf allen sechs Reitern
 * gleich aussieht. Generisch über den Wert, damit Marktpreise (Zeiträume) und
 * Prognose (Bewertungsfenster) DIESELBE Bedienung tragen statt zweier eigener.
 */
export function ZeitSegment<T extends string>({
  label,
  optionen,
  wert,
  onWert,
}: {
  label: string;
  optionen: readonly { id: T; label: string }[];
  wert: T;
  onWert: (w: T) => void;
}) {
  return (
    <div className="vp-seg" role="tablist" aria-label={label}>
      {optionen.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={wert === o.id}
          className={wert === o.id ? 'active' : ''}
          onClick={() => onWert(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Der BLÄTTERER der Leiste — ‹ Zeitraum › (+ „Heute", wo es einen gibt).
 *
 * ⚠ Der Sprung-Knopf heißt bewusst NICHT überall „Heute": auf Lastspitzen
 * blättert man über Abrechnungsperioden, dort ist „Aktuelle Periode" die
 * ehrliche Beschriftung. Ohne `onJetzt` gibt es ihn gar nicht — ein Knopf, der
 * nichts anspringen kann, wäre ein Versprechen ohne Deckung.
 */
export function ZeitBlaetterer({
  label,
  onZurueck,
  onVor,
  zurueckDisabled,
  vorDisabled,
  jetztLabel,
  onJetzt,
  extra,
}: {
  label: string;
  onZurueck: () => void;
  onVor: () => void;
  zurueckDisabled?: boolean;
  vorDisabled?: boolean;
  jetztLabel?: string;
  onJetzt?: () => void;
  extra?: ReactNode;
}) {
  return (
    <div className="vp-period-nav">
      <button
        type="button"
        className="step"
        aria-label="Vorheriger Zeitraum"
        disabled={zurueckDisabled}
        onClick={onZurueck}
      >
        <Icon name="chevron-left" size={18} />
      </button>
      <span className="label">{label}</span>
      <button
        type="button"
        className="step"
        aria-label="Nächster Zeitraum"
        disabled={vorDisabled}
        onClick={onVor}
      >
        <Icon name="chevron-right" size={18} />
      </button>
      {onJetzt && (
        <button type="button" className="step" onClick={onJetzt}>
          {jetztLabel ?? 'Heute'}
        </button>
      )}
      {extra}
    </div>
  );
}

/**
 * Der unsichtbare Seitenkopf der vier Reiter, die bis P1 einen SICHTBAREN
 * trugen (`SUB_PAGES` in `AnlagenPage`, Befund B1): sein Titel + Lead-Absatz
 * standen ÜBER den Bereichs-Reitern und schoben sie von 140 auf 287/316 px —
 * die Reiterleiste sprang also bei jedem Reiterwechsel.
 *
 * Es ist wörtlich die Form von {@link WeltKopf}: eine `h1` für die
 * Dokumentstruktur und für Screenreader, 0 px auf der Fläche. Was der Kopf
 * SAGTE, sagen die Reiter darüber; der Lead-Satz lebt in {@link VerlaufFuss}
 * weiter — er ist Nachschlage-Text, kein Scrollweg-Inhalt.
 */
export function VerlaufKopf({ titel }: { titel: string }) {
  return <h1 className="vp-sr-only">{titel}</h1>;
}

/**
 * Die Fußzeile der vier Reiter: der frühere Lead-Satz als Aufklapper, in der
 * Form von {@link WeltFuss}. Am Schreibtisch als ruhige Karte, am Telefon
 * zugeklappt — er kostet dort eine Zeile statt eines Absatzes.
 *
 * ⚠ Der Satz wird WÖRTLICH übernommen. Er ist Kunden-Sprache und war die
 * einzige Stelle, an der die Fläche sagt, was sie überhaupt zeigt; ihn beim
 * Entfernen des Seitenkopfs zu verlieren wäre kein Aufräumen, sondern ein
 * Verlust.
 */
export function VerlaufFuss({ titel, text }: { titel?: string; text: string }) {
  const isPhone = useIsPhone();
  const [open, setOpen] = useState(false);
  const kopf = titel ?? 'Was diese Zahlen zeigen';

  if (isPhone) {
    return (
      <WeltDisclosure titel={kopf} open={open} onToggle={() => setOpen((o) => !o)}>
        <p className="vp-welt-fusstext">{text}</p>
      </WeltDisclosure>
    );
  }

  return (
    <section className="vp-section">
      <Card padding="lg" radius="lg" className="vp-welt-fuss">
        <b>{kopf}</b>
        <p>{text}</p>
      </Card>
    </section>
  );
}

/**
 * Das Sprungfeld der Zeit-Leiste (F2): der Haus-Picker in seiner Datums- bzw.
 * Jahres-Fassung.
 *
 * ⚠ Es war ein NATIVES Feld, mit der Begründung „der Browser bringt seinen
 * Kalender mit". Seit dem Picker-System (`vp-picker-system`, Captain-Entscheid
 * 1) gilt das Gegenteil: der System-Kalender sieht auf jedem Betriebssystem
 * anders aus als der Rest der Seite, und er beginnt auf einem englisch
 * eingestellten Rechner am SONNTAG — was eine Kalenderwochen-Auswahl
 * unbrauchbar macht. Der Haus-Kalender beginnt immer am Montag und trägt seine
 * KW-Spalte.
 *
 * Der WERT bleibt unverändert ISO (`JJJJ-MM-TT` / `JJJJ-Www` / `JJJJ-MM` /
 * `JJJJ`), `ankerAusWert` liest ihn also weiter unverändert.
 *
 * Grenzen kommen aus der Datenlage: nie in die Zukunft, nie vor die erste
 * gemessene Viertelstunde (`historieZeit.sprungGrenzen`).
 */
function Sprungfeld({
  range,
  anchor,
  now,
  coverage,
  onAnchor,
}: {
  range: HistoryRange;
  anchor: Date;
  now: Date;
  coverage?: HistoryCoverage | null;
  onAnchor: (d: Date) => void;
}) {
  const feld = sprungFeld(range);
  const label = sprungLabel(range);
  const wert = sprungWert(anchor, range);

  const uebernehmen = (v: string) => {
    const d = ankerAusWert(v, range);
    if (d) onAnchor(d);
  };

  if (feld === 'year') {
    // Ein Jahr ist eine Liste, kein Kalender - dafür gibt es kein Datumsfeld.
    return (
      <VpPicker
        className="vp-zl-jump"
        ariaLabel={label}
        options={sprungJahre(anchor, now, coverage).map((j) => ({
          value: String(j),
          label: String(j),
        }))}
        value={wert}
        onChange={uebernehmen}
      />
    );
  }

  const grenzen = sprungGrenzen(range, now, coverage);
  return (
    <VpDatePicker
      className="vp-zl-jump"
      ariaLabel={label}
      art={feld === 'week' ? 'woche' : feld === 'month' ? 'monat' : 'tag'}
      value={wert}
      onChange={uebernehmen}
      min={grenzen.min}
      max={grenzen.max}
    />
  );
}

/**
 * Die Datenlage-Zeile der Zeit-Leiste (F4): „Daten ab 19.06.2026 ▇▇▇▇░ 94 % der
 * Viertelstunden gemessen · 6 Lücken". Sie rendert NICHTS, wenn es nichts
 * Ehrliches zu sagen gibt — eine behauptete Abdeckung wäre schlimmer als keine.
 */
function AbdeckungZeile({
  coverage,
  stale,
}: {
  coverage?: HistoryCoverage | null;
  stale?: boolean;
}) {
  const view = abdeckungView(coverage);
  if (!view) return null;
  return (
    <div className={stale ? 'vp-zl-cover vp-zl-cover-stale' : 'vp-zl-cover'} title={view.titel}>
      {view.abText && <span className="vp-zl-ab">{view.abText}</span>}
      {view.balkenPct != null && (
        <MiniShareBar
          className="vp-zl-bar"
          size="micro"
          fraction={view.balkenPct / 100}
          ariaLabel={`Datenabdeckung ${view.balkenPct} Prozent`}
        />
      )}
      {view.satz && <span className="vp-zl-sat">{view.satz}</span>}
      {view.luecken && <span className="vp-zl-gap">· {view.luecken}</span>}
    </div>
  );
}

/**
 * **F8 · der „Vergleichen"-Umschalter.** Er steht in der Zeit-Leiste, weil er
 * eine Frage AN DEN ZEITRAUM ist („und wie war es davor?") — dieselbe Stelle,
 * dieselbe Geste. Er rendert nichts, wenn die Welt ihn nicht anbietet.
 *
 * Die Ehrlichkeit steckt im `hinweis`: trägt die gewählte Vergleichsperiode
 * keine Zahlen, sagt der Umschalter das (statt eine leere Reihe zu zeichnen,
 * die sich wie gemessene Nullen läse).
 */
function VergleichsSchalter({
  range,
  anchor,
  coverage,
  modus,
  onModus,
  hinweis,
}: {
  range: HistoryRange;
  anchor: Date;
  coverage?: HistoryCoverage | null;
  modus: VergleichsModus;
  onModus: (m: VergleichsModus) => void;
  hinweis?: string | null;
}) {
  const optionen = vergleichsOptionen(anchor, range, coverage);
  return (
    <div className="vp-zl-vgl">
      <span className="vp-zl-vgl-label" id="vp-zl-vgl-label">
        Vergleichen
      </span>
      <div className="vp-seg vp-seg-compact" role="group" aria-labelledby="vp-zl-vgl-label">
        {optionen.map((o) => (
          <button
            key={o.id}
            type="button"
            title={o.titel}
            aria-pressed={modus === o.id}
            className={modus === o.id ? 'active' : ''}
            onClick={() => onModus(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {hinweis && (
        <span className="vp-zl-vgl-hinweis" role="status">
          {hinweis}
        </span>
      )}
    </div>
  );
}

/**
 * Die Legenden-Zeile der Überlagerung (F8) — sie NENNT beide Zeiträume, damit
 * „durchgezogen" und „blass" nie geraten werden müssen.
 */
export function UeberlagerungLegendeZeile({
  legende,
}: {
  legende: UeberlagerungLegende | null;
}) {
  if (!legende) return null;
  return (
    <p className="vp-vgl-legende">
      <span className="vp-vgl-jetzt">{legende.aktuell}</span>
      {/* M9: die Geister-Ebene trägt ihr WORT, nicht nur ihre Strichelung -
          derselbe Ausdruck wie in den Tooltips und Reihen-Namen der drei
          Vergleichsflächen (`chartCopy.vergleichName`). */}
      <span className="vp-vgl-vorher">{vergleichName(legende.vergleich)}</span>
    </p>
  );
}

/**
 * Die klebende Zeit-Leiste — [Tag|Woche|Monat|Jahr] ‹ Anker › Heute + Datumsfeld,
 * seit E3 **EINE Zeile** (58 px klebend am Schreibtisch, zwei nicht klebende am
 * Telefon). Monatsstreifen, „Vergleichen" und Datenlage liegen hinter dem
 * Datum-Feld.
 *
 * Sie steht in BEIDEN Welten an derselben Stelle und regiert alles darunter
 * (dieselbe Idee wie die Bilanz-Leiste des Cockpits: der Zeitraum steht bei den
 * Zahlen, die er regiert). Klebend, weil man beim Lesen langer Seiten sonst
 * nach oben scrollen muss, um die Periode zu wechseln — aber nur so hoch, wie
 * ein Bedienelement wirklich ist.
 *
 * **Der Schrittknopf ist nicht mehr die einzige Geste in die Vergangenheit**
 * (F2): daneben stehen das Sprungfeld und — dort, wo Blättern wirklich weh tut
 * (Tag: 211 Klicks in den Januar, Monat: 7) — der Monatsstreifen aus der
 * Geld-Ansicht, hier als reiner Navigator ohne erfundene Zahlen.
 */
/**
 * **Das ⋯-Blatt der Mobil-Bedienzeile** (P4, Konzept `data/vp-mobile-views-x1`).
 * Gelegenheits-Bedienung — Datums-Sprungfeld, „Vergleichen" und die
 * Datenlage-Zeile — steht am Telefon nicht dauerhaft in einer KLEBENDEN Leiste,
 * wo jede Zeile dauerhaft Bildschirm kostet, sondern hinter einem Knopf.
 *
 * Es benutzt bewusst die Blatt-Klassen der Schale (`.vp-sheet*`, `Shell.css`):
 * das Haus hat EIN Bottom-Sheet-Aussehen, und `AppShell` ist der Wirt jeder
 * dieser Seiten, das Stylesheet ist also garantiert geladen.
 */
function ZeitBlatt({
  onClose,
  children,
}: {
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="vp-sheet-scrim" onClick={onClose} aria-hidden="true" />
      <div className="vp-sheet vp-zl-blatt" role="dialog" aria-label="Zeitraum & Vergleich">
        <div className="vp-sheet-head">
          <span>Zeitraum &amp; Vergleich</span>
          <button type="button" aria-label="Schließen" onClick={onClose}>
            <Icon name="x" size={20} />
          </button>
        </div>
        {children}
      </div>
    </>
  );
}

/**
 * **Das Popover der Zeit-Leiste am Schreibtisch** (E3, §3.5).
 *
 * Es ist der Zwilling des Telefon-Blatts: dieselben drei Gelegenheits-Dinge
 * (Monatsstreifen · „Vergleichen" · Datenlage), nur als Panel unter dem
 * Datum-Feld statt als Bottom-Sheet. Vorher standen sie als drei zusätzliche
 * ZEILEN in einer KLEBENDEN Leiste — 199 px, die bei jedem Scrollen 30 % des
 * Bildschirms verdeckten (Befund B4).
 *
 * Escape schließt, ein Klick daneben schließt; der Scrim ist durchsichtig, weil
 * dies keine Entscheidung ist, die den Rest der Seite ausblenden müsste.
 */
export function ZeitPopover({
  onClose,
  children,
}: {
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="vp-zl-pop-scrim" onClick={onClose} aria-hidden="true" />
      <div className="vp-zl-pop" role="dialog" aria-label="Zeitraum & Vergleich">
        {children}
      </div>
    </>
  );
}

export function ZeitLeiste({
  range,
  anchor,
  onRange,
  onAnchor,
  coverage,
  stale,
  vergleich,
  onVergleich,
  vergleichHinweis,
  now = new Date(),
}: {
  range: HistoryRange;
  anchor: Date;
  onRange: (r: HistoryRange) => void;
  onAnchor: (d: Date) => void;
  /** Datenabdeckung des gezeigten Zeitraums (F4) — optional. */
  coverage?: HistoryCoverage | null;
  /** Die Abdeckung gehört noch zur vorherigen Periode (P5: gedimmt). */
  stale?: boolean;
  /** F8: der gewählte Vergleichs-Modus — ohne `onVergleich` gibt es keinen Schalter. */
  vergleich?: VergleichsModus;
  onVergleich?: (m: VergleichsModus) => void;
  /** Die ehrliche Zeile, wenn die Vergleichsperiode nichts trägt. */
  vergleichHinweis?: string | null;
  now?: Date;
}) {
  const nextDisabled = shiftAnchor(anchor, range, 1) > now;
  const streifen = zeigtStreifen(range);
  const isPhone = useIsPhone();
  const [blattOffen, setBlattOffen] = useState(false);
  // Der gesetzte Vergleich bleibt SICHTBAR, auch wenn seine Bedienung im Blatt
  // wohnt — sonst überlagerte das Diagramm eine Reihe, die niemand bestellt zu
  // haben scheint.
  const chip = vergleichsChip(anchor, range, vergleich ?? 'aus');

  const blaetterer = (
    <ZeitBlaetterer
      label={periodLabel(anchor, range)}
      onZurueck={() => onAnchor(shiftAnchor(anchor, range, -1))}
      onVor={() => onAnchor(shiftAnchor(anchor, range, 1))}
      vorDisabled={nextDisabled}
      onJetzt={() => onAnchor(new Date())}
      extra={
        !isPhone ? (
          <Sprungfeld
            range={range}
            anchor={anchor}
            now={now}
            coverage={coverage}
            onAnchor={onAnchor}
          />
        ) : undefined
      }
    />
  );

  const perioden = (
    <ZeitSegment label="Zeitraum" optionen={PERIOD_RANGES} wert={range} onWert={onRange} />
  );

  const schalter = onVergleich ? (
    <VergleichsSchalter
      range={range}
      anchor={anchor}
      coverage={coverage}
      modus={vergleich ?? 'aus'}
      onModus={onVergleich}
      hinweis={vergleichHinweis}
    />
  ) : null;

  /**
   * **Telefon: ZWEI klebende Zeilen, alles Übrige im ⋯-Blatt** (P3/P4). Vorher
   * klebten hier bis zu vier Zeilen (Perioden · Blätterer · Vergleichen ·
   * Datenlage) — dauerhaft, denn die Leiste klebt, und sie waren der Grund,
   * warum das erste Diagramm erst bei 1 908 px begann.
   */
  if (isPhone) {
    return (
      <ZeitLeisteRahmen
        mobil
        zeile1={
          <>
            {perioden}
            <button
              type="button"
              className="vp-zl-more"
              aria-label="Zeitraum & Vergleich"
              aria-expanded={blattOffen}
              onClick={() => setBlattOffen(true)}
            >
              <Icon name="more-horizontal" size={18} />
            </button>
          </>
        }
        zeile2={
          <>
            {blaetterer}
            {chip && (
              <button
                type="button"
                className="vp-zl-chip"
                title="Vergleich ändern"
                onClick={() => setBlattOffen(true)}
              >
                {chip}
              </button>
            )}
          </>
        }
      >
        {blattOffen && (
          <ZeitBlatt onClose={() => setBlattOffen(false)}>
            <div className="vp-zl-blatt-feld">
              <span className="vp-zl-blatt-label">{sprungLabel(range)}</span>
              <Sprungfeld
                range={range}
                anchor={anchor}
                now={now}
                coverage={coverage}
                onAnchor={onAnchor}
              />
            </div>
            {schalter}
            <AbdeckungZeile coverage={coverage} stale={stale} />
          </ZeitBlatt>
        )}
      </ZeitLeisteRahmen>
    );
  }

  /**
   * **Schreibtisch: EINE Zeile, 58 px klebend** (E3, §3.5). Segment · ‹ Datum ›
   * · Heute · Datum-Feld — und dahinter, im Popover, Monatsstreifen,
   * „Vergleichen" und die Datenlage. Vorher waren es bis zu vier gestapelte
   * Zeilen (199 px), die zusammen mit der 68-px-Kopfzeile der Schale dauerhaft
   * 267 px verdeckten und die Antwort auf 779 px hinunterdrückten (B4).
   *
   * Der gesetzte Vergleich bleibt in der Leiste SICHTBAR — genau wie am
   * Telefon: eine überlagerte Reihe, deren Schalter im Popover wohnt, hätte
   * sonst niemand bestellt.
   */
  const hatPopInhalt = streifen || schalter != null || abdeckungView(coverage) != null;

  return (
    <ZeitLeisteRahmen
      mobil={false}
      zeile1={
        <>
          {perioden}
          {blaetterer}
          {chip && (
          <button
            type="button"
            className="vp-zl-chip"
            title="Vergleich ändern"
            onClick={() => setBlattOffen(true)}
          >
            {chip}
          </button>
        )}
        {hatPopInhalt && (
          <button
            type="button"
            className="vp-zl-more"
            aria-label="Monat, Vergleich & Datenlage"
            aria-expanded={blattOffen}
            onClick={() => setBlattOffen((o) => !o)}
          >
            <Icon name="more-horizontal" size={18} />
          </button>
        )}
        </>
      }
    >
      {blattOffen && hatPopInhalt && (
        <ZeitPopover onClose={() => setBlattOffen(false)}>
          {streifen && (
            <MonthStrip
              slots={streifenSlots(now, coverage)}
              selectedMonth={`${sprungWert(anchor, 'month')}-01`}
              showValues={false}
              ariaLabel="Monat anspringen"
              onSelect={(monthIso) => {
                const d = streifenAnker(monthIso, range, now);
                if (d) onAnchor(d);
              }}
            />
          )}
          {schalter}
          <AbdeckungZeile coverage={coverage} stale={stale} />
        </ZeitPopover>
      )}
    </ZeitLeisteRahmen>
  );
}

/**
 * Die Vergleichszeile einer Kennzahl (F3) — „18 % mehr als im Juni". Rendert
 * NICHTS ohne ehrlichen Vergleich (`delta()` gibt dann null zurück): ein Δ
 * gegen eine erfundene Null wäre die teuerste Art zu lügen.
 */
export function DeltaZeile({ delta }: { delta: DeltaView | null }) {
  if (!delta) return null;
  return (
    <span className={`vp-delta vp-delta-${delta.wertung}`} title={delta.titel}>
      {delta.richtung !== 'gleich' && (
        <Icon name={delta.richtung === 'mehr' ? 'arrow-up' : 'arrow-down'} size={12} />
      )}
      {delta.text}
    </span>
  );
}

/**
 * P5-Vervollständigung: das Blättern lässt die alte Periode stehen — schlägt
 * der Abruf der NEUEN fehl, muss die Seite das sagen, sonst liest sich der
 * gedimmte Rest wie ein Ergebnis. Ein Balken, keine Karte: die Zahlen darunter
 * bleiben sichtbar, sie gehören nur zu einem anderen Zeitraum.
 */
export function PeriodeFehlgeschlagen({
  periode,
  onRetry,
}: {
  periode: string;
  onRetry: () => void;
}) {
  return (
    <div className="vp-zl-fehler" role="status">
      <Icon name="alert-triangle" size={16} aria-hidden="true" />
      <span>
        {periode} konnte nicht geladen werden — angezeigt bleibt der zuletzt geladene Zeitraum.
      </span>
      <button type="button" onClick={onRetry}>
        Erneut versuchen
      </button>
    </div>
  );
}

/**
 * **Ein benannter Aufklapper** — das gemeinsame Muster beider Welten am Telefon
 * (Konzept `data/vp-mobile-views-x1`): eine Zeile mit Titel, ruhiger Unterzeile
 * und Chevron; geöffnet steht der VOLLE Inhalt darin. Es wird nichts gekürzt,
 * nur einsortiert — deshalb behält jeder geöffnete Abschnitt seinen Kartenkopf
 * samt Ehrlichkeits-Abzeichen.
 *
 * Dasselbe DOM benutzt der Messwerte-Explorer seit dem Historie-Konzept; er ist
 * die Vorlage, aus der dieses Bauteil herausgelöst wurde.
 */
export function WeltDisclosure({
  titel,
  sub,
  open,
  onToggle,
  children,
}: {
  titel: string;
  sub?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="vp-section">
      <Card padding="lg" radius="lg" className="vp-welt-disc-card">
        <button
          type="button"
          className={open ? 'vp-welt-disclosure open' : 'vp-welt-disclosure'}
          aria-expanded={open}
          onClick={onToggle}
        >
          <span className="vp-wd-title">{titel}</span>
          {sub && <span className="vp-wd-sub">{sub}</span>}
          <span className="vp-wd-chev" aria-hidden="true">
            <Icon name="chevron-down" size={20} />
          </span>
        </button>
        {open && <div className="vp-welt-disclosure-body">{children}</div>}
      </Card>
    </section>
  );
}

/**
 * Die Fußkarte „Was diese Zahlen sind" — je Welt genau einmal, am Ende.
 *
 * **Am Telefon ist sie ein Aufklapper**: der Text ist die Einschränkung, unter
 * der die ganze Welt zu lesen ist (bewertet ≠ abgerechnet), also muss er
 * erreichbar bleiben — aber er ist Nachschlage-Text, kein Scrollweg-Inhalt.
 * Zugeklappt kostet er eine Zeile statt eines Absatzes; sein Wortlaut ist
 * unverändert.
 */
export function WeltFuss({ welt }: { welt: Welt }) {
  const isPhone = useIsPhone();
  const [open, setOpen] = useState(false);

  if (isPhone) {
    return (
      <WeltDisclosure
        titel="Was diese Zahlen sind"
        open={open}
        onToggle={() => setOpen((o) => !o)}
      >
        <p className="vp-welt-fusstext">{welt.fussText}</p>
      </WeltDisclosure>
    );
  }

  return (
    <section className="vp-section">
      <Card padding="lg" radius="lg" className="vp-welt-fuss">
        <b>Was diese Zahlen sind</b>
        <p>{welt.fussText}</p>
      </Card>
    </section>
  );
}
