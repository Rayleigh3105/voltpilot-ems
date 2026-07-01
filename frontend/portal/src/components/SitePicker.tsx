import type { Site } from '../api';

/** Compact site selector used by the site-scoped data pages/widgets. */
export function SitePicker({
  sites,
  value,
  onChange,
  id = 'site-picker',
}: {
  sites: Site[];
  value: string | null;
  onChange: (siteId: string) => void;
  id?: string;
}) {
  if (sites.length <= 1) return null;
  return (
    <select
      id={id}
      aria-label="Standort wählen"
      className="vp-select"
      style={{ width: 'auto', padding: '0.45rem 0.75rem', fontSize: 'var(--vp-text-sm)' }}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
    >
      {sites.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}
