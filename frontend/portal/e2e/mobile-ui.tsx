import './rollen-fixture';
import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { AddDeviceDrawer } from '../src/components/DeviceDrawers';
import type { Site } from '../src/api';
import App from '../src/App';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

const sites = [
  { id: 'site-a', name: 'Solarpark mit einem langen Standortnamen', biddingZone: 'DE-LU' },
  { id: 'site-b', name: 'Zweite Anlage', biddingZone: 'DE-LU' },
] as Site[];

function Fixture() {
  const [open, setOpen] = useState(false);
  if (new URLSearchParams(location.search).has('register')) return <App initialAuth={false} initialView="register" />;
  return <main>
    <button onClick={() => setOpen(true)}>Gerät hinzufügen</button>
    <a href="#background">Link im Hintergrund</a>
    <AddDeviceDrawer open={open} onClose={() => setOpen(false)} sites={sites} onClaimed={() => {}} />
  </main>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />);
