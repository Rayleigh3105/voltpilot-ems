/**
 * **Zone ② · Verbraucher** — die Render-Hälfte (Verbrauchsmanagement v1,
 * Paket P1: LESEND).
 *
 * Jede Regel, jeder Satz und jedes Urteil liegt im reinen `src/verbraucherZone.ts`
 * (das `Betriebsmodelle`/`FleetOverview`-Muster); hier wird NUR gerendert.
 *
 * Der Abschnitt ist dreigeteilt (§6.1): **Ladepunkte** mit dem Ladepark-Rahmen
 * als Kopf und der Anlagen-Standard-Zeile, **Weitere Verbraucher**, und am Ende
 * die **Rangliste** als ausklappbare Karte.
 *
 * **⚠ Seit P2 ÖFFNET die Zeile den Steuerart-Dialog** — aber nur, wo der
 * Server sie als schreibbar meldet (`optionen.schreibbar`). Wo nicht (die
 * OCPP-Säule bis Paket P5, oder ein älteres Backend ohne das Feld), bleibt sie
 * lesend und nennt den WEG, den es wirklich gibt — die Haus-Regel „eine
 * Handlung, die strukturell nichts bewirken kann, wird nicht angeboten;
 * stattdessen steht ihr Grund da". Der Sprung „N Regeln →" ist unverändert
 * echt: er führt gefiltert in die Regel-Kapsel — und die RANGLISTE ist seit
 * Paket P4 bedienbar (`RanglisteKarte`).
 */
import { useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { GRENZE_FEHLT } from '../ladepunkte';
import {
  ABSCHNITT_LADEPUNKTE,
  ABSCHNITT_WEITERE,
  OHNE_REGEL,
  RAHMEN_EINSTELLUNGEN,
  RAHMEN_TITEL,
  RANGLISTE_TITEL,
  STANDARD_TITEL,
  WEG_LADEPUNKT,
  WEG_VERBRAUCHER,
  ZONE_INTRO,
  ZONE_TITEL,
  type SiteVerbraucher,
  type ZeilenView,
  type ZoneView,
  zone as zoneView,
} from '../verbraucherZone';
import { PartHead } from './SteuerungParts';
import { RanglisteKarte } from './RanglisteKarte';
import { FahrzeugeKarte } from './FahrzeugeKarte';
import type { FahrzeugWunsch, SiteFahrzeuge } from '../fahrzeugProfile';
import './VerbraucherZone.css';

export interface VerbraucherZoneProps {
  daten: SiteVerbraucher | null;
  /** „N Regeln →": gefilterter Sprung in die Regel-Kapsel. */
  onRegeln: (entityId: string) => void;
  /** Der Rahmen-Kopf verweist auf die Ladepark-Einstellungen (bis P5). */
  onEinstellungen?: () => void;
  /**
   * Speichert die Reihenfolge bei knapper Leistung (Paket P4). Fehlt sie, ist
   * die Rangliste reine ANZEIGE - ein Knopf, der nichts bewirken kann, wird
   * nicht angeboten.
   */
  onRangliste?: (rumpf: { art: string; entityId?: string }[]) => Promise<void>;
  /** Klick auf eine SCHREIBBARE Zeile: der Steuerart-Dialog (P2). */
  onSteuerart?: (entityId: string) => void;
  /**
   * Die FAHRZEUGE dieses Ladeparks (P7). `null` = noch nicht geladen oder ein
   * älteres Backend - dann erscheint der Abschnitt gar nicht, statt eine leere
   * Liste zu behaupten.
   */
  fahrzeuge?: SiteFahrzeuge | null;
  onFahrzeug?: (tagRef: string, wunsch: FahrzeugWunsch) => Promise<void>;
  onFahrzeugEntfernen?: (tagRef: string) => Promise<void>;
}

export function VerbraucherZone({
  daten, onRegeln, onEinstellungen, onRangliste, onSteuerart,
  fahrzeuge, onFahrzeug, onFahrzeugEntfernen,
}: VerbraucherZoneProps) {
  const v: ZoneView = zoneView(daten);
  const [suche, setSuche] = useState('');
  const [ranglisteOffen, setRanglisteOffen] = useState(false);
  const [standardOffen, setStandardOffen] = useState(false);

  const gefiltert = (zeilen: ZeilenView[]): ZeilenView[] => {
    const q = suche.trim().toLowerCase();
    return q ? zeilen.filter((z) => z.name.toLowerCase().includes(q)) : zeilen;
  };
  // §6.4: ab 25 Ladepunkten stehen nur die ABWEICHENDEN offen; die Folger des
  // Standards werden zusammengeklappt und GEZÄHLT, nie verschwiegen.
  const ladepunkte = gefiltert(v.ladepunkte);
  const klappen = v.ladepunkte.length >= v.klappenAb && !suche.trim();
  const folger = klappen ? ladepunkte.filter((z) => z.folgtStandard) : [];
  const offen = klappen ? ladepunkte.filter((z) => !z.folgtStandard) : ladepunkte;

  return (
    <section className="vp-capsule vp-verbraucherzone" aria-label={ZONE_TITEL}>
      <PartHead title={ZONE_TITEL} intro={ZONE_INTRO} />
      <Card padding="lg" radius="lg">
        {v.leer && <p className="vp-capsule-empty">{v.leer}</p>}

        {v.ladepunkte.length > 0 && (
          <>
            <h4 className="vp-vz-sec">{ABSCHNITT_LADEPUNKTE}</h4>
            {v.rahmen && (
              <div className="vp-vz-rahmen">
                <div className="vp-vz-rahmen-kopf">
                  <b>{RAHMEN_TITEL}</b>
                  {onEinstellungen && (
                    <button type="button" className="vp-vz-link" onClick={onEinstellungen}>
                      {RAHMEN_EINSTELLUNGEN}
                      <Icon name="chevron-right" size={14} />
                    </button>
                  )}
                </div>
                {v.rahmen.zahlen.length > 0 && (
                  <p className="vp-vz-rahmen-zahlen">
                    {v.rahmen.zahlen.map((t) => (
                      <span key={t}>{t}</span>
                    ))}
                  </p>
                )}
                {v.rahmen.anteil != null && (
                  <span className="vp-vz-bar" aria-hidden="true">
                    <i style={{ width: `${Math.round(v.rahmen.anteil * 100)}%` }} />
                  </span>
                )}
                {/* Ohne hinterlegte Grenze steht der BESTEHENDE Satz da — eine
                    zweite Formulierung derselben Lage wäre eine zweite Wahrheit. */}
                {v.rahmen.grenzeFehlt && <p className="vp-vz-warn">{GRENZE_FEHLT}</p>}
                {v.rahmen.hinweis && <p className="vp-vz-quiet">{v.rahmen.hinweis}</p>}
              </div>
            )}

            {v.standard && (
              <div className="vp-vz-standard">
                <div>
                  <b>{STANDARD_TITEL}</b>
                  <div className="vp-vz-chips">
                    {v.standardQuelle && <span className="vp-vz-chip src">{v.standardQuelle}</span>}
                    {v.standardZiel && <span className="vp-vz-chip due">{v.standardZiel}</span>}
                    {v.standardSatz && <span className="vp-vz-sub">{v.standardSatz}</span>}
                  </div>
                </div>
              </div>
            )}

            {v.ladepunkte.length >= v.sucheAb && (
              <label className="vp-vz-suche">
                <span className="vp-visually-hidden">Ladepunkt suchen</span>
                <input
                  type="text"
                  value={suche}
                  placeholder="Ladepunkt suchen …"
                  onChange={(e) => setSuche(e.target.value)}
                />
              </label>
            )}

            <ul className="vp-vz-rows">
              {offen.map((z) => (
                <Zeile key={z.entityId} z={z} onRegeln={onRegeln} onSteuerart={onSteuerart} />
              ))}
            </ul>

            {klappen && folger.length > 0 && (
              <>
                <button
                  type="button"
                  className="vp-vz-fold"
                  aria-expanded={standardOffen}
                  onClick={() => setStandardOffen((o) => !o)}
                >
                  {`${folger.length} ${folger.length === 1 ? 'Ladepunkt folgt' : 'Ladepunkte folgen'} dem Standard`}
                  <Icon name={standardOffen ? 'chevron-down' : 'chevron-right'} size={14} />
                </button>
                {standardOffen && (
                  <ul className="vp-vz-rows">
                    {folger.map((z) => (
                      <Zeile
                        key={z.entityId}
                        z={z}
                        onRegeln={onRegeln}
                        onSteuerart={onSteuerart}
                      />
                    ))}
                  </ul>
                )}
              </>
            )}

            {/* ⚠ Der Weg steht nur da, wo die Zeile NICHT schreibbar ist -
                sonst wäre er ein Hinweis auf einen Umweg, den es nicht mehr
                braucht. */}
            {v.ladepunkte.some((z) => !z.schreibbar)
              && <p className="vp-vz-quiet">{WEG_LADEPUNKT}</p>}

            {/* ⚠ Die FAHRZEUGE stehen IM Ladepunkt-Abschnitt (P7): ein Profil
                ist eine Abweichung von der Steuerart des Ladepunkts, und zwei
                entfernte Orte für dieselbe Frage wären eine Doppeldeutigkeit.
                Ohne geladene Daten erscheint der Abschnitt gar nicht. */}
            {fahrzeuge && (
              <FahrzeugeKarte
                daten={fahrzeuge}
                ladepunktName={(id) => ladepunktNameAus(daten, id)}
                onSpeichern={onFahrzeug}
                onEntfernen={onFahrzeugEntfernen}
              />
            )}
          </>
        )}

        {v.weitere.length > 0 && (
          <>
            <h4 className="vp-vz-sec">{ABSCHNITT_WEITERE}</h4>
            <ul className="vp-vz-rows">
              {v.weitere.map((z) => (
                <Zeile key={z.entityId} z={z} onRegeln={onRegeln} onSteuerart={onSteuerart} />
              ))}
            </ul>
            {v.weitere.some((z) => !z.schreibbar)
              && <p className="vp-vz-quiet">{WEG_VERBRAUCHER}</p>}
          </>
        )}

        {v.rangliste.length > 0 && (
          <>
            <button
              type="button"
              className="vp-vz-fold"
              aria-expanded={ranglisteOffen}
              onClick={() => setRanglisteOffen((o) => !o)}
            >
              {RANGLISTE_TITEL}
              {v.ranglisteZusammenfassung && (
                <small className="vp-vz-sub">{v.ranglisteZusammenfassung}</small>
              )}
              <Icon name={ranglisteOffen ? 'chevron-down' : 'chevron-right'} size={14} />
            </button>
            {ranglisteOffen && (
              <RanglisteKarte liste={v.rangliste} onSpeichern={onRangliste} />
            )}
          </>
        )}
      </Card>
    </section>
  );
}

/**
 * Der NAME einer Säule zu ihrer Kennung - aus demselben Lese-Aggregat, das die
 * Zeilen darüber trägt. Ohne Treffer `null`; die Fläche nennt dann die Kennung,
 * statt einen Namen zu erfinden.
 */
function ladepunktNameAus(daten: SiteVerbraucher | null, chargePointId: string): string | null {
  const treffer = (daten?.verbraucher ?? [])
    .find((e) => e.ladepunkt && e.chargePointId === chargePointId);
  return treffer?.name ?? null;
}

function Zeile({ z, onRegeln, onSteuerart }: {
  z: ZeilenView;
  onRegeln: (entityId: string) => void;
  onSteuerart?: (entityId: string) => void;
}) {
  const oeffnen = z.schreibbar && onSteuerart ? () => onSteuerart(z.entityId) : null;
  const inhalt = (
    <>
      <span className="vp-vz-name">
        {z.name}
        {z.chip && (
          <span className={`vp-vz-chip ${z.chip === 'Standard' ? 'std' : 'abw'}`}>{z.chip}</span>
        )}
      </span>
      <span className="vp-vz-chips">
        <span className={`vp-vz-chip ${z.eigeneRegel ? 'own' : 'src'}`}>{z.quelle}</span>
        {z.ziel && <span className="vp-vz-chip due">{z.ziel}</span>}
      </span>
    </>
  );
  return (
    <li className="vp-vz-row">
      {/* ⚠ Die Steuerart und der Regel-Sprung sind ZWEI Ziele - deshalb ist
          die Zeile kein Knopf um alles herum, sondern trägt zwei getrennte
          Bedienelemente (ein Klickziel in einem anderen ist die
          Doppeldeutigkeit, die das Haus verbietet). */}
      {oeffnen ? (
        <button type="button" className="vp-vz-text is-klick" onClick={oeffnen}>
          {inhalt}
          <Icon name="chevron-right" size={16} />
        </button>
      ) : (
        <span className="vp-vz-text">
          {inhalt}
          {z.nichtSchreibbarGrund && (
            <span className="vp-vz-sub">{z.nichtSchreibbarGrund}</span>
          )}
        </span>
      )}
      <span className="vp-vz-chips">
        {z.regeln ? (
          <button
            type="button"
            className="vp-vz-chip rule"
            onClick={() => onRegeln(z.entityId)}
          >
            {z.regeln}
          </button>
        ) : (
          <span className="vp-vz-sub">{OHNE_REGEL}</span>
        )}
      </span>
    </li>
  );
}
