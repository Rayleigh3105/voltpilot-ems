import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { ApiError, type SteuerwegAntwort, type SteuerwegGeraet, type SteuerwegRegel } from '../src/api';
import { api } from '../src/apiVoll';
import { keycloak } from '../src/auth';
import { SteuerwegAbschnitt } from '../src/steuerung/SteuerwegAbschnitt';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';
import '../src/steuerung/steuerung.css';

(keycloak as unknown as { token: string }).token = 'e2e-token';
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;

/**
 * E2E-Bühne „Wie Ihre Regeln und Steuerarten laufen“ (Steuerlogik Stufe 6, Zusammenführen): der Abschnitt im Reiter
 * „Regeln“ mit dem Schalter der Anlage. `?stand=alt` (ab Werk), `mitlauf` (der Vergleich läuft), `kern` (übernommen),
 * `light` (eine Edge Light: Regeln immer im Kern, die Steuerarten am Schalter), `leser` (ohne das Recht, den Schalter
 * zu stellen), `nur-regeln` (eine Anlage ohne Steuerarten, wie im zweiten Teil). Die Schritte gehen an eine gestellte
 * API, die den Stand fortschreibt, wie die echte (SteuerwegApiTest, SteuerwegGeraeteApiTest).
 *
 * Fiktive Anlage mit drei Regeln aus dem Regel-Baukasten: „Mittagssonne nutzen“ (Pumpe, 2 kW Sonnenstrom),
 * „Nachts laufen lassen“ (Heizstab, 22:00 bis 06:00) und eine Regel aus dem freien Editor, die sich nicht übersetzen
 * lässt. Im Vergleich weicht „Nachts“ eine Stunde ab: der bisherige Weg rechnet das Zeitfenster heute in UTC
 * (Befund im Vertrag, steuerlogik.md „Zusammenführen“). Dazu zwei Geräte mit Steuerart: die „Poolpumpe“ mit
 * „Solar-Überschuss“ (die Verbraucherregel) und der „Heizstab Warmwasser“ (der Heizstab-Regler der Box), und eine
 * Wallbox, die ihren eigenen Ort hat.
 */
const stand = new URLSearchParams(window.location.search).get('stand') ?? 'alt';

const FREI = 'Die Regel ist im freien Editor gebaut; übersetzen lassen sich nur Regeln des Regel-Baukastens.';
const regeln = (weg: 'alt' | 'mitlauf' | 'kern'): SteuerwegRegel[] => {
  const sonne: SteuerwegRegel = { flowId: 'r-sonne', name: 'Mittagssonne nutzen', weg, gruende: [], logikId: weg === 'alt' ? null : 'l-sonne',
    logikFassung: weg === 'alt' ? null : 1, gemeldetAm: weg === 'alt' ? null : '2026-11-16T13:02:00Z', vergleich: null };
  const nacht: SteuerwegRegel = { flowId: 'r-nacht', name: 'Nachts laufen lassen', weg, gruende: [], logikId: weg === 'alt' ? null : 'l-nacht',
    logikFassung: weg === 'alt' ? null : 1, gemeldetAm: weg === 'alt' ? null : '2026-11-16T13:02:00Z', vergleich: null };
  if (weg === 'mitlauf') {
    sonne.vergleich = { zustand: 'mitlaufend', wunsch: { ein: true }, ist: { ein: true }, verglichen_s: 47_520, abweichend_s: 0, laengste_abweichung_s: 0 };
    nacht.vergleich = { zustand: 'mitlaufend', wunsch: { ein: false }, ist: { ein: false }, verglichen_s: 47_520, abweichend_s: 3_600, laengste_abweichung_s: 3_600 };
  }
  if (weg === 'kern') {
    sonne.vergleich = { zustand: 'scharf', wunsch: { ein: true }, befehl: { ein: true }, ist: { ein: true } };
    nacht.vergleich = { zustand: 'scharf', wunsch: { ein: false }, befehl: { ein: false }, ist: { ein: false } };
  }
  return [sonne, nacht, { flowId: 'r-frei', name: 'Heizstab bei Wärmepumpe aus', weg: 'alt', gruende: weg === 'alt' ? [] : [FREI],
    logikId: null, logikFassung: null, vergleich: null, gemeldetAm: null }];
};

const WALLBOX = 'Ein Ladepunkt hat seinen eigenen Ort (Laden); eine Logik des Kerns beansprucht ihn nicht.';
const geraete = (weg: 'alt' | 'mitlauf' | 'kern'): SteuerwegGeraet[] => {
  const an = weg !== 'alt';
  const pumpe: SteuerwegGeraet = { art: 'steuerart', entityId: 'e-pumpe', name: 'Poolpumpe', weg, gruende: [],
    logikId: an ? 'l-pumpe' : null, logikFassung: an ? 1 : null, gemeldetAm: an ? '2026-11-16T13:02:00Z' : null, vergleich: null };
  const stab: SteuerwegGeraet = { art: 'heizstab', entityId: 'e-stab', name: 'Heizstab Warmwasser', weg, gruende: [],
    logikId: an ? 'l-stab' : null, logikFassung: an ? 1 : null, gemeldetAm: an ? '2026-11-16T13:02:00Z' : null, vergleich: null };
  if (weg === 'mitlauf') {
    pumpe.vergleich = { zustand: 'mitlaufend', wunsch: { ein: true }, ist: { ein: true }, verglichen_s: 47_520, abweichend_s: 0, laengste_abweichung_s: 0 };
    stab.vergleich = { zustand: 'mitlaufend', wunsch: { stufe: 2 }, ist: { stufe: 2 }, verglichen_s: 47_520, abweichend_s: 0, laengste_abweichung_s: 0 };
  }
  if (weg === 'kern') {
    pumpe.vergleich = { zustand: 'scharf', wunsch: { ein: true }, befehl: { ein: true }, ist: { ein: true } };
    stab.vergleich = { zustand: 'scharf', wunsch: { stufe: 2 }, befehl: { stufe: 2 }, ist: { stufe: 2 } };
  }
  return [pumpe, stab, { art: 'steuerart', entityId: 'e-wallbox', name: 'Wallbox Garage', weg: 'alt',
    gruende: weg === 'alt' ? [] : [WALLBOX], logikId: null, logikFassung: null, vergleich: null, gemeldetAm: null }];
};

/** Der Stand der Bühne: wo die Regeln und wo die Steuerarten stehen. */
function antwort(s: string, geraeteModus?: 'alt' | 'mitlauf' | 'kern'): SteuerwegAntwort {
  const light = s === 'light';
  const modus = light || s === 'kern' ? 'kern' : s === 'mitlauf' ? 'mitlauf' : 'alt';
  const gm = geraeteModus ?? (light ? 'alt' : modus);
  const r = regeln(modus);
  return {
    stand: {
      modus, seit: modus === 'alt' ? null : '2026-11-16T07:48:00Z', boxArt: light ? 'light' : 'docker',
      boxKannMitlauf: true, boxKannScharf: true, regeln: light ? r.slice(0, 2) : r, schritte: [],
      geraeteModus: gm, geraeteSeit: gm === 'alt' ? null : '2026-11-16T07:48:00Z', boxKannSteuerarten: true,
      geraete: s === 'nur-regeln' ? [] : geraete(gm),
    },
    darf: s !== 'leser',
  };
}

let jetzt = antwort(stand);
const gesendet: string[] = [];
(window as unknown as { gesendet: string[] }).gesendet = gesendet;
const belegt: Record<string, (...args: never[]) => Promise<unknown>> = {
  steuerweg: (() => Promise.resolve(structuredClone(jetzt))) as never,
  steuerwegSchritt: ((_site: string, schritt: string) => {
    gesendet.push(schritt);
    const ziel = schritt === 'mitlauf' ? 'mitlauf' : schritt === 'uebernehmen' ? 'kern' : 'alt';
    // Auf einer Edge Light bewegt der Schritt nur die Steuerarten; die Regeln bleiben im Kern.
    jetzt = stand === 'light' ? antwort('light', ziel) : antwort(ziel === 'alt' && stand === 'nur-regeln' ? 'nur-regeln' : ziel);
    if (stand === 'nur-regeln') jetzt.stand.geraete = [];
    return Promise.resolve(structuredClone(jetzt));
  }) as never,
};
const offen = api as unknown as Record<string, unknown>;
for (const [name, wert] of Object.entries(offen)) {
  if (typeof wert !== 'function') continue;
  offen[name] = belegt[name] ?? (() => Promise.reject(new ApiError(404, `E2E-Bühne: ${name} ist nicht belegt`)));
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="stn" style={{ maxWidth: 1180, margin: '0 auto', padding: '16px' }}>
      <div className="stn-main steuerung">
        <SteuerwegAbschnitt siteId="site-1" schluessel="r-sonne:1,r-nacht:1,r-frei:2" />
      </div>
    </div>
  </React.StrictMode>,
);
