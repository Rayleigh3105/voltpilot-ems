import ReactDOM from 'react-dom/client';

import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';
import '../src/components/Erloese.css';

import { Card } from '../designsystem/components/core/Card';
import { Icon } from '../designsystem/components/core/Icon';
import { MiniShareBar } from '../src/components/MiniChart';
import type { SiteEarnings } from '../src/api';
import { erloesErgebnis, type ErgebnisZeile } from '../src/erloesKomposition';

/**
 * P0 der Erlöse-Welt (Konzept `vp-erloese-seite-konzept-e2` §2.3 B1/B2/B6b):
 * die drei Defekte der Live-Karte nebeneinander, gerechnet durch das ECHTE
 * `erloesErgebnis()` mit den Fixtures des Konzepts (`derived.json`).
 *
 * ⚠ Der Rumpf ist eine LAYOUT-Sonde, kein zweiter Renderer: er trägt genau die
 * Klassen der Karte (`vp-ekomp-*`, `vp-erg-steering-*`), damit die Messung im
 * echten Chrome (0 px Überlauf bei 375/768/1440, Ton-Farben in Hell und
 * Dunkel) das Blatt prüft, das die Seite ausliefert. Die ZAHLEN und SÄTZE
 * kommen aus der einen Ableitung — sie werden hier nirgends nachgebaut.
 */
const BASIS: SiteEarnings = {
  siteId: 's1',
  name: 'Fixture',
  range: 'day',
  from: '2026-09-01T22:00:00Z',
  to: '2026-09-02T22:00:00Z',
  plantKind: 'direktvermarktung',
  tarifArt: 'fest',
  tarifParamCtKwh: 25,
  tarifPriced: true,
  anzulegenderWertCtKwh: 8.11,
  coveredSlots: 96,
  firstCoveredDate: '2026-06-01',
  reason: null,
  einspeiseErloesEur: 26.134,
  eigenverbrauchsWertEur: 38.684,
  stromkostenEur: 1.585,
  nettoErgebnisEur: 63.233,
  savedEur: -2.67,
  arbitrageEur: null,
  pvShiftEur: null,
  baselineEur: -63,
  actualEur: -24.549,
  marktpraemieEur: 4.79,
  bezugspreisCtKwh: 25,
  realizedExportCtKwh: 6.1,
  marketValueSolarCtKwh: 5.8,
  marketValueProvisional: true,
  bezogenKwh: 6.34,
  eingespeistKwh: 345.2,
  selbstverbrauchKwh: 154.736,
  batterieBewegtKwh: 71.6,
  gesamtertragEur: 64.818,
  expectedMarketValueSolarCtKwh: null,
  expectedMarketValueFrom: null,
  expectedMarketValueTo: null,
  expectedMarketValueSlots: null,
  series: [],
  peakShaving: null,
} as SiteEarnings;

const FAELLE: Array<{ id: string; titel: string; money: SiteEarnings; label: string; now: Date }> = [
  {
    id: 'b1-praemie-ruht',
    titel: 'B1 · Negativpreis-Tag (`dv-praemie-ruht`) — Einspeise-Erlös negativ',
    label: 'Mo., 24.08.2026',
    now: new Date('2026-09-02T10:19:00Z'),
    money: {
      ...BASIS,
      from: '2026-08-23T22:00:00Z',
      to: '2026-08-24T22:00:00Z',
      einspeiseErloesEur: -1.42,
      eigenverbrauchsWertEur: 30.1,
      stromkostenEur: 0.98,
      nettoErgebnisEur: 27.7,
      savedEur: 6.8,
      marktpraemieEur: 0.61,
      selbstverbrauchKwh: 120.4,
    },
  },
  {
    id: 'b2-laufend',
    titel: 'B2 · laufender Tag (`dv-tag-laufend`) — Zurechnung negativ, Ton neutral',
    label: 'Mi., 02.09.2026',
    now: new Date('2026-09-02T10:19:00Z'),
    money: BASIS,
  },
  {
    id: 'b2-abgeschlossen',
    titel: 'B2 · derselbe Tag, abgeschlossen — Ton Bernstein',
    label: 'Mi., 02.09.2026',
    now: new Date('2026-09-03T10:19:00Z'),
    money: BASIS,
  },
  {
    id: 'b6-ohne-tarif',
    titel: 'B6b · ohne Stromtarif, aber bewertet (`eeg-ohne-tarif`)',
    label: 'Di., 01.09.2026',
    now: new Date('2026-09-02T12:05:00Z'),
    money: {
      ...BASIS,
      from: '2026-08-31T22:00:00Z',
      to: '2026-09-01T22:00:00Z',
      plantKind: 'eigenverbrauch',
      tarifArt: 'ohne',
      tarifParamCtKwh: null,
      tarifPriced: true,
      einspeiseErloesEur: 1.995,
      eigenverbrauchsWertEur: null,
      stromkostenEur: 1.118,
      nettoErgebnisEur: 0.877,
      savedEur: 3.4,
      marktpraemieEur: null,
      selbstverbrauchKwh: 18.2,
    },
  },
];

function Zeile({ row }: { row: ErgebnisZeile }) {
  return (
    <li className={row.eur == null ? 'vp-ekomp-row vp-ekomp-off' : 'vp-ekomp-row'}>
      <span className="vp-ekomp-dot" style={{ background: row.hue }} aria-hidden="true" />
      <span className="vp-ekomp-name">{row.label}</span>
      <MiniShareBar className="vp-ekomp-bar" fraction={row.barFraction} color={row.hue} />
      <span className="vp-ekomp-value">
        {row.eur != null && (
          <span className="vp-ekomp-sign" aria-hidden="true">
            {row.vorzeichen === 'minus' ? '−' : '+'}
          </span>
        )}
        <span className="vp-ekomp-amount">{row.valueText}</span>
      </span>
      {row.note && <span className="vp-ekomp-note">{row.note}</span>}
    </li>
  );
}

function Karte({ id, titel, money, label, now }: (typeof FAELLE)[number]) {
  const v = erloesErgebnis({ money, periodLabel: label, now });
  return (
    <Card padding="lg" radius="lg" data-fall={id} style={{ marginBottom: 16, minWidth: 0 }}>
      <p style={{ margin: 0, fontSize: '0.8rem', fontWeight: 700, color: '#718096' }}>{titel}</p>
      <p className={v.richtung === 'kosten' ? 'vp-erg-netto vp-erg-kosten' : 'vp-erg-netto'}>
        {v.nettoText}
      </p>
      <p className="vp-erg-satz">{v.nettoSatz}</p>
      {v.steering && (
        <p
          className={`vp-erg-steering vp-erg-steering-${v.steeringTon ?? 'ok'}`}
          title={v.steeringTitel ?? undefined}
        >
          <Icon name="zap" size={14} aria-hidden="true" />
          {v.steering}
        </p>
      )}
      <ul className="vp-ekomp">
        {v.rows.map((r) => (
          <Zeile key={r.id} row={r} />
        ))}
      </ul>
    </Card>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 16, maxWidth: 720, margin: '0 auto' }}>
    {FAELLE.map((f) => (
      <Karte key={f.id} {...f} />
    ))}
  </main>,
);
