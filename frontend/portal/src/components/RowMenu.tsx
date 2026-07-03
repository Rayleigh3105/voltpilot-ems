import { useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import type { IconName } from '../../designsystem/components/core/Icon';

export type RowMenuItem = {
  label: string;
  icon?: IconName;
  onClick: () => void;
  /** Renders the item in the destructive style and after a separator. */
  danger?: boolean;
};

/**
 * A table-row overflow menu (⋯). Collapses dense per-row actions into a
 * popover so routine and destructive actions no longer wrap side by side in a
 * narrow cell; destructive items are visually separated. Closes on outside
 * click or Escape.
 */
export function RowMenu({ items, label = 'Aktionen' }: { items: RowMenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);

  const routine = items.filter((i) => !i.danger);
  const danger = items.filter((i) => i.danger);

  return (
    <span className="vp-rowmenu">
      <button
        type="button"
        className="vp-rowmenu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <Icon name="more-horizontal" size={18} />
      </button>
      {open && (
        <>
          <div
            className="vp-rowmenu-scrim"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
          />
          <div
            className="vp-rowmenu-pop"
            role="menu"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
            }}
          >
            {routine.map((it) => (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  it.onClick();
                }}
              >
                {it.icon && <Icon name={it.icon} size={16} />}
                {it.label}
              </button>
            ))}
            {danger.length > 0 && routine.length > 0 && <div className="vp-rowmenu-sep" />}
            {danger.map((it) => (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                className="danger"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  it.onClick();
                }}
              >
                {it.icon && <Icon name={it.icon} size={16} />}
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}
