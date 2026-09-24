import { EnergiezieleRegister } from '../components/EnergiezieleRegister';
import '../components/BereichTabs.css';
import * as Z from '../energieziele';
import { UEMS_ABWEICHUNGEN, UEMS_MASSNAHMEN, UEMS_NORMGRENZE, UEMS_ZIELE_UND_MASSNAHMEN } from '../glossar';
import type { VerbesserungReiter } from '../nav';
import { EnergiezielSeite } from './EnergiezielSeite';
import './Verbesserung.css';

/**
 * Der Bereich „Ziele und Maßnahmen“ (UEMS AP-18 IP-8, §6.3; `#/portfolio/verbesserung`, nur mit
 * `verbesserung.ansehen`) mit drei Reitern Energieziele · Maßnahmen · Abweichungen. Maßnahmen und Abweichungen haben
 * ihre Flächen erst mit IP-13/IP-18 — bis dahin ein ehrlicher Leer-Satz ohne Knopf. Ein Energieziel öffnet seine Seite.
 */
export function VerbesserungBereich({
  reiter,
  energiezielId,
  onReiter,
  onOeffnen,
  onListe,
  onKennzahl,
}: {
  reiter: VerbesserungReiter;
  energiezielId: string | null;
  onReiter: (r: VerbesserungReiter) => void;
  onOeffnen: (id: string) => void;
  onListe: () => void;
  onKennzahl?: (kennzahlId: string) => void;
}) {
  if (energiezielId) return <EnergiezielSeite id={energiezielId} onListe={onListe} onKennzahl={onKennzahl} />;
  return (
    <div className="vp-ez" data-testid="verbesserung-bereich">
      <h1>{UEMS_ZIELE_UND_MASSNAHMEN}</h1>
      <div className="vp-bereich-tabs" role="tablist" aria-label={UEMS_ZIELE_UND_MASSNAHMEN}>
        {Z.REITER.map((r) => (
          <button
            key={r.key}
            type="button"
            role="tab"
            aria-selected={reiter === r.key}
            className={`vp-bereich-tab${reiter === r.key ? ' active' : ''}`}
            data-testid={`verbesserung-reiter-${r.key}`}
            onClick={() => onReiter(r.key)}
          >
            {r.label}
          </button>
        ))}
      </div>
      {reiter === 'energieziele' ? (
        <EnergiezieleRegister onOeffnen={onOeffnen} />
      ) : (
        <section className="vp-ez" data-testid={`verbesserung-leer-${reiter}`}>
          <p className="vp-ez-satz">{Z.LEER_SPAETER(reiter === 'massnahmen' ? UEMS_MASSNAHMEN : UEMS_ABWEICHUNGEN)}</p>
          <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
        </section>
      )}
    </div>
  );
}
