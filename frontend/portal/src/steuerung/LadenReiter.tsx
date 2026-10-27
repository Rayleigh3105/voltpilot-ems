/**
 * Reiter „Laden“: der EINE Ort für jeden Ladepunkt (Konzept „Ein Ort fürs
 * Laden" e1, Scheibe 1) - Netzanschluss, je Ladepunkt eine Bühne (Zustand und
 * Herkunft in Klartext), Aus · Smart · Schnell (schaltet NUR hier), Womit
 * laden, Ladeziel, Ladungen (kWh), Vorrang vor dem Speicher, Autos, eine
 * Technik-Zeile zur Geräteseite.
 */
import { liste } from './liste';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { api, type ChargingConfig, type Device, type OcppTransactionEconomics } from '../api';
import { Recht } from '../components/Recht';
import { GeraetBuehne } from '../components/GeraetBuehne';
import { LADEPUNKT_MODUS, LADEPUNKT_UNGESTEUERT, LADEQUELLE, LADEQUELLE_VERSPRECHEN } from '../glossar';
import { useRollen } from '../rollen';
import { LADEPUNKT_ABSTECKEN_DECKEL_TEXT, type LadepunktSperre, type SpeicherFreigabe } from '../ladepunkte';
import type { SiteFahrzeuge } from '../fahrzeugProfile';
import { fahrzeugName, fahrzeugZeilen, kartenKurz } from '../fahrzeugProfile';
import type { LadeparkRahmen } from '../verbraucherZone';
import type { SteuerartWunsch } from '../steuerartDialog';
import { parseDecimal } from '../zahl';
import { ladeCsv } from '../ladeCsv';
import { boxRefOf, chargerGeraetId } from '../geraetAdresse';
import { geraetSeiteHash } from '../nav';
import { Blatt } from './Blatt';
import type { BlattKontext } from './Blaetter';
import { quellenAnteil, type GeraetBild } from './bild';
import { ladungenCsv, ladungenSumme, ladungenZeilen } from './ladungen';
import { Ic } from './Ic';
import {
  OPTION_SONNE_SPEICHER, band, bandBremst, grenzePruefung, heutigerAnschluss, kwVereinbart, ladebudgetKw,
  ladeQuelle, ladeWahl, lokalesDatum, naechsteUhrzeit, speicherZeile, type AnschlussStand,
} from './laden';
import { DreiZahlen, QuelleZeichen, VorschauBand, startEntwurf, wunschAus } from './LadeWahl';
import { kwhText, mitAuto, uhrKurz, vorschauFuer, vorschauSaetze, type VorschauAnlage } from './ladeVorschau';
import { rueckmeldung, type Gesendet } from './rueckmeldung';
import type { BlattZustand, SeitenBild } from './seite';
import { TAG, fCt, fEur, fKw, fKwh, fPct, uhrTag, uhrVon, zahl0 } from './zeit';
// `RahmenBlatt` ist seit „Ein Ort fürs Laden" Scheibe 4 auch außerhalb der Steuerung mountbar
// (Einstellungen, `components/AnschlussgrenzeBlatt.tsx`) - diese Datei bringt ihre eigene
// Styling-Abhängigkeit deshalb selbst mit, statt sich auf `SteuerungSeite.tsx`s Import zu
// verlassen (Bündler dedupliziert dieselbe Datei; sonst rendert das Blatt dort ohne Höhen-/
// Z-Index-Regel und der Sektionsleiste läuft über sie hinweg).
import './steuerung.css';

export interface LadenReiterProps {
  siteId: string;
  bild: SeitenBild;
  rahmen: LadeparkRahmen | null;
  config: ChargingConfig | null;
  fahrzeuge: SiteFahrzeuge | null;
  busy: string | null;
  oeffne: (b: BlattZustand) => void;
  onSmart: (g: GeraetBild) => void;
  onVorrang: (speicherZuerst: boolean) => void;
  onLadevorgaenge: () => void;
  zuGeraete: () => void;
  /** „Sonne + Speicher“: was die Box gerade freigibt (null = keine Meldung). */
  release?: SpeicherFreigabe | null;
  /** Wann die Box zuletzt gemeldet hat (`ChargingBudget.reportedAt`). */
  releaseGemeldet?: string | null;
  /** „Sonne + Speicher“: die Reserve der Anlage setzen (null = Vorgabe). */
  onReserve?: (kwh: number | null) => void;
  /** Was die Vorschau von der Anlage braucht (Speicher, Vorrang, Startleistung). */
  anlage: VorschauAnlage;
  /** Je Ladepunkt die zuletzt gesendete Wahl dieser Sitzung (Rückmeldung in drei Schritten). */
  gesendet: Record<string, Gesendet>;
  /** Für die Technik-Zeile (§4.3): der Weg zur Geräteseite der Wallbox. */
  devices?: Device[];
  /** Für „Ladungen" (§4.1 Punkt 5 / §4.4, Scheibe 2): die Ladungen aller Ladepunkte, mit Herkunft und Geld. */
  economics?: OcppTransactionEconomics[] | null;
}

export function LadenReiter(p: LadenReiterProps) {
  const { bild } = p;
  const lp = bild.ladepunkte;
  const boxRef = boxRefOf(p.devices, p.siteId);
  // Die Anschlussgrenze wohnt seit „Ein Ort fürs Laden" Scheibe 4 (E5 = A) in
  // den Einstellungen - hier bleibt NUR ein Satz, und nur, solange sie
  // tatsächlich bremst (`bandBremst`). Kein Rahmen-Knopf, keine Karte mehr.
  const bremstSatz = bandBremst(band(p.rahmen, bild.ladepunkte, bild.reihen, bild.raster.jetzt));
  return (
    <>
      {bremstSatz && (
        <section className="card" aria-label="Netzanschluss">
          <p className="leise">Mehr lässt Ihr Hausanschluss gerade nicht zu.</p>
        </section>
      )}
      {lp.map((g) => (
        <LadeKarte
          key={g.id} g={g} bild={bild} fahrzeuge={p.fahrzeuge} busy={p.busy === g.id} oeffne={p.oeffne}
          onSmart={p.onSmart} release={p.release ?? null} releaseGemeldet={p.releaseGemeldet ?? null}
          anlage={p.anlage} gesendet={p.gesendet[g.id] ?? null} siteId={p.siteId} boxRef={boxRef}
          economics={p.economics ?? null}
        />
      ))}
      {!lp.length && (
        <section className="card">
          <p className="leise">Noch ist kein Ladepunkt mit dieser Anlage verbunden. Ladepunkte legen Sie in der Anlage an; hier erscheinen sie von selbst.</p>
        </section>
      )}
      {bild.speicher && <VorrangKarte config={p.config} busy={p.busy === 'vorrang'} onVorrang={p.onVorrang} zuGeraete={p.zuGeraete} />}
      {bild.speicher && p.onReserve && speicherAngeboten(lp) && p.config?.storageReleaseReserveStandardKwh != null && (
        <ReserveKarte standard={p.config.storageReleaseReserveStandardKwh} eigen={p.config.storageReleaseReserveKwh ?? null}
          busy={p.busy === 'reserve'} onReserve={p.onReserve} />
      )}
      <FahrzeugKarte fahrzeuge={p.fahrzeuge} oeffne={p.oeffne} bild={bild} />
      <section className="card immer">
        <button type="button" className="immer-r" onClick={p.onLadevorgaenge}>
          <span className="li"><Ic n="history" s={18} /></span>
          <span className="lt">Ladevorgänge<small>Was gerade lädt, mit Leistung und Karte</small></span>
          <Ic n="chevR" s={18} />
        </button>
      </section>
    </>
  );
}

function LadeKarte({
  g, bild, fahrzeuge, busy, oeffne, onSmart, release, releaseGemeldet, anlage, gesendet, siteId, boxRef, economics,
}: {
  g: GeraetBild; bild: SeitenBild; fahrzeuge: SiteFahrzeuge | null; busy: boolean;
  oeffne: (b: BlattZustand) => void; onSmart: (g: GeraetBild) => void;
  release: SpeicherFreigabe | null; releaseGemeldet: string | null;
  anlage: VorschauAnlage; gesendet: Gesendet | null;
  siteId: string; boxRef: string | null; economics: OcppTransactionEconomics[] | null;
}) {
  const rollen = useRollen();
  const r = bild.raster;
  const l = g.ladepunkt;
  const wahl = ladeWahl(g);
  const q = ladeQuelle(g);
  const an = g.an === true;
  // Der Anlagen-Standard eines Ladepunkts, dessen Kunde nie gewählt hat (E5=A): ehrlich „immer sofort voll“.
  const ungesteuert = !g.eingriff && g.steuerart?.quelle === 'sofort';
  const karte = l?.karte ? liste(fahrzeuge?.fahrzeuge).find((f) => f.tagRef === l.karte) ?? null : null;
  // Regelt VoltPilot diese Wallbox gerade gar nicht? (Audit W-01/W-05/W-12)
  const sperre = l?.sperre ?? null;
  const stumm = sperre?.kind === 'getrennt' || sperre?.kind === 'nie_gemeldet';
  // ⚠ Ein volles Auto (SuspendedEV) bekommt keine Ladeankündigung (Audit W-21).
  const autoPausiert = l?.zustand?.kind === 'auto_pausiert' ? l.zustand : null;
  let sub: string;
  if (stumm) sub = 'Ob ein Auto steckt, ist gerade unbekannt';
  else if (l?.angesteckt) {
    const kurzKarte = l.karte ? kartenKurz(l.karte) : '';
    const wer = [karte?.name?.trim() || null, kurzKarte ? `Karte ${kurzKarte}…` : null].filter(Boolean).join(' · ') || (karte ? fahrzeugName(karte) : 'Ein Auto');
    sub = `${wer}${l.sitzungSeit ? ` · angesteckt seit ${uhrVon(r, Date.parse(l.sitzungSeit))}` : ''}`;
  } else sub = 'Kein Auto angesteckt';
  const platz = bild.rang.indexOf(g.id) + 1;
  const ansage = wahl === 'aus'
    ? `Pausiert${g.eingriff?.bisMs != null ? ` bis ${uhrVon(r, g.eingriff.bisMs)}` : ` bis zum Abstecken, höchstens ${LADEPUNKT_ABSTECKEN_DECKEL_TEXT}`}. Danach wieder Smart.`
    : wahl === 'schnell' && !ungesteuert
      ? 'Lädt so schnell es geht, nur für diese Ladung. Netzstrom erlaubt.'
      : null;
  const s = g.steuerart;
  const zielAn = s?.ziel === 'bis_uhrzeit' && typeof s.zielEnergieKwh === 'number';
  const zielMoeglich = liste(g.eintrag.optionen?.ziele).some((z) => z.id === 'bis_uhrzeit' && !z.gesperrt);
  let zielSub = 'Ziel setzen';
  let zielBis: number | null = null;
  if (zielAn && s?.zielFenster?.bis) {
    const bis = naechsteUhrzeit(r.jetzt, s.zielFenster.bis);
    zielBis = bis;
  }
  const entwurf = q ? startEntwurf(g) : null;
  const vor = entwurf ? vorschauFuer(bild, g, anlage, entwurf) : null;
  if (zielAn && zielBis != null) {
    // Der Fahrplan hat Vorrang; die Schätzung nur, wo er fehlt und ein Auto steckt.
    const geplant = g.herkunft.some((h, t) => h === 'plan' && t > r.jetzt);
    let fertig: number | null = null;
    if (geplant) {
      for (let t = r.jetzt; t < zielBis; t++) if ((g.kw[t] ?? 0) > 0.02) fertig = t + 1;
    } else if (l?.angesteckt && vor?.vorschau.schafft) fertig = vor.vorschau.fertig;
    zielSub = sperre ? 'wirkt gerade nicht' : fertig != null ? `fertig voraussichtlich ${uhrTag(fertig)}` : !l?.angesteckt ? 'sobald ein Auto ansteckt' : 'reicht laut Schätzung nicht ganz';
  }
  const saetze = vor ? vorschauSaetze(vor.vorschau, vor.abfahrt) : null;
  // ⚠ Nimmt die Wallbox keine Ladegrenzen an, ist jede Ladewahl eine leere Zusage (Audit W-05).
  const darf = rollen.darf('betriebsweise.aendern') && sperre?.kind !== 'keine_grenzen';
  const oeffneWahl = (e: { currentTarget: HTMLElement }) => { e.currentTarget.focus(); oeffne({ art: 'womit', id: g.id }); };
  const zeilen = gesendet ? rueckmeldung(l, gesendet, r.nowMs, (ms) => uhrVon(r, ms)) : null;
  // ⚠ Die Bühne (Konzept „Ein Ort fürs Laden" e1, §4.1 Punkt 1): „der Strom
  // läuft in der Farbe seiner Herkunft". Nur beim Laden selbst - pausiert/
  // ohne Auto zeigt sie die ruhige Spur, nie eine erfundene Quelle.
  const herkunft = an ? herkunftArt(bild, r.jetzt) : null;
  const hw = herkunftWort(bild, r.jetzt);
  const buehneSatz = stumm
    ? sub
    : !l?.angesteckt
      ? 'Kein Auto angesteckt'
      : an
        ? (hw === 'lädt' ? 'Lädt' : `Lädt ${hw}`)
        : wahl === 'aus'
          ? 'Pausiert'
          : 'Wartet';
  const ladungenMonat = ladungenZeilen(economics, l?.chargePointId ?? '');
  const ladungen = ladungenMonat.slice(0, 3);
  const summe = ladungenSumme(ladungenMonat);
  const technikHref = boxRef ? geraetSeiteHash(siteId, boxRef, chargerGeraetId(l?.chargePointId ?? '')) : null;
  return (
    <section className={`card lp-card${bild.funktion.angehalten ? ' matt' : ''}`} aria-label={g.name}>
      {/* ⚠ Die Sperre sagt `SperreHinweis` gleich darunter mit Satz UND Folge als
          EIGENER `role="status"` - die Bühne nennt sie hier nicht zusätzlich
          (zwei Status-Flächen mit demselben Satz war der Befund). */}
      <GeraetBuehne
        zahl={an && g.jetztKw != null ? { zahl: String(Math.round(g.jetztKw * 10) / 10).replace('.', ','), einheit: 'kW', wort: null, ton: 'ok', key: 'kw' } : null}
        satz={buehneSatz}
        satzTon={sperre ? 'warn' : 'ok'}
        grafik={{ art: 'wallbox', kw: g.jetztKw ?? null, laedt: an, herkunft, angesteckt: !!l?.angesteckt }}
      />
      <div className="lp-h">
        <span className={`ico${an ? ' on' : ''}`}><Ic n="car" s={26} /></span>
        <span className="t">
          <b>{g.name}</b>
          <small>{sub}</small>
        </span>
        <span className="lp-kw">
          {an && g.jetztKw != null ? fKw(g.jetztKw) : '—'}
          <small>{an ? herkunftWort(bild, r.jetzt) : stumm ? 'keine Verbindung' : l?.angesteckt ? g.pill[1] : 'kein Auto'}</small>
        </span>
      </div>
      <Recht aktion="handeingriff.setzen"><div className="lmodes" role="group" aria-label="Lademodus" style={{ gridTemplateColumns: 'repeat(3,minmax(0,1fr))' }}>
        {([['aus', 'pause', LADEPUNKT_MODUS.aus], ['smart', 'sun', LADEPUNKT_MODUS.smart], ['schnell', 'rocket', LADEPUNKT_MODUS.schnell]] as const).map(([k, i, label]) => (
          <button
            type="button"
            key={k}
            data-m={k}
            aria-pressed={wahl === k}
            // ⚠ Unter einer Sperre bleibt nur der Rückweg eines laufenden Eingriffs („Smart“).
            // ⚠ „Schnell“ ist derselbe `POST /charging-boost` wie auf *Ladevorgänge* und im
            // Menü „Eingreifen“ - EINE Regel (`boostbar`) für alle drei Flächen, sonst zeigt
            // dieselbe Anlage gleichzeitig „anbietbar" und „gesperrt" (Audit, Befund 3).
            disabled={busy || (sperre != null && !(k === 'smart' && g.eingriff)) || (k !== 'smart' && (!l?.angesteckt || bild.funktion.sperre != null))
              || (k === 'schnell' && !ungesteuert && wahl !== 'schnell' && !(l?.boostbar ?? false))}
            onClick={(e) => {
              e.currentTarget.focus();
              if (k === 'smart') { if (wahl !== 'smart') onSmart(g); return; }
              oeffne({ art: 'geraet', id: g.id, modus: k === 'aus' ? 'aus' : 'an' });
            }}
          >
            <Ic n={i} s={20} />
            {label}
            {k === 'schnell' && <small>{ungesteuert ? 'immer' : 'für diese Ladung'}</small>}
          </button>
        ))}
      </div></Recht>
      {sperre && <SperreHinweis sperre={sperre} />}
      {bild.funktion.sperre && <p className="leise" role="note">{bild.funktion.sperre}</p>}
      {ansage && <p className="leise" style={{ color: 'var(--c-fg)', fontWeight: 600 }}>{ansage}</p>}
      {ungesteuert && (
        <>
          <p className="lq-zustand"><i aria-hidden="true" />{LADEPUNKT_UNGESTEUERT.satz}</p>
          <p className="leise">{LADEPUNKT_UNGESTEUERT.folge}</p>
          <Recht aktion="betriebsweise.aendern">
            <button type="button" className="btn lq-einstellen" disabled={busy} onClick={oeffneWahl}>
              <Ic n="sun" s={18} />{LADEPUNKT_UNGESTEUERT.knopf}
            </button>
          </Recht>
        </>
      )}
      {l?.sitzungKwh != null && l.sitzungKwh > 0.05 && (
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
      {wahl === 'smart' && (
        <>
          <div className="blk">
            <h3>Womit laden{platz > 0 && <span className="meta">Platz {platz}</span>}</h3>
            {q && vor && saetze ? (
              <WahlZeile darf={darf} label={`Womit laden: ${LADEQUELLE[q]}. Ändern`} onClick={oeffneWahl}>
                <QuelleZeichen q={q} klein />
                <span className="lq-t"><b>{LADEQUELLE[q]}</b><small>{LADEQUELLE_VERSPRECHEN[q]}</small></span>
                {darf && <span className="lq-chev" aria-hidden="true"><Ic n="chevR" s={18} /></span>}
                {/* Die Vorschau ist eine Zusage - sie entfällt, solange VoltPilot
                    nichts bewirkt oder das Auto selbst nichts nimmt. */}
                {!sperre && !autoPausiert && (
                  <span className="lq-mini">
                    <VorschauBand v={vor.vorschau} abfahrt={vor.abfahrt} maxKw={g.nennKw ?? 11} h={36} preis={q === 'guenstig'}
                      label={`${LADEQUELLE[q]}: geschätzte Ladeleistung bis ${uhrKurz(vor.abfahrt)} Uhr nach Herkunft`} />
                  </span>
                )}
                {!sperre && (
                  <span className="lq-satz">
                    {autoPausiert
                      ? [autoPausiert.word, autoPausiert.detail].filter(Boolean).join(' · ')
                      : mitAuto(saetze.jetzt, !!l?.angesteckt)}
                    {saetze.dann && !autoPausiert && <small>{saetze.dann} · Schätzung</small>}
                  </span>
                )}
              </WahlZeile>
            ) : (
              <WahlZeile darf={darf} label="Womit laden: noch nicht gewählt. Wählen" onClick={oeffneWahl}>
                <span className="lq-t"><b>Noch nicht gewählt</b><small>Tippen, um zu wählen</small></span>
                {darf && <span className="lq-chev" aria-hidden="true"><Ic n="chevR" s={18} /></span>}
              </WahlZeile>
            )}
            {!darf && <Recht aktion="betriebsweise.aendern"><span /></Recht>}
            {q === 'speicher' && <p className="leise">{speicherZeile(release, bild.reihen.speicherGrenze?.[r.jetzt] ?? null, releaseGemeldet)}</p>}
            {q === 'guenstig' && s?.preisgrenzeCtKwh != null && <p className="leise">Lädt, solange der Bezugspreis unter {fCt(s.preisgrenzeCtKwh)} liegt.</p>}
          </div>
          {zielMoeglich && (
            <button type="button" className="lziel" onClick={(e) => { e.currentTarget.focus(); oeffne({ art: 'ziel', id: g.id }); }}>
              <Ic n="flag" s={20} />
              <span>
                <b>{zielAn ? `+${zahl0(s?.zielEnergieKwh ?? 0)} kWh bis ${zielBis != null ? uhrTag(zielBis) : s?.zielFenster?.bis ?? ''}` : 'Kein Ziel'}</b>
                <small>{zielSub}</small>
              </span>
              <Ic n="chevR" s={18} />
            </button>
          )}
        </>
      )}
      {zeilen && (
        <ol className="lq-rm" aria-live="polite" aria-label="Rückmeldung">
          {zeilen.map((z, i) => (
            <li key={i} className={z.zustand}>
              <span className="pk" aria-hidden="true">{z.zustand === 'fertig' ? <Ic n="check" s={12} /> : z.zustand === 'warn' ? <Ic n="alert" s={12} /> : z.zustand === 'laeuft' ? '…' : null}</span>
              <span>{z.text}{z.unter && <small>{z.unter}</small>}</span>
            </li>
          ))}
        </ol>
      )}
      {/* „Ladungen" (§4.1 Punkt 5 / §4.4, Scheibe 2): drei Zahlen des Monats,
          darunter die letzten drei mit Sonnenanteil und Euro; „Alle" öffnet
          Monat, Auto-Filter und die CSV „für die Abrechnung". */}
      <div className="blk">
        <div className="card-h" style={{ margin: 0 }}>
          <h3 style={{ margin: 0 }}>Ladungen · {monatsName()}</h3>
          <button type="button" className="tbtn" onClick={(e) => { e.currentTarget.focus(); oeffne({ art: 'ladungen', id: g.id }); }}>
            Alle<Ic n="chevR" s={16} />
          </button>
        </div>
        {summe.kwh != null && (
          <p style={{ margin: '4px 0 10px', font: '600 14px/1.4 var(--font)' }}>
            {fKwh(summe.kwh)}{summe.sonnenanteilPct != null ? `, ${fPct(summe.sonnenanteilPct)} Sonne` : ''}
            {summe.euro != null ? `, ${fEur(summe.euro)}` : ''}
            {summe.durchschnittCtKwh != null ? <small> · Ø {fCt(summe.durchschnittCtKwh)}</small> : null}
          </p>
        )}
        {ladungen.length ? (
          <ul className="lq-ladungen">
            {ladungen.map((z) => (
              <li key={z.key}>
                <span>{ladungDatum(z.startedAt)}{z.sonnenanteilPct != null ? ` · ${fPct(z.sonnenanteilPct)} Sonne` : ''}</span>
                <b>{z.kwh != null ? fKwh(z.kwh) : '—'}{z.euro != null ? <small> {fEur(z.euro)}</small> : null}</b>
              </li>
            ))}
          </ul>
        ) : (
          <p className="leise">Noch keine abgeschlossene Ladung.</p>
        )}
      </div>
      {/* Technik-Zeile (§4.3): Kennung, Sicherheitsprofil und Ausfall-Schutz
          wohnen an der Geräteseite - hier nur die ruhige Zeile, die hinführt. */}
      {technikHref && (
        <a className="lq-technik" href={technikHref}>
          <Ic n="shield" s={16} />
          <span>Anschluss geschützt <small>{g.name} verbunden · Technik</small></span>
          <Ic n="chevR" s={16} />
        </a>
      )}
    </section>
  );
}

/** „Oktober" - der Name des laufenden Monats (die Zeilen sind sein Inhalt). */
function monatsName(): string {
  return new Date().toLocaleDateString('de-DE', { month: 'long' });
}

/** „26.10., 18:20" - das Datum einer Ladung, in Kundenworten. */
function ladungDatum(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const d = new Date(t);
  return `${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}, ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
}

/** Woher der Ladestrom gerade kommt - für die Farbe der Bühne (§4.1 Punkt 1). */
function herkunftArt(bild: SeitenBild, t: number): 'sonne' | 'speicher' | 'netz' | null {
  const a = quellenAnteil(bild.reihen, t);
  if (!a) return null;
  if (a.pv >= a.sp && a.pv >= a.netz) return 'sonne';
  return a.sp >= a.netz ? 'speicher' : 'netz';
}

/** Warum VoltPilot an dieser Wallbox gerade nichts bewirkt - der Satz und seine Folge (Audit W-01/W-05/W-12). */
function SperreHinweis({ sperre }: { sperre: LadepunktSperre }) {
  return (
    <div className="konflikt lq-sperre" role="status" data-sperre={sperre.kind}>
      <Ic n="alert" s={18} />
      <span><b>{sperre.satz}.</b> {sperre.folge}</span>
    </div>
  );
}

/** Die Zeile „Womit laden“: ein Knopf ins Blatt - ohne das Recht nur die Anzeige. */
function WahlZeile({ darf, label, onClick, children }: { darf: boolean; label: string; onClick: (e: { currentTarget: HTMLElement }) => void; children: ReactNode }) {
  if (!darf) return <div className="lq-zeile">{children}</div>;
  return <button type="button" className="lq-zeile" aria-label={label} onClick={onClick}>{children}</button>;
}

function herkunftWort(bild: SeitenBild, t: number): string {
  const a = quellenAnteil(bild.reihen, t);
  if (!a) return 'lädt';
  if (a.pv >= a.sp && a.pv >= a.netz) return 'mit Sonne';
  return a.sp >= a.netz ? 'aus dem Speicher' : 'aus dem Netz';
}

/** Bietet ein Ladepunkt der Anlage „Sonne + Speicher“ überhaupt an? */
function speicherAngeboten(lp: GeraetBild[]): boolean {
  return lp.some((g) => liste(g.eintrag.optionen?.quellen).some((x) => x.id === OPTION_SONNE_SPEICHER && !x.gesperrt));
}

const RESERVEN = [0.5, 1, 2, 3, 5];

/**
 * Die Reserve von „Sonne + Speicher“ je Anlage: wie viel der Speicher über
 * seinem Mindestladestand zusätzlich für die Nacht behält. Sie wirkt nur über
 * den Fahrplan - deshalb steht da, dass sie mit dem nächsten Fahrplan gilt.
 * Ein Wert außerhalb der Chips (über die API gesetzt) steht im Satz, ohne
 * dass ein Chip gedrückt erscheint.
 */
function ReserveKarte({ standard, eigen, busy, onReserve }: {
  standard: number; eigen: number | null; busy: boolean; onReserve: (kwh: number | null) => void;
}) {
  const wert = eigen ?? standard;
  const kwhText = (v: number) => `${String(v).replace('.', ',')} kWh`;
  const chips = RESERVEN.includes(standard) ? RESERVEN : [...RESERVEN, standard].sort((a, b) => a - b);
  return (
    <section className="card" aria-label={`Reserve für ${LADEQUELLE.speicher}`}>
      <div className="card-h"><h2><Ic n="battery" s={18} />Reserve für „{LADEQUELLE.speicher}“</h2></div>
      <p style={{ margin: '0 0 10px', font: '600 15px/1.45 var(--font)' }}>
        Der Speicher behält {kwhText(wert)} mehr, als die vorsichtige Prognose bis zur nächsten Sonne verlangt{eigen == null ? ' (Vorgabe)' : ''}.
      </p>
      <Recht aktion="betriebsweise.aendern"><div className="chips" role="group" aria-label="Reserve">
        {chips.map((v) => (
          <button type="button" key={v} aria-pressed={wert === v} disabled={busy}
            onClick={() => onReserve(v === standard ? null : v)}>
            {kwhText(v)}{v === standard ? ' · Vorgabe' : ''}
          </button>
        ))}
      </div></Recht>
      <p className="leise">Gerechnet wird vorsichtig: eher viel Verbrauch, eher wenig Sonne, aus den gemessenen Prognosefehlern dieser Anlage. Mehr Reserve heißt: weniger für das Auto, mehr Sicherheit für die Nacht. Eine Änderung gilt ab dem nächsten Fahrplan, spätestens in einer Viertelstunde.</p>
    </section>
  );
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

function FahrzeugKarte({ fahrzeuge, oeffne, bild }: { fahrzeuge: SiteFahrzeuge | null; oeffne: (b: BlattZustand) => void; bild: SeitenBild }) {
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
      <p className="leise">Wer mit dieser Karte lädt, bekommt diese Einstellung. Den Ladestand des Autos kennt VoltPilot nicht; ein Ziel ist deshalb eine Menge in kWh.</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Blätter des Reiters
// ---------------------------------------------------------------------------

/** „2026-10" → der Vormonat/Folgemonat - reine Zeichenkettenarithmetik, keine Datumsbibliothek nötig. */
function monatVerschoben(monat: string, delta: number): string {
  const [jahrStr, monatStr] = monat.split('-');
  const n = (Number(jahrStr) * 12 + (Number(monatStr) - 1)) + delta;
  const jahr = Math.floor(n / 12);
  const m = (n % 12) + 1;
  return `${jahr}-${String(m).padStart(2, '0')}`;
}

/** „2026-10" → „Oktober 2026". */
function monatLabel(monat: string): string {
  const [jahr, m] = monat.split('-').map(Number);
  return new Date(jahr, m - 1, 1).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
}

/**
 * „Ladungen · Alle" (§4.1 Punkt 5, Scheibe 2): Monat wählen, nach Auto
 * filtern, jede Ladung mit Menge/Sonnenanteil/Euro, CSV „für die
 * Abrechnung" - ohne jede Aussage über steuerliche oder messrechtliche
 * Eignung. Holt sich den gewählten Monat selbst (wie `useAnschluss` im
 * Rahmen-Blatt): die Hauptseite kennt nur den laufenden Monat.
 */
export function LadungenBlatt({ k, id, siteId, fahrzeuge }: {
  k: BlattKontext; id: string; siteId: string; fahrzeuge: SiteFahrzeuge | null;
}) {
  const g = k.bild.geraete.find((x) => x.id === id);
  const heuteMonat = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const [monat, setMonat] = useState(heuteMonat);
  const [autoFilter, setAutoFilter] = useState<string | null>(null);
  const [daten, setDaten] = useState<OcppTransactionEconomics[] | null>(null);
  const [laden, setLaden] = useState(false);
  useEffect(() => {
    let aktiv = true;
    setLaden(true);
    api.ocppTransactionEconomics(siteId, monat).then(
      (d) => { if (aktiv) { setDaten(d); setLaden(false); } },
      () => { if (aktiv) { setDaten(null); setLaden(false); } },
    );
    return () => { aktiv = false; };
  }, [siteId, monat]);
  if (!g?.ladepunkt) return null;
  const cp = g.ladepunkt.chargePointId;
  const alle = ladungenZeilen(daten, cp);
  const autos = Array.from(new Set(alle.map((z) => z.kartenRef).filter((x): x is string => !!x)));
  const gefiltert = autoFilter ? alle.filter((z) => z.kartenRef === autoFilter) : alle;
  const summe = ladungenSumme(gefiltert);
  const autoName = (ref: string) => {
    const f = liste(fahrzeuge?.fahrzeuge).find((x) => x.tagRef === ref);
    return f ? fahrzeugName(f) : `Karte ${kartenKurz(ref)}…`;
  };
  return (
    <Blatt symbol="history" titel={`Ladungen · ${g.name}`} unter={monatLabel(monat)} voll onClose={k.zu}>
      <div className="blk">
        <div className="mini-seg" role="group" aria-label="Monat" style={{ marginBottom: 10 }}>
          <button type="button" onClick={() => setMonat(monatVerschoben(monat, -1))}><Ic n="chevL" s={16} />Vormonat</button>
          <button type="button" disabled={monat >= heuteMonat} onClick={() => setMonat(monatVerschoben(monat, 1))}>Folgemonat<Ic n="chevR" s={16} /></button>
        </div>
        {autos.length > 1 && (
          <div className="chips" role="group" aria-label="Auto" style={{ marginBottom: 10 }}>
            <button type="button" aria-pressed={autoFilter == null} onClick={() => setAutoFilter(null)}>Alle Autos</button>
            {autos.map((ref) => (
              <button type="button" key={ref} aria-pressed={autoFilter === ref} onClick={() => setAutoFilter(ref)}>{autoName(ref)}</button>
            ))}
          </div>
        )}
        {laden ? (
          <p className="leise">Lädt …</p>
        ) : summe.kwh != null ? (
          <p style={{ margin: '0 0 10px', font: '700 15px/1.4 var(--font)' }}>
            {fKwh(summe.kwh)}{summe.sonnenanteilPct != null ? `, ${fPct(summe.sonnenanteilPct)} Sonne` : ''}
            {summe.euro != null ? `, ${fEur(summe.euro)}` : ''}
            {summe.durchschnittCtKwh != null ? <small> · Ø {fCt(summe.durchschnittCtKwh)}</small> : null}
          </p>
        ) : (
          <p className="leise">Keine abgeschlossene Ladung in diesem Monat.</p>
        )}
        {gefiltert.length > 0 && (
          <ul className="lq-ladungen">
            {gefiltert.map((z) => (
              <li key={z.key}>
                <span>
                  {ladungDatum(z.startedAt)}
                  {z.sonnenanteilPct != null ? ` · ${fPct(z.sonnenanteilPct)} Sonne` : ''}
                  {z.kartenRef ? ` · ${autoName(z.kartenRef)}` : ''}
                </span>
                <b>{z.kwh != null ? fKwh(z.kwh) : '—'}{z.euro != null ? <small> {fEur(z.euro)}</small> : null}</b>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className="btn sek"
          style={{ marginTop: 12 }}
          disabled={!gefiltert.length}
          onClick={() => ladeCsv(ladungenCsv(gefiltert), `ladungen-${cp}-${monat}.csv`)}
        >
          <Ic n="down" s={18} />
          CSV für die Abrechnung
        </button>
        <p className="leise" style={{ marginTop: 8 }}>
          Die CSV ist eine Übersicht für Ihre eigenen Unterlagen - keine Rechnung und kein Nachweis im steuerlichen oder messrechtlichen Sinn.
        </p>
      </div>
    </Blatt>
  );
}

const ZIEL_ZEITEN = ['06:00', '07:00', '08:00', '16:00', '18:00'];

/**
 * Das Ladeziel: Menge und Uhrzeit (Konzept k1, E4=A). Es fragt kein zweites
 * „Womit?“ mehr - geladen wird mit der Ladequelle der Karte, und „Ziel
 * übernehmen“ schickt sie unverändert mit (vorher überschrieb das Blatt sie
 * still, aus „Günstig“ wurde „Nur Sonne“, Befund 11).
 */
export function ZielBlatt({ k, id, anlage, rahmenMinKw, onSpeichern }: {
  k: BlattKontext; id: string; anlage: VorschauAnlage; rahmenMinKw: number | null;
  onSpeichern: (g: GeraetBild, w: SteuerartWunsch) => Promise<boolean>;
}) {
  const g = k.bild.geraete.find((x) => x.id === id);
  const s = g?.steuerart;
  const [kwh, setKwh] = useState<number>(typeof s?.zielEnergieKwh === 'number' ? s.zielEnergieKwh : 20);
  const [bis, setBis] = useState<string>(s?.zielFenster?.bis ?? '07:00');
  if (!g) return null;
  const r = k.bild.raster;
  const basis = startEntwurf(g);
  const w = { ...basis, zielKwh: kwh, zielBis: bis };
  const { vorschau, abfahrt } = vorschauFuer(k.bild, g, anlage, w);
  const vorlaeufig = abfahrt >= TAG && !k.bild.reihen.morgenBekannt;
  const busy = k.busy === g.id;
  return (
    <Blatt
      symbol="flag"
      titel="Ladeziel"
      unter={`${g.name} · ${LADEQUELLE[basis.modus]}`}
      voll
      onClose={k.zu}
      fuss={
        <Recht aktion="betriebsweise.aendern">
          {s?.ziel ? (
            <button type="button" className="btn sek" disabled={busy} onClick={async () => { if (await onSpeichern(g, wunschAus(g, { ...basis, zielKwh: 0 }, rahmenMinKw))) k.zu(); }}>Kein Ziel</button>
          ) : (
            <button type="button" className="btn sek" onClick={k.zu}>Abbrechen</button>
          )}
          <button type="button" className="btn" disabled={busy} onClick={async () => { if (await onSpeichern(g, wunschAus(g, w, rahmenMinKw))) k.zu(); }}>
            <Ic n="check" s={18} />
            {busy ? 'Wird gesendet …' : 'Ziel übernehmen'}
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
        <p>Geladen wird mit „{LADEQUELLE[basis.modus]}“, bis das Ziel erreicht ist; fehlt dann etwas, kommt der Rest in den günstigsten Stunden aus dem Netz. Ändern lässt sich das unter „Womit laden“.</p>
      </div>
      {!g.ladepunkt?.angesteckt ? (
        <div className="blk">
          <h3>Plan</h3>
          <div className="warum">Kein Auto angesteckt. Das Ziel gilt ab der nächsten Ladung; VoltPilot plant sie, sobald ein Auto ansteckt.</div>
        </div>
      ) : (
        <div className="blk">
          <h3>Plan <span className="meta" style={{ textTransform: 'none', letterSpacing: 0 }}>Schätzung</span></h3>
          <VorschauBand v={vorschau} abfahrt={abfahrt} maxKw={g.nennKw ?? 11} h={46} preis={basis.modus === 'guenstig'}
            label={`Ladeziel: geschätzte Ladeleistung bis ${uhrKurz(abfahrt)} Uhr nach Herkunft`} />
          <DreiZahlen v={vorschau} abfahrt={abfahrt} />
          {vorschau.schafft === false && (
            <div className="konflikt"><Ic n="alert" s={18} /><span>Das reicht nicht ganz: bis {uhrTag(abfahrt)} passen {kwhText(vorschau.kwh)}. Früher anstecken oder später abfahren hilft.</span></div>
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
export function RahmenBlatt({ k, siteId, rahmen, config, onGrenze, serverFehler = null }: {
  /** Nur `zu`/`busy` - seit Scheibe 4 auch außerhalb der Steuerung mountbar (Einstellungen). */
  k: { zu: () => void; busy: string | null };
  siteId: string; rahmen: LadeparkRahmen | null; config: ChargingConfig | null;
  onGrenze: (kw: number, vereinbartKw?: number) => Promise<boolean>;
  /** Ein Fehler des `onGrenze`-Abrufs selbst (Netz/Server) - getrennt von der Plausibilitätsprüfung unten. */
  serverFehler?: string | null;
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
          {serverFehler && <p className="stn-fehler" role="alert">{serverFehler}</p>}
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

// `FahrzeugBlatt` ist entfallen (Konzept „Ein Ort fürs Laden" e1, Abschnitt 7
// Punkt 6): „Autos" öffnet jetzt denselben `FahrzeugDialog` wie früher nur die
// Ladevorgänge-Seite - zwei Dialoge über dieselbe Sache wären zwei Wahrheiten.
