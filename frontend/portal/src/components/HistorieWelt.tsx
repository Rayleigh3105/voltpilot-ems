/**
 * Das gemeinsame SKELETT beider Historie-Welten (Konzept
 * `data/vp-historie-konzept-t4` §4.2): Welt-Kopf → klebende Zeit-Leiste →
 * Karten → Fußkarte. Reine Render-Bausteine; jede Ableitung/Copy lebt im reinen
 * `historieWelten.ts` (das `PeakBand`/`FleetOverview`-Muster).
 *
 * Warum ein eigener Kopf statt der generischen Seiten-Überschrift: die Frage
 * „was schaue ich gerade an?" wird hier an Icon, Farbe, Titel, Abzeichen UND
 * dem Kartenpaar gleichzeitig beantwortet — und der Kopf ersetzt die frühere
 * Titel-/Untertitelzeile, statt sie zu ergänzen. Genau daran hing die
 * 515-px-Kopfzone am Telefon (vier Bedienzeilen: Welt · Zeitraum · Blätterer ·
 * Modus); übrig bleiben zwei.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import { IconTile, type IconCategory } from '../../designsystem/components/core/IconTile';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';
import type { HistoryCoverage, HistoryRange } from '../api';
import { vergleichName } from '../chartCopy';
import { useIsPhone } from '../useIsPhone';
import {
  PROVENIENZ,
  type Provenienz,
  type Welt,
  type WeltSwitchCard,
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
 * Der Kopf einer Karte: Icon-Kachel, Überschrift, Abzeichen — die eine Zeile,
 * die jede Karte beider Welten gleich aufbaut.
 *
 * **Am Telefon schrumpft die Kachel** (40 → 28 px) und der Abstand darunter mit
 * ihr: gemessen kostete der Kopf dort 76 px ÜBER dem Diagramm, das im ersten
 * Bildschirm stehen soll. **Das Abzeichen bleibt unangetastet** — es ist die
 * Ehrlichkeitsregel (report §7), nicht Zierrat; nur seine Kachel wird kleiner.
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
  const isPhone = useIsPhone();
  return (
    <div
      className="vp-section-head"
      style={{ marginBottom: isPhone ? '10px' : 'var(--vp-space-4)' }}
    >
      <IconTile category={category} size={isPhone ? 28 : 40}>
        <Icon name={icon} size={isPhone ? 15 : 20} />
      </IconTile>
      <h2>{titel}</h2>
      <ProvBadge art={art} />
      {extra}
    </div>
  );
}

/**
 * Welt-Kopf: Icon · Titel · Abzeichen · Einleitungssatz, darunter das
 * Kartenpaar für den Ein-Klick-Wechsel (leer = es gibt nur eine Welt, dann
 * rendert kein einsamer Schalter).
 *
 * **Am Telefon (≤ 720 px) schrumpft er auf EINE Zeile** (Konzept
 * `data/vp-mobile-views-x1`, Captain-Abnahme 09.08.2026): Icon · Weltname ·
 * Ehrlichkeits-Abzeichen. Zwei Dinge entfallen dort und beide aus gutem Grund —
 * das **Kartenpaar**, weil Messwerte und Erlöse seit dem Mobil-Umbau Stufe 1
 * eigene Plätze der Bottom-Bar sind (der Wechsel ist einen Daumen entfernt,
 * 170 px Karten dafür sind Doppelung), und der **Einleitungssatz**, weil er die
 * Frage „was schaue ich an?" beantwortet, die der Bar-Slot schon beantwortet
 * hat. **Das Abzeichen bleibt** — es ist die Ehrlichkeitsregel, nicht Deko.
 */
export function WeltKopf({
  welt,
  cards,
  hrefFor,
  onOpen,
}: {
  welt: Welt;
  cards: WeltSwitchCard[];
  /** Der Link der Welt — echtes `href`, damit Öffnen-in-neuem-Tab funktioniert. */
  hrefFor: (card: WeltSwitchCard) => string;
  onOpen: (card: WeltSwitchCard) => void;
}) {
  const isPhone = useIsPhone();

  if (isPhone) {
    return (
      <div className={`vp-welt-zeile vp-welt-${welt.id}`}>
        <span className="vp-welt-zeile-ico" aria-hidden="true">
          <Icon name={welt.icon} size={17} />
        </span>
        <h1>{welt.label}</h1>
        <ProvBadge art={welt.badge} />
      </div>
    );
  }

  return (
    <Card
      padding="lg"
      radius="lg"
      className={`vp-welt-kopf vp-welt-${welt.id}`}
      // Die Kartenpolsterung ist am Telefon der größte Posten der Kopfzone;
      // `Card` setzt sie inline, also führen wir sie über eine Variable, die
      // die Medienabfrage schrumpfen kann (`style` gewinnt gegen `padding`).
      style={{ padding: 'var(--vp-welt-pad)' }}
    >
      <div className="vp-welt-head">
        <IconTile category="dynamic" size={44} style={{ background: 'var(--vp-welt-grad)' }}>
          <Icon name={welt.icon} size={22} />
        </IconTile>
        <div className="vp-welt-titles">
          <h1>
            {welt.label}
            <ProvBadge art={welt.badge} />
          </h1>
          <p>{welt.lead}</p>
        </div>
      </div>
      {cards.length > 1 && (
        <div className="vp-welt-switch" role="group" aria-label="Ansicht wechseln">
          {cards.map((card) => (
            <a
              key={card.welt.id}
              className={`vp-wsw vp-welt-${card.welt.id}${card.active ? ' on' : ''}`}
              href={hrefFor(card)}
              aria-current={card.active ? 'page' : undefined}
              onClick={(e) => {
                // Modifier-Klicks (neuer Tab) dem Browser überlassen.
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                onOpen(card);
              }}
            >
              <span className="vp-wsw-ico" aria-hidden="true">
                <Icon name={card.welt.icon} size={17} />
              </span>
              <span className="vp-wsw-text">
                <span className="vp-wsw-label">{card.welt.label}</span>
                <span className="vp-wsw-sub">{card.welt.switchLead}</span>
              </span>
            </a>
          ))}
        </div>
      )}
    </Card>
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
 * Die klebende Zeit-Leiste — [Tag|Woche|Monat|Jahr] ‹ Anker › Heute 📅, darunter
 * der Monatsstreifen (Tag/Monat) und die Datenlage.
 *
 * Sie steht in BEIDEN Welten an derselben Stelle und regiert alles darunter
 * (dieselbe Idee wie die Bilanz-Leiste des Cockpits: der Zeitraum steht bei den
 * Zahlen, die er regiert). Klebend, weil man beim Lesen langer Seiten sonst
 * nach oben scrollen muss, um die Periode zu wechseln.
 *
 * **Der Schrittknopf ist nicht mehr die einzige Geste in die Vergangenheit**
 * (F2): daneben stehen das native Sprungfeld und — dort, wo Blättern wirklich
 * weh tut (Tag: 211 Klicks in den Januar, Monat: 7) — der Monatsstreifen aus
 * der Geld-Ansicht, hier als reiner Navigator ohne erfundene Zahlen.
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
    <div className="vp-period-nav">
      <button
        type="button"
        className="step"
        aria-label="Vorheriger Zeitraum"
        onClick={() => onAnchor(shiftAnchor(anchor, range, -1))}
      >
        <Icon name="chevron-left" size={18} />
      </button>
      <span className="label">{periodLabel(anchor, range)}</span>
      <button
        type="button"
        className="step"
        aria-label="Nächster Zeitraum"
        disabled={nextDisabled}
        onClick={() => onAnchor(shiftAnchor(anchor, range, 1))}
      >
        <Icon name="chevron-right" size={18} />
      </button>
      <button type="button" className="step" onClick={() => onAnchor(new Date())}>
        Heute
      </button>
      {!isPhone && (
        <Sprungfeld
          range={range}
          anchor={anchor}
          now={now}
          coverage={coverage}
          onAnchor={onAnchor}
        />
      )}
    </div>
  );

  const perioden = (
    <div className="vp-seg" role="tablist" aria-label="Zeitraum">
      {PERIOD_RANGES.map((r) => (
        <button
          key={r.id}
          role="tab"
          aria-selected={range === r.id}
          className={range === r.id ? 'active' : ''}
          onClick={() => onRange(r.id)}
        >
          {r.label}
        </button>
      ))}
    </div>
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
      <>
        <div className="vp-zeitleiste vp-zeitleiste-mobil">
          <div className="vp-zl-row vp-zl-row-1">
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
          </div>
          <div className="vp-zl-row vp-zl-row-2">
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
          </div>
        </div>
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
      </>
    );
  }

  return (
    <div className="vp-zeitleiste">
      <div className="vp-zl-row">
        {perioden}
        {blaetterer}
      </div>
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
    </div>
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
