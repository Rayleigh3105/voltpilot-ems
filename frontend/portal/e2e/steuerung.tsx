import ReactDOM from 'react-dom/client';
import App from '../src/App';
import { installSteuerungFixtures } from './steuerung-fixtures';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

installSteuerungFixtures();
ReactDOM.createRoot(document.getElementById('root')!).render(<App initialAuth />);
