/**
 * Die „Lage"-Zeile der Fahrplan-Seite (Erklärbarkeit Stufe 2, Konzept
 * `data/vp-warum-erklaerbar-e2` §6) - render-only.
 *
 * Sie steht ZWISCHEN dem JETZT-Helden und dem Film des Tages und beantwortet
 * die zwei Fragen, die sonst erst beim Kunden entstehen: wie der Tag verläuft
 * und was für morgen erwartet wird. **Nur hier** - das Cockpit behält seine
 * knappe `filmKurzfassung` (F4, Mobil-Disziplin: keine Doppelung).
 *
 * Jede Regel und jeder Satz kommt aus dem reinen `src/fahrplanLage.ts`; hier
 * wird nichts abgeleitet und nichts formuliert. Ohne belegte Aussage liefert
 * `lageView` null und der Aufrufer rendert GAR NICHTS - eine Karte, die nur
 * den konstanten Bedingungs-Satz trüge, wäre Rauschen.
 */

import { Card } from '../../designsystem/components/core/Card';
import { ProvBadge } from './HistorieWelt';
import type { LageView } from '../fahrplanLage';

import './Fahrplan.css';

/**
 * `kompakt` = die Block-3-Zeile im Standard-Scroll: nur der Tages-Bogen und der
 * Morgen-Ausblick, ohne den konstanten Bedingungs-Satz und die Quelle - die zwei
 * gehören in den „Mehr erklären"-Aufklapper (`voll`). `voll` (Vorgabe) ist die
 * bisherige, vollständige Karte.
 */
export function FahrplanLage({
  view,
  variant = 'voll',
}: {
  view: LageView;
  variant?: 'kompakt' | 'voll';
}) {
  if (variant === 'kompakt') {
    return (
      <Card padding="md" radius="lg" style={{ marginBottom: 'var(--vp-space-4)' }}>
        <div className="vp-jetzt-kick">
          <span className="vp-card-label">Heute und morgen</span>
          <ProvBadge art="geplant" />
        </div>
        <div className="vp-lage">
          {view.bogen && <p className="vp-lage-satz">{view.bogen}</p>}
          {view.ausblick && <p className="vp-lage-satz">{view.ausblick}</p>}
        </div>
      </Card>
    );
  }
  return (
    <Card padding="lg" radius="lg" style={{ marginBottom: 'var(--vp-space-4)' }}>
      <div className="vp-jetzt-kick">
        <span className="vp-card-label">Heute und morgen</span>
        <ProvBadge art="geplant" />
      </div>
      <div className="vp-lage">
        {view.bogen && <p className="vp-lage-satz">{view.bogen}</p>}
        {view.ausblick && <p className="vp-lage-satz">{view.ausblick}</p>}
        <p className="vp-lage-bedingung">{view.bedingung}</p>
        <p className="vp-lage-quelle">{view.quelle}</p>
      </div>
    </Card>
  );
}
