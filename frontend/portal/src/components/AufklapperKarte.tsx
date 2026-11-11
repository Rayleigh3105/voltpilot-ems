import type { ReactNode } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import { Aufklapper } from './Aufklapper';
import { useIsPhone } from '../useIsPhone';

/**
 * Eine SEKUNDÄRE Sektion mehrerer Admin-Flächen (`vp-adminview-mobile-rework`):
 * am Telefon ein {@link Aufklapper} - zu, mit der Urteilszeile als Beleg
 * ("einklappbare Sektionen mit sprechenden Urteilszeilen" statt endloser
 * Kartenstapel); am Rechner bleibt sie die unveränderte offene Karte mit
 * Überschrift (Desktop darf nicht schlechter werden).
 *
 * Bewusst nur für die SEKUNDÄREN Sektionen einer Fläche - was der Techniker
 * als Erstes braucht, bleibt eine plaine `Card`, nie durch diese ersetzt.
 *
 * `aktionen` (eine Kopf-Handlung wie „Anlage anlegen") steht zugeklappt nicht
 * zur Verfügung - sie gehört an dieselbe Fläche wie ihre Liste, nicht in die
 * Zeile, die nur zusammenfasst.
 */
export function AufklapperKarte({ icon, titel, urteil, aktionen, className, children }: {
  icon: IconName;
  titel: string;
  /** Die Urteilszeile - sichtbar auch zugeklappt, Beleg statt Blindflug. */
  urteil?: ReactNode;
  aktionen?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const isPhone = useIsPhone();
  if (!isPhone) {
    return (
      <Card padding="lg" radius="lg" className={className}>
        <div className="vp-section-head">
          <h2><Icon name={icon} size={18} /> {titel}</h2>
          {aktionen && <span className="actions">{aktionen}</span>}
        </div>
        {children}
      </Card>
    );
  }
  return (
    <Card padding="md" radius="lg" className={className}>
      <Aufklapper titel={<><Icon name={icon} size={16} /> {titel}</>} sub={urteil}>
        {aktionen && <div className="vp-row-gap" style={{ marginBottom: 'var(--vp-space-3)' }}>{aktionen}</div>}
        {children}
      </Aufklapper>
    </Card>
  );
}
