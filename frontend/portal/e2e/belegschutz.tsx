import './rollen-fixture';
import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { ApiError, type SiteEntity } from '../src/api';
import { GeraetGefahrenzone, gefahrMenueLabel } from '../src/components/GeraetGefahrenzone';
import { RowMenu } from '../src/components/RowMenu';
import { entitiesApi } from '../src/entitiesApi';
import { gefahrenzone } from '../src/geraetLoeschen';
import { plantModel } from '../src/komponenten';
import { berichtsBelege } from '../src/uemsBericht';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

/**
 * Bühne der Gefahrenzone mit Belegschutz (UEMS AP-12 IP-12, Referenzfall B12): die ECHTE `GeraetGefahrenzone` an der
 * Komponente hinter MS-12 — K-8.3 „Zähler Energiekarte EK-3 (Montage M1)“ der Referenzdatei. Die Cloud antwortet auf
 * „Endgültig entfernen“ mit genau dem Körper, den `BelegeImWeg.koerper()` für B12 schreibt: 409 `berichts_belege`,
 * vier Stände, die zitierte Messstelle.
 */
const K83: SiteEntity = {
  id: '00000000-0000-4000-8000-0000000008c3',
  entityType: 'grid-meter',
  typeLabel: 'Zähler',
  role: 'grid-meter',
  label: 'Zähler Energiekarte EK-3 (Montage M1)',
  control: false,
  deviceId: 'box-halle-2',
  capabilities: { measure: [{ channel: 'energy_import_kwh', unit: 'kWh' }] },
  guards: null,
  syncStatus: 'in_sync',
  observed: { health: 'ok', lastTelemetryAt: null, channels: [], appliedType: null, reportedAt: '' },
  edgeSourceId: 'ek-3',
};

const STAENDE = [
  { kennung: 'BR-2026-0001', nr: 1 },
  { kennung: 'BR-2026-0001', nr: 2 },
  { kennung: 'BR-2026-0002', nr: 1 },
  { kennung: 'BR-2026-0004', nr: 1 },
];

Object.assign(entitiesApi, {
  removeComponent: async () => {
    const satz = berichtsBelege(STAENDE);
    throw new ApiError(409, satz, {
      code: 'berichts_belege',
      codes: ['berichts_belege'],
      message: satz,
      messstellen: [{ id: '00000000-0000-4000-8000-0000000000c2', kennzeichen: 'MS-12', name: 'Montage Linie M1' }],
      berichtsstaende: STAENDE,
    });
  },
});

/**
 * Seit der Geräteseite „ein Blick, eine Antwort“ (main d1b97ac39) öffnet die Rückfrage über das Menü „⋯“ (Weitere
 * Aktionen) im Kopf — die Bühne trägt denselben Eintrag wie `GeraetSeiteSection` (Label aus `gefahrMenueLabel`, Recht
 * `komponente.loeschen`).
 */
function Fixture() {
  const [offen, setOffen] = useState(false);
  const model = plantModel([K83], null, []);
  const zustand = gefahrenzone(model.components, (id) => (id === K83.id ? K83 : undefined));
  const label = gefahrMenueLabel(zustand);
  return (
    <main className="vp-main" style={{ padding: 'var(--vp-space-4)', maxWidth: 960, margin: '0 auto' }}>
      {zustand == null && <p data-testid="kein-zustand">Die Bühne hat keinen Gefahrenzonen-Zustand.</p>}
      {label && (
        <RowMenu
          label="Weitere Aktionen"
          items={[{ label, icon: 'trash', danger: true, onClick: () => setOffen(true), recht: 'komponente.loeschen' }]}
        />
      )}
      <GeraetGefahrenzone
        siteId="an-2"
        zustand={zustand}
        name={K83.label ?? ''}
        offen={offen}
        onSchliessen={() => setOffen(false)}
        onDone={() => {}}
      />
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />);
