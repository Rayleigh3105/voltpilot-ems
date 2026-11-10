import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { HelpLink } from '../help/HelpProvider';
import { ERGEBNIS, FREMD } from '../koppelTexte';
import { KennungKachel } from './KoppelKachel';
import './KoppelBand.css';

/**
 * M11 (QE-5 A): Die Box gehört schon einem anderen Konto (Antwort 409). Nennt kein fremdes Konto und
 * keine Anlage, nur häufige Gründe, die Kennung zum Kopieren und den Weg zum Support.
 *
 * Das „ehrliche Ergebnis" nach einem erfolgreichen Verbinden lebt seit
 * vp-box-verbinden-konzept (E1 = B) in `boxweg/BoxWeg.tsx` (`BoxWeg`, fünf
 * Stationen statt der früheren Zweiteilung „online"/„wartet").
 */
export function BoxFremdKonto({ kennung, onAndere }: { kennung: string; onAndere: () => void }) {
  return (
    <section className="vp-koppel-seite" role="alert" aria-labelledby="box-fremd-titel">
      <h3 id="box-fremd-titel">{FREMD.titel}</h3>
      <p className="vp-koppel-klein">{FREMD.datenschutz}</p>
      <div>
        <p className="vp-koppel-klein" style={{ marginBottom: 'var(--vp-space-2)' }}>{FREMD.gruendeTitel}</p>
        <ul className="vp-koppel-liste">
          {FREMD.gruende.map((g) => (
            <li key={g}>
              <Icon name="info" size={14} />
              <span>{g}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h4>{FREMD.wegTitel}</h4>
        <p className="vp-koppel-klein">{FREMD.weg}</p>
      </div>
      <KennungKachel kennung={kennung} titel="Kennung" zeile={FREMD.kennungZeile} kopieren />
      <HelpLink article="kontakt">{ERGEBNIS.support}</HelpLink>
      <Button variant="ghost" onClick={onAndere}>
        {FREMD.andere}
      </Button>
    </section>
  );
}
