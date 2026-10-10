/**
 * Die Blätter der Steuerung (Prototyp `ui-blaetter.js`): Gerät, Speicher,
 * Pause, Vorrang, § 14a, Negativpreis, Anbinden und „Neu einstellen“.
 *
 * Jede Änderung zeigt vorher ihre Folgen und läuft über den bestehenden
 * Schreibweg (Steuerart, Handeingriff, Speicher-Eingriff, Pause,
 * Betriebsmodell). Was die Box vor Ort erzwingt, gilt weiter und steht dabei.
 */
import { liste } from './liste';
import { useMemo, useState, type ReactNode } from 'react';
import { Recht } from '../components/Recht';
import { useRollen } from '../rollen';
import { RUHE_VERBINDUNG_HINWEIS } from '../ruheHinweis';
import type { SiteProfile } from '../profiles';
import { benefitLine } from '../profiles';
import { fehlt, fragen, TAGE_WORT, wunschAus, entwurfAus, type SteuerartEntwurf, type SteuerartWunsch } from '../steuerartDialog';
import type { FlowSummary } from '../flows/flowsApi';
import { parseGuidedFlow } from '../flows/guidedBuilder';
import { Blatt } from './Blatt';
import {
  SPEICHER,
  erwarteteLaeufe,
  quellenAnteil,
  type GeraetBild,
  type Reihen,
} from './bild';
import { Ic } from './Ic';
import type { BlattZustand, SeitenBild } from './seite';
import { Zeitband } from './Zeitband';
import { regelSatzAusFlow } from './regeln';
import { szeneDef, szenenGeraete, szenenWirkung } from './szenen';
import {
  N,
  TAG,
  dauer,
  fCt,
  fEur,
  fKw,
  fKwh,
  fPct,
  spannen,
  spannenText,
  uhrMin,
  uhrVon,
  zahl0,
  zahl1,
} from './zeit';

export interface Aktionen {
  eingriff: (g: GeraetBild, art: 'aus' | 'an' | 'smart', minuten: number | null) => Promise<boolean>;
  speicherEingriff: (art: 'aus' | 'an' | 'smart', minuten: number | null) => Promise<boolean>;
  steuerart: (g: GeraetBild, w: SteuerartWunsch) => Promise<boolean>;
  speicherHilft: (g: GeraetBild, an: boolean) => Promise<void>;
  pause: (minuten: number) => Promise<boolean>;
  /** „Bis ich fortsetze“: „Steuern & Optimieren“ ohne Ende anhalten (UEMS SZ-2 A). */
  anhalten: () => Promise<boolean>;
  fortsetzen: () => Promise<boolean>;
  betriebsmodell: (neu: string | null) => Promise<boolean>;
  nurMessen: (g: GeraetBild) => Promise<void>;
  szeneAn: (id: string, geraete: string[]) => Promise<boolean>;
  oeffne: (b: BlattZustand) => void;
  zuReiter: (sub: 'steuerung' | 'laden' | 'regeln') => void;
  reihenfolgeAendern: (id: string) => void;
  anlage: (g: GeraetBild | null) => void;
  einstellungen: () => void;
}

export interface BlattKontext {
  bild: SeitenBild;
  flows: FlowSummary[] | null;
  profiles: SiteProfile[] | null;
  editorNamen: Record<string, string>;
  busy: string | null;
  a: Aktionen;
  zu: () => void;
}

// ---------------------------------------------------------------------------
// Aus · Smart · Ein
// ---------------------------------------------------------------------------

type Art3 = 'aus' | 'smart' | 'an';

export function dreiWorte(g: GeraetBild | null): [string, string, string] {
  if (!g) return ['Halten', 'Smart', 'Laden'];
  if (g.eintrag.ladepunkt) return ['Aus', 'Smart', 'Schnell'];
  if (g.form === 'freigabe') return ['Normal', 'Smart', 'Anheben'];
  return ['Aus', 'Smart', 'Ein'];
}

const DAUERN: [number, string][] = [[30, '30 Min'], [60, '1 Std'], [120, '2 Std'], [240, '4 Std']];

function DreiSchalter({ g, bild, eingriff, busy, start, onWahl, folge }: {
  g: GeraetBild | null;
  bild: SeitenBild;
  eingriff: { art: 'aus' | 'an'; bisMs: number | null } | null;
  busy: boolean;
  start?: 'aus' | 'an';
  onWahl: (art: Art3, minuten: number | null) => void;
  folge: (art: 'aus' | 'an', minuten: number | null) => string;
}) {
  const [a, b, c] = dreiWorte(g);
  const cur: Art3 = eingriff ? eingriff.art : 'smart';
  // In Ruhe (UEMS R0) gibt es keinen Eingriff - nur „Smart“ beendet einen laufenden.
  const sperre = bild.funktion.sperre;
  const [wahl, setWahl] = useState<Art3>(sperre ? cur : start ?? cur);
  const lp = !!g?.eintrag.ladepunkt;
  const [minuten, setMinuten] = useState<number | null>(lp ? null : 60);
  const knopf = (k: Art3, label: string, icon: string) => (
    <button
      type="button"
      aria-pressed={wahl === k}
      disabled={busy || (sperre != null && k !== 'smart')}
      onClick={() => {
        if (k === 'smart') {
          setWahl('smart');
          if (cur !== 'smart') onWahl('smart', null);
          return;
        }
        setWahl(k);
      }}
    >
      <Ic n={icon} s={20} />
      {label}
    </button>
  );
  const dauern: [number | null, string][] = [...DAUERN];
  if (lp) dauern.push([null, 'bis Abstecken']);
  const bisMs = minuten == null ? null : bild.raster.nowMs + minuten * 60_000;
  const bisText = bisMs == null ? 'zum Abstecken' : uhrVon(bild.raster, bisMs);
  // Die Ruhe sperrt für alle und sagt ihren Grund; die Knöpfe selbst folgen dem Recht (AP-03 IP-12).
  return (
    <>
      <Recht aktion="handeingriff.setzen">
        <div className="lmodes" role="group" aria-label={`${a}, ${b} oder ${c}`} style={{ gridTemplateColumns: 'repeat(3,minmax(0,1fr))' }}>
          {knopf('aus', a, g ? 'pause' : 'lock')}
          {knopf('smart', b, 'sun')}
          {knopf('an', c, !g ? 'down' : lp ? 'rocket' : 'power')}
        </div>
        {wahl !== 'smart' && wahl !== cur && !sperre && (
          <div className="param">
            <div className="blk">
              <h3>Wie lange?</h3>
              <div className="dauer" style={{ gridTemplateColumns: `repeat(${dauern.length},minmax(0,1fr))` }}>
                {dauern.map(([v, l]) => (
                  <button type="button" key={l} aria-pressed={minuten === v} onClick={() => setMinuten(v)}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
            <p className="leise" style={{ color: 'var(--c-fg)' }}>
              <b>Das passiert:</b> {folge(wahl, minuten)} Danach wieder Smart. Schutzgrenzen gelten weiter.
            </p>
            <button type="button" className="btn" disabled={busy} onClick={() => onWahl(wahl, minuten)}>
              <Ic n="check" s={18} />
              {busy ? 'Wird gesendet …' : `${wahl === 'aus' ? a : c} bis ${bisText}`}
            </button>
          </div>
        )}
        {eingriff && wahl === cur && (
          <p className="leise">
            Ihr Eingriff läuft{eingriff.bisMs != null ? ` bis ${uhrVon(bild.raster, eingriff.bisMs)}` : ''}. „{b}“ beendet ihn sofort.
          </p>
        )}
      </Recht>
      {sperre && <p className="leise" role="note">{sperre}</p>}
    </>
  );
}

/** Energie, Netzanteil und Kosten einer Laufzeit - anteilig aus dem Plan. */
function laufFolge(rh: Reihen, von: number, bis: number, kw: number): { kwh: number; netzKwh: number; eur: number } {
  let kwh = 0;
  let netzKwh = 0;
  let eur = 0;
  for (let t = von; t < Math.min(bis, N); t++) {
    const e = kw / 4;
    const a = quellenAnteil(rh, t);
    const netz = e * (a?.netz ?? 0);
    kwh += e;
    netzKwh += netz;
    const p = rh.preis[t];
    if (p != null) eur += (netz * p) / 100;
  }
  return { kwh, netzKwh, eur };
}

// ---------------------------------------------------------------------------
// Gerät
// ---------------------------------------------------------------------------

export function GeraetBlatt({ k, id, modus }: { k: BlattKontext; id: string; modus?: 'aus' | 'an' }) {
  const g = k.bild.geraete.find((x) => x.id === id);
  if (!g) return null;
  return <GeraetBlattInhalt k={k} g={g} modus={modus} />;
}

function GeraetBlattInhalt({ k, g, modus }: { k: BlattKontext; g: GeraetBild; modus?: 'aus' | 'an' }) {
  const { bild, a } = k;
  const r = bild.raster;
  const [entwurf, setEntwurf] = useState<SteuerartEntwurf>(() => entwurfAus(g.eintrag));
  const basis = useMemo(() => entwurfAus(g.eintrag), [g.eintrag]);
  const geaendert = JSON.stringify(entwurf) !== JSON.stringify(basis);
  const lp = !!g.eintrag.ladepunkt;
  const busy = k.busy === g.id;

  const folge = (art: 'aus' | 'an', minuten: number | null): string => {
    const bis = minuten == null ? N : Math.min(N, r.jetzt + Math.ceil(minuten / 15));
    if (art === 'an') {
      const kw = g.nennKw;
      if (kw == null) return `Läuft bis ${minuten == null ? 'zum Abstecken' : uhrVon(r, r.nowMs + minuten * 60_000)}.`;
      const f = laufFolge(bild.reihen, r.jetzt, bis, kw);
      return `Läuft bis ${minuten == null ? 'zum Abstecken' : uhrVon(r, r.nowMs + minuten * 60_000)}: ≈ ${fKwh(f.kwh)}, davon aus dem Netz ≈ ${fKwh(f.netzKwh)}${f.eur > 0.005 ? ` (≈ ${fEur(f.eur)})` : ''}.`;
    }
    let entfaellt = 0;
    for (let t = r.jetzt; t < bis; t++) entfaellt += (g.kw[t] ?? 0) / 4;
    return `Bleibt aus bis ${minuten == null ? 'zum Abstecken' : uhrVon(r, r.nowMs + minuten * 60_000)}${entfaellt > 0.05 ? `; entfallen ≈ ${fKwh(entfaellt)} laut Plan.` : '.'}`;
  };

  // Heute: gemessen bis jetzt.
  let std = 0;
  let kwh = 0;
  const q = { pv: 0, sp: 0, netz: 0 };
  for (let t = 0; t < r.jetzt; t++) {
    const v = g.kw[t];
    if (v == null || v <= 0.02 || g.herkunft[t] !== 'gemessen') continue;
    std += 0.25;
    kwh += v / 4;
    const an = quellenAnteil(bild.reihen, t) ?? { pv: 1, sp: 0, netz: 0 };
    q.pv += (v / 4) * an.pv;
    q.sp += (v / 4) * an.sp;
    q.netz += (v / 4) * an.netz;
  }
  const regeln = regelnFuer(k.flows, g.id, k.editorNamen);
  const platzListe = bild.rang;
  const platz = platzListe.indexOf(g.id);
  const kopf = (
    <>
      <span className="ico"><Ic n={g.symbol} s={22} /></span>
      <h2>
        {g.name}
        <small>{g.typLabel}{g.consumer?.ioChannel ? ` · Ausgang ${g.consumer.ioChannel}` : ''}</small>
      </h2>
    </>
  );
  // Folgen einer geänderten Steuerart.
  let folgeNeu: ReactNode = null;
  if (geaendert) {
    const s = (w: SteuerartWunsch) => ({ ...w, herkunft: 'policy' }) as NonNullable<GeraetBild['steuerart']>;
    const neu = spannen(erwarteteLaeufe(s(wunschAus(entwurf, lp)), { form: g.form, nennKw: g.nennKw, ladepunkt: lp }, bild.reihen, r.jetzt).slice(r.jetzt, TAG), r.jetzt);
    const alt = spannen(erwarteteLaeufe(g.steuerart, { form: g.form, nennKw: g.nennKw, ladepunkt: lp }, bild.reihen, r.jetzt).slice(r.jetzt, TAG), r.jetzt);
    folgeNeu = (
      <div className="ok-note" style={{ background: 'var(--c-bg)', border: '1px solid var(--c-border)', color: 'var(--c-fg)' }}>
        <Ic n="info" s={18} />
        <span>
          <b>Folgen ab jetzt:</b> läuft heute voraussichtlich {neu.length ? spannenText(neu, 3) : 'nicht mehr'} statt {alt.length ? spannenText(alt, 3) : 'gar nicht'}.
        </span>
      </div>
    );
  }
  const grund = fehlt(entwurf, g.eintrag.optionen);
  const fuss = geaendert ? (
    <>
      <button type="button" className="btn sek" onClick={() => setEntwurf(basis)}>Verwerfen</button>
      <Recht aktion="betriebsweise.aendern"><button
        type="button"
        className="btn"
        disabled={busy || grund != null}
        title={grund ?? undefined}
        onClick={async () => {
          const ok = await a.steuerart(g, wunschAus(entwurf, lp));
          if (ok) setEntwurf(entwurfAus({ ...g.eintrag, steuerart: { ...g.eintrag.steuerart, ...wunschAus(entwurf, lp), herkunft: 'policy' } }));
        }}
      >
        <Ic n="check" s={18} />
        {busy ? 'Speichere …' : 'Übernehmen'}
      </button></Recht>
    </>
  ) : null;
  const hilft = g.consumer?.allowStorageDischarge;
  return (
    <Blatt titel={g.name} kopf={kopf} fuss={fuss} voll onClose={k.zu}>
      <DreiSchalter
        g={g}
        bild={bild}
        eingriff={g.eingriff}
        busy={busy}
        start={modus}
        folge={folge}
        onWahl={(art, minuten) => void a.eingriff(g, art, minuten)}
      />
      <div className="blk">
        <h3>
          Jetzt{' '}
          <span className={`pill ${g.pill[0]}`}>
            <i />
            {g.pill[1]}
            {g.an && g.gemessen && g.jetztKw != null ? ` · ${fKw(g.jetztKw)}` : ''}
          </span>
        </h3>
        <div className="warum">{g.warumLang}</div>
        <Kette g={g} bild={bild} />
      </div>
      <div className="blk">
        <h3>
          Heute{' '}
          <span className="meta" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 600 }}>
            {std ? `${dauer(std * 4)} · ${g.gemessen ? fKwh(kwh) : 'nicht gemessen'}` : 'lief nicht'}
          </span>
        </h3>
        <Zeitband
          id={`g-${g.id}`}
          t0={0}
          t1={TAG}
          reihen={bild.reihen}
          jetzt={r.jetzt}
          padT={16}
          label={`Heute: ${g.name}`}
          bands={[{ art: 'pv', h: 18, gap: 4 }, { art: 'preis', h: 20, gap: 6 }]}
          rows={[{ g, h: 20 }]}
          namen={false}
        />
        {kwh > 0.05 && g.gemessen && (
          <p className="leise">
            Davon Sonne {fPct((q.pv / kwh) * 100)}, Speicher {fPct((q.sp / kwh) * 100)}, Netz {fPct((q.netz / kwh) * 100)} (anteilig aus der Bilanz der Anlage).
          </p>
        )}
      </div>
      {lp ? (
        <div className="blk">
          <h3>Smart heißt hier</h3>
          <p>{g.auftrag}. Ladeziel und Quelle stellen Sie im Reiter Laden ein.</p>
          <button type="button" className="btn sek" onClick={() => { k.zu(); a.zuReiter('laden'); }}>
            <Ic n="car" s={18} />
            Zum Reiter Laden
          </button>
        </div>
      ) : (
        <div className="blk">
          <h3>Smart heißt hier</h3>
          {!g.schreibbar ? (
            <p>{g.nichtSchreibbarGrund ?? 'Die Steuerart lässt sich für dieses Gerät hier nicht ändern.'}</p>
          ) : (
            <ArtenWahl g={g} bild={bild} entwurf={entwurf} setEntwurf={setEntwurf} />
          )}
        </div>
      )}
      {!lp && (
        <div className="blk">
          <h3>Bedingungen und Abhängigkeiten</h3>
          <div className="bed">
            {regeln.map((x) => (
              <div className="bed-r" key={x.flowId}>
                <span className="k">auch wenn</span>
                <span>{x.satz}{x.aktiv ? '' : ' (aus)'}</span>
                <button type="button" className="x" aria-label="Regel öffnen" onClick={(e) => { e.currentTarget.focus(); a.oeffne({ art: 'regel', flowId: x.flowId }); }}>
                  <Ic n="chevR" s={17} />
                </button>
              </div>
            ))}
            {!regeln.length && <p className="leise">Keine. Das Gerät folgt nur seinem Smart-Auftrag.</p>}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Recht aktion="betriebsweise.aendern"><button type="button" className="tbtn" onClick={(e) => { e.currentTarget.focus(); a.oeffne({ art: 'regel', geraet: g.id }); }}>
              <Ic n="plus" s={16} />
              Auch wenn …
            </button></Recht>
          </div>
        </div>
      )}
      {!lp && g.consumer && hilft != null && (
        <div className="blk">
          <h3>Speicher</h3>
          <div className="prow">
            <span>
              Speicher darf aushelfen
              <small>{hilft ? 'Fehlt Sonne, deckt der Speicher den Rest.' : 'Fehlt Sonne, kommt der Rest aus dem Netz. Der Speicher bleibt fürs Haus.'}</small>
            </span>
            <Recht aktion="betriebsweise.aendern"><button
              type="button"
              className="sw"
              role="switch"
              aria-checked={hilft}
              aria-label="Speicher darf aushelfen"
              disabled={busy}
              onClick={() => void a.speicherHilft(g, !hilft)}
            /></Recht>
          </div>
        </div>
      )}
      <div className="blk">
        <h3>Reihenfolge</h3>
        <p>
          {platz >= 0
            ? `Platz ${platz + 1} von ${platzListe.length} für Sonnenstrom. Wer weiter oben steht, bekommt zuerst.`
            : 'Läuft nach Zeit, Frist oder Preis und steht deshalb nicht in der Reihenfolge. Pflichten gehen der Reihenfolge vor.'}
        </p>
        {platz >= 0 && platzListe.length > 1 && (
          <Recht aktion="betriebsweise.aendern"><button type="button" className="lnk" onClick={() => { k.zu(); a.reihenfolgeAendern(g.id); }}>
            Reihenfolge ändern <Ic n="chevR" s={16} />
          </button></Recht>
        )}
      </div>
      <details className="fein">
        <summary>
          <Ic n="cpu" s={18} />
          <span>
            Technik
            <br />
            <small>{g.typLabel} · {FORM_WORT[g.form]}</small>
          </span>
          <Ic n="chevR" s={18} />
        </summary>
        <div className="in">
          <p className="leise">{technikSatz(g)}</p>
          <button type="button" className="lnk" onClick={() => { k.zu(); a.anlage(g); }}>
            In der Anlage ansehen <Ic n="chevR" s={16} />
          </button>
        </div>
      </details>
      {folgeNeu}
    </Blatt>
  );
}

const FORM_WORT: Record<GeraetBild['form'], string> = {
  stufenlos: 'stufenlos',
  stufig: 'in Stufen',
  schalten: 'ein/aus',
  freigabe: 'Freigabe-Kontakt',
};

function technikSatz(g: GeraetBild): string {
  const c = g.consumer;
  const teile: string[] = [];
  let form = `Steuerform: ${FORM_WORT[g.form]}`;
  if (g.stufenKw?.length) form += ` (${g.stufenKw.map((x) => zahl1(x).replace(/,0$/, '')).join(' / ')} kW)`;
  else if (g.nennKw != null) form += ` (${fKw(g.nennKw)})`;
  teile.push(`${form}.`);
  teile.push(g.gemessen ? 'Leistung wird gemessen.' : 'Leistung wird nicht gemessen; Energie ist angenommen (Nennleistung × Zeit).');
  if (c?.ioEntityId && c.ioChannel) teile.push(`Geschaltet über Ausgang ${c.ioChannel} eines I/O-Moduls.`);
  if (c?.failsafe) teile.push(`Bei Verbindungsverlust: ${c.failsafe === 'off' ? 'aus' : 'das Gerät regelt selbst'}.`);
  const v = g.eintrag.optionen?.vorgaben;
  if (v?.mindestlaufzeitMinuten) teile.push(`Mindestlaufzeit ${v.mindestlaufzeitMinuten} Min${v.sperrzeitMinuten ? `, Sperrzeit ${v.sperrzeitMinuten} Min` : ''}.`);
  return teile.join(' ');
}

/** Die Kette „vom Wunsch zur Wirkung“ - nur mit Gemeldetem. */
function Kette({ g, bild }: { g: GeraetBild; bild: SeitenBild }) {
  if (!(g.an === true || g.eingriff)) return null;
  const st = g.status;
  const wunsch = g.eingriff
    ? `Ihr Eingriff${g.eingriff.bisMs != null ? ` bis ${uhrVon(bild.raster, g.eingriff.bisMs)}` : ''}`
    : g.regelJetzt
      ? `Regel „${g.regelJetzt}“`
      : `Smart: ${g.auftrag}`;
  const soll = g.form === 'freigabe' ? 'Freigabe setzen' : g.eintrag.ladepunkt ? 'Ladeleistung vorgeben' : g.form === 'stufig' ? 'Stufe wählen' : 'Einschalten';
  const zeit = st?.reportedAt ? uhrVon(bild.raster, Date.parse(st.reportedAt)) : null;
  const begrenzt = st?.state === 'clamped';
  const schritte: [string, string, string, string][] = [
    ['check', 'Wunsch', `${wunsch} → ${soll}`, ''],
    begrenzt
      ? ['alert', 'Box hat begrenzt', `${zeit ?? ''}${zeit ? ' · ' : ''}${g.warum}`, 'warn']
      : ['check', 'Box hat angenommen', `${zeit ?? 'gemeldet'} · keine Schutzgrenze aktiv`, ''],
    st?.confirmed === true || g.eintrag.ladepunkt
      ? ['check', 'Gerät hat bestätigt', g.eintrag.ladepunkt ? 'Ladepunkt meldet: lädt' : 'Rückmeldung passt zum Befehl', '']
      : st?.confirmed === false
        ? ['alert', 'Gerät hat nicht bestätigt', 'Das Gerät hat den Befehl nicht übernommen', 'warn']
        : ['info', 'Gerät', 'keine Rückmeldung über den Schaltzustand', 'leer'],
    g.gemessen && g.jetztKw != null
      ? ['check', 'Wirkung', `${fKw(g.jetztKw)} gemessen`, '']
      : ['info', 'Wirkung', g.form === 'freigabe' ? 'Leistung wird nicht gemessen' : `nicht gemessen${g.nennKw ? ` · angenommen ${fKw(g.nennKw)} (Nennleistung)` : ''}`, 'leer'],
  ];
  return (
    <ol className="kette" aria-label="Vom Wunsch zur Wirkung">
      {schritte.map(([i, b, s, cls]) => (
        <li key={b}>
          <span className={`k-dot ${cls}`}><Ic n={i} s={15} /></span>
          <span><b>{b}</b><span>{s}</span></span>
        </li>
      ))}
    </ol>
  );
}

function regelnFuer(flows: FlowSummary[] | null, id: string, namen: Record<string, string>): { flowId: string; satz: string; aktiv: boolean }[] {
  const out: { flowId: string; satz: string; aktiv: boolean }[] = [];
  for (const f of liste(flows)) {
    const regel = parseGuidedFlow(f.latestDocument);
    if (!regel || regel.action.kind === 'notify' || regel.action.entityId !== id) continue;
    out.push({ flowId: f.flowId, satz: regelSatzAusFlow(regel, namen, true), aktiv: f.activeVersion != null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// „Smart heißt hier“: die Arten und ihre Einstellungen
// ---------------------------------------------------------------------------

interface ArtKarte {
  k: string;
  icon: string;
  t: string;
  s: string;
  gesperrt: boolean;
  grund: string | null;
}

function artenFuer(g: GeraetBild): ArtKarte[] {
  const o = g.eintrag.optionen;
  const text: Record<string, [string, string, string]> = {
    ueberschuss: ['sun', 'Mit Sonnenstrom', 'läuft bei Überschuss'],
    freigabe_ueberschuss: ['sun', 'Anheben bei Sonne', 'SG-Ready-Freigabe bei Überschuss'],
    guenstig: ['euro', 'Günstige Stunden', 'unter einer Preisgrenze'],
    freigabe_guenstig: ['euro', 'Anheben, wenn günstig', 'unter einer Preisgrenze'],
    feste_zeiten: ['clock', 'Feste Zeiten', 'täglich von … bis'],
    sofort: ['power', 'Ohne Steuerung', 'VoltPilot schaltet nicht'],
  };
  const out: ArtKarte[] = [];
  for (const q of liste(o?.quellen)) {
    const t = text[q.id];
    if (!t) continue;
    out.push({ k: q.id, icon: t[0], t: t[1], s: t[2], gesperrt: q.gesperrt, grund: q.grund ?? null });
    if (q.id === 'feste_zeiten' || (q.id === 'guenstig' && !o?.quellen.some((x) => x.id === 'feste_zeiten'))) {
      const frist = liste(o?.ziele).find((z) => z.id === 'laufzeit_bis');
      if (frist) out.push({ k: 'frist', icon: 'flag', t: 'Fertig bis', s: 'Laufzeit bis zu einer Uhrzeit', gesperrt: frist.gesperrt, grund: frist.grund ?? null });
    }
  }
  // „Ohne Steuerung“ steht immer hinten.
  out.sort((a, b) => (a.k === 'sofort' ? 1 : 0) - (b.k === 'sofort' ? 1 : 0));
  return out;
}

function Stepper({ wert, minus, plus, onMinus, onPlus }: { wert: string; minus: string; plus: string; onMinus: () => void; onPlus: () => void }) {
  return (
    <span className="stp">
      <button type="button" aria-label={minus} onClick={onMinus}><Ic n="minus" s={18} /></button>
      <output>{wert}</output>
      <button type="button" aria-label={plus} onClick={onPlus}><Ic n="plus" s={18} /></button>
    </span>
  );
}

const hhmm = (min: number) => uhrMin(((min % 1440) + 1440) % 1440);
const minAus = (t: string, fallback: number) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
};

export function ArtenWahl({ g, bild, entwurf, setEntwurf }: {
  g: GeraetBild; bild: SeitenBild; entwurf: SteuerartEntwurf; setEntwurf: (e: SteuerartEntwurf) => void;
}) {
  const arten = artenFuer(g);
  const aktiv = entwurf.ziel === 'laufzeit_bis' ? 'frist' : entwurf.quelle;
  const waehle = (k: string) => {
    if (k === 'frist') {
      const quelle = ['ueberschuss', 'guenstig'].includes(entwurf.quelle) ? entwurf.quelle
        : arten.find((x) => (x.k === 'ueberschuss' || x.k === 'guenstig') && !x.gesperrt)?.k ?? 'ueberschuss';
      setEntwurf({ ...entwurf, quelle, ziel: 'laufzeit_bis' });
    } else setEntwurf({ ...entwurf, quelle: k, ziel: '' });
  };
  const set = (p: Partial<SteuerartEntwurf>) => setEntwurf({ ...entwurf, ...p });
  let panel: ReactNode = null;
  const r = bild.raster;
  if (aktiv === 'ueberschuss' || aktiv === 'freigabe_ueberschuss') {
    const ab = entwurf.schwelleKw;
    const sub = g.form === 'stufig' && g.stufenKw?.length
      ? `Nutzt ${g.stufenKw.map((x) => zahl0(x)).join(', ')} kW, je nach Überschuss.`
      : g.form === 'freigabe'
        ? `Die Freigabe bleibt mindestens ${entwurf.mindestlaufzeitMinuten ?? 30} Min; danach ${entwurf.sperrzeitMinuten ?? 20} Min Sperrzeit.`
        : 'Darunter bleibt das Gerät aus.';
    panel = (
      <div className="param">
        <div className="prow">
          <span>Startet ab Überschuss<small>{sub}</small></span>
          <Stepper
            wert={ab != null ? fKw(ab) : '—'}
            minus="weniger"
            plus="mehr"
            onMinus={() => set({ schwelleKw: Math.max(0.5, (ab ?? 1) - 0.5) })}
            onPlus={() => set({ schwelleKw: Math.min(30, (ab ?? 0.5) + 0.5) })}
          />
        </div>
      </div>
    );
  } else if (aktiv === 'guenstig' || aktiv === 'freigabe_guenstig') {
    const grenze = entwurf.preisgrenzeCtKwh;
    let n = 0;
    if (grenze != null) for (let t = r.jetzt; t < TAG; t++) { const p = bild.reihen.preis[t]; if (p != null && p < grenze) n++; }
    panel = (
      <div className="param">
        <div className="prow">
          <span>Preisgrenze<small>{grenze != null ? `heute ab jetzt ${dauer(n)} darunter` : 'Börsenpreis, unter dem das Gerät läuft'}</small></span>
          <Stepper
            wert={grenze != null ? fCt(grenze) : '—'}
            minus="niedriger"
            plus="höher"
            onMinus={() => set({ preisgrenzeCtKwh: Math.max(-5, (grenze ?? 10.5) - 0.5) })}
            onPlus={() => set({ preisgrenzeCtKwh: Math.min(60, (grenze ?? 9.5) + 0.5) })}
          />
        </div>
      </div>
    );
  } else if (aktiv === 'feste_zeiten') {
    const von = minAus(entwurf.fensterVon, 11 * 60);
    const bis = minAus(entwurf.fensterBis, 15 * 60);
    panel = (
      <div className="param">
        <div className="prow">
          <span>von</span>
          <Stepper wert={entwurf.fensterVon || '—'} minus="früher" plus="später" onMinus={() => set({ fensterVon: hhmm(von - 30) })} onPlus={() => set({ fensterVon: hhmm(von + 30) })} />
        </div>
        <div className="prow">
          <span>bis</span>
          <Stepper wert={entwurf.fensterBis || '—'} minus="früher" plus="später" onMinus={() => set({ fensterBis: hhmm(bis - 30) })} onPlus={() => set({ fensterBis: hhmm(bis + 30) })} />
        </div>
        <div className="chips">
          {Object.entries(TAGE_WORT).map(([key, l]) => (
            <button type="button" key={key} aria-pressed={(entwurf.fensterTage || 'daily') === key} onClick={() => set({ fensterTage: key })}>{l}</button>
          ))}
        </div>
      </div>
    );
  } else if (aktiv === 'frist') {
    const lauf = entwurf.zielLaufzeitMinuten;
    const bisMin = minAus(entwurf.zielUhrzeit, 17 * 60);
    panel = (
      <div className="param">
        <div className="prow">
          <span>Laufzeit</span>
          <Stepper
            wert={lauf != null ? dauer(lauf / 15) : '—'}
            minus="kürzer"
            plus="länger"
            onMinus={() => set({ zielLaufzeitMinuten: Math.max(30, (lauf ?? 60) - 30) })}
            onPlus={() => set({ zielLaufzeitMinuten: Math.min(24 * 60, (lauf ?? 0) + 30) })}
          />
        </div>
        <div className="prow">
          <span>fertig bis</span>
          <Stepper wert={entwurf.zielUhrzeit || '—'} minus="früher" plus="später" onMinus={() => set({ zielUhrzeit: hhmm(bisMin - 30) })} onPlus={() => set({ zielUhrzeit: hhmm(bisMin + 30) })} />
        </div>
        <div className="chips">
          {arten.some((x) => x.k === 'ueberschuss' && !x.gesperrt) && (
            <button type="button" aria-pressed={entwurf.quelle === 'ueberschuss'} onClick={() => set({ quelle: 'ueberschuss' })}>Sonne zuerst, dann günstig</button>
          )}
          {arten.some((x) => x.k === 'guenstig' && !x.gesperrt) && (
            <button type="button" aria-pressed={entwurf.quelle === 'guenstig'} onClick={() => set({ quelle: 'guenstig' })}>nur günstig</button>
          )}
        </div>
        <div className="prow">
          <span>Am Stück<small>zum Beispiel ein Programm, das nicht unterbrochen werden darf</small></span>
          <button type="button" className="sw" role="switch" aria-checked={entwurf.zielAmStueck} aria-label="Am Stück" onClick={() => set({ zielAmStueck: !entwurf.zielAmStueck })} />
        </div>
      </div>
    );
  } else if (aktiv === 'sofort') {
    panel = <p className="leise">{g.form === 'freigabe' ? 'Die Wärmepumpe läuft nach ihrem eigenen Regler; VoltPilot hebt nicht an.' : 'Das Gerät läuft, wie es selbst will. VoltPilot misst nur.'}</p>;
  }
  const grund = entwurf.quelle ? fehlt(entwurf, g.eintrag.optionen) : null;
  return (
    <>
      <div className="arten" role="group" aria-label="Womit läuft das Gerät?">
        {arten.map((x) => (
          <button type="button" key={x.k} className="art" aria-pressed={aktiv === x.k} disabled={x.gesperrt} onClick={() => waehle(x.k)} title={x.grund ?? undefined}>
            <Ic n={x.icon} s={20} />
            <b>{x.t}</b>
            <small>{x.s}</small>
            {x.gesperrt && x.grund && <span className="gesp">{x.grund}</span>}
          </button>
        ))}
      </div>
      {panel}
      {grund && <p className="leise" style={{ color: 'var(--st-wait)' }}>{grund}</p>}
      {fragen(entwurf.quelle).includes('mindestlaufzeit') && entwurf.mindestlaufzeitMinuten != null && g.form !== 'freigabe' && (
        <p className="leise">Mindestlaufzeit {entwurf.mindestlaufzeitMinuten} Min, damit das Gerät nicht taktet.</p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Neu verbunden: Auftrag wählen
// ---------------------------------------------------------------------------

export function NeuBlatt({ k, id }: { k: BlattKontext; id: string }) {
  const g = k.bild.geraete.find((x) => x.id === id);
  const [entwurf, setEntwurf] = useState<SteuerartEntwurf | null>(() => (g ? entwurfAus({ ...g.eintrag, steuerart: { quelle: '', herkunft: 'ohne' } }) : null));
  if (!g || !entwurf) return null;
  const lp = !!g.eintrag.ladepunkt;
  const r = k.bild.raster;
  const grund = fehlt(entwurf, g.eintrag.optionen);
  let folge = '';
  if (!grund) {
    const s = { ...wunschAus(entwurf, lp), herkunft: 'policy' } as NonNullable<GeraetBild['steuerart']>;
    const bits = erwarteteLaeufe(s, { form: g.form, nennKw: g.nennKw, ladepunkt: lp }, k.bild.reihen, r.jetzt + 1);
    const sp = spannen(bits.slice(r.jetzt + 1), r.jetzt + 1);
    const n = bits.filter(Boolean).length;
    folge = sp.length
      ? `läuft voraussichtlich ${spannenText(sp, 3)}${g.nennKw ? `, ≈ ${fKwh((n * g.nennKw) / 4)}` : ''}.`
      : 'bis morgen Abend voraussichtlich kein Lauf.';
  }
  const busy = k.busy === g.id;
  return (
    <Blatt
      symbol={g.symbol}
      titel={`${g.name} steuern`}
      unter={`in der Anlage angelegt als ${g.typLabel}`}
      voll
      onClose={k.zu}
      fuss={
        <Recht aktion="betriebsweise.aendern">
          <button type="button" className="btn sek" disabled={busy} onClick={async () => { await k.a.nurMessen(g); k.zu(); }}>Nur messen</button>
          <button
            type="button"
            className="btn"
            disabled={busy || grund != null}
            onClick={async () => {
              if (await k.a.steuerart(g, wunschAus(entwurf, lp))) k.zu();
            }}
          >
            <Ic n="check" s={18} />
            {busy ? 'Speichere …' : 'Steuern beginnen'}
          </button>
        </Recht>
      }
    >
      <div className="warum">Angelegt und verbunden ist {g.name} in der Anlage. Hier entscheiden Sie nur, was das Gerät tut.</div>
      <div className="blk">
        <h3>Smart heißt hier</h3>
        <ArtenWahl g={g} bild={k.bild} entwurf={entwurf} setEntwurf={setEntwurf} />
      </div>
      {folge && (
        <div className="ok-note" style={{ background: 'var(--c-bg)', border: '1px solid var(--c-border)', color: 'var(--c-fg)' }}>
          <Ic n="info" s={18} />
          <span>
            <b>Folgen:</b> {folge} Danach steht es in der Liste und hat {dreiWorte(g).join(' · ')}.
          </span>
        </div>
      )}
    </Blatt>
  );
}

// ---------------------------------------------------------------------------
// Speicher und Betriebsmodell
// ---------------------------------------------------------------------------

export function SpeicherBlatt({ k }: { k: BlattKontext }) {
  const { bild, a } = k;
  const sp = bild.speicher;
  const gruppe = liste(k.profiles).filter((p) => p.exklusivGruppe === 'speicher');
  const laufend = gruppe.find((p) => p.active)?.id ?? null;
  const [wahl, setWahl] = useState<string | null>(laufend);
  if (!sp) return null;
  const r = bild.raster;
  const eingriff = speicherEingriff(bild);
  const busy = k.busy === SPEICHER;
  const geaendert = wahl !== laufend;
  const modelle: { id: string | null; t: string; s: string; ok: boolean; grund: string | null }[] = [
    { id: null, t: 'Eigenverbrauch', s: 'Möglichst viel eigener Strom im Haus. Grundform, ohne Betriebsmodell.', ok: true, grund: null },
    ...gruppe.map((p) => {
      const fehlend = liste(p.requirements).filter((x) => !x.met).map((x) => x.label);
      const ok = !fehlend.length && !p.blockedReason;
      return {
        id: p.id,
        t: p.label,
        s: ok ? benefitLine(p) : p.blockedReason ?? `Nicht möglich: ${fehlend.join(' und ')} fehlt.`,
        ok,
        grund: ok ? null : p.blockedReason ?? null,
      };
    }),
  ];
  const folge = (art: 'aus' | 'an', minuten: number | null) => {
    const bis = minuten == null ? 'später' : uhrVon(r, r.nowMs + minuten * 60_000);
    return art === 'an' ? `Der Speicher lädt aus dem Netz bis ${bis}.` : `Der Speicher hält seinen Ladestand bis ${bis}.`;
  };
  return (
    <Blatt
      symbol="battery"
      titel={sp.name}
      unter={[sp.kwh != null ? fKwh(sp.kwh) : null, sp.kw != null ? fKw(sp.kw) : null].filter(Boolean).join(' · ') || null}
      voll
      onClose={k.zu}
      fuss={
        geaendert ? (
          <>
            <button type="button" className="btn sek" onClick={() => setWahl(laufend)}>Verwerfen</button>
            <Recht aktion="betriebsweise.aendern"><button type="button" className="btn" disabled={busy} onClick={async () => { if (await a.betriebsmodell(wahl)) k.zu(); }}>
              <Ic n="check" s={18} />
              {busy ? 'Wechsle …' : 'Übernehmen'}
            </button></Recht>
          </>
        ) : null
      }
    >
      <DreiSchalter g={null} bild={bild} eingriff={eingriff} busy={busy} folge={folge} onWahl={(art, minuten) => void a.speicherEingriff(art, minuten)} />
      <div className="blk">
        <h3>Jetzt <span className={`pill ${sp.pill[0]}`}><i />{sp.pill[1]}</span></h3>
        <div className="warum">{sp.warum}{bild.rang.includes(SPEICHER) ? `. Er steht in der Reihenfolge auf Platz ${bild.rang.indexOf(SPEICHER) + 1}.` : ''}</div>
      </div>
      <div className="blk">
        <h3>Heute</h3>
        <Zeitband id="soc" t0={0} t1={TAG} reihen={bild.reihen} jetzt={r.jetzt} padT={16} label="Ladestand heute" bands={[{ art: 'pv', h: 18, gap: 4 }, { art: 'soc', h: 30, gap: 6 }]} namen={false} />
      </div>
      <div className="blk">
        <h3>Betriebsmodell</h3>
        <div className="arten" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
          {modelle.map((m) => (
            <button type="button" key={m.id ?? 'grund'} className="art" aria-pressed={wahl === m.id} disabled={!m.ok && laufend !== m.id} style={{ minHeight: 0 }} onClick={() => setWahl(m.id)}>
              <b>{m.t}</b>
              <small>{m.s}</small>
            </button>
          ))}
        </div>
        {geaendert && (
          <div className="ok-note" style={{ background: 'var(--c-bg)', border: '1px solid var(--c-border)', color: 'var(--c-fg)' }}>
            <Ic n="info" s={18} />
            <span><b>Folgen:</b> {wahl ? `„${modelle.find((m) => m.id === wahl)?.t}“ übernimmt den Speicher` : 'Der Speicher fährt Eigenverbrauch ohne Betriebsmodell'}; {laufend ? `„${modelle.find((m) => m.id === laufend)?.t}“ endet` : 'es läuft bisher keines'}. Der Wechsel gilt ab dem nächsten Fahrplan.</span>
          </div>
        )}
      </div>
      {sp.reservePct != null && (
        <div className="blk">
          <h3>Reserve</h3>
          <p>Unter {fPct(sp.reservePct)} gibt der Speicher nichts ab. Die Reserve stellen Sie in den Einstellungen der Anlage ein.</p>
          <button type="button" className="lnk" onClick={() => { k.zu(); a.einstellungen(); }}>Zu den Einstellungen <Ic n="chevR" s={16} /></button>
        </div>
      )}
      {bild.rang.includes(SPEICHER) && (
        <div className="blk">
          <h3>Reihenfolge</h3>
          <p>Platz {bild.rang.indexOf(SPEICHER) + 1} für Sonnenstrom.</p>
          {bild.rang.length > 1 && (
            <Recht aktion="betriebsweise.aendern"><button type="button" className="lnk" onClick={() => { k.zu(); a.reihenfolgeAendern(SPEICHER); }}>Reihenfolge ändern <Ic n="chevR" s={16} /></button></Recht>
          )}
        </div>
      )}
    </Blatt>
  );
}

export function speicherEingriff(bild: SeitenBild): { art: 'aus' | 'an'; bisMs: number | null } | null {
  return bild.speicherEingriff ?? null;
}

// ---------------------------------------------------------------------------
// Kleine Blätter
// ---------------------------------------------------------------------------

/**
 * „Steuerung anhalten“ (UEMS SZ-2 A, Captain 04.10.2026): EIN Blatt für „VoltPilot
 * soll aufhören“. Die Dauern sind die befristete Pause (`/automation-pause`, Recht
 * `handeingriff.setzen`); „Bis ich fortsetze“ hält „Steuern & Optimieren“ ohne Ende
 * an (`PUT …/funktionen/steuern`, Recht `steuerung.anhalten_fortsetzen`) und steht nur
 * da, wo der Server „anhalten“ anbietet - ohne Recht nicht wählbar, mit Grund.
 * Antippen wählt nur; erst „Anhalten“ schreibt.
 */
export function PauseBlatt({ k }: { k: BlattKontext }) {
  const f = k.bild.funktion;
  const rollen = useRollen();
  const darfOffen = rollen.darf('steuerung.anhalten_fortsetzen', f.standortId);
  const [wahl, setWahl] = useState<number | 'offen' | null>(null);
  const busy = k.busy === 'pause';
  const fuss = (
    <>
      <button type="button" className="btn sek" onClick={k.zu}>Abbrechen</button>
      <button
        type="button"
        className="btn"
        disabled={wahl == null || busy}
        onClick={async () => {
          if (wahl == null) return;
          if (await (wahl === 'offen' ? k.a.anhalten() : k.a.pause(wahl))) k.zu();
        }}
      >
        <Ic n="pause" s={18} />
        {busy ? 'Halte an …' : 'Anhalten'}
      </button>
    </>
  );
  return (
    <Blatt symbol="pause" titel="Steuerung anhalten" unter="für die ganze Anlage" fuss={fuss} onClose={k.zu}>
      <p className="leise" style={{ color: 'var(--c-fg)' }}>
        Während der Pause schaltet VoltPilot nichts. Die Geräte fallen in ihren sicheren Zustand; Schutzgrenzen gelten weiter.
      </p>
      <Recht aktion="handeingriff.setzen"><div className="dauer" role="group" aria-label="Wie lange?">
        {DAUERN.map(([v, l]) => (
          <button type="button" key={v} aria-pressed={wahl === v} disabled={busy} onClick={() => setWahl(v)}>{l}</button>
        ))}
      </div></Recht>
      {f.anhaltenMoeglich && (
        <>
          <div className="oder">oder</div>
          <button type="button" className="bif" aria-pressed={wahl === 'offen'} disabled={busy || !darfOffen} onClick={() => setWahl('offen')}>
            <span className="rad" />
            <span>
              <b>Bis ich fortsetze</b>
              <small>VoltPilot sendet ab sofort keine Sollwerte; die Anlage bleibt ohne Enddatum angehalten, bis jemand fortsetzt. Die Geräte fallen in ihren sicheren Zustand.</small>
            </span>
          </button>
          {!darfOffen && <p className="leise vp-recht-hinweis" role="note">{rollen.grund}</p>}
          {wahl === 'offen' && f.ruheHinweisBeimAnhalten && <p className="leise" role="note">{RUHE_VERBINDUNG_HINWEIS}</p>}
        </>
      )}
    </Blatt>
  );
}

/** „Steuerung fortsetzen“ (UEMS SZ-2 A): aus dem Band, mit Folgen und Bestätigung. */
export function FortsetzenBlatt({ k }: { k: BlattKontext }) {
  const f = k.bild.funktion;
  const busy = k.busy === 'fortsetzen';
  const fuss = (
    <>
      <button type="button" className="btn sek" onClick={k.zu}>Abbrechen</button>
      <Recht standort={f.standortId} aktion="steuerung.anhalten_fortsetzen">
        <button type="button" className="btn" disabled={busy} onClick={async () => { if (await k.a.fortsetzen()) k.zu(); }}>
          <Ic n="play" s={18} />
          {busy ? 'Setze fort …' : 'Fortsetzen'}
        </button>
      </Recht>
    </>
  );
  return (
    <Blatt symbol="play" titel="Steuerung fortsetzen" unter="für die ganze Anlage" fuss={fuss} onClose={k.zu}>
      {f.satz && <div className="warum">{f.satz}.</div>}
      <p className="leise" style={{ color: 'var(--c-fg)' }}>
        VoltPilot prüft Box, Freigaben, Grenze, Hauptzähler und Betriebsweise erneut. Nur mit grüner Prüfliste beginnt die Steuerung mit dem nächsten Fahrplan.
      </p>
    </Blatt>
  );
}

export function VorrangBlatt({ k }: { k: BlattKontext }) {
  const stufen: [string, string, string, string][] = [
    ['shield', 'Schutz und Pflichten des Netzes', 'Netzanschluss, § 14a, Geräteschutz (Mindestlaufzeit, Pause), Gerätegrenzen. Setzt die Box vor Ort durch, auch ohne Cloud.', '#b91c1c'],
    ['power', 'Ihr Eingriff', 'Aus oder Ein am Gerät, immer mit Ende: danach wieder Smart.', '#6d28d9'],
    ['zap', 'Ihre Regeln', 'Wenn … dann … Ausnahmen vom Smart-Auftrag.', '#8b5cf6'],
    ['flag', 'Fristen und feste Zeiten', 'Was bis zu einer Uhrzeit fertig sein muss, läuft auch mit Netzstrom.', '#0e7490'],
    ['list', 'Reihenfolge für Sonnenstrom', 'Wer oben steht, bekommt den Überschuss zuerst. Reicht es nicht, darf ein kleineres Gerät weiter unten vor.', '#e65100'],
  ];
  return (
    <Blatt symbol="shield" titel="Wer gewinnt?" unter="Vorrang in der Steuerung" onClose={k.zu}>
      <p className="leise" style={{ color: 'var(--c-fg)' }}>Wenn zwei Dinge sich widersprechen, gewinnt das obere. So steht es auch in jedem „Warum?“ am Gerät.</p>
      <ol className="kette">
        {stufen.map(([i, t, s, c], n) => (
          <li key={t}>
            <span className="k-dot" style={{ background: c, color: '#fff' }}><Ic n={i} s={15} /></span>
            <span><b>{n + 1}. {t}</b><span>{s}</span></span>
          </li>
        ))}
      </ol>
      <div className="warum">Beispiel: Eine Regel schaltet den Heizstab bei günstigem Preis ein. Meldet sein Thermostat „warm genug“, schaltet er ab - der Geräteschutz gewinnt.</div>
    </Blatt>
  );
}

export function P14aBlatt({ k }: { k: BlattKontext }) {
  return (
    <Blatt symbol="pole" titel="§ 14a EnWG" unter="Steuerbare Verbrauchseinrichtungen" onClose={k.zu}>
      <div className="warum">Dimmt Ihr Netzbetreiber, gilt seine Grenze für Wallboxen, Wärmepumpe und Speicher zusammen (mindestens 4,2 kW bleiben).</div>
      <p className="leise">VoltPilot kürzt dann nach Ihrer Reihenfolge von unten. Die Box setzt die Grenze vor Ort durch, auch ohne Cloud.</p>
    </Blatt>
  );
}

export function NegativBlatt({ k }: { k: BlattKontext }) {
  return (
    <Blatt symbol="down" titel="Negativpreis-Abregelung" unter="läuft immer mit" onClose={k.zu}>
      <div className="warum">Kostet Strom an der Börse unter null, speist die Anlage nicht ein. Das schützt vor Kosten.</div>
      <p className="leise">Besser als abregeln: den Strom selbst nutzen. Eine Regel schaltet dann Heizstab oder Pumpe ein.</p>
      <Recht aktion="betriebsweise.aendern"><button type="button" className="btn sek" onClick={(e) => { e.currentTarget.focus(); k.a.oeffne({ art: 'regel', vorlage: 'negativ' }); }}>
        <Ic n="plus" s={18} />
        Regel aus Vorlage
      </button></Recht>
    </Blatt>
  );
}

export function AnbindenBlatt({ k }: { k: BlattKontext }) {
  const schritte: [string, string, string][] = [
    ['layers', 'In der Anlage anlegen und verbinden', 'Anlage › Aufbau › Komponente anlegen. Dort sagen Sie, was es ist (Waschmaschine, Poolpumpe, Wallbox …) und wie es angebunden ist.'],
    ['shield', 'Schalten freigeben', 'Je nach Gerät von selbst (freigegebenes Modell) oder mit einem kurzen Schalttest (eigenes Schaltgerät).'],
    ['zap', 'Hier erscheint es von selbst', 'Oben als „Neu in Ihrer Anlage“ mit einem Vorschlag. Sie übernehmen ihn, stellen ihn anders ein oder lassen das Gerät nur messen.'],
  ];
  return (
    <Blatt
      symbol="plus"
      titel="Ein Gerät kommt in die Steuerung"
      unter="angelegt und verbunden wird in der Anlage"
      onClose={k.zu}
      fuss={
        <button type="button" className="btn" onClick={() => { k.zu(); k.a.anlage(null); }}>
          <Ic n="arrowR" s={18} />
          Zu Anlage › Aufbau
        </button>
      }
    >
      <ol className="kette">
        {schritte.map(([i, t, x]) => (
          <li key={t}>
            <span className="k-dot" style={{ background: 'var(--price-soft)', color: '#1d4ed8' }}><Ic n={i} s={15} /></span>
            <span><b>{t}</b><span>{x}</span></span>
          </li>
        ))}
      </ol>
      <div className="warum">Die Steuerung legt keine Geräte an. So gibt es jedes Gerät nur einmal, und was angeschlossen ist, steht an einem Ort. Die Steuerung entscheidet nur, was es tut.</div>
    </Blatt>
  );
}

// ---------------------------------------------------------------------------
// Szene: ein Tipp, mehrere Geräte (E6)
// ---------------------------------------------------------------------------

export function SzeneBlatt({ k, id }: { k: BlattKontext; id: string }) {
  const def = szeneDef(id);
  const zeilen = useMemo(() => (def ? szenenGeraete(def, k.bild.geraete) : []), [def, k.bild.geraete]);
  const [wahl, setWahl] = useState<Set<string>>(() => new Set(zeilen.filter((z) => z.vorgeschlagen).map((z) => z.g.id)));
  if (!def) return null;
  const r = k.bild.raster;
  const busy = k.busy === 'szene';
  /** Was bis morgen Abend wegfällt: Plan und Erwartung des Geräts ab jetzt. */
  const weg = (g: GeraetBild) => {
    let kwh = 0;
    for (let t = r.jetzt + 1; t < g.kw.length; t++) kwh += (g.kw[t] ?? 0) / 4;
    return kwh;
  };
  const schalte = (gid: string) => setWahl((w) => {
    const n = new Set(w);
    if (n.has(gid)) n.delete(gid);
    else n.add(gid);
    return n;
  });
  const andere = k.bild.szene && k.bild.szene.def.id !== def.id ? k.bild.szene.def.name : null;
  return (
    <Blatt
      symbol={def.icon}
      titel={`Szene ${def.name}`}
      unter={def.kurz}
      onClose={k.zu}
      fuss={
        <>
          <button type="button" className="btn sek" onClick={k.zu}>Abbrechen</button>
          <Recht aktion="betriebsweise.aendern"><button
            type="button"
            className="btn"
            disabled={busy || wahl.size === 0}
            onClick={async () => {
              if (await k.a.szeneAn(def.id, zeilen.filter((z) => wahl.has(z.g.id)).map((z) => z.g.id))) k.zu();
            }}
          >
            <Ic n="check" s={18} />
            {busy ? 'Schalte …' : 'Szene einschalten'}
          </button></Recht>
        </>
      }
    >
      <div className="blk">
        <h3>Das passiert</h3>
        {zeilen.length ? (
          <div className="bed">
            {zeilen.map(({ g }) => {
              const an = wahl.has(g.id);
              const kwh = weg(g);
              return (
                <div className="bed-r" key={g.id}>
                  <span className="k" style={{ background: 'var(--c-muted)', color: 'var(--navy)' }}><Ic n={g.symbol} s={15} /></span>
                  <span>
                    {g.name}: <b>{an ? szenenWirkung(g) : 'bleibt wie es ist'}</b>
                    {an && kwh > 0.05 && g.consumer?.controlActivation !== 'paused' && <span className="leise"> (−{fKwh(kwh)} bis morgen)</span>}
                  </span>
                  <button type="button" className="sw" role="switch" aria-checked={an} aria-label={`${g.name} in der Szene`} onClick={() => schalte(g.id)} />
                </div>
              );
            })}
          </div>
        ) : (
          <p className="leise">Keines Ihrer Geräte hat einen eigenen Auftrag. Eine Szene pausiert nur gesteuerte Geräte.</p>
        )}
      </div>
      <div className="blk">
        <h3>Wie lange?</h3>
        <div className="chips">
          <button type="button" aria-pressed="true">bis ich sie beende</button>
          <button type="button" disabled title="Ende als Datum kommt noch">bis Datum … (kommt noch)</button>
        </div>
      </div>
      <div className="warum">
        {andere ? `Die Szene „${andere}“ endet dabei. ` : ''}
        Alles andere bleibt. Pausiert heißt: VoltPilot schaltet das Gerät nicht, es gilt sein sicherer Zustand. Beenden wirkt sofort und fragt nicht nach.
      </div>
    </Blatt>
  );
}
