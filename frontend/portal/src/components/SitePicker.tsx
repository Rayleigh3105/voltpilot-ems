import { VpPicker } from './VpPicker';
import type { Site } from '../api';

/**
 * Die kompakte Anlagen-Auswahl der anlagen-gebundenen Datenseiten.
 *
 * Sie rendert seit dem Picker-System (`vp-picker-system`) denselben
 * {@link VpPicker} wie die Kopfzeile - vorher war sie ein natives `<select>`,
 * das auf jedem Betriebssystem anders aussah und in dem man nicht suchen
 * konnte. Eine ANGEREICHERTE Zeile (Punkt + Nebenzeile) gibt es hier bewusst
 * nicht: diese Flächen kennen die Geräteliste nicht, und eine Gesundheit zu
 * behaupten, die niemand gemessen hat, ist genau das, was das Haus nicht tut.
 */
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
    <VpPicker
      id={id}
      ariaLabel="Anlage wählen"
      className="vp-sitepicker"
      options={sites.map((s) => ({ value: s.id, label: s.name }))}
      value={value}
      onChange={onChange}
      searchPlaceholder="Anlage suchen …"
    />
  );
}
