import './rollen-fixture';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '../src/App';
import { HelpProvider } from '../src/help/HelpProvider';
import { GuidedRuleBuilder } from '../src/components/GuidedRuleBuilder';
import { Modal } from '../designsystem/components/shell/Modal';
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
  if (scene === 'rule') return <HelpProvider><Modal open title="Regel erstellen" onClose={() => {}}>
    <GuidedRuleBuilder siteId="help-site" initialName="Heizstab am Mittag" entities={[{ id: 'heizung', entityType: 'consumer', label: 'Heizstab',
      measure: ['power_kw'], actuate: ['on_off'] }]}
      onBuild={() => {}} onCancel={() => {}} />
  </Modal></HelpProvider>;
  if (scene === 'claim') return <HelpProvider><AddDeviceDrawer open sites={sites as never} onClose={() => {}} onClaimed={() => {}} /></HelpProvider>;
  return <App initialAuth />;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />);
