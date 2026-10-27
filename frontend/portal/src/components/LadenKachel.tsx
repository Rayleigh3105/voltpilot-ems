import type { ReactNode } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { fmtNum } from '../format';
import type { LadenKachel as LadenKachelView, LadenZeile } from '../ladenKachel';
import { MiniShareBar } from './MiniChart';
import { Kachel, type RasterGroesse } from './kacheln/Kachel';

import './LadenKachel.css';

/**
 * Die Kachel „Laden" (Konzept `vp-verbraucher-cockpit-k1` §5): der EINE Ort,
 * an dem ohne Klick steht, ob ein Auto steckt und ob es lädt.
 *
 * REINE ANZEIGE (Captain): kein Start, kein Stopp, keine Freigabe. Der Kopf
 * springt auf „Laden" (Konzept „Ein Ort fürs Laden" e1, §4.2), jede Zeile auf
 * ihre Geräteseite - die Handlungen wohnen dort, wo sie hingehören.
 *
 * Die Fußzeile IST das bestehende Netzanschluss-Band: der Block `lade-budget`
 * ist mit diesem Baustein aus den Kennzahlen hierher gezogen, damit eine Zahl
 * EINEN Wohnort hat.
 *
 * Thin + render-only - jede Zahl und jedes Wort kommt aus der getesteten
 * {@link ../ladenKachel}.
 */
export function LadenKachel({
  view,
  kachel = null,
}: {
  view: LadenKachelView;
  /** Die Kachel-Fassung im Raster (Konzept „Cockpit als Tagesfilm“): Kopf mit Absprung „Laden“. */
  kachel?: { groesse?: RasterGroesse; onOpen?: (() => void) | null; lead?: boolean; fuss?: ReactNode } | null;
}) {
  if (kachel) {
    const band = view.band;
    // Der wichtigste Ladepunkt: der ladende, sonst - steckt nirgends ein Auto -
    // der getrennte (über ihn spricht der Kopf, Audit W-12), sonst der erste.
    const haupt = view.zeilen.find((z) => z.kw != null && z.kw > 0.05)
      ?? (view.ladend === 0 && view.steckt === 0 ? view.zeilen.find((z) => z.kind === 'getrennt') : undefined)
      ?? view.zeilen[0] ?? null;
    return (
      <Kachel
        id="laden"
        name="Laden"
        icon="car"
        ton="load"
        groesse={kachel.groesse ?? 'breit'}
        onOpen={kachel.onOpen ?? (view.href ? () => { window.location.hash = view.href!.replace(/^#/, ''); } : null)}
        ziel="Laden"
        lead={kachel.lead}
        fuss={kachel.fuss}
      >
        {/* Wie im Prototyp: die Leistung groß, der eine Satz zum wichtigsten
            Ladepunkt, darunter das Ladebudget. Die Säulen im Einzelnen stehen
            auf „Laden“ und in „Verbrauch im Detail“. */}
        <div className="vp-k-reihe">
          <span className="vp-k-ico vp-laden-kachel-ico" aria-hidden="true">
            <Icon name="car" size={22} />
          </span>
          <div>
            {view.ladenKw != null ? (
              <span className="vp-k-gross">
                {fmtNum(view.ladenKw, '').trim()}
                <span className="vp-k-einheit">kW</span>
              </span>
            ) : (
              <span className="vp-k-zustand">{view.kopf}</span>
            )}
            {haupt && (
              <p className="vp-k-zustand">
                {/* ⚠ Das Wort bleibt, wie die Vektoren es schreiben: klein
                    geschrieben hiesse es „säule getrennt“, „auto pausiert“. */}
                {haupt.label}: {haupt.word}
                {haupt.note ? ` · ${haupt.note}` : ''}
              </p>
            )}
          </div>
        </div>
        {view.zeilen.length > 1 && <p className="vp-k-sub">{view.unterzeile ?? `${view.zeilen.length} Ladepunkte`}</p>}
        <Hinweise view={view} />
        {band && band.headline != null && (
          <div className="vp-laden-fuss">
            <span className="vp-laden-fuss-kopf">
              <span>Ladebudget {band.headline}</span>
              {band.blind && <span className="vp-laden-blind">geschätzt</span>}
            </span>
            <MiniShareBar
              className="vp-laden-band"
              segments={band.segments.map((sg) => ({
                key: sg.id,
                weight: Math.max(sg.kw, 0.001),
                className: `vp-laden-seg is-${sg.id}`,
                title: sg.label,
              }))}
            />
          </div>
        )}
      </Kachel>
    );
  }
  return (
    <section className="vp-laden" aria-label="Laden">
      <div className="vp-laden-kopf">
        <div className="vp-laden-kopfblock">
          <span className="vp-laden-label">Laden</span>
          <span className="vp-laden-wert">{view.kopf}</span>
          {view.unterzeile && <span className="vp-laden-sub">{view.unterzeile}</span>}
        </div>
        {view.href && (
          <a className="vp-laden-mehr" href={view.href}>
            Laden
            <Icon name="chevron-right" size={14} />
          </a>
        )}
      </div>

      <Hinweise view={view} />
      <LadenInhalt view={view} />
    </section>
  );
}

/** Die Säulen, an denen VoltPilot gerade nichts bewirkt - je ein Satz. */
function Hinweise({ view }: { view: LadenKachelView }) {
  if (view.hinweise.length === 0) return null;
  return (
    <>
      {view.hinweise.map((h) => (
        <p key={h} className="vp-laden-hinweis" role="status">{h}</p>
      ))}
    </>
  );
}

/** Zeilen, ruhende Ladepunkte und das Ladebudget - in Karte und Kachel gleich. */
function LadenInhalt({ view }: { view: LadenKachelView }) {
  const { band } = view;
  return (
    <>
      {view.zeilen.length > 0 && (
        <ul className="vp-laden-zeilen">
          {view.zeilen.map((z) => (
            <Zeile key={z.key} zeile={z} />
          ))}
        </ul>
      )}

      {/* E6: die ruhenden Ladepunkte sind EIN Satz, keine Liste. */}
      {view.ruhendText && <p className="vp-laden-ruhend">{view.ruhendText}</p>}

      {/* Ohne gemeldetes Budget gibt es KEINE Fußzeile - eine „0 kW"-Zeile wäre
          eine Behauptung über eine Anlage, die gerade nichts gemeldet hat. */}
      {band && band.headline != null && (
        <div className="vp-laden-fuss">
          <span className="vp-laden-fuss-kopf">
            <span>Ladebudget {band.headline}</span>
            {band.blind && <span className="vp-laden-blind">geschätzt</span>}
          </span>
          <MiniShareBar
            className="vp-laden-band"
            segments={band.segments.map((s) => ({
              key: s.id,
              weight: Math.max(s.kw, 0.001),
              className: `vp-laden-seg is-${s.id}`,
              title: s.label,
            }))}
          />
          <span className="vp-laden-fuss-satz">{band.sourceLine ?? band.line}</span>
        </div>
      )}
    </>
  );
}

function Zeile({ zeile }: { zeile: LadenZeile }) {
  const inhalt = (
    <>
      <span className={`vp-laden-dot tone-${zeile.tone}`} aria-hidden="true" />
      <span className="vp-laden-name">
        {zeile.label}
        {zeile.note && <span className="vp-laden-note">{zeile.note}</span>}
      </span>
      {/* „Nicht messbar ist nie 0": ohne Messwert trägt das Wort allein. */}
      <span className={`vp-laden-wort tone-${zeile.tone}`}>
        {zeile.word}
        {zeile.kw != null && <b className="vp-laden-kw">{fmtNum(zeile.kw, 'kW')}</b>}
      </span>
    </>
  );
  if (!zeile.href) {
    return <li className="vp-laden-zeile">{inhalt}</li>;
  }
  return (
    <li className="vp-laden-zeile is-link">
      <a className="vp-laden-link" href={zeile.href} aria-label={`${zeile.label} öffnen`}>
        {inhalt}
        <span className="vp-laden-go" aria-hidden="true">
          <Icon name="chevron-right" size={14} />
        </span>
      </a>
    </li>
  );
}
