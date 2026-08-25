/**
 * **Zone ③ · Betriebsmodelle** — die Render-Hälfte (Steuerung Stufe 5).
 *
 * Jede Regel, jeder Satz und jedes Urteil liegt im reinen `src/betriebsmodelle.ts`
 * (der `FleetOverview`/`ErloesKomposition`-Präzedenzfall); hier wird NUR
 * gerendert.
 *
 * Die Zone hat zwei Bedienformen, und der Unterschied ist eine Aussage:
 *  - eine **Radiogruppe** aus dem Grundmodus plus den Modellen DERSELBEN
 *    Exklusivitäts-Gruppe (es läuft immer genau eines davon, oder keines), und
 *  - je einen **eigenen Schalter** für ein Modell ohne Gruppe (heute das
 *    Ladepark-Lastmanagement — es ist Schutz, konkurriert mit niemandem und
 *    läuft neben jedem Betriebsmodell weiter).
 *
 * ⚠ Der Grundmodus IST der Weg zurück. Ein Radio kann sich nicht selbst
 * abwählen, also braucht die Gruppe eine Zeile „kein Betriebsmodell" — ohne sie
 * wäre das erste Einschalten eine Einbahnstraße.
 */
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  ALTBESTAND_TITEL,
  GRUNDMODUS_SATZ,
  GRUNDMODUS_TITEL,
  altbestandSatz,
  nichtMoeglichGrund,
  nichtMoeglichTitel,
  type AmpelZeile,
  type BetriebsmodellKarte,
  type BetriebsmodellZone,
} from '../betriebsmodelle';
import { PartHead } from './SteuerungParts';
import './Betriebsmodelle.css';

export interface BetriebsmodelleProps {
  zone: BetriebsmodellZone;
  title: string;
  intro: string;
  /** Der Leer-Satz, wenn diese Anlage KEIN Betriebsmodell fahren kann. */
  emptyText: string;
  /** Welche Id gerade schaltet (Knöpfe dieser Karte sind dann still). */
  busyId: string | null;
  /** Ein Radio wurde gewählt — `null` = zurück in den Grundmodus. */
  onWaehlen: (karte: BetriebsmodellKarte | null) => void;
  /** Ein gruppenloses Modell wurde umgelegt. */
  onSchalten: (karte: BetriebsmodellKarte, an: boolean) => void;
  /** Die Karte öffnen (Modus-Container). */
  onOpen: (id: string) => void;
  /** Einen Behebungs-Weg gehen. */
  onWeg: (zeile: AmpelZeile) => void;
}

export function Betriebsmodelle({
  zone,
  title,
  intro,
  emptyText,
  busyId,
  onWaehlen,
  onSchalten,
  onOpen,
  onWeg,
}: BetriebsmodelleProps) {
  const alt = altbestandSatz(zone.altbestand);
  const leer = zone.radio.length === 0 && zone.eigene.length === 0;
  return (
    <section className="vp-capsule" aria-label={title}>
      <PartHead title={title} intro={intro} />
      <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
        {alt && (
          <div className="vp-bm-alt" role="status">
            <Icon name="alert-triangle" size={16} />
            <span>
              <strong>{ALTBESTAND_TITEL}</strong>
              <span>{alt}</span>
            </span>
          </div>
        )}

        {leer ? (
          <p className="vp-capsule-empty">{emptyText}</p>
        ) : (
          <>
            {zone.radio.length > 0 && (
              <ul className="vp-bm-list" role="radiogroup" aria-label={title}>
                {/* Der Grundmodus ist eine vollwertige Wahl, kein Leer-Zustand. */}
                <li className={`vp-bm-card${zone.aktiv == null && zone.altbestand.length === 0 ? ' on' : ''}`}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={zone.aktiv == null && zone.altbestand.length === 0}
                    className="vp-bm-pick"
                    disabled={busyId != null}
                    onClick={() => onWaehlen(null)}
                  >
                    <span className="vp-bm-dot" aria-hidden="true" />
                    <span className="vp-bm-text">
                      <strong>{GRUNDMODUS_TITEL}</strong>
                      <span className="vp-bm-nutzen">{GRUNDMODUS_SATZ}</span>
                    </span>
                  </button>
                </li>
                {zone.radio.map((k) => (
                  <ModellKarte
                    key={k.id}
                    karte={k}
                    radio
                    busy={busyId === k.id}
                    disabled={busyId != null && busyId !== k.id}
                    onPick={() => onWaehlen(k)}
                    onOpen={() => onOpen(k.id)}
                    onWeg={onWeg}
                  />
                ))}
              </ul>
            )}

            {zone.eigene.length > 0 && (
              <ul className="vp-bm-list vp-bm-eigene">
                {zone.eigene.map((k) => (
                  <ModellKarte
                    key={k.id}
                    karte={k}
                    radio={false}
                    busy={busyId === k.id}
                    disabled={busyId != null && busyId !== k.id}
                    onPick={() => onSchalten(k, !k.aktiv)}
                    onOpen={() => onOpen(k.id)}
                    onWeg={onWeg}
                  />
                ))}
              </ul>
            )}
          </>
        )}

        {zone.nichtMoeglich.length > 0 && (
          <details className="vp-bm-unmoeglich">
            <summary>{nichtMoeglichTitel(zone.nichtMoeglich.length)}</summary>
            <ul>
              {zone.nichtMoeglich.map((k) => (
                <li key={k.id}>{nichtMoeglichGrund(k)}</li>
              ))}
            </ul>
          </details>
        )}
      </Card>
    </section>
  );
}

function ModellKarte({
  karte,
  radio,
  busy,
  disabled,
  onPick,
  onOpen,
  onWeg,
}: {
  karte: BetriebsmodellKarte;
  radio: boolean;
  busy: boolean;
  disabled: boolean;
  onPick: () => void;
  onOpen: () => void;
  onWeg: (zeile: AmpelZeile) => void;
}) {
  return (
    <li className={`vp-bm-card${karte.aktiv ? ' on' : ''}`}>
      <button
        type="button"
        {...(radio
          ? { role: 'radio' as const, 'aria-checked': karte.aktiv }
          : {
            role: 'switch' as const,
            'aria-checked': karte.aktiv,
            'aria-label': `${karte.label} ${karte.aktiv ? 'ausschalten' : 'einschalten'}`,
          })}
        className="vp-bm-pick"
        disabled={busy || disabled}
        onClick={onPick}
      >
        <span className="vp-bm-dot" aria-hidden="true" />
        <span className="vp-bm-text">
          <strong>{karte.label}</strong>
          <span className="vp-bm-nutzen">{karte.nutzen}</span>
          {karte.seit && <span className="vp-bm-seit">{karte.seit}</span>}
          {karte.beleg && <span className="vp-bm-beleg">{karte.beleg}</span>}
          {karte.blockedReason && (
            <span className="vp-bm-blocked">{karte.blockedReason}</span>
          )}
        </span>
      </button>

      <button
        type="button"
        className="vp-bm-open"
        aria-label={`${karte.label} öffnen`}
        onClick={onOpen}
      >
        <Icon name="chevron-right" size={16} />
      </button>

      {karte.ampel.length > 0 && (
        <ul className="vp-bm-ampel">
          {karte.ampel.map((z) => (
            <li key={z.label} className={z.met ? 'met' : ''}>
              <span className="vp-bm-req">
                {z.met ? '✓ ' : ''}
                {z.text}
              </span>
              {z.weg && (
                <button type="button" className="vp-bm-weg" onClick={() => onWeg(z)}>
                  {z.weg.label} →
                </button>
              )}
              {z.durchVoltpilot && (
                <span className="vp-bm-vp">{z.durchVoltpilot}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
