import ReactDOM from 'react-dom/client';
import { VpLoaderScreen, LOADER_TEXT } from '../src/components/VpLoader';
// Dasselbe CSS-Set wie `src/main.tsx` (Tokens + Schriften), damit die React-Marke
// exakt so rendert wie im Portal.
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

// Der React-Lader mit GENAU dem Text, den der Inline-Lader (index.html) trägt -
// so vergleicht `loader-parity.spec.ts` beide Fassungen deckungsgleich.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <VpLoaderScreen text={LOADER_TEXT.auth} />,
);
