import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import type { ChargePoint } from './ladepunkte';
import {
  gemesseneEntitaeten,
  hatLadepunkt,
  heuteAusEntitaet,
  heuteAusRegister,
  REGISTER_POINT_KEY,
  tagesBeginn,
} from './verbrauchHeute';
import type { VerbrauchKomposition } from './verbrauchKomposition';

/** Wie viele Komponenten-Historien gleichzeitig unterwegs sein dürfen. */
const PARALLEL = 4;

/**
 * Die Tagessummen der Aufschlüsselung — **lazy**, also erst, wenn der Kunde
 * das Panel wirklich aufklappt (Konzept `vp-verbraucher-cockpit-k1` §8, Phase 0
 * Schritt 5; das Board-Spark-Muster).
 *
 * ⚠ Zwei Abrufe, nie mehr: EIN Register-Abruf für alle Ladepunkte
 * (`/ocpp/meter-values` mit `from` + `pointKey`) und je gemessener Komponente
 * ihre Tages-Historie. Ein Abruf je SÄULE wäre bei 25 Ladepunkten ein Sturm
 * für eine Zahl, die eine einzige Antwort schon enthält.
 *
 * Fail-soft wie jede Anzeige-Ergänzung: ein Fehler liefert schlicht keinen
 * Eintrag, und die Zeile bleibt bei ihrem ehrlichen „—" — sie behauptet nie
 * eine 0, und das Board bleibt bedienbar.
 */
export function useVerbrauchHeute(
  siteId: string,
  komposition: VerbrauchKomposition | null,
  chargers: ChargePoint[] | null | undefined,
  armed: boolean,
): Record<string, number | null> | null {
  const [heute, setHeute] = useState<Record<string, number | null> | null>(null);
  // ⚠ Die Ids als STRING in die Abhängigkeiten: `komposition` wird mit dem
  // Ergebnis dieses Hooks neu gerechnet, ein Objekt-Vergleich liefe also im
  // Kreis. Die Id-Menge selbst hängt nicht an den Tagessummen.
  const idsKey = useMemo(() => gemesseneEntitaeten(komposition).join(','), [komposition]);
  const mitLadepunkt = hatLadepunkt(chargers);
  // Der Tagesbeginn wird beim AUFKLAPPEN festgehalten - ein Panel, das über
  // Mitternacht offen bleibt, zeigt bis zum nächsten Zu- und Aufklappen den
  // gestrigen Tag. Das ist die ehrlichere der beiden Vereinfachungen: die
  // Alternative wäre ein Ticker, der die Zahlen unter dem Blick des Kunden
  // austauscht, ohne dass er es sieht.
  const tag = useMemo(() => (armed ? tagesBeginn() : null), [armed]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!armed || tag == null) return;
    if (!mitLadepunkt && idsKey === '') return;
    let cancelled = false;
    const ids = idsKey === '' ? [] : idsKey.split(',');
    (async () => {
      const out: Record<string, number | null> = {};
      if (mitLadepunkt) {
        try {
          const samples = await api.ocppMeterValues(siteId, 1000, undefined, {
            from: tag,
            pointKey: REGISTER_POINT_KEY,
          });
          Object.assign(out, heuteAusRegister(samples));
        } catch {
          /* ehrliches „—" statt einer erfundenen Zahl */
        }
      }
      for (let i = 0; i < ids.length; i += PARALLEL) {
        const teil = ids.slice(i, i + PARALLEL);
        const werte = await Promise.all(
          teil.map(async (id) => {
            try {
              return [id, heuteAusEntitaet(await api.entityHistory(siteId, id, 'day'))] as const;
            } catch {
              return [id, null] as const;
            }
          }),
        );
        for (const [id, kwh] of werte) out[`e:${id}`] = kwh;
        if (cancelled) return;
      }
      if (!cancelled && alive.current) setHeute(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [siteId, idsKey, mitLadepunkt, armed, tag]);

  return heute;
}
