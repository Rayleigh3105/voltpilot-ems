/** AP-04 IP-18: Eingaben prüfen, gespeicherte Fakten sprechen; keine Verbrauchsrechnung. */
import type { Messkanal, MessstelleQuelleStand, UemsGeraet, Zaehlerwechsel, ZaehlerwechselVorgang } from './api';
import { parseDecimal } from './anlageFlow';
import { iso, zeitpunkteVon } from './bezugsPeriode';
import { ZEIT_SAETZE } from './geraetEinstellungen';
import { ereignisSatz, zeitText, zahlText } from './uemsEreignis';
import { rueckwirkung } from './uemsMessstelle';
import { teile } from './uemsZustand';

export type WechselZiel = { art: 'messstelle'; id: string; kennzeichen: string; geraetId: string; anlageId: string }
  | { art: 'geraet'; geraet: UemsGeraet; anlageId: string };
export interface WechselEingabe {
  datum: string; uhrzeit: string; kennzeichen: string; seriennummer: string;
  gleichesModell: boolean; hersteller: string; typ: string;
  gleicheVerbindung: boolean; datenquelle: string; geraeteId: string;
  endstand: string; anfangsstand: string; uebernehmen: boolean; grund: string;
}
export function wechselEingabe(jetzt: string, zone: string): WechselEingabe {
  const t = teile(jetzt, zone);
  const [tag, monat, jahr] = t.tag.split('.');
  return { datum: `${jahr}-${monat}-${tag}`, uhrzeit: `${t.stunde}:${t.minute}`, kennzeichen: '', seriennummer: '',
    gleichesModell: true, hersteller: '', typ: '', gleicheVerbindung: true, datenquelle: '', geraeteId: '',
    endstand: '', anfangsstand: '', uebernehmen: true, grund: '' };
}
export function wechselZeit(datum: string, uhrzeit: string, zone: string): { iso: string } | { fehler: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) return { fehler: ZEIT_SAETZE.datum_fehlt };
  if (!/^\d{2}:\d{2}$/.test(uhrzeit)) return { fehler: ZEIT_SAETZE.uhrzeit_fehlt };
  const gefunden = zeitpunkteVon(`${datum}T${uhrzeit}:00`, zone);
  if (!gefunden.length) return { fehler: ZEIT_SAETZE.nicht_vorhanden };
  if (gefunden.length > 1) return { fehler: ZEIT_SAETZE.zweimal };
  return { iso: iso(gefunden[0], zone) };
}
/** Nur genau EIN führender Zählerstand kann die beiden Ablesestände tragen (IP-17). */
export function ableseEinheit(kanaele: readonly Messkanal[]): string | null {
  const fuehrend = kanaele.filter(k => k.wertart === 'counter').flatMap(k =>
    (k.speist ?? []).filter(s => s.rolle === 'fuehrend').map(() => k.einheit));
  return fuehrend.length === 1 ? fuehrend[0] : null;
}
/** Übergabe an AP-09 IP-10 (zahl.ts): Gruppierung nur hier, Dezimalteil über parseDecimal. */
export function ablesestandWert(text: string): number | null {
  const wert = text.trim();
  return parseDecimal(/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(wert) ? wert.replace(/\./g, '') : wert);
}
export function wechselPruefen(e: WechselEingabe, zone: string, einheit: string | null) {
  const fehler: Partial<Record<keyof WechselEingabe, string>> = {};
  const zeit = wechselZeit(e.datum, e.uhrzeit, zone);
  if ('fehler' in zeit) fehler.datum = zeit.fehler;
  if (e.kennzeichen.trim() && !/^[A-Za-z0-9][A-Za-z0-9._/′-]{0,31}$/.test(e.kennzeichen.trim())) fehler.kennzeichen = 'Bitte verwenden Sie 1–32 Zeichen, beginnend mit einem Buchstaben oder einer Ziffer; erlaubt sind außerdem Punkt, Unterstrich, Schrägstrich, Bindestrich und ′.';
  if (!e.gleichesModell && !e.hersteller.trim()) fehler.hersteller = 'Bitte geben Sie den Hersteller an.';
  if (!e.gleichesModell && !e.typ.trim()) fehler.typ = 'Bitte geben Sie den Typ an.';
  const geraeteId = e.geraeteId.trim() ? Number(e.geraeteId) : null;
  if (!e.gleicheVerbindung && geraeteId !== null && (!Number.isInteger(geraeteId) || geraeteId < 0)) fehler.geraeteId = 'Bitte geben Sie eine ganze Geräte-ID ab 0 an.';
  for (const f of ['endstand', 'anfangsstand'] as const) {
    if (e[f].trim() && (ablesestandWert(e[f]) === null || ablesestandWert(e[f])! < 0)) fehler[f] = 'Bitte geben Sie einen Zählerstand ab 0 an.';
    if (e[f].trim() && !einheit) fehler[f] = 'Ablesestände lassen sich hier keinem einzelnen Zählwerk zuordnen.';
  }
  const body: Zaehlerwechsel | null = Object.keys(fehler).length || !('iso' in zeit) ? null : {
    zeitpunkt: zeit.iso,
    neues_geraet: { einbau_kennzeichen: e.kennzeichen.trim() || null, seriennummer: e.seriennummer.trim() || null,
      ...(e.gleichesModell ? {} : { hersteller: e.hersteller.trim(), typ: e.typ.trim() }) },
    ...(e.gleicheVerbindung ? {} : { verbindung: { datenquelle: e.datenquelle || null, geraete_id: geraeteId } }),
    endstand_vorgaenger: e.endstand.trim() ? { wert: ablesestandWert(e.endstand)!, einheit } : null,
    anfangsstand: e.anfangsstand.trim() ? { wert: ablesestandWert(e.anfangsstand)!, einheit } : null,
    einstellungen_uebernehmen: e.uebernehmen, grund: e.grund.trim() || null,
  };
  return { fehler, body };
}
export function wechselAbzeichen(zeitpunkt: string, jetzt: string) {
  const r = rueckwirkung(jetzt, zeitpunkt);
  return r.art === 'angekuendigt' ? 'angekündigt' : r.abzeichen;
}
export function standText(stand: MessstelleQuelleStand | null): string | null {
  return stand?.wert == null ? null : `${zahlText(stand.wert)}${stand.einheit ? ` ${stand.einheit}` : ' (Einheit nicht erfasst)'}`;
}
/** Die bestätigte Folgen-Karte benutzt ausschließlich die Antwort des Schreibvorgangs. */
export function wechselFolgen(v: ZaehlerwechselVorgang, zone: string): string[] {
  const { alt, neu } = v.geraet;
  const saetze = [ereignisSatz({ art: 'device_boundary', anlass: 'zaehlerwechsel', zeitpunkt: neu.eingebaut_am,
    einbau_alt: alt.einbau, einbau_neu: neu.einbau }, {}, zone)];
  if (alt.ausgebaut_am) saetze.push(`${alt.einbau}: ausgebaut am ${zeitText(alt.ausgebaut_am, zone)}.`);
  saetze.push(`${neu.einbau}: eingebaut am ${zeitText(neu.eingebaut_am, zone)}.`);
  for (const b of v.bindungen) {
    saetze.push(`${b.kennzeichen} · ${b.groesse} · ${b.richtung}: ${b.rolle === 'fuehrend' ? 'führende Quelle' : 'Vergleichsquelle'} ${b.neu.geraet.einbau ?? neu.einbau} ab ${zeitText(b.neu.gueltig_ab, zone)}.`);
    const ende = standText(b.beendet.endstand), anfang = standText(b.neu.anfangsstand);
    if (ende !== null) saetze.push(`${alt.einbau}: Endstand ${ende}.`);
    if (anfang !== null) saetze.push(`${neu.einbau}: Anfangsstand ${anfang}.`);
  }
  if (v.rueckwirkung.abzeichen) saetze.push(`Eintrag: ${v.rueckwirkung.abzeichen}.`);
  else if (v.rueckwirkung.art === 'angekuendigt') saetze.push('Eintrag: angekündigt.');
  if (v.geraet.verbindung_neu) saetze.push('Die Verbindung wurde geändert.');
  if (v.einstellungen.length) saetze.push('Die Einstellungen wurden übernommen.');
  if (v.marken > 0) saetze.push('Der Zählerwechsel ist im Komponenten-Verlauf vermerkt.');
  if (v.marken < v.komponenten.length) saetze.push('Die Marke konnte nicht in allen Komponenten-Verläufen eingetragen werden. Der Zählerwechsel ist gespeichert.');
  if (v.hinweise.includes('ablesestand_pruefen')) saetze.push('Bitte prüfen Sie die Einheit der Ablesestände.');
  return saetze;
}

/** Übersetzt ausschließlich device_replaced aus dem bestehenden Komponenten-Ereignispfad. */
export function wechselMarken(ereignisse: readonly import('./api').KomponentenEreignis[], zone: string): string[] {
  return [...new Set(ereignisse.filter(e => e.eventType === 'device_replaced' && e.fromValue && e.toValue)
    .map(e => ereignisSatz({ art: 'device_boundary', anlass: 'zaehlerwechsel', zeitpunkt: e.effectiveAt,
      einbau_alt: e.fromValue, einbau_neu: e.toValue }, {}, zone)))];
}
