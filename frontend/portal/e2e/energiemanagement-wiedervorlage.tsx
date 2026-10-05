import React from 'react';
import ReactDOM from 'react-dom/client';
import { api } from '../src/api';
import { EnergiemanagementWiedervorlage } from '../src/components/EnergiemanagementWiedervorlage';
import { setSelbstauskunft } from '../src/rollen';
import { rechteSeed } from '../src/test/rollenFixtures';
import { verzeichnisDemo, wvDemo, wvLeer, wvNormal, wvR12 } from '../src/test/wiedervorlageFixtures';
import type { Wiedervorlage } from '../src/wiedervorlage';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../src/index.css';

/**
 * Die Wiedervorlage als Arbeitsliste auf einer eigenen Bühne (Konzept Wiedervorlage w1): die ECHTE Seite mit den
 * Antworten von `/energiemanagement/wiedervorlage` und `/verzeichnis`, wie die Routen sie liefern.
 * `?fall=r12|demo|normal|leer|fehler|einsicht` · `&art=…` setzt den Art-Filter aus der Übersicht. Jeder Sprung landet
 * in `window.__sprung` (die Schale ist hier nicht dabei).
 */
const params = new URLSearchParams(location.search);
const fall = params.get('fall') ?? 'r12';
setSelbstauskunft(rechteSeed(fall === 'einsicht' ? 'RF' : 'IK').me);
const antworten: Record<string, Wiedervorlage> = { r12: wvR12(), demo: wvDemo(), normal: wvNormal(), leer: wvLeer(), einsicht: wvR12() };
Object.assign(api, {
  energiemanagementWiedervorlage: async () => {
    if (fall === 'fehler') throw new Error('503');
    return antworten[fall] ?? wvR12();
  },
  energiemanagementVerzeichnis: async () => verzeichnisDemo(),
  energiemanagementWiedervorlageIcs: async () => new Blob(['BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'], { type: 'text/calendar' }),
});
const art = params.get('art');
history.replaceState(null, '', `#/portfolio/energiemanagement/wiedervorlage${art ? `?art=${art}` : ''}`);
const sprung: unknown[] = [];
(window as unknown as { __sprung: unknown[] }).__sprung = sprung;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <main style={{ maxWidth: 1160, margin: '0 auto', padding: 16, background: 'var(--vp-c-bg)' }}>
      <EnergiemanagementWiedervorlage springe={(s) => sprung.push(s.hash)} />
    </main>
  </React.StrictMode>,
);
