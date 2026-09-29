import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { Modal } from '../../designsystem/components/shell/Modal';
import { KNOWN_ROLES, roleLabel, type SlotRole } from '../fahrplanWhy';
import type { PlanWordingKind } from '../schedule';
import type { JetztFluss } from '../flussJetzt';
import { erzeugungListe, ohneAufteilung, verbrauchListe, type Liste, type ListenZeile } from '../flussListen';
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
import { PvCompositionDetails } from './PvBreakdown';
import { Tagesleiste } from './Tagesleiste';
import { VerbrauchDetails } from './VerbrauchDetails';
import './EnergieBuehne.css';

const ROLLEN = new Set<string>(KNOWN_ROLES);

/**
 * **Die Bühne des Cockpits** (Konzept `docs/konzepte/cockpit-tagesfilm`):
 * Uhrzeit, Umschalter „Jetzt · kW / Heute · kWh“, ein Satz zum Moment, der
 * Energiefluss als Leitungsplan, „Verbrauch/Erzeugung im Detail“ und die
 * Tagesleiste. Jeder Knoten und jede Zeile öffnet am Telefon ein Blatt, am
 * Rechner das zentrierte `Modal`.
 *
 * Messung, Plan und Jetzt bleiben getrennt: die Marke oben sagt, was gerade
 * zu sehen ist („Live“, „gemessen“, „Plan und Prognose“, „Energie · gemessen“),
 * und nur „Live“ bewegt sich.
 */
export function EnergieBuehne({
  jetzt,
  stale = false,
  betrieb,
  tag,
  zielKw = null,
  bestaetigt = false,
  verbrauch = null,
  pv = null,
  reserveProzent = null,
  planKind = 'eigenverbrauch',
  isPhone,
  now = new Date(),
}: {
  jetzt: JetztFluss;
  stale?: boolean;
  betrieb: Betrieb;
  /** Der heutige Tag aus Verlauf und Fahrplan; null = noch nicht geladen (dann keine Tagesleiste). */
  tag: Tag | null;
  zielKw?: number | null;
  bestaetigt?: boolean;
  verbrauch?: VerbrauchKomposition | null;
  pv?: PvComposition | null;
  reserveProzent?: number | null;
  planKind?: PlanWordingKind;
  isPhone: boolean;
  now?: Date;
}) {
  const [ansicht, setAnsicht] = useState<Ansicht>('jetzt');
  const [gewaehlt, setGewaehlt] = useState<number | null>(null);
  const [spielt, setSpielt] = useState(false);
  const [blatt, setBlatt] = useState<{ art: Rolle | 'verbrauch' | 'erzeugung' } | null>(null);
  const ausloeser = useRef<HTMLElement | null>(null);
  const jetztQ = tag?.jetzt ?? 0;
  const q = Math.min(gewaehlt ?? jetztQ, ansicht === 'heute' ? jetztQ : (tag?.viertel.length ?? 1) - 1);

  // „Tag abspielen“: eine Viertelstunde je Schritt, bis zum Ende (bzw. bis jetzt).
  useEffect(() => {
    if (!spielt || !tag) return undefined;
    const ende = ansicht === 'heute' ? tag.jetzt : tag.viertel.length - 1;
    const reduziert = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const t = window.setInterval(() => {
      setGewaehlt((g) => {
        const n = (g ?? 0) + 1;
        if (n >= ende) { setSpielt(false); return ende; }
        return n;
      });
    }, reduziert ? 220 : 110);
    return () => window.clearInterval(t);
  }, [spielt, tag, ansicht]);

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
    preisCt: betrieb === 'markt' ? preisCt : null,
    bestaetigt,
  });
  const uhr = !tag || (q === jetztQ && !heute) ? uhrText(now) : heute && q === jetztQ ? uhrText(now) : uhrzeit(v?.start ?? now.getTime());
  const satzText =
    satz({
      betrieb,
      ansicht,
      zeit,
      werte,
      herkunft,
      energie,
      uhr,
      zielKw,
      hoechsteKw: tag ? hoechsterBezug(tag, q) : null,
      preisCt,
    }) ?? (zeit === 'plan' ? 'Für diese Viertelstunde liegt kein vollständiger Plan vor.' : 'Für diesen Moment fehlen Messwerte; das Cockpit rechnet keine Aufteilung aus.');
  const rolle = v?.rolle && ROLLEN.has(v.rolle) ? roleLabel(v.rolle as SlotRole, planKind) : null;
  const marke = heute ? 'Energie · gemessen' : zeit === 'plan' ? 'Plan und Prognose' : zeit === 'live' ? 'Live' : 'gemessen';

  // --- Listen ---------------------------------------------------------------
  const max = isPhone ? 4 : 6;
  let vListe: Liste | null;
  let pListe: Liste | null;
  if (heute || zeit === 'live') {
    vListe = verbrauchListe(verbrauch, { heute, max, hausKw: heute ? null : werte.load });
    pListe = heute ? null : erzeugungListe(pv, { max });
  } else {
    vListe = verbrauch ? ohneAufteilung('Verbrauch im Detail', kw(werte.load), zeit === 'plan') : null;
    pListe = pv && pv.parts.length > 1 ? ohneAufteilung('Erzeugung im Detail', kw(werte.pv), zeit === 'plan') : null;
  }

  const oeffne = (art: Rolle | 'verbrauch' | 'erzeugung', el: HTMLElement) => {
    ausloeser.current = el;
    setBlatt({ art });
  };
  const schliesse = () => {
    setBlatt(null);
    const el = ausloeser.current;
    if (el && document.contains(el)) el.focus({ preventScroll: true });
  };

  return (
    <div className={`vp-eb${heute ? ' is-heute' : ''}`}>
      <div className="vp-eb-kopf">
        <span className="vp-eb-uhr">{heute ? `bis ${uhr}` : uhr}</span>
        <span className={`vp-eb-marke is-${heute ? 'heute' : zeit}`}>
          {zeit === 'live' && !heute && <i aria-hidden="true" />}
          {marke}
        </span>
        {rolle && !heute && <span className="vp-eb-plan">Plan: {rolle}</span>}
        <span className="vp-eb-sp" />
        <div className="vp-seg vp-seg-compact vp-eb-modus" role="group" aria-label="Anzeige">
          {(['jetzt', 'heute'] as const).map((a) => (
            <button
              key={a}
              type="button"
              aria-pressed={ansicht === a}
              className={ansicht === a ? 'active' : ''}
              onClick={() => { setSpielt(false); setAnsicht(a); if (a === 'heute') setGewaehlt(null); }}
            >
              {a === 'jetzt' ? 'Jetzt · kW' : 'Heute · kWh'}
            </button>
          ))}
        </div>
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
        stale={stale}
        onKnoten={(r, el) => oeffne(r, el)}
      />

      {(vListe || pListe) && (
        <div className="vp-eb-listen">
          {vListe && <ListeBlock liste={vListe} onOpen={(el) => oeffne('verbrauch', el)} />}
          {pListe && <ListeBlock liste={pListe} onOpen={(el) => oeffne('erzeugung', el)} />}
        </div>
      )}

      {tag && (
        <div className="vp-eb-zeit">
          <Tagesleiste
            tag={tag}
            betrieb={betrieb}
            q={q}
            heute={heute}
            zielKw={betrieb === 'spitze' ? zielKw : null}
            onQ={(n) => { setSpielt(false); setGewaehlt(n); }}
          />
          <div className="vp-eb-zeitknoepfe">
            <button
              type="button"
              className="vp-btn vp-btn--sm vp-eb-spiel"
              onClick={() => {
                if (spielt) { setSpielt(false); return; }
                if (q >= (heute ? jetztQ : tag.viertel.length - 1) || q === jetztQ) setGewaehlt(0);
                setSpielt(true);
              }}
            >
              <Icon name={spielt ? 'x' : 'history'} size={16} />
              {spielt ? 'Anhalten' : 'Tag abspielen'}
            </button>
            <span className="vp-eb-sp" />
            {q !== jetztQ && (
              <button type="button" className="vp-btn vp-btn--sm vp-eb-jetzt" onClick={() => { setSpielt(false); setGewaehlt(null); }}>
                Zurück zu Jetzt
              </button>
            )}
          </div>
          <p className="vp-eb-hinweis">Ziehen Sie über die Tagesleiste. Links von „Jetzt“ sehen Sie Messwerte, rechts den Plan.</p>
        </div>
      )}

      <Blatt
        offen={blatt != null}
        isPhone={isPhone}
        titel={blatt ? BLATT_TITEL[blatt.art] : ''}
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
            zielKw={zielKw}
            rolle={rolle}
            now={now}
          />
        )}
      </Blatt>
    </div>
  );
}

const BLATT_TITEL: Record<Rolle | 'verbrauch' | 'erzeugung', string> = {
  pv: 'Erzeugung',
  erzeugung: 'Erzeugung',
  load: 'Verbrauch',
  verbrauch: 'Verbrauch',
  batt: 'Speicher',
  grid: 'Netz',
};

function uhrText(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function ListeBlock({ liste, onOpen }: { liste: Liste; onOpen: (el: HTMLElement) => void }) {
  return (
    <section className="vp-eb-liste" aria-label={liste.titel}>
      <div className="vp-eb-lk">
        <span>{liste.titel}</span>
        <b>{liste.summe}</b>
      </div>
      <ul>
        {liste.zeilen.map((z) => (
          <li key={z.key}>
            <button type="button" className={`vp-eb-zeile is-${z.art}`} onClick={(e) => onOpen(e.currentTarget)} title={z.title ?? undefined}>
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
            </button>
          </li>
        ))}
      </ul>
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
  zielKw,
  rolle,
  now,
}: {
  art: Rolle | 'verbrauch' | 'erzeugung';
  werte: FlussWerte;
  herkunft: Herkunft | null;
  energie: FlussEnergie | null;
  socPct: number | null;
  heute: boolean;
  zeit: Zeitbezug;
  uhr: string;
  verbrauch: VerbrauchKomposition | null;
  pv: PvComposition | null;
  zielKw: number | null;
  rolle: string | null;
  now: Date;
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

  if (art === 'pv' || art === 'erzeugung') {
    return (
      <>
        <div className="vp-eb-kpis">{kpi(`Erzeugung ${wann}`, f(werte.pv))}</div>
        {wegZeilen(wege((p) => p.startsWith('pv>')))}
        {!heute && zeit === 'live' && pv && pv.parts.length + pv.unmeasured.length > 1 && <PvCompositionDetails composition={pv} now={now} />}
        {zeit === 'plan' && <p className="vp-eb-note">Die Prognose gilt für die ganze Anlage, nicht je Fläche.</p>}
      </>
    );
  }
  if (art === 'load' || art === 'verbrauch') {
    const teile: [string, number, string][] = herkunft
      ? [['Sonne', herkunft['pv>load'], 'pv'], ['Speicher', herkunft['batt>load'], 'batt'], ['Netz', herkunft['grid>load'], 'grid']]
      : [];
    return (
      <>
        <div className="vp-eb-kpis">{kpi(`Verbrauch ${wann}`, f(werte.load))}</div>
        {teile.length > 0 && <p className="vp-eb-zw-titel">Herkunft {heute ? 'heute' : wann}</p>}
        <Herkunftsbalken teile={teile} />
        {(zeit === 'live' || heute) && verbrauch && <VerbrauchDetails komposition={verbrauch} now={now} />}
        {zeit === 'plan' && <p className="vp-eb-note">Für den Plan gibt es keine Aufteilung je Gerät.</p>}
        <p className="vp-eb-note">
          Die Herkunft ist eine bilanzielle Zuordnung: Sonnenstrom zählt zuerst für den Verbrauch, dann für den Speicher, dann für das Netz.
        </p>
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
      <p className="vp-eb-note">Eingespeist ist, was den Netzanschluss verlässt, nicht was den Speicher verlässt.</p>
    </>
  );
}

export type { ListenZeile };
