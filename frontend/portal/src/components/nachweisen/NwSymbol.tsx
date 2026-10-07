import type { CSSProperties } from 'react';
import { Icon, type IconName } from '../../../designsystem/components/core/Icon';

/**
 * Die Zeichen, die Nachweisen über das Haus-Icon hinaus braucht (Teilen, Speichern, Uhr, Ordner, Kopieren) - gleiche
 * Zeichensprache wie `Icon`: 24-px-Raster, Strich 2, `currentColor`, Pfade aus Lucide (ISC). Alles andere reicht an
 * `Icon` durch, damit eine Fläche nur einen Namen für ein Zeichen kennt.
 */
const EIGENE = {
  teilen: (
    <>
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <path d="M16 6l-4-4-4 4" />
      <path d="M12 2v13" />
    </>
  ),
  speichern: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </>
  ),
  uhr: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  ordner: <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />,
  kopieren: (
    <>
      <rect width="14" height="14" x="8" y="8" rx="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </>
  ),
} as const;

export type NwSymbolName = keyof typeof EIGENE | IconName;

export function NwSymbol({ name, size = 16, strokeWidth = 2, style }: { name: NwSymbolName; size?: number; strokeWidth?: number; style?: CSSProperties }) {
  if (!(name in EIGENE)) return <Icon name={name as IconName} size={size} strokeWidth={strokeWidth} style={style} aria-hidden="true" />;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flex: '0 0 auto', ...style }}
    >
      {EIGENE[name as keyof typeof EIGENE]}
    </svg>
  );
}
