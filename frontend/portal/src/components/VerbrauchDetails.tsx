import { Icon } from '../../designsystem/components/core/Icon';
import { standLabel } from '../datenAlter';
import { fmtNum } from '../format';
import { NO_DATA } from '../nodata';
import {
  anteilVon,
  type VerbrauchGruppe,
  type VerbrauchKomposition,
  type VerbrauchTeil,
} from '../verbrauchKomposition';
import { MiniShareBar } from './MiniChart';

import './VerbrauchDetails.css';

/**
 * „Verbrauch setzt sich zusammen aus …" - das Inline-Panel hinter der
 * Board-Zeile „Hausverbrauch" (Konzept `vp-verbraucher-cockpit-k1` §4.1).
 *
 * Das Spiegelbild von {@link ./PvBreakdown} `PvCompositionDetails`, mit einem
 * Unterschied, der die ganze Fläche prägt: eine PV-Zeile hat IMMER eine Zahl
 * oder einen Grund, eine Verbraucher-Zeile hat ein ZUSTANDSWORT - und das steht
 * auch dort, wo es keine Leistung zu messen gibt.
 *
 * Rein zeichnend: jede Zahl, jedes Wort und jede Sortierung kommt aus der
 * getesteten {@link ../verbrauchKomposition}.
 */
export function VerbrauchDetails({
  komposition,
  now = new Date(),
}: {
  komposition: VerbrauchKomposition;
  now?: Date;
}) {
  const { gruppen, rest } = komposition;
  const stand = standLabel(komposition.asOf, now);
  // Der Balken zeigt die gemessenen Teile plus den Rest - er ist damit genau
  // die Haus-Summe, oder er wird gar nicht gezeichnet.
  const teile = gruppen.flatMap((g) => (g.collapsed ? [] : g.teile)).filter((t) => t.kw != null);
  const balken = rest.kw != null && teile.length > 0;
  return (
    <div className="vp-vbcomp">
      <div className="vp-vbcomp-head">
        <span className="vp-vbcomp-title">Verbrauch setzt sich zusammen aus</span>
        <span className="vp-vbcomp-count">
          {komposition.verbraucherCount} Verbraucher
        </span>
      </div>

      {balken && (
        <MiniShareBar
          className="vp-vbcomp-bar"
          segments={[
            ...teile.map((t) => ({
              key: t.key,
              weight: Math.max(anteilVon(t, komposition), 0.001),
              className: 'vp-vbcomp-seg',
              title: t.label,
            })),
            {
              key: 'rest',
              weight: Math.max((rest.kw ?? 0) / (komposition.hausKw || 1), 0.001),
              className: 'vp-vbcomp-seg rest',
              title: 'übriger Haushalt',
            },
          ]}
        />
      )}

      {/* Ab 1100 px zweispaltig (Konzept §3): sonst stünde die Zahl einer Zeile
          über einen Meter vom Namen entfernt, und niemand liest das als Paar. */}
      <div className="vp-vbcomp-groups">
        {gruppen.map((g) => (
          <Gruppe key={g.id} gruppe={g} />
        ))}
      </div>

      {/* Der Rest ist eine DIFFERENZ, kein Gerät: kein Punkt, kein Sprung. */}
      <ul className="vp-vbcomp-rows">
        <li className="vp-vbcomp-row rest">
          <span className="vp-vbcomp-name">übriger Haushalt</span>
          {rest.kw == null ? (
            <span className="vp-vbcomp-word" title={rest.note ?? undefined}>
              {rest.note}
            </span>
          ) : (
            <span className="vp-vbcomp-val">{fmtNum(rest.kw, 'kW')}</span>
          )}
          <Heute kwh={rest.todayKwh} />
        </li>
      </ul>

      {stand && <p className="vp-vbcomp-stand">{stand}</p>}
    </div>
  );
}

function Gruppe({ gruppe }: { gruppe: VerbrauchGruppe }) {
  return (
    <div className="vp-vbcomp-group">
      <div className="vp-vbcomp-gh">
        <span>{gruppe.label}</span>
        <b>{gruppe.headline}</b>
      </div>
      {gruppe.collapsed ? (
        // E4: eine Zahl hat EINEN Wohnort. Stehen die Ladepunkt-Zeilen schon
        // in der Kachel „Laden", trägt die Gruppe hier nur ihre Summe - und
        // sagt, wo die Zeilen stehen.
        <ul className="vp-vbcomp-rows">
          <li className="vp-vbcomp-row quiet sum">
            <span className="vp-vbcomp-name">
              {gruppe.collapsedText}
              <span className="vp-vbcomp-hint"> · in der Kachel „Laden"</span>
            </span>
            {gruppe.kw != null && <span className="vp-vbcomp-val">{fmtNum(gruppe.kw, 'kW')}</span>}
          </li>
        </ul>
      ) : (
        <ul className="vp-vbcomp-rows">
          {gruppe.teile.map((t) => (
            <Zeile key={t.key} teil={t} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Zeile({ teil }: { teil: VerbrauchTeil }) {
  const inhalt = (
    <>
      <span className={`vp-pvsplit-dot ${teil.health}`} aria-hidden="true" />
      <span className="vp-vbcomp-name" title={teil.title ?? undefined}>
        {teil.label}
        {teil.note && <span className="vp-vbcomp-hint">{teil.note}</span>}
      </span>
      {/* „Nicht messbar ist nie 0": ohne Messwert steht hier das WORT. */}
      {teil.kw == null ? (
        <span className="vp-vbcomp-word">{teil.word}</span>
      ) : (
        <span className="vp-vbcomp-val">
          <span className="vp-vbcomp-wordinline">{teil.word}</span>
          {fmtNum(teil.kw, 'kW')}
        </span>
      )}
      <Heute kwh={teil.todayKwh} />
    </>
  );
  const cls = `vp-vbcomp-row${teil.aktiv ? '' : ' quiet'}`;
  if (!teil.href) return <li className={cls}>{inhalt}</li>;
  return (
    <li className={`${cls} is-link`}>
      <a className="vp-vbcomp-link" href={teil.href} aria-label={`${teil.label} öffnen`}>
        {inhalt}
        <span className="vp-vbcomp-go" aria-hidden="true">
          <Icon name="chevron-right" size={14} />
        </span>
      </a>
    </li>
  );
}

/** Die HEUTE-Spalte des Boards, hier je Zeile - „—" ohne belegbare Summe. */
function Heute({ kwh }: { kwh: number | null }) {
  return (
    <span className="vp-vbcomp-today">
      <span className="vp-vbcomp-today-cap" aria-hidden="true">heute</span>
      {kwh == null ? NO_DATA : fmtNum(kwh, 'kWh')}
    </span>
  );
}
