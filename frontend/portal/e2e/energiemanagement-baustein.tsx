import React from 'react';
import ReactDOM from 'react-dom/client';
import { EnergiemanagementBaustein } from '../src/components/EnergiemanagementBaustein';
import { GrenzHinweis, GrenzSatzBereich } from '../src/components/GrenzSatz';
import { wvDemo, wvLeer, wvNormal, wvR12 } from '../src/test/wiedervorlageFixtures';
import { wasStehtAn, type Wiedervorlage } from '../src/wiedervorlage';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../src/index.css';
import '../src/components/UebersichtBausteine.css';

/**
 * „Was steht an“ auf einer eigenen Bühne (Konzept Wiedervorlage w1): die ECHTE Komponente mit der Antwort von
 * `GET /api/v1/energiemanagement/wiedervorlage`, wie die Route sie liefert, in derselben Hülle wie auf der Übersicht
 * (`GrenzSatzBereich`, darunter einmal „Was VoltPilot leistet“). `?fall=r12|demo|normal|bald|leer`: R12 am
 * 12.02.2029 (acht überfällig, vier Bündel), die Demo am 30.04.2029 (zehn Anstöße an einem Bericht), der Normalfall
 * (nichts in den nächsten 30 Tagen), nur eine Frist in den nächsten Tagen, ohne jede Frist (kein Block).
 */
const fall = new URLSearchParams(location.search).get('fall') ?? 'r12';
const antworten: Record<string, Wiedervorlage> = {
  r12: wvR12(),
  demo: wvDemo(),
  normal: wvNormal(),
  bald: { ...wvR12(), faellig: [], anzahl_faellig: 0 },
  leer: wvLeer(),
};
const bild = wasStehtAn(antworten[fall] ?? wvR12());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <main style={{ maxWidth: 1200, margin: '0 auto', padding: 16 }}>
      <GrenzSatzBereich>
        <div className="vp-ub" data-testid="uebersicht-bausteine">
          {bild && <EnergiemanagementBaustein bild={bild} onOeffnen={() => {}} springe={() => {}} />}
          {bild && <GrenzHinweis />}
        </div>
      </GrenzSatzBereich>
    </main>
  </React.StrictMode>,
);
