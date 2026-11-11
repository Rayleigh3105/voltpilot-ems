import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { LIST_POLL_MS } from '../pollCadence';
import { useFreshnessPoll } from '../useFreshnessPoll';
import { meldungenApi } from '../meldungenApi';

/**
 * Die Glocke im Kopf, auf jeder Ebene (Alerting Scheibe 1, Entscheid 4A): rechts vor Hilfe und
 * Konto, mit der Zahl der Meldungen, die die Person noch nicht gesehen hat. Ein Tipp öffnet
 * `#/meldungen`; die Seitenleiste bekommt keinen neuen Eintrag (§6.2, §6.8).
 */
export function GlockeButton() {
  const [stand, setStand] = useState<{ ungesehen: number; dringend: boolean } | null>(null);

  const holen = useCallback(() => {
    meldungenApi.zahl().then(setStand, () => {
      /* ein verlorener Takt zeigt nur weiter den letzten bekannten Stand - nie einen Fehler */
    });
  }, []);

  useEffect(holen, [holen]);
  useFreshnessPoll(holen, LIST_POLL_MS);

  const zahl = stand?.ungesehen ?? null;
  const dringend = stand?.dringend ?? false;
  const label = zahl ? `Meldungen, ${zahl} ungesehen` : 'Meldungen';

  return (
    <button
      type="button"
      className={`vp-glocke${dringend ? ' dringend' : ''}`}
      aria-label={label}
      onClick={() => {
        window.location.hash = '#/meldungen';
      }}
    >
      <Icon name="bell" size={18} />
      {zahl != null && zahl > 0 && <span className="vp-glocke-zahl">{zahl > 99 ? '99+' : zahl}</span>}
    </button>
  );
}
