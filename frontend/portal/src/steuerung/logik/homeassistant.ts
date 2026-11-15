/**
 * Aus Home Assistant übernehmen (Steuerlogik Stufe 6, E8 = A): die Dateien einer Anlage von Home Assistant werden
 * eine Logik der Textform. Übersetzt, vorgeschlagen und geprüft wird im Logik-Dienst; dieses Modul liest nur die
 * Dateien im Browser und bringt seine Antwort in Sätze. Die Dateien verlassen den Browser nur zum Übersetzen, sie
 * werden nirgends gespeichert.
 */
import type { HaDatei, HaKandidat, HaLuecke, HaOrt, LogikAusHomeAssistant } from '../../api';
import type { VpOption } from '../../picker/optionen';

/** Wie der Dienst: höchstens so viele Dateien, zusammen höchstens so groß. */
export const MAX_DATEIEN = 8;
export const MAX_BYTES = 1024 * 1024;

/** Was eine Anlage von Home Assistant für eine Logik mitbringt. */
export const ERWARTETE_DATEIEN = ['configuration.yaml', 'automations.yaml', 'scripts.yaml'];

export interface Gelesen {
  dateien: HaDatei[];
  fehler: string | null;
}

/** Liest die gewählten Dateien als Text; nur YAML, höchstens MAX_DATEIEN und MAX_BYTES zusammen. */
export async function liesDateien(dateien: readonly Pick<File, 'name' | 'size' | 'text'>[]): Promise<Gelesen> {
  if (!dateien.length) return { dateien: [], fehler: 'Bitte mindestens eine Datei wählen.' };
  if (dateien.length > MAX_DATEIEN) return { dateien: [], fehler: `Höchstens ${MAX_DATEIEN} Dateien auf einmal.` };
  const fremd = dateien.find((d) => !/\.ya?ml$/i.test(d.name));
  if (fremd) return { dateien: [], fehler: `„${fremd.name}“ ist keine YAML-Datei.` };
  const groesse = dateien.reduce((s, d) => s + d.size, 0);
  if (groesse > MAX_BYTES) return { dateien: [], fehler: 'Die Dateien sind zusammen größer als 1 MB.' };
  const gelesen = await Promise.all(dateien.map(async (d) => ({ name: d.name, text: await d.text() })));
  return { dateien: gelesen, fehler: null };
}

/** „automations.yaml, Zeile 7“. */
export function ortText(o: HaOrt): string {
  return o.zeile > 0 ? `${o.datei}, Zeile ${o.zeile}` : o.datei;
}

const GROESSE: Record<string, string> = {
  temperatur: 'Temperatur', leistung: 'Leistung', prozent: 'Prozent', winkel: 'Winkel', ja_nein: 'Ja oder Nein',
};

/** Was die Lücke in der Logik ist, für die Zeile unter ihrem Namen. */
export function lueckeArt(l: HaLuecke): string {
  if (l.art === 'geraet') {
    const n = l.ausgaenge ?? l.entities.length;
    return l.ausgang === 'level' ? `Gerät mit ${n} Ausgängen, geschaltet in Stufen` : 'Gerät, ein und aus';
  }
  if (!l.groesse) return 'Messwert; ob Temperatur, Leistung oder Prozent, steht in keiner Datei';
  return `Messwert: ${GROESSE[l.groesse] ?? l.groesse}${l.groesse_geschaetzt ? ' (aus dem Namen geschätzt)' : ''}`;
}

/** Die Frage zu einer Leistung: das Vorzeichen der Box ist fest, das von Home Assistant nicht. */
export function lueckeFrage(l: HaLuecke): string | null {
  if (l.art === 'eingang' && l.groesse === 'leistung') return 'Was zählt Home Assistant hier positiv?';
  return null;
}

export function optionen(l: HaLuecke): VpOption[] {
  return l.kandidaten.map((k: HaKandidat) => ({ value: k.wert, label: k.name, sub: k.hinweis ?? null }));
}

/** Lücken, die noch keinem Gerät oder Eingang der Anlage zugeordnet sind (oder deren Zuordnung nicht passt). */
export function offen(e: LogikAusHomeAssistant): HaLuecke[] {
  return e.luecken.filter((l) => !l.wert || !!l.fehler);
}

/** Ein Satz zum Stand der Übersetzung, für den Kopf des Blatts. */
export function stand(e: LogikAusHomeAssistant): { satz: string; art: 'fehler' | 'warten' | 'ok' } {
  const n = e.nicht_uebersetzt.length;
  if (n) return { satz: n === 1 ? 'Eine Stelle lässt sich nicht übersetzen.' : `${n} Stellen lassen sich nicht übersetzen.`, art: 'fehler' };
  const o = offen(e).length;
  if (o) return { satz: o === 1 ? 'Noch eine Lücke zuordnen.' : `Noch ${o} Lücken zuordnen.`, art: 'warten' };
  const fehler = (e.bericht?.meldungen ?? []).filter((m) => m.art !== 'hinweis').length;
  if (e.bericht?.sperrt) return { satz: fehler === 1 ? 'Die Prüfung findet einen Fehler.' : `Die Prüfung findet ${fehler} Fehler.`, art: 'fehler' };
  return { satz: 'Übersetzt und geprüft. Sie können die Logik übernehmen.', art: 'ok' };
}

/** Die Notiz an der Fassung, die aus der Übersetzung entsteht. */
export function notiz(e: LogikAusHomeAssistant): string {
  return `Aus Home Assistant übersetzt (${e.dateien.join(', ')})`;
}

/** Fehlt eine der Dateien, aus denen eine Logik meist entsteht? */
export function fehlendeDateien(e: LogikAusHomeAssistant): string[] {
  return ERWARTETE_DATEIEN.filter((d) => !e.dateien.some((x) => x.toLowerCase().startsWith(d.replace('.yaml', ''))));
}

/** Die Hinweise als Meldungen an ihrer Zeile im übersetzten Text (für die Vorschau). */
export function hinweisMeldungen(e: LogikAusHomeAssistant) {
  return [
    ...e.hinweise.filter((h) => h.zeile).map((h) => ({ art: 'hinweis' as const, text: h.text, zeile: h.zeile })),
    ...(e.bericht?.meldungen ?? []).filter((m) => m.art !== 'hinweis'),
  ];
}
