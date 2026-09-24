/**
 * Prüfbühne für den Verlauf (Energie · Erlöse · Messwerte): die ganze App mit
 * den fiktiven Hilfe-Fixtures, aber mit Verlaufsdaten für JEDEN Zeitraum
 * (`verlauf-fixtures.ts`), damit Woche, Monat und Jahr im Browser prüfbar
 * sind. Aufruf: `/e2e/verlauf.html#/anlage/help-site/messwerte` usw.; die Uhr
 * steht wie bei den Hilfe-Aufnahmen auf dem 10.09.2026, 12:00 Uhr Berlin.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '../src/App';
import { api } from '../src/api';
import type { HistoryRange, SiteEarningsRange } from '../src/api';
import { installHelpFixtures } from './help-fixtures';
import { earningsFor, historyFor, TODAY } from './verlauf-fixtures';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

installHelpFixtures();
Object.assign(api, {
  history: async (_siteId: string, range: HistoryRange, at: string) => historyFor(range, at || TODAY),
  siteEarnings: async (siteId: string, range: SiteEarningsRange = 'month', at?: string | null) =>
    earningsFor(siteId, 'Sonnenhof', range, at || TODAY),
});
ReactDOM.createRoot(document.getElementById('root')!).render(<App initialAuth />);
