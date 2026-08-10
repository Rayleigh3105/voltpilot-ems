import React from 'react';
import ReactDOM from 'react-dom/client';

// Same CSS, same order as src/main.tsx - the charts read their palette from
// these tokens at paint time (chartTheme()), so dropping one silently changes
// every colour in the screenshot.
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

import { TelemetryChart } from '../src/TelemetryChart';
import { HistoryEnergieChart } from '../src/HistoryChart';
import { ScheduleChart } from '../src/ScheduleChart';
import { history, schedulePlan, telemetryPoints } from './fixtures';

type Only = 'telemetry' | 'history' | 'schedule';

const ONLY: Only | null = (() => {
  const raw = new URLSearchParams(window.location.search).get('only');
  return raw === 'telemetry' || raw === 'history' || raw === 'schedule' ? raw : null;
})();

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        maxWidth: 960,
        margin: '24px auto',
        padding: 16,
        background: '#fff',
        borderRadius: 12,
      }}
    >
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      {children}
    </div>
  );
}

function App() {
  const show = (id: Only) => ONLY === null || ONLY === id;
  return (
    <>
      {show('telemetry') && (
        <Frame title="TelemetryChart">
          <TelemetryChart points={telemetryPoints} windowLabel="in den letzten 3 Stunden" />
        </Frame>
      )}
      {show('history') && (
        <Frame title="HistoryEnergieChart">
          <HistoryEnergieChart history={history} />
        </Frame>
      )}
      {show('schedule') && (
        <Frame title="ScheduleChart">
          <ScheduleChart plan={schedulePlan} plantKind="eigenverbrauch" />
        </Frame>
      )}
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
