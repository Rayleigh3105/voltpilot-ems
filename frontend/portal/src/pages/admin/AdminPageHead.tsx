import type { ReactNode } from 'react';
import { Icon } from '../../../designsystem/components/core/Icon';
import type { IconName } from '../../../designsystem/components/core/Icon';
import { IconTile } from '../../../designsystem/components/core/IconTile';

/**
 * Shared header for the Plattform (Portal-Admin) pages. An IconTile + title +
 * description on the left, an optional actions slot on the right - so the four
 * admin pages (Mandanten / Benutzer / Geräte-Registry / Optimizer) read as one
 * operator console instead of four bare `h1`s. Built on the existing
 * `.vp-page-head` typography + the design-system IconTile (tokens only); the
 * gradient category codes the page (industry / home / primary / dynamic).
 */
export function AdminPageHead({
  icon,
  category = 'primary',
  title,
  description,
  actions,
}: {
  icon: IconName;
  category?: 'solar' | 'battery' | 'ev' | 'home' | 'industry' | 'dynamic' | 'primary';
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="vp-page-head vp-admin-head">
      <div className="vp-admin-head-main">
        <IconTile category={category} size={44}>
          <Icon name={icon} size={22} />
        </IconTile>
        <div className="titles">
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}
