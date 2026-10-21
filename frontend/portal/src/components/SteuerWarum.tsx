import type { ReactNode } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { Modal } from '../../designsystem/components/shell/Modal';
import type { ControlStripView } from '../control';
import type { ExportGuardView } from '../curtailment';
import { kw, zahl } from '../leitungsplan';
import type { ErzeugerBlatt } from '../erzeuger';
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
  erzeuger = null,
  onWeiter,
}: {
  offen: boolean;
  isPhone: boolean;
  onClose: () => void;
  view: ControlStripView | null;
  guard: ExportGuardView | null;
  spalten: SteuerSpalte[] | null;
  /** Erzeugeranlage (EZ-8): die ganze Soll-Kette statt Auftrag › Gerät › Wirkung. */
  erzeuger?: ErzeugerBlatt | null;
  onWeiter?: (sub: AnlagenSub) => void;
}) {
  return (
    <SteuerBlatt offen={offen} isPhone={isPhone} onClose={onClose}>
      {erzeuger ? (
        <ErzeugerDetails blatt={erzeuger} guard={guard} onWeiter={onWeiter} />
      ) : (
        <SteuerDetails view={view} guard={guard} spalten={spalten} onWeiter={onWeiter} />
      )}
    </SteuerBlatt>
  );
}

/**
 * „Steuerung jetzt“ einer Erzeugeranlage: die ganze Kette Netzbetreiber › Direktvermarkter › Anlage mit
 * Namen, Kanal und „seit“, darunter der Balken 0 … installierte Leistung, „Warum“ (was gilt und wer es
 * setzt, seit wann, Datenalter, heute) und „Grenze“. Alle Sätze kommen fertig aus `erzeuger.ts`.
 */
function ErzeugerDetails({
  blatt,
  guard,
  onWeiter,
}: {
  blatt: ErzeugerBlatt;
  guard: ExportGuardView | null;
  onWeiter?: (sub: AnlagenSub) => void;
}) {
  const b = blatt.balken;
  const pos = (x: number) => `${Math.min(100, Math.max(0, (100 * x) / (b?.maxKw || 1))).toFixed(1)}%`;
  // Die Beschriftungen bleiben im Kasten, auch wenn eine Marke nahe am Rand steht.
  const posText = (x: number) => `${Math.min(88, Math.max(14, (100 * x) / (b?.maxKw || 1))).toFixed(1)}%`;
  const grenze: [string, string][] = guard ? [['Einspeisung', guard.line], ...blatt.grenze] : blatt.grenze;
  return (
    <div className="vp-steuer-blatt vp-ez-blatt">
      <div className="vp-ez-kette">
        <ul className="vp-ez-zeilen">
          {blatt.zeilen.map((z) => (
            <li key={z.key} className={`tone-${z.ton}`}>
              <i className={`vp-ez-punkt is-${z.farbe}`} aria-hidden="true" />
              <span className="vp-ez-name">
                <b>{z.titel}</b>
                <small>{z.unter}</small>
              </span>
              <b className="vp-ez-wert">{z.wert}</b>
            </li>
          ))}
        </ul>
        {b && (
          <div className="vp-ez-balken" role="img" aria-label={`Erzeugung ${kw(b.istKw)} von ${kw(b.maxKw)}${b.nbKw != null ? `, Grenze des Netzbetreibers ${kw(b.nbKw)}` : ''}${b.dvKw != null ? `, Sollwert des Direktvermarkters ${kw(b.dvKw)}` : ''}`}>
            <span className="vp-ez-max" aria-hidden="true">{kw(b.maxKw)}</span>
            <span className="vp-ez-spur" aria-hidden="true">
              {b.istKw != null && <i className="vp-ez-ist" style={{ width: pos(b.istKw) }} />}
              {b.nbKw != null && <i className="vp-ez-marke is-netz" style={{ left: pos(b.nbKw) }} />}
              {b.dvKw != null && <i className="vp-ez-marke is-markt" style={{ left: pos(b.dvKw) }} />}
            </span>
            <span className="vp-ez-achse" aria-hidden="true">
              <span>0</span>
              {b.nbKw != null && <span className="is-netz" style={{ left: posText(b.nbKw) }}>NB {zahl(b.nbKw)}</span>}
              {b.dvKw != null && <span className="is-markt" style={{ left: posText(b.dvKw) }}>DV {zahl(b.dvKw)}</span>}
            </span>
          </div>
        )}
      </div>
      <p className="vp-steuer-abschnitt">Warum</p>
      <dl className="vp-steuer-gruende">
        {blatt.warum.map(([wer, satz]) => (
          <div key={wer}>
            <dt>{wer}</dt>
            <dd>{satz}</dd>
          </div>
        ))}
      </dl>
      {grenze.length > 0 && (
        <>
          <p className="vp-steuer-abschnitt">Grenze</p>
          <dl className="vp-steuer-gruende">
            {grenze.map(([wer, satz]) => (
              <div key={wer}>
                <dt>{wer}</dt>
                <dd>{satz}</dd>
              </div>
            ))}
          </dl>
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
