import React from 'react';
import ReactDOM from 'react-dom/client';
import { EnergieBuehne } from '../src/components/EnergieBuehne';
import type { History, HistoryBucket, SchedulePlan, ScheduleSlot } from '../src/api';
import { tagAus } from '../src/tagesleiste';
import type { Betrieb } from '../src/leitungsplan';
import type { VerbrauchKomposition } from '../src/verbrauchKomposition';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../src/index.css';

// Ausschließlich fiktive Werte („Sonnenhof“ aus den Test-Fixtures). Ein Tag mit
// Sonne mittags, Speicher lädt ab 11 Uhr, abends aus dem Speicher.
const q = new URLSearchParams(location.search);
const betrieb = (q.get('betrieb') ?? 'eigenverbrauch') as Betrieb;
const phone = matchMedia('(max-width: 720px)').matches;
const now = new Date();
now.setHours(13, 52, 0, 0);
const mitternacht = new Date(now); mitternacht.setHours(0, 0, 0, 0);
const iso = (i: number) => new Date(mitternacht.getTime() + i * 900000).toISOString();
const skala = betrieb === 'spitze' ? 60 : betrieb === 'markt' ? 16 : 1;
const glocke = (h: number) => (h <= 7.3 || h >= 19.1 ? 0 : Math.pow(Math.sin((Math.PI * (h - 7.3)) / 11.8), 1.3));
function moment(i: number) {
  const h = i / 4 + 0.125;
  const pv = 7.2 * glocke(h) * skala;
  const load = (0.9 + 0.8 * Math.exp(-((h - 7) ** 2) / 2) + 1.6 * Math.exp(-((h - 19) ** 2) / 3) + (h > 12.5 && h < 14.5 ? 3.1 : 0)) * skala;
  let batt = 0;
  const sur = pv - load;
  if (sur > 0.05 * skala) batt = Math.min(sur, 3.2 * skala);
  else if (h > 17) batt = -Math.min(-sur, 3.2 * skala);
  const grid = load + batt - pv;
  return { pv, load, batt, grid, soc: Math.min(98, 8 + Math.max(0, h - 11) * 9) };
}
const jetztI = 55;
const buckets: HistoryBucket[] = [];
for (let i = 0; i <= jetztI; i++) {
  const m = moment(i);
  buckets.push({
    start: iso(i), pvKwh: m.pv / 4, loadKwh: m.load / 4,
    gridImportKwh: Math.max(m.grid, 0) / 4, gridExportKwh: Math.max(-m.grid, 0) / 4,
    batteryChargeKwh: Math.max(m.batt, 0) / 4, batteryDischargeKwh: Math.max(-m.batt, 0) / 4,
    socMinPct: m.soc, socMaxPct: m.soc, socLastPct: m.soc,
    priceEurMwh: 80 + 120 * Math.sin(i / 15), costEur: null,
  });
}
const history = { range: 'day', from: iso(0), to: iso(96), bucketMinutes: 15, buckets, totals: {}, protocol: [], plan: [] } as unknown as History;
const slots: ScheduleSlot[] = [];
for (let i = jetztI; i < 96; i++) {
  const m = moment(i);
  const role = betrieb === 'markt' ? (i >= 72 && i < 86 ? 'verkaufen' : i < 28 ? 'guenstig_laden' : 'warten') : m.batt > 0 ? 'pv_speichern' : m.batt < 0 ? 'eigenverbrauch' : 'warten';
  slots.push({ start: iso(i), batteryKw: m.batt, gridKw: m.grid, socPct: m.soc, priceEurMwh: 80 + 120 * Math.sin(i / 15), pvKw: m.pv, loadKw: m.load, slotRole: role } as ScheduleSlot);
}
const plan = { slotMinutes: 15, slots, peakTargetKw: betrieb === 'spitze' ? 300 : null } as unknown as SchedulePlan;
const tag = tagAus(q.get('ohneTag') ? null : history, q.get('ohneTag') ? null : plan, now);
const m = moment(jetztI);
const teil = (key: string, label: string, kw: number | null, word: string, today: number | null, aktiv = true) =>
  ({ key, label, kw, word, note: null, health: 'ok', aktiv, todayKwh: today, href: null, entityId: key, title: null });
const verbrauch = {
  hausKw: m.load,
  gruppen: [
    { id: 'laden', label: 'Laden', kw: 3.1 * skala, headline: '', teile: [teil('cp:1', 'Wallbox Garage', 3.1 * skala, 'lädt', 3.9 * skala)], collapsed: false, collapsedText: null },
    { id: 'waerme', label: 'Wärme', kw: 1.3 * skala, headline: '', teile: [teil('e:wp', 'Wärmepumpe', 0.9 * skala, 'läuft', 8.6 * skala), teil('e:hs', 'Heizstab Warmwasser', 0, 'aus', 0.4, false)], collapsed: false, collapsedText: null },
    { id: 'sonstiges', label: 'Sonstiges', kw: 0, headline: '', teile: [teil('e:wm', 'Waschmaschine', 0, 'aus', 1.4, false), teil('e:tr', 'Trockner', 0.2 * skala, 'läuft', 0.6)], collapsed: false, collapsedText: null },
  ],
  rest: { kw: Math.max(0, m.load - 4.2 * skala), note: null, konflikt: false, todayKwh: 8.2 * skala },
  verbraucherCount: 5, subLine: null, ladenKw: 3.1 * skala, ladepunktCount: 1, asOf: now.toISOString(),
} as unknown as VerbrauchKomposition;
const pv = {
  totalKw: m.pv, deviceCount: 2, origin: 'entity', asOf: now.toISOString(), unmeasured: [],
  parts: [
    { key: 'sued', label: 'Dach Süd', kw: m.pv * 0.68, health: 'ok', note: null, title: 'WR 1', entityId: 'sued', deviceId: null, alias: null },
    { key: 'carport', label: 'Carport', kw: m.pv * 0.32, health: 'ok', note: null, title: 'WR 2', entityId: 'carport', deviceId: null, alias: null },
  ],
} as never;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <main style={{ maxWidth: 760, margin: '0 auto', padding: 16 }}>
    <h1>Sonnenhof</h1>
    <section style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 22, padding: 14 }}>
      <EnergieBuehne
        jetzt={{ werte: { pv: m.pv, load: m.load, batt: m.batt, grid: m.grid }, socPct: m.soc, hat: { pv: true, batt: q.get('ohneSpeicher') == null } }}
        betrieb={betrieb}
        tag={tag}
        zielKw={betrieb === 'spitze' ? 300 : null}
        verbrauch={verbrauch}
        pv={pv}
        isPhone={phone}
        now={now}
        bestaetigt
      />
    </section>
  </main>,
);
