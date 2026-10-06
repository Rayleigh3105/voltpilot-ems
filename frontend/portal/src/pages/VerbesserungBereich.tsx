import { AbweichungenRegister } from '../components/AbweichungenRegister';
import { GrenzHinweis, GrenzSatzBereich } from '../components/GrenzSatz';
import { BegriffeZeile } from '../components/BegriffeZeile';
import { useReiterRand } from '../reiterRand';
import { EnergiezieleRegister } from '../components/EnergiezieleRegister';
import { MassnahmenRegister } from '../components/MassnahmenRegister';
import '../components/BereichTabs.css';
import * as Z from '../energieziele';
import { UEMS_ZIELE_UND_MASSNAHMEN } from '../glossar';
import type { VerbesserungReiter } from '../nav';
import { AbweichungSeite } from './AbweichungSeite';
import { EnergiezielSeite } from './EnergiezielSeite';
import { MassnahmeSeite } from './MassnahmeSeite';
import './Verbesserung.css';

/**
 * Der Bereich „Ziele und Maßnahmen“ (UEMS AP-18 IP-8, §6.3; `#/portfolio/verbesserung`, nur mit
 * `verbesserung.ansehen`) mit drei Reitern Energieziele · Maßnahmen · Abweichungen. Ein Energieziel, eine Maßnahme
 * (IP-13) und eine Abweichung (IP-18) öffnen ihre Seite.
 */
export function VerbesserungBereich({
  reiter,
  energiezielId,
  onReiter,
  onOeffnen,
  onListe,
  onKennzahl,
  onMassnahme,
  massnahmeId = null,
  abweichungId = null,
  onAbweichung,
  reiterOben = false,
}: {
  reiter: VerbesserungReiter;
  energiezielId: string | null;
  massnahmeId?: string | null;
  onReiter: (r: VerbesserungReiter) => void;
  onOeffnen: (id: string) => void;
  onListe: () => void;
  onKennzahl?: (kennzahlId: string) => void;
  /** Öffnet die Seite einer Maßnahme (IP-13); ohne bleibt das Register ohne Sprung. */
  onMassnahme?: (id: string) => void;
  abweichungId?: string | null;
  /** Öffnet die Seite einer Abweichung (IP-18); ohne bleibt das Register ohne Sprung. */
  onAbweichung?: (id: string) => void;
  /**
   * N1 (Konzept „Navigation aus einem Guss“): stehen die Reiter in der Reihe der Gruppe „Verbessern“ über der Seite,
   * zeigt der Bereich keine eigene Reihe — es gibt höchstens eine.
   */
  reiterOben?: boolean;
}) {
  const reiterRand = useReiterRand<HTMLDivElement>();
  if (energiezielId) return <EnergiezielSeite id={energiezielId} onListe={onListe} onKennzahl={onKennzahl} onMassnahme={onMassnahme} />;
  if (abweichungId) {
    return <AbweichungSeite id={abweichungId} onListe={() => onReiter('abweichungen')} onKennzahl={onKennzahl} onMassnahme={onMassnahme} />;
  }
  if (massnahmeId) {
    return <MassnahmeSeite id={massnahmeId} onListe={() => onReiter('massnahmen')} onKennzahl={onKennzahl} onEnergieziel={onOeffnen} />;
  }
  const reiterReihe = !reiterOben && (
    <div ref={reiterRand} className="vp-bereich-tabs" role="tablist" aria-label={UEMS_ZIELE_UND_MASSNAHMEN}>
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
  );
  // Verbessern-Konzept v1 §6.5 (Entscheid 2): der Reiter „Maßnahmen“ trägt seinen eigenen Titel mit Klartext-Satz,
  // Antwort und „Was VoltPilot leistet“ - die gemeinsame Überschrift des Bereichs entfällt dort.
  if (reiter === 'massnahmen') {
    return (
      <GrenzSatzBereich>
        <div className="vp-ez" data-testid="verbesserung-bereich">
          {reiterReihe}
          <MassnahmenRegister onOeffnen={(id) => onMassnahme?.(id)} />
        </div>
      </GrenzSatzBereich>
    );
  }
  return (
    <GrenzSatzBereich>
      <div className="vp-ez" data-testid="verbesserung-bereich">
        <h1>{UEMS_ZIELE_UND_MASSNAHMEN}</h1>
        <BegriffeZeile begriffe={['energieziel', 'massnahme', 'abweichung']} />
        <GrenzHinweis />
        {reiterReihe}
        {reiter === 'energieziele' ? (
          <EnergiezieleRegister onOeffnen={onOeffnen} />
        ) : (
          <>
            <AbweichungenRegister onOeffnen={(id) => onAbweichung?.(id)} grenze={false} />
          </>
        )}
      </div>
    </GrenzSatzBereich>
  );
}
