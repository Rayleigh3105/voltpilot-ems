import type { BezugsdatenImportProtokollEintrag, BezugsdatenRuecknahmeVorschau, BezugsdatenVorschau } from './api';

export type KonfliktEntscheidung = 'behalten' | 'ersetzen';

export function doppelimportBanner(v: BezugsdatenVorschau) {
  const befund = [v.datei.befund, ...v.import.befunde].find((b) => b?.befund === 'datei_bekannt') ?? null;
  return befund && v.frueherer_import ? { satz: befund.satz, kennung: v.frueherer_import.kennung } : null;
}

export function konfliktAbleitung(v: BezugsdatenVorschau, entscheidungen: Record<number, KonfliktEntscheidung>) {
  const konflikte = v.zeilen.filter((z) => z.urteil === 'konflikt');
  const ersetzen = konflikte.filter((z) => entscheidungen[z.nr] === 'ersetzen').length;
  return {
    konflikte: konflikte.length,
    ersetzen,
    behalten: konflikte.length - ersetzen,
    aenderungen: v.import.aenderungen + ersetzen,
    begruendungNoetig: ersetzen > 0,
  };
}

export const IMPORT_STATUS: Record<string, string> = {
  uebernommen: 'Übernommen', teilweise_uebernommen: 'Teilweise übernommen', wiederholt: 'Wiederholt (0 Änderungen)',
  verworfen: 'Verworfen', zurueckgenommen: 'Zurückgenommen',
};

export function ruecknahmeSaetze(v: BezugsdatenRuecknahmeVorschau): string[] {
  return v.werte.map((w) => {
    const zeit = w.periode_von
      ? new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${w.periode_von}T12:00:00Z`))
      : w.zeitpunkt ? new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(w.zeitpunkt)) : 'ohne Zeitraum';
    const alt = w.bisheriger_betrag === null ? '—' : `${Number(w.bisheriger_betrag).toLocaleString('de-DE', { maximumFractionDigits: 6 })} ${w.einheit}`;
    return w.vorgang === 'vorfassung_wiederhergestellt'
      ? `${w.kennzeichen} · ${zeit}: ${alt} wird durch die Vorfassung ersetzt.`
      : `${w.kennzeichen} · ${zeit}: ${alt} wird zurückgenommen.`;
  });
}

export const kannZuruecknehmen = (i: BezugsdatenImportProtokollEintrag) =>
  i.status !== 'zurueckgenommen' && i.aenderungen > 0;
