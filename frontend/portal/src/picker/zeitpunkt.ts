import { iso, zeitpunkt, satz } from '../bezugsPeriode';
export type ZeitpunktEingabe = { tag: string; zeit: string; variante: string | null };
export function ortszeit(wert: string | number, zone: string): ZeitpunktEingabe {
  const lokal = iso(typeof wert === 'number' ? wert : Date.parse(wert), zone);
  return { tag: lokal.slice(0, 10), zeit: lokal.slice(11, 16), variante: lokal };
}
export function zonenName(wert: string, zone: string): string {
  return new Intl.DateTimeFormat('de-DE', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date(wert)).find(p => p.type === 'timeZoneName')?.value ?? zone;
}
/** Z5 ist der Vertragszwilling; eine alte Auswahl darf nie eine neue Ortszeit freigeben. */
export function lesen(e: ZeitpunktEingabe, zone: string): { wert: string | null; fehler: string | null; varianten: { value: string; label: string }[] } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.tag) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(e.zeit)
      || !Number.isFinite(Date.parse(`${e.tag}T00:00:00Z`)) || new Date(`${e.tag}T00:00:00Z`).toISOString().slice(0, 10) !== e.tag)
    return { wert: null, fehler: 'Bitte geben Sie Datum und Uhrzeit an.', varianten: [] };
  const z = zeitpunkt(`${e.tag}T${e.zeit}`, zone, null);
  const varianten = z.varianten.map(value => ({ value, label: `${zonenName(value, zone)} (UTC${value.slice(-6)})` }));
  const wert = z.zeitpunkt !== null ? iso(z.zeitpunkt, zone) : z.varianten.includes(e.variante ?? '') ? e.variante : null;
  return { wert, fehler: wert ? null : z.befund ? satz(z.befund) : null, varianten };
}
