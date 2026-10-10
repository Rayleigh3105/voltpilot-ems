import { useEffect, useState } from 'react';
import { api, type UemsDatenquelle } from './api';
import { quellenJeGeraet } from './boxAnQuelle';

/**
 * Die Zuständigkeiten der Datenquellen für eine oder mehrere Anlagen (UEMS AP-13 IP-12, L6) —
 * daraus sagen die Quelle-Karte und die Register-Spalte „Quelle“, WELCHE Box liest.
 *
 * ⚠ ZWEI Aufrufe je Anlage, nicht einer: `…/data-sources` nennt weder Geräte noch Komponenten
 * einer Quelle, also verbindet erst `…/geraete` (`data_source_id`) die Fläche mit ihr (Befund an
 * AP-06, siehe `boxAnQuelle.ts`). Beide Antworten werden je Anlage genau EINMAL gelesen und
 * gemerkt; ein Anlagen-Wechsel liest nur die neue Anlage nach.
 *
 * ⚠ Jede Ablehnung bleibt still: ohne Antwort steht kein Box-Satz, und die Flächen stehen genau
 * so da wie vor diesem Paket. Eine fehlende Zuständigkeit ist kein Fehler des Registers.
 */
export interface BoxenAnQuellen {
  /** Gerät-ID → Datenquelle; leer, solange nichts gelesen ist. */
  karte: ReadonlyMap<string, UemsDatenquelle>;
  /** Alle gelesenen Datenquellen — das Urteil „Box-Tausch oder Übergabe“ braucht sie alle. */
  quellen: readonly UemsDatenquelle[];
}

const LEER: BoxenAnQuellen = { karte: new Map(), quellen: [] };

async function fuerAnlage(anlage: string): Promise<BoxenAnQuellen> {
  const [geraete, quellen] = await Promise.all([
    api.uemsGeraete(anlage).then((a) => a.geraete, () => []),
    api.datenquellen(anlage).then((a) => a.datenquellen, () => []),
  ]);
  return { karte: quellenJeGeraet(geraete, quellen), quellen };
}

export function useBoxenAnQuellen(anlagen: readonly (string | null | undefined)[]): BoxenAnQuellen {
  const ids = [...new Set(anlagen.filter((a): a is string => typeof a === 'string' && a.length > 0))].sort();
  const schluessel = ids.join('|');
  const [stand, setStand] = useState<Record<string, BoxenAnQuellen>>({});

  useEffect(() => {
    if (ids.length === 0) return;
    let aktiv = true;
    for (const id of ids) {
      if (stand[id]) continue;
      void fuerAnlage(id).then((s) => aktiv && setStand((alt) => (alt[id] ? alt : { ...alt, [id]: s })));
    }
    return () => {
      aktiv = false;
    };
  }, [schluessel]); // eslint-disable-line react-hooks/exhaustive-deps

  const teile = ids.map((id) => stand[id]).filter((s): s is BoxenAnQuellen => s !== undefined);
  if (teile.length === 0) return LEER;
  if (teile.length === 1) return teile[0];
  const karte = new Map<string, UemsDatenquelle>();
  for (const t of teile) for (const [g, q] of t.karte) karte.set(g, q);
  return { karte, quellen: teile.flatMap((t) => t.quellen) };
}
