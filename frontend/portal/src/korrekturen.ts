/** AP-08 IP-16: Methoden und Anzeige aus gelieferten Fakten; keine eigene Verbrauchsrechnung. */
import type { ErsatzwertEingabe, ErsatzwertLuecke, ErsatzwertMethode, KorrekturAktion, KorrekturPeriode, MessstelleQuelle } from './api';
import { METHODE_TEXT, zahlText } from './uemsEreignis';
import { ablesestandWert } from './zahl';
import { wechselZeit } from './zaehlerwechsel';
import { teile } from './uemsZustand';

export const STATUS: Record<string, string> = { vorschlag: 'Wartet auf Prüfung', freigegeben: 'Freigegeben', abgelehnt: 'Abgelehnt', zurueckgenommen: 'Zurückgenommen' };
export const PERIODEN: Record<string, string> = { viertelstunde: 'Viertelstunde', tag: 'Tag', monat: 'Monat', jahr: 'Jahr', ablesung: 'Ablesestand' };
export function methoden(luecke: ErsatzwertLuecke | null, vergleich: boolean): ErsatzwertMethode[] {
  if (luecke?.art === 'counter_reset' || luecke?.art === 'device_boundary') return ['ablesestand_nachtragen'];
  if (luecke?.zuwachs != null) return ['gleichmaessig_verteilen', 'profil_vorperiode', ...(vergleich ? ['profil_vergleichsquelle' as const] : [])];
  return ['wert_eingeben', 'vorperiode_uebernehmen', ...(vergleich ? ['vergleichsquelle_uebernehmen' as const] : [])];
}
export const methodenName = (m: string) => METHODE_TEXT[m] ?? 'Ersatzwert';
export const quelleDeckt = (q: MessstelleQuelle, von: string, bis: string) =>
  Date.parse(q.gueltig_ab) <= Date.parse(von) && (!q.gueltig_bis || Date.parse(q.gueltig_bis) >= Date.parse(bis));
export function datumZeit(zeit: string, zone: string) {
  const t = teile(zeit, zone); const [tag, monat, jahr] = t.tag.split('.');
  return { datum: `${jahr}-${monat}-${tag}`, zeit: `${t.stunde}:${t.minute}` };
}
export function lueckenZeitraum(l: ErsatzwertLuecke) {
  if (l.art === 'data_gap') return { von: new Date(Math.floor(Date.parse(l.von) / 900_000) * 900_000).toISOString(),
    bis: l.bis ? new Date(Math.ceil(Date.parse(l.bis) / 900_000) * 900_000).toISOString() : null };
  const anfang = Math.floor((Date.parse(l.von) - 1) / 900_000) * 900_000;
  return { von: new Date(anfang).toISOString(), bis: new Date(anfang + 900_000).toISOString() };
}
export interface ErsatzForm {
  methode: ErsatzwertMethode; vonTag: string; vonZeit: string; bisTag: string; bisZeit: string;
  vorTag: string; vorZeit: string; zeitTag: string; zeitZeit: string;
  vergleich: string; endstand: string; anfangsstand: string; betrag: string; grund: string; beleg: string;
}
export function formAus(von: string, bis: string, zone: string): ErsatzForm {
  const v = datumZeit(von, zone), b = datumZeit(bis, zone);
  const alt = new Date(`${v.datum}T12:00:00Z`); alt.setUTCDate(alt.getUTCDate() - 7);
  return { methode: 'wert_eingeben', vonTag: v.datum, vonZeit: v.zeit, bisTag: b.datum, bisZeit: b.zeit,
    vorTag: alt.toISOString().slice(0, 10), vorZeit: v.zeit, zeitTag: v.datum, zeitZeit: v.zeit,
    vergleich: '', endstand: '', anfangsstand: '', betrag: '', grund: '', beleg: '' };
}
export function ersatzAnfrage(f: ErsatzForm, quelle: MessstelleQuelle, luecke: ErsatzwertLuecke | null, zone: string, einheit: string,
  vergleich: readonly MessstelleQuelle[]): { eingabe: ErsatzwertEingabe } | { feld: keyof ErsatzForm; fehler: string } {
  // Eine gewählte Ereignisgrenze hat bereits einen eindeutigen Zeitpunkt, auch in der doppelten Herbststunde.
  const zeit = (tag: string, uhr: string, bekannt?: string | null) => {
    const t = bekannt ? datumZeit(bekannt, zone) : null;
    return bekannt && t?.datum === tag && t.zeit === uhr ? { iso: bekannt } : wechselZeit(tag, uhr, zone);
  };
  const rahmen = luecke ? lueckenZeitraum(luecke) : null;
  const von = zeit(f.vonTag, f.vonZeit, rahmen?.von), bis = zeit(f.bisTag, f.bisZeit, rahmen?.bis);
  if ('fehler' in von) return { feld: 'vonTag', fehler: von.fehler };
  if ('fehler' in bis) return { feld: 'bisTag', fehler: bis.fehler };
  if (Date.parse(von.iso) >= Date.parse(bis.iso) || [von.iso, bis.iso].some(t => Date.parse(t) % 900_000 !== 0))
    return { feld: 'bisTag', fehler: 'Bitte einen Zeitraum im Viertelstundenraster wählen, dessen Ende nach dem Beginn liegt.' };
  if (!quelleDeckt(quelle, von.iso, bis.iso)) return { feld: 'vonTag', fehler: 'Diese Quelle gilt nicht im ganzen Zeitraum. Bitte Zeitraum oder Quelle ändern.' };
  if (!methoden(luecke, vergleich.length > 0).includes(f.methode)) return { feld: 'methode', fehler: 'Bitte eine passende Methode wählen.' };
  if (f.grund.trim().length < 10 || f.grund.trim().length > 500) return { feld: 'grund', fehler: 'Bitte den Grund mit 10 bis 500 Zeichen angeben.' };
  if (f.beleg.trim() && (f.beleg.trim().length < 10 || f.beleg.trim().length > 500)) return { feld: 'beleg', fehler: 'Bitte den Beleg mit 10 bis 500 Zeichen beschreiben.' };
  const e: ErsatzwertEingabe = { quelle_id: quelle.id, methode: f.methode, von: von.iso, bis: bis.iso, begruendung: f.grund.trim() };
  if (f.beleg.trim()) e.beleg = f.beleg.trim();
  if (['gleichmaessig_verteilen', 'profil_vorperiode', 'profil_vergleichsquelle'].includes(f.methode)) {
    const rahmen = luecke ? lueckenZeitraum(luecke) : null;
    if (!luecke?.bis || !rahmen?.bis || Date.parse(rahmen.von) !== Date.parse(von.iso) || Date.parse(rahmen.bis) !== Date.parse(bis.iso))
      return { feld: 'vonTag', fehler: 'Verteilen umfasst die ganze gewählte Lücke. Bitte die Lücke erneut auswählen.' };
    e.luecke_ereignis_id = luecke.id; e.einheit = einheit;
  }
  if (['profil_vorperiode', 'vorperiode_uebernehmen'].includes(f.methode)) {
    const v = wechselZeit(f.vorTag, f.vorZeit, zone);
    if ('fehler' in v || Date.parse(v.iso) >= Date.parse(von.iso)) return { feld: 'vorTag', fehler: 'Bitte den Beginn der früheren Vergleichsperiode angeben.' };
    e.vorperiode_von = v.iso;
  }
  if (['profil_vergleichsquelle', 'vergleichsquelle_uebernehmen'].includes(f.methode)) {
    if (!vergleich.some(q => q.id === f.vergleich && quelleDeckt(q, von.iso, bis.iso))) return { feld: 'vergleich', fehler: 'Bitte eine für den Zeitraum gültige Vergleichsquelle wählen.' };
    e.vergleich_quelle_id = f.vergleich;
  }
  if (f.methode === 'wert_eingeben') {
    const n = ablesestandWert(f.betrag);
    if (n === null || n < 0) return { feld: 'betrag', fehler: 'Bitte eine gültige Menge ab null eingeben.' };
    if (!e.beleg) return { feld: 'beleg', fehler: 'Für einen eingegebenen Wert ist ein Beleg erforderlich.' };
    e.betrag = n; e.einheit = einheit;
  }
  if (f.methode === 'ablesestand_nachtragen') {
    if (Date.parse(bis.iso) - Date.parse(von.iso) !== 900_000) return { feld: 'bisTag', fehler: 'Ein Ablesestand gehört zu genau einer Viertelstunde.' };
    const t = zeit(f.zeitTag, f.zeitZeit, luecke?.von), ende = ablesestandWert(f.endstand), anfang = ablesestandWert(f.anfangsstand);
    if ('fehler' in t || Date.parse(t.iso) <= Date.parse(von.iso) || Date.parse(t.iso) > Date.parse(bis.iso))
      return { feld: 'zeitTag', fehler: 'Bitte den Zeitpunkt innerhalb der Viertelstunde angeben.' };
    if (ende === null && anfang === null) return { feld: 'endstand', fehler: 'Bitte mindestens einen Ablesestand angeben.' };
    if ((f.endstand.trim() && ende === null) || (f.anfangsstand.trim() && anfang === null)) return { feld: 'endstand', fehler: 'Bitte gültige Ablesestände eingeben.' };
    e.zeitpunkt = t.iso; e.einheit = einheit;
    if (ende !== null) e.endstand = ende;
    if (anfang !== null) e.anfangsstand = anfang;
  }
  return { eingabe: e };
}
export function aktionsGrund(a: KorrekturAktion): string | null {
  if (a.erlaubt) return null;
  if (a.grund === 'zweite_person_noetig') return 'Freigabe durch eine zweite Person erforderlich. Sie haben diesen Vorschlag erstellt.';
  if (a.grund === 'status_passt_nicht') return 'Dieser Vorgang ist bereits entschieden.';
  return 'Für diese Entscheidung fehlt Ihnen das Recht.';
}
export function periodenZahl(n: number | null | undefined, einheit: string) { return n == null ? 'Keine Werte' : `${zahlText(n)} ${einheit}`; }
export function vorschauBalken(p: readonly KorrekturPeriode[]) {
  const werte = p.filter(x => x.periode === 'viertelstunde');
  const max = Math.max(0, ...werte.map(x => x.neu.menge ?? 0));
  return werte.map(x => ({ von: x.von, menge: x.neu.menge, hoehe: x.neu.menge == null || max === 0 ? 0 : x.neu.menge / max * 80 }));
}
