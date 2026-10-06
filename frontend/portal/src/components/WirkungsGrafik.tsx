import { useState } from 'react';
import type { MassnahmeWirkung } from '../api';
import { monatWort } from '../bezugsbasisVergleich';
import { offenGrund } from '../energieziele';
import { NBSP } from '../format';
import { ganz, personProzent, prozentBetrag, richtungWort } from '../massnahmenBild';

/**
 * „Je Monat nach der Umsetzung“ (Verbessern-Konzept v1 §6.6, §6.11): die Abweichung je Monat als Säulen um die
 * Nulllinie wie in Auswerten a1, beginnend im Monat nach der Umsetzung; die erwartete Wirkung als gestrichelte
 * Navy-Linie (das Vorgenommene, kein Urteil). Nicht bewertbare Monate gestrichelt mit ihrem Grund in der Infozeile,
 * laufende gestrichelt, kommende leer mit hellen Monatsnamen. Alle Werte, Urteile und Sätze sind die der Route
 * (`…/wirkung`); hier wird nur gezeichnet und gezählt.
 */

const BREITE = 320;
const HOEHE = 150;
const OBEN = 8;
const UNTEN = 142;
const MITTE = (OBEN + UNTEN) / 2;

const FARBE: Record<string, string> = {
  besser: 'var(--vp-flow-batt, #16a34a)',
  schlechter: 'var(--vp-c-warn-fg, #9a3412)',
  im_rahmen: '#94a3b8',
};
export const URTEIL_WORT: Record<string, string> = {
  besser: 'weniger als erwartet',
  schlechter: 'mehr als erwartet',
  im_rahmen: 'im Rahmen',
};

const KURZ = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

type Monat = MassnahmeWirkung['monate'][number];
type Art = 'gezaehlt' | 'nicht_bewertbar' | 'laeuft' | 'spaeter';

function art(m: Monat): Art {
  if (m.gezaehlt) return 'gezaehlt';
  if (m.grund !== null) return 'nicht_bewertbar';
  if (m.vergleich.bereinigt.gemessen.wert !== null) return 'laeuft';
  return 'spaeter';
}

/** Die Nachher-Monate (ohne Umsetzungsmonat) in der Reihenfolge der Route. */
export function nachherMonate(w: Pick<MassnahmeWirkung, 'monate' | 'umsetzungsmonat'>): Monat[] {
  return w.monate.filter((m) => m.periode !== w.umsetzungsmonat);
}

/** „9 von 11 Monaten lagen unter der Erwartung, 1 im Rahmen, 1 darüber.“ - gezählt, nicht gerechnet. */
export function fazit(monate: readonly Monat[]): { kopf: string; rest: string } | null {
  const gezaehlt = monate.filter((m) => m.gezaehlt);
  if (!gezaehlt.length) return null;
  const n = (u: string) => gezaehlt.filter((m) => m.vergleich.bereinigt.urteil === u).length;
  const unter = n('besser');
  const rahmen = n('im_rahmen');
  const ueber = n('schlechter');
  const teile = [
    ...(rahmen ? [`${rahmen} im Rahmen`] : []),
    ...(ueber ? [`${ueber} darüber`] : []),
  ];
  return {
    kopf: `${unter} von ${gezaehlt.length} ${gezaehlt.length === 1 ? 'Monat' : 'Monaten'}`,
    rest: ` ${unter === 1 ? 'lag' : 'lagen'} unter der Erwartung${teile.length ? `, ${teile.join(', ')}` : ''}.`,
  };
}

export function WirkungsGrafik({ w, erwartetProzent }: { w: MassnahmeWirkung; erwartetProzent: string | null }) {
  const monate = nachherMonate(w);
  const startIndex = (() => {
    const gezaehlt = monate.map((m, i) => (m.gezaehlt ? i : -1)).filter((i) => i >= 0);
    if (gezaehlt.length) return gezaehlt[gezaehlt.length - 1];
    const mitWert = monate.map((m, i) => (art(m) !== 'spaeter' ? i : -1)).filter((i) => i >= 0);
    return mitWert.length ? mitWert[mitWert.length - 1] : 0;
  })();
  const [sel, setSel] = useState(startIndex);
  if (!monate.length) return null;

  const deltas = monate
    .map((m) => m.vergleich.bereinigt.delta_prozent)
    .filter((d): d is string => d !== null)
    .map((d) => Math.abs(Number(d)));
  const band = Number(monate.find((m) => m.vergleich.bereinigt.band_prozent !== null)?.vergleich.bereinigt.band_prozent ?? 2);
  const erwartet = erwartetProzent === null ? null : Number(erwartetProzent);
  const max = Math.max(4, ...deltas, band, erwartet === null ? 0 : Math.abs(erwartet));
  const skala = Math.ceil(max / 2) * 2;
  const y = (v: number) => MITTE - (v / skala) * (MITTE - OBEN);
  const slot = BREITE / monate.length;
  const balken = Math.min(22, slot * 0.58);

  const m = monate[Math.min(sel, monate.length - 1)];
  const b = m.vergleich.bereinigt;
  const a = art(m);
  const einheit = b.gemessen.einheit;

  const jahrUnter = (i: number) => i === 0 || monate[i].periode.endsWith('-01') || i === monate.length - 1;

  return (
    <div className="vp-mn-grafik" data-testid="massnahme-wirkung-grafik">
      <div className="vp-mn-info" aria-live="polite" data-testid="massnahme-wirkung-info">
        <b>{monatWort(m.periode)}</b>
        {a === 'gezaehlt' && b.gemessen.wert !== null && b.erwartet !== null ? (
          <>
            <span className="vp-mn-w">{`${ganz(b.gemessen.wert)}${NBSP}${einheit}`}</span>
            <span>{`statt ${ganz(b.erwartet)} erwartet`}</span>
            <span className={`vp-mn-u${b.urteil === 'besser' ? ' is-ok' : b.urteil === 'schlechter' ? ' is-warn' : ''}`}>
              {`${prozentBetrag(b.delta_prozent!)} ${richtungWort(b.delta_prozent!)} · ${URTEIL_WORT[b.urteil] ?? b.urteil}`}
            </span>
          </>
        ) : a === 'nicht_bewertbar' ? (
          <span className="vp-mn-u">{(m.satz ?? m.vergleich.satz).replace(/^[^:]+:\s*/, '')}</span>
        ) : (
          // Befund 1: der Grund der Route (läuft noch, kein gemessener Wert …), nie pauschal „noch nicht endgültig“.
          <span className="vp-mn-u">{offenGrund(m.vergleich)}</span>
        )}
      </div>
      <div className="vp-mn-graf">
        <div className="vp-mn-graf-y" aria-hidden="true">
          <span className="is-wort" style={{ top: `${(OBEN / HOEHE) * 100}%` }}>
            mehr
          </span>
          <span style={{ top: `${(y(skala / 2) / HOEHE) * 100}%` }}>{`+${skala / 2}${NBSP}%`}</span>
          <span style={{ top: `${(MITTE / HOEHE) * 100}%` }}>0</span>
          <span style={{ top: `${(y(-skala / 2) / HOEHE) * 100}%` }}>{`−${skala / 2}${NBSP}%`}</span>
          <span className="is-wort" style={{ top: `${(UNTEN / HOEHE) * 100}%` }}>
            weniger
          </span>
        </div>
        <div className="vp-mn-graf-p">
          <svg viewBox={`0 0 ${BREITE} ${HOEHE}`} role="img" aria-label={`Abweichung je Monat nach der Umsetzung, ${w.monate_text ?? ''} Monaten`}>
            <rect x={0} y={y(band)} width={BREITE} height={y(-band) - y(band)} fill="#eef2f7" />
            <line x1={0} x2={BREITE} y1={y(skala / 2)} y2={y(skala / 2)} stroke="#e2e8f0" strokeWidth={1} />
            <line x1={0} x2={BREITE} y1={y(-skala / 2)} y2={y(-skala / 2)} stroke="#e2e8f0" strokeWidth={1} />
            <line x1={0} x2={BREITE} y1={MITTE} y2={MITTE} stroke="#94a3b8" strokeWidth={1} />
            {monate.map((mo, i) => {
              const cx = slot * i + slot / 2;
              const ar = art(mo);
              const d = mo.vergleich.bereinigt.delta_prozent;
              const auswahl = i === sel;
              return (
                <g key={mo.periode}>
                  {auswahl && (
                    <rect x={cx - slot / 2 + 2} y={OBEN - 4} width={slot - 4} height={UNTEN - OBEN + 8} rx={8} fill="none" stroke="#64748b" strokeWidth={1.5} />
                  )}
                  {ar === 'gezaehlt' && d !== null && (
                    <rect
                      x={cx - balken / 2}
                      y={Math.min(y(Number(d)), MITTE)}
                      width={balken}
                      height={Math.max(2, Math.abs(y(Number(d)) - MITTE))}
                      rx={3}
                      fill={FARBE[mo.vergleich.bereinigt.urteil] ?? '#94a3b8'}
                    />
                  )}
                  {ar === 'nicht_bewertbar' && (
                    <rect x={cx - balken / 2} y={MITTE - 12} width={balken} height={24} rx={3} fill="none" stroke="#94a3b8" strokeWidth={1.2} strokeDasharray="3 2" />
                  )}
                  {ar === 'laeuft' && (
                    <rect
                      x={cx - balken / 2}
                      y={d === null ? MITTE - 12 : Math.min(y(Number(d)), MITTE)}
                      width={balken}
                      height={d === null ? 24 : Math.max(4, Math.abs(y(Number(d)) - MITTE))}
                      rx={3}
                      fill="none"
                      stroke="#94a3b8"
                      strokeWidth={1.2}
                      strokeDasharray="3 2"
                    />
                  )}
                </g>
              );
            })}
            {erwartet !== null && (
              <line x1={0} x2={BREITE} y1={y(erwartet)} y2={y(erwartet)} stroke="var(--vp-chart-plan, #1e3a5f)" strokeWidth={1.6} strokeDasharray="6 4" />
            )}
          </svg>
          <div className="vp-mn-graf-tasten" style={{ gridTemplateColumns: `repeat(${monate.length}, minmax(0, 1fr))` }}>
            {monate.map((mo, i) => (
              <button
                key={mo.periode}
                type="button"
                aria-pressed={i === sel}
                aria-label={monatWort(mo.periode)}
                onClick={() => setSel(i)}
                data-testid={`wirkung-monat-${mo.periode}`}
              />
            ))}
          </div>
        </div>
        <div className="vp-mn-graf-x" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${monate.length}, minmax(0, 1fr))` }}>
          {monate.map((mo, i) => (
            <span key={mo.periode} className={`${i === sel ? 'is-sel' : ''}${art(mo) === 'spaeter' ? ' is-spaeter' : ''}`}>
              {KURZ[Number(mo.periode.slice(5, 7)) - 1]}
              {jahrUnter(i) && <small>{mo.periode.slice(0, 4)}</small>}
            </span>
          ))}
        </div>
      </div>
      <p className="vp-mn-legende" aria-hidden="true">
        <span>
          <i style={{ background: FARBE.schlechter }} />
          mehr als erwartet
        </span>
        <span>
          <i style={{ background: FARBE.im_rahmen }} />
          {`im Rahmen (± ${String(band).replace('.', ',')}${NBSP}%)`}
        </span>
        <span>
          <i style={{ background: FARBE.besser }} />
          weniger als erwartet
        </span>
        <span>
          <i className="is-strich" />
          nicht bewertbar
        </span>
        {erwartetProzent !== null && (
          <span>
            <i className="is-linie" />
            {`erwartet: ${personProzent(erwartetProzent)} ${richtungWort(erwartetProzent)}`}
          </span>
        )}
      </p>
    </div>
  );
}
