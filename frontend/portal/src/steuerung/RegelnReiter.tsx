/**
 * Reiter „Regeln“ und der Satzbaukasten (Prototyp `ui-regeln.js`).
 *
 * Eine Regel ist ein Satz aus Bausteinen: „Wenn der Börsenpreis unter 10 ct
 * liegt: Heizstab einschalten." Jeder Baustein ist antippbar, der Probelauf
 * zeigt heute und morgen, wann sie greift und was sie kostet, und vor dem
 * Aktivieren stehen die Folgen. Gespeichert wird eine gewöhnliche Regel der
 * Box (`regeln.ts` → `buildGuidedFlow`).
 */
import { liste } from './liste';
import { useState, type ChangeEvent, type ReactNode } from 'react';
import type { RuleEvents } from '../api';
import { Recht } from '../components/Recht';
import { ereignisZeile } from '../regeln/verlauf';
import { Blatt } from './Blatt';
import type { BlattKontext } from './Blaetter';
import type { GeraetBild } from './bild';
import { Ic } from './Ic';
import {
  OP_WORT,
  greift,
  probelauf,
  regelSatz,
  tatenFuer,
  vars,
  vorlagenFuer,
  vorlagenZiel,
  wertText,
  type Bedingung,
  type Bezug,
  type RegelEntwurf,
  type RegelKarte,
  type VarId,
} from './regeln';
import type { BlattZustand, SeitenBild } from './seite';
import { SZENEN, szenenfaehig } from './szenen';
import { Zeitband, type Band } from './Zeitband';
import { N, TAG, dauer, fCt, fEur, fKwh, spannen, spannenText, uhr, uhrMin, uhrTag, uhrVon, zahl1 } from './zeit';

export interface RegelnReiterProps {
  bild: SeitenBild;
  karten: RegelKarte[];
  ziele: GeraetBild[];
  bezug: Bezug;
  ereignisse: RuleEvents | null;
  busy: string | null;
  oeffne: (b: BlattZustand) => void;
  onSchalter: (k: RegelKarte) => void;
  onBefehle: () => void;
  /** Tippen auf die laufende Szene beendet sie (ohne Nachfrage). */
  onSzeneBeenden: () => void;
}

const FARBE: Record<string, [string, string]> = {
  price: ['var(--price-soft)', '#1d4ed8'],
  neg: ['var(--st-done-soft)', 'var(--neg)'],
  pv: ['var(--pv-soft)', 'var(--pv)'],
  batt: ['var(--batt-soft)', 'var(--batt)'],
  navy: ['var(--c-muted)', 'var(--navy)'],
};

export function RegelnReiter(p: RegelnReiterProps) {
  const { bild } = p;
  const vorlagen = vorlagenFuer(p.bezug, p.ziele);
  const an = p.karten.filter((k) => k.an).length;
  const r = bild.raster;
  const heuteStart = r.start;
  const log: { t: number; text: ReactNode }[] = [];
  for (const e of liste(p.ereignisse?.events)) {
    const ms = Date.parse(e.occurredAt);
    if (!(ms >= heuteStart && ms <= r.nowMs)) continue;
    const zeile = ereignisZeile(e);
    const karte = p.karten.find((k) => k.flowId === e.ruleRef);
    if (!zeile) continue;
    log.push({ t: ms, text: <>{karte ? <>Regel „{karte.name}“: </> : null}{zeile.replace(/^\d{1,2}:\d{2} · /, '')}</> });
  }
  for (const g of bild.geraete) {
    if (!g.eingriff) continue;
    log.push({ t: r.nowMs, text: <>Ihr Eingriff: <b>{g.name}</b> {g.eingriff.art}{g.eingriff.bisMs != null ? ` bis ${uhrVon(r, g.eingriff.bisMs)}` : ''}</> });
  }
  const sz = bild.szene;
  if (sz?.seitMs != null && sz.seitMs >= heuteStart && sz.seitMs <= r.nowMs) {
    log.push({ t: sz.seitMs, text: <>Szene <b>„{sz.def.name}“</b> eingeschaltet: {sz.ids.length} {sz.ids.length === 1 ? 'Gerät' : 'Geräte'} pausiert</> });
  }
  log.sort((a, b) => b.t - a.t);
  return (
    <>
      <Recht aktion="betriebsweise.aendern"><button
        type="button"
        className="btn voll"
        style={{ width: '100%', minHeight: 52, fontSize: 16 }}
        disabled={!p.ziele.length}
        onClick={(e) => { e.currentTarget.focus(); p.oeffne({ art: 'regel' }); }}
      >
        <Ic n="plus" s={20} />
        Neue Regel
      </button></Recht>
      {!p.ziele.length && (
        <p className="leise voll">Noch gibt es kein Gerät, das eine Regel schalten kann. Schaltbare Geräte verbinden Sie in der Anlage.</p>
      )}
      {vorlagen.length > 0 && (
        <section aria-label="Vorlagen" className="voll">
          <div className="grp-h"><h3>Vorlagen</h3><span>antippen und anpassen</span></div>
          <Recht aktion="betriebsweise.aendern"><div className="vorl">
            {vorlagen.map((v) => {
              const g = vorlagenZiel(v, p.ziele);
              const [bg, fg] = FARBE[v.farbe];
              return (
                <button type="button" className="vk" key={v.id} onClick={(e) => { e.currentTarget.focus(); p.oeffne({ art: 'regel', vorlage: v.id }); }}>
                  <span className="ico" style={{ background: bg, color: fg }}><Ic n={v.icon} s={19} /></span>
                  <b>{v.titel}</b>
                  <small>{g ? v.satz.replace(/: .*$/, `: ${g.name} einschalten`) : v.satz}</small>
                </button>
              );
            })}
          </div></Recht>
        </section>
      )}
      {bild.geraete.some(szenenfaehig) && (
        <section aria-label="Szenen" className="voll">
          <div className="grp-h"><h3>Szenen</h3><span>ein Tipp, mehrere Geräte</span></div>
          <Recht aktion="betriebsweise.aendern"><div className="szenen">
            {SZENEN.map((sz) => {
              const an = bild.szene?.def.id === sz.id;
              return (
                <button
                  type="button"
                  className="sz"
                  key={sz.id}
                  aria-pressed={an}
                  disabled={p.busy === 'szene'}
                  onClick={(e) => {
                    if (an) { p.onSzeneBeenden(); return; }
                    e.currentTarget.focus();
                    p.oeffne({ art: 'szene', id: sz.id });
                  }}
                >
                  <Ic n={sz.icon} s={20} />
                  <b>{sz.name}</b>
                  <small>{an ? 'an · tippen zum Beenden' : sz.kurz}</small>
                </button>
              );
            })}
          </div></Recht>
        </section>
      )}
      <section aria-label="Ihre Regeln" style={{ display: 'grid', gap: 8 }} className="links">
        <div className="grp-h"><h3>Ihre Regeln</h3><span>{an} von {p.karten.length} an</span></div>
        {p.karten.map((k) => (
          <RegelKarteView key={k.flowId} k={k} bild={bild} busy={p.busy === k.flowId} oeffne={p.oeffne} onSchalter={p.onSchalter} />
        ))}
        {!p.karten.length && <p className="leise" style={{ padding: '0 4px' }}>Noch keine Regel. Eine Vorlage ist der schnellste Anfang.</p>}
        <p className="leise" style={{ padding: '0 4px' }}>Regeln sind Ausnahmen vom Smart-Auftrag der Geräte. Schutzgrenzen und Ihre Eingriffe gehen immer vor.</p>
      </section>
      <section className="card rechts" aria-label="Verlauf" style={{ gridRow: 'auto' }}>
        <div className="card-h">
          <h2><Ic n="history" s={18} />Heute passiert</h2>
          <span className="meta">bis {uhrMin(r.jetztMin)}</span>
        </div>
        {log.length ? (
          <ul className="log">
            {log.slice(0, 8).map((l, i) => (
              <li key={i}><time>{new Date(l.t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</time><span>{l.text}</span></li>
            ))}
          </ul>
        ) : (
          <p className="leise">Heute hat noch keine Regel geschaltet.</p>
        )}
        <button type="button" className="lnk" onClick={p.onBefehle}>Befehle an Ihre Geräte ansehen <Ic n="chevR" s={16} /></button>
      </section>
    </>
  );
}

function RegelKarteView({ k, bild, busy, oeffne, onSchalter }: {
  k: RegelKarte; bild: SeitenBild; busy: boolean; oeffne: (b: BlattZustand) => void; onSchalter: (k: RegelKarte) => void;
}) {
  const r = bild.raster;
  const heute = k.entwurf ? greift(k.entwurf, bild.reihen, 0, TAG) : null;
  const jetzt = heute ? heute[r.jetzt] : null;
  const kommend = heute ? spannen(heute.slice(r.jetzt), r.jetzt) : [];
  const vorbei = heute ? spannen(heute.slice(0, r.jetzt), 0) : [];
  // Angehalten (UEMS SZ-2 A): eine eingeschaltete Regel wirkt nicht, bis die Steuerung fortgesetzt ist.
  const ruht = k.an && bild.funktion.angehalten;
  let pill: ReactNode;
  if (!k.an) pill = <span className="pill off"><i />aus</span>;
  else if (ruht) pill = <span className="pill lock"><i />wirkt nicht</span>;
  else if (jetzt) pill = <span className="pill on"><i />greift gerade</span>;
  else pill = <span className="pill wait"><i />wartet</span>;
  const info: string[] = [];
  if (ruht) info.push('bis Sie fortsetzen');
  else {
    if (k.an && vorbei.length) info.push(`heute schon ${spannenText(vorbei, 2)}`);
    if (k.an && kommend.length && !jetzt) info.push(`als Nächstes ${uhrTag(kommend[0][0])}`);
    if (k.an && heute && !kommend.length) info.push('greift heute nicht mehr');
  }
  return (
    <article className={`rule${k.an ? '' : ' aus'}${ruht ? ' matt' : ''}`} id={`regel-${k.flowId}`}>
      <button type="button" className="r-satz" onClick={(e) => { e.currentTarget.focus(); oeffne({ art: 'regel', flowId: k.flowId }); }}>
        {k.satz ? <><span className="h">{k.satz.wenn}</span>: <span className="d">{k.satz.dann}</span>.</> : <>{k.name}</>}
      </button>
      <Recht aktion="betriebsweise.aendern"><button
        type="button"
        className="sw"
        role="switch"
        aria-checked={k.an}
        aria-label={`Regel ${k.name} ${k.an ? 'ausschalten' : 'einschalten'}`}
        disabled={busy}
        onClick={() => onSchalter(k)}
      /></Recht>
      <div className="r-meta">
        {pill}
        <span>{k.name}</span>
        {!k.satz && <span>· {k.freiText}</span>}
        {info.length > 0 && <span>· {info.join(' · ')}</span>}
      </div>
      {heute && <Streifen bits={heute} an={k.an && !ruht} jetzt={r.jetzt} />}
    </article>
  );
}

function Streifen({ bits, an, jetzt }: { bits: boolean[]; an: boolean; jetzt: number }) {
  const W = 400;
  const bw = W / TAG;
  return (
    <div className="r-strip">
      <svg viewBox={`0 0 ${W} 12`} width="100%" height={12} preserveAspectRatio="none" aria-hidden="true">
        <rect x={0} y={3} width={W} height={6} rx={3} fill="#eef2f6" />
        {bits.map((b, t) => (b ? <rect key={t} x={t * bw} y={3} width={bw + 0.3} height={6} fill={an ? 'var(--load)' : '#94a3b8'} fillOpacity={t >= jetzt ? 0.5 : 1} /> : null))}
        <rect x={jetzt * bw} y={0} width={1.6} height={12} fill="var(--navy)" />
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Der Baukasten
// ---------------------------------------------------------------------------

export interface RegelBlattProps {
  k: BlattKontext;
  start: RegelEntwurf;
  bearbeiten: boolean;
  freiName?: string | null;
  ziele: GeraetBild[];
  bezug: Bezug;
  karten: RegelKarte[];
  sofortFolgen?: boolean;
  onAktivieren: (e: RegelEntwurf) => Promise<boolean>;
  onLoeschen: (flowId: string) => Promise<boolean>;
}

type Fokus = string | null;

export function RegelBlatt(p: RegelBlattProps) {
  const { k } = p;
  const [d, setD] = useState<RegelEntwurf>(p.start);
  const [fokus, setFokus] = useState<Fokus>(null);
  const [schritt, setSchritt] = useState<'bau' | 'folgen'>(p.sofortFolgen ? 'folgen' : 'bau');
  const [loeschen, setLoeschen] = useState(false);
  const V = vars(p.bezug);
  const g = p.ziele.find((x) => x.id === d.dann.g) ?? null;
  const setze = (neu: Partial<RegelEntwurf>) => setD({ ...d, ...neu });
  const setzeBed = (i: number, c: Bedingung) => setze({ wenn: d.wenn.map((x, j) => (j === i ? c : x)) });
  const busy = k.busy === 'regel';
  const r = k.bild.raster;
  const satz = regelSatz(d, g);
  const pl = probelauf(d, k.bild.reihen, g, r.jetzt);
  const andere = p.karten.filter((x) => x.flowId !== d.flowId && x.entwurf?.dann.g === d.dann.g);

  if (schritt === 'folgen') {
    const std = pl.mehr / 4;
    const neu = spannen(pl.bits, r.jetzt);
    const passiert: string[] = [];
    passiert.push(`${g?.name ?? 'Das Gerät'} läuft ab jetzt bis morgen Abend zusätzlich ${std ? dauer(pl.mehr) : 'gar nicht'}${neu.length ? `: ${spannenText(neu, 3)}` : ''}.`);
    if (pl.kwh > 0.05) passiert.push(`Mehr Energie: ≈ ${fKwh(pl.kwh)}, davon aus dem Netz ≈ ${fKwh(pl.netzKwh)}${pl.eur > 0.005 ? ` (≈ ${fEur(pl.eur)} zum Börsenpreis)` : ''}.`);
    if (andere.length) passiert.push(`Die Regel ersetzt nichts: für ${g?.name} gilt auch ${andere.map((x) => `„${x.name}“`).join(', ')}.`);
    return (
      <Blatt
        titel="Folgen prüfen"
        kopf={
          <>
            <button type="button" className="ibtn" aria-label="Zurück" onClick={() => setSchritt('bau')}><Ic n="chevL" s={22} /></button>
            <h2 aria-hidden="true">Folgen prüfen<small>{d.name}</small></h2>
          </>
        }
        voll
        onClose={k.zu}
        fuss={
          <>
            <button type="button" className="btn sek" onClick={() => setSchritt('bau')}>Zurück</button>
            <Recht aktion="betriebsweise.aendern"><button type="button" className="btn" disabled={busy || !d.name.trim()} onClick={async () => { if (await p.onAktivieren(d)) k.zu(); }}>
              <Ic n="check" s={18} />
              {busy ? 'Aktiviere …' : 'Regel aktivieren'}
            </button></Recht>
          </>
        }
      >
        <p className="satz-p"><span className="h">{satz.wenn}</span>: <span className="d">{satz.dann}</span>.</p>
        <div className="folgen">
          <div className="fb"><b>Das passiert</b><ul>{passiert.map((x) => <li key={x}>{x}</li>)}</ul></div>
          <div className="fb"><b>Das bleibt</b><ul><li>Schutzgrenzen, Netzanschluss und § 14a gehen vor.</li><li>Ihr Eingriff am Gerät geht vor.</li><li>Gemessenes bis jetzt ändert sich nicht.</li></ul></div>
          <div className="fb"><b>Zurücknehmen</b><ul><li>Ausschalten wirkt sofort und fragt nicht nach. Die Regel bleibt gespeichert.</li></ul></div>
        </div>
        <label className="prow" style={{ padding: '0 2px' }} htmlFor="regel-name"><span>Name der Regel</span></label>
        <input
          id="regel-name"
          value={d.name}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setze({ name: e.target.value })}
          style={{ minHeight: 46, borderRadius: 12, border: '1px solid var(--field)', padding: '0 12px', font: '600 16px var(--font)', width: '100%' }}
        />
      </Blatt>
    );
  }

  const tok = (key: string, cls: string, text: string, icon?: string) => (
    <button type="button" className={`tok ${cls}`} aria-expanded={fokus === key} onClick={() => setFokus(fokus === key ? null : key)} key={key}>
      {icon && <Ic n={icon} s={17} />}
      {text}
    </button>
  );
  const tokens: ReactNode[] = [<span className="w" key="w">Wenn</span>];
  d.wenn.forEach((c, i) => {
    if (i > 0) tokens.push(<button type="button" className="tok link" key={`o${i}`} onClick={() => setze({ oder: !d.oder })}>{d.oder ? 'oder' : 'und'}</button>);
    const v = V[c.v];
    tokens.push(tok(`w${i}v`, 'var', v.label, v.icon));
    if (c.v !== 'zeit') tokens.push(tok(`w${i}o`, 'op', OP_WORT[c.op]));
    tokens.push(tok(`w${i}w`, 'val', wertText(c)));
    if (d.wenn.length > 1) {
      tokens.push(
        <button type="button" className="tok add" key={`x${i}`} aria-label="Bedingung entfernen" onClick={() => { setze({ wenn: d.wenn.filter((_, j) => j !== i) }); setFokus(null); }}>
          <Ic n="x" s={15} />
        </button>,
      );
    }
  });
  if (d.wenn.length < 4) {
    tokens.push(
      <button type="button" className="tok add" key="plus" onClick={() => { setze({ wenn: [...d.wenn, { v: 'preis', op: 'unter', w: 10 }] }); setFokus(`w${d.wenn.length}v`); }}>
        <Ic n="plus" s={15} />
        {d.oder ? 'oder' : 'und'} …
      </button>,
    );
  }
  tokens.push(<span className="w" key="dann">dann</span>);
  tokens.push(tok('dg', 'dev', g?.name ?? 'Gerät wählen', g?.symbol));
  tokens.push(tok('da', 'act', (tatenFuer(g).find((x) => x[0] === d.dann.a) ?? tatenFuer(g)[0])[1]));

  // Der Wähler zum angetippten Baustein.
  let picker: ReactNode = <p className="leise" style={{ padding: '2px 4px' }}>Tippen Sie auf einen Baustein, um ihn zu ändern.</p>;
  const m = fokus ? /^w(\d)([vow])$/.exec(fokus) : null;
  if (m) {
    const i = Number(m[1]);
    const c = d.wenn[i];
    const v = V[c.v];
    if (m[2] === 'v') {
      const kats = [...new Set(Object.values(V).map((x) => x.kat))];
      picker = (
        <div className="pick">
          <b>Wenn …</b>
          <div className="vgrid">
            {kats.map((kat) => [
              <span className="vkat" key={`k-${kat}`}>{kat}</span>,
              ...(Object.entries(V) as [VarId, (typeof V)[VarId]][]).filter(([, x]) => x.kat === kat).map(([key, x]) => (
                <button
                  type="button"
                  className="vopt"
                  key={key}
                  aria-pressed={c.v === key}
                  disabled={x.gesperrt != null}
                  onClick={() => { setzeBed(i, { v: key, op: x.ops[0], w: Array.isArray(x.def) ? [...x.def] as [number, number] : x.def }); setFokus(`w${i}w`); }}
                >
                  <Ic n={x.icon} s={18} />
                  <span>{x.label}{x.gesperrt && <small>{x.gesperrt}</small>}</span>
                </button>
              )),
            ])}
          </div>
        </div>
      );
    } else if (m[2] === 'o') {
      picker = (
        <div className="pick">
          <b>Vergleich</b>
          <div className="chips">
            {v.ops.map((o) => (
              <button type="button" key={o} aria-pressed={c.op === o} onClick={() => { setzeBed(i, { ...c, op: o }); setFokus(`w${i}w`); }}>{OP_WORT[o]}</button>
            ))}
          </div>
        </div>
      );
    } else if (c.v === 'zeit') {
      const [a, b] = c.w as [number, number];
      const stp = (j: 0 | 1, delta: number) => {
        const w: [number, number] = [a, b];
        w[j] = (w[j] + delta + TAG) % TAG;
        setzeBed(i, { ...c, w });
      };
      picker = (
        <div className="pick">
          <b>Zeitraum</b>
          <div className="prow"><span>von</span><Stp wert={uhr(a)} onMinus={() => stp(0, -2)} onPlus={() => stp(0, 2)} /></div>
          <div className="prow"><span>bis</span><Stp wert={uhr(b)} onMinus={() => stp(1, -2)} onPlus={() => stp(1, 2)} /></div>
          <p className="leise">Über Mitternacht geht: 22:00–07:00. Das Ende gehört nicht mehr dazu.</p>
        </div>
      );
    } else {
      const w = c.w as number;
      const rund = (x: number) => Math.round(x * 100) / 100;
      const neu = (x: number) => setzeBed(i, { ...c, w: rund(Math.max(v.min ?? -Infinity, Math.min(v.max ?? Infinity, x))) });
      picker = (
        <div className="pick">
          <b>{v.label}</b>
          <div className="rng">
            <div className="prow"><span>{OP_WORT[c.op]}</span><Stp wert={wertText(c)} onMinus={() => neu(w - (v.schritt ?? 1))} onPlus={() => neu(w + (v.schritt ?? 1))} /></div>
            <input type="range" min={v.min} max={v.max} step={v.schritt} value={w} aria-label={v.label} onChange={(e) => neu(Number(e.target.value))} />
            <div className="skala"><span>{zahl1(v.min ?? 0).replace(/,0$/, '')}</span><span>{zahl1(v.max ?? 0).replace(/,0$/, '')} {v.einheit}</span></div>
          </div>
        </div>
      );
    }
  } else if (fokus === 'dg') {
    picker = (
      <div className="pick">
        <b>Welches Gerät?</b>
        <div className="vgrid">
          {p.ziele.map((x) => (
            <button type="button" className="vopt" key={x.id} aria-pressed={d.dann.g === x.id} onClick={() => { setze({ dann: { g: x.id, a: tatenFuer(x).some((t) => t[0] === d.dann.a) ? d.dann.a : 'an' } }); setFokus('da'); }}>
              <Ic n={x.symbol} s={18} />
              <span>{x.name}</span>
            </button>
          ))}
        </div>
      </div>
    );
  } else if (fokus === 'da') {
    picker = (
      <div className="pick">
        <b>Was soll passieren?</b>
        <div className="chips">
          {tatenFuer(g).map(([key, l]) => (
            <button type="button" key={key} aria-pressed={d.dann.a === key} onClick={() => { setze({ dann: { ...d.dann, a: key } }); setFokus(null); }}>{l}</button>
          ))}
        </div>
        <p className="leise">„Bleibt aus“ (nie wenn …) kommt noch; bis dahin sperren Sie ein Gerät mit „Aus“ am Gerät.</p>
      </div>
    );
  }

  // Probelauf-Bänder: die erste Bedingung bestimmt das obere Band.
  const erste = d.wenn[0];
  const bits = pl.bits;
  const an = (t: number) => (t >= r.jetzt ? bits[t - r.jetzt] === true : false);
  const bands: Band[] = [];
  if (erste?.v === 'preis') bands.push({ art: 'preis', h: 34, gap: 8, hl: (t) => (t < r.jetzt ? null : an(t)), linie: erste.w as number });
  else if (erste?.v === 'sonne') bands.push({ art: 'pv', h: 30, gap: 8, frei: an });
  else if (erste?.v === 'soc') bands.push({ art: 'soc', h: 18, gap: 8, label: 'Ladestand des Speichers' });
  else bands.push({ art: 'hl', h: 14, gap: 8, symbol: V[erste?.v ?? 'zeit'].icon, label: 'Bedingung erfüllt', hl: an });
  if (erste?.v !== 'preis') bands.push({ art: 'preis', h: 22, gap: 8 });
  const reihe = g ? g.kw.map((x, t) => (t >= r.jetzt && an(t) ? Math.max(x ?? 0, g.nennKw ?? 1) : x)) : null;

  const hinweise: ReactNode[] = [];
  if (!pl.treffer) {
    hinweise.push(
      <div className="konflikt" key="nie"><Ic n="alert" s={18} /><span>Trifft ab jetzt bis morgen Abend nie zu.{erste?.v === 'preis' && pl.niedrigsterPreis != null ? ` Der niedrigste bekannte Preis ist ${fCt(pl.niedrigsterPreis)}.` : ''}</span></div>,
    );
  }
  if (pl.unbekannt) {
    hinweise.push(<div className="konflikt" key="unb"><Ic n="info" s={18} /><span>Für morgen fehlen noch die Börsenpreise (kommen gegen 13 Uhr). Bis dahin schaltet die Regel dort nicht: unbekannt ist keine Null.</span></div>);
  }
  if (andere.length) {
    hinweise.push(<div className="konflikt" key="and"><Ic n="link" s={18} /><span>Für {g?.name} gilt schon {andere.map((x) => `„${x.name}“`).join(', ')}. Beide gelten nebeneinander.</span></div>);
  }
  if (g && !g.gemessen) {
    hinweise.push(<div className="ok-note" key="mess"><Ic n="info" s={18} /><span>{g.name} wird nicht gemessen. Energie und Kosten sind angenommen (Nennleistung × Zeit).</span></div>);
  }
  const kosten = pl.eur > 0.005 ? `≈ ${fEur(pl.eur)}` : '0,00 €';
  const ticks = [0, 48, 96, 144, 192];
  const kopf = (
    <>
      <span className="ico"><Ic n="zap" s={22} /></span>
      <h2 aria-hidden="true">{p.bearbeiten ? 'Regel ändern' : 'Neue Regel'}<small>{d.name}</small></h2>
    </>
  );
  return (
    <Blatt
      titel={p.bearbeiten ? 'Regel ändern' : 'Neue Regel'}
      kopf={kopf}
      voll
      onClose={k.zu}
      fuss={
        <>
          {p.bearbeiten && d.flowId ? (
            <Recht aktion="betriebsweise.aendern"><button
              type="button"
              className="btn sek"
              style={loeschen ? { color: 'var(--c-destructive)', boxShadow: 'inset 0 0 0 1.5px var(--c-destructive)' } : undefined}
              disabled={busy}
              onClick={async () => {
                if (!loeschen) { setLoeschen(true); return; }
                if (d.flowId && (await p.onLoeschen(d.flowId))) k.zu();
              }}
            >
              {loeschen ? 'Endgültig löschen' : 'Löschen'}
            </button></Recht>
          ) : (
            <button type="button" className="btn sek" onClick={k.zu}>Abbrechen</button>
          )}
          <button type="button" className="btn" disabled={!g} onClick={() => { setSchritt('folgen'); setFokus(null); }}>Weiter: Folgen</button>
        </>
      }
    >
      <div className="satz" aria-label="Regel als Satz">{tokens}</div>
      <p className="leise" style={{ padding: '0 4px', color: 'var(--c-fg)' }}><b>{satz.wenn}: {satz.dann}.</b></p>
      {picker}
      <div className="prev">
        <div className="blk"><h3>Probelauf ab jetzt bis morgen Abend</h3></div>
        {g && (
          <Zeitband
            id="probe"
            t0={0}
            t1={N}
            reihen={k.bild.reihen}
            jetzt={r.jetzt}
            padT={22}
            tage
            label="Probelauf der Regel heute und morgen"
            bands={bands}
            rows={reihe ? [{ g, h: 20, kw: reihe }] : []}
            ticks={ticks}
            namen={false}
          />
        )}
        <div className="prev-sum">
          <div><b>{dauer(pl.treffer)}</b><small>Bedingung erfüllt</small></div>
          <div><b>+{dauer(pl.mehr)}</b><small>{g?.kurz ?? 'Gerät'} läuft</small></div>
          <div><b>+{fKwh(pl.kwh)}</b><small>{kosten} Netz</small></div>
        </div>
        {hinweise}
      </div>
      <details className="fein">
        <summary>
          <Ic n="sliders" s={18} />
          <span>Feinheiten<br /><small>Schaltabstand, Mindestlaufzeit</small></span>
          <Ic n="chevR" s={18} />
        </summary>
        <div className="in">
          <p className="leise">Schaltabstand: Die Box schaltet erst wieder aus, wenn die Bedingung deutlich nicht mehr gilt (beim Preis 0,5 ct/kWh, beim Überschuss 0,3 kW). Das wählt VoltPilot selbst.</p>
          <p className="leise">Die Mindestlaufzeit und die Sperrzeit des Geräts gelten weiter; sie stehen am Gerät unter „Technik“.</p>
        </div>
      </details>
      <div className="warum" style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <Ic n="shield" s={18} />
        <span>Schutzgrenzen, Netzanschluss und Ihre Eingriffe gehen immer vor. Eine Regel äußert einen Wunsch; die Box entscheidet vor Ort.</span>
      </div>
    </Blatt>
  );
}

function Stp({ wert, onMinus, onPlus }: { wert: string; onMinus: () => void; onPlus: () => void }) {
  return (
    <span className="stp">
      <button type="button" aria-label="weniger" onClick={onMinus}><Ic n="minus" s={18} /></button>
      <output>{wert}</output>
      <button type="button" aria-label="mehr" onClick={onPlus}><Ic n="plus" s={18} /></button>
    </span>
  );
}
