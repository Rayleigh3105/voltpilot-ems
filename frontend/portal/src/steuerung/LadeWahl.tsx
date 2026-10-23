/**
 * „Womit laden?“ - Konzept k1 „Jede Wahl zeigt ihren Tag“, Variante B
 * (Captain 23.10.2026: E1=B, E2=A, E3=A, E4=A, E5=A, E6=A).
 *
 * Das VORSCHAU-BLATT: Antippen ändert nur die Vorschau, erst „So laden“ schickt
 * die Wahl an die Box. Am Telefon die vier Modi als Zeilen und darunter EINE
 * Vorschau; am Rechner dasselbe als Fenster mit vier Spalten nebeneinander, je
 * mit eigener Vorschau - vergleichen ohne Umschalten. Das Ladeziel wohnt im
 * selben Blatt („Bis 7 Uhr voll? Kein Ziel · +20 kWh · +40 kWh“), die
 * Preisgrenze von „Günstig“ steht mit − / + darin.
 *
 * Dazu die Bausteine, die auch die Karte trägt: das Tagesband (Ladeleistung je
 * Viertelstunde nach Herkunft, Nacht schattiert, bei „Günstig“ Striche für die
 * Viertelstunden unter der Preisgrenze) und die drei Zahlen.
 */
import { useId, useMemo, useState, type CSSProperties, type ReactElement } from 'react';
import { LADEQUELLE, LADEQUELLE_GUT_WENN, LADEQUELLE_VERSPRECHEN } from '../glossar';
import { Recht } from '../components/Recht';
import { useIsPhone } from '../useIsPhone';
import type { SteuerartWunsch } from '../steuerartDialog';
import { Blatt } from './Blatt';
import type { BlattKontext } from './Blaetter';
import type { GeraetBild } from './bild';
import { Ic, type IcName } from './Ic';
import { OPTION_SONNE_SPEICHER, UEBERSCHUSS_MODUS, ladeQuelle, type LadeQuelle } from './laden';
import {
  LADE_QUELLEN, ctText, kwhText, mitAuto, quantil, uhrKurz, vorschauFuer, vorschauSaetze,
  type LadeWahlEntwurf, type Vorschau, type VorschauAnlage,
} from './ladeVorschau';
import { liste } from './liste';
import { TAG } from './zeit';

const SYMBOL: Record<LadeQuelle, [IcName, IcName | null]> = {
  sonne: ['sun', null],
  min: ['sun', 'pole'],
  speicher: ['sun', 'battery'],
  guenstig: ['euro', null],
};

/** Das Zeichen einer Ladequelle: Sonne, Sonne mit Mast, Sonne mit Speicher, Euro. */
export function QuelleZeichen({ q, klein }: { q: LadeQuelle; klein?: boolean }) {
  const [a, b] = SYMBOL[q];
  return (
    <span className={`lq-zeichen ${q}${klein ? ' klein' : ''}`} aria-hidden="true">
      <Ic n={a} s={klein ? 20 : 24} />
      {b && <span className="zwei"><Ic n={b} s={13} /></span>}
    </span>
  );
}

/**
 * Die Ladequellen, die dieser Ladepunkt anbietet (die Karten `optionen.quellen`
 * des Servers) - und „Sonne + Speicher“ GESPERRT mit Grund, wenn eine
 * Sonnen-Quelle wählbar ist: eine Wahl, die verschwindet, erklärt nichts.
 */
export function angeboteneQuellen(g: GeraetBild): { q: LadeQuelle; gesperrt: string | null }[] {
  const karten = liste(g.eintrag.optionen?.quellen);
  const frei = new Set(karten.filter((x) => !x.gesperrt).map((x) => x.id));
  const out: { q: LadeQuelle; gesperrt: string | null }[] = [];
  if (frei.has('ueberschuss')) {
    out.push({ q: 'sonne', gesperrt: null }, { q: 'min', gesperrt: null });
    const sp = karten.find((x) => x.id === OPTION_SONNE_SPEICHER);
    if (sp) out.push({ q: 'speicher', gesperrt: sp.gesperrt ? sp.grund ?? 'Für diesen Ladepunkt nicht möglich.' : null });
  }
  if (frei.has('guenstig')) out.push({ q: 'guenstig', gesperrt: null });
  return out;
}

/** Die Wahl, mit der das Blatt öffnet: die gespeicherte - oder beim ersten Besuch „Sonne + Minimum“ (E5=A). */
export function startEntwurf(g: GeraetBild): LadeWahlEntwurf {
  const s = g.steuerart;
  const zielAn = s?.ziel === 'bis_uhrzeit' && typeof s.zielEnergieKwh === 'number';
  const vorgabe = g.eintrag.optionen?.vorgaben?.preisgrenzeCtKwh;
  return {
    modus: ladeQuelle(g) ?? 'min',
    zielKwh: zielAn ? (s?.zielEnergieKwh as number) : 0,
    zielBis: s?.zielFenster?.bis || '07:00',
    preisgrenzeCt: s?.preisgrenzeCtKwh ?? (typeof vorgabe === 'number' ? vorgabe : null),
  };
}

/**
 * Der Auftrag an den Server: die GANZE Steuerart (PUT ersetzt sie) - ohne Ziel
 * heißt ohne Ziel. Die Mindestleistung von „Sonne + Minimum“ bleibt, wie sie
 * war, sonst die des Rahmens.
 */
export function wunschAus(g: GeraetBild, w: LadeWahlEntwurf, rahmenMinKw: number | null): SteuerartWunsch {
  const s = g.steuerart;
  const ziel = w.zielKwh > 0
    ? { ziel: 'bis_uhrzeit', zielEnergieKwh: w.zielKwh, zielFenster: { tage: 'daily', von: '', bis: w.zielBis } }
    : {};
  if (w.modus === 'guenstig') return { quelle: 'guenstig', preisgrenzeCtKwh: w.preisgrenzeCt, ...ziel };
  return {
    quelle: 'ueberschuss',
    ueberschussModus: UEBERSCHUSS_MODUS[w.modus],
    ...(w.modus === 'min' ? { mindestleistungKw: s?.mindestleistungKw ?? rahmenMinKw ?? 1.4 } : {}),
    ...ziel,
  };
}

/** Hat sich gegenüber der gespeicherten Steuerart etwas geändert? */
export function geaendert(g: GeraetBild, w: LadeWahlEntwurf): boolean {
  const alt = startEntwurf(g);
  if (g.steuerart?.quelle === 'sofort' || ladeQuelle(g) == null) return true;
  return alt.modus !== w.modus || alt.zielKwh !== w.zielKwh
    || (w.zielKwh > 0 && alt.zielBis !== w.zielBis)
    || (w.modus === 'guenstig' && (g.steuerart?.preisgrenzeCtKwh ?? null) !== w.preisgrenzeCt);
}

// ---------------------------------------------------------------------------
// Das Tagesband und die drei Zahlen
// ---------------------------------------------------------------------------

/**
 * Ladeleistung je Viertelstunde bis zur Abfahrt, gestapelt nach Sonne,
 * Speicher, Netz; Nacht schattiert; bei „Günstig“ Striche unter der
 * Preisgrenze; mit Ziel eine gestrichelte Linie, wo es fertig ist.
 */
export function VorschauBand({ v, abfahrt, maxKw, h = 62, preis, label }: {
  v: Vorschau; abfahrt: number; maxKw: number; h?: number; preis?: boolean; label: string;
}) {
  const t0 = v.slots[0]?.t ?? 0;
  const n = Math.max(1, abfahrt - t0);
  const W = 360;
  const oben = 4;
  const H = h + oben;
  const bw = W / n;
  const skala = (H - oben) / Math.max(maxKw, 0.1);
  const teile: ReactElement[] = [];
  // Nacht: zusammenhängende Viertelstunden ohne Sonne.
  let nacht: number | null = null;
  v.slots.forEach((s, i) => {
    if (s.nacht && nacht == null) nacht = i;
    const ende = !s.nacht || i === v.slots.length - 1;
    if (ende && nacht != null) {
      const bis = s.nacht ? i + 1 : i;
      teile.push(<rect key={`n${i}`} className="vb-nacht" x={nacht * bw} y={oben} width={(bis - nacht) * bw} height={H - oben} />);
      nacht = null;
    }
  });
  // Hinter der Vorschau (fehlende Prognose): eigene Fläche, nicht leer.
  if (v.bis < abfahrt) teile.push(<rect key="fehlt" className="vb-fehlt" x={(v.bis - t0) * bw} y={oben} width={(abfahrt - v.bis) * bw} height={H - oben} />);
  v.slots.forEach((s, i) => {
    let y = H;
    for (const [k, w] of [['sonne', s.sonne], ['speicher', s.speicher], ['netz', s.netz]] as const) {
      const hh = w * skala;
      if (hh > 0.2) {
        y -= hh;
        teile.push(<rect key={`${k}${i}`} className={`vb-${k}`} x={i * bw + 0.3} y={y} width={Math.max(0.4, bw - 0.6)} height={hh} />);
      }
    }
  });
  const fertigX = v.schafft != null && v.fertig != null ? Math.min(W - 1, (v.fertig - t0) * bw) : null;
  // Die Beschriftung steht als Text unter dem Bild: das Band dehnt sich mit der Karte, die Schrift nicht.
  const ticks: [number, string, 'start' | 'middle' | 'end'][] = [[t0, 'jetzt', 'start'], [abfahrt, `${uhrKurz(abfahrt)} Uhr`, 'end']];
  for (let t = t0 + 1; t < abfahrt; t++) {
    if (t % 24 !== 0 || t - t0 < 10 || abfahrt - t < 12) continue;
    ticks.push([t, String((t % TAG) / 4), 'middle']);
  }
  return (
    <span className="vb-w">
      <svg className="vb" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: H }} role="img" aria-label={label}>
        {teile}
        <line className="vb-achse" x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} vectorEffect="non-scaling-stroke" />
        <line className="vb-jetzt" x1={0.75} x2={0.75} y1={oben - 2} y2={H} vectorEffect="non-scaling-stroke" />
        {fertigX != null && <line className="vb-fertig" x1={fertigX} x2={fertigX} y1={oben - 2} y2={H} vectorEffect="non-scaling-stroke" />}
      </svg>
      {preis && (
        <span className="vb-preise" aria-hidden="true">
          {v.slots.map((s, i) => (s.billig ? <i key={i} style={{ left: `${(i / n) * 100}%`, width: `${(1 / n) * 100}%` }} /> : null))}
        </span>
      )}
      <span className="vb-ticks" aria-hidden="true">
        {ticks.map(([t, l, a]) => (
          <span key={`t${t}`} className={a} style={{ left: `${((t - t0) / n) * 100}%` }}>{l}</span>
        ))}
      </span>
    </span>
  );
}

/** Die drei Zahlen: bis zur Abfahrt möglich · davon Netzstrom · Ø ct/kWh. */
export function DreiZahlen({ v, abfahrt }: { v: Vorschau; abfahrt: number }) {
  const bis = `bis ${uhrKurz(abfahrt)} Uhr`;
  return (
    <div className="lq-zahlen">
      <div><b>{kwhText(v.kwh)}</b><small>{v.schafft != null ? bis : `${bis} möglich`}</small></div>
      <div><b>{v.netzKwh < 0.5 ? 'kein' : kwhText(v.netzKwh)}</b><small>Netzstrom</small></div>
      <div><b>{v.ctKwh != null ? `Ø ${ctText(v.ctKwh)}` : '—'}</b><small>{v.ctKwh != null ? 'je kWh' : 'Preis fehlt'}</small></div>
    </div>
  );
}

/** Ein Satz zum Ziel unter der Vorschau - nur mit Ziel. */
function zielSatz(v: Vorschau, w: LadeWahlEntwurf, abfahrt: number): { ok: boolean; text: string } | null {
  if (w.zielKwh <= 0 || v.schafft == null) return null;
  if (!v.schafft) return { ok: false, text: `Reicht nicht ganz bis ${uhrKurz(abfahrt)} Uhr` };
  const nachts = v.netzKwh > 0.5 && w.modus !== 'guenstig' && w.modus !== 'min';
  return { ok: true, text: `Schafft +${w.zielKwh} kWh bis ${uhrKurz(v.fertig ?? abfahrt)} Uhr${nachts ? ', Rest aus dem Netz' : ''}` };
}

// ---------------------------------------------------------------------------
// Das Blatt
// ---------------------------------------------------------------------------

const ZIEL_MENGEN = [20, 40];

export interface LadeWahlBlattProps {
  k: BlattKontext;
  id: string;
  anlage: VorschauAnlage;
  /** Mindestleistung des Rahmens (für „Sonne + Minimum“). */
  rahmenMinKw: number | null;
  /** „So laden“: die ganze Steuerart an den Server; true = gespeichert. */
  onSoLaden: (g: GeraetBild, w: SteuerartWunsch) => Promise<boolean>;
}

export function LadeWahlBlatt({ k, id, anlage, rahmenMinKw, onSoLaden }: LadeWahlBlattProps) {
  const g = k.bild.geraete.find((x) => x.id === id);
  if (!g) return null;
  return <LadeWahlInhalt k={k} g={g} anlage={anlage} rahmenMinKw={rahmenMinKw} onSoLaden={onSoLaden} />;
}

function LadeWahlInhalt({ k, g, anlage, rahmenMinKw, onSoLaden }: Omit<LadeWahlBlattProps, 'id'> & { g: GeraetBild }) {
  const telefon = useIsPhone();
  const name = useId();
  const [w, setW] = useState<LadeWahlEntwurf>(() => startEntwurf(g));
  const quellen = angeboteneQuellen(g);
  const erst = g.steuerart?.quelle === 'sofort' || ladeQuelle(g) == null;
  const vorgabe = g.eintrag.optionen?.vorgaben?.preisgrenzeCtKwh;
  const zielMoeglich = liste(g.eintrag.optionen?.ziele).some((z) => z.id === 'bis_uhrzeit' && !z.gesperrt);
  const busy = k.busy === g.id;
  const angesteckt = !!g.ladepunkt?.angesteckt;
  // Ohne gespeicherte Grenze und ohne Vorgabe des Servers: das billigste Viertel
  // der bekannten Bezugspreise bis morgen - als Startwert, sichtbar und änderbar.
  const grenzeStart = useMemo(() => {
    const werte = k.bild.reihen.bezug.slice(k.bild.raster.jetzt).filter((x): x is number => x != null);
    const q = quantil(werte, 0.25);
    return q == null ? null : Math.round(q * 2) / 2;
  }, [k.bild.reihen.bezug, k.bild.raster.jetzt]);
  const grenze = w.preisgrenzeCt ?? grenzeStart;
  const rechne = (modus: LadeQuelle) => vorschauFuer(k.bild, g, anlage, { ...w, modus, preisgrenzeCt: grenze });
  const alle = LADE_QUELLEN.filter((q) => quellen.some((x) => x.q === q && !x.gesperrt)).map((q) => [q, rechne(q)] as const);
  const gewaehlt = alle.find(([q]) => q === w.modus)?.[1] ?? rechne(w.modus);
  const zielUhr = uhrKurz(Math.round((Number(w.zielBis.slice(0, 2)) * 60 + Number(w.zielBis.slice(3, 5))) / 15));
  const mengen = [...new Set([...ZIEL_MENGEN, ...(w.zielKwh > 0 ? [w.zielKwh] : []), ...(startEntwurf(g).zielKwh > 0 ? [startEntwurf(g).zielKwh] : [])])].sort((a, b) => a - b);
  const kannSenden = w.modus !== 'guenstig' || grenze != null;

  const soLaden = async () => {
    if (!geaendert(g, { ...w, preisgrenzeCt: grenze })) { k.zu(); return; }
    if (await onSoLaden(g, wunschAus(g, { ...w, preisgrenzeCt: grenze }, rahmenMinKw))) k.zu();
  };

  const optionZeile = ({ q, gesperrt }: { q: LadeQuelle; gesperrt: string | null }) => (
    <label key={q} className={`lq-opt${gesperrt ? ' zu' : ''}`}>
      <input type="radio" name={name} value={q} checked={w.modus === q} disabled={gesperrt != null}
        onChange={() => setW((x) => ({ ...x, modus: q }))} />
      <QuelleZeichen q={q} klein />
      <span className="lq-t">
        <b>{LADEQUELLE[q]}{erst && q === 'min' && <span className="lq-empf">Empfohlen</span>}</b>
        <small>{gesperrt ?? LADEQUELLE_VERSPRECHEN[q]}</small>
      </span>
      <span className="lq-haken" aria-hidden="true"><Ic n="check" s={12} /></span>
    </label>
  );

  const preisZeile = w.modus === 'guenstig' && (
    <div className="lq-grenze">
      <span>Preisgrenze<small>{grenze != null && typeof vorgabe === 'number' && grenze === vorgabe
        ? 'Vorgabe: billigstes Viertel der letzten 7 Tage' : 'Bezugspreis, unter dem das Auto lädt'}</small></span>
      <span className="stp">
        <button type="button" aria-label="Preisgrenze senken" disabled={grenze == null}
          onClick={() => setW((x) => ({ ...x, preisgrenzeCt: Math.max(-50, (grenze ?? 0) - 1) }))}><Ic n="minus" s={18} /></button>
        <output aria-live="polite">{grenze != null ? `${ctText(grenze)}` : '—'}</output>
        <button type="button" aria-label="Preisgrenze anheben" disabled={grenze == null}
          onClick={() => setW((x) => ({ ...x, preisgrenzeCt: Math.min(200, (grenze ?? 0) + 1) }))}><Ic n="plus" s={18} /></button>
      </span>
    </div>
  );

  const zielBlock = zielMoeglich && (
    <div className="blk lq-ziel">
      <h3>Bis {zielUhr} Uhr voll?</h3>
      <div className="chips" role="group" aria-label={`Ladeziel bis ${zielUhr} Uhr`}>
        <button type="button" aria-pressed={w.zielKwh === 0} onClick={() => setW((x) => ({ ...x, zielKwh: 0 }))}>Kein Ziel</button>
        {mengen.map((m) => (
          <button type="button" key={m} aria-pressed={w.zielKwh === m} onClick={() => setW((x) => ({ ...x, zielKwh: m }))}>+{m} kWh</button>
        ))}
      </div>
    </div>
  );

  const hinweise = (v: Vorschau) => (
    <>
      {v.gekuerzt && <p className="leise">Die Prognose reicht noch nicht bis zur Abfahrt; gerechnet ist, soweit sie reicht.</p>}
      {v.speicherUnbekannt && v.modus === 'speicher' && <p className="leise">Der Ladestand des Speichers ist gerade nicht gemessen; ohne ihn gibt der Speicher nichts frei.</p>}
    </>
  );

  const fuss = (
    <Recht aktion="betriebsweise.aendern">
      <button type="button" className="btn sek" onClick={k.zu}>Abbrechen</button>
      <button type="button" className="btn" disabled={busy || !kannSenden} onClick={() => void soLaden()}>
        <Ic n="check" s={18} />
        {busy ? 'Wird gesendet …' : telefon ? 'So laden' : `So laden: ${LADEQUELLE[w.modus]}`}
      </button>
    </Recht>
  );
  const unter = `${g.name} · Schätzung aus Prognose und Preis`;

  if (!telefon) {
    return (
      <Blatt symbol="sun" titel="Womit laden?" unter={unter} breit onClose={k.zu} fuss={fuss}>
        <div className="lq-vergleich" role="radiogroup" aria-label="Womit laden" style={{ '--lq-spalten': quellen.length } as CSSProperties}>
          {quellen.map(({ q, gesperrt }) => {
            const r = alle.find(([x]) => x === q)?.[1] ?? null;
            const satz = r ? vorschauSaetze(r.vorschau, r.abfahrt) : null;
            return (
              <label key={q} className={`lq-spalte${gesperrt ? ' zu' : ''}`}>
                <input type="radio" name={name} value={q} checked={w.modus === q} disabled={gesperrt != null}
                  onChange={() => setW((x) => ({ ...x, modus: q }))} />
                <span className="lq-k1">
                  <QuelleZeichen q={q} klein />
                  <span className="lq-t"><b>{LADEQUELLE[q]}{erst && q === 'min' && <span className="lq-empf">Empfohlen</span>}</b><small>{LADEQUELLE_VERSPRECHEN[q]}</small></span>
                </span>
                {r && satz ? (
                  <>
                    <VorschauBand v={r.vorschau} abfahrt={r.abfahrt} maxKw={g.nennKw ?? 11} h={44} preis={q === 'guenstig'} label={`${LADEQUELLE[q]}: Ladeleistung bis ${uhrKurz(r.abfahrt)} Uhr nach Herkunft`} />
                    <DreiZahlen v={r.vorschau} abfahrt={r.abfahrt} />
                    <span className="lq-satz">{mitAuto(satz.jetzt, angesteckt)}{satz.dann && <small>{satz.dann}</small>}</span>
                    {zielSatz(r.vorschau, w, r.abfahrt) && <span className={`lq-zielsatz${zielSatz(r.vorschau, w, r.abfahrt)!.ok ? '' : ' nein'}`}>{zielSatz(r.vorschau, w, r.abfahrt)!.text}</span>}
                    <span className="leise">Gut, wenn {LADEQUELLE_GUT_WENN[q]}.</span>
                  </>
                ) : (
                  <span className="leise">{gesperrt}</span>
                )}
              </label>
            );
          })}
        </div>
        {preisZeile}
        {hinweise(gewaehlt.vorschau)}
        {zielBlock}
        <p className="leise">Die Box entscheidet selbst; die Vorschau ist eine Schätzung aus Prognose und Preis. Netzstrom zum Bezugspreis, Sonne und Speicher zu dem, was die kWh eingespeist gebracht hätte.</p>
      </Blatt>
    );
  }

  const satz = vorschauSaetze(gewaehlt.vorschau, gewaehlt.abfahrt);
  const ziel = zielSatz(gewaehlt.vorschau, w, gewaehlt.abfahrt);
  return (
    <Blatt symbol="sun" titel="Womit laden?" unter={g.name} voll onClose={k.zu} fuss={fuss}>
      <div className="lq-opts" role="radiogroup" aria-label="Womit laden">
        {quellen.map(optionZeile)}
      </div>
      <div className="lq-vorschau" aria-live="polite">
        <p className="lq-satz">{mitAuto(satz.jetzt, angesteckt)}<small>{satz.dann ?? ' '}</small></p>
        <VorschauBand v={gewaehlt.vorschau} abfahrt={gewaehlt.abfahrt} maxKw={g.nennKw ?? 11} h={50} preis={w.modus === 'guenstig'}
          label={`${LADEQUELLE[w.modus]}: Ladeleistung bis ${uhrKurz(gewaehlt.abfahrt)} Uhr nach Herkunft`} />
        <DreiZahlen v={gewaehlt.vorschau} abfahrt={gewaehlt.abfahrt} />
        {preisZeile}
        {ziel && <p className={`lq-zielsatz${ziel.ok ? '' : ' nein'}`}>{ziel.text}</p>}
        {hinweise(gewaehlt.vorschau)}
        <p className="leise lq-schaetzung">Schätzung aus Prognose und Preis</p>
      </div>
      {zielBlock}
    </Blatt>
  );
}
