import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { api } from '../src/api';
import { keycloak } from '../src/auth';
import { GeraeteKatalog } from '../src/components/GeraeteKatalog';
import type { ComponentTemplate } from '../src/komponentenAssistent';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

(keycloak as unknown as { token: string; updateToken: () => Promise<boolean> }).token = 'e2e-token';
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;

/**
 * E2E-Bühne für den Vorher/Nachher-Beweis des Katalog-Modals „Gerät hinzufügen" (Auftrag vom 05.11.2026, Captain:
 * „ist das zu hochkant", Nachtrag: Mobil bleibt in der heutigen Linie). Ein eigener, größerer Katalog (Deye 37,
 * KACO 72 Modelle - wie im Screenshot des Auftrags) macht den „Turm" auf dem heutigen Stand sichtbar; die echten
 * Fixtures (`geraetesucheFixtures.ts`) haben dafür zu wenige Modelle. Rein zum Anschauen und für
 * `geraete-katalog-breite.spec.ts` - keine Fachlogik, kein Netz.
 */
function marken(brand: string, brandLabel: string, n: number, extra: Record<string, unknown>): ComponentTemplate[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: 'builtin',
    version: 1,
    deviceType: 'inverter',
    templateRef: `builtin:${brand}:modell-${i + 1}`,
    brand,
    brandLabel,
    model: `modell-${i + 1}`,
    modelLabel: `${brandLabel}-${i + 1}`,
    ratedKw: 5 + (i % 20),
    ...extra,
  })) as unknown as ComponentTemplate[];
}

const solarman = { communication: 'solarman_v5', communicationLabel: 'Solarman-V5 (WiFi-Datenlogger, TCP 8899)' };
const kacoHttp = { communication: 'kaco_http', communicationLabel: 'App-Schnittstelle der Kommunikationseinheit (HTTP 8484)' };
const froniusApi = { communication: 'fronius_solar_api', communicationLabel: 'Solar API (HTTP)' };
const huaweiModbus = { communication: 'huawei_modbus', communicationLabel: 'Modbus-TCP (SmartLogger)' };
const kostalModbus = { communication: 'kostal_modbus', communicationLabel: 'Modbus-TCP' };

const TEMPLATES: ComponentTemplate[] = [
  ...marken('deye', 'Deye', 37, solarman),
  ...marken('fronius', 'Fronius', 4, froniusApi),
  ...marken('huawei', 'Huawei', 6, huaweiModbus),
  ...marken('kaco', 'KACO', 72, kacoHttp),
  ...marken('kostal', 'KOSTAL', 5, kostalModbus),
  {
    kind: 'builtin', version: 1, deviceType: 'charge_point', templateRef: 'builtin:keba:p30', brand: 'keba', brandLabel: 'KEBA',
    model: 'p30', modelLabel: 'KEBA P30', communication: 'ocpp', communicationLabel: 'OCPP 1.6',
  } as unknown as ComponentTemplate,
  {
    // `deviceType: 'io_module'`, NICHT 'switch': ein einzelner Schalter (Shelly) ist im Katalog absichtlich
    // ausgeschlossen (`alsModellAngeboten` in `geraeteKatalog.ts` - er kommt nur über „Geräte suchen" als Heizstab).
    // Das I/O-Modul Ebyte M31 ist dagegen ein gewöhnlicher Katalog-Eintrag unter „Schalten" (Auftrags-Screenshot).
    kind: 'builtin', version: 1, deviceType: 'io_module', templateRef: 'builtin:ebyte:m31', brand: 'ebyte', brandLabel: 'Ebyte',
    model: 'm31', modelLabel: 'Ebyte M31', communication: 'modbus_tcp', communicationLabel: 'Modbus-TCP',
  } as unknown as ComponentTemplate,
  {
    kind: 'builtin', version: 1, deviceType: 'meter', templateRef: 'builtin:wago:750-494', brand: 'wago', brandLabel: 'WAGO',
    model: '750-494', modelLabel: 'WAGO 750-494/495', communication: 'modbus_tcp', communicationLabel: 'Modbus-TCP',
  } as unknown as ComponentTemplate,
];

const belegt: Record<string, (...args: never[]) => Promise<unknown>> = {
  componentTemplates: () => Promise.resolve(TEMPLATES),
  siteComponentTemplates: () => Promise.resolve([]),
};
const offen = api as unknown as Record<string, unknown>;
for (const [name, wert] of Object.entries(offen)) {
  if (typeof wert !== 'function') continue;
  offen[name] = belegt[name] ?? (() => Promise.reject(new Error(`E2E-Bühne: ${name} ist nicht belegt`)));
}

function Harness() {
  const [open, setOpen] = React.useState(true);
  return (
    <div style={{ padding: 24 }}>
      <button type="button" onClick={() => setOpen(true)}>
        Gerät hinzufügen
      </button>
      <GeraeteKatalog
        open={open}
        siteId="s1"
        funde={[]}
        onClose={() => setOpen(false)}
        onWahl={(wahl) => {
          (window as unknown as { __wahl: unknown }).__wahl = wahl;
          setOpen(false);
        }}
        onSuche={() => {
          (window as unknown as { __wahl: unknown }).__wahl = { art: 'suche' };
          setOpen(false);
        }}
      />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Harness />);
