import { useSyncExternalStore } from 'react';

import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { useIsPhone } from '../useIsPhone';
import {
  installIosContext,
  installSnapshot,
  installView,
  lastInstallOutcome,
  promptInstall,
  subscribeInstallApp,
} from '../installApp';
import './InstallApp.css';

/**
 * Die Fläche der Gruppe „Als App auf dem Handy" - reines Rendern.
 *
 * JEDE Regel und jeder Satz liegt in `src/installApp.ts`; hier wird nur
 * gezeichnet, was `installView` sagt. Der Zustand kommt über
 * `useSyncExternalStore` aus demselben Speicher, in den `main.tsx` das Angebot
 * des Browsers einhängt - deshalb erscheint der Knopf auch dann, wenn
 * `beforeinstallprompt` erst NACH dem Öffnen dieser Seite feuert.
 *
 * Beide Momentaufnahmen sind primitiv (Zeichenkette bzw. `undefined`), also für
 * `useSyncExternalStore` stabil - eine neu erzeugte Struktur wäre eine
 * Endlosschleife.
 *
 * ⚠ Die volle Breite am Telefon läuft über `fullWidth`, NICHT über CSS: der
 * Haus-`Button` setzt seine Breite INLINE (`style={{width: fullWidth ? '100%'
 * : 'auto'}}`), und ein Inline-Stil schlägt jede Medienabfrage - dieselbe
 * Klippe wie `Card` mit seiner inline gesetzten Polsterung. Eine
 * `@media`-Regel dafür wäre toter Code, der aussieht, als wirkte er.
 */
export function InstallAppPanel() {
  const isPhone = useIsPhone();
  const state = useSyncExternalStore(subscribeInstallApp, installSnapshot);
  const outcome = useSyncExternalStore(subscribeInstallApp, lastInstallOutcome);
  // `navigator.userAgent` ändert sich nie innerhalb einer Sitzung - ein reiner Aufruf ohne
  // eigenen Speicher genügt, anders als `state`/`outcome` braucht es kein `useSyncExternalStore`.
  const ios = installIosContext() ?? undefined;
  const view = installView(state, outcome, ios);

  return (
    <div className={`vp-installapp is-${view.state}`}>
      <p className="vp-installapp-text">{view.text}</p>
      {view.steps.length > 0 && (
        <ol className="vp-installapp-steps">
          {view.steps.map((s) => (
            <li key={s.text}>
              {s.icons.map((icon, i) => (
                <Icon key={i} name={icon} size={16} className="vp-installapp-step-icon" />
              ))}
              {s.text}
            </li>
          ))}
        </ol>
      )}
      {view.action && (
        <Button
          type="button"
          size="md"
          className="vp-installapp-btn"
          fullWidth={isPhone}
          onClick={() => void promptInstall()}
        >
          {view.action}
        </Button>
      )}
      {view.hint && <p className="vp-installapp-hint">{view.hint}</p>}
    </div>
  );
}
