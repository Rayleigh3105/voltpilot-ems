/**
 * Die REINEN Regeln des Zählerbaums (Konzept `vp-zaehlerbaum-konzept`,
 * Captain-Entscheide E1-E5 vom 10.11.2026, alle A; Prosa in
 * `docs/contracts/v2/zaehlerbaum.md` §2, R6): darf eine Komponente an dieser
 * Eltern-Komponente hängen?
 *
 * Der Zwilling im Server ist
 * `services/api/.../components/ZaehlerbaumRegeln`; beide fahren dieselben
 * Vektoren (`docs/contracts/v2/zaehlerbaum-vectors.json`). **Wer eine Regel
 * ändert, ändert beide Seiten und die Vektor-Datei.**
 */

/** Die Rolle des Netzanschlusses - hängt nie irgendwo. */
export const ROLLE_NETZ = 'grid-meter';

/** Der Entitätstyp eines Unterzählers - ein Zähler, kein Netzanschluss. */
export const TYP_UNTERZAEHLER = 'sub-meter';

/** Eine Komponente, wie sie heute im Baum hängt (für den Zyklus-Test). */
export interface Zuordnung {
  komponenteId: string;
  haengtAn: string | null;
}

/** Die Eltern-Komponente, die geprüft wird. `null` = die Wurzel (kein Eltern). */
export interface ElternKandidat {
  id: string;
  anlage: string;
  rolle: string | null;
  entityType: string | null;
}

/** Warum eine Zuordnung abgelehnt wird - in der Reihenfolge der Prüfung (Vertrag R6). */
export const HAENGT_AN_GRUENDE = [
  'wurzel_haengt_nirgends',
  'selbst',
  'fremde_anlage',
  'eltern_kein_zaehler',
  'zyklus',
] as const;
export type HaengtAnGrund = (typeof HAENGT_AN_GRUENDE)[number];

export interface HaengtAnUrteil {
  gueltig: boolean;
  grund: HaengtAnGrund | null;
  kette: string[];
}

const GUELTIG: HaengtAnUrteil = { gueltig: true, grund: null, kette: [] };

function ungueltig(grund: HaengtAnGrund, kette: string[] = []): HaengtAnUrteil {
  return { gueltig: false, grund, kette };
}

function haengtAnVon(baum: Zuordnung[], komponenteId: string): string | null {
  return baum.find((z) => z.komponenteId === komponenteId)?.haengtAn ?? null;
}

/**
 * Darf `komponenteId` (Rolle `eigeneRolle`, Anlage `eigeneAnlage`) an `eltern`
 * hängen? Reihenfolge (Vertrag R6): `wurzel_haengt_nirgends` → `selbst` →
 * `fremde_anlage` → `eltern_kein_zaehler` → `zyklus`. `eltern = null` (die
 * Wurzel) ist immer gültig - das ist die Vorgabe des Berichts: was nicht
 * ausdrücklich woanders hängt, hängt an der Wurzel.
 *
 * @param baum der heute aktive Baum der Anlage (jede Komponente mit einer
 *   eigenen Zeile), für den Zyklus-Test; eine Komponente ohne Zeile hängt an
 *   der Wurzel.
 */
export function haengtAnPruefen(
  komponenteId: string,
  eigeneAnlage: string,
  eigeneRolle: string | null,
  eltern: ElternKandidat | null,
  baum: Zuordnung[],
): HaengtAnUrteil {
  if (eltern === null) return GUELTIG;
  if (eigeneRolle === ROLLE_NETZ) return ungueltig('wurzel_haengt_nirgends');
  if (eltern.id === komponenteId) return ungueltig('selbst');
  if (eltern.anlage !== eigeneAnlage) return ungueltig('fremde_anlage');
  const elternIstZaehler = eltern.rolle === ROLLE_NETZ || eltern.entityType === TYP_UNTERZAEHLER;
  if (!elternIstZaehler) return ungueltig('eltern_kein_zaehler');
  const kette = [komponenteId];
  const gesehen = new Set<string>();
  for (let cur: string | null = eltern.id; cur !== null && !gesehen.has(cur); ) {
    gesehen.add(cur);
    kette.push(cur);
    if (cur === komponenteId) return ungueltig('zyklus', [...kette]);
    cur = haengtAnVon(baum, cur);
  }
  return GUELTIG;
}
