/**
 * Die Anlagensteuerung einer Erzeugeranlage laden (UEMS EZ-10) - für Steuerung › Geräte, die Geräteseite und
 * Anlage › Einstellungen. Jede Quelle fehlertolerant: ein älteres Backend (404) oder ein Fehler lässt nur das
 * Stück weg, das sie belegt hätte; die Seiten zeigen dann, was sie heute zeigen.
 *
 * Takt nach `pollCadence.ts`: die Werte sind gemessene Ist-Werte (`LIVE_POLL_MS`), Liste und Stammdaten ein
 * Verwaltungsstand (`LIST_POLL_MS`); verdeckte Tabs fragen nicht.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AnlagensteuerungListe, type AnlagensteuerungWerte, type NetzVermarktung } from './api';
import { LIST_POLL_MS, LIVE_POLL_MS } from './pollCadence';
import { useFreshnessPoll } from './useFreshnessPoll';

export interface AnlagensteuerungStand {
  /** `null` = lädt noch, älteres Backend oder Fehler - dann gibt es keine Anlagensteuerung zu zeigen. */
  liste: AnlagensteuerungListe | null;
  netzVermarktung: NetzVermarktung | null;
  /** Je Gerät die jüngsten Werte; fehlt ein Eintrag, ist noch nichts geladen. */
  werte: Record<string, AnlagensteuerungWerte>;
  /** Nach einer Änderung: neu laden. */
  neuLaden: () => void;
  /** Eine Antwort übernehmen, ohne neu zu laden (z. B. nach `PUT`). */
  setzeNetzVermarktung: (nv: NetzVermarktung) => void;
}

export function useAnlagensteuerung(siteId: string | null, mitWerten = true): AnlagensteuerungStand {
  const [liste, setListe] = useState<AnlagensteuerungListe | null>(null);
  const [nv, setNv] = useState<NetzVermarktung | null>(null);
  const [werte, setWerte] = useState<Record<string, AnlagensteuerungWerte>>({});
  const [stand, setStand] = useState(0);
  const siteRef = useRef(siteId);
  siteRef.current = siteId;

  const ladeListe = useCallback(() => {
    const id = siteId;
    if (!id) return;
    api.anlagensteuerungen(id).then(
      (l) => siteRef.current === id && setListe(l),
      () => undefined,
    );
    api.netzVermarktung(id).then(
      (v) => siteRef.current === id && setNv(v),
      () => undefined,
    );
  }, [siteId]);

  const geraete = (liste?.steuerungen ?? []).map((s) => s.geraet_id).join(',');
  const ladeWerte = useCallback(() => {
    const id = siteId;
    if (!id || !mitWerten || !geraete) return;
    for (const g of geraete.split(',')) {
      api.anlagensteuerungWerte(id, g).then(
        (w) => siteRef.current === id && setWerte((alt) => ({ ...alt, [g]: w })),
        () => undefined,
      );
    }
  }, [siteId, mitWerten, geraete]);

  useEffect(() => {
    setListe(null);
    setNv(null);
    setWerte({});
  }, [siteId]);
  useEffect(() => ladeListe(), [ladeListe, stand]);
  useEffect(() => ladeWerte(), [ladeWerte]);
  useFreshnessPoll(ladeListe, LIST_POLL_MS, Boolean(siteId));
  useFreshnessPoll(ladeWerte, LIVE_POLL_MS, Boolean(siteId) && mitWerten && Boolean(geraete));

  return {
    liste,
    netzVermarktung: nv,
    werte,
    neuLaden: useCallback(() => setStand((n) => n + 1), []),
    setzeNetzVermarktung: setNv,
  };
}

/** Die jüngsten Werte EINER Anlagensteuerung (Geräteseite); `null` = noch nicht geladen oder nicht lesbar. */
export function useAnlagensteuerungWerte(siteId: string | null, geraetId: string | null): AnlagensteuerungWerte | null {
  const [werte, setWerte] = useState<AnlagensteuerungWerte | null>(null);
  const ziel = siteId && geraetId ? `${siteId}|${geraetId}` : null;
  const zielRef = useRef(ziel);
  zielRef.current = ziel;
  const lade = useCallback(() => {
    if (!siteId || !geraetId) return;
    const z = `${siteId}|${geraetId}`;
    api.anlagensteuerungWerte(siteId, geraetId).then(
      (w) => zielRef.current === z && setWerte(w),
      () => undefined,
    );
  }, [siteId, geraetId]);
  useEffect(() => {
    setWerte(null);
    lade();
  }, [lade]);
  useFreshnessPoll(lade, LIVE_POLL_MS, ziel != null);
  return werte;
}
