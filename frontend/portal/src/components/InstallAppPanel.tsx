import { useMemo, useState, useSyncExternalStore } from 'react';

import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { useIsPhone } from '../useIsPhone';
import { KOPIEREN } from '../koppelTexte';
import { qrCode, qrPfad } from '../qrCode';
import {
  ANDERES_GERAET_HINWEIS,
  ANDERES_GERAET_TITEL,
  installIosContext,
  installSnapshot,
  installView,
  lastInstallOutcome,
  promptInstall,
  subscribeInstallApp,
} from '../installApp';
import './InstallApp.css';

const QR_RUHE = 4;

/** Der QR-Code zum Link auf dem ANDEREN Gerät - dieselbe Vorlage wie das Gehäuse-Etikett der Werkstatt. */
function WeiteresGeraetQr({ link }: { link: string }) {
  const q = useMemo(() => qrCode(link), [link]);
  const seite = q.groesse + 2 * QR_RUHE;
  return (
    <svg
      className="vp-installapp-qr"
      viewBox={`0 0 ${seite} ${seite}`}
      role="img"
      aria-label={`QR-Code: ${link}`}
    >
      <rect width={seite} height={seite} fill="#fff" />
      <path d={qrPfad(q, QR_RUHE)} fill="#000" />
    </svg>
  );
}

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
  // Der Link auf DIESES Gerät - derselbe Ursprung, der auf dem anderen Gerät im Browser landet.
  const weiterLink = useMemo(() => window.location.origin, []);
  const [kopiert, setKopiert] = useState(false);

  return (
    <div className={`vp-installapp is-${view.state}`}>
      <p className="vp-installapp-text">{view.text}</p>
      {view.steps.length > 0 && (
        <ol className="vp-installapp-steps">
          {view.steps.map((s, i) => (
            <li key={i}>
              {s.parts.map((p, j) =>
                'icon' in p ? (
                  <Icon key={j} name={p.icon} size={18} className="vp-installapp-step-icon" />
                ) : (
                  <span key={j}>{p.text}</span>
                ),
              )}
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
      {view.state === 'installiert' && (
        <div className="vp-installapp-weiter">
          <p className="vp-installapp-weiter-titel">{ANDERES_GERAET_TITEL}</p>
          <div className="vp-installapp-weiter-row">
            <WeiteresGeraetQr link={weiterLink} />
            <div className="vp-installapp-weiter-link">
              <code translate="no">{weiterLink}</code>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard?.writeText(weiterLink).then(
                    () => setKopiert(true),
                    () => setKopiert(false),
                  );
                }}
              >
                {kopiert ? KOPIEREN.kopiert : KOPIEREN.knopf}
              </Button>
            </div>
          </div>
          <p className="vp-installapp-weiter-hinweis">{ANDERES_GERAET_HINWEIS}</p>
        </div>
      )}
    </div>
  );
}
