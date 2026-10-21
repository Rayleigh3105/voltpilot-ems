import { useRef, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { Modal } from '../../designsystem/components/shell/Modal';
import { KNOWN_ROLES, roleLabel, type SlotRole } from '../fahrplanWhy';
import type { PlanWordingKind } from '../schedule';
import type { RollenKanonischerWert } from '../api';
import type { AnlagenSub } from '../nav';
import type { ErzeugerBuehne } from '../erzeuger';
import type { JetztFluss } from '../flussJetzt';
import { erzeugungListe, ohneAufteilung, rollenListe, verbrauchListe, type Liste } from '../flussListen';
import {
  herkunftMoment,
  knotenTexte,
  kw,
  kwh,
  PAAR_TEXT,
  PAARE,
  prozent,
  satz,
  TOTBAND_KW,
  TOTBAND_KWH,
  type Ansicht,
  type Betrieb,
  type FlussEnergie,
  type FlussWerte,
  type Herkunft,
  type Rolle,
  type Zeitbezug,
} from '../leitungsplan';
import type { PvComposition } from '../pvComposition';
import { energieBis, hoechsterBezug, tagesSkala, uhrzeit, type Tag } from '../tagesleiste';
import type { VerbrauchKomposition } from '../verbrauchKomposition';
import { BottomSheet } from './BottomSheet';
import { Leitungsplan } from './Leitungsplan';
import { Tagesleiste } from './Tagesleiste';
import './EnergieBuehne.css';

const ROLLEN = new Set<string>(KNOWN_ROLES);

/**
 * **Die Bühne des Cockpits** (Konzept `docs/konzepte/cockpit-tagesfilm`, Kopf
 * und Zeitwahl seit Konzept b1 vom 20.10.2026): Uhrzeit, Umschalter „Jetzt · kW
 * / Heute · kWh“, ein Satz zum Moment, der Energiefluss als Leitungsplan, direkt
 * darunter die Tagesleiste und danach „Verbrauch im Detail“. Jeder Knoten und
 * jede Zeile öffnet am Telefon ein Blatt, am Rechner das zentrierte `Modal`. Die
 * Listen sind der EINE Ort der Geräte im Cockpit (kein Komponenten-Board mehr
 * darunter).
 *
 * Die vier Werte des Moments stehen an den Knoten - es gibt keinen zweiten Werteblock daneben, und
 * „Überwachen“ wohnt nur unter Meldungen › Überwachungen (Konzept b1, Entscheide E1/E3).
 *
 * Messung, Plan und Jetzt bleiben getrennt: die Marke oben sagt, was gerade
 * zu sehen ist („Live“, „gemessen“, „Plan · Tätigkeit“, „Energie · gemessen“),
 * und nur „Live“ bewegt sich. Die Tagesleiste steht direkt unter dem Fluss,
 * weil die Liste beim Verlassen von „jetzt“ kürzer wird - stünde die Leiste
 * darunter, spränge sie nach dem ersten Tipp unter dem Finger weg.
 */
export function EnergieBuehne({
  jetzt,
  stale = false,
  betrieb,
  tag,
  zielKw = null,
  verbrauch = null,
  pv = null,
  rollen = null,
  reserveProzent = null,
  planKind = 'eigenverbrauch',
  isPhone,
  now = new Date(),
  onBlatt,
  onOpenSub,
  erzeuger = null,
}: {
  jetzt: JetztFluss;
  stale?: boolean;
  betrieb: Betrieb;
  /** Der heutige Tag aus Verlauf und Fahrplan; null = noch nicht geladen (dann keine Tagesleiste). */
  tag: Tag | null;
  zielKw?: number | null;
  verbrauch?: VerbrauchKomposition | null;
  pv?: PvComposition | null;
  /** Die kanonischen Rollen-Werte (`GET …/rollen/…`): ihre Aufschlüsselung je Gerät steht im Blatt des Knotens. */
  rollen?: { pv: RollenKanonischerWert | null; load: RollenKanonischerWert | null; grid: RollenKanonischerWert | null } | null;
  reserveProzent?: number | null;
  planKind?: PlanWordingKind;
  isPhone: boolean;
  now?: Date;
  /** Ein Blatt geht auf (Rolle) oder zu (null) - z. B. um die Tagessummen je Gerät erst dann zu holen. */
  onBlatt?: (art: Rolle | null) => void;
  /** Absprung aus dem Blatt (Energie-Verlauf, Ihre Geräte). */
  onOpenSub?: (sub: AnlagenSub) => void;
  /**
   * Erzeugeranlage an einer Anlagensteuerung (Konzept „Erzeuger am WAGO-Modbus-Server“, EZ-8): der
   * Moment „jetzt“ kommt dann aus dem Bild der Steuerung (`jetzt` ist schon daraus gebildet), der Satz
   * nennt die Vorgabe, der obere Knoten heißt „Erzeugung“ mit Motor oder Sonne, der untere „Hof“ bzw.
   * „Verbrauch“ (= Erzeugung + Netzpunkt). Ohne Netzpunkt (EW-16 C) stehen Netz und Hof als „—“, nie 0.
   */
  erzeuger?: ErzeugerBuehne | null;
}) {
  const [ansicht, setAnsicht] = useState<Ansicht>('jetzt');
  const [gewaehlt, setGewaehlt] = useState<number | null>(null);
  const [blatt, setBlatt] = useState<{ art: Rolle } | null>(null);
  const ausloeser = useRef<HTMLElement | null>(null);
  const jetztQ = tag?.jetzt ?? 0;
  // Die letzte wählbare Viertelstunde: bei „Heute · kWh“ jetzt, sonst das Tagesende (Plan).
  const letzteQ = ansicht === 'heute' ? jetztQ : (tag?.viertel.length ?? 1) - 1;
  const q = Math.min(gewaehlt ?? jetztQ, letzteQ);
  const waehle = (n: number) => setGewaehlt(Math.max(0, Math.min(letzteQ, n)));

  // --- Der Moment -----------------------------------------------------------
  let werte: FlussWerte;
  let herkunft: Herkunft | null;
  let energie: FlussEnergie | null = null;
  let socPct: number | null;
  let zeit: Zeitbezug;
  let skala: number;
  let preisCt: number | null = null;
  const v = tag?.viertel[q];
  const liveMax = Math.max(...[jetzt.werte.pv, jetzt.werte.load, jetzt.werte.batt, jetzt.werte.grid].map((x) => Math.abs(x ?? 0)));
  if (ansicht === 'heute' && tag) {
    const e = energieBis(tag, q);
    energie = e.energie;
    werte = {
      pv: e.energie.pv,
      load: e.energie.load,
      batt: e.energie.laden == null || e.energie.abgeben == null ? null : e.energie.laden - e.energie.abgeben,
      grid: e.energie.bezug == null || e.energie.einspeisung == null ? null : e.energie.bezug - e.energie.einspeisung,
    };
    herkunft = e.herkunft;
    skala = tagesSkala(energieBis(tag, jetztQ));
    socPct = q === jetztQ ? jetzt.socPct : v?.socPct ?? null;
    zeit = 'gemessen';
  } else if (!tag || q === jetztQ) {
    werte = jetzt.werte;
    herkunft = herkunftMoment(werte);
    socPct = jetzt.socPct;
    zeit = 'live';
    skala = Math.max(tag?.maxKw ?? 0, liveMax);
    preisCt = v?.preisCt ?? v?.planPreisCt ?? null;
  } else if (q < jetztQ) {
    werte = v?.gemessen ?? { pv: null, load: null, batt: null, grid: null };
    herkunft = v?.gemessen ? herkunftMoment(v.gemessen) : null;
    socPct = v?.socPct ?? null;
    zeit = 'gemessen';
    skala = Math.max(tag.maxKw, liveMax);
    preisCt = v?.preisCt ?? null;
  } else {
    werte = v?.plan ?? { pv: null, load: null, batt: null, grid: null };
    herkunft = v?.plan ? herkunftMoment(v.plan) : null;
    socPct = v?.planSocPct ?? null;
    zeit = 'plan';
    skala = Math.max(tag.maxKw, liveMax);
    preisCt = v?.planPreisCt ?? null;
  }
  if (!jetzt.hat.batt) werte = { ...werte, batt: werte.batt ?? 0 };
  const heute = ansicht === 'heute';
  const texte = knotenTexte({
    ansicht,
    zeit,
    werte,
    energie,
    socPct,
    zielKw: betrieb === 'spitze' ? zielKw : null,
  });
  if (erzeuger) {
    // Die Knoten tragen die Wörter der Erzeugeranlage; die Werte bleiben die des gewählten Moments.
    const k = erzeuger.knoten;
    const live = zeit === 'live' && !heute;
    const pvZeilen = live ? [k.erzeugungZeile] : texte.pv.zeilen;
    const lastZeilen = heute ? texte.load.zeilen : [k.lastName];
    texte.pv = { ...texte.pv, zeilen: pvZeilen, aria: `Erzeugung: ${texte.pv.wert}, ${pvZeilen.join(', ')}` };
    texte.load = { ...texte.load, zeilen: lastZeilen, aria: `${k.lastName}: ${texte.load.wert}, ${lastZeilen.join(', ')}` };
    if (live && k.netzZeile) texte.grid = { ...texte.grid, zeilen: [k.netzZeile], aria: `Netz: ${texte.grid.wert}, ${k.netzZeile}` };
  }
  const uhr = !tag || (q === jetztQ && !heute) ? uhrText(now) : heute && q === jetztQ ? uhrText(now) : uhrzeit(v?.start ?? now.getTime());
  const satzText = erzeuger && zeit === 'live' && !heute ? erzeuger.satz : satz({
      betrieb,
      ansicht,
      zeit,
      werte,
      herkunft,
      energie,
      uhr,
      zielKw,
      hoechsteKw: tag ? hoechsterBezug(tag, q) : null,
      // Jetzt steht der Preis in der Börsenpreis-Zeile; nur eine andere
      // Viertelstunde nennt ihren Preis im Satz.
      preisCt: q === jetztQ ? null : preisCt,
    }) ?? (zeit === 'plan' ? 'Für diese Viertelstunde liegt kein vollständiger Plan vor.' : 'Für diesen Moment fehlen Messwerte; das Cockpit rechnet keine Aufteilung aus.');
  const rolle = v?.rolle && ROLLEN.has(v.rolle) ? roleLabel(v.rolle as SlotRole, planKind) : null;
  // Die Plan-Tätigkeit steht IN der Marke (keine zweite Plakette, die den Umschalter verdrängt).
  // Jetzt nennt sie die Fahrplan-Zeile; eine gemessene Viertelstunde sagt „Plan:“, denn die
  // Tätigkeit ist eine Aussage des Plans, keine Messung.
  const planWort = rolle && !heute && q !== jetztQ ? rolle : null;
  const marke = heute
    ? 'Energie · gemessen'
    : zeit === 'plan'
      ? planWort ? `Plan · ${planWort}` : 'Plan und Prognose'
      : zeit === 'live'
        ? 'Live'
        : planWort ? `gemessen · Plan: ${planWort}` : 'gemessen';

  // --- Listen „im Detail“ ---------------------------------------------------
  const max = isPhone ? 4 : 6;
  // Unter dem Fluss steht nur der Verbrauch; die Erzeugung je Gerät öffnet
  // sich im Blatt des Sonnen-Knotens (dieselbe Listenform).
  // Bei einer Erzeugeranlage steht hier die Erzeugung je Einheit (Motor, Wechselrichter) - nur jetzt.
  const vListe: Liste | null = erzeuger
    ? (zeit === 'live' && !heute ? erzeuger.liste : null)
    : heute || zeit === 'live'
      ? verbrauchListe(verbrauch, { heute, max, hausKw: heute ? null : werte.load })
      : verbrauch
        ? ohneAufteilung('Verbrauch im Detail', kw(werte.load), zeit === 'plan')
        : null;

  const oeffne = (art: Rolle, el: HTMLElement) => {
    ausloeser.current = el;
    setBlatt({ art });
    onBlatt?.(art);
  };
  const schliesse = () => {
    setBlatt(null);
    onBlatt?.(null);
    const el = ausloeser.current;
    if (el && document.contains(el)) el.focus({ preventScroll: true });
  };

  return (
    <div className={`vp-eb${heute ? ' is-heute' : ''}`}>
      {/* Feste Plätze: Uhrzeit und Umschalter oben, die Marke darunter (am Rechner in einer
          Zeile). Eine lange Marke bricht in ihrer eigenen Zeile um, nie der Umschalter. */}
      <div className="vp-eb-kopf">
        <span className="vp-eb-uhr">{heute ? `bis ${uhr}` : uhr}</span>
        <div className="vp-seg vp-seg-compact vp-eb-modus" role="group" aria-label="Anzeige">
          {(['jetzt', 'heute'] as const).map((a) => (
            <button
              key={a}
              type="button"
              aria-pressed={ansicht === a}
              className={ansicht === a ? 'active' : ''}
              onClick={() => {
                setAnsicht(a);
                // „Heute“ zeigt die Energie je Gerät - erst dann werden die Tagessummen geholt.
                if (a === 'heute') { setGewaehlt(null); onBlatt?.('load'); }
              }}
            >
              {a === 'jetzt' ? 'Jetzt · kW' : 'Heute · kWh'}
            </button>
          ))}
        </div>
        <span className={`vp-eb-marke is-${heute ? 'heute' : zeit}`}>
          {zeit === 'live' && !heute && <i aria-hidden="true" />}
          {marke}
        </span>
      </div>
      <p className="vp-eb-satz" aria-live="polite">{satzText}</p>

      <Leitungsplan
        herkunft={herkunft}
        skala={skala}
        totband={heute ? TOTBAND_KWH : TOTBAND_KW}
        texte={texte}
        hat={jetzt.hat}
        zeit={heute ? 'heute' : zeit}
        socPct={socPct}
        gridKw={werte.grid}
        zielKw={betrieb === 'spitze' ? zielKw : null}
        reserveProzent={reserveProzent}
        stale={stale || (erzeuger?.veraltet ?? false)}
        symbol={erzeuger?.knoten.symbol === 'motor' ? 'motor' : 'sonne'}
        onKnoten={(r, el) => oeffne(r, el)}
      />

      {tag && (
        <div className="vp-eb-zeit">
          <Tagesleiste
            tag={tag}
            betrieb={betrieb}
            q={q}
            heute={heute}
            zielKw={betrieb === 'spitze' ? zielKw : null}
            vorgaben={erzeuger?.vorgaben ?? null}
            onQ={waehle}
          />
          {/* Ein Tipp trifft am Telefon nur auf etwa ± 45 Minuten genau; ‹ › gehen je eine Viertelstunde. */}
          <div className="vp-eb-zeitknoepfe">
            <button
              type="button"
              className="vp-eb-schritt"
              aria-label="Eine Viertelstunde früher"
              disabled={q <= 0}
              onClick={() => waehle(q - 1)}
            >
              <Icon name="chevron-left" size={18} />
            </button>
            <button
              type="button"
              className="vp-eb-schritt"
              aria-label="Eine Viertelstunde später"
              disabled={q >= letzteQ}
              onClick={() => waehle(q + 1)}
            >
              <Icon name="chevron-right" size={18} />
            </button>
            <span className="vp-eb-sp" />
            {q !== jetztQ && (
              <button type="button" className="vp-btn vp-btn--sm vp-eb-jetzt" onClick={() => setGewaehlt(null)}>
                Zurück zu Jetzt
              </button>
            )}
          </div>
        </div>
      )}

      {vListe && (
        <div className="vp-eb-listen">
          <ListeBlock liste={vListe} onOpen={(el) => oeffne(erzeuger ? 'pv' : 'load', el)} />
        </div>
      )}

      <ZahlenAlsListe
        werte={werte}
        heute={heute}
        zeit={zeit}
        uhr={uhr}
        tag={tag}
        jetztUhr={uhrText(now)}
        hatSpeicher={!erzeuger}
        lastName={erzeuger?.knoten.lastName}
      />

      <Blatt
        offen={blatt != null}
        isPhone={isPhone}
        titel={blatt ? (erzeuger && blatt.art === 'load' ? erzeuger.knoten.lastName : BLATT_TITEL[blatt.art]) : ''}
        onClose={schliesse}
      >
        {blatt && (
          <BlattInhalt
            art={blatt.art}
            werte={werte}
            herkunft={herkunft}
            energie={energie}
            socPct={socPct}
            heute={heute}
            zeit={zeit}
            uhr={uhr}
            verbrauch={verbrauch}
            pv={pv}
            rollen={rollen}
            zielKw={zielKw}
            rolle={rolle}
            erzeuger={erzeuger}
            onOpenSub={onOpenSub ? (sub) => { schliesse(); onOpenSub(sub); } : undefined}
          />
        )}
      </Blatt>
    </div>
  );
}

const BLATT_TITEL: Record<Rolle, string> = {
  pv: 'Erzeugung',
  load: 'Verbrauch',
  batt: 'Speicher',
  grid: 'Netz',
};

/**
 * „Zahlen als Liste“ (wie im Prototyp): dieselben Werte als Tabelle - für
 * Vorlesen und für alle, die Zahlen lieber lesen als Spuren. Der gewählte
 * Moment und der Tag bis jetzt stehen nebeneinander; fehlend ist „—“.
 */
function ZahlenAlsListe({
  werte,
  heute,
  zeit,
  uhr,
  tag,
  jetztUhr,
  hatSpeicher = true,
  lastName = 'Verbrauch',
}: {
  werte: FlussWerte;
  heute: boolean;
  zeit: Zeitbezug;
  uhr: string;
  tag: Tag | null;
  jetztUhr: string;
  /** Ohne Speicher keine Speicher-Zeilen (sonst stünde dort eine erfundene 0). */
  hatSpeicher?: boolean;
  /** „Hof“ bei einer Biogasanlage (EZ-8). */
  lastName?: string;
}) {
  const f = heute ? kwh : kw;
  const b = werte.batt;
  const g = werte.grid;
  const pos = (x: number | null) => (x == null ? null : Math.max(0, x));
  const neg = (x: number | null) => (x == null ? null : Math.max(0, -x));
  const e = tag ? energieBis(tag, tag.jetzt).energie : null;
  const zeilen: [string, number | null, number | null][] = [
    ['Erzeugung', werte.pv, e?.pv ?? null],
    [lastName, werte.load, e?.load ?? null],
    ...(hatSpeicher
      ? ([['Speicher laden', pos(b), e?.laden ?? null], ['Speicher abgeben', neg(b), e?.abgeben ?? null]] as [string, number | null, number | null][])
      : []),
    ['Netzbezug', pos(g), e?.bezug ?? null],
    ['Einspeisung', neg(g), e?.einspeisung ?? null],
  ];
  return (
    <details className="vp-eb-zahlen">
      <summary>
        <Icon name="list" size={16} />
        Zahlen als Liste
      </summary>
      <div className="vp-eb-zahlen-wrap">
        <table>
          <caption className="vp-sr-only">Werte für {uhr}</caption>
          <thead>
            <tr>
              <th scope="col" />
              <th scope="col">{heute ? `Heute bis ${uhr}` : `${uhr}${zeit === 'plan' ? ' (Plan)' : ''}`}</th>
              <th scope="col">Heute bis {jetztUhr}</th>
            </tr>
          </thead>
          <tbody>
            {zeilen.map(([name, moment, tagWert]) => (
              <tr key={name}>
                <th scope="row">{name}</th>
                <td>{f(moment)}</td>
                <td>{kwh(tagWert)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function uhrText(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Eine Liste „im Detail“. Unter dem Fluss öffnet jede Zeile das Blatt; im
 * Blatt selbst steht dieselbe Liste vollständig, und eine Zeile führt - wo es
 * eine gibt - auf ihre Geräteseite.
 */
function ListeBlock({ liste, onOpen, className }: { liste: Liste; onOpen?: (el: HTMLElement) => void; className?: string }) {
  const inhalt = (z: Liste['zeilen'][number]) => (
    <>
      <span className="vp-eb-zi" aria-hidden="true">
        <Icon name={z.icon} size={15} />
      </span>
      <span className="vp-eb-zn">
        {z.name}
        {z.sub && <small> {z.sub}</small>}
      </span>
      <span className="vp-eb-zw">{z.wert}</span>
      {z.art !== 'weitere' && (
        <span className="vp-eb-zb" aria-hidden="true">
          <i style={{ width: `${((z.anteil ?? 0) * 100).toFixed(1)}%` }} />
        </span>
      )}
    </>
  );
  return (
    <section className={`vp-eb-liste${className ? ` ${className}` : ''}`} aria-label={liste.titel}>
      <div className="vp-eb-lk">
        <span>{liste.titel}</span>
        <b>{liste.summe}</b>
      </div>
      <ul>
        {liste.zeilen.map((z) => (
          <li key={z.key}>
            {onOpen ? (
              <button type="button" className={`vp-eb-zeile is-${z.art}`} onClick={(e) => onOpen(e.currentTarget)} title={z.title ?? undefined}>
                {inhalt(z)}
              </button>
            ) : z.href ? (
              <a className={`vp-eb-zeile is-${z.art}`} href={z.href} title={z.title ?? undefined}>
                {inhalt(z)}
              </a>
            ) : (
              <div className={`vp-eb-zeile is-${z.art} is-still-zeile`} title={z.title ?? undefined}>
                {inhalt(z)}
              </div>
            )}
          </li>
        ))}
      </ul>
      {liste.fuss?.map((f) => (
        <p key={f} className="vp-eb-note">{f}</p>
      ))}
    </section>
  );
}

function Blatt({
  offen,
  isPhone,
  titel,
  onClose,
  children,
}: {
  offen: boolean;
  isPhone: boolean;
  titel: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (isPhone) {
    return (
      <BottomSheet open={offen} title={titel} onClose={onClose}>
        <div className="vp-eb-blatt">{children}</div>
      </BottomSheet>
    );
  }
  return (
    <Modal open={offen} onClose={onClose} title={titel}>
      <div className="vp-eb-blatt">{children}</div>
    </Modal>
  );
}

function Herkunftsbalken({ teile }: { teile: [string, number, string][] }) {
  const summe = teile.reduce((s, t) => s + t[1], 0);
  if (summe <= 0) return null;
  return (
    <>
      <div className="vp-eb-mix" aria-hidden="true">
        {teile.filter((t) => t[1] > 0).map((t) => (
          <i key={t[0]} className={`vp-eb-mix-${t[2]}`} style={{ flexGrow: t[1] }} />
        ))}
      </div>
      <p className="vp-eb-legende">
        {teile.map((t) => (
          <span key={t[0]}>
            <i className={`vp-eb-mix-${t[2]}`} aria-hidden="true" />
            {t[0]} {prozent((100 * t[1]) / summe)}
          </span>
        ))}
      </p>
    </>
  );
}

function BlattInhalt({
  art,
  werte,
  herkunft,
  energie,
  socPct,
  heute,
  zeit,
  uhr,
  verbrauch,
  pv,
  rollen,
  zielKw,
  rolle,
  erzeuger = null,
  onOpenSub,
}: {
  art: Rolle;
  werte: FlussWerte;
  herkunft: Herkunft | null;
  energie: FlussEnergie | null;
  socPct: number | null;
  heute: boolean;
  zeit: Zeitbezug;
  uhr: string;
  verbrauch: VerbrauchKomposition | null;
  pv: PvComposition | null;
  rollen: { pv: RollenKanonischerWert | null; load: RollenKanonischerWert | null; grid: RollenKanonischerWert | null } | null;
  zielKw: number | null;
  rolle: string | null;
  erzeuger?: ErzeugerBuehne | null;
  onOpenSub?: (sub: AnlagenSub) => void;
}) {
  const f = heute ? kwh : kw;
  const wann = heute ? `bis ${uhr}` : zeit === 'plan' ? `Plan ${uhr}` : zeit === 'live' ? `jetzt ${uhr}` : `gemessen ${uhr}`;
  const kpi = (l: string, w: string) => (
    <div className="vp-eb-kpi"><span>{l}</span><b>{w}</b></div>
  );
  const wege = (filter: (p: string) => boolean) =>
    herkunft ? PAARE.filter(filter).filter((p) => herkunft[p] > (heute ? TOTBAND_KWH : TOTBAND_KW)) : [];
  const wegZeilen = (ps: typeof PAARE[number][]) =>
    ps.length ? (
      <ul className="vp-eb-wege">
        {ps.map((p) => <li key={p}><span>{PAAR_TEXT[p]}</span><b>{f(herkunft![p])}</b></li>)}
      </ul>
    ) : null;
  // Der Weg weiter: der Energie-Verlauf und die Geräte, aus denen die Zahlen stammen.
  const weiter = onOpenSub ? (
    <p className="vp-eb-weiter">
      <button type="button" className="vp-btn vp-btn--sm vp-btn-ghost" onClick={() => onOpenSub('messwerte')}>
        Verlauf ansehen <Icon name="chevron-right" size={14} />
      </button>
      <button type="button" className="vp-btn vp-btn--sm vp-btn-ghost" onClick={() => onOpenSub('modell')}>
        Ihre Geräte <Icon name="chevron-right" size={14} />
      </button>
    </p>
  ) : null;

  if (art === 'pv') {
    return (
      <>
        <div className="vp-eb-kpis">{kpi(`Erzeugung ${wann}`, f(werte.pv))}</div>
        {wegZeilen(wege((p) => p.startsWith('pv>')))}
        {!heute && zeit === 'live' && (() => {
          // Dieselbe Listenform wie unter dem Fluss, hier vollständig.
          const liste = erzeuger ? erzeuger.liste : rollenListe(rollen?.pv) ?? erzeugungListe(pv, { max: Number.MAX_SAFE_INTEGER });
          return liste ? <ListeBlock liste={liste} className="vp-rolle-pv" /> : null;
        })()}
        {zeit === 'plan' && <p className="vp-eb-note">Die Prognose gilt für die ganze Anlage, nicht je Fläche.</p>}
        {zeit === 'gemessen' && !heute && <p className="vp-eb-note">Die Aufteilung je Gerät gibt es nur für jetzt.</p>}
        {weiter}
      </>
    );
  }
  if (art === 'load') {
    const teile: [string, number, string][] = herkunft
      ? [[erzeuger ? 'Erzeugung' : 'Sonne', herkunft['pv>load'], 'pv'], ['Speicher', herkunft['batt>load'], 'batt'], ['Netz', herkunft['grid>load'], 'grid']]
      : [];
    if (erzeuger) {
      // Der Hof ist gerechnet (Erzeugung + Netzpunkt), kein eigener Zähler; ohne Netzpunkt gibt es ihn nicht.
      return (
        <>
          <div className="vp-eb-kpis">{kpi(`${erzeuger.knoten.lastName} ${wann}`, f(werte.load))}</div>
          {teile.length > 0 && <p className="vp-eb-zw-titel">Herkunft {heute ? 'heute' : wann}</p>}
          <Herkunftsbalken teile={teile} />
          <p className="vp-eb-note">
            {werte.load == null
              ? 'Ohne Messung am Netzpunkt lässt sich der Verbrauch hinter dem Netzanschluss nicht ausrechnen.'
              : 'Gerechnet aus Erzeugung und Netzpunkt - kein eigener Zähler.'}
          </p>
          {weiter}
        </>
      );
    }
    return (
      <>
        <div className="vp-eb-kpis">{kpi(`Verbrauch ${wann}`, f(werte.load))}</div>
        {teile.length > 0 && <p className="vp-eb-zw-titel">Herkunft {heute ? 'heute' : wann}</p>}
        <Herkunftsbalken teile={teile} />
        {(zeit === 'live' || heute) && (() => {
          const liste =
            (!heute ? rollenListe(rollen?.load) : null) ??
            verbrauchListe(verbrauch, { heute, max: Number.MAX_SAFE_INTEGER, hausKw: heute ? null : werte.load });
          return liste ? <ListeBlock liste={liste} className="vp-rolle-consumer" /> : null;
        })()}
        {zeit === 'plan' && <p className="vp-eb-note">Für den Plan gibt es keine Aufteilung je Gerät.</p>}
        {zeit === 'gemessen' && !heute && <p className="vp-eb-note">Die Aufteilung je Gerät gibt es nur für jetzt und heute.</p>}
        <p className="vp-eb-note">
          Die Herkunft ist eine bilanzielle Zuordnung: Sonnenstrom zählt zuerst für den Verbrauch, dann für den Speicher, dann für das Netz.
        </p>
        {weiter}
      </>
    );
  }
  if (art === 'batt') {
    const b = werte.batt;
    return (
      <>
        <div className="vp-eb-kpis">
          {kpi(`Ladestand ${heute ? 'jetzt' : wann}`, prozent(socPct))}
          {heute
            ? kpi('Heute geladen · abgegeben', `${kwh(energie?.laden ?? null)} · ${kwh(energie?.abgeben ?? null)}`)
            : kpi('Leistung', b == null ? '—' : b > TOTBAND_KW ? `lädt ${kw(b)}` : b < -TOTBAND_KW ? `entlädt ${kw(b)}` : 'ruht')}
        </div>
        {wegZeilen(wege((p) => p.includes('batt')))}
        {rolle && <p className="vp-eb-note">Plan: {rolle}. Die Tätigkeit ist eine Aussage des Plans, keine Messung.</p>}
        {weiter}
      </>
    );
  }
  const g = werte.grid;
  return (
    <>
      <div className="vp-eb-kpis">
        {heute
          ? <>{kpi('Heute bezogen', kwh(energie?.bezug ?? null))}{kpi('Heute eingespeist', kwh(energie?.einspeisung ?? null))}</>
          : kpi(g != null && g < -TOTBAND_KW ? `Einspeisung ${wann}` : `Bezug ${wann}`, g == null ? '—' : kw(Math.abs(g)))}
        {zielKw != null && kpi('Ziel Netzbezug', kw(zielKw))}
      </div>
      {wegZeilen(wege((p) => p.includes('grid')))}
      {!heute && zeit === 'live' && (() => {
        const liste = rollenListe(rollen?.grid);
        return liste ? <ListeBlock liste={liste} className="vp-rolle-grid" /> : null;
      })()}
      <p className="vp-eb-note">
        {erzeuger && g == null
          ? 'An dieser Anlage wird am Netzpunkt nicht gemessen; Einspeisung und Bezug sind deshalb unbekannt.'
          : 'Eingespeist ist, was den Netzanschluss verlässt, nicht was den Speicher verlässt.'}
      </p>
      {weiter}
    </>
  );
}

