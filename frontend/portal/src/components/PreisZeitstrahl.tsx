import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { chartTheme, type ChartTheme } from '../chartTheme';
import { withAlpha } from '../chartStyle';
import { haptik } from '../haptik';
import { useContainerWidth } from '../useContainerWidth';
import {
  abstand,
  bisUhrzeit,
  blockZeit,
  ct1,
  hatFolgetag,
  langerTag,
  laufEnde,
  naechsteMitternacht,
  stufe,
  stufeBei,
  STUFE_WORT,
  tagesBeginn,
  uhrzeit,
  VIERTEL_MS,
  VORLAUF_VIERTEL,
  wochentagDatum,
  type PlanTun,
  type PreisBlock,
  type PreisStufe,
  type Zeitstrahl,
} from '../preisZeitstrahl';
import './PreisZeitstrahl.css';

/**
 * Die Bausteine der Preis-Seite (Konzept „Preise und Wetter", Fassung 3,
 * Entscheide vom 20.10.2026). Sie RECHNEN nichts — jede Zahl und jedes Wort
 * kommt aus `preisZeitstrahl.ts`.
 *
 * Bedienung wie im Cockpit entschieden (Konzept b1, 20.10.2026): der Finger
 * TIPPT, nur die Maus darf ziehen; ‹ › gehen je 15 Minuten; kein Hinweissatz.
 */

/** Welches der zwei Fenster gerade markiert ist. */
export type FensterWahl = 'guenstigste' | 'teuerste';

function stufenFarbe(t: ChartTheme, s: PreisStufe | 'vorbei'): string {
  switch (s) {
    case 'negativ':
      return t.preisNegativ;
    case 'guenstig':
      return t.preisGuenstig;
    case 'teuer':
      return t.preisTeuer;
    case 'vorbei':
      return t.preisVorbei;
    default:
      return t.preisMittel;
  }
}

/* ===========================================================================
 * Die Antwort oben
 * ========================================================================= */

/** Das Stufenwort als neutraler Chip mit farbigem Punkt — Farbe nie allein. */
export function StufenChip({ stufe: s }: { stufe: PreisStufe | 'vorbei' }) {
  const t = chartTheme();
  return (
    <span className="vp-chip vp-pz-stufe" data-stufe={s}>
      <i aria-hidden="true" style={{ background: stufenFarbe(t, s) }} />
      {s === 'vorbei' ? 'vorbei' : STUFE_WORT[s]}
    </span>
  );
}

/** Eine Zeile: wo der gezeigte Preis zwischen Tief und Hoch der kommenden Stunden liegt. */
export function Preisleiter({ z, wert }: { z: Zeitstrahl; wert: number }) {
  if (z.flach || z.tief == null || z.hoch == null || z.grenzeGuenstig == null || z.grenzeTeuer == null) {
    return null;
  }
  const t = chartTheme();
  const spanne = z.hoch - z.tief || 1;
  const teile: { von: number; bis: number; s: PreisStufe }[] = [];
  let unten = z.tief;
  if (z.tief < 0 && z.grenzeGuenstig > 0) {
    teile.push({ von: unten, bis: 0, s: 'negativ' });
    unten = 0;
  }
  teile.push({ von: unten, bis: z.grenzeGuenstig, s: 'guenstig' });
  teile.push({ von: z.grenzeGuenstig, bis: z.grenzeTeuer, s: 'mittel' });
  teile.push({ von: z.grenzeTeuer, bis: z.hoch, s: 'teuer' });
  const pos = Math.max(0, Math.min(100, ((wert - z.tief) / spanne) * 100));
  return (
    <div
      className="vp-pz-leiter"
      role="img"
      aria-label={`Einordnung: ${ct1(wert)} ct/kWh zwischen ${ct1(z.tief)} und ${ct1(z.hoch)} ct/kWh in den kommenden Stunden`}
    >
      <span>{ct1(z.tief)}</span>
      <span className="vp-pz-leiter-bahn">
        {teile.map((teil) => (
          <span
            key={teil.s}
            style={{
              flexGrow: Math.max(0.02, (teil.bis - teil.von) / spanne),
              background: withAlpha(stufenFarbe(t, teil.s), 0.42),
            }}
          />
        ))}
        <i className="vp-pz-leiter-punkt" style={{ left: `${pos}%` }} />
      </span>
      <span>{ct1(z.hoch)}&nbsp;ct</span>
    </div>
  );
}

function InfoKnopf({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="vp-pz-info" aria-label="Was ist der Börsenpreis?" onClick={onClick}>
      <Icon name="info" size={18} />
    </button>
  );
}

function Schritte({ onSchritt, onJetzt }: { onSchritt: (d: -1 | 1) => void; onJetzt: () => void }) {
  return (
    <span className="vp-pz-schritte">
      <button type="button" className="vp-pz-schritt" aria-label="15 Minuten früher" onClick={() => onSchritt(-1)}>
        <Icon name="chevron-left" size={18} />
      </button>
      <button type="button" className="vp-pz-schritt" aria-label="15 Minuten später" onClick={() => onSchritt(1)}>
        <Icon name="chevron-right" size={18} />
      </button>
      <button type="button" className="vp-pz-jetzt-knopf" onClick={onJetzt}>
        <Icon name="refresh-cw" size={15} />
        Jetzt
      </button>
    </span>
  );
}

/**
 * Die Antwort oben (Regel 1 der Fassung 3): eine Zahl, ein Wort, wie lange.
 * Mit gewählter Viertelstunde oder markiertem Fenster zeigt sie DAS — und den
 * Weg zurück zu jetzt.
 */
export function PreisAntwort({
  z,
  auswahl,
  fenster,
  onInfo,
  onSchritt,
  onJetzt,
}: {
  z: Zeitstrahl;
  auswahl: number | null;
  fenster: FensterWahl | null;
  onInfo: () => void;
  onSchritt: (d: -1 | 1) => void;
  onJetzt: () => void;
}) {
  const block = fenster ? z[fenster] : null;
  if (block) {
    const s: PreisStufe = fenster === 'guenstigste' ? stufe(z, block.ct) : 'teuer';
    const bz = blockZeit(z, block);
    const beginn = z.viertel[block.von].start;
    return (
      <>
        <div className="vp-pz-label">
          <span>{fenster === 'guenstigste' ? 'Am günstigsten' : 'Am teuersten'} · 2 Std</span>
          <span className="vp-pz-label-rechts">{block.von === z.jetzt ? 'läuft' : abstand(beginn, z.jetztMs)}</span>
          <InfoKnopf onClick={onInfo} />
        </div>
        <div className="vp-pz-zahl">
          <span className="vp-pz-zahl-wert">
            <small>Ø</small>
            <b>{ct1(block.ct)}</b>
            <small>ct/kWh</small>
          </span>
          <StufenChip stufe={s} />
        </div>
        <div className="vp-pz-noch">
          <span>
            {bz.tag} <b>{bz.zeit}</b>
          </span>
          <button type="button" className="vp-pz-jetzt-knopf" onClick={onJetzt}>
            <Icon name="refresh-cw" size={15} />
            Jetzt
          </button>
        </div>
        <Preisleiter z={z} wert={block.ct} />
      </>
    );
  }

  const i = auswahl ?? z.jetzt;
  const v = i >= 0 ? z.viertel[i] : null;
  if (!v || v.ct == null) {
    // Regel 1: ohne laufende Viertelstunde gibt es kein „jetzt".
    return (
      <>
        <div className="vp-pz-label">
          <span>Börsenpreis · jetzt</span>
          <InfoKnopf onClick={onInfo} />
        </div>
        <p className="vp-pz-ohne">Für jetzt liegt noch kein Börsenpreis vor.</p>
      </>
    );
  }
  const s = stufeBei(z, i) ?? 'mittel';
  const gewaehlt = auswahl != null && auswahl !== z.jetzt;
  const ende = laufEnde(z, i);
  return (
    <>
      <div className="vp-pz-label">
        {gewaehlt ? (
          <>
            <span>
              {wochentagDatum(v.start)} {uhrzeit(v.start)}–{bisUhrzeit(v.start + VIERTEL_MS)}
            </span>
            <span className="vp-pz-label-rechts">{abstand(v.start, z.jetztMs)}</span>
          </>
        ) : (
          <span>Börsenpreis · jetzt {uhrzeit(v.start)}</span>
        )}
        <InfoKnopf onClick={onInfo} />
      </div>
      <div className="vp-pz-zahl">
        <span className="vp-pz-zahl-wert">
          <b>{ct1(v.ct)}</b>
          <small>ct/kWh</small>
        </span>
        {!z.flach && <StufenChip stufe={s} />}
      </div>
      <div className="vp-pz-noch">
        {auswahl != null ? (
          <Schritte onSchritt={onSchritt} onJetzt={onJetzt} />
        ) : z.flach ? (
          // Ehrlich statt „kaum": die Spanne als Zahl, bis wohin sie gilt.
          <span>
            {z.tief != null && z.hoch != null ? (
              <>
                bis {bisUhrzeit(z.viertel[z.viertel.length - 1].start + VIERTEL_MS)} höchstens{' '}
                <b>{ct1(z.hoch - z.tief)}&nbsp;ct</b> Unterschied
              </>
            ) : (
              'noch zu wenige Preise für einen Vergleich'
            )}
          </span>
        ) : ende < z.viertel.length ? (
          <span>
            noch bis <b>{bisUhrzeit(z.viertel[ende].start)}</b>
          </span>
        ) : null}
      </div>
      <Preisleiter z={z} wert={v.ct} />
    </>
  );
}

/** Eine der zwei Kacheln „Am günstigsten" / „Am teuersten" — nur nach vorn. */
export function PreisKachel({
  z,
  art,
  block,
  aktiv,
  onWahl,
}: {
  z: Zeitstrahl;
  art: FensterWahl;
  block: PreisBlock;
  aktiv: boolean;
  onWahl: () => void;
}) {
  const bz = blockZeit(z, block);
  const beginn = z.viertel[block.von].start;
  const guenstig = art === 'guenstigste';
  return (
    <button
      type="button"
      className="vp-pz-kachel"
      data-art={art}
      aria-pressed={aktiv}
      onClick={onWahl}
    >
      <span className="vp-pz-kachel-kopf">
        <span className="vp-pz-kachel-ico" aria-hidden="true">
          <Icon name={guenstig ? 'arrow-down' : 'arrow-up'} size={15} />
        </span>
        {guenstig ? 'Am günstigsten' : 'Am teuersten'}
      </span>
      <span className="vp-pz-kachel-zeit">
        {bz.tag} <span className="vp-pz-nw">{bz.zeit}</span>
      </span>
      <span className="vp-pz-kachel-sub">
        Ø {ct1(block.ct)}&nbsp;ct · {block.von === z.jetzt ? '2 Std' : abstand(beginn, z.jetztMs)}
      </span>
    </button>
  );
}

/* ===========================================================================
 * Das Bild
 * ========================================================================= */

interface Geometrie {
  i0: number;
  /** Letzter WÄHLBARER Index (einschließlich) — der Platzhalter ist nicht wählbar. */
  iMax: number;
  padL: number;
  schritt: number;
}

const TOUCH_TOLERANZ_PX = 10;

/**
 * Das Bild: Balken je Viertelstunde in drei Stufen, die Jetzt-Linie mit Marke,
 * darüber das Tagesband, darunter (mit Speicher) der Plan-Streifen.
 *
 * Am Telefon beginnt es 2 Stunden vor jetzt (E1 = A) und reicht bis zum
 * letzten bekannten Preis; `breit` (ab 721 px) zeigt heute ab 0 Uhr und morgen.
 * Ist der Folgetag noch nicht veröffentlicht, steht das IM Bild.
 */
export function PreisZeitstrahlBild({
  z,
  plan,
  auswahl,
  fenster,
  breit,
  onWahl,
  onJetzt,
}: {
  z: Zeitstrahl;
  plan: readonly (PlanTun | null)[] | null;
  auswahl: number | null;
  fenster: FensterWahl | null;
  breit: boolean;
  onWahl: (i: number) => void;
  onJetzt: () => void;
}) {
  const [ref, breite] = useContainerWidth<HTMLDivElement>();
  const geo = useRef<Geometrie | null>(null);
  const finger = useRef<{ x: number; y: number } | null>(null);
  const ziehen = useRef(false);

  const n = z.viertel.length;
  const start0 = z.viertel[0].start;
  const tagStart = tagesBeginn(z.jetztMs);
  const jetztIndex = z.jetzt >= 0 ? z.jetzt : z.ab;
  let i0 = breit
    ? Math.max(0, Math.round((tagStart - start0) / VIERTEL_MS))
    : Math.max(0, jetztIndex - VORLAUF_VIERTEL);
  i0 = Math.min(i0, n - 1);
  const folgetag = hatFolgetag(z);
  const letztesEnde = z.viertel[n - 1].start + VIERTEL_MS;
  const platzhalter = folgetag
    ? 0
    : breit
      ? Math.max(0, Math.round((naechsteMitternacht(z.jetztMs) + 24 * 3600_000 - letztesEnde) / VIERTEL_MS))
      : 32;
  const i1 = n + platzhalter;

  const W = Math.max(240, Math.round(breite || 0));
  const RIB = 22;
  const PILLE = 26;
  const padL = breit ? 40 : 30;
  const padR = 4;
  const plotH = breit ? 200 : 150;
  const planH = plan ? 16 : 0;
  const oben = RIB + PILLE;
  const basis = oben + plotH;
  const H = basis + planH + 22;
  const schritt = (W - padL - padR) / (i1 - i0);
  const X = (i: number) => padL + (i - i0) * schritt;
  const XMs = (ms: number) => X(i0 + (ms - z.viertel[i0].start) / VIERTEL_MS);

  geo.current = { i0, iMax: n - 1, padL, schritt };

  const t = chartTheme();
  const sichtbar = z.viertel.slice(i0, n).map((v) => v.ct).filter((c): c is number => c != null);
  const lo = Math.min(0, ...sichtbar);
  const hi = Math.max(1, ...sichtbar);
  const tick = hi - lo > 22 ? 10 : 5;
  const ymin = lo < 0 ? -Math.ceil(-lo / tick) * tick : 0;
  const ymax = Math.max(tick, Math.ceil(hi / tick) * tick);
  const Y = (v: number) => oben + ((ymax - v) / (ymax - ymin)) * plotH;

  const markiert = fenster ? z[fenster] : null;

  // --- Tagesband ---------------------------------------------------------
  const baender: { a: number; b: number; text: string; bekannt: boolean; ungerade: boolean }[] = [];
  const bildAnfang = z.viertel[i0].start;
  const bildEnde = bildAnfang + (i1 - i0) * VIERTEL_MS;
  for (let tag = tagesBeginn(bildAnfang), k = 0; tag < bildEnde; tag = naechsteMitternacht(tag), k++) {
    const a = XMs(Math.max(tag, bildAnfang));
    const b = XMs(Math.min(naechsteMitternacht(tag), bildEnde));
    const bekannt = tag < letztesEnde;
    const istHeute = tag === tagStart;
    const kurz = istHeute ? 'Heute' : wochentagDatum(tag);
    const lang = istHeute ? `Heute, ${wochentagDatum(tag)}` : langerTag(tag);
    const text = !bekannt ? 'Morgen' : b - a > 150 ? lang : kurz;
    baender.push({ a, b, text, bekannt, ungerade: k % 2 === 1 });
  }

  // --- Achse: volle Stunden, am Telefon alle 6, breit alle 3 -------------
  const stundenSchritt = breit ? 3 : 6;
  const achse: { x: number; text: string }[] = [];
  for (let ms = Math.ceil(bildAnfang / 3600_000) * 3600_000; ms <= bildEnde; ms += 3600_000) {
    const h = new Date(ms).getHours();
    if (h % stundenSchritt !== 0) continue;
    const ende = ms === bildEnde && h === 0;
    achse.push({ x: XMs(ms), text: ende ? '24' : String(h) });
  }
  if (achse.length > 0) achse[0] = { ...achse[0], text: `${achse[0].text} Uhr` };

  // --- Bedienung -----------------------------------------------------------
  const indexAus = (clientX: number): number | null => {
    const g = geo.current;
    const el = ref.current;
    if (!g || !el) return null;
    const x = clientX - el.getBoundingClientRect().left;
    const i = g.i0 + Math.floor((x - g.padL) / g.schritt);
    return Math.max(g.i0, Math.min(g.iMax, i));
  };
  const waehle = (i: number | null, fuehlbar: boolean) => {
    if (i == null || i === auswahl) return;
    if (fuehlbar) haptik(i === z.jetzt ? 'jetzt' : 'tick');
    onWahl(i);
  };
  const unten = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') {
      finger.current = { x: e.clientX, y: e.clientY };
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    ziehen.current = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ältere Browser: ohne Einfangen geht das Ziehen nur über dem Bild
    }
    waehle(indexAus(e.clientX), false);
  };
  const bewegt = (e: PointerEvent<HTMLDivElement>) => {
    if (ziehen.current) waehle(indexAus(e.clientX), false);
  };
  const losgelassen = (e: PointerEvent<HTMLDivElement>) => {
    const f = finger.current;
    finger.current = null;
    ziehen.current = false;
    if (
      e.pointerType === 'touch' &&
      f &&
      Math.abs(e.clientX - f.x) < TOUCH_TOLERANZ_PX &&
      Math.abs(e.clientY - f.y) < TOUCH_TOLERANZ_PX
    ) {
      waehle(indexAus(e.clientX), true);
    }
  };
  const taste = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      if (auswahl != null || fenster) {
        e.preventDefault();
        onJetzt();
      }
      return;
    }
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const von = auswahl ?? jetztIndex;
    waehle(Math.max(i0, Math.min(n - 1, von + d)), false);
  };

  const xJetzt = z.jetzt >= 0 ? XMs(z.jetztMs) : null;
  const pilleText = breit ? `Jetzt ${uhrzeit(z.jetztMs)}` : 'Jetzt';
  const pilleW = breit ? 84 : 48;
  const anfangText = `${wochentagDatum(bildAnfang)} ${uhrzeit(bildAnfang)}`;
  const endeText = `${wochentagDatum(letztesEnde - 1)} ${bisUhrzeit(letztesEnde)}`;

  return (
    <div
      ref={ref}
      className="vp-pz-bild"
      tabIndex={0}
      role="group"
      aria-label={`Börsenpreis je Viertelstunde von ${anfangText} bis ${endeText}. Antippen oder Pfeiltasten wählen eine Viertelstunde.`}
      onPointerDown={unten}
      onPointerMove={bewegt}
      onPointerUp={losgelassen}
      onPointerCancel={() => {
        finger.current = null;
        ziehen.current = false;
      }}
      onKeyDown={taste}
    >
      {breite > 0 && (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
          <defs>
            <pattern id="vp-pz-platzhalter" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="var(--vp-c-bg, #f8fafc)" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--vp-c-border, #e2e8f0)" strokeWidth="2" />
            </pattern>
            <pattern id="vp-pz-abgeben" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="4" height="4" fill="#fff" />
              <line x1="0" y1="0" x2="0" y2="4" stroke={t.plan} strokeWidth="1.6" />
            </pattern>
          </defs>

          {/* Tagesband */}
          {baender.map((b) => (
            <g key={b.a}>
              <rect
                x={b.a + 1}
                y={0}
                width={Math.max(0, b.b - b.a - 2)}
                height={18}
                rx={6}
                className={b.ungerade ? 'vp-pz-band is-zweit' : 'vp-pz-band'}
              />
              {b.b - b.a > 40 && (
                <text x={b.a + 8} y={12.8} className={b.bekannt ? 'vp-pz-band-text' : 'vp-pz-band-text is-offen'}>
                  {b.text}
                </text>
              )}
            </g>
          ))}

          {/* Raster */}
          {Array.from({ length: Math.round((ymax - ymin) / tick) + 1 }, (_, k) => ymin + k * tick).map((v) => (
            <g key={v}>
              <line
                x1={padL}
                x2={W - padR}
                y1={Y(v)}
                y2={Y(v)}
                stroke={v === 0 && ymin < 0 ? t.axis : t.grid}
                strokeWidth={1}
              />
              <text x={padL - 6} y={Y(v) + 3.5} className="vp-pz-achse" textAnchor="end">
                {v === ymax ? `${v} ct` : String(v).replace('-', '−')}
              </text>
            </g>
          ))}

          {/* Markiertes Fenster */}
          {markiert && (
            <rect
              x={X(markiert.von)}
              y={oben}
              width={X(markiert.bis) - X(markiert.von)}
              height={plotH}
              fill={withAlpha(fenster === 'teuerste' ? t.preisTeuer : t.preisGuenstig, 0.1)}
            />
          )}

          {/* Tageswechsel */}
          {baender.slice(1).map((b) => (
            <line key={`w${b.a}`} x1={b.a} x2={b.a} y1={RIB} y2={basis + planH} stroke={t.axis} strokeDasharray="3 3" />
          ))}

          {/* Folgetag noch nicht veröffentlicht */}
          {platzhalter > 0 && (
            <g>
              <rect x={X(n) + 2} y={oben} width={Math.max(0, X(i1) - X(n) - 2)} height={plotH} rx={6} fill="url(#vp-pz-platzhalter)" />
              {(X(i1) - X(n) > 150 ? ['Preise für morgen'] : ['Preise für', 'morgen']).map((zeile, k, alle) => (
                <text
                  key={zeile}
                  x={(X(n) + X(i1)) / 2}
                  y={oben + plotH / 2 - 8 * alle.length + 14 * k + 4}
                  className="vp-pz-platz-text"
                  textAnchor="middle"
                >
                  {zeile}
                </text>
              ))}
              <text
                x={(X(n) + X(i1)) / 2}
                y={oben + plotH / 2 + (X(i1) - X(n) > 150 ? 12 : 20)}
                className="vp-pz-platz-text is-leise"
                textAnchor="middle"
              >
                {new Date(z.jetztMs).getHours() < 13 ? 'ab ca. 13 Uhr' : 'folgen in Kürze'}
              </text>
            </g>
          )}

          {/* Balken */}
          {z.viertel.slice(i0, n).map((v, k) => {
            const i = i0 + k;
            if (v.ct == null) return null;
            const s = stufeBei(z, i) ?? 'mittel';
            const luecke = i % 4 === 3 ? (schritt >= 4 ? 1.6 : schritt >= 2.4 ? 0.9 : 0.5) : schritt >= 4.5 ? 0.6 : 0;
            const y0 = Y(Math.max(v.ct, 0));
            const y1 = Y(Math.min(v.ct, 0));
            const ausserhalb = markiert && i >= z.ab && (i < markiert.von || i >= markiert.bis);
            const farbe = z.flach && s !== 'vorbei' && s !== 'negativ' ? t.preisMittel : stufenFarbe(t, s);
            return (
              <rect
                key={v.start}
                x={X(i)}
                y={y0}
                width={Math.max(0.6, schritt - luecke)}
                height={Math.max(0.8, y1 - y0)}
                fill={farbe}
                opacity={ausserhalb ? 0.32 : 1}
              />
            );
          })}

          {/* Speicher laut Plan */}
          {plan &&
            z.viertel.slice(i0, n).map((v, k) => {
              const i = i0 + k;
              const p = plan[i];
              if (!p) return null;
              return (
                <rect
                  key={`p${v.start}`}
                  x={X(i)}
                  y={basis + 5}
                  width={schritt + 0.2}
                  height={8}
                  fill={p === 'laedt' ? t.plan : 'url(#vp-pz-abgeben)'}
                />
              );
            })}
          {plan && <PlanUmriss plan={plan} i0={i0} n={n} X={X} y={basis + 5} farbe={t.plan} />}

          {/* Auswahl */}
          {auswahl != null && auswahl >= i0 && auswahl < n && z.viertel[auswahl].ct != null && (
            <g>
              <line
                x1={X(auswahl) + schritt / 2}
                x2={X(auswahl) + schritt / 2}
                y1={oben - 4}
                y2={basis}
                stroke="var(--vp-c-primary, #2563eb)"
                strokeWidth={1.5}
              />
              <circle
                cx={X(auswahl) + schritt / 2}
                cy={Y(z.viertel[auswahl].ct as number)}
                r={5}
                fill="#fff"
                stroke="var(--vp-c-primary, #2563eb)"
                strokeWidth={2.5}
              />
            </g>
          )}

          {/* Jetzt */}
          {xJetzt != null && (
            <g className="vp-pz-jetzt">
              <line x1={xJetzt} x2={xJetzt} y1={RIB + 18} y2={basis + planH} stroke={t.jetzt} strokeWidth={2} />
              <rect
                x={Math.max(padL - 6, Math.min(W - padR - pilleW, xJetzt - pilleW / 2))}
                y={RIB + 2}
                width={pilleW}
                height={19}
                rx={9.5}
                fill={t.jetzt}
              />
              <text
                x={Math.max(padL - 6, Math.min(W - padR - pilleW, xJetzt - pilleW / 2)) + pilleW / 2}
                y={RIB + 15.5}
                className="vp-pz-pille-text"
                textAnchor="middle"
              >
                {pilleText}
              </text>
            </g>
          )}

          {/* Achse */}
          {achse.map((a) => (
            <text
              key={a.x}
              x={a.x}
              y={H - 4}
              className="vp-pz-achse"
              textAnchor={a.x < padL + 14 ? 'start' : a.x > W - 16 ? 'end' : 'middle'}
            >
              {a.text}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}

/** Ein Umriss je Block „gibt ab" — die Schraffur allein verliert bei 2 px Breite ihre Kante. */
function PlanUmriss({
  plan,
  i0,
  n,
  X,
  y,
  farbe,
}: {
  plan: readonly (PlanTun | null)[];
  i0: number;
  n: number;
  X: (i: number) => number;
  y: number;
  farbe: string;
}) {
  const bloecke: [number, number][] = [];
  let a: number | null = null;
  for (let i = i0; i <= n; i++) {
    const ab = i < n && plan[i] === 'gibtAb';
    if (ab && a == null) a = i;
    if (!ab && a != null) {
      bloecke.push([a, i]);
      a = null;
    }
  }
  return (
    <>
      {bloecke.map(([von, bis]) => (
        <rect key={von} x={X(von)} y={y} width={X(bis) - X(von)} height={8} fill="none" stroke={farbe} strokeWidth={1} />
      ))}
    </>
  );
}

/** Die Legende: nur Stufen, die im Bild vorkommen, und der Speicher, wenn es ihn gibt. */
export function PreisLegende({ z, plan }: { z: Zeitstrahl; plan: boolean }) {
  const t = chartTheme();
  const da = new Set<PreisStufe>();
  for (let i = z.ab; i < z.viertel.length; i++) {
    const s = stufeBei(z, i);
    if (s && s !== 'vorbei') da.add(s);
  }
  const reihe: PreisStufe[] = (['negativ', 'guenstig', 'mittel', 'teuer'] as const).filter((s) => da.has(s));
  if ((z.flach || reihe.length === 0) && !plan) return null;
  return (
    <div className="vp-pz-legende">
      {!z.flach &&
        reihe.map((s) => (
          <span key={s}>
            <i style={{ background: stufenFarbe(t, s) }} aria-hidden="true" />
            {STUFE_WORT[s]}
          </span>
        ))}
      {plan && (
        <span className="vp-pz-legende-gruppe">
          Speicher laut Plan:
          <span>
            <i style={{ background: t.plan }} aria-hidden="true" />
            lädt
          </span>
          <span>
            <i className="is-abgeben" aria-hidden="true" />
            gibt ab
          </span>
        </span>
      )}
    </div>
  );
}
