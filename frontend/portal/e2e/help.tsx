import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '../src/App';
import { HelpProvider } from '../src/help/HelpProvider';
import { AddDeviceDrawer } from '../src/components/DeviceDrawers';
import { installHelpFixtures, sites } from './help-fixtures';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

installHelpFixtures();
const scene = location.hash.startsWith('#/hilfe') ? null : new URLSearchParams(location.search).get('scene');
function Fixture() {
  if (scene === 'claim') return <HelpProvider><AddDeviceDrawer open sites={sites as never} onClose={() => {}} onClaimed={() => {}} /></HelpProvider>;
  return <App initialAuth />;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />);
