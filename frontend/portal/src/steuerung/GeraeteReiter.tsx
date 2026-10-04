/**
 * Reiter „Geräte“: Jetzt · Neu in Ihrer Anlage · Tagesbild · die Geräte als
 * Reihenfolge · Was immer gilt (Prototyp `ui-geraete.js`).
 */
import { forwardRef, useEffect, useRef, useState, type PointerEvent as RPointerEvent, type KeyboardEvent } from 'react';
import type { SteuerartWunsch } from '../steuerartDialog';
import { haptik } from '../haptik';
import {
  SPEICHER,
  auftragSatz,
  erwarteteLaeufe,
  kopfsatz,
  leiste,
  momentZeile,
  naechsterWechsel,
  unterzeile,
  type GeraetBild,
} from './bild';
import { Ic } from './Ic';
import { vorschlag } from './neu';
import type { BlattZustand, SeitenBild } from './seite';
import { useBreite, zeitband } from './Zeitband';
import {
  TAG,
  fKw,
  fKwh,
  fPct,
  inZeit,
  spannen,
  spannenText,
  uhr,
  uhrMin,
  uhrTag,
  uhrVon,
} from './zeit';

export interface GeraeteReiterProps {
  bild: SeitenBild;
  oeffne: (b: BlattZustand) => void;
  /** Neu in der Anlage: den Vorschlag übernehmen. */
  onUebernehmen: (g: GeraetBild) => void;
  onNurMessen: (g: GeraetBild) => void;
  onReihenfolge: (ids: string[]) => Promise<void>;
  onAnlage: (g: GeraetBild | null) => void;
  netzanschlussKw: number | null;
  busy: string | null;
  /** Von außen gewünscht: die Reihenfolge ändern (aus einem Blatt). */
  reoStart: string | null;
  onReoGestartet: () => void;
}

export function GeraeteReiter(p: GeraeteReiterProps) {
  const { bild } = p;
  const [sel, setSel] = useState<number | null>(null);
  const [tag, setTag] = useState(0);
  const [reo, setReo] = useState<string[] | null>(null);
  const listeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (p.reoStart == null) return;
    setReo([...bild.rang]);
    p.onReoGestartet();
    requestAnimationFrame(() => {
      const el = document.getElementById(`reo-${p.reoStart}`) ?? listeRef.current;
      el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }, [p.reoStart]); // eslint-disable-line react-hooks/exhaustive-deps

  const t = sel ?? bild.raster.jetzt;
  return (
    <>
      <JetztKarte bild={bild} t={t} sel={sel} onJetzt={() => { setSel(null); setTag(0); }} oeffne={p.oeffne} />
      {bild.einordnung.neu.map((g) => (
        <NeuKarte key={g.id} g={g} bild={bild} busy={p.busy === g.id} oeffne={p.oeffne} onUebernehmen={p.onUebernehmen} onNurMessen={p.onNurMessen} />
      ))}
      <Tagesbild bild={bild} tag={tag} setTag={(x) => { setTag(x); setSel(x === 1 ? TAG + bild.raster.jetzt : null); }} sel={sel} setSel={setSel} oeffne={p.oeffne} />
      <Liste
        ref={listeRef}
        bild={bild}
        reo={reo}
        setReo={setReo}
        oeffne={p.oeffne}
        onReihenfolge={p.onReihenfolge}
        onAnlage={p.onAnlage}
        busy={p.busy === 'reihenfolge'}
      />
      <ImmerKarte bild={bild} oeffne={p.oeffne} netzanschlussKw={p.netzanschlussKw} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Jetzt
// ---------------------------------------------------------------------------

function JetztKarte({ bild, t, sel, onJetzt, oeffne }: {
  bild: SeitenBild; t: number; sel: number | null; onJetzt: () => void; oeffne: (b: BlattZustand) => void;
}) {
  const r = bild.raster;
  const rh = bild.reihen;
  let eye: string;
  if (t === r.jetzt) eye = `Jetzt · ${uhrMin(r.jetztMin)}`;
  else if (t < r.jetzt) eye = `Gemessen · ${uhrTag(t)}–${uhr(t + 1)}`;
  else eye = `Laut Plan · ${uhrTag(t)} · ${inZeit(r, t)}`;
  const satz = kopfsatz(rh, t, bild.geraete, r.jetzt);
  const zusatz: [string, string][] = [];
  const preis = rh.preis[t];
  if (preis != null && preis < 0) {
    zusatz.push(['down', `Strom kostet an der Börse gerade unter null${(rh.abgeregelt[t] ?? 0) > 0.1 ? '; statt einzuspeisen wird abgeregelt.' : '.'}`]);
  }
  if (t === r.jetzt) {
    for (const g of bild.geraete) {
      if (g.regelJetzt) zusatz.push(['zap', `Regel „${g.regelJetzt}“ schaltet ${g.kurz}.`]);
    }
    for (const g of bild.geraete) {
      if (g.eingriff?.art === 'an') {
        zusatz.push(['power', `Ihr Eingriff: ${g.kurz} an${g.eingriff.bisMs != null ? ` bis ${uhrVon(r, g.eingriff.bisMs)}` : ''}.`]);
      }
    }
    if (bild.pausiertBisMs != null) zusatz.push(['pause', 'Automatik pausiert.']);
  }
  const unter = unterzeile(rh, t, bild.speicher != null);
  const l = leiste(rh, t, bild.geraete, bild.reihenfolge, r.jetzt);
  return (
    <section className="card jetzt links" id="jetzt" aria-live="polite" aria-label="Jetzt">
      <div className="j-eye">
        <p>{eye}</p>
        {sel != null && (
          <button type="button" className="j-back" onClick={onJetzt}>
            <Ic n="clock" s={15} />
            Jetzt
          </button>
        )}
      </div>
      <p className="j-say">
        {satz.vor}
        {satz.sonne && <b className="pvw">{satz.sonne}</b>}
        {satz.nach}
      </p>
      {zusatz.length > 0 && (
        <ul className="j-zusatz">
          {zusatz.map(([i, x]) => (
            <li key={x}>
              <Ic n={i} s={16} />
              <span>{x}</span>
            </li>
          ))}
        </ul>
      )}
      {unter && <p className="j-sub">{unter}</p>}
      {l ? <Sonnenleiste l={l} oeffne={oeffne} /> : <Nachtblock bild={bild} t={t} oeffne={oeffne} />}
    </section>
  );
}

const LEG_FARBE: Record<string, string> = {
  haus: '#94a3b8', batt: 'var(--batt-fill)', netz: 'var(--grid)', abgeregelt: '#cbd5e1', dev: 'var(--pv-fill)',
};

function Sonnenleiste({ l, oeffne }: { l: NonNullable<ReturnType<typeof leiste>>; oeffne: (b: BlattZustand) => void }) {
  const sum = Math.max(l.pv, l.teile.reduce((s, x) => s + x.kw, 0)) || 1;
  const auf = (id: string | null) => {
    if (!id) return;
    oeffne(id === SPEICHER ? { art: 'speicher' } : { art: 'geraet', id });
  };
  return (
    <div className="ladder">
      <div className="l-top">
        <span>Wohin geht der Sonnenstrom?</span>
        <b>{fKw(l.pv)}</b>
      </div>
      <div className="l-bar" role="img" aria-label="Verteilung des Sonnenstroms">
        {l.teile.map((s, i) => {
          const pct = (s.kw / sum) * 100;
          return (
            <span
              key={`${s.art}-${s.id ?? i}`}
              className={`l-seg ${s.art}`}
              style={{ flex: `0 0 ${pct.toFixed(2)}%` }}
              title={`${s.label} ${fKw(s.kw)}`}
              onClick={s.id ? () => auf(s.id) : undefined}
            >
              {pct > 9 && <Ic n={s.symbol} s={17} />}
            </span>
          );
        })}
      </div>
      <div className="l-legend">
        {l.teile.map((s, i) => (
          <span key={`${s.art}-${s.id ?? i}`}>
            <i style={{ background: LEG_FARBE[s.art] }} />
            {s.label} <b>{fKw(s.kw)}</b>
          </span>
        ))}
      </div>
      {l.wartet && (
        <button
          type="button"
          className="l-wait"
          style={{ width: '100%', border: 0, textAlign: 'left', cursor: 'pointer' }}
          onClick={() => l.wartet && oeffne({ art: 'geraet', id: l.wartet.id })}
        >
          <Ic n="clock" s={17} />
          <span>
            <b>{l.wartet.name}</b> wartet (Platz {l.wartet.platz}): braucht {fKw(l.wartet.braucht)}, frei sind {fKw(Math.max(0, l.wartet.frei))}.
          </span>
        </button>
      )}
    </div>
  );
}

function Nachtblock({ bild, t, oeffne }: { bild: SeitenBild; t: number; oeffne: (b: BlattZustand) => void }) {
  const rh = bild.reihen;
  const sp = Math.max(0, -(rh.bat[t] ?? 0));
  const netz = Math.max(0, rh.netz[t] ?? 0);
  const sum = sp + netz || 1;
  const kommend: [number, GeraetBild][] = [];
  for (const g of bild.geraete) {
    const nx = naechsterWechsel(g, t);
    if (nx && nx.an && nx.t < t + 48) kommend.push([nx.t, g]);
  }
  kommend.sort((a, b) => a[0] - b[0]);
  const next = kommend[0];
  if (rh.netz[t] == null && rh.bat[t] == null) return null;
  return (
    <div className="ladder">
      <div className="l-top">
        <span>Woher kommt der Strom?</span>
        <b style={{ color: 'var(--c-fg)' }}>{fKw(sp + netz)}</b>
      </div>
      <div className="l-bar" role="img" aria-label="Herkunft des Stroms">
        {sp > 0.02 && (
          <span className="l-seg batt" style={{ flex: `0 0 ${((sp / sum) * 100).toFixed(1)}%` }} onClick={() => oeffne({ art: 'speicher' })}>
            {sp / sum > 0.12 && <Ic n="battery" s={17} />}
          </span>
        )}
        {netz > 0.02 && (
          <span className="l-seg netz" style={{ flex: `0 0 ${((netz / sum) * 100).toFixed(1)}%` }}>
            {netz / sum > 0.12 && <Ic n="pole" s={17} />}
          </span>
        )}
      </div>
      <div className="l-legend">
        {sp > 0.02 && (
          <span>
            <i style={{ background: 'var(--batt-fill)' }} />
            Speicher <b>{fKw(sp)}</b>
          </span>
        )}
        {netz > 0.02 && (
          <span>
            <i style={{ background: 'var(--grid)' }} />
            Netz <b>{fKw(netz)}</b>
          </span>
        )}
      </div>
      {next && (
        <div className="l-nacht">
          <Ic n={next[1].symbol} s={18} />
          <span>
            Als Nächstes: <b style={{ color: 'var(--c-fg)' }}>{next[1].name}</b>{' '}
            {next[0] <= bild.raster.jetzt ? 'startet gleich' : `um ${uhrTag(next[0])}`}
            {next[1].herkunft[next[0]] === 'erwartet' ? ' (erwartet)' : ''}
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Neu in Ihrer Anlage
// ---------------------------------------------------------------------------

function NeuKarte({ g, bild, busy, oeffne, onUebernehmen, onNurMessen }: {
  g: GeraetBild; bild: SeitenBild; busy: boolean; oeffne: (b: BlattZustand) => void;
  onUebernehmen: (g: GeraetBild) => void; onNurMessen: (g: GeraetBild) => void;
}) {
  const v = vorschlag(g);
  const r = bild.raster;
  let folge = 'Wann es läuft, entscheidet VoltPilot nach dem Auftrag.';
  if (v) {
    const s = { ...(g.steuerart ?? { herkunft: 'policy' }), ...v.wunsch, herkunft: 'policy' } as NonNullable<GeraetBild['steuerart']>;
    const bits = erwarteteLaeufe(s, { form: g.form, nennKw: g.nennKw, ladepunkt: !!g.ladepunkt }, bild.reihen, r.jetzt + 1);
    const sp = spannen(bits.slice(r.jetzt + 1), r.jetzt + 1);
    const n = bits.filter(Boolean).length;
    if (sp.length) {
      folge = `Läuft dann voraussichtlich ${spannenText(sp, 2)}${g.nennKw ? ` · ≈ ${fKwh((n * g.nennKw) / 4)}` : ''}`;
    } else if (s.quelle === 'ueberschuss' && s.schwelleKw != null) {
      folge = `Bis morgen Abend bleiben voraussichtlich keine ${fKw(s.schwelleKw)} Sonnenstrom übrig; es läuft, sobald es passt.`;
    } else if (s.quelle === 'guenstig') {
      folge = 'Bis morgen Abend liegt der Börsenpreis voraussichtlich nie unter der Grenze.';
    }
  }
  const quelle = g.eintrag.typLabel;
  return (
    <section className="card neu-karte links" id={`neu-${g.id}`} aria-label={`Neu in Ihrer Anlage: ${g.name}`}>
      <div className="nk-kopf">
        <span className="ico">
          <Ic n={g.symbol} s={23} />
        </span>
        <span className="nk-t">
          <span className="nk-eye">Neu in Ihrer Anlage</span>
          <b>{g.name}</b>
          <small>{quelle}{g.gemessen ? ' · misst' : ''}</small>
        </span>
      </div>
      <p className="nk-frage">Was soll VoltPilot mit {artikel(g)} {g.name} tun?</p>
      {v ? (
        <div className="nk-vorschlag">
          <small>Vorschlag für {artikelUnbestimmt(g)} {g.typLabel}</small>
          <b>{auftragFuerWunsch(g, v.wunsch)}</b>
          <span>{folge}</span>
        </div>
      ) : (
        <div className="nk-vorschlag">
          <small>Noch kein Vorschlag</small>
          <span>Wählen Sie unter „Anders einstellen“, womit das Gerät laufen soll.</span>
        </div>
      )}
      <div className="nk-knoepfe">
        <button type="button" className="btn" disabled={!v || busy} onClick={() => onUebernehmen(g)}>
          <Ic n="check" s={18} />
          {busy ? 'Übernehme …' : 'Übernehmen'}
        </button>
        <button type="button" className="btn sek" onClick={() => oeffne({ art: 'neu', id: g.id })}>
          Anders einstellen
        </button>
      </div>
      <button type="button" className="lnk" onClick={() => onNurMessen(g)}>
        Nicht steuern, nur messen
      </button>
    </section>
  );
}

export function auftragFuerWunsch(g: GeraetBild, w: SteuerartWunsch): string {
  return auftragSatz(
    {
      quelle: w.quelle,
      herkunft: 'policy',
      schwelleKw: w.schwelleKw ?? null,
      preisgrenzeCtKwh: w.preisgrenzeCtKwh ?? null,
      ueberschussModus: w.ueberschussModus ?? null,
      fenster: w.fenster ?? null,
      ziel: w.ziel ?? null,
      zielFenster: w.zielFenster ?? null,
      zielEnergieKwh: w.zielEnergieKwh ?? null,
      zielLaufzeitMinuten: w.zielLaufzeitMinuten ?? null,
    },
    { form: g.form, ladepunkt: !!g.eintrag.ladepunkt },
  );
}

function artikel(g: GeraetBild): string {
  const n = g.name.toLowerCase();
  if (/pumpe|maschine|wallbox|last|anlage|sauna|lüftung|heizung/.test(n)) return 'der';
  if (/stab|trockner|speicher|ladepunkt|kühlschrank/.test(n)) return 'dem';
  return 'dem Gerät';
}
function artikelUnbestimmt(g: GeraetBild): string {
  const n = g.typLabel.toLowerCase();
  if (/pumpe|last|wallbox|wärmepumpe/.test(n)) return 'eine';
  return 'einen';
}

// ---------------------------------------------------------------------------
// Tagesbild
// ---------------------------------------------------------------------------

function Tagesbild({ bild, tag, setTag, sel, setSel, oeffne }: {
  bild: SeitenBild; tag: number; setTag: (t: number) => void; sel: number | null;
  setSel: (t: number | null) => void; oeffne: (b: BlattZustand) => void;
}) {
  const [ref, w] = useBreite();
  const heute = tag === 0;
  const t0 = tag * TAG;
  const breit = w >= 520;
  const reihenIds = [...bild.rang.filter((id) => id !== SPEICHER), ...bild.rest];
  const rows = reihenIds
    .map((id) => bild.geraete.find((g) => g.id === id))
    .filter((g): g is GeraetBild => !!g)
    .map((g) => ({ g, h: breit ? 17 : 15, gap: 5 }));
  const bands = [
    { art: 'pv' as const, h: 24, gap: 4 },
    { art: 'preis' as const, h: 26, gap: 8 },
    ...(bild.speicher ? [{ art: 'soc' as const, h: 12, gap: 6, label: 'Ladestand des Speichers' }] : []),
  ];
  const momentT = sel ?? bild.raster.jetzt;
  const { svg, geo } = zeitband(w, {
    id: 'tl',
    t0,
    t1: t0 + TAG,
    reihen: bild.reihen,
    jetzt: bild.raster.jetzt,
    sel,
    label: 'Tagesbild: wann welches Gerät läuft, gefärbt nach Herkunft des Stroms',
    bands,
    rows,
    onRow: (id) => oeffne({ art: 'geraet', id }),
  });
  const aktiv = useRef(false);
  const waehle = (x: number) => {
    const t = Math.max(0, Math.min(2 * TAG - 1, x));
    const neu = t === bild.raster.jetzt ? null : t;
    if (neu !== sel) {
      setSel(neu);
      haptik('tick');
    }
  };
  const slotAus = (e: RPointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * geo.W;
    if (px < geo.padL - 2) return null;
    return geo.t0 + Math.max(0, Math.min(TAG - 1, Math.floor((px - geo.padL) / geo.bw)));
  };
  const taste = (e: KeyboardEvent<HTMLDivElement>) => {
    const schritt = e.shiftKey ? 4 : 1;
    if (e.key === 'ArrowRight') { e.preventDefault(); waehle(momentT + schritt); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); waehle(momentT - schritt); }
    if (e.key === 'Home') { e.preventDefault(); waehle(t0); }
    if (e.key === 'End') { e.preventDefault(); waehle(t0 + TAG - 1); }
    if (e.key === 'Escape') { e.preventDefault(); setSel(null); }
  };
  const mz = momentZeile(bild.reihen, momentT, bild.geraete, bild.raster.jetzt);
  const erwartet = bild.geraete.some((g) => g.herkunft.some((h) => h === 'erwartet'));
  return (
    <section className="card plan links" aria-label="Tagesbild">
      <div className="card-h">
        <h2>
          <Ic n="calendar" s={18} />
          {heute ? 'Heute gesteuert' : 'Morgen geplant'}
        </h2>
        <div className="mini-seg" role="group" aria-label="Tag">
          <button type="button" aria-pressed={heute} onClick={() => setTag(0)}>Heute</button>
          <button type="button" aria-pressed={!heute} onClick={() => setTag(1)}>Morgen</button>
        </div>
      </div>
      <div
        className="tl"
        ref={ref}
        tabIndex={0}
        role="slider"
        aria-label="Viertelstunde wählen"
        aria-valuemin={0}
        aria-valuemax={95}
        aria-valuenow={momentT % TAG}
        aria-valuetext={uhrTag(momentT)}
        onKeyDown={taste}
        onPointerDown={(e) => {
          if ((e.target as Element).closest('.row-hit')) return;
          const x = slotAus(e);
          if (x == null) return;
          aktiv.current = true;
          waehle(x);
        }}
        onPointerMove={(e) => {
          if (!aktiv.current) return;
          const x = slotAus(e);
          if (x != null) waehle(x);
        }}
        onPointerUp={() => { aktiv.current = false; }}
        onPointerLeave={() => { aktiv.current = false; }}
      >
        {svg}
      </div>
      <div className="tl-leg">
        <span><i style={{ background: 'var(--pv-fill)' }} />Sonne</span>
        {bild.speicher && <span><i style={{ background: 'var(--batt-fill)' }} />Speicher</span>}
        <span><i style={{ background: 'var(--grid)' }} />Netz</span>
        {bild.geraete.some((g) => g.form === 'freigabe') && (
          <span><i style={{ background: 'var(--load-soft)', boxShadow: 'inset 0 2px 0 var(--load),inset 0 -2px 0 var(--load)' }} />Freigabe</span>
        )}
        <span><i className="plan" />{erwartet ? 'Plan und Erwartung' : 'laut Plan'}</span>
      </div>
      <div className="tl-moment">
        <b>{mz.kopf}</b>
        <br />
        {mz.zeile}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Die Geräte = die Reihenfolge
// ---------------------------------------------------------------------------

interface ListeProps {
  bild: SeitenBild;
  reo: string[] | null;
  setReo: (x: string[] | null) => void;
  oeffne: (b: BlattZustand) => void;
  onReihenfolge: (ids: string[]) => Promise<void>;
  onAnlage: (g: GeraetBild | null) => void;
  busy: boolean;
}

const Liste = forwardRef<HTMLElement, ListeProps>(function Liste(p, ref) {
  const { bild } = p;
  if (p.reo) return <ReoListe {...p} reo={p.reo} ref={ref} />;
  const rang = bild.rang;
  const alle = bild.geraete;
  const nichts = !rang.length && !bild.rest.length;
  return (
    <section aria-label="Geräte und Reihenfolge" className="devs rechts" id="devs" ref={ref}>
      <div className="card-h" style={{ margin: '4px 2px 0' }}>
        <h2>
          <Ic n="list" s={18} />
          Wer bekommt Sonnenstrom zuerst?
        </h2>
        {rang.length > 1 && (
          <button type="button" className="tbtn" onClick={() => p.setReo([...rang])}>
            <Ic n="sliders" s={16} />
            Ändern
          </button>
        )}
      </div>
      {nichts && (
        <p className="leise" style={{ padding: '0 4px' }}>
          Noch steuert VoltPilot kein Gerät. Was Sie in der Anlage verbinden, erscheint hier von selbst.
        </p>
      )}
      {rang.map((id, i) =>
        id === SPEICHER ? (
          <SpeicherKarte key={id} bild={bild} platz={i + 1} oeffne={p.oeffne} />
        ) : (
          <GeraetKarte key={id} g={alle.find((g) => g.id === id)!} bild={bild} platz={i + 1} oeffne={p.oeffne} />
        ),
      )}
      {bild.rest.length > 0 && <div className="linie">nach Zeit, Frist oder Preis</div>}
      {bild.rest.map((id) => {
        const g = alle.find((x) => x.id === id);
        return g ? <GeraetKarte key={id} g={g} bild={bild} platz={null} oeffne={p.oeffne} /> : null;
      })}
      <OffenZeilen bild={bild} oeffne={p.oeffne} onAnlage={p.onAnlage} />
      <button type="button" className="add-dev" onClick={() => p.oeffne({ art: 'anbinden' })}>
        <Ic n="plus" s={18} />
        Gerät fehlt? In der Anlage anbinden
      </button>
    </section>
  );
});

function GeraetKarte({ g, bild, platz, oeffne }: { g: GeraetBild; bild: SeitenBild; platz: number | null; oeffne: (b: BlattZustand) => void }) {
  const r = bild.raster;
  const t = r.jetzt;
  const an = g.an === true || (g.jetztKw ?? 0) > 0.02;
  let icoKlasse = '';
  if (g.eingriff) icoKlasse = 'hand';
  else if (an) {
    const a = bild.reihen.last[t] != null ? quelle(bild, t) : 'pv';
    icoKlasse = `on ${a === 'netz' ? 'netz' : a === 'sp' ? 'batt' : ''}`;
  }
  const kw = an ? (g.gemessen && g.jetztKw != null ? fKw(g.jetztKw) : null) : null;
  let erste = g.warum;
  const nx = naechsterWechsel(g, t);
  if (nx && nx.t - t <= 16 && !g.eingriff) {
    erste += ` · ${nx.an ? 'startet' : 'endet'} ${inZeit(r, nx.t)}`;
  }
  const zweite = g.eingriff
    ? <>Eingriff{g.eingriff.bisMs != null ? ` bis ${uhrVon(r, g.eingriff.bisMs)}` : ''} · dann wieder Smart</>
    : <>Smart: <em>{g.auftrag}</em></>;
  return (
    <button type="button" className="dev" id={`dev-${g.id}`} onClick={() => oeffne({ art: 'geraet', id: g.id })}>
      <span className={`ico ${icoKlasse}`}>
        <Ic n={g.symbol} s={23} />
        {platz != null && <span className="rk">{platz}</span>}
      </span>
      <span className="d-mid">
        <span className="d-name"><b>{g.name}</b></span>
        <span className="d-satz">{erste}</span>
        <span className="d-satz">{zweite}</span>
      </span>
      <span className="d-right">
        <span className={`pill ${g.pill[0]}`}><i />{g.pill[1]}</span>
        <span className="d-kw">{kw ?? (an && !g.gemessen ? <small>nicht gemessen</small> : '')}</span>
      </span>
    </button>
  );
}

function quelle(bild: SeitenBild, t: number): 'pv' | 'sp' | 'netz' {
  const rh = bild.reihen;
  const last = rh.last[t] ?? 0;
  if (last <= 0) return 'pv';
  const imp = Math.max(0, rh.netz[t] ?? 0);
  const ent = Math.max(0, -(rh.bat[t] ?? 0));
  const pv = Math.max(0, last - imp - ent);
  const m = Math.max(pv, imp, ent);
  return m === pv ? 'pv' : m === ent ? 'sp' : 'netz';
}

function SpeicherKarte({ bild, platz, oeffne }: { bild: SeitenBild; platz: number; oeffne: (b: BlattZustand) => void }) {
  const sp = bild.speicher;
  if (!sp) return null;
  const an = sp.jetztKw != null && Math.abs(sp.jetztKw) > 0.05;
  return (
    <button type="button" className="dev" id="dev-sp" onClick={() => oeffne({ art: 'speicher' })}>
      <span className={`ico ${an ? 'on batt' : ''}`}>
        <Ic n="battery" s={23} />
        <span className="rk">{platz}</span>
      </span>
      <span className="d-mid">
        <span className="d-name"><b>{sp.name}</b></span>
        <span className="d-satz">{sp.warum}</span>
        <span className="d-satz">Smart: <em>{bild.betriebsmodell}</em></span>
      </span>
      <span className="d-right">
        <span className={`pill ${sp.pill[0]}`}><i />{sp.pill[1]}</span>
        <span className="d-kw">{an ? fKw(Math.abs(sp.jetztKw ?? 0)) : sp.soc != null ? fPct(sp.soc) : ''}</span>
      </span>
    </button>
  );
}

function OffenZeilen({ bild, oeffne, onAnlage }: { bild: SeitenBild; oeffne: (b: BlattZustand) => void; onAnlage: (g: GeraetBild | null) => void }) {
  const { nurMessen, nichtSteuerbar } = bild.einordnung;
  if (!nurMessen.length && !nichtSteuerbar.length) return null;
  return (
    <>
      <div className="linie">in der Anlage, noch nicht gesteuert</div>
      {nurMessen.map((g) => (
        <div className="dev offen" id={`offen-${g.id}`} key={g.id}>
          <span className="ico"><Ic n={g.symbol} s={23} /></span>
          <span className="d-mid">
            <span className="d-name"><b>{g.name}</b></span>
            <span className="d-satz">Nur gemessen, auf Ihren Wunsch.</span>
            <span className="d-satz">{g.typLabel}</span>
            <button type="button" className="tbtn" onClick={() => oeffne({ art: 'neu', id: g.id })}>Steuern</button>
          </span>
        </div>
      ))}
      {nichtSteuerbar.map((g) => (
        <div className="dev offen" id={`offen-${g.id}`} key={g.id}>
          <span className="ico"><Ic n={g.symbol} s={23} /></span>
          <span className="d-mid">
            <span className="d-name"><b>{g.name}</b></span>
            <span className="d-satz">{g.nichtSchreibbarGrund ?? 'Schalten ist für dieses Gerät noch nicht freigegeben.'}</span>
            <span className="d-satz">{g.typLabel}</span>
            <button type="button" className="tbtn" onClick={() => onAnlage(g)}>
              In der Anlage ansehen
              <Ic n="chevR" s={16} />
            </button>
          </span>
        </div>
      ))}
    </>
  );
}

const ReoListe = forwardRef<HTMLElement, ListeProps & { reo: string[] }>(function ReoListe(p, ref) {
  const { bild, reo } = p;
  const [moved, setMoved] = useState<string | null>(null);
  const [live, setLive] = useState('');
  const listeRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; y0: number; el: HTMLElement } | null>(null);
  const name = (id: string) => (id === SPEICHER ? bild.speicher?.name ?? 'Speicher' : bild.geraete.find((g) => g.id === id)?.name ?? id);

  const bewege = (id: string, d: number) => {
    const i = reo.indexOf(id);
    const j = i + d;
    if (j < 0 || j >= reo.length) return;
    const neu = [...reo];
    [neu[i], neu[j]] = [neu[j], neu[i]];
    p.setReo(neu);
    setMoved(id);
    setLive(`${name(id)} jetzt auf Platz ${j + 1}.`);
    haptik('tick');
    requestAnimationFrame(() => {
      const b = document.querySelector<HTMLButtonElement>(`#reo-${cssId(id)} [data-r="${d < 0 ? 'hoch' : 'runter'}"]:not([disabled])`)
        ?? document.querySelector<HTMLButtonElement>(`#reo-${cssId(id)} .handle`);
      b?.focus({ preventScroll: true });
    });
  };

  const unten = (e: RPointerEvent<HTMLButtonElement>, id: string) => {
    const el = (e.currentTarget as HTMLElement).closest<HTMLElement>('.dev.reo');
    if (!el) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id, y0: e.clientY, el };
    el.classList.add('drag');
  };
  const zieh = (e: RPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    const liste = listeRef.current;
    if (!d || !liste) return;
    let dy = e.clientY - d.y0;
    d.el.style.transform = `translateY(${dy}px)`;
    const kinder = [...liste.children] as HTMLElement[];
    const i = kinder.indexOf(d.el);
    const rect = d.el.getBoundingClientRect();
    const mitte = rect.top + rect.height / 2;
    const vor = kinder[i - 1];
    const nach = kinder[i + 1];
    if (vor && mitte < vor.getBoundingClientRect().top + vor.getBoundingClientRect().height / 2) {
      liste.insertBefore(d.el, vor);
      d.y0 -= vor.getBoundingClientRect().height + 8;
      dy = e.clientY - d.y0;
      d.el.style.transform = `translateY(${dy}px)`;
      haptik('tick');
    } else if (nach && mitte > nach.getBoundingClientRect().top + nach.getBoundingClientRect().height / 2) {
      liste.insertBefore(nach, d.el);
      d.y0 += nach.getBoundingClientRect().height + 8;
      dy = e.clientY - d.y0;
      d.el.style.transform = `translateY(${dy}px)`;
      haptik('tick');
    }
  };
  const los = () => {
    const d = drag.current;
    const liste = listeRef.current;
    if (!d || !liste) return;
    drag.current = null;
    d.el.classList.remove('drag');
    d.el.style.transform = '';
    const neu = ([...liste.children] as HTMLElement[]).map((c) => c.dataset.id ?? '').filter(Boolean);
    // React soll die Reihenfolge wieder selbst zeichnen: die DOM-Umstellung
    // zurücknehmen, dann den Zustand setzen.
    const alt = reo.map((id) => liste.querySelector<HTMLElement>(`[data-id="${cssId(id)}"]`)).filter(Boolean) as HTMLElement[];
    for (const el of alt) liste.appendChild(el);
    p.setReo(neu);
    setMoved(d.id);
    setLive(`${name(d.id)} jetzt auf Platz ${neu.indexOf(d.id) + 1}.`);
  };

  const folgen: string[] = [];
  reo.forEach((id, i) => {
    const vorher = bild.rang.indexOf(id);
    if (vorher !== i && vorher >= 0) folgen.push(`${name(id)} Platz ${i + 1} statt ${vorher + 1}`);
  });
  const speichern = async () => {
    await p.onReihenfolge(reo);
  };
  return (
    <section aria-label="Reihenfolge ändern" className="devs rechts" id="devs" ref={ref}>
      <div className="reo-bar">
        <span>Oben bekommt zuerst. Ziehen am Griff oder mit den Pfeilen.</span>
      </div>
      <div id="reo-liste" className="devs" ref={listeRef}>
        {reo.map((id, i) => {
          const g = bild.geraete.find((x) => x.id === id);
          const symbol = id === SPEICHER ? 'battery' : g?.symbol ?? 'plug';
          const satz = id === SPEICHER ? bild.betriebsmodell : g?.auftrag ?? '';
          return (
            <div className={`dev reo${moved === id ? ' moved' : ''}`} data-id={id} id={`reo-${id}`} key={id}>
              <span className="ico">
                <Ic n={symbol} s={23} />
                <span className="rk">{i + 1}</span>
              </span>
              <span className="d-mid">
                <span className="d-name"><b>{name(id)}</b></span>
                <span className="d-satz">{satz}</span>
              </span>
              <span className="reo-btns">
                <button type="button" data-r="hoch" aria-label={`${name(id)} nach oben`} disabled={i === 0} onClick={() => bewege(id, -1)}>
                  <Ic n="chevU" s={20} />
                </button>
                <button type="button" data-r="runter" aria-label={`${name(id)} nach unten`} disabled={i === reo.length - 1} onClick={() => bewege(id, 1)}>
                  <Ic n="chevD" s={20} />
                </button>
                <button
                  type="button"
                  className="handle"
                  aria-label={`${name(id)} ziehen`}
                  onPointerDown={(e) => unten(e, id)}
                  onPointerMove={zieh}
                  onPointerUp={los}
                  onPointerCancel={los}
                >
                  <Ic n="grip" s={20} />
                </button>
              </span>
            </div>
          );
        })}
      </div>
      <div className="ok-note" style={{ background: 'var(--c-card)', border: '1px solid var(--c-border)', color: 'var(--c-fg)' }}>
        <Ic n="info" s={18} />
        <span>
          <b>Folgen ab jetzt:</b>{' '}
          {folgen.length ? folgen.join(' · ') : 'noch keine Änderung'}. Reicht der Sonnenstrom nicht für alle, bekommt, wer oben steht, zuerst.
          Fristen und feste Zeiten gehen weiter vor. Gemessenes bleibt, wie es war.
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn sek" style={{ flex: 1 }} onClick={() => p.setReo(null)}>Abbrechen</button>
        <button type="button" className="btn" style={{ flex: 1 }} disabled={p.busy || !folgen.length} onClick={() => void speichern()}>
          {p.busy ? 'Speichere …' : 'Reihenfolge speichern'}
        </button>
      </div>
      <p className="leise" aria-live="polite">{live}</p>
    </section>
  );
});

function cssId(id: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Was immer gilt
// ---------------------------------------------------------------------------

function ImmerKarte({ bild, oeffne, netzanschlussKw }: { bild: SeitenBild; oeffne: (b: BlattZustand) => void; netzanschlussKw: number | null }) {
  const rows: [string, string, string, BlattZustand][] = [
    ['shield', 'Wer gewinnt?', 'Schutz › Ihr Eingriff › Regel › Frist › Reihenfolge', { art: 'vorrang' }],
  ];
  if (bild.speicher) {
    rows.push(['battery', `Speicher: ${bild.betriebsmodell}`, `Betriebsmodell${bild.speicher.reservePct != null ? ` · Reserve ${fPct(bild.speicher.reservePct)}` : ''}`, { art: 'speicher' }]);
  }
  if (netzanschlussKw != null) {
    rows.push(['gauge', `Netzanschluss ${fKw(netzanschlussKw)}`, 'Laden wird gekürzt, bevor die Sicherung fällt', { art: 'rahmen' }]);
  }
  rows.push(['pole', '§ 14a EnWG', 'Grenze Ihres Netzbetreibers für steuerbare Geräte', { art: 'p14a' }]);
  rows.push(['down', 'Negativpreis-Abregelung', 'Bei Preisen unter null speist die Anlage nicht ein', { art: 'negativ' }]);
  return (
    <section className="card immer links" aria-label="Was immer gilt">
      <div className="card-h" style={{ margin: '8px 0 2px' }}>
        <h2>
          <Ic n="shield" s={18} />
          Was immer gilt
        </h2>
      </div>
      {rows.map(([i, titel, sub, ziel]) => (
        <button type="button" className="immer-r" key={titel} onClick={() => oeffne(ziel)}>
          <span className="li"><Ic n={i} s={18} /></span>
          <span className="lt">
            {titel}
            <small>{sub}</small>
          </span>
          <Ic n="chevR" s={18} />
        </button>
      ))}
    </section>
  );
}

