import type { ReactNode } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import type { MiniAbweichung, MiniLinie } from '../auswertenGrafik';
import {
  ANSEHEN,
  BEZUGSBASIS_FESTLEGEN,
  BEZUGSBASIS_VORLAEUFIG,
  GRUPPE_MIT,
  GRUPPE_OHNE,
  KEIN_ENERGIEZIEL,
  KEINE_BEZUGSBASIS,
  LEITKENNZAHL,
  miniZusammenfassung,
  OHNE_URTEIL,
  OHNE_VORJAHR,
  SPALTEN_MIT,
  SPALTEN_OHNE,
  ZWOELF_MONATE,
  type HinweisKarte,
  type KarteMitBasis,
  type ReiheOhneBasis,
} from '../kennzahlListe';
import { TRENNER } from '../uemsErgebnis';
import { Marke } from './kacheln/Kachel';
import './KennzahlenAuswertung.css';

/**
 * Die Bausteine der Liste „Kennzahlen“ (Konzept Auswerten a1 §6.4, §6.14) - render-only: jede Zahl, jedes Wort und jede
 * Lage kommt fertig aus `kennzahlListe.ts` und `auswertenGrafik.ts`. Am Handy Karten und Reihen, am Rechner Reihen mit
 * Spalten (höchstens sechs); die Grafiken tragen nur Marken, ihre Beschriftung steht als HTML daneben.
 */

const STRICH = '–';

function Zahl({ zahl, einheit, vor }: { zahl: string | null; einheit: string | null; vor: string | null }) {
  return (
    <span className="vp-kzl-zahl-wert">
      {vor && <small className="vp-kzl-vor">{vor} </small>}
      <b>{zahl ?? STRICH}</b>
      {/* Das Leerzeichen trägt nur den Text (Vorleser, Kopieren); den Abstand macht die Flex-Lücke. */}
      {zahl !== null && einheit && <span className="vp-kzl-einheit"> {einheit}</span>}
    </span>
  );
}

/** Abweichung je Monat um die Nulllinie (§6.12) - nur Marken; die Zusammenfassung liest der Vorleser. */
export function MiniAbweichungBild({ mini, testId }: { mini: MiniAbweichung; testId?: string }) {
  return (
    <>
      <svg
        className="vp-kzl-mini-bild"
        viewBox={`0 0 ${mini.breite} ${mini.hoehe}`}
        width={mini.breite}
        height={mini.hoehe}
        aria-hidden="true"
        data-testid={testId}
      >
        <rect className="vp-kzl-band" x="0" y={mini.band.y} width={mini.breite} height={mini.band.hoehe} />
        <line className="vp-kzl-null" x1="0" x2={mini.breite} y1={mini.nullY} y2={mini.nullY} />
        {mini.saeulen.map((s) => (
          <path key={s.periode} className={`vp-kzl-saeule is-${s.art}`} d={s.pfad} data-art={s.art} />
        ))}
      </svg>
      <span className="vp-sr-only">{miniZusammenfassung(mini)}</span>
    </>
  );
}

/** Der Verlauf einer Kennzahl zum Beobachten: eine Linie in der Rolle Verbrauch, der jüngste Punkt markiert. */
export function MiniLinieBild({ linie }: { linie: MiniLinie }) {
  return (
    <svg className="vp-kzl-mini-bild" viewBox={`0 0 ${linie.breite} ${linie.hoehe}`} width={linie.breite} height={linie.hoehe} aria-hidden="true">
      {linie.strecken.map((p, i) => (
        <polyline key={i} className="vp-kzl-linie" points={p} />
      ))}
      {linie.letzter && <circle className="vp-kzl-linie-punkt" cx={linie.letzter.x} cy={linie.letzter.y} r="3.2" />}
    </svg>
  );
}

function Marken({ k }: { k: KarteMitBasis }) {
  return (
    <span className="vp-kzl-marken">
      {k.urteil && <Marke art={k.urteil.ton}>{k.urteil.wort}</Marke>}
      {k.urteil && k.abweichung && <Marke art={k.urteil.ton}>{k.abweichung}</Marke>}
      {k.ohneUrteil && <Marke art="ohne">{k.ohneUrteil}</Marke>}
      {k.vorlaeufig && <Marke art="ohne">{BEZUGSBASIS_VORLAEUFIG}</Marke>}
    </span>
  );
}

/** Die Karte einer Kennzahl mit Bezugsbasis am Handy (§6.4). */
export function KarteMitBasisHandy({ k, onOeffnen }: { k: KarteMitBasis; onOeffnen: () => void }) {
  return (
    <button type="button" className="vp-kzl-karte" data-testid="kennzahl-karte" data-id={k.id} data-kennzeichen={k.kennzeichen} onClick={onOeffnen}>
      <span className="vp-kzl-kopf">
        <span className="vp-kzl-name">
          {k.name} <span className="vp-kzl-kz">{k.kennzeichen}</span>
        </span>
        {k.leit && (
          <span className="vp-kzl-stern" title={LEITKENNZAHL}>
            <Icon name="star" size={14} />
            <span className="vp-sr-only">{LEITKENNZAHL}</span>
          </span>
        )}
        <span className="vp-kzl-pfeil" aria-hidden="true">
          <Icon name="chevron-right" size={18} />
        </span>
      </span>
      <span className="vp-kzl-koerper">
        <span className="vp-kzl-zahl">
          <Zahl zahl={k.zahl} einheit={k.einheit} vor={k.vor} />
          <span className="vp-kzl-per">{k.per}</span>
          <Marken k={k} />
        </span>
        <span className="vp-kzl-mini">
          <MiniAbweichungBild mini={k.mini} testId="kennzahl-mini" />
          <small aria-hidden="true">{ZWOELF_MONATE}</small>
        </span>
      </span>
      {k.ziel && (
        <span className="vp-kzl-ziel" data-testid="kennzahl-ziel">
          <Icon name="target" size={14} />
          <span>
            <b>{k.ziel.kopf}:</b> {k.ziel.wert}
            {TRENNER}
            {k.ziel.stand}
          </span>
        </span>
      )}
    </button>
  );
}

/** Eine Reihe zum Beobachten am Handy: Name, Vorjahr ohne Farbe, Wert rechts. */
export function ReiheOhneBasisHandy({ r, onOeffnen }: { r: ReiheOhneBasis; onOeffnen: () => void }) {
  const unter = [r.vorjahr, r.wertMonat].filter(Boolean).join(TRENNER);
  return (
    <button type="button" className="vp-kzl-reihe" data-testid="kennzahl-reihe" data-kennzeichen={r.kennzeichen} onClick={onOeffnen}>
      <span className="vp-kzl-reihe-text">
        <span className="vp-kzl-name">
          {r.name} <span className="vp-kzl-kz">{r.kennzeichen}</span>
        </span>
        {unter && <span className="vp-kzl-reihe-unter">{unter}</span>}
      </span>
      <span className="vp-kzl-reihe-wert">
        <Zahl zahl={r.zahl} einheit={r.einheit} vor={r.vor} />
      </span>
      <span className="vp-kzl-pfeil" aria-hidden="true">
        <Icon name="chevron-right" size={18} />
      </span>
    </button>
  );
}

/** Die Gruppe am Rechner: Reihen mit Spalten statt Karten (§6.14); unter 1.200 px entfällt die Mini-Grafik. */
export function TabelleMitBasis({ karten, onOeffnen }: { karten: readonly KarteMitBasis[]; onOeffnen: (id: string) => void }) {
  return (
    <section className="vp-kzl-gruppe-karte" aria-labelledby="kzl-mit" data-testid="kennzahlen-mit">
      <header className="vp-kzl-gruppe-kopf">
        <h2 id="kzl-mit">{GRUPPE_MIT.titel}</h2>
        <span>
          {GRUPPE_MIT.leise}
          {TRENNER}
          {karten.length}
        </span>
      </header>
      <div className="vp-kzl-zeile vp-kzl-spalten is-mit" aria-hidden="true">
        {SPALTEN_MIT.map((s) => (
          <span key={s}>{s}</span>
        ))}
        <span />
      </div>
      <ul className="vp-kzl-zeilen">
        {karten.map((k) => (
          <li key={k.id}>
            <button type="button" className="vp-kzl-zeile is-mit" data-testid="kennzahl-karte" data-id={k.id} data-kennzeichen={k.kennzeichen} onClick={() => onOeffnen(k.id)}>
              <span className="vp-kzl-z-name">
                <b>
                  {k.name} <span className="vp-kzl-kz">{k.kennzeichen}</span>
                  {k.leit && (
                    <span className="vp-kzl-stern" title={LEITKENNZAHL}>
                      <Icon name="star" size={13} />
                      <span className="vp-sr-only">{LEITKENNZAHL}</span>
                    </span>
                  )}
                </b>
                <span>{k.unter}</span>
              </span>
              <span className="vp-kzl-z-wert">
                <Zahl zahl={k.zahl} einheit={k.einheit} vor={k.vor} />
                {k.wertMonat && <span>{k.wertMonat}</span>}
              </span>
              <span className="vp-kzl-z-urteil">
                {k.urteil ? <Marke art={k.urteil.ton}>{k.urteil.wort}</Marke> : k.ohneUrteil && <Marke art="ohne">{k.ohneUrteil}</Marke>}
                {(k.abweichungKurz || k.vorlaeufig) && (
                  <small>{[k.abweichungKurz, k.vorlaeufig ? BEZUGSBASIS_VORLAEUFIG : null].filter(Boolean).join(TRENNER)}</small>
                )}
              </span>
              <span className="vp-kzl-z-ziel">
                {k.ziel ? (
                  <>
                    {k.ziel.jahre}: {k.ziel.wert}
                    <small>{k.ziel.stand}</small>
                  </>
                ) : (
                  <>
                    {STRICH}
                    <small>{KEIN_ENERGIEZIEL}</small>
                  </>
                )}
              </span>
              <span className="vp-kzl-z-mini">
                <MiniAbweichungBild mini={k.mini} testId="kennzahl-mini" />
              </span>
              <span className="vp-kzl-pfeil" aria-hidden="true">
                <Icon name="chevron-right" size={18} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function TabelleOhneBasis({
  reihen,
  darfBasisFestlegen,
  onOeffnen,
  weitere,
  anzahlWeitere,
}: {
  reihen: readonly ReiheOhneBasis[];
  /** Nur wer Bezugsbasen verwalten darf, liest „Bezugsbasis festlegen“ (ohne Recht nur „keine“). */
  darfBasisFestlegen: boolean;
  onOeffnen: (id: string) => void;
  /** Kennzahlen ohne Monatswerte: als schlichte Reihen unter den Spalten, in derselben Gruppe. */
  weitere?: ReactNode;
  anzahlWeitere?: number;
}) {
  return (
    <section className="vp-kzl-gruppe-karte" aria-labelledby="kzl-ohne" data-testid="kennzahlen-ohne">
      <header className="vp-kzl-gruppe-kopf">
        <h2 id="kzl-ohne">{GRUPPE_OHNE.titel}</h2>
        <span>
          {GRUPPE_OHNE.leise}
          {TRENNER}
          {reihen.length + (anzahlWeitere ?? 0)}
        </span>
      </header>
      {reihen.length > 0 && (
        <div className="vp-kzl-zeile vp-kzl-spalten is-ohne" aria-hidden="true">
          {SPALTEN_OHNE.map((s) => (
            <span key={s}>{s}</span>
          ))}
          <span />
        </div>
      )}
      <ul className="vp-kzl-zeilen">
        {reihen.map((r) => (
          <li key={r.id}>
            <button type="button" className="vp-kzl-zeile is-ohne" data-testid="kennzahl-reihe" data-kennzeichen={r.kennzeichen} onClick={() => onOeffnen(r.id)}>
              <span className="vp-kzl-z-name">
                <b>
                  {r.name} <span className="vp-kzl-kz">{r.kennzeichen}</span>
                </b>
                <span>{r.unter}</span>
              </span>
              <span className="vp-kzl-z-wert">
                <Zahl zahl={r.zahl} einheit={r.einheit} vor={r.vor} />
                {r.wertMonat && <span>{r.wertMonat}</span>}
              </span>
              <span className="vp-kzl-z-urteil">
                {r.vorjahr ? <Marke art="neutral">{r.vorjahr}</Marke> : <Marke art="ohne">{OHNE_VORJAHR}</Marke>}
                <small>{OHNE_URTEIL}</small>
              </span>
              <span className="vp-kzl-z-ziel">
                {r.bezugsbasis ?? KEINE_BEZUGSBASIS}
                {!r.bezugsbasis && darfBasisFestlegen && <small>{BEZUGSBASIS_FESTLEGEN}</small>}
              </span>
              <span className="vp-kzl-z-mini">
                <MiniLinieBild linie={r.linie} />
              </span>
              <span className="vp-kzl-pfeil" aria-hidden="true">
                <Icon name="chevron-right" size={18} />
              </span>
            </button>
          </li>
        ))}
      </ul>
      {weitere}
    </section>
  );
}

/** Die Hinweiskarte bei Handlungsbedarf (Variante A der Übersicht) oder der ruhige Satz. */
export function ListenHinweis({ hinweis, kurz, onAnsehen }: { hinweis: HinweisKarte; kurz: boolean; onAnsehen: () => void }) {
  if (hinweis.art === 'ruhig') {
    return (
      <p className="vp-kzl-ruhig" data-testid="kennzahlen-ruhig">
        {hinweis.text}
      </p>
    );
  }
  return (
    <button type="button" className="vp-kzl-hinweis" data-testid="kennzahlen-hinweis" onClick={onAnsehen}>
      <span className="vp-kzl-hinweis-icon" aria-hidden="true">
        <Icon name="alert-triangle" size={20} />
      </span>
      <span className="vp-kzl-hinweis-text">
        <b>{hinweis.titel}</b>
        <span>{kurz ? hinweis.textKurz : hinweis.text}</span>
      </span>
      <span className="vp-kzl-hinweis-weg">{ANSEHEN}</span>
    </button>
  );
}
