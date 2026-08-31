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
 * **⚠ In diesem Paket ist die Zeile LESEND.** Sie öffnet noch keinen
 * Steuerart-Dialog (das ist P2), und statt eines toten Klicks steht der Weg da,
 * auf dem die Steuerart HEUTE eingestellt wird — die Haus-Regel „eine Handlung,
 * die strukturell nichts bewirken kann, wird nicht angeboten; stattdessen steht
 * ihr Grund da". Der Sprung „N Regeln →" ist dagegen echt: er führt gefiltert
 * in die Regel-Kapsel.
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
import './VerbraucherZone.css';

export interface VerbraucherZoneProps {
  daten: SiteVerbraucher | null;
  /** „N Regeln →": gefilterter Sprung in die Regel-Kapsel. */
  onRegeln: (entityId: string) => void;
  /** Der Rahmen-Kopf verweist auf die Ladepark-Einstellungen (bis P5). */
  onEinstellungen?: () => void;
}

export function VerbraucherZone({ daten, onRegeln, onEinstellungen }: VerbraucherZoneProps) {
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
  const folger = klappen ? ladepunkte.filter((z) => z.chip === 'Standard') : [];
  const offen = klappen ? ladepunkte.filter((z) => z.chip !== 'Standard') : ladepunkte;

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
                <Zeile key={z.entityId} z={z} onRegeln={onRegeln} />
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
                      <Zeile key={z.entityId} z={z} onRegeln={onRegeln} />
                    ))}
                  </ul>
                )}
              </>
            )}

            <p className="vp-vz-quiet">{WEG_LADEPUNKT}</p>
          </>
        )}

        {v.weitere.length > 0 && (
          <>
            <h4 className="vp-vz-sec">{ABSCHNITT_WEITERE}</h4>
            <ul className="vp-vz-rows">
              {v.weitere.map((z) => (
                <Zeile key={z.entityId} z={z} onRegeln={onRegeln} />
              ))}
            </ul>
            <p className="vp-vz-quiet">{WEG_VERBRAUCHER}</p>
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
              <ol className="vp-vz-rank">
                {v.rangliste.map((e) => (
                  <li key={`${e.art}:${e.entityId ?? 'speicher'}`}>
                    <span className="vp-vz-pos">{e.position}</span>
                    <span className="vp-vz-rankname">{e.name}</span>
                    {e.art !== 'speicher' && (
                      <span className="vp-vz-sub">
                        {e.art === 'ladepunkt' ? 'Ladepunkt' : ''}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </Card>
    </section>
  );
}

function Zeile({ z, onRegeln }: { z: ZeilenView; onRegeln: (entityId: string) => void }) {
  return (
    <li className="vp-vz-row">
      <span className="vp-vz-text">
        <span className="vp-vz-name">
          {z.name}
          {z.chip && (
            <span className={`vp-vz-chip ${z.chip === 'Standard' ? 'std' : 'abw'}`}>{z.chip}</span>
          )}
        </span>
        <span className="vp-vz-chips">
          <span className={`vp-vz-chip ${z.eigeneRegel ? 'own' : 'src'}`}>{z.quelle}</span>
          {z.ziel && <span className="vp-vz-chip due">{z.ziel}</span>}
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
      </span>
    </li>
  );
}
