import type { ReactNode } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { Modal } from '../../designsystem/components/shell/Modal';
import type { ControlStripView } from '../control';
import type { ExportGuardView } from '../curtailment';
import type { SteuerSpalte } from '../kacheln';
import type { AnlagenSub } from '../nav';
import { BottomSheet } from './BottomSheet';
import { tonAus } from './steuerTon';

/**
 * Das Blatt „Warum?“ der Steuerzeile (Konzept b1, 20.10.2026; `ControlStrip variant="zeile"` lädt es
 * beim ersten Tipp nach). Am Telefon `BottomSheet`, am Rechner das zentrierte `Modal`.
 */
export function SteuerWarum({
  offen,
  isPhone,
  onClose,
  view,
  guard,
  spalten,
  onWeiter,
}: {
  offen: boolean;
  isPhone: boolean;
  onClose: () => void;
  view: ControlStripView | null;
  guard: ExportGuardView | null;
  spalten: SteuerSpalte[] | null;
  onWeiter?: (sub: AnlagenSub) => void;
}) {
  return (
    <SteuerBlatt offen={offen} isPhone={isPhone} onClose={onClose}>
      <SteuerDetails view={view} guard={guard} spalten={spalten} onWeiter={onWeiter} />
    </SteuerBlatt>
  );
}

function SteuerBlatt({ offen, isPhone, onClose, children }: { offen: boolean; isPhone: boolean; onClose: () => void; children: ReactNode }) {
  return isPhone ? (
    <BottomSheet open={offen} title="Steuerung jetzt" onClose={onClose}>
      {children}
    </BottomSheet>
  ) : (
    <Modal open={offen} onClose={onClose} title="Steuerung jetzt">
      {children}
    </Modal>
  );
}

/**
 * Der Inhalt von „Warum?“: dieselben Sätze wie vorher (`control.ts`, `fahrplanWhy.ts`,
 * `curtailment.ts`), nur je Herkunft gegliedert statt als Fließtext - keiner wird neu formuliert.
 */
function SteuerDetails({
  view,
  guard,
  spalten,
  onWeiter,
}: {
  view: ControlStripView | null;
  guard: ExportGuardView | null;
  spalten: SteuerSpalte[] | null;
  onWeiter?: (sub: AnlagenSub) => void;
}) {
  const gruende: [string, string][] = view
    ? ([
        ['Plan', view.reason],
        ['Gerät', view.execution],
        ['Einspeisung', view.curtailment],
        ['Als Nächstes', view.outlook],
      ].filter((g): g is [string, string] => Boolean(g[1])))
    : [];
  return (
    <div className="vp-steuer-blatt">
      {view && (
        <ul className="vp-steuer-schritte">
          {spalten && spalten.length > 0 ? (
            spalten.map((sp) => (
              <li key={sp.titel} className={`tone-${tonAus(sp.ton)}`}>
                <i aria-hidden="true" />
                <span>{sp.titel}</span>
                <b>{sp.text}</b>
              </li>
            ))
          ) : (
            <li className={`tone-${tonAus(view.tone)}`}>
              <i aria-hidden="true" />
              <span>Jetzt</span>
              <b>
                {view.sentence}
                {view.agoNote && <small>{view.agoNote}</small>}
              </b>
            </li>
          )}
        </ul>
      )}
      {gruende.length > 0 && (
        <>
          <p className="vp-steuer-abschnitt">Warum</p>
          <dl className="vp-steuer-gruende">
            {gruende.map(([wer, satz]) => (
              <div key={wer}>
                <dt>{wer}</dt>
                <dd>{satz}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {guard && (
        <>
          <p className="vp-steuer-abschnitt">Grenze</p>
          <p className={`vp-steuer-grenze tone-${guard.tone}`}>
            {guard.line}
            {guard.agoNote && <small> {guard.agoNote}</small>}
          </p>
          {guard.deviceLimitLine && (
            <div className="vp-steuer-befund" role="note">
              <span>{guard.deviceLimitLine}</span>
              {onWeiter && (
                <button type="button" className="vp-steuer-pruefen" onClick={() => onWeiter('technik')}>
                  Prüfen
                  <Icon name="chevron-right" size={14} />
                </button>
              )}
            </div>
          )}
        </>
      )}
      {onWeiter && (
        <p className="vp-steuer-weiter">
          <button type="button" className="vp-btn vp-btn--sm vp-btn-ghost" onClick={() => onWeiter('steuerung')}>
            Zur Steuerung <Icon name="chevron-right" size={14} />
          </button>
        </p>
      )}
    </div>
  );
}
