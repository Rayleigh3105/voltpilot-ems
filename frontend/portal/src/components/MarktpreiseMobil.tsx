import { Icon } from '../../designsystem/components/core/Icon';
import type { JetztPreis, PreisChip, FokusUmschalter } from '../marktpreise';
import { ctLabel } from '../marktpreise';
import './Marktpreise.css';

/**
 * Die drei Render-Teile der Mobil-Fassung der Marktpreise (Konzept
 * `data/vp-mobile-views-x1` §7). Sie rechnen NICHTS — jede Zahl und jedes Wort
 * kommt aus `src/marktpreise.ts`.
 */

/**
 * Der „Jetzt"-Held: aktueller Börsenpreis + Bezugspreis + EIN Wort. Das ist die
 * Frage, mit der fast jeder Besuch beginnt, und sie hatte auf dieser Seite
 * keinen Ort.
 */
export function MarktJetztHeld({ preis, bezug }: { preis: JetztPreis; bezug: string | null }) {
  return (
    <div className="vp-mp-jetzt">
      <div className="vp-mp-jetzt-left">
        <span className="vp-mp-kicker">
          Börsenpreis jetzt{preis.zeit ? ` · ${preis.zeit}` : ''}
        </span>
        <span className={`vp-mp-preis ton-${preis.ton}`}>{ctLabel(preis.ct)}</span>
        <span className="vp-mp-sub">
          {preis.bedeutung}
          {bezug ? ` · ${bezug}` : ''}
        </span>
      </div>
      <span className={`vp-mp-wort ton-${preis.ton}`}>{preis.wort}</span>
    </div>
  );
}

/**
 * Die Zeile unter der Kurve: links, welcher Tag zu sehen ist, rechts der Sprung
 * zum anderen. Ohne Folgetag rendert sie GAR NICHT — ein Chip, der nirgendwohin
 * springt, ist schlimmer als kein Chip.
 */
export function TagZeile({
  umschalter,
  onSpringen,
}: {
  umschalter: FokusUmschalter | null;
  onSpringen: (ziel: FokusUmschalter['ziel']) => void;
}) {
  if (!umschalter) return null;
  return (
    <div className="vp-mp-tagzeile">
      <span className="vp-mp-tagname">{umschalter.aktuell}</span>
      <button
        type="button"
        className="vp-mp-sprung"
        onClick={() => onSpringen(umschalter.ziel)}
      >
        {umschalter.label}
      </button>
    </div>
  );
}

/** Tief / Hoch / Ø als Chips UNTER der Kurve statt als drei Karten davor. */
export function PreisChips({ chips }: { chips: PreisChip[] }) {
  if (chips.length === 0) return null;
  return (
    <div className="vp-mp-chips">
      {chips.map((c) => (
        <span key={c.id} className={`vp-mp-chip ton-${c.ton}`}>
          {c.label}
        </span>
      ))}
    </div>
  );
}

/**
 * Der Profi-Aufklapper. Der EUR/MWh-Grundsatz der Seite bleibt (die Einheit ist
 * das Profi-Detail, ct/kWh die Rechnungs-Einheit des Kunden) — er zieht nur aus
 * dem täglichen Scrollweg heraus.
 */
export function ProfiDetail({ children }: { children: React.ReactNode }) {
  return (
    <details className="vp-mp-profi">
      <summary>
        <Icon name="chevron-down" size={16} />
        Profi-Detail (EUR/MWh · Quelle)
      </summary>
      <div className="vp-mp-profi-body">{children}</div>
    </details>
  );
}
