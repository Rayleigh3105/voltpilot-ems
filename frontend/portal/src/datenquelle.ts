import {
  deviceLiveStatus,
  type DatenquelleBudgetBox,
  type Device,
  type EdgeVersion,
} from './api';

export interface DatenquelleBoxZeile {
  id: string;
  name: string;
  verbunden: 'Verbunden' | 'Meldet sich nicht' | 'Wartet auf erste Meldung';
  software: string;
  budget: string;
}

const zahl = (wert: number): string => wert.toLocaleString('de-DE', { maximumFractionDigits: 3 });

export function budgetFreiText(budget: DatenquelleBudgetBox | null | undefined): string {
  if (!budget) return 'Freies Lesebudget: wird beim Einrichten geprüft';
  return `Frei: ${zahl(budget.frei.samples_per_minute)} Messwerte/min · ${zahl(budget.frei.requests_per_minute)} Anfragen/min · ${zahl(budget.frei.duty_cycle_percent)} % Buszeit`;
}

export function datenquelleBoxen(
  geraete: readonly Device[],
  versionen: readonly EdgeVersion[],
  anlagenAmStandort: readonly string[],
  budgets: readonly DatenquelleBudgetBox[] = [],
  jetzt = new Date(),
): DatenquelleBoxZeile[] {
  const anlagen = new Set(anlagenAmStandort);
  const versionJeBox = new Map(versionen.map((v) => [v.deviceId, v]));
  const budgetJeBox = new Map(budgets.map((b) => [b.id, b]));
  return geraete
    .filter((g) => g.kind === 'edge' && anlagen.has(g.siteId))
    .map((g): DatenquelleBoxZeile => {
      const status = deviceLiveStatus(g, jetzt);
      const version = versionJeBox.get(g.id);
      return {
        id: g.id,
        name: g.name?.trim() || g.externalRef,
        verbunden: status === 'online' ? 'Verbunden' : status === 'stale' ? 'Meldet sich nicht' : 'Wartet auf erste Meldung',
        software: version?.coreVersion ? `Software ${version.coreVersion}` : 'Software-Stand unbekannt',
        budget: budgetFreiText(budgetJeBox.get(g.id)),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

export function pruefungText(ergebnis: { ergebnis: string; text: string; dauer_ms: number }): string {
  const klasse: Record<string, string> = {
    ok: 'Erreichbar',
    unreachable: 'Nicht erreichbar',
    no_answer: 'Zeitüberschreitung',
    invalid_response: 'Gerät meldet Fehler',
    implausible: 'Werte unplausibel',
    timeout: 'Kein Ergebnis',
    box_meldet_sich_nicht: 'Box meldet sich nicht',
  };
  return `${klasse[ergebnis.ergebnis] ?? ergebnis.ergebnis} · ${zahl(ergebnis.dauer_ms)} ms — ${ergebnis.text}`;
}

export function folgenSaetze(anlage: string, box: string | null): string[] {
  return [
    `Die Datenquelle gehört zur Anlage ${anlage}.`,
    box ? `${box} liest sie erst nach einer erfolgreichen Prüfung.` : 'Wählen Sie die Box, die diese Datenquelle erreichen kann.',
    'Vorhandene Datenquellen und Messwerte bleiben unverändert.',
    'Liegt die Quelle in einem anderen Netz, brauchen Sie eine Box dort oder eine Route der Kunden-IT.',
  ];
}
