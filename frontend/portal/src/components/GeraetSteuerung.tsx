import type { ReactNode } from 'react';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import { werEntscheidet, type Segment, type SegmentAktion, type SteuerungView } from '../geraetSteuerung';
import './GeraetSteuerung.css';

/**
 * Der Baustein „Steuerung" (Konzept „Geräteseiten: Ein Blick, eine Antwort",
 * Baustein 3 · K1): wer gerade entscheidet, und EIN Schalter mit dem echten
 * Zustand.
 *
 * <p>Diese Datei RENDERT nur - Zustand, Grund, Quelle und die angebotenen
 * Handlungen kommen aus `geraetSteuerung.ts` (auf `steuerungJetzt.ts`). Ein
 * Segment LÖST nur aus: der Wirt öffnet seinen BESTEHENDEN Dialog.
 *
 * <p>⚠ Der Schalter ist eine `radiogroup`, deren gewähltes Element den
 * Zustand ZEIGT - ein Tipp auf ein anderes Segment ändert ihn nicht sofort,
 * sondern öffnet die Rückfrage mit ihren Folgen. Erst die bestätigte Handlung
 * (und die nächste Rückmeldung) verschiebt die Wahl.
 */
export function GeraetSteuerung({
  view,
  onAktion,
  busy = false,
  zusatz,
}: {
  view: SteuerungView;
  onAktion: (aktion: SegmentAktion) => void;
  busy?: boolean;
  /** Was darunter noch steht (Freigabe, Not-Aus-Hinweis, Hauptaktion). */
  zusatz?: ReactNode;
}) {
  const { zeile, segmente, keinEingriff } = view;
  const wer = werEntscheidet(zeile);
  const gewaehlt = Math.max(0, segmente.findIndex((s) => s.aktiv));
  return (
    <div className="vp-steuer" data-testid="geraet-steuerung">
      <p className="vp-steuer-zustand">
        <span className="z">{grossAnfang(zeile.zustand)}</span>
        {wer && <span className="q"> · {wer}</span>}
      </p>
      {zeile.grund && <p className="vp-steuer-grund">{zeile.grund}</p>}
      {segmente.length > 0 && (
        <div
          className="vp-steuer-seg"
          role="radiogroup"
          aria-label="Betriebsart"
          style={{ ['--n' as string]: segmente.length, ['--wahl' as string]: gewaehlt }}
        >
          <span className="daumen" aria-hidden="true" />
          {segmente.map((s) => (
            <SegmentKnopf key={s.key} segment={s} busy={busy} onAktion={onAktion} />
          ))}
        </div>
      )}
      {keinEingriff && <p className="vp-steuer-grund">{keinEingriff}</p>}
      {zusatz}
    </div>
  );
}

const SEGMENT_ICON: Record<string, IconName> = {
  automatik: 'refresh-cw',
  laden: 'battery-charging',
  halten: 'shield',
  ein: 'zap',
  aus: 'x',
  sofort: 'zap',
  pausieren: 'x',
};

function SegmentKnopf({
  segment,
  busy,
  onAktion,
}: {
  segment: Segment;
  busy: boolean;
  onAktion: (aktion: SegmentAktion) => void;
}) {
  const gesperrt = busy || (!segment.aktiv && segment.aktion == null);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={segment.aktiv}
      aria-disabled={gesperrt || undefined}
      data-segment={segment.key}
      className={segment.aktiv ? 'is-aktiv' : undefined}
      onClick={() => {
        if (segment.aktiv || gesperrt || !segment.aktion) return;
        onAktion(segment.aktion);
      }}
    >
      <Icon name={SEGMENT_ICON[segment.key] ?? 'zap'} size={15} />
      {segment.label}
    </button>
  );
}

/** Der Zustand steht am Satzanfang - „lädt 3,2 kW" wird „Lädt 3,2 kW". */
function grossAnfang(text: string): string {
  const t = text.trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}
