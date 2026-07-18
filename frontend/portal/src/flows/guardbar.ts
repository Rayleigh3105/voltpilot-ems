/**
 * Guard-bar derivation (pure): the site's NON-EDITABLE constraints the flow
 * editor always shows - no flow can override them (the mockup's dark strip).
 * Sources are the existing site + optimizer-config surfaces; a value the
 * backend does not carry renders NOTHING (honest, never a fabricated limit).
 */
import { fmtNum } from '../format';

export interface GuardChip {
  key: string;
  text: string;
}

export interface GuardSources {
  netzladenErlaubt?: boolean;
  maxFeedInKw?: number | null;
  leistungspreisEurKw?: number | null;
  socMinPct?: number | null;
  socMaxPct?: number | null;
  backupReserveSocPct?: number | null;
}

export function guardChips(site: GuardSources | null): GuardChip[] {
  if (!site) return [];
  const chips: GuardChip[] = [];
  chips.push({ key: '14a', text: '§ 14a-Limit (beobachtet)' });
  if (site.maxFeedInKw != null) {
    chips.push({
      key: 'feedin',
      text: `Einspeisung ≤ ${fmtNum(site.maxFeedInKw, 'kW', 0)}`,
    });
  }
  if (site.socMinPct != null && site.socMaxPct != null) {
    chips.push({
      key: 'soc',
      text: `SoC ${fmtNum(site.socMinPct, '', 0)}–${fmtNum(site.socMaxPct, '%', 0)}`,
    });
  }
  if (site.backupReserveSocPct != null) {
    chips.push({
      key: 'reserve',
      text: `Notstrom-Reserve ${fmtNum(site.backupReserveSocPct, '%', 0)}`,
    });
  }
  chips.push({
    key: 'netzladen',
    text: site.netzladenErlaubt
      ? 'Netzladen erlaubt'
      : 'EEG: kein Netzladen-Verstoß',
  });
  if (site.leistungspreisEurKw != null) {
    chips.push({
      key: 'peak',
      text: `Leistungspreis ${fmtNum(site.leistungspreisEurKw, '€/kW', 0)}`,
    });
  }
  return chips;
}
