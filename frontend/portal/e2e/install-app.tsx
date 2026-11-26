import ReactDOM from 'react-dom/client';
import { Modal } from '../designsystem/components/shell/Modal';
import { InstallAppPanel } from '../src/components/InstallAppPanel';
import { initInstallApp, STANDALONE_QUERY } from '../src/installApp';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

/**
 * Bühne der ECHTEN „Als App auf diesem Gerät"-Fläche (Modal + InstallAppPanel), für die
 * Geräte-Proben (iPhone/WebKit, Android/Chromium) der Fernmeldung `vp-app-installieren`.
 *
 * Parameter:
 *  - `standalone=1`  - tut so, als liefe die Seite schon installiert (patcht `matchMedia`
 *                      für `(display-mode: standalone)`, bevor `initInstallApp` zuhört).
 *  - `angebot=1`     - feuert ein `beforeinstallprompt`, wie Chrome es wirklich schickt
 *                      (derselbe Stellvertreter wie in `installApp.test.ts`), damit der
 *                      echte Knopf in einem echten Browser geprüft werden kann, ohne auf
 *                      Chromes eigene Heuristik angewiesen zu sein.
 *
 * Auf `navigator.userAgent` wird NICHT eingegriffen - das liefert jedes Playwright-Projekt
 * (`mobile-webkit` = echtes iPhone, `mobile-chromium` = echtes Android-Chrome) bereits echt;
 * genau das ist der Punkt der Probe. Ein abweichender Browser (z.B. Firefox/Android für den
 * echten „nicht-verfuegbar"-Fall) wird über `page.addInitScript` in der Spec selbst gestellt.
 */
const params = new URLSearchParams(location.search);

if (params.get('standalone') === '1') {
  const echtesMatchMedia = window.matchMedia.bind(window);
  window.matchMedia = (query: string) =>
    query === STANDALONE_QUERY
      ? ({ matches: true, addEventListener() {}, removeEventListener() {} } as MediaQueryList)
      : echtesMatchMedia(query);
}

initInstallApp(window);

if (params.get('angebot') === '1') {
  const angebot = Object.assign(new Event('beforeinstallprompt'), {
    prompt: () => {
      (window as unknown as { __angebotGerufen: boolean }).__angebotGerufen = true;
      return Promise.resolve();
    },
    userChoice: Promise.resolve({ outcome: 'accepted' as const }),
  });
  window.dispatchEvent(angebot);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <Modal open title="Als App auf diesem Gerät" blatt onClose={() => {}}>
    <InstallAppPanel />
  </Modal>,
);
