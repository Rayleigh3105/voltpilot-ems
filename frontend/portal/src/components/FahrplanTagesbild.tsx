/**
 * Das TAGESBILD der Fahrplan-Seite (Überblick 20.10.2026, Variante A „echte
 * Uhr"; Rückmeldung: „mobile immer noch sehr überladen", „die Uhr geht nicht
 * nach der Uhr im echten Leben").
 *
 *  - Telefon: die STATUS-ZEILE (wer was tut, darunter höchstens drei
 *    Stichworte), die UHR wie am Handgelenk (ein Ring: was ab jetzt kommt),
 *    zwei KACHELN (Heute Abend · Heute geplant) und eingeklappt „Ihr Tag"
 *    und „Gut zu wissen". Gestern und morgen erzählt ein Satz den Tag, die Uhr
 *    zeigt Vor- oder Nachmittag.
 *  - 640–899 px: die Uhr links, Status, Kacheln und Abschnitte rechts.
 *  - ab 900 px Inhaltsbreite: Status mit drei Kacheln, das TAGESBAND
 *    (Phasen oben, Ladestand gemessen | geplant, Sonne und Preis), darunter
 *    „Ihr Tag" | „Gut zu wissen".
 *
 * Das Warum (Satz, Waage, alle Gründe) wohnt in EINEM Blatt: hinter der
 * Status-Zeile, hinter jedem Bogen der Uhr und jedem Block des Tagesbands.
 * Der Gerätezustand steht nur, wenn das Gerät NICHT dem Plan folgt.
 *
 * Dieses Bauteil hält nur den Zustand der Bedienung; jede Aussage kommt aus
 * den reinen Modulen `fahrplanTag`, `fahrplanUhr`, `fahrplanTagesband`,
 * `fahrplanAntworten`, `fahrplanWaage`, `fahrplanIst` und `fahrplanTagesbild`.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { Modal } from '../../designsystem/components/shell/Modal';
import { chartTheme } from '../chartTheme';
import { haptik } from '../haptik';
import type { AnnahmeZeile } from '../fahrplanAnnahmen';
import { antworten, type Antwort } from '../fahrplanAntworten';
import { fmtNum } from '../format';
import { uhrzeit, type TagModell } from '../fahrplanTag';
import {
  BILD_AB_PX,
  ROLLEN_SYMBOL,
  ZWEISPALTIG_AB_PX,
  jetztZeile,
  kopfsatz,
  momentBand,
  stationen,
  type TagArt,
  type TagOhneBild,
} from '../fahrplanTagesbild';
import { sonnenBogen, uhrFenster, uhrModell, uhrPhasen, uhrUnterschrift, type UhrHaelfte, type UhrPhase } from '../fahrplanUhr';
import { spanneSatz, waage } from '../fahrplanWaage';
import type { WhySlot } from '../fahrplanWhy';
import type { JetztHeldView } from '../fahrplanJetzt';
import type { AutarkieHeute, SonnenstromModell } from '../fahrplanSonnenstrom';
import type { PlanWordingKind } from '../schedule';
import type { SpeicherAussage } from '../speicherAussage';
import { InfoTip } from './InfoTip';
import { FahrplanAntworten, FahrplanWaage } from './FahrplanAntworten';
import { FahrplanTagesband } from './FahrplanTagesband';
import { JetztMesswerte } from './FahrplanJetzt';
import { FahrplanUhr } from './FahrplanUhr';
import { roleColor } from './FahrplanWhy';
import { ProvBadge } from './HistorieWelt';
import './FahrplanTagesbild.css';

export interface FahrplanTagesbildProps {
  tag: TagModell;
  /**
   * Der Folgetag (jüngster Lauf): heute läuft die Uhr über Mitternacht in ihn
   * hinein. null = noch kein Plan für morgen, dann endet der Ring um 24 Uhr.
   */
  folgetag?: TagModell | null;
  plantKind: PlanWordingKind;
  /** Die Steuerungs-Aussage des Tages (E6); null = keine Geld-Kachel. */
  speicher: SpeicherAussage | null;
  siteId: string;
  /** Die Viertelstunde i, wie sie die Waage liest (jüngster Lauf, sonst der Tag). */
  slotFuerWarum: (i: number) => WhySlot | null;
  /** Das volle Erklär-Panel der Viertelstunde i. */
  warumPanel: (i: number, schliessen: () => void) => ReactNode;
  /** Das Erklär-Panel einer Phase von `tag.phasenRoh`; null = keins. */
  phasenPanel?: ((phaseIndex: number, schliessen: () => void) => ReactNode) | null;
  /** Dasselbe für eine Phase des Folgetags (Bögen nach Mitternacht). */
  phasenPanelFolgetag?: ((phaseIndex: number, schliessen: () => void) => ReactNode) | null;
  /** Wohin der Nachtrag-Satz der Geld-Antwort führt. */
  nachtragHref?: string;
  /** Die Jetzt-Aussage (Ausführung und Messung, `jetztHeld`); null = nur der Plan. */
  held?: JetztHeldView | null;
  /** „Gut zu wissen" (`fahrplanAnnahmen.planAnnahmen`). */
  annahmen?: AnnahmeZeile[];
  /** Wie der Fahrplan berechnet wird - klein an „Gut zu wissen". */
  berechnung?: string | null;
  /** Öffnet das bisherige Diagramm mit allen Werten; null = kein Verweis. */
  onAlleWerte?: (() => void) | null;
  /** Der Hinweis auf morgen unter den Stationen („Morgen · 3 weitere Phasen"). */
  morgen?: string | null;
  /** Der Tag des Tagesschalters (E2 = A); ohne Angabe heute. */
  art?: TagArt;
  /**
   * Die IST-SPUR: der gemessene Ladestand je Viertelstunde von `tag.slots`
   * (`fahrplanIst.istLadestand`); leer = keine Messung, dann spricht der Plan.
   */
  ist?: readonly (number | null)[];
  /** Der gemessene Ladestand JETZT (frische Telemetrie); null = keiner. */
  jetztLadestand?: number | null;
  /**
   * Die Sonnen-Erzählung (Konzept `vp-fahrplan-eigenverbrauch-konzept`,
   * `preisRolle(...).erzaehlung === 'sonne'`); Vorgabe `false` lässt Stationen,
   * Waage und Lupe unverändert (Preis-Erzählung).
   */
  sonne?: boolean;
  /** Herkunft der Einspeisevergütung für die Spanne (§4.4); null = unbekannt. */
  verguetungHerkunft?: string | null;
  /** Vergütung nicht hinterlegt (§5.2, die „Lücke"); Vorgabe `false`. */
  verguetungLuecke?: boolean;
  /**
   * Die Start-Zeitstempel der Viertelstunden ohne Vergütung (§ 51a,
   * `preisRolle(...).nullstunden`, auf Zeitstempel übersetzt - siehe
   * `fahrplanUhr.sonnenBogen`); Vorgabe = leere Menge.
   */
  nullstundenZeiten?: ReadonlySet<string>;
  /** Die Autarkie-Kachel „Aus eigenem Strom X %" (§4.3/§4.5); Vorgabe `null`. */
  autarkie?: AutarkieHeute | null;
  /** Die zwei Balken „Ihr Sonnenstrom heute" (§4.5); Vorgabe `null` = kein Abschnitt. */
  sonnenstrom?: SonnenstromModell | null;
}

/** Rollen, deren Farbe hell ist: ihr Symbol steht dunkel. */
const RUHE_ROLLEN = new Set(['warten', 'reserve_halten', 'abregeln']);
const KEINE_MESSUNG: readonly (number | null)[] = [];
const KEINE_ZEITEN: ReadonlySet<string> = new Set();

export function FahrplanTagesbild({
  tag,
  folgetag = null,
  plantKind,
  speicher,
  siteId,
  slotFuerWarum,
  warumPanel,
  phasenPanel = null,
  phasenPanelFolgetag = null,
  nachtragHref,
  held = null,
  annahmen = [],
  berechnung = null,
  onAlleWerte = null,
  morgen = null,
  art = 'heute',
  ist = KEINE_MESSUNG,
  jetztLadestand = null,
  sonne = false,
  verguetungHerkunft = null,
  verguetungLuecke = false,
  nullstundenZeiten = KEINE_ZEITEN,
  autarkie = null,
  sonnenstrom = null,
}: FahrplanTagesbildProps) {
  const t = chartTheme();
  const huelle = useRef<HTMLDivElement | null>(null);
  const [breite, setBreite] = useState(0);
  // Eine im Tagesband gewählte Viertelstunde; null = jetzt (bzw. keine).
  const [wahl, setWahl] = useState<number | null>(null);
  const [antwort, setAntwort] = useState<Antwort | null>(null);
  const [warumOffen, setWarumOffen] = useState(false);
  const [alleGruende, setAlleGruende] = useState(false);
  const [zustandOffen, setZustandOffen] = useState(false);
  const [phasenWahl, setPhasenWahl] = useState<{ quelle: UhrPhase['quelle']; phaseIndex: number } | null>(null);
  const [tagOffen, setTagOffen] = useState(false);
  const [wissenOffen, setWissenOffen] = useState(false);
  const [sonnenstromOffen, setSonnenstromOffen] = useState(false);
  const [haelfte, setHaelfte] = useState<UhrHaelfte>('vormittag');

  // ---- Breite: Uhr oder Tagesband ------------------------------------------------
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

  // Ein neuer Tag bzw. ein Lauf mit anderem Anfang: die Auswahl gilt nicht mehr.
  const erster = tag.slots[0]?.start ?? null;
  useEffect(() => {
    setWahl(null);
    setAntwort(null);
  }, [erster]);

  const jetztI = tag.jetztIndex;
  const n = tag.slots.length;
  const auswahl = wahl ?? (jetztI >= 0 ? jetztI : -1);
  const istJetzt = wahl == null && jetztI >= 0;
  const mitJetzt = istJetzt && tag.jetzt != null;

  const liste = useMemo(
    () => antworten({ tag, auswahl: Math.max(0, auswahl), istJetzt, speicher, art, autarkie: sonne ? autarkie : null }),
    [tag, auswahl, istJetzt, speicher, art, sonne, autarkie],
  );
  const satz = useMemo(() => kopfsatz(tag, art), [tag, art]);
  const halte = useMemo(() => stationen(tag, plantKind, ist, sonne), [tag, plantKind, ist, sonne]);
  const uhrPh = useMemo(() => uhrPhasen(tag, art === 'heute' ? folgetag : null), [tag, folgetag, art]);
  const fenster = useMemo(() => uhrFenster(tag, uhrPh, haelfte), [tag, uhrPh, haelfte]);
  const uhr = useMemo(() => uhrModell(uhrPh, fenster), [uhrPh, fenster]);
  const sonnenbogen = useMemo(
    () => (sonne ? sonnenBogen(tag, fenster, nullstundenZeiten) : []),
    [sonne, tag, fenster, nullstundenZeiten],
  );

  if (n === 0) return null;

  const warumSlot = auswahl >= 0 ? slotFuerWarum(auswahl) : null;
  const w = warumSlot
    ? sonne
      ? spanneSatz({
          importCtKwh: warumSlot.importPriceCtKwh ?? null,
          exportCtKwh: warumSlot.exportValueCtKwh ?? null,
          verguetungHerkunft,
          luecke: verguetungLuecke,
        })
      : waage(warumSlot, plantKind)
    : null;
  const band = auswahl >= 0 ? momentBand(tag, auswahl, istJetzt, held, w?.urteil ?? null) : null;
  const jz = auswahl >= 0 ? jetztZeile(tag, auswahl, istJetzt, held, plantKind, jetztLadestand) : null;
  const erloeseHref = `#/anlage/${siteId}/erloese`;

  const zurueck = () => {
    haptik('jetzt');
    setWahl(null);
    setAntwort(null);
  };
  /** Jede Bedienstelle am Telefon spielt eines der drei Muster (`haptik.ts`). */
  const umschalten = (setzen: (f: (o: boolean) => boolean) => void) => () => {
    haptik('tick');
    setzen((o) => !o);
  };
  const warumOeffnen = () => {
    haptik('tick');
    setWarumOffen(true);
  };

  // ---- Bausteine ------------------------------------------------------------------

  const eingreifen = (
    <a className="vp-tb-knopf" href={`#/anlage/${siteId}/steuerung`}>
      Eingreifen …
    </a>
  );

  const hatWarum = Boolean(band?.warum || w);

  /** Wer was tut, darunter höchstens drei Stichworte; ein Tipp öffnet das Warum. */
  const statusInhalt = jz ? (
    <>
      <span
        className="vp-tb-jetzt-ic"
        style={{
          background: jz.role ? roleColor(jz.role, t) : t.neutral,
          color: jz.role && RUHE_ROLLEN.has(jz.role) ? t.ink : '#FFFFFF',
        }}
        aria-hidden="true"
      >
        {jz.role && <Icon name={ROLLEN_SYMBOL[jz.role]} size={20} strokeWidth={2.1} />}
      </span>
      <span className="vp-tb-status-t">
        {!mitJetzt && <span className="vp-tb-status-kopf">{art === 'heute' ? jz.kopf : `${art === 'gestern' ? 'Gestern' : 'Morgen'} · ${jz.kopf}`}</span>}
        <b className="vp-tb-status-titel">
          {jz.titel ?? 'Kein Plan'}
          {/* „Geplant" nur ohne Gerätezeile: die sagt schon, dass nichts bestätigt ist. */}
          {mitJetzt && jz.geplant && !jz.zustand && <ProvBadge art="geplant" />}
        </b>
        {jz.unterzeile && <span className="vp-tb-status-unter">{jz.unterzeile}</span>}
      </span>
    </>
  ) : null;

  const statusZeile = jz ? (
    hatWarum ? (
      <button type="button" className="vp-tb-status" onClick={warumOeffnen} aria-label={`${jz.titel ?? ''}. ${jz.unterzeile ?? ''}. Warum?`}>
        {statusInhalt}
        <Icon name="help-circle" size={18} className="vp-tb-status-warum" aria-hidden="true" />
      </button>
    ) : (
      <div className="vp-tb-status">{statusInhalt}</div>
    )
  ) : null;

  /** Der Gerätezustand - nur, wenn das Gerät nicht dem Plan folgt. */
  const zustandZeile =
    mitJetzt && jz?.zustand ? (
      <div className="vp-tb-zustand-wrap">
        <button
          type="button"
          className={`vp-tb-zustand is-${jz.zustand.ton}`}
          aria-expanded={zustandOffen}
          onClick={umschalten(setZustandOffen)}
          title={jz.zustand.lang}
        >
          <i aria-hidden="true" />
          <span>{jz.zustand.kurz}</span>
          <Icon name="chevron-down" size={14} />
        </button>
        {zustandOffen && (
          <div className="vp-tb-zustand-detail">
            <p>{jz.zustand.lang}</p>
            {held && <JetztMesswerte view={held} />}
            {eingreifen}
          </div>
        )}
      </div>
    ) : null;

  /** Gestern und morgen: der Tag in einem Satz statt des Jetzt. */
  const tagSatz = satz ? <p className="vp-tb-tagsatz">{satz}</p> : null;

  const kacheln = (form: 'kacheln' | 'spalten') => {
    const nur = form === 'kacheln' ? liste.filter((a) => a.key !== 'weiter') : liste;
    return (
      <FahrplanAntworten
        antworten={nur}
        gewaehlt={antwort?.key ?? null}
        onWahl={(a) => {
          haptik('ziel');
          setAntwort((cur) => (cur?.key === a.key ? null : a));
        }}
        form={form}
        nachtragHref={nachtragHref}
        erloeseHref={erloeseHref}
        onSonnenstromOeffnen={
          sonnenstrom
            ? () => {
                haptik('tick');
                setSonnenstromOffen(true);
              }
            : undefined
        }
      />
    );
  };

  /** Das WARUM der Viertelstunde: ein Satz, die Waage, alle Gründe. */
  const warumBlatt = (
    <Modal
      open={warumOffen}
      onClose={() => {
        setWarumOffen(false);
        setAlleGruende(false);
      }}
      title={jz?.titel ? `Warum: ${jz.titel}?` : 'Warum?'}
      blatt
    >
      {warumOffen && auswahl >= 0 && (
        <div className="vp-tb-warumblatt vp-tb-blattinhalt">
          {/* N1: ohne Gerätezustand ist band.warum GENAU der Waage-Satz
              (`w.urteil` fließt unverändert durch) - dann steht er nur einmal,
              in der Waage. Mit Gerätezustand (`held.why`) ist er ein eigener
              Satz und bleibt stehen. */}
          {band?.warum && band.warum !== w?.urteil && <p className="vp-tb-warumblatt-satz">{band.warum}</p>}
          {w && <FahrplanWaage waage={w} />}
          {/* Was gerade gemessen wird - hier immer erreichbar, auch wenn das Gerät ruhig ist. */}
          {mitJetzt && held && <JetztMesswerte view={held} />}
          {!alleGruende ? (
            <button type="button" className="vp-tb-link" onClick={() => setAlleGruende(true)}>
              Alle Gründe und Zahlen ›
            </button>
          ) : (
            warumPanel(auswahl, () => setAlleGruende(false))
          )}
        </div>
      )}
    </Modal>
  );

  /** Das Warum einer Phase (Bogen der Uhr, Block des Tagesbands). */
  const phasenQuelle = phasenWahl?.quelle === 'folgetag' ? folgetag : tag;
  const phasenFn = phasenWahl?.quelle === 'folgetag' ? phasenPanelFolgetag : phasenPanel;
  const gewaehltePhase = phasenWahl ? phasenQuelle?.phasen.find((p) => p.phaseIndex === phasenWahl.phaseIndex) : null;
  const phasenBlatt = (
    <Modal
      open={phasenWahl != null && phasenFn != null}
      onClose={() => setPhasenWahl(null)}
      title={gewaehltePhase ? `${gewaehltePhase.label} · ${uhrzeit(gewaehltePhase.von)}–${uhrzeit(gewaehltePhase.bis)}` : 'Phase'}
      blatt
    >
      {phasenWahl != null && phasenFn ? (
        <div className="vp-tb-blattinhalt">{phasenFn(phasenWahl.phaseIndex, () => setPhasenWahl(null))}</div>
      ) : null}
    </Modal>
  );
  const phaseOeffnen = (p: { quelle: UhrPhase['quelle']; phaseIndex: number }) => {
    if ((p.quelle === 'folgetag' ? phasenPanelFolgetag : phasenPanel) == null) return;
    setPhasenWahl({ quelle: p.quelle, phaseIndex: p.phaseIndex });
  };

  /** Ihr Tag: eine Zeile je Phase; ein Tipp öffnet ihr Warum im Blatt. */
  const stationenListe = (
    <>
      <ol className="vp-st">
        {halte.map((st) => (
          <li
            key={st.phaseIndex}
            className={`vp-st-halt${st.vorbei ? ' is-vorbei' : ''}${st.laeuft ? ' is-jetzt' : ''}${RUHE_ROLLEN.has(st.role) ? ' is-ruhe' : ''}`}
            style={{ ['--vp-st-farbe' as string]: roleColor(st.role, t) }}
          >
            <span className="vp-st-punkt" aria-hidden="true">
              <Icon name={ROLLEN_SYMBOL[st.role]} size={13} strokeWidth={2.2} stroke={RUHE_ROLLEN.has(st.role) ? t.ink : '#FFFFFF'} />
            </span>
            <button
              type="button"
              className="vp-st-zeile"
              aria-haspopup="dialog"
              onClick={() => {
                haptik('tick');
                phaseOeffnen({ quelle: 'tag', phaseIndex: st.phaseIndex });
              }}
            >
              <span className="vp-st-zeit">{st.zeit}</span>
              <span className="vp-st-name">
                {st.laeuft && <span className="vp-st-jetzt">Jetzt</span>}
                {st.label}
                {st.abweichung && <span className="vp-st-abw">{st.abweichung}</span>}
              </span>
              {st.ladestand && (
                <span className={`vp-st-soc${st.gemessen ? ' is-gemessen' : ''}`} title={st.gemessen ? 'gemessen' : st.vorbei ? 'war geplant' : 'geplant'}>
                  {st.ladestand}
                </span>
              )}
              <Icon name="chevron-right" size={14} className="vp-st-pfeil" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ol>
      {morgen && <p className="vp-tb-fein">{morgen}</p>}
      <p className="vp-tb-fein">
        {art === 'morgen'
          ? 'Geplant – VoltPilot rechnet den Plan bis dahin alle 15 Minuten neu.'
          : ist.some((x) => x != null)
            ? 'Ladestand: vergangene Phasen gemessen, kommende geplant.'
            : 'Vergangene Phasen zeigen den Plan, der damals galt.'}{' '}
        <a href={`#/anlage/${siteId}/messwerte`}>Messwerte ›</a>
      </p>
    </>
  );

  /**
   * „Ihr Sonnenstrom heute" (Konzept `vp-fahrplan-eigenverbrauch-konzept`
   * §4.5, Scheibe S3): zwei Balken - wohin die Sonne floss/fließt, woher das
   * Haus seinen Verbrauch deckte/deckt. „Auto" hat keinen eigenen Messwert
   * (Wallbox-Konzept separat) und bleibt ein Gedankenstrich.
   */
  const sonnenstromListe = sonnenstrom ? (
    <>
      <p className="vp-tb-sonnenstrom-zeile">
        <b>Ihre Sonne:</b> {fmtNum(sonnenstrom.sonne.gesamtKwh, 'kWh', 0)} — Haus {fmtNum(sonnenstrom.sonne.haus, 'kWh', 0)} ·
        Speicher {fmtNum(sonnenstrom.sonne.speicher, 'kWh', 0)} · Auto – · Netz {fmtNum(sonnenstrom.sonne.netz, 'kWh', 0)}
      </p>
      <p className="vp-tb-sonnenstrom-zeile">
        <b>Ihr Haus:</b> {fmtNum(sonnenstrom.haus.gesamtKwh, 'kWh', 0)} — Sonne {fmtNum(sonnenstrom.haus.sonne, 'kWh', 0)} ·
        Speicher {fmtNum(sonnenstrom.haus.speicher, 'kWh', 0)} · Netz {fmtNum(sonnenstrom.haus.netz, 'kWh', 0)}
      </p>
      {sonnenstrom.wallboxHinweis && <p className="vp-tb-fein">{sonnenstrom.wallboxHinweis}</p>}
      <p className="vp-tb-fein">Heute bis jetzt gemessen, der Rest geplant.</p>
    </>
  ) : null;

  /** Gut zu wissen: Eingaben und Grenzen des Plans, der Weg zu allen Werten. */
  const annahmenListe =
    annahmen.length > 0 || onAlleWerte ? (
      <>
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
      </>
    ) : null;

  const tagTitel = art === 'gestern' ? 'Der Tag gestern' : art === 'morgen' ? 'Der Tag morgen' : 'Ihr Tag';

  if (bild) {
    return (
      <div ref={huelle} className="vp-tb is-bild">
        <section className="vp-tb-jetzt" aria-live="polite">
          <div className="vp-tb-jetzt-haupt">
            {mitJetzt || wahl != null ? statusZeile : tagSatz}
            {zustandZeile}
            <div className="vp-tb-jetzt-knoepfe">
              {wahl != null && jetztI >= 0 && (
                <button type="button" className="vp-tb-zurueck" onClick={zurueck}>
                  <Icon name="history" size={14} />
                  Zurück zu jetzt
                </button>
              )}
              {mitJetzt && !jz?.zustand && eingreifen}
            </div>
          </div>
          {kacheln('spalten')}
        </section>
        <section className="vp-tb-bandkarte" aria-label="Tagesverlauf">
          <div className="vp-tb-bandleiste">
            <p className="vp-tb-bandsatz">{art === 'heute' && satz ? satz : 'Der Tag im Bild'}</p>
            <span className="vp-tb-legende" aria-hidden="true">
              <span>
                <i className="is-ist" /> gemessen
              </span>
              <span>
                <i className="is-plan" /> geplant
              </span>
            </span>
          </div>
          <FahrplanTagesband
            tag={tag}
            ist={ist}
            breite={Math.max(0, breite - 2 * BANDKARTE_RAND)}
            auswahl={Math.max(0, auswahl)}
            istJetzt={istJetzt}
            gewaehlt={wahl != null}
            markierung={antwort?.ziel ?? null}
            onWahl={(i) => setWahl(i === jetztI ? null : i)}
            onJetzt={zurueck}
            onPhase={(p) => phaseOeffnen({ quelle: 'tag', phaseIndex: p })}
            sonne={sonne}
          />
        </section>
        <div className="vp-tb-unten">
          <section className="vp-tb-karte2" aria-label={tagTitel}>
            <h3 className="vp-tb-karte2-titel">{tagTitel}</h3>
            {stationenListe}
          </section>
          {sonnenstromListe && (
            <section className="vp-tb-karte2 vp-tb-karte2-breit" aria-label="Ihr Sonnenstrom heute">
              <h3 className="vp-tb-karte2-titel">Ihr Sonnenstrom heute</h3>
              {sonnenstromListe}
            </section>
          )}
          {annahmenListe && (
            <section className="vp-tb-karte2" aria-label="Gut zu wissen">
              <div className="vp-tb-karte2-kopf">
                <h3 className="vp-tb-karte2-titel">Gut zu wissen</h3>
                {berechnung && <InfoTip title="Wie der Fahrplan berechnet wird">{berechnung}</InfoTip>}
              </div>
              {annahmenListe}
            </section>
          )}
        </div>
        {warumBlatt}
        {phasenBlatt}
      </div>
    );
  }

  const uhrKarte = (
    <section className="vp-tb-uhrkarte" aria-label="Die Uhr">
      <FahrplanUhr
        modell={uhr}
        beschriftung={mitJetzt ? 'Die Uhr: was ab jetzt kommt' : `Die Uhr: ${uhrUnterschrift(fenster)}`}
        onPhase={phaseOeffnen}
        sonnenbogen={sonnenbogen}
      />
      {fenster.zeiger == null ? (
        <div className="vp-tb-haelfte" role="group" aria-label="Tageshälfte">
          {(['vormittag', 'nachmittag'] as const).map((h) => (
            <button
              key={h}
              type="button"
              aria-pressed={haelfte === h}
              onClick={() => {
                if (h !== haelfte) haptik('tick');
                setHaelfte(h);
              }}
            >
              {h === 'vormittag' ? 'Vormittag' : 'Nachmittag'}
            </button>
          ))}
        </div>
      ) : (
        <span className="vp-tb-uhr-unter">{uhrUnterschrift(fenster)}</span>
      )}
    </section>
  );

  /** Eingeklappte Abschnitte am Telefon: Ihr Tag, Gut zu wissen. */
  const abschnitte = (
    <div className="vp-tb-zu">
      <button type="button" className="vp-tb-zu-kopf" aria-expanded={tagOffen} onClick={umschalten(setTagOffen)}>
        <span>{tagTitel}</span>
        <Icon name="chevron-down" size={18} />
      </button>
      {tagOffen && <div className="vp-tb-zu-inhalt">{stationenListe}</div>}
      {sonnenstromListe && (
        <>
          <button
            type="button"
            className="vp-tb-zu-kopf"
            aria-expanded={sonnenstromOffen}
            onClick={umschalten(setSonnenstromOffen)}
          >
            <span>Ihr Sonnenstrom heute</span>
            <Icon name="chevron-down" size={18} />
          </button>
          {sonnenstromOffen && <div className="vp-tb-zu-inhalt">{sonnenstromListe}</div>}
        </>
      )}
      {annahmenListe && (
        <>
          <button type="button" className="vp-tb-zu-kopf" aria-expanded={wissenOffen} onClick={umschalten(setWissenOffen)}>
            <span>Gut zu wissen</span>
            <Icon name="chevron-down" size={18} />
          </button>
          {wissenOffen && (
            <div className="vp-tb-zu-inhalt">
              {annahmenListe}
              {berechnung && <p className="vp-tb-fein">{berechnung}</p>}
            </div>
          )}
        </>
      )}
    </div>
  );

  const kopfTeil = mitJetzt ? (
    <>
      {statusZeile}
      {zustandZeile}
    </>
  ) : (
    tagSatz
  );

  if (zweispaltig) {
    return (
      <div ref={huelle} className="vp-tb is-uhr is-zweispaltig">
        <div className="vp-tb-spalten">
          <div className="vp-tb-bildspalte">{uhrKarte}</div>
          <div className="vp-tb-textspalte">
            {kopfTeil}
            {kacheln('kacheln')}
            {abschnitte}
          </div>
        </div>
        {warumBlatt}
        {phasenBlatt}
      </div>
    );
  }

  // Telefon: Status, Uhr, zwei Kacheln - dann eingeklappt Ihr Tag und Gut zu wissen.
  return (
    <div ref={huelle} className="vp-tb is-uhr">
      {kopfTeil}
      {uhrKarte}
      {kacheln('kacheln')}
      {abschnitte}
      {warumBlatt}
      {phasenBlatt}
    </div>
  );
}

/**
 * Ein Tag des Tagesschalters ohne Tagesbild: der Grund an der Stelle des
 * Bildes (`fahrplanTagesbild.tagOhneBild`), nie eine leere Fläche.
 */
export function TagOhneBildKarte({
  zustand,
  siteId,
  onErneut,
}: {
  zustand: TagOhneBild;
  siteId: string;
  onErneut: () => void;
}) {
  return (
    <section className="vp-tb-leer" aria-live="polite" aria-busy={zustand.laedt || undefined}>
      <span className="vp-tb-leer-ic" aria-hidden="true">
        <Icon name={zustand.laedt ? 'refresh-cw' : zustand.erneut ? 'alert-triangle' : 'calendar'} size={20} />
      </span>
      <div className="vp-tb-leer-t">
        <p className="vp-tb-leer-titel">{zustand.titel}</p>
        {zustand.text && <p className="vp-tb-leer-text">{zustand.text}</p>}
        {(zustand.mitMesswerte || zustand.erneut) && (
          <div className="vp-tb-reihe">
            {zustand.mitMesswerte && (
              <a className="vp-tb-link" href={`#/anlage/${siteId}/messwerte`}>
                Zu den Messwerten ›
              </a>
            )}
            {zustand.erneut && (
              <button type="button" className="vp-tb-knopf" onClick={onErneut}>
                Erneut versuchen
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** Innenrand der Bandkarte (px, 24 px Polster + 1 px Rand) - das Band zeichnet 1 : 1 auf die Breite darin. */
const BANDKARTE_RAND = 25;
