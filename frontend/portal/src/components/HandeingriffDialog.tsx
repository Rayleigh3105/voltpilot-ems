/**
 * Die FOLGEN-KARTE eines Handeingriffs am Speicher oder an der ganzen Anlage
 * (Steuerung Stufe 4, Konzept `vp-steuerung-konzept-b3` §3.5 + §3.2) — das
 * Haus-Muster `Drawer` + Folgenliste, wie beim Verbraucher-Eingriff, aber mit
 * den VIER festen Blöcken des Konzepts und der Dauer-Wahl der Stufe 4.
 *
 * Reine Anzeige: jeder Satz und jede Zahl kommt aus `handeingriff.ts`. Die
 * Zahl im Block „Auswirkung auf den Fahrplan" ist entweder echt oder wörtlich
 * „nicht abschätzbar" MIT ihrem Grund — hier wird nichts gerechnet.
 */
import { Button } from '../../designsystem/components/core/Button';
import { Modal } from '../../designsystem/components/shell/Modal';
import { VpPicker } from './VpPicker';
import { DAUERN, type DauerOption, type HandeingriffFolgen } from '../handeingriff';

export function HandeingriffDialog({
  folgen,
  busy,
  withDuration,
  dauern = DAUERN,
  dauerKey,
  onDauer,
  onConfirm,
  onCancel,
}: {
  folgen: HandeingriffFolgen | null;
  busy?: boolean;
  /** Eine Rücknahme braucht keine Dauer - sie wirkt sofort. */
  withDuration?: boolean;
  /**
   * Die anzubietenden Dauern. Vorgabe sind die des Speicher-/Anlagen-Eingriffs;
   * der Ladepunkt-Boost (P3a) reicht seine eigenen herein („bis Abstecken"
   * statt „bis morgen früh") - EIN Dialog, zwei Dauer-Listen, statt zweier
   * Dialoge, die auseinanderlaufen können.
   */
  dauern?: DauerOption[];
  /**
   * ⚠ Die Dauer ist KONTROLLIERT, nicht dialog-intern: die Folgen-Karte
   * beschreibt, was der Knopf tun WIRD - Endzeit und Fahrplan-Verzicht hängen
   * beide an ihr. Mit dialog-interner Auswahl stünde dort dauerhaft die
   * Vorauswahl, während der Kunde etwas anderes gewählt hat.
   */
  dauerKey: string;
  onDauer: (key: string) => void;
  /** Die gewählten Minuten; `null` = „bis morgen früh" (ein absolutes Ende). */
  onConfirm: (minutes: number | null) => void;
  onCancel: () => void;
}): JSX.Element | null {
  if (!folgen) return null;
  const gewaehlt = dauern.find((d) => d.key === dauerKey) ?? dauern[2] ?? dauern[0];

  return (
    <Modal open onClose={onCancel} title={folgen.titel}>
      <div className="vp-vb-override-dialog">
        {folgen.bloecke.map((b) => (
          <div key={b.key} className="vp-handeingriff-block">
            <h4>{b.titel}</h4>
            <ul className="vp-vb-consequences">
              {b.zeilen.map((z, i) => (<li key={i}>{z}</li>))}
            </ul>
          </div>
        ))}
        {withDuration && (
          <VpPicker
            className="vp-vb-duration"
            label="Wie lange?"
            ariaLabel="Dauer des Eingriffs"
            options={dauern.map((d) => ({ value: d.key, label: d.label }))}
            value={dauerKey}
            onChange={onDauer}
          />
        )}
        <div className="vp-vb-dialog-actions">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Abbrechen</Button>
          <Button
            onClick={() => onConfirm(withDuration ? gewaehlt.minutes : 0)}
            disabled={busy}
          >
            {busy ? 'Wird gesendet…' : folgen.bestaetigen}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
