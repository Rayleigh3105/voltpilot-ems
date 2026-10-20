import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { chartTheme } from '../chartTheme';
import { withAlpha } from '../chartStyle';
import { haptik } from '../haptik';
import { abstand } from '../preisZeitstrahl';
import { useContainerWidth } from '../useContainerWidth';
import {
  grad,
  gradSpanne,
  HIMMEL_WORT,
  pvBei,
  sonnenSatz,
  stundeBei,
  type HimmelArt,
  type WetterModell,
  type WetterStunde,
  type WetterTagModell,
} from '../wetterTag';
import './PreisZeitstrahl.css';
import './WetterTag.css';

/**
 * Die Bausteine der Wetter-Seite (Konzept „Preise und Wetter", Fassung 3,
 * E5 = A „Wetter zuerst"). Sie rechnen nichts — jede Zahl kommt aus
 * `wetterTag.ts`. Bedienung wie auf der Preis-Seite und im Cockpit: der Finger
 * tippt, die Maus darf ziehen, ‹ › gehen je 15 Minuten.
 */

const VIERTEL_MS = 15 * 60_000;
const STUNDE_MS = 3600_000;

const kw1 = (v: number) => v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const kwh0 = (v: number) => Math.round(v).toLocaleString('de-DE');
const uhr = (ms: number) => new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

/* ===========================================================================
 * Das Wettersymbol
 * ========================================================================= */

function sonne(cx: number, cy: number, r: number, strahl: number): ReactNode {
  const strahlen = Array.from({ length: 8 }, (_, k) => {
    const a = (k * Math.PI) / 4;
    const r1 = r + 2.2;
    const r2 = r + 2.2 + strahl;
    return `M${(cx + r1 * Math.cos(a)).toFixed(2)} ${(cy + r1 * Math.sin(a)).toFixed(2)}L${(cx + r2 * Math.cos(a)).toFixed(2)} ${(cy + r2 * Math.sin(a)).toFixed(2)}`;
  }).join('');
  return (
    <>
      <circle cx={cx} cy={cy} r={r} className="vp-ws-sonne" />
      <path d={strahlen} className="vp-ws-strahl" />
    </>
  );
}

function wolke(dx: number, dy: number, hell: boolean): ReactNode {
  return (
    <path
      transform={`translate(${dx} ${dy})`}
      d="M7 19h10.5a4.5 4.5 0 0 0 .4-9 6 6 0 0 0-11.5 1.6A3.8 3.8 0 0 0 7 19z"
      className={hell ? 'vp-ws-wolke is-hell' : 'vp-ws-wolke'}
    />
  );
}

function mond(dx: number, dy: number): ReactNode {
  return <path transform={`translate(${dx} ${dy})`} d="M15.5 3.5a8 8 0 1 0 5 13 6.5 6.5 0 0 1-5-13z" className="vp-ws-mond" />;
}

/** Ein Symbol je Himmel — immer zusammen mit seinem Wort, nie allein. */
export function WetterSymbol({ art, groesse = 24 }: { art: HimmelArt | null; groesse?: number }) {
  let inhalt: ReactNode;
  switch (art) {
    case 'sonnig':
      inhalt = sonne(12, 12, 4.6, 3);
      break;
    case 'wechselnd':
      inhalt = (
        <>
          {sonne(9, 8.5, 3.6, 2.2)}
          {wolke(1.5, 2.2, true)}
        </>
      );
      break;
    case 'bewoelkt':
      inhalt = wolke(0, -1, false);
      break;
    case 'klar':
      inhalt = mond(-1, 0);
      break;
    case 'nachtWolken':
      inhalt = (
        <>
          {mond(-3, -2)}
          {wolke(1.5, 2.5, false)}
        </>
      );
      break;
    default:
      inhalt = wolke(0, -1, false);
  }
  return (
    <svg width={groesse} height={groesse} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false" className="vp-ws">
      {inhalt}
    </svg>
  );
}

/* ===========================================================================
 * Die Antwort oben
 * ========================================================================= */

function InfoKnopf({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="vp-pz-info" aria-label="Woher die Werte kommen" onClick={onClick}>
      <Icon name="info" size={18} />
    </button>
  );
}

function Mini({ titel, wert, einheit, zeile }: { titel: string; wert: string; einheit: string; zeile: string }) {
  return (
    <div className="vp-wt-mini">
      <span className="vp-wt-mini-titel">{titel}</span>
      <b>
        {wert}
        <small>{einheit}</small>
      </b>
      <span className="vp-wt-mini-zeile">{zeile}</span>
    </div>
  );
}

/**
 * Wetter zuerst (E5 = A): Symbol, Temperatur, ein Wort, darunter zwei Zahlen
 * für die Anlage. Mit gewählter Viertelstunde zeigt sie deren Stunde.
 */
export function WetterAntwort({
  m,
  tag,
  auswahl,
  onInfo,
  onSchritt,
  onJetzt,
}: {
  m: WetterModell;
  tag: WetterTagModell;
  auswahl: number | null;
  onInfo: () => void;
  onSchritt: (d: -1 | 1) => void;
  onJetzt: () => void;
}) {
  const gewaehlt = auswahl != null;
  const stunde: WetterStunde | null = gewaehlt ? stundeBei(tag, auswahl) : m.jetzt;
  const heute = m.tage[0];
  const satz = sonnenSatz(m);

  let mini1: ReactNode;
  if (gewaehlt) {
    const pv = pvBei(tag, auswahl);
    mini1 = pv ? (
      <Mini titel={`Sonnenstrom ${uhr(auswahl)}`} wert={kw1(pv.kw)} einheit="kW" zeile={pv.herkunft} />
    ) : (
      <Mini
        titel={`Sonnenstärke ${uhr(auswahl)}`}
        wert={stunde?.ghi != null ? String(Math.round(stunde.ghi / 5) * 5) : '–'}
        einheit="W/m²"
        zeile="laut Wetterdienst"
      />
    );
  } else if (m.pvJetzt) {
    const dunkel = m.pvJetzt.kw < 0.05 && heute?.hell != null && (m.jetztMs < heute.hell.von || m.jetztMs >= heute.hell.bis);
    const zeile = !dunkel ? 'gemessen' : heute?.hell && m.jetztMs < heute.hell.von ? 'noch keine Sonne' : 'nach Sonnenuntergang';
    mini1 = <Mini titel="Sonnenstrom jetzt" wert={kw1(m.pvJetzt.kw)} einheit="kW" zeile={zeile} />;
  } else {
    mini1 = (
      <Mini
        titel="Sonnenstärke jetzt"
        wert={m.jetzt?.ghi != null ? String(Math.round(m.jetzt.ghi / 5) * 5) : '–'}
        einheit="W/m²"
        zeile="laut Wetterdienst"
      />
    );
  }

  const mini2 =
    heute && heute.kwh != null ? (
      <Mini
        titel="Sonnenstrom heute"
        wert={`≈ ${kwh0(heute.kwh)}`}
        einheit="kWh"
        zeile={heute.kwhBisher && heute.kwhBisher >= 0.5 ? `${kwh0(heute.kwhBisher)} schon erzeugt` : 'erwartet'}
      />
    ) : heute && heute.kwhBisher != null && heute.kwhBisher >= 0.5 ? (
      <Mini titel="Sonnenstrom heute" wert={kwh0(heute.kwhBisher)} einheit="kWh" zeile="bisher erzeugt" />
    ) : heute && heute.sonnenStunden != null ? (
      <Mini titel="Sonne heute" wert={`≈ ${heute.sonnenStunden}`} einheit="Std" zeile="laut Wetterdienst" />
    ) : null;

  const art = stunde?.art ?? null;
  const kachel = art === 'klar' || art === 'nachtWolken' ? 'is-nacht' : art === 'bewoelkt' ? 'is-wolke' : '';

  return (
    <>
      <div className="vp-pz-label">
        {gewaehlt ? (
          <>
            <span>
              {tag.wort === 'Heute' ? 'heute' : tag.wort} {uhr(auswahl)} Uhr
            </span>
            <span className="vp-pz-label-rechts">{abstand(auswahl, m.jetztMs)}</span>
          </>
        ) : (
          <span>Wetter am Standort · jetzt {uhr(m.jetztMs)}</span>
        )}
        <InfoKnopf onClick={onInfo} />
      </div>
      {stunde ? (
        <div className="vp-wt-kopf">
          <span className={`vp-wt-symbol ${kachel}`}>
            <WetterSymbol art={art} groesse={44} />
          </span>
          <span className="vp-wt-temp">
            <b>{stunde.temp != null ? `${grad(stunde.temp)} °C` : '–'}</b>
            {art && <span>{HIMMEL_WORT[art]}</span>}
          </span>
          <span className="vp-wt-sub">
            {gewaehlt ? (
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
            ) : (
              satz
            )}
          </span>
        </div>
      ) : (
        <p className="vp-pz-ohne">Für jetzt liegt noch keine Vorhersage vor.</p>
      )}
      <div className="vp-wt-minis">
        {mini1}
        {mini2}
      </div>
    </>
  );
}

/* ===========================================================================
 * Die drei Tage
 * ========================================================================= */

/** Drei Tage wie in jeder Wetter-App; die gewählte Karte steuert das Bild. */
export function TagesKarten({
  m,
  gewaehlt,
  onWahl,
}: {
  m: WetterModell;
  gewaehlt: number;
  onWahl: (i: number) => void;
}) {
  return (
    <div
      className="vp-wt-tage"
      role="tablist"
      aria-label="Tag wählen"
      // So viele Spalten wie Tage: reicht die Vorhersage nur über heute, steht keine leere Spalte daneben.
      style={{ gridTemplateColumns: `repeat(${Math.max(1, m.tage.length)}, minmax(0, 1fr))` }}
    >
      {m.tage.map((t, i) => {
        const spanne = gradSpanne(t.tmin, t.tmax);
        return (
          <button
            key={t.beginn}
            type="button"
            role="tab"
            className="vp-wt-tag"
            aria-selected={gewaehlt === i}
            aria-label={`${t.wort}: ${t.art ? HIMMEL_WORT[t.art] : 'ohne Angabe'}${spanne ? `, ${spanne}` : ''}`}
            onClick={() => onWahl(i)}
          >
            <span className="vp-wt-tag-name">{t.wort}</span>
            <WetterSymbol art={t.art} groesse={32} />
            {t.art && <span className="vp-wt-tag-wort">{HIMMEL_WORT[t.art]}</span>}
            {spanne && <span className="vp-wt-tag-temp">{spanne}</span>}
            <span className="vp-wt-tag-ertrag">
              {t.kwh != null ? (
                <>
                  <b>≈&nbsp;{kwh0(t.kwh)}</b>&nbsp;kWh
                </>
              ) : t.sonnenStunden != null ? (
                t.sonnenStunden < 1 ? (
                  'kaum Sonne'
                ) : (
                  <>
                    <b className="is-neutral">{t.sonnenStunden}</b>&nbsp;Std Sonne
                  </>
                )
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ===========================================================================
 * Das Tagesbild
 * ========================================================================= */

interface Geo {
  i0: number;
  n: number;
  padL: number;
  schritt: number;
  von: number;
}

/**
 * Sonnenstrom des gewählten Tages: gemessen gefüllt, erwartet schraffiert, die
 * Jetzt-Linie wie bei den Preisen, darüber Symbol und Temperatur alle zwei
 * Stunden. Ohne Sonnenstrom-Werte zeigt es die Sonnenstärke — EINE Einheit je
 * Bild, nie zwei Achsen.
 */
export function WetterTagesBild({
  m,
  tag,
  auswahl,
  breit,
  onWahl,
  onJetzt,
}: {
  m: WetterModell;
  tag: WetterTagModell;
  auswahl: number | null;
  breit: boolean;
  onWahl: (ms: number) => void;
  onJetzt: () => void;
}) {
  const [ref, breite] = useContainerWidth<HTMLDivElement>();
  const geo = useRef<Geo | null>(null);
  const finger = useRef<{ x: number; y: number } | null>(null);
  const ziehen = useRef(false);
  const t = chartTheme();

  const istHeute = tag === m.tage[0];
  const stunde = (ms: number) => Math.floor(ms / STUNDE_MS) * STUNDE_MS;
  let von = tag.hell ? tag.hell.von : tag.beginn + 6 * STUNDE_MS;
  let bis = tag.hell ? tag.hell.bis : tag.beginn + 20 * STUNDE_MS;
  if (istHeute && m.jetztMs >= tag.beginn) {
    von = Math.min(von, stunde(m.jetztMs));
    bis = Math.max(bis, Math.min(tag.beginn + 24 * STUNDE_MS, stunde(m.jetztMs) + STUNDE_MS));
  }
  const n = Math.max(1, Math.round((bis - von) / VIERTEL_MS));

  const W = Math.max(240, Math.round(breite || 0));
  const SYMBOL = 46;
  const PILLE = 24;
  const padL = breit ? 46 : 36;
  const padR = 6;
  const plotH = breit ? 220 : 140;
  const oben = SYMBOL + PILLE;
  const basis = oben + plotH;
  const H = basis + 22;
  const schritt = (W - padL - padR) / n;
  const X = (ms: number) => padL + ((ms - von) / VIERTEL_MS) * schritt;
  geo.current = { i0: 0, n, padL, schritt, von };

  const kw = tag.mitStrom;
  const werte: { start: number; v: number; herkunft: 'gemessen' | 'erwartet' | 'wetter' }[] = kw
    ? tag.pv.filter((p) => p.start >= von && p.start < bis).map((p) => ({ start: p.start, v: p.kw, herkunft: p.herkunft }))
    : tag.stunden
        .filter((s) => s.start >= von && s.start < bis && s.ghi != null)
        .map((s) => ({ start: s.start + STUNDE_MS / 2 - VIERTEL_MS / 2, v: s.ghi as number, herkunft: 'wetter' as const }));
  const max = Math.max(0, ...werte.map((w) => w.v));
  const tick = kw ? (max > 6 ? 2 : 1) : 200;
  const ymax = Math.max(tick * 2, Math.ceil((max * 1.12) / tick) * tick);
  const Y = (v: number) => oben + ((ymax - v) / ymax) * plotH;
  const einheit = kw ? 'kW' : 'W/m²';

  const punkt = (w: { start: number; v: number }) => `${(X(w.start) + schritt / 2).toFixed(1)},${Y(w.v).toFixed(1)}`;
  const flaeche = (reihe: typeof werte) => {
    if (reihe.length < 2) return null;
    const a = (X(reihe[0].start) + schritt / 2).toFixed(1);
    const b = (X(reihe[reihe.length - 1].start) + schritt / 2).toFixed(1);
    return { poly: `${a},${basis} ${reihe.map(punkt).join(' ')} ${b},${basis}`, linie: reihe.map(punkt).join(' ') };
  };
  const gemessen = werte.filter((w) => w.herkunft === 'gemessen');
  const ersterErwartet = werte.findIndex((w) => w.herkunft === 'erwartet');
  // Die erwartete Fläche schließt an die letzte Messung an, damit kein Spalt bleibt.
  const erwartet = ersterErwartet >= 0 ? werte.slice(Math.max(0, ersterErwartet - (gemessen.length ? 1 : 0))) : [];
  const fGem = kw ? flaeche(gemessen) : null;
  const fErw = kw ? flaeche(erwartet) : null;
  const fWetter = kw ? null : flaeche(werte);

  let spitze: (typeof werte)[number] | null = null;
  for (const w of werte) if (!spitze || w.v > spitze.v) spitze = w;

  const xJetzt = istHeute && m.jetztMs >= von && m.jetztMs <= bis ? X(m.jetztMs) : null;
  const pilleW = breit ? 84 : 48;
  const pilleX = xJetzt != null ? Math.max(padL - 6, Math.min(W - padR - pilleW, xJetzt - pilleW / 2)) : 0;

  const zweiStunden: number[] = [];
  for (let ms = Math.ceil(von / STUNDE_MS) * STUNDE_MS; ms < bis; ms += STUNDE_MS) {
    if (new Date(ms).getHours() % 2 === 0) zweiStunden.push(ms);
  }

  // --- Bedienung (wie auf der Preis-Seite) ---------------------------------
  const zeitAus = (clientX: number): number | null => {
    const g = geo.current;
    const el = ref.current;
    if (!g || !el) return null;
    const x = clientX - el.getBoundingClientRect().left;
    const i = Math.max(0, Math.min(g.n - 1, Math.floor((x - g.padL) / g.schritt)));
    return g.von + i * VIERTEL_MS;
  };
  const waehle = (ms: number | null, fuehlbar: boolean) => {
    if (ms == null || ms === auswahl) return;
    if (fuehlbar) haptik('tick');
    onWahl(ms);
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
    waehle(zeitAus(e.clientX), false);
  };
  const losgelassen = (e: PointerEvent<HTMLDivElement>) => {
    const f = finger.current;
    finger.current = null;
    ziehen.current = false;
    if (e.pointerType === 'touch' && f && Math.abs(e.clientX - f.x) < 10 && Math.abs(e.clientY - f.y) < 10) {
      waehle(zeitAus(e.clientX), true);
    }
  };
  const taste = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      if (auswahl != null) {
        e.preventDefault();
        onJetzt();
      }
      return;
    }
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const start = auswahl ?? (istHeute ? Math.floor(m.jetztMs / VIERTEL_MS) * VIERTEL_MS : von);
    waehle(Math.max(von, Math.min(bis - VIERTEL_MS, start + d * VIERTEL_MS)), false);
  };

  let ausgewaehlt: { start: number; v: number } | null = null;
  if (auswahl != null && auswahl >= von && auswahl < bis) {
    if (kw) ausgewaehlt = werte.find((w) => auswahl >= w.start && auswahl < w.start + VIERTEL_MS) ?? null;
    else {
      const s = stundeBei(tag, auswahl);
      ausgewaehlt = s?.ghi != null ? { start: s.start + STUNDE_MS / 2 - VIERTEL_MS / 2, v: s.ghi } : null;
    }
  }

  return (
    <div
      ref={ref}
      className="vp-pz-bild"
      tabIndex={0}
      role="group"
      aria-label={`${kw ? 'Sonnenstrom' : 'Sonnenstärke'} ${tag.wort === 'Heute' ? 'heute' : tag.lang}. Antippen oder Pfeiltasten wählen eine Viertelstunde.`}
      onPointerDown={unten}
      onPointerMove={(e) => {
        if (ziehen.current) waehle(zeitAus(e.clientX), false);
      }}
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
            <pattern id="vp-wt-erwartet" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="5" height="5" fill={withAlpha(t.pv, 0.12)} />
              <line x1="0" y1="0" x2="0" y2="5" stroke={t.pv} strokeWidth="1.8" />
            </pattern>
          </defs>

          {/* Himmel über der Zeit */}
          {zweiStunden.map((ms) => {
            const s = stundeBei(tag, ms);
            const x = X(ms);
            return (
              <g key={`h${ms}`}>
                <g transform={`translate(${(x - 11).toFixed(1)} 0)`}>
                  <WetterSymbol art={s?.art ?? null} groesse={22} />
                </g>
                {s?.temp != null && (
                  <text x={x} y={38} className="vp-wt-bild-temp" textAnchor="middle">
                    {grad(s.temp)}°
                  </text>
                )}
              </g>
            );
          })}

          {/* Raster */}
          {Array.from({ length: Math.round(ymax / tick) + 1 }, (_, k) => k * tick).map((v) => (
            <g key={v}>
              <line x1={padL} x2={W - padR} y1={Y(v)} y2={Y(v)} stroke={t.grid} />
              <text x={padL - 6} y={Y(v) + 3.5} className="vp-pz-achse" textAnchor="end">
                {v === ymax ? `${v} ${einheit}` : v}
              </text>
            </g>
          ))}

          {/* Flächen */}
          {fGem && (
            <g>
              <polygon points={fGem.poly} fill={withAlpha(t.pv, 0.6)} />
              <polyline points={fGem.linie} fill="none" stroke={t.pvLine} strokeWidth={2} strokeLinejoin="round" />
            </g>
          )}
          {fErw && (
            <g>
              <polygon points={fErw.poly} fill="url(#vp-wt-erwartet)" />
              <polyline points={fErw.linie} fill="none" stroke={t.pvLine} strokeWidth={2} strokeDasharray="4 3" strokeLinejoin="round" />
            </g>
          )}
          {fWetter && (
            <g>
              <polygon points={fWetter.poly} fill={withAlpha(t.pv, 0.25)} />
              <polyline points={fWetter.linie} fill="none" stroke={t.pvLine} strokeWidth={2} strokeLinejoin="round" />
            </g>
          )}

          {/* Spitze */}
          {spitze && spitze.v > 0 && (() => {
            const x = X(spitze.start) + schritt / 2;
            const y = Y(spitze.v);
            const nah = xJetzt != null && Math.abs(x - xJetzt) < 50;
            const anker = nah ? (xJetzt! >= x ? 'end' : 'start') : 'middle';
            const tx = nah ? (anker === 'end' ? x - 9 : x + 9) : x;
            return (
              <g>
                <circle cx={x} cy={y} r={4.5} fill="#fff" stroke={t.pvLine} strokeWidth={2.5} />
                <text x={Math.max(padL + 20, Math.min(W - 30, tx))} y={nah ? y + 4 : y - 10} className="vp-wt-bild-spitze" textAnchor={anker}>
                  {kw ? `${kw1(spitze.v)} kW` : `${Math.round(spitze.v / 10) * 10} W/m²`}
                </text>
              </g>
            );
          })()}

          {/* Auswahl */}
          {ausgewaehlt && (
            <g>
              <line
                x1={X(auswahl as number) + schritt / 2}
                x2={X(auswahl as number) + schritt / 2}
                y1={oben - 2}
                y2={basis}
                stroke="var(--vp-c-primary, #2563eb)"
                strokeWidth={1.5}
              />
              <circle cx={X(ausgewaehlt.start) + schritt / 2} cy={Y(ausgewaehlt.v)} r={5} fill="#fff" stroke="var(--vp-c-primary, #2563eb)" strokeWidth={2.5} />
            </g>
          )}

          {/* Jetzt */}
          {xJetzt != null && (
            <g className="vp-pz-jetzt">
              <line x1={xJetzt} x2={xJetzt} y1={SYMBOL + 18} y2={basis} stroke={t.jetzt} strokeWidth={2} />
              <rect x={pilleX} y={SYMBOL + 2} width={pilleW} height={19} rx={9.5} fill={t.jetzt} />
              <text x={pilleX + pilleW / 2} y={SYMBOL + 15.5} className="vp-pz-pille-text" textAnchor="middle">
                {breit ? `Jetzt ${uhr(m.jetztMs)}` : 'Jetzt'}
              </text>
            </g>
          )}

          {/* Achse */}
          {zweiStunden.map((ms, k) => (
            <text key={`a${ms}`} x={X(ms)} y={H - 4} className="vp-pz-achse" textAnchor="middle">
              {k === 0 ? `${new Date(ms).getHours()} Uhr` : new Date(ms).getHours()}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}

/** Die Legende: gemessen, erwartet — nur, was im Bild vorkommt. */
export function WetterLegende({ tag }: { tag: WetterTagModell }) {
  if (!tag.mitStrom) return null;
  const t = chartTheme();
  const gemessen = tag.pv.some((p) => p.herkunft === 'gemessen');
  const erwartet = tag.pv.some((p) => p.herkunft === 'erwartet');
  return (
    <div className="vp-pz-legende">
      {gemessen && (
        <span>
          <i style={{ background: withAlpha(t.pv, 0.6), border: `1px solid ${t.pvLine}` }} aria-hidden="true" />
          gemessen
        </span>
      )}
      {erwartet && (
        <span>
          <i className="vp-wt-legende-erwartet" aria-hidden="true" />
          erwartet
        </span>
      )}
    </div>
  );
}

/** Stunde für Stunde — am Telefon im Blatt, am Rechner neben dem Bild. */
export function StundenTabelle({ m, tag }: { m: WetterModell; tag: WetterTagModell }) {
  const von = tag.hell ? tag.hell.von : tag.beginn + 6 * STUNDE_MS;
  const bis = tag.hell ? tag.hell.bis : tag.beginn + 20 * STUNDE_MS;
  const zeilen = tag.stunden.filter((s) => s.start >= von && s.start < bis);
  return (
    <table className="vp-wt-tabelle">
      <thead>
        <tr>
          <th scope="col">Zeit</th>
          <th scope="col">Himmel</th>
          <th scope="col" className="is-zahl">
            Temp.
          </th>
          <th scope="col" className="is-zahl">
            {tag.mitStrom ? 'Sonnenstrom' : 'Sonnenstärke'}
          </th>
        </tr>
      </thead>
      <tbody>
        {zeilen.map((s) => {
          const jetzt = m.jetztMs >= s.start && m.jetztMs < s.start + STUNDE_MS;
          const vorbei = s.start + STUNDE_MS <= m.jetztMs;
          const viertel = tag.pv.filter((p) => p.start >= s.start && p.start < s.start + STUNDE_MS);
          const gem = viertel.filter((p) => p.herkunft === 'gemessen');
          const quelle = gem.length >= 2 ? gem : viertel;
          const pv = quelle.length > 0 ? quelle.reduce((a, p) => a + p.kw, 0) / quelle.length : null;
          return (
            <tr key={s.start} className={jetzt ? 'is-jetzt' : vorbei ? 'is-vorbei' : undefined}>
              <th scope="row">{jetzt ? 'jetzt' : `${new Date(s.start).getHours()} Uhr`}</th>
              <td>
                <span className="vp-wt-tabelle-himmel">
                  <WetterSymbol art={s.art} groesse={20} />
                  {s.art ? HIMMEL_WORT[s.art] : '–'}
                </span>
              </td>
              <td className="is-zahl">{s.temp != null ? `${grad(s.temp)} °C` : '–'}</td>
              <td className="is-zahl">
                {tag.mitStrom ? (
                  pv != null ? (
                    <>
                      {kw1(pv)}&nbsp;kW <small>{gem.length >= 2 ? 'gemessen' : 'erwartet'}</small>
                    </>
                  ) : (
                    '–'
                  )
                ) : s.ghi != null ? (
                  `${Math.round(s.ghi / 5) * 5} W/m²`
                ) : (
                  '–'
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
