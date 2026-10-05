/**
 * Reiter „Laden“: alles rund um die Ladepunkte an einem Ort (Prototyp
 * `ui-laden.js`) - Netzanschluss, je Ladepunkt Aus · Smart · Schnell,
 * Womit laden, Ladeziel, Ladeplan, Vorrang vor dem Speicher, Fahrzeuge.
 */
import { liste } from './liste';
import { useEffect, useId, useRef, useState } from 'react';
import { api, type ChargingConfig } from '../api';
import { Recht } from '../components/Recht';
import { VpTimePicker } from '../components/VpTimePicker';
import type { SiteFahrzeuge } from '../fahrzeugProfile';
import type { FahrerAnfrage, LadepunktErtraege, LadepunktListe, Rueckspeisen } from '../ladepunktErtraege';
import { fahrzeugName, fahrzeugZeilen, kartenKurz } from '../fahrzeugProfile';
import type { LadeparkRahmen } from '../verbraucherZone';
import type { SteuerartWunsch } from '../steuerartDialog';
import { parseDecimal } from '../zahl';
import { Blatt } from './Blatt';
import type { BlattKontext } from './Blaetter';
import { quellenAnteil, type GeraetBild } from './bild';
import { Ic } from './Ic';
import {
  abfahrtSetzen, abfahrtZeile, band, ertragZeile, fahrerAnfrage, grenzePruefung, heutigerAnschluss, kmZu,
  kwVereinbart, ladebudgetKw, ladeQuelle, ladeWahl, ladeplan, lokalesDatum, naechsteAbfahrt, naechsteUhrzeit, pctKm, plantZurueck,
  rueckspeiseSatz, wallboxMispel, wochentageText, type AnschlussStand, type LadeQuelle, type WallboxMispel,
} from './laden';
import type { BlattZustand, SeitenBild } from './seite';
import { Zeitband } from './Zeitband';
import { N, TAG, fCt, fKw, fKwh, fPct, uhrTag, uhrVon, zahl0 } from './zeit';

export interface LadenReiterProps {
  bild: SeitenBild;
  rahmen: LadeparkRahmen | null;
  config: ChargingConfig | null;
  fahrzeuge: SiteFahrzeuge | null;
  busy: string | null;
  oeffne: (b: BlattZustand) => void;
  onSmart: (g: GeraetBild) => void;
  onQuelle: (g: GeraetBild, q: LadeQuelle) => void;
  onVorrang: (speicherZuerst: boolean) => void;
  onLadevorgaenge: () => void;
  zuGeraete: () => void;
  /** MiSpeL MP-41b: Ladepunkte mit Fähigkeit und Fahrer-Einstellungen; `null` = unbekannt → Karten wie heute. */
  ladepunkte?: LadepunktListe | null;
  ertraege?: LadepunktErtraege | null;
  onFahrer?: (g: GeraetBild, anfrage: FahrerAnfrage) => Promise<boolean>;
  zuErloesen?: () => void;
}

export function LadenReiter(p: LadenReiterProps) {
  const { bild } = p;
  const lp = bild.ladepunkte;
  return (
    <>
      <BudgetKarte bild={bild} rahmen={p.rahmen} oeffne={p.oeffne} />
      {lp.map((g) => (
        <LadeKarte key={g.id} g={g} bild={bild} fahrzeuge={p.fahrzeuge} busy={p.busy === g.id} oeffne={p.oeffne} onSmart={p.onSmart} onQuelle={p.onQuelle}
          m={wallboxMispel(g, p.ladepunkte)} ertraege={p.ertraege ?? null} onFahrer={p.onFahrer} zuErloesen={p.zuErloesen} />
      ))}
      {!lp.length && (
        <section className="card">
          <p className="leise">Noch ist kein Ladepunkt mit dieser Anlage verbunden. Ladepunkte legen Sie in der Anlage an; hier erscheinen sie von selbst.</p>
        </section>
      )}
      {bild.speicher && <VorrangKarte config={p.config} busy={p.busy === 'vorrang'} onVorrang={p.onVorrang} zuGeraete={p.zuGeraete} />}
      <FahrzeugKarte fahrzeuge={p.fahrzeuge} oeffne={p.oeffne} bild={bild} mispel={lp.some((g) => wallboxMispel(g, p.ladepunkte) != null)} />
      <section className="card immer">
        <button type="button" className="immer-r" onClick={p.onLadevorgaenge}>
          <span className="li"><Ic n="history" s={18} /></span>
          <span className="lt">Ladevorgänge<small>Jede Ladung mit Menge, Herkunft und Karte</small></span>
          <Ic n="chevR" s={18} />
        </button>
      </section>
    </>
  );
}

function BudgetKarte({ bild, rahmen, oeffne }: { bild: SeitenBild; rahmen: LadeparkRahmen | null; oeffne: (b: BlattZustand) => void }) {
  const b = band(rahmen, bild.ladepunkte, bild.reihen, bild.raster.jetzt);
  if (!b) {
    return (
      <section className="card" aria-label="Netzanschluss">
        <div className="card-h">
          <h2><Ic n="gauge" s={18} />Netzanschluss</h2>
          <button type="button" className="tbtn" onClick={(e) => { e.currentTarget.focus(); oeffne({ art: 'rahmen' }); }}><Ic n="sliders" s={16} />Rahmen</button>
        </div>
        <p className="leise">Die Grenze Ihres Netzanschlusses ist noch nicht hinterlegt. Ohne sie verteilt die Box nur, was sie sicher weiß.</p>
      </section>
    );
  }
  return (
    <section className="card" aria-label="Netzanschluss">
      <div className="card-h">
        <h2><Ic n="gauge" s={18} />Netzanschluss {fKw(b.anschlussKw)}</h2>
        <button type="button" className="tbtn" onClick={(e) => { e.currentTarget.focus(); oeffne({ art: 'rahmen' }); }}><Ic n="sliders" s={16} />Rahmen</button>
      </div>
      <div className="budget">
        <div className="b-bar" role="img" aria-label="Aufteilung des Netzanschlusses">
          {b.teile.map((x, i) => (
            <span key={`${x.k}-${i}`} className={x.k} style={{ flex: `0 0 ${((x.kw / b.anschlussKw) * 100).toFixed(1)}%` }} title={`${x.label} ${fKw(x.kw)}`}>
              {x.kw / b.anschlussKw > 0.14 ? x.label : ''}
            </span>
          ))}
        </div>
        <p className="leise">
          Aus dem Netz gerade: Haus {b.hausKw != null ? fKw(b.hausKw) : 'nicht gemeldet'}
          {b.ladenNetzKw > 0.05 ? `, Laden ${fKw(b.ladenNetzKw)}` : ''}. Für Autos frei: <b style={{ color: 'var(--c-fg)' }}>{fKw(b.freiKw)}</b>. Laden mit Sonnenstrom belastet den Anschluss nicht.
          {b.ladenKw > 0.05 ? ` Es laden gerade ${fKw(b.ladenKw)}.` : ''}
        </p>
      </div>
    </section>
  );
}

function LadeKarte({ g, bild, fahrzeuge, busy, oeffne, onSmart, onQuelle, m, ertraege, onFahrer, zuErloesen }: {
  g: GeraetBild; bild: SeitenBild; fahrzeuge: SiteFahrzeuge | null; busy: boolean;
  oeffne: (b: BlattZustand) => void; onSmart: (g: GeraetBild) => void; onQuelle: (g: GeraetBild, q: LadeQuelle) => void;
  /** MiSpeL MP-41b; `null` = Bestand, die Karte bleibt wie vor MP-41b. */
  m: WallboxMispel | null; ertraege: LadepunktErtraege | null;
  onFahrer?: (g: GeraetBild, anfrage: FahrerAnfrage) => Promise<boolean>; zuErloesen?: () => void;
}) {
  // BK-41 A: für ein Auto mit gemeldetem Ladestand wird das Ladeziel zu „Abfahrt und Reserve“ - eine Quelle (MP-41a).
  const abfahrtStatt = m?.fahrzeug === 'mit_ladestand';
  const r = bild.raster;
  const l = g.ladepunkt;
  const wahl = ladeWahl(g);
  const q = ladeQuelle(g);
  const an = g.an === true;
  const karte = l?.karte ? liste(fahrzeuge?.fahrzeuge).find((f) => f.tagRef === l.karte) ?? null : null;
  let sub: string;
  if (l?.angesteckt) {
    const kurzKarte = l.karte ? kartenKurz(l.karte) : '';
    const wer = [karte?.name?.trim() || null, kurzKarte ? `Karte ${kurzKarte}…` : null].filter(Boolean).join(' · ') || (karte ? fahrzeugName(karte) : 'Ein Auto');
    sub = `${wer}${l.sitzungSeit ? ` · angesteckt seit ${uhrVon(r, Date.parse(l.sitzungSeit))}` : ''}`;
  } else sub = 'Kein Auto angesteckt';
  const platz = bild.rang.indexOf(g.id) + 1;
  const ansage = wahl === 'aus'
    ? `Pausiert${g.eingriff?.bisMs != null ? ` bis ${uhrVon(r, g.eingriff.bisMs)}` : ' bis zum Abstecken'}. Danach wieder Smart.`
    : wahl === 'schnell'
      ? 'Lädt so schnell es geht, nur für diese Ladung. Netzstrom erlaubt.'
      : an && g.sonnig && platz > 0 && !g.steuerart?.ziel
        ? `Sonnenstrom · Platz ${platz}`
        : g.warum;
  const quellen: [LadeQuelle, string, string][] = [['sonne', 'Nur Sonne', 'ueberschuss'], ['min', 'Sonne + Minimum', 'ueberschuss'], ['guenstig', 'Günstig', 'guenstig']];
  const frei = new Set(liste(g.eintrag.optionen?.quellen).filter((x) => !x.gesperrt).map((x) => x.id));
  const s = g.steuerart;
  const zielAn = s?.ziel === 'bis_uhrzeit' && typeof s.zielEnergieKwh === 'number';
  const zielMoeglich = liste(g.eintrag.optionen?.ziele).some((z) => z.id === 'bis_uhrzeit' && !z.gesperrt);
  const kw = g.nennKw ?? 11;
  let zielSub = 'Tippen, um eine Menge bis zu einer Uhrzeit festzulegen';
  let planKw: (number | null)[] | null = null;
  let zielBis: number | null = null;
  if (zielAn && s?.zielFenster?.bis) {
    const bis = naechsteUhrzeit(r.jetzt, s.zielFenster.bis);
    zielBis = bis;
    const art = s.quelle === 'guenstig' ? 'In den günstigsten Stunden' : 'Sonne zuerst, Rest in den günstigsten Stunden';
    // Der Fahrplan hat Vorrang; die Schätzung nur, wo er fehlt und ein Auto steckt.
    const geplant = g.herkunft.some((h, t) => h === 'plan' && t > r.jetzt);
    let fertig: number | null = null;
    if (geplant) {
      for (let t = r.jetzt; t < bis; t++) if ((g.kw[t] ?? 0) > 0.02) fertig = t + 1;
    } else if (l?.angesteckt) {
      const plan = ladeplan(bild.reihen, r.jetzt, bis, s.zielEnergieKwh ?? 0, kw, s.quelle === 'guenstig');
      planKw = plan.kw;
      fertig = plan.fertig;
    }
    zielSub = `${art}${fertig != null ? ` · fertig voraussichtlich ${uhrTag(fertig)}` : !l?.angesteckt ? ' · sobald ein Auto ansteckt' : ''}`;
  }
  const zeile = planKw ? { g, h: 18, kw: mitGemessen(g, planKw, r.jetzt) } : { g, h: 18 };
  const t1 = Math.min(N, r.jetzt + TAG);
  const ticks: number[] = [];
  for (let k = 0; k <= t1 - r.jetzt; k++) if ((r.jetzt + k) % 24 === 0) ticks.push(k);
  return (
    <section className={`card lp-card${bild.funktion.angehalten ? ' matt' : ''}`} aria-label={g.name}>
      <div className="lp-h">
        <span className={`ico${an ? ' on' : ''}`}><Ic n="car" s={26} /></span>
        <span className="t">
          <b>{g.name}</b>
          <small>{sub}</small>
        </span>
        <span className="lp-kw">
          {an && g.jetztKw != null ? fKw(g.jetztKw) : '—'}
          <small>{an ? herkunftWort(bild, r.jetzt) : g.pill[1]}</small>
        </span>
      </div>
      <Recht aktion="handeingriff.setzen"><div className="lmodes" role="group" aria-label="Lademodus" style={{ gridTemplateColumns: 'repeat(3,minmax(0,1fr))' }}>
        {([['aus', 'pause', 'Aus'], ['smart', 'sun', 'Smart'], ['schnell', 'rocket', 'Schnell']] as const).map(([k, i, label]) => (
          <button
            type="button"
            key={k}
            data-m={k}
            aria-pressed={wahl === k}
            disabled={busy || (k !== 'smart' && (!l?.angesteckt || bild.funktion.sperre != null))}
            onClick={(e) => {
              if (k === 'smart') { if (wahl !== 'smart') onSmart(g); return; }
              e.currentTarget.focus();
              oeffne({ art: 'geraet', id: g.id, modus: k === 'aus' ? 'aus' : 'an' });
            }}
          >
            <Ic n={i} s={20} />
            {label}
          </button>
        ))}
      </div></Recht>
      {bild.funktion.sperre && <p className="leise" role="note">{bild.funktion.sperre}</p>}
      <p className="leise" style={{ color: 'var(--c-fg)', fontWeight: 600 }}>{ansage}</p>
      {!abfahrtStatt && l?.sitzungKwh != null && l.sitzungKwh > 0.05 && (
        <div className="soc">
          <div className="soc-row">
            <span>Diese Ladung: {fKwh(l.sitzungKwh)}</span>
            {zielAn && <span>Ziel +{zahl0(s?.zielEnergieKwh ?? 0)} kWh</span>}
          </div>
          <div className="soc-bar">
            <span style={{ width: `${Math.min(100, (l.sitzungKwh / (zielAn ? s?.zielEnergieKwh ?? 30 : 30)) * 100).toFixed(0)}%` }} />
          </div>
        </div>
      )}
      {m && <WallboxTeil g={g} m={m} busy={busy} oeffne={oeffne} onFahrer={onFahrer} nowMs={r.nowMs} />}
      {wahl === 'smart' && (
        <>
          {!abfahrtStatt && <div className="blk">
            <h3>Womit laden?</h3>
            <Recht aktion="betriebsweise.aendern"><div className="chips" role="group" aria-label="Womit laden">
              {quellen.filter(([, , id]) => frei.has(id)).map(([k, label]) => (
                <button type="button" key={k} aria-pressed={q === k} disabled={busy} onClick={() => onQuelle(g, k)}>{label}</button>
              ))}
            </div></Recht>
            {q === 'guenstig' && !zielAn && s?.preisgrenzeCtKwh != null && <p className="leise">Lädt, solange der Börsenpreis unter {fCt(s.preisgrenzeCtKwh)} liegt.</p>}
            {q === 'min' && <p className="leise">Lädt immer mit mindestens {fKw(s?.mindestleistungKw ?? 1.4)}; was die Sonne mehr liefert, kommt dazu.</p>}
          </div>}
          {abfahrtStatt && m && <AbfahrtZeile g={g} m={m} oeffne={oeffne} nowMs={r.nowMs} />}
          {!abfahrtStatt && zielMoeglich && (
            <button type="button" className="lziel" onClick={(e) => { e.currentTarget.focus(); oeffne({ art: 'ziel', id: g.id }); }}>
              <Ic n="flag" s={20} />
              <span>
                <b>{zielAn ? `+${zahl0(s?.zielEnergieKwh ?? 0)} kWh bis ${zielBis != null ? uhrTag(zielBis) : s?.zielFenster?.bis ?? ''}` : 'Kein Ziel · lädt, wenn es passt'}</b>
                <small>{zielSub}</small>
              </span>
              <Ic n="chevR" s={18} />
            </button>
          )}
          <Zeitband
            id={`lade-${g.id}`}
            t0={r.jetzt}
            t1={t1}
            reihen={bild.reihen}
            jetzt={r.jetzt}
            padT={22}
            tage
            label="Ladeplan der nächsten 24 Stunden"
            bands={[{ art: 'pv', h: 20, gap: 4 }, { art: 'preis', h: 22, gap: 6 }]}
            rows={[zeile]}
            ticks={ticks}
            namen={false}
          />
        </>
      )}
      {m && <ErtragZeile e={ertraege} komponente={g.id} zuErloesen={zuErloesen} />}
    </section>
  );
}

function herkunftWort(bild: SeitenBild, t: number): string {
  const a = quellenAnteil(bild.reihen, t);
  if (!a) return 'lädt';
  if (a.pv >= a.sp && a.pv >= a.netz) return 'mit Sonne';
  return a.sp >= a.netz ? 'aus dem Speicher' : 'aus dem Netz';
}

function mitGemessen(g: GeraetBild, plan: (number | null)[], jetzt: number): (number | null)[] {
  return plan.map((v, t) => (t <= jetzt ? g.kw[t] : v));
}

function VorrangKarte({ config, busy, onVorrang, zuGeraete }: { config: ChargingConfig | null; busy: boolean; onVorrang: (speicherZuerst: boolean) => void; zuGeraete: () => void }) {
  const speicherZuerst = (config?.storagePriority ?? 'speicher_vor_auto') === 'speicher_vor_auto';
  return (
    <section className="card" aria-label="Überschuss zuerst">
      <div className="card-h"><h2><Ic n="sun" s={18} />Wohin geht der Überschuss zuerst?</h2></div>
      <p style={{ margin: '0 0 10px', font: '600 15px/1.45 var(--font)' }}>
        {speicherZuerst ? 'Der Speicher hat Vorrang. Die Autos bekommen, was er nicht aufnimmt.' : 'Die Autos haben Vorrang vor dem Speicher.'}
      </p>
      <Recht aktion="betriebsweise.aendern"><div className="chips" role="group" aria-label="Vorrang">
        <button type="button" aria-pressed={speicherZuerst} disabled={busy} onClick={() => !speicherZuerst && onVorrang(true)}>Speicher zuerst</button>
        <button type="button" aria-pressed={!speicherZuerst} disabled={busy} onClick={() => speicherZuerst && onVorrang(false)}>Autos zuerst</button>
      </div></Recht>
      <button type="button" className="lnk" style={{ marginTop: 6 }} onClick={zuGeraete}>Ganze Reihenfolge ansehen <Ic n="chevR" s={16} /></button>
    </section>
  );
}

function FahrzeugKarte({ fahrzeuge, oeffne, bild, mispel = false }: { fahrzeuge: SiteFahrzeuge | null; oeffne: (b: BlattZustand) => void; bild: SeitenBild; mispel?: boolean }) {
  const namen = (cp: string) => bild.ladepunkte.find((g) => g.ladepunkt?.chargePointId === cp)?.name ?? null;
  const zeilen = fahrzeugZeilen(fahrzeuge, namen, bild.raster.nowMs);
  return (
    <section className="card" aria-label="Fahrzeuge">
      <div className="card-h"><h2><Ic n="car" s={18} />Fahrzeuge</h2><span className="meta">nach Ladekarte</span></div>
      {zeilen.length ? (
        <div className="fz">
          {zeilen.map((z) => (
            <button type="button" key={z.key} className="fz-r" style={{ border: 0, background: 'none', width: '100%', textAlign: 'left', font: 'inherit', color: 'inherit', cursor: 'pointer' }} onClick={(e) => { e.currentTarget.focus(); oeffne({ art: 'fahrzeug', tagRef: z.tagRef }); }}>
              <span className="li"><Ic n={z.benannt ? 'car' : 'help'} s={19} /></span>
              <span>
                <b>{z.name}</b>
                <small>{[z.chip, z.laedt ? 'lädt gerade' : z.sichtung, z.ort].filter(Boolean).join(' · ')}</small>
              </span>
              <Ic n="chevR" s={18} />
            </button>
          ))}
        </div>
      ) : (
        <p className="leise">Noch hat keine Ladekarte hier geladen.</p>
      )}
      {mispel ? (
        // MiSpeL MP-41b: Abfahrt und Reserve gehören dem Ladepunkt, nicht dem Fahrzeug (A1 S. 27, Abschn. 3.2.5).
        <p className="leise">Wer mit dieser Karte lädt, bekommt diese Einstellung. An einem Ladepunkt mit Zurückspeisen gelten Abfahrt und Reserve für jedes Auto, das seinen Ladestand meldet — nicht je Karte; für alle anderen ist ein Ziel eine Menge in kWh.</p>
      ) : (
        <p className="leise">Wer mit dieser Karte lädt, bekommt diese Einstellung. Den Ladestand des Autos kennt VoltPilot nicht; ein Ziel ist deshalb eine Menge in kWh.</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// MiSpeL MP-41b: Wallbox-Karte an einem bidirektionalen Ladepunkt (BK-41 A)
// ---------------------------------------------------------------------------

const STUFEN: [Rueckspeisen, 'x' | 'house' | 'pole', string][] = [['aus', 'x', 'Aus'], ['v2h', 'house', 'Ins Haus'], ['v2g', 'pole', 'Haus + Netz']];

/**
 * Ladestand mit Reserve- und Abfahrtsmarke, „Zurückspeisen: Aus · Ins Haus ·
 * Haus + Netz“ und der Satz dazu. Die Stufen sind die Freigabe des Fahrers
 * (MP-41a § 5a), nie über der Fähigkeit des Ladepunkts (A1 S. 26 Fn. 21);
 * V2H vor V2G steht in der Reihenfolge.
 */
function WallboxTeil({ g, m, busy, oeffne, onFahrer, nowMs }: {
  g: GeraetBild; m: WallboxMispel; busy: boolean; oeffne: (b: BlattZustand) => void;
  onFahrer?: (g: GeraetBild, anfrage: FahrerAnfrage) => Promise<boolean>; nowMs: number;
}) {
  const f = m.fahrer;
  const km = f.km_je_prozent;
  const ab = naechsteAbfahrt(f, nowMs);
  const kannNicht = m.fahrzeug === 'ohne_rueckspeisen';
  return (
    <div className="wb-mispel" data-fahrzeug={m.fahrzeug}>
      {m.ladestandPct != null && (
        <div className="soc wb-soc" data-ladestand={m.ladestandPct}>
          <div className="soc-row wb-soc-k">
            <b>{zahl0(m.ladestandPct)} %</b>
            <span>{[kmZu(m.ladestandPct, km), 'jetzt'].filter(Boolean).join(' · ')}</span>
          </div>
          <div className="soc-bar" role="img" aria-label={`Ladestand ${zahl0(m.ladestandPct)} %${f.reserve_pct != null ? `, Reserve ${zahl0(f.reserve_pct)} %` : ''}${ab ? `, Abfahrt ${zahl0(ab.socPct)} %` : ''}`}>
            <span style={{ width: `${Math.min(100, Math.max(0, m.ladestandPct))}%` }} />
            {f.reserve_pct != null && <i className="res" style={{ width: `${Math.min(100, f.reserve_pct)}%` }} />}
            {ab && <u style={{ left: `${Math.min(100, ab.socPct)}%` }} />}
          </div>
          <div className="soc-row">
            <span>{f.reserve_pct != null ? `Reserve ${zahl0(f.reserve_pct)} %` : 'Keine Reserve'}</span>
            {ab && <span>Abfahrt {zahl0(ab.socPct)} %</span>}
          </div>
        </div>
      )}
      {kannNicht && (
        <div className="lziel wb-hinweis" role="note">
          <Ic n="info" s={20} />
          <span>
            <b>Dieses Auto kann nicht zurückspeisen</b>
            <small>Es lädt wie gewohnt. Ihre Einstellungen gelten wieder, sobald ein Auto mit Rückspeise-Funktion ansteckt.</small>
          </span>
          <span />
        </div>
      )}
      <div className="blk">
        <h3>Zurückspeisen</h3>
        <Recht aktion="ladepunkt.betrieb"><div className="lmodes wb-stufen" role="group" aria-label="Zurückspeisen" style={{ gridTemplateColumns: 'repeat(3,minmax(0,1fr))' }}>
          {STUFEN.map(([k, i, label]) => (
            <button
              type="button"
              key={k}
              data-r={k}
              aria-pressed={f.rueckspeisen === k}
              disabled={busy || kannNicht || !m.traegt[k] || !onFahrer}
              title={!m.traegt[k] ? 'Das kann dieser Ladepunkt nicht; was er kann, trägt der Installateur im Aufbau ein.' : undefined}
              onClick={() => { if (onFahrer && f.rueckspeisen !== k) void onFahrer(g, fahrerAnfrage(f, { rueckspeisen: k })); }}
            >
              <Ic n={i} s={20} />
              {label}
            </button>
          ))}
        </div></Recht>
        <p className="wb-satz">{rueckspeiseSatz(m)}</p>
        {f.rueckspeisen !== 'aus' && !kannNicht && !plantZurueck(g) && (
          <p className="leise" data-hinweis="plant-noch-nicht">Zurückspeisen plant VoltPilot noch nicht; bis dahin lädt das Auto nur.</p>
        )}
        {m.fahrzeug === 'kein_auto' && <p className="leise">Ob ein Auto zurückspeisen kann, prüft die Wallbox beim Anstecken.</p>}
      </div>
      {(m.fahrzeug === 'kein_auto' || m.fahrzeug === 'ohne_ladestand') && (
        <button type="button" className="lziel" data-zeile="abfahrt-reserve" onClick={(e) => { e.currentTarget.focus(); oeffne({ art: 'abfahrt', id: g.id }); }}>
          <Ic n="shield" s={20} />
          <span>
            <b>{f.reserve_pct != null ? `Abfahrt und Reserve · Reserve ${pctKm(f.reserve_pct, km)}` : 'Abfahrt und Reserve festlegen'}</b>
            <small>Gilt, sobald ein Auto mit Rückspeise-Funktion seinen Ladestand meldet. Bis dahin gilt das Ladeziel unten.</small>
          </span>
          <Ic n="chevR" s={18} />
        </button>
      )}
    </div>
  );
}

/** Das Ladeziel eines Autos mit Ladestand: „Abfahrt und Reserve“ (BK-41 A). */
function AbfahrtZeile({ g, m, oeffne, nowMs }: { g: GeraetBild; m: WallboxMispel; oeffne: (b: BlattZustand) => void; nowMs: number }) {
  const z = abfahrtZeile(m.fahrer, nowMs);
  return (
    <button type="button" className="lziel" data-zeile="abfahrt" onClick={(e) => { e.currentTarget.focus(); oeffne({ art: 'abfahrt', id: g.id }); }}>
      <Ic n="flag" s={20} />
      <span>
        <b>{z.titel}</b>
        <small>{z.unter}</small>
      </span>
      <Ic n="chevR" s={18} />
    </button>
  );
}

/** Der Monat am Ladepunkt und der Sprung in Verlauf › Erlöse (BK-41 A, die Karte dort ist MP-41a). */
function ErtragZeile({ e, komponente, zuErloesen }: { e: LadepunktErtraege | null; komponente: string; zuErloesen?: () => void }) {
  const z = ertragZeile(e, komponente);
  if (!z) return null;
  return (
    <button type="button" className="lziel wb-ertrag" data-zeile="ertrag" onClick={() => zuErloesen?.()}>
      <Ic n="euro" s={20} />
      <span>
        <b>{z.titel}</b>
        <small>{z.unter}</small>
      </span>
      <Ic n="chevR" s={18} />
    </button>
  );
}

const WOCHE: [number, string][] = [[1, 'Mo'], [2, 'Di'], [3, 'Mi'], [4, 'Do'], [5, 'Fr'], [6, 'Sa'], [7, 'So']];

/** `JJJJ-MM-TTTHH:MM` in der Zeitzone des Browsers. */
function ortszeitIso(ms: number): string {
  const d = new Date(ms);
  return `${lokalesDatum(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Das Blatt „Abfahrt und Reserve“ (BK-41 A): eine Abfahrt für mehrere
 * Wochentage, Ladestand bei Abfahrt und Reserve in Prozent und Kilometern,
 * „Akku schonen“ in Ladungen am Tag und „nur die nächste Fahrt“. Schreibt
 * die Einstellungen des Fahrers ganz (`PUT …/fahrer-einstellungen`, MP-41a).
 */
export function AbfahrtBlatt({ k, id, ladepunkte, onSpeichern }: {
  k: BlattKontext; id: string; ladepunkte: LadepunktListe | null;
  onSpeichern: (g: GeraetBild, anfrage: FahrerAnfrage) => Promise<boolean>;
}) {
  const g = k.bild.geraete.find((x) => x.id === id);
  const m = g ? wallboxMispel(g, ladepunkte) : null;
  const f = m?.fahrer;
  const erste = f?.abfahrten?.[0] ?? null;
  const [tage, setTage] = useState<number[]>(erste?.wochentage ?? [1, 2, 3, 4, 5]);
  const [um, setUm] = useState<string>(erste?.abfahrt.slice(0, 5) ?? '07:00');
  const [ziel, setZiel] = useState<number>(erste?.abfahrt_soc_pct ?? 80);
  const [reserve, setReserve] = useState<number>(f?.reserve_pct ?? 30);
  const [zyklen, setZyklen] = useState<number | null>(f?.vollzyklen_je_tag ?? null);
  const [einmal, setEinmal] = useState<boolean>(f?.naechste_fahrt != null);
  const [einmalAb, setEinmalAb] = useState<string>(f?.naechste_fahrt?.abfahrt.slice(0, 16) ?? ortszeitIso(k.bild.raster.nowMs + 18 * 3_600_000).slice(0, 11) + '06:00');
  const [einmalZiel, setEinmalZiel] = useState<number>(f?.naechste_fahrt?.abfahrt_soc_pct ?? 100);
  const zielId = useId();
  const reserveId = useId();
  const einmalId = useId();
  if (!g || !m || !f) return null;
  const km = f.km_je_prozent;
  const busy = k.busy === g.id;
  const nowMs = k.bild.raster.nowMs;
  // Höchstens 7 Tage voraus (§ 5a): heute, morgen und die fünf Tage danach als Chips statt eines Datumsfelds.
  const tageVoraus = Array.from({ length: 8 }, (_, i) => {
    const d = new Date(nowMs + i * 24 * 3_600_000);
    const iso = lokalesDatum(d);
    return { iso, label: i === 0 ? 'heute' : i === 1 ? 'morgen' : `${WOCHE[(d.getDay() + 6) % 7][1]} ${iso.slice(8, 10)}.${iso.slice(5, 7)}.` };
  });
  const minEinmal = ortszeitIso(nowMs + 15 * 60_000);
  const maxEinmal = ortszeitIso(nowMs + 7 * 24 * 3_600_000);
  const grund = ziel < reserve ? 'Der Ladestand bei Abfahrt liegt unter der Reserve.'
    : einmal && einmalZiel < reserve ? 'Die nächste Fahrt liegt unter der Reserve.'
      : einmal && (einmalAb < minEinmal || einmalAb > maxEinmal) ? 'Die nächste Fahrt liegt in der Zukunft und höchstens 7 Tage voraus.'
        : !/^\d{2}:\d{2}$/.test(um) ? 'Bitte eine Uhrzeit für die Abfahrt eintragen.' : null;
  const kapazitaet = km != null ? (km * 100) / 6 : null;
  const plan = g.kw.map((v, t) => (g.herkunft[t] === 'plan' && (v ?? 0) > 0.02 ? t : -1)).filter((t) => t >= 0);
  const planSatz = plan.length
    ? `VoltPilot plant das Laden ab ${uhrTag(plan[0])}${plantZurueck(g) ? ' und das Zurückgeben' : ''}.`
    : 'Für dieses Auto liegt noch kein Plan vor.';
  const uebernehmen = async () => {
    const anfrage = fahrerAnfrage(f, {
      reserve_pct: reserve,
      vollzyklen_je_tag: zyklen,
      abfahrten: abfahrtSetzen(f.abfahrten ?? [], { wochentage: tage, abfahrt: um, abfahrt_soc_pct: ziel }),
      naechste_fahrt: einmal ? { abfahrt: einmalAb, abfahrt_soc_pct: einmalZiel } : null,
    });
    if (await onSpeichern(g, anfrage)) k.zu();
  };
  return (
    <Blatt
      symbol="flag"
      titel="Abfahrt und Reserve"
      unter={g.name}
      voll
      onClose={k.zu}
      fuss={
        <Recht aktion="ladepunkt.betrieb">
          <button type="button" className="btn sek" onClick={k.zu}>Abbrechen</button>
          <button type="button" className="btn" disabled={busy || grund != null} onClick={() => void uebernehmen()}>
            <Ic n="check" s={18} />
            {busy ? 'Speichere …' : 'Übernehmen'}
          </button>
        </Recht>
      }
    >
      <div className="blk">
        <h3>Abfahrt</h3>
        <div className="chips" role="group" aria-label="Wochentage">
          {WOCHE.map(([t, kurz]) => (
            <button type="button" key={t} aria-pressed={tage.includes(t)} onClick={() => setTage((x) => (x.includes(t) ? x.filter((y) => y !== t) : [...x, t]))}>{kurz}</button>
          ))}
        </div>
        <VpTimePicker label="losfahren um" ariaLabel="losfahren um" value={um} step={15} onChange={setUm} />
        <p>{tage.length ? `${wochentageText(tage)} um ${um}.` : 'Kein Wochentag gewählt: dann gilt nur „Nur die nächste Fahrt“.'} Andere Tage oder eine Ausnahme: „Nur die nächste Fahrt“ unten.</p>
      </div>
      <div className="blk rng">
        <h3><label htmlFor={zielId}>Ladestand bei Abfahrt</label><span className="meta">{pctKm(ziel, km)}</span></h3>
        <input id={zielId} type="range" min={Math.min(50, ziel)} max={100} step={5} value={ziel} onChange={(e) => setZiel(Number(e.target.value))} />
        <div className="skala"><span>{Math.min(50, ziel)} %</span><span>100 %</span></div>
      </div>
      <div className="blk rng">
        <h3><label htmlFor={reserveId}>Reserve — nie darunter</label><span className="meta">{pctKm(reserve, km)}</span></h3>
        <input id={reserveId} type="range" min={Math.min(10, reserve)} max={Math.max(80, reserve)} step={5} value={reserve} onChange={(e) => setReserve(Number(e.target.value))} />
        <div className="skala"><span>{Math.min(10, reserve)} %</span><span>{Math.max(80, reserve)} %</span></div>
        <p>Davon gibt das Auto nie etwas ab. Ohne Reserve speist es gar nicht zurück.{f.reserve_pct == null ? ' Noch ist keine Reserve gesagt; mit „Übernehmen“ gilt der Wert oben.' : ''}</p>
      </div>
      <div className="blk">
        <h3>Akku schonen</h3>
        <div className="chips" role="group" aria-label="Akku schonen">
          {([[0.5, '½ Ladung'], [1, '1 Ladung'], [2, '2 Ladungen']] as const).map(([v, label]) => (
            <button type="button" key={v} aria-pressed={zyklen === v} onClick={() => setZyklen(zyklen === v ? null : v)}>{label}</button>
          ))}
        </div>
        <p>
          höchstens so viel am Tag zurückgeben{kapazitaet != null ? ` (1 Ladung = ${zahl0(kapazitaet)} kWh)` : ''}. Verschleiß geschätzt 3 ct je kWh — VoltPilot gibt nur zurück, wenn es mehr bringt.
          {zyklen == null ? ' Nicht gesagt: VoltPilot rechnet mit 1 Ladung.' : ''}
        </p>
      </div>
      <div className="blk">
        <h3>Plan</h3>
        <div className="warum">{planSatz}{f.rueckspeisen !== 'aus' && !plantZurueck(g) ? ' Zurückspeisen plant VoltPilot noch nicht.' : ''}</div>
      </div>
      <div className="blk">
        <h3>Nur die nächste Fahrt</h3>
        <button type="button" className="lziel" aria-pressed={einmal} onClick={() => setEinmal((x) => !x)}>
          <Ic n="clock" s={20} />
          <span>
            <b>{einmal ? `${einmalAb.slice(8, 10)}.${einmalAb.slice(5, 7)}. ${einmalAb.slice(11, 16)} mit ${pctKm(einmalZiel, km)}` : 'Nur die nächste Fahrt'}</b>
            <small>{einmal ? 'Tippen zum Entfernen — danach gilt wieder der Plan oben' : 'z. B. „morgen 05:30 mit 100 %“ — danach gilt wieder der Plan oben'}</small>
          </span>
          <Ic n={einmal ? 'x' : 'plus'} s={18} />
        </button>
        {einmal && (
          <>
            <div className="chips" role="group" aria-label="Tag der nächsten Fahrt">
              {tageVoraus.map((d) => (
                <button type="button" key={d.iso} aria-pressed={einmalAb.slice(0, 10) === d.iso} onClick={() => setEinmalAb(`${d.iso}T${einmalAb.slice(11, 16)}`)}>{d.label}</button>
              ))}
            </div>
            <VpTimePicker label="losfahren um" ariaLabel="nächste Fahrt um" value={einmalAb.slice(11, 16)} step={15} onChange={(z) => setEinmalAb(`${einmalAb.slice(0, 10)}T${z}`)} />
            <div className="rng">
              <h3 style={{ margin: 0 }}><label htmlFor={einmalId}>mit</label><span className="meta">{pctKm(einmalZiel, km)}</span></h3>
              <input id={einmalId} type="range" min={Math.min(50, einmalZiel)} max={100} step={5} value={einmalZiel} onChange={(e) => setEinmalZiel(Number(e.target.value))} />
            </div>
          </>
        )}
      </div>
      {grund && <div className="konflikt" role="alert"><Ic n="alert" s={18} /><span>{grund}</span></div>}
    </Blatt>
  );
}

// ---------------------------------------------------------------------------
// Blätter des Reiters
// ---------------------------------------------------------------------------

const ZIEL_ZEITEN = ['06:00', '07:00', '08:00', '16:00', '18:00'];

export function ZielBlatt({ k, id, onSpeichern }: { k: BlattKontext; id: string; onSpeichern: (g: GeraetBild, w: SteuerartWunsch) => Promise<boolean> }) {
  const g = k.bild.geraete.find((x) => x.id === id);
  const s = g?.steuerart;
  const [kwh, setKwh] = useState<number>(typeof s?.zielEnergieKwh === 'number' ? s.zielEnergieKwh : 20);
  const [bis, setBis] = useState<string>(s?.zielFenster?.bis ?? '07:00');
  const [quelle, setQuelle] = useState<'ueberschuss' | 'guenstig'>(s?.quelle === 'guenstig' ? 'guenstig' : 'ueberschuss');
  if (!g) return null;
  const r = k.bild.raster;
  const bisT = naechsteUhrzeit(r.jetzt, bis);
  const kw = g.nennKw ?? 11;
  const plan = ladeplan(k.bild.reihen, r.jetzt, bisT, kwh, kw, quelle === 'guenstig');
  const t1 = Math.min(N, Math.max(bisT + 4, r.jetzt + 24));
  const schritt = t1 - r.jetzt <= 48 ? 8 : 16;
  const ticks: number[] = [];
  for (let x = 0; x <= t1 - r.jetzt; x++) if ((r.jetzt + x) % schritt === 0) ticks.push(x);
  const vorlaeufig = bisT >= TAG && !k.bild.reihen.morgenBekannt;
  const busy = k.busy === g.id;
  const wunsch = (mitZiel: boolean): SteuerartWunsch => ({
    quelle,
    ...(quelle === 'ueberschuss' ? { ueberschussModus: s?.ueberschussModus ?? 'pausieren' } : {}),
    ...(quelle === 'guenstig' && s?.preisgrenzeCtKwh != null ? { preisgrenzeCtKwh: s.preisgrenzeCtKwh } : {}),
    ...(mitZiel ? { ziel: 'bis_uhrzeit', zielEnergieKwh: kwh, zielFenster: { tage: 'daily', von: '', bis } } : {}),
  });
  return (
    <Blatt
      symbol="flag"
      titel="Ladeziel"
      unter={g.name}
      voll
      onClose={k.zu}
      fuss={
        <Recht aktion="betriebsweise.aendern">
          {s?.ziel ? (
            <button type="button" className="btn sek" disabled={busy} onClick={async () => { if (await onSpeichern(g, wunsch(false))) k.zu(); }}>Kein Ziel</button>
          ) : (
            <button type="button" className="btn sek" onClick={k.zu}>Abbrechen</button>
          )}
          <button type="button" className="btn" disabled={busy} onClick={async () => { if (await onSpeichern(g, wunsch(true))) k.zu(); }}>
            <Ic n="check" s={18} />
            {busy ? 'Speichere …' : 'Ziel übernehmen'}
          </button>
        </Recht>
      }
    >
      <div className="blk">
        <h3>Wie viel?</h3>
        <div className="chips">
          {[10, 20, 30, 40].map((v) => (
            <button type="button" key={v} aria-pressed={kwh === v} onClick={() => setKwh(v)}>+{v} kWh</button>
          ))}
        </div>
        <p>Etwa {zahl0(kwh * 6)} km. Den Ladestand des Autos kennt VoltPilot nicht; deshalb eine Menge.</p>
      </div>
      <div className="blk">
        <h3>Bis wann?</h3>
        <div className="chips">
          {ZIEL_ZEITEN.map((z) => (
            <button type="button" key={z} aria-pressed={bis === z} onClick={() => setBis(z)}>{naechsteUhrzeit(r.jetzt, z) >= TAG ? 'morgen ' : 'heute '}{z}</button>
          ))}
        </div>
      </div>
      <div className="blk">
        <h3>Womit?</h3>
        <div className="chips">
          <button type="button" aria-pressed={quelle === 'ueberschuss'} onClick={() => setQuelle('ueberschuss')}>Sonne zuerst, dann günstig</button>
          <button type="button" aria-pressed={quelle === 'guenstig'} onClick={() => setQuelle('guenstig')}>nur günstige Stunden</button>
        </div>
      </div>
      {!g.ladepunkt?.angesteckt ? (
        <div className="blk">
          <h3>Plan</h3>
          <div className="warum">Kein Auto angesteckt. Das Ziel gilt ab der nächsten Ladung; VoltPilot plant sie, sobald ein Auto ansteckt.</div>
        </div>
      ) : (
      <div className="blk">
        <h3>Plan <span className="meta" style={{ textTransform: 'none', letterSpacing: 0 }}>Schätzung</span></h3>
        <Zeitband
          id={`z-${g.id}`}
          t0={r.jetzt}
          t1={t1}
          reihen={k.bild.reihen}
          jetzt={r.jetzt}
          padT={22}
          tage
          label="Ladeplan bis zum Ziel"
          bands={[{ art: 'pv', h: 18, gap: 4 }, { art: 'preis', h: 26, gap: 6 }]}
          rows={[{ g, h: 20, kw: plan.kw }]}
          ticks={ticks}
          namen={false}
        />
        <div className="prev-sum">
          <div><b>{plan.fertig != null ? uhrTag(plan.fertig) : '—'}</b><small>voraussichtlich fertig</small></div>
          <div><b>{fKwh(plan.kwh)}</b><small>{plan.kwh ? `${fPct((plan.pvKwh / plan.kwh) * 100)} Sonne` : ''}</small></div>
          <div><b>{plan.netzKwh > 0.05 ? fCt((plan.eur * 100) / plan.netzKwh) : '—'}</b><small>Ø Börse im Netzanteil</small></div>
        </div>
        {!plan.schafft && (
          <div className="konflikt"><Ic n="alert" s={18} /><span>Das reicht nicht ganz: bis {uhrTag(bisT)} passen {fKwh(plan.kwh)}. Früher anstecken oder später abfahren hilft.</span></div>
        )}
        {vorlaeufig && (
          <div className="konflikt"><Ic n="info" s={18} /><span>Vorläufig: Die Börsenpreise für morgen kommen gegen 13 Uhr. Dann plant VoltPilot neu.</span></div>
        )}
        <p className="leise">Die Box plant die Ladung selbst; das Bild ist eine Schätzung aus Prognose und Preis. Kommt das Auto später oder fährt früher, gilt das Ziel für die nächste Ladung.</p>
      </div>
      )}
    </Blatt>
  );
}

/**
 * Das Rahmen-Blatt: die Anschlussgrenze gehört dem Kunden, der Rest ist von der
 * Box vorgegeben. Die Grenze schreibt der Kunden-Schritt `PUT /charging-frame`
 * (AP-01 IP-13): er prüft sie gegen den heute gebundenen Netzanschluss, die
 * Grundlast der letzten 7 Tage und die Hausreserve und lehnt mit 422 ab. Das
 * Blatt zeigt denselben Grund schon vorher und sperrt „Übernehmen“. Ohne
 * Bindung gilt der Übergang: die vereinbarte Leistung kommt aus dem Blatt.
 */
export function RahmenBlatt({ k, siteId, rahmen, config, onGrenze }: {
  k: BlattKontext; siteId: string; rahmen: LadeparkRahmen | null; config: ChargingConfig | null;
  onGrenze: (kw: number, vereinbartKw?: number) => Promise<boolean>;
}) {
  const start = config?.gridLimitKw ?? rahmen?.gepflegteGrenzeKw ?? rahmen?.netzanschlussKw ?? null;
  const [kw, setKw] = useState<number | null>(start);
  const anschluss = useAnschluss(siteId);
  const [uebergang, setUebergang] = useState('');
  const [uebergangBeruehrt, setUebergangBeruehrt] = useState(false);
  const uebergangRef = useRef<HTMLInputElement>(null);
  const uebergangId = useId();
  const geaendert = kw != null && kw !== start;
  const ungebunden = anschluss.zustand === 'ungebunden';
  const uebergangKw = parseDecimal(uebergang);
  const uebergangFehlt = ungebunden && (uebergangKw == null || uebergangKw <= 0);
  const grundlastKw = config?.frame?.maxHouseLoadKw ?? null;
  const reserveKw = config?.frame?.houseReserveKw ?? null;
  const einwand = grenzePruefung(kw, anschluss, uebergangKw, grundlastKw, reserveKw);
  const budgetKw = ladebudgetKw(kw, grundlastKw, reserveKw);
  const zeilen: [string, string][] = [];
  if (rahmen?.sicherheitsabstandPct != null) zeilen.push(['Sicherheitsabstand', fPct(rahmen.sicherheitsabstandPct)]);
  if (rahmen?.mindestleistungKw != null) zeilen.push(['Mindestleistung je Auto', fKw(rahmen.mindestleistungKw)]);
  if (config?.frame?.rotationMinutes != null) zeilen.push(['Wechsel bei knapper Leistung', `alle ${config.frame.rotationMinutes} Min`]);
  if (rahmen?.modus) zeilen.push(['Budget', rahmen.modus === 'measured' || rahmen.modus === 'metered' ? 'gemessen am Netzanschluss' : 'fest']);
  zeilen.push(['§ 14a EnWG', 'Grenze gilt dann für alle']);

  async function uebernehmen() {
    if (kw == null) return;
    if (uebergangFehlt) {
      setUebergangBeruehrt(true);
      uebergangRef.current?.focus();
      return;
    }
    if (await onGrenze(kw, ungebunden && uebergangKw != null ? uebergangKw : undefined)) k.zu();
  }

  return (
    <Blatt
      symbol="gauge"
      titel="Netzanschluss und Laden"
      unter="Ladepark-Rahmen"
      onClose={k.zu}
      fuss={geaendert ? (
        <>
          <button type="button" className="btn sek" onClick={() => { setKw(start); setUebergangBeruehrt(false); }}>Abbrechen</button>
          <Recht aktion="grenze.eintragen"><button type="button" className="btn" disabled={k.busy === 'rahmen' || anschluss.zustand === 'laden' || einwand != null} onClick={() => void uebernehmen()}>
            <Ic n="check" s={18} />
            Übernehmen
          </button></Recht>
        </>
      ) : null}
    >
      <div className="blk">
        <h3>Anschlussgrenze</h3>
        <div className="param">
          <div className="prow">
            <span>Ihr Netzanschluss<small>gehört Ihnen; VoltPilot hält ihn ein</small></span>
            <Recht aktion="grenze.eintragen">
              <span className="stp">
                <button type="button" aria-label="weniger" onClick={() => setKw(Math.max(6, (kw ?? 22) - 1))}><Ic n="minus" s={18} /></button>
                <output>{kw != null ? fKw(kw) : '—'}</output>
                <button type="button" aria-label="mehr" onClick={() => setKw(Math.min(400, (kw ?? 21) + 1))}><Ic n="plus" s={18} /></button>
              </span>
            </Recht>
          </div>
          {ungebunden && geaendert && (
            <div className="prow">
              <span><label htmlFor={uebergangId}>Vereinbarte Leistung (kW)</label></span>
              <input
                ref={uebergangRef}
                id={uebergangId}
                className="zahl"
                inputMode="decimal"
                value={uebergang}
                onChange={(e) => { setUebergang(e.target.value); setUebergangBeruehrt(true); }}
                aria-invalid={uebergangBeruehrt && uebergangFehlt ? true : undefined}
              />
            </div>
          )}
        </div>
        <div className="pruefung" aria-label="Plausibilitätsprüfung der Anschlussgrenze">
          {anschluss.zustand === 'laden' && <p className="leise">Netzanschluss wird geprüft …</p>}
          {anschluss.zustand === 'fehler' && <p className="leise">Der Netzanschluss konnte nicht geladen werden.</p>}
          {anschluss.zustand === 'gebunden' && (
            <p className="leise">
              {anschluss.vereinbartKw == null
                ? `Netzanschluss ${anschluss.kennzeichen}: vereinbarte Leistung fehlt.`
                : `Netzanschluss ${anschluss.kennzeichen}: ${kwVereinbart(anschluss.vereinbartKw)} vereinbart.`}
            </p>
          )}
          {ungebunden && (
            <p className="leise">Heute ist kein Netzanschluss gebunden. Tragen Sie für den Übergang die vereinbarte Leistung im Dialog ein.</p>
          )}
          {grundlastKw != null && reserveKw != null && (
            <p className="leise">
              Grundlast der letzten 7 Tage {kwVereinbart(grundlastKw)} · Hausreserve {kwVereinbart(reserveKw)}
              {budgetKw != null && budgetKw > 0 ? ` · Ladebudget ${kwVereinbart(budgetKw)}` : ''}
            </p>
          )}
          {uebergangBeruehrt && uebergangFehlt && geaendert && <p className="stn-fehler">Tragen Sie die vereinbarte Leistung ein.</p>}
          {einwand && <p className="stn-fehler">{einwand}</p>}
        </div>
      </div>
      <div className="blk">
        <h3>Verteilung auf die Ladepunkte</h3>
        <p>Reicht die Leistung nicht für alle, bekommt der obere Ladepunkt der Reihenfolge zuerst. Keines lädt unter seiner Mindestleistung; bei knapper Leistung wechseln die Autos sich ab.</p>
      </div>
      {zeilen.length > 0 && (
        <div className="blk">
          <h3>Von der Box vorgegeben</h3>
          <div className="bed">
            {zeilen.map(([a, b]) => (
              <div className="prow" key={a} style={{ borderBottom: '1px solid var(--c-border)' }}><span>{a}</span><b>{b}</b></div>
            ))}
          </div>
          <p>Diese Werte stellt Ihr Installateur ein. Sie gelten auch, wenn die Cloud nicht erreichbar ist.</p>
        </div>
      )}
    </Blatt>
  );
}

/** Der heute gebundene Netzanschluss der Anlage - gelesen, sobald das Rahmen-Blatt aufgeht. */
function useAnschluss(siteId: string): AnschlussStand {
  const [stand, setStand] = useState<AnschlussStand>({ zustand: 'laden' });
  useEffect(() => {
    let aktiv = true;
    const heute = lokalesDatum(new Date());
    api.siteDetail(siteId)
      .then(async (detail): Promise<AnschlussStand> => {
        if (!detail.standort) return { zustand: 'ungebunden' };
        const liste = await api.netzanschluesse(detail.standort.id, heute);
        return heutigerAnschluss(liste.netzanschluesse, siteId, heute);
      })
      .then(
        (s) => { if (aktiv) setStand(s); },
        () => { if (aktiv) setStand({ zustand: 'fehler' }); },
      );
    return () => { aktiv = false; };
  }, [siteId]);
  return stand;
}

export function FahrzeugBlatt({ k, tagRef, fahrzeuge, onSetzen }: {
  k: BlattKontext; tagRef: string; fahrzeuge: SiteFahrzeuge | null;
  onSetzen: (tagRef: string, w: { name?: string; quelle?: 'sofort' | 'ueberschuss' | '' }) => Promise<boolean>;
}) {
  const f = liste(fahrzeuge?.fahrzeuge).find((x) => x.tagRef === tagRef);
  const [name, setName] = useState(f?.name ?? '');
  if (!f) return null;
  const q = f.steuerart?.quelle ?? null;
  const busy = k.busy === `fz:${tagRef}`;
  return (
    <Blatt
      symbol="car"
      titel={fahrzeugName(f)}
      unter="Einstellung für diese Ladekarte"
      onClose={k.zu}
      fuss={
        <Recht aktion="ladepunkt.betrieb"><button type="button" className="btn" disabled={busy} onClick={async () => {
          if (name.trim() !== (f.name ?? '')) { if (await onSetzen(tagRef, { name: name.trim() })) k.zu(); } else k.zu();
        }}>
          Fertig
        </button></Recht>
      }
    >
      <div className="blk">
        <h3>Name</h3>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="z. B. Familienauto"
          aria-label="Name des Fahrzeugs"
          style={{ minHeight: 46, borderRadius: 12, border: '1px solid var(--field)', padding: '0 12px', font: '600 16px var(--font)', width: '100%' }}
        />
      </div>
      <div className="blk">
        <h3>Wenn diese Karte lädt</h3>
        <Recht aktion="ladepunkt.betrieb"><div className="chips">
          <button type="button" aria-pressed={q == null} disabled={busy} onClick={() => void onSetzen(tagRef, { quelle: '' })}>wie der Ladepunkt</button>
          <button type="button" aria-pressed={q === 'ueberschuss'} disabled={busy} onClick={() => void onSetzen(tagRef, { quelle: 'ueberschuss' })}>Smart</button>
          <button type="button" aria-pressed={q === 'sofort'} disabled={busy} onClick={() => void onSetzen(tagRef, { quelle: 'sofort' })}>Schnell</button>
        </div></Recht>
        <p>„Smart“ lädt mit Sonnenstrom, „Schnell“ sofort mit voller Leistung. Ohne Wahl gilt die Einstellung des Ladepunkts.</p>
      </div>
    </Blatt>
  );
}
