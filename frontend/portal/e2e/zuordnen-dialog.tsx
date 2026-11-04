import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { ZuordnenDialog } from '../src/components/ZuordnenDialog';
import type { AdoptableSource } from '../src/rollen';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

/**
 * Bühne „Gerät zuordnen" (vp-geraet-zuordnen-dialog): der ECHTE `ZuordnenDialog` je Geräteart.
 * `?art=verbraucher|wallbox|pv|netz|unbekannt`, `&wieder=1` stellt eine verwaiste Komponente
 * daneben (Wahl „Wieder verbinden"). Kein Aufruf verlässt die Seite - die Bühne zeigt nur.
 */
const ARTEN: Record<string, Partial<AdoptableSource>> = {
  verbraucher: { summary: 'Heizstab', role: 'consumer', brand: null, suggestedType: 'generic-load' },
  wallbox: { summary: 'go-e Charger', role: 'consumer', brand: 'go-e', suggestedType: 'wallbox' },
  pv: { summary: 'Fronius Anlage WR2', role: 'pv-generation', brand: 'fronius_sunspec', suggestedType: 'producer' },
  netz: { summary: 'Shelly Pro 3EM', role: 'grid-meter', brand: 'shelly', suggestedType: 'grid-meter' },
  unbekannt: { summary: 'Unbekanntes Gerät', role: null, brand: null, suggestedType: null },
};

const params = new URLSearchParams(location.search);
const art = ARTEN[params.get('art') ?? 'verbraucher'] ?? ARTEN.verbraucher;
const source: AdoptableSource = {
  id: 'src-buehne',
  role: null,
  brand: null,
  model: null,
  label: art.summary ?? null,
  roleLabel: '',
  summary: '',
  suggestedType: null,
  ...art,
};
const candidates =
  params.get('wieder') === '1' ? [{ entityId: 'alt-1', label: `${source.summary} (alt)` }] : [];

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ZuordnenDialog
      siteId="site-buehne"
      source={source}
      candidates={candidates}
      onClose={() => {}}
      onAssigned={() => {}}
    />
  </React.StrictMode>,
);
