import { useEffect, useId, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type EdgeVersion } from '../api';
import type { GeraetesucheVerlaufEintrag } from '../geraetesuche';
import { knopfLage, laeuftNoch, letzteSucheSatz, type KnopfLage } from '../geraetesucheAnsicht';
import { UEMS_GERAETE_SUCHEN } from '../glossar';
import { aufbauHash, hashForRoute, pageRoute } from '../nav';
import { useRollen } from '../rollen';
import { Recht } from './Recht';
import './GeraetesucheEinstieg.css';

/**
 * Die Einstiege in „Geräte suchen" auf der Box-Seite (Bericht §4 „Einstiege", m1, m8, d1): der Knopf im Kopf der Karte
 * „Geräte an dieser Box", der Hauptknopf im Leerzustand, der Grund, warum er gerade nicht geht, und die letzte Suche.
 * Alle führen in den Aufbau (`?neu=suche&box=…`) - Geräte entstehen nur dort. Ohne das Recht `geraet.einrichten`
 * steht statt des Knopfs der Satz, wer es darf (`Recht`).
 */

/** Die Suchen dieser Box (fail-soft: ohne Antwort `null`, dann fehlt nur die Zeile „Letzte Suche"). */
export function useGeraetesucheVerlauf(siteId: string, boxId: string | null): GeraetesucheVerlaufEintrag[] | null {
  const [eintraege, setEintraege] = useState<GeraetesucheVerlaufEintrag[] | null>(null);
  useEffect(() => {
    if (!boxId) return;
    const controller = new AbortController();
    setEintraege(null);
    api.geraetesucheVerlauf(siteId, boxId, controller.signal).then(
      (a) => setEintraege(a.suchen),
      () => undefined,
    );
    return () => controller.abort();
  }, [siteId, boxId]);
  return eintraege;
}

/** Ob der Knopf geht - und wenn nicht, warum (offline, Update nötig, läuft schon). */
export function useGeraetesucheLage(
  lastSeenAt: string | null | undefined,
  edge: EdgeVersion | null | undefined,
  verlauf: readonly GeraetesucheVerlaufEintrag[] | null,
  jetzt: number,
): KnopfLage {
  const ich = useRollen().selbst?.name ?? null;
  return knopfLage({
    lastSeenAt,
    faehigkeiten: edge ? edge.capabilities ?? edge.supports ?? null : null,
    laufend: verlauf?.find((e) => laeuftNoch(e.zustand)) ?? null,
    ichName: ich,
    jetzt,
  });
}

/** „Geräte suchen" bzw. „Mitansehen" - ein Link in den Aufbau; gesperrt mit Verweis auf den Grund. */
export function GeraeteSuchenKnopf({
  siteId,
  boxId,
  lage,
  gross = false,
  grundId,
}: {
  siteId: string;
  boxId: string;
  lage: KnopfLage;
  gross?: boolean;
  grundId?: string;
}) {
  const klasse = `vp-btn vp-gs-einstieg-knopf ${gross ? 'vp-btn--primary vp-btn--lg vp-gs-einstieg-gross' : 'vp-btn--outline vp-btn--sm'}`;
  if (lage.art === 'laeuft') {
    return (
      <Recht aktion="geraet.einrichten">
        <a className={`vp-btn vp-gs-einstieg-knopf vp-btn--outline ${gross ? 'vp-btn--lg vp-gs-einstieg-gross' : 'vp-btn--sm'}`} href={aufbauHash(siteId, 'suche', { box: boxId, such: lage.suchId })}>
          Mitansehen
        </a>
      </Recht>
    );
  }
  if (lage.art !== 'bereit') {
    return (
      <Recht aktion="geraet.einrichten">
        <button type="button" className={klasse} disabled aria-describedby={grundId}>
          <Icon name="target" size={gross ? 18 : 15} /> {UEMS_GERAETE_SUCHEN}
        </button>
      </Recht>
    );
  }
  return (
    <Recht aktion="geraet.einrichten">
      <a className={klasse} href={aufbauHash(siteId, 'suche', { box: boxId })} data-testid="geraete-suchen">
        <Icon name="target" size={gross ? 18 : 15} /> {UEMS_GERAETE_SUCHEN}
      </a>
    </Recht>
  );
}

/** Der Satz, warum der Knopf gerade nicht geht - nie ein stummer grauer Knopf (m8). */
export function GeraetesucheGrund({ lage, id }: { lage: KnopfLage; id: string }) {
  if (lage.art === 'bereit') return null;
  return (
    <p className={`vp-gs-einstieg-grund is-${lage.art}`} id={id} data-testid="geraetesuche-grund">
      <span className={`vp-health-dot ${lage.art === 'laeuft' ? 'vp-health-ok' : 'vp-health-off'}`} aria-hidden="true" />
      <span>{lage.satz}</span>
      {lage.art === 'update' && (
        <a href={hashForRoute(pageRoute('edge-updates'))}>
          Update planen <Icon name="chevron-right" size={14} />
        </a>
      )}
    </p>
  );
}

/** „Letzte Suche heute 09:12 · 2 Energie-Geräte, 1 davon noch nicht übernommen · Letzte Suchen" (d1). */
export function LetzteSuche({
  siteId,
  boxId,
  verlauf,
  jetzt,
}: {
  siteId: string;
  boxId: string;
  verlauf: readonly GeraetesucheVerlaufEintrag[] | null;
  jetzt: number;
}) {
  const letzte = verlauf?.[0];
  if (!letzte) return null;
  return (
    <p className="vp-note vp-gs-einstieg-letzte" data-testid="letzte-suche">
      {letzteSucheSatz(letzte, new Date(jetzt))} ·{' '}
      <a href={aufbauHash(siteId, 'suche', { box: boxId, verlauf: true })}>Letzte Suchen</a>
    </p>
  );
}

/**
 * Der Leerzustand der Box-Seite (m1): „Noch keine Geräte" mit „Geräte suchen" als Hauptknopf; „von Hand" bleibt ein
 * leiser Weg.
 */
export function GeraetesucheLeer({
  siteId,
  boxId,
  satz,
  lage,
}: {
  siteId: string;
  boxId: string;
  /** „An dieser Box meldet sich noch kein Gerät." */
  satz: string;
  lage: KnopfLage;
}) {
  const grundId = useId();
  return (
    <div className="vp-gs-einstieg-leer" data-testid="geraetesuche-leer">
      <span className="vp-gs-einstieg-symbol" aria-hidden="true"><Icon name="target" size={22} /></span>
      <b>{satz}</b>
      <p>Ihre Box kann ihr Heimnetz nach Wechselrichtern, Zählern, Wallboxen und Schaltern durchsuchen. Es wird nur gelesen.</p>
      <GeraeteSuchenKnopf siteId={siteId} boxId={boxId} lage={lage} gross grundId={grundId} />
      <GeraetesucheGrund lage={lage} id={grundId} />
      <Recht aktion="geraet.einrichten">
        <a className="vp-gs-einstieg-hand" href={aufbauHash(siteId, 'geraet')}>Von Hand hinzufügen</a>
      </Recht>
    </div>
  );
}
