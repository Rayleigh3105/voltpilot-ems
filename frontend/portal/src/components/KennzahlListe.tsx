import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, ApiError, type Kennzahl, type KennzahlPeriodeArt } from '../api';
import {
  ANZAHL_VERLAUF,
  amStandort,
  anfrage,
  heuteIn,
  listenPerioden,
  ohneWert,
  type ListenKarte,
  type ListenWerte,
} from '../kennzahlKarte';
import '../pages/KennzahlenPage.css';
import './Bezugsbasis.css';

/**
 * Die Listen-Karten der Kennzahlen (AP-11 IP-13) — geteilt von „Unternehmen › Kennzahlen“, „Kennzahlen dieses
 * Standorts“ (AP-13 IP-2) und dem Baustein „Kennzahlen“ der Übersicht (AP-13 IP-7).
 *
 * `useKennzahlenListe` liest `GET /api/v1/kennzahlen` und je Kennzahl das Fenster des Verlaufs in ihrer Grundperiode
 * (`…/werte`, IP-7); am Standort nur, was dort gilt. `an = false` fragt nichts ab. Jede Ableitung steht in
 * `kennzahlKarte.ts`. ⚠ R-A7: antwortet `…/werte` für eine gelistete Kennzahl mit 404, trägt die Karte die
 * Hinweiszeile ohne Wert.
 */
export function useKennzahlenListe(zone: string, standortId: string | null, versuch = 0, an = true) {
  const [liste, setListe] = useState<Kennzahl[] | null>(null);
  const [werte, setWerte] = useState<Record<string, ListenWerte>>({});
  const [ausserhalb, setAusserhalb] = useState<string | null>(null);
  const [fehler, setFehler] = useState(false);

  useEffect(() => {
    if (!an) return;
    let aktiv = true;
    setFehler(false);
    api.kennzahlen().then(
      ({ kennzahlen: alle, ausserhalb_zugriff }) => {
        if (!aktiv) return;
        // Am Standort nur, was dort gilt — und nur deren Werte werden gelesen.
        const kennzahlen = standortId ? amStandort(alle, standortId) : alle;
        setListe(kennzahlen);
        setAusserhalb(ausserhalb_zugriff?.text ?? null);
        setWerte({});
        ladeWerte(kennzahlen, zone, (id, w) => aktiv && setWerte((alt) => ({ ...alt, [id]: w })), () => aktiv);
      },
      () => aktiv && setFehler(true),
    );
    return () => {
      aktiv = false;
    };
  }, [zone, versuch, standortId, an]);
  return { liste, werte, fehler, ausserhalb };
}

/**
 * Je Kennzahl das Fenster des Verlaufs in ihrer Grundperiode (`…/werte`, IP-7). Trägt die Grundperiode keinen
 * gebildeten Wert (nur Platzhalter), die nächstgröbere mit Werten versuchen (`listenPerioden`), sonst stünde „—“, obwohl
 * die Kennzahl monatlich rechnet. Der Rückfall kann nur verbessern: bei echtem Schritt (auch „keine Werte“) hält die
 * erste Periode.
 */
function ladeWerte(
  kennzahlen: readonly Kennzahl[],
  zone: string,
  setze: (id: string, w: ListenWerte) => void,
  aktiv: () => boolean,
) {
  const heute = heuteIn(zone, Date.now());
  const laden = (id: string, perioden: KennzahlPeriodeArt[], i: number) => {
    const art = perioden[i];
    const { von, bis } = anfrage(art, heute, ANZAHL_VERLAUF[art]);
    api.kennzahlWerte(id, art, von, bis).then(
      (antwort) =>
        aktiv() &&
        (ohneWert(antwort) && i + 1 < perioden.length ? laden(id, perioden, i + 1) : setze(id, { art: 'geladen', antwort })),
      (e) => setze(id, e instanceof ApiError && e.status === 404 ? { art: 'ausserhalb' } : { art: 'fehler' }),
    );
  };
  for (const k of kennzahlen) {
    const perioden = listenPerioden(k);
    if (perioden.length === 0) {
      setze(k.id, { art: 'ohne_periode' });
      continue;
    }
    laden(k.id, perioden, 0);
  }
}

/**
 * Konzept Auswerten a1 (PR1): die Werte nur der Kennzahlen, die keine Auswertung tragen - Archivierte erst beim
 * Aufklappen (`kennzahlen = null` lädt nichts), Kennzahlen ohne Monatswerte immer. Jede andere Karte liest ihre Zahl aus
 * `GET /api/v1/kennzahlen?mit=auswertung`.
 */
export function useListenWerte(kennzahlen: readonly Kennzahl[] | null, zone: string): Record<string, ListenWerte> {
  const [werte, setWerte] = useState<Record<string, ListenWerte>>({});
  const schluessel = kennzahlen?.map((k) => k.id).join(',') ?? null;
  useEffect(() => {
    if (!kennzahlen || kennzahlen.length === 0) return;
    let aktiv = true;
    ladeWerte(kennzahlen, zone, (id, w) => aktiv && setWerte((alt) => ({ ...alt, [id]: w })), () => aktiv);
    return () => {
      aktiv = false;
    };
    // Die Liste wechselt nur mit ihren Kennungen - ein neues Array derselben Kennzahlen lädt nicht neu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schluessel, zone]);
  return werte;
}

export function KennzahlKarte({ karte, onOeffnen }: { karte: ListenKarte; onOeffnen: () => void }) {
  return (
    <button type="button" className="vp-kz-karte" data-testid="kennzahl-karte" onClick={onOeffnen}>
      <span className="vp-kz-karte-kopf">
        <span className="vp-kz-kennzeichen">{karte.kennzeichen}</span>
        {karte.archiviert && <Badge variant="tint">{karte.archiviert}</Badge>}
        <span className="vp-kz-pfeil" aria-hidden="true">
          <Icon name="chevron-right" size={18} />
        </span>
      </span>
      <span className="vp-kz-name">{karte.name}</span>
      {karte.hinweis ? (
        <span className="vp-kz-hinweis" data-testid="kennzahl-hinweis">
          {karte.hinweis}
        </span>
      ) : karte.fehler ? (
        <span className="vp-kz-hinweis">{karte.fehler}</span>
      ) : karte.zahl === null ? (
        <span className="vp-kz-platzhalter" aria-hidden="true" />
      ) : (
        <>
          <span className="vp-kz-zahl" data-testid="kennzahl-zahl">
            {karte.zahl}
          </span>
          {(karte.zustand || karte.periode) && (
            <span className="vp-kz-abzeichen">
              {karte.zustand && <Badge variant={karte.zustandTon}>{karte.zustand}</Badge>}
              {karte.periode && <span>{karte.periode}</span>}
            </span>
          )}
        </>
      )}
      <span className="vp-kz-unter">{karte.unter}</span>
    </button>
  );
}
