import ReactDOM from 'react-dom/client';

import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';
import '../src/components/Historie.css';
import '../src/components/Erloese.css';

import { Card } from '../designsystem/components/core/Card';
import { DeltaZeile } from '../src/components/HistorieWelt';
import { erloesVergleich, type VergleichsEimer } from '../src/vergleichLaufend';
import type { HistoryRange } from '../src/api';

/**
 * **Die Vergleichszeile der Erlöse-Karte, mit den Fixtures des Konzepts**
 * (`data/vp-erloese-seite-konzept-e2/derived.json`) — der Browser-Beweis zu P2
 * (E3): am LAUFENDEN Tag ein ruhiger Chip gegen die GLEICHE Stunde des
 * Vortags, bei laufender Woche/Monat/Jahr nur zwei Beträge, und ein
 * abgeschlossener Zeitraum unverändert mit Wort UND Ton.
 *
 * Gemessen wird hier, was jsdom nicht messen kann: dass bei 375 px nichts über
 * den Rand läuft.
 */

/** Stunden-Eimer aus UTC-Start + Netto — nur, was der Vergleich liest. */
const std = (tagUtcStunde: number, netto: number, monat: number, tag: number): VergleichsEimer => ({
  start: new Date(Date.UTC(2026, monat, tag, tagUtcStunde)).toISOString(),
  nettoEur: netto,
});

/** `dv-tag-laufend` — Mi., 02.09.2026, Berliner Stunden 0…12. */
const DV_HEUTE = [
  -0.243, -0.243, -0.243, -0.243, -0.243, 0.574, 2.397, 5.478, 8.321, 10.446, 12.088, 12.57, 12.574,
].map((v, i) => std(22 + i, v, 8, 1));

/** `dv-tag-abgeschlossen` — Di., 01.09.2026, voll. */
const DV_VORTAG = [
  -0.143, -0.143, -0.143, -0.143, -0.143, 0.789, 2.97, 6.846, 10.731, 13.839, 16.162, 16.948,
  16.948, 15.41, 13.087, 9.969, 6.083, 2.201, 0.578, -0.115, -0.145, -0.148, -0.15, -0.151,
].map((v, i) => std(22 + i, v, 7, 31));

/** `eeg-tag-laufend` — Mi., 02.09.2026, Berliner Stunden 0…14. */
const EEG_HEUTE = [
  -0.065, -0.065, -0.065, -0.065, -0.065, -0.002, 0.129, 0.327, 0.485, 0.586, 0.669, 0.686, 0.686,
  0.621, 0.538,
].map((v, i) => std(22 + i, v, 8, 1));

/** `eeg-tag-abgeschlossen` — Di., 01.09.2026, voll. */
const EEG_VORTAG = [
  -0.084, -0.084, -0.084, -0.084, -0.084, -0.003, 0.167, 0.427, 0.635, 0.768, 0.877, 0.901, 0.901,
  0.815, 0.706, 0.568, 0.351, 0.132, 0.033, -0.061, -0.083, -0.085, -0.086, -0.087,
].map((v, i) => std(22 + i, v, 7, 31));

interface Fall {
  id: string;
  titel: string;
  range: HistoryRange;
  anchor: Date;
  now: Date;
  jetztEur: number;
  vorherEur: number;
  jetztSeries?: VergleichsEimer[];
  vorherSeries?: VergleichsEimer[];
}

const FAELLE: Fall[] = [
  {
    id: 'dv-tag-laufend',
    titel: 'Direktvermarktung · laufender Tag, 12:19 (der Screenshot-Fall)',
    range: 'day',
    anchor: new Date('2026-09-02T12:19:00+02:00'),
    now: new Date('2026-09-02T12:19:00+02:00'),
    jetztEur: 63.233,
    vorherEur: 135.224,
    jetztSeries: DV_HEUTE,
    vorherSeries: DV_VORTAG,
  },
  {
    id: 'eeg-tag-laufend',
    titel: 'EEG-Privathaushalt · laufender Tag, 14:05',
    range: 'day',
    anchor: new Date('2026-09-02T14:05:00+02:00'),
    now: new Date('2026-09-02T14:05:00+02:00'),
    jetztEur: 4.4,
    vorherEur: 6.603,
    jetztSeries: EEG_HEUTE,
    vorherSeries: EEG_VORTAG,
  },
  {
    id: 'dv-tag-abgeschlossen',
    titel: 'Direktvermarktung · abgeschlossener Tag (unverändert: Wort UND Ton)',
    range: 'day',
    anchor: new Date('2026-09-01T12:00:00+02:00'),
    now: new Date('2026-09-02T12:19:00+02:00'),
    jetztEur: 135.224,
    vorherEur: 119.983,
  },
  {
    id: 'eeg-woche',
    titel: 'EEG · laufende Woche (nur zwei Beträge, kein Prozent)',
    range: 'week',
    anchor: new Date('2026-09-02T14:05:00+02:00'),
    now: new Date('2026-09-02T14:05:00+02:00'),
    jetztEur: 39.3,
    vorherEur: 41.1,
  },
  {
    id: 'eeg-jahr',
    titel: 'EEG · laufendes Jahr (der längste Satz, für die 375-px-Messung)',
    range: 'year',
    anchor: new Date('2026-09-02T14:05:00+02:00'),
    now: new Date('2026-09-02T14:05:00+02:00'),
    jetztEur: 1080.3,
    vorherEur: 1500.55,
  },
];

function VergleichsKarte(f: Fall) {
  const v = erloesVergleich({
    range: f.range,
    anchor: f.anchor,
    now: f.now,
    jetztEur: f.jetztEur,
    vorherEur: f.vorherEur,
    jetztSeries: f.jetztSeries,
    vorherSeries: f.vorherSeries,
  });
  return (
    <Card padding="lg" radius="lg" data-fall={f.id} style={{ marginBottom: 16, minWidth: 0 }}>
      <p style={{ margin: 0, fontSize: '0.8rem', fontWeight: 700, color: '#718096' }}>{f.titel}</p>
      <p style={{ margin: '6px 0 0', fontSize: '1.9rem', fontWeight: 800 }}>
        + {f.jetztEur.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
      </p>
      {v?.chip && (
        <p className="vp-kpi-delta">
          <DeltaZeile delta={v.chip} />
        </p>
      )}
      {v?.betraege && <p className="vp-erg-vergleich">{v.betraege}</p>}
      {v?.satz && <p className="vp-note vp-note-laufend">{v.satz}</p>}
    </Card>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <div style={{ padding: 16, maxWidth: 1160, margin: '0 auto', minWidth: 0 }}>
    <h1 style={{ fontSize: '1.1rem', margin: '0 0 12px' }}>
      Erlöse · Vergleich eines laufenden Zeitraums (P2 · E3)
    </h1>
    {FAELLE.map((f) => (
      <VergleichsKarte key={f.id} {...f} />
    ))}
  </div>,
);
