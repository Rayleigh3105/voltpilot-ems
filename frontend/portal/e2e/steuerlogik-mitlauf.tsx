import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import {
  api,
  ApiError,
  type SteuerlogikBlatt,
  type SteuerlogikProtokoll,
  type SteuerlogikRueckmeldung,
} from '../src/api';
import { keycloak } from '../src/auth';
import { SteuerlogikMitlaufBlatt } from '../src/pages/admin/SteuerlogikMitlaufBlatt';
import block from '../../../docs/contracts/v2/examples/steuerlogik-rueckmeldung.valid.waermepumpe.json';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

(keycloak as unknown as { token: string }).token = 'e2e-token';
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;
(keycloak as unknown as { tokenParsed: { realm_access: { roles: string[] } } }).tokenParsed =
  { realm_access: { roles: ['platform-admin'] } };

/**
 * E2E-Bühne „Steuerlogik-Mitlauf“ (Stufe 2, zweiter Teil): das Blatt der Plattform mit dem Beispiel der Wärmepumpe,
 * wie die Box es meldet (der gepinnte Block `steuerlogik-rueckmeldung.valid.waermepumpe.json`). `?stand=ohne` zeigt
 * eine Box ohne die Fähigkeit, `?stand=leer` eine Anlage ohne Logik. Fiktive Daten, nie eine echte Cloud.
 */
const stand = new URLSearchParams(window.location.search).get('stand') ?? 'mit';
const lauf = (block as { laeufe: SteuerlogikRueckmeldung[] }).laeufe[0];
const logikId = lauf.flow_id;

const blatt: SteuerlogikBlatt = {
  box: '22222222-2222-4222-8222-222222222222',
  boxKann: stand !== 'ohne',
  logiken: stand === 'leer' ? [] : [{
    logikId,
    name: 'Wärmepumpe',
    fassungen: [
      { fassung: 2, zustand: 'mitlaufend', contentHash: lauf.content_hash, bericht: { name: 'Wärmepumpe', sperrt: false },
        angelegtAm: '2026-11-14T09:59:00Z', angelegtVon: 'sub-betrieb', stillgelegtAm: null },
      { fassung: 1, zustand: 'stillgelegt', contentHash: lauf.content_hash, bericht: null,
        angelegtAm: '2026-11-13T09:00:00Z', angelegtVon: 'sub-betrieb', stillgelegtAm: '2026-11-14T09:59:00Z' },
    ],
    quittung: { fassung: 2, contentHash: lauf.content_hash, zustand: 'active', detail: null, gemeldetAm: '2026-11-14T10:00:02Z' },
    laeufe: [{ box: '22222222-2222-4222-8222-222222222222', fassung: 2, contentHash: lauf.content_hash, zustand: 'mitlaufend',
      seit: lauf.seit, rueckmeldung: { ...lauf, flow_version: 2, unbekannt: stand === 'luecke' ? ['puffer'] : lauf.unbekannt },
      gemeldetAm: '2026-11-14T10:21:05Z' }],
  }],
};

const protokoll: SteuerlogikProtokoll = {
  logikId,
  tag: '2026-11-14',
  wechsel: ((block as { laeufe: { wechsel: SteuerlogikProtokoll['wechsel'] }[] }).laeufe[0].wechsel ?? []).map((w) => ({
    ...w, box: blatt.box!, fassung: 2, laufSeit: lauf.seit,
  })) as SteuerlogikProtokoll['wechsel'],
};

const ok = <T,>(wert: T) => () => Promise.resolve(structuredClone(wert));
const belegt: Record<string, (...args: never[]) => Promise<unknown>> = {
  steuerlogikBlatt: ok(blatt),
  steuerlogikWechsel: ok(protokoll),
  steuerlogikAnnehmen: () => Promise.reject(new ApiError(422, 'abgelehnt', {
    grund: 'pruefung_sperrt', message: 'Die Prüfung sperrt die Logik',
    bericht: { proben: [{ name: 'Kalter Morgen', besteht: false,
      abweichungen: [{ stelle: 'status', soll: 'Heizt aus dem Netz', ist: 'Nachtsperre' }] }] },
  })),
  steuerlogikStilllegen: ok({ stillgelegt: true }),
};
const offen = api as unknown as Record<string, unknown>;
for (const [name, wert] of Object.entries(offen)) {
  if (typeof wert !== 'function') continue;
  offen[name] = belegt[name] ?? (() => Promise.reject(new ApiError(404, `E2E-Bühne: ${name} ist nicht belegt`)));
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="vp-content" style={{ maxWidth: 880, margin: '24px auto', padding: '0 16px' }}>
      <SteuerlogikMitlaufBlatt siteId="site-1" jetzt={new Date('2026-11-14T10:30:00Z')} />
    </div>
  </React.StrictMode>,
);
