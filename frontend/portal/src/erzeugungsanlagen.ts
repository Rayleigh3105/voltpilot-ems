/**
 * Erzeugungsanlagen (Messkonzepte S1, NUR ANZEIGE) - rein, ohne React.
 *
 * Eine Erzeugungsanlage (EA) ist eine Anlage im Sinn ihrer Förderung: eigene
 * Inbetriebnahme, eigene Leistung, eigener Satz, eigenes Förderende. Sie heißt
 * im Portal immer mit Nummer oder Namen („EA 1“, „EA 2 · PV Scheune“) - nie
 * „Anlage“ allein (Captain-Entscheid F2), damit sie nicht mit der Anlage
 * (dem elektrischen System mit Box und Fahrplan) verwechselt wird.
 *
 * **Hier wird nichts gerechnet.** Satz, Herkunft, Förderende und die Lage bei
 * negativen Preisen liefert der Server je EA
 * (`GET /api/v1/sites/{id}/erzeugungsanlagen`) aus demselben Satzplan wie die
 * Karte „Einspeisevergütung“; die Wörter der Zeile kommen aus
 * `einspeiseverguetung.ts`, damit EA und Karte nie verschieden sprechen.
 *
 * **Einfach bleibt einfach:** Mit einer EA zeigt „Strom & Geld“ die Karte wie
 * bisher; die Liste je EA erscheint erst ab der zweiten ({@link mehrere}).
 * Fahrplan und Erlöse rechnen bis auf Weiteres mit dem einen Satz der Anlage -
 * die Liste sagt das dazu ({@link nurAnzeigeHinweis}).
 */
import type {
  Einspeiseart,
  Einspeiseverguetung,
  Erzeugungsanlage,
  ErzeugungsanlageArt,
  Erzeugungsanlagen,
  ErzeugungsanlageVorschlag,
  VerguetungNaeherung,
} from './api';
import { satzText, tagText, verguetungZeile } from './einspeiseverguetung';
import { fmtNum } from './format';
import { zahl } from './zahl';

export const TITEL = 'Erzeugungsanlagen';
export const HINZUFUEGEN = 'Erzeugungsanlage hinzufügen';
export const RECHT = 'geraet.einrichten';
export const NICHT_ABRUFBAR = 'Die Erzeugungsanlagen konnten nicht geladen werden.';
export const NICHT_ERHOBEN = 'nicht erhoben';
/** Der leise Einstieg im Blatt „Einspeisevergütung“ einer Anlage mit einer EA - kein Messkonzept, keine Liste. */
export const WEITERE_EINSTIEG = 'Weitere Erzeugungsanlage mit eigener Inbetriebnahme hinzufügen';

/** Die Art einer EA in Kundenworten. */
export const ART: Record<ErzeugungsanlageArt, string> = {
  pv: 'Photovoltaik',
  wind: 'Wind',
  wasser: 'Wasserkraft',
  biomasse: 'Biomasse',
  kwk: 'KWK (z. B. BHKW)',
  sonstige: 'Sonstige',
};

export const EINSPEISEART: Record<Einspeiseart, string> = {
  ueberschuss: 'Überschusseinspeisung',
  voll: 'Volleinspeisung',
};

/** Warum ein hergeleiteter Satz nur genähert ist - je ein kurzer Satz. */
export const NAEHERUNG: Record<VerguetungNaeherung, string> = {
  vor_erstem_band:
    'Inbetriebnahme vor 2012: der Satzplan kennt diese Jahre nicht und nimmt den ersten Satz von 2012 - ein Näherungswert.',
  jahresstufen: 'Vor dem 30.07.2022 rechnet der Satzplan mit Jahresstufen - ein Näherungswert.',
  volleinspeisung:
    'Der Satzplan kennt nur Überschusseinspeisung. Für Volleinspeisung tragen Sie den Satz aus Ihrer Abrechnung ein.',
  leistung_unbekannt: 'Ohne Leistung rechnet der Satzplan mit dem Satz bis 10 kWp.',
};

/** Ab der zweiten EA zeigt „Strom & Geld“ die Liste je EA; mit einer bleibt die Karte, wie sie war. */
export function mehrere(liste: Erzeugungsanlagen | null): boolean {
  return (liste?.erzeugungsanlagen.length ?? 0) >= 2;
}

/**
 * Wert und Herkunft des Satzes einer EA - dieselben Wörter wie die Karte
 * („7,94 ct/kWh · hergeleitet aus EEG, Inbetriebnahme 01.06.2025“).
 */
export function satzZeile(ea: Erzeugungsanlage): { wert: string; sub: string; warn: boolean } {
  const v = ea.verguetung;
  const alsKarte: Einspeiseverguetung = {
    zustand: v.zustand,
    wirksamCtKwh: v.wirksamCtKwh,
    angegebenCtKwh: v.angegebenCtKwh,
    inbetriebnahmeAbSolarspitzengesetz: ea.inbetriebnahmeAbSolarspitzengesetz,
    hergeleitetCtKwh: v.hergeleitetCtKwh,
    hergeleitetGenaehert: v.naeherung.includes('jahresstufen') || v.naeherung.includes('vor_erstem_band'),
    inbetriebnahme: ea.inbetriebnahme,
    leistungKwp: ea.fassung?.leistungKwp ?? null,
    eegEndeAm: v.foerderendeAm,
    ohneVerguetungBeiNegativpreis: v.ohneVerguetungBeiNegativpreis,
    anzulegenderWertCtKwh: null,
  };
  return verguetungZeile(alsKarte);
}

/** „Inbetriebnahme 14.04.2009 · 30,0 kWp · Volleinspeisung · Förderende 31.12.2029“. */
export function eckdaten(ea: Erzeugungsanlage): string {
  const teile = [
    ea.inbetriebnahme ? `Inbetriebnahme ${tagText(ea.inbetriebnahme)}` : `Inbetriebnahme ${NICHT_ERHOBEN}`,
    ea.fassung?.leistungKwp != null ? fmtNum(ea.fassung.leistungKwp, 'kWp', 1) : `Leistung ${NICHT_ERHOBEN}`,
  ];
  if (ea.fassung?.einspeiseart) teile.push(EINSPEISEART[ea.fassung.einspeiseart]);
  if (ea.verguetung.foerderendeAm) teile.push(`Förderende ${tagText(ea.verguetung.foerderendeAm)}`);
  return teile.join(' · ');
}

/** Kurze Hinweise unter einer EA: die Lage bei negativen Preisen und warum ein Satz genähert ist. */
export function hinweise(ea: Erzeugungsanlage): string[] {
  const aus: string[] = [];
  const v = ea.verguetung;
  if (v.ohneVerguetungBeiNegativpreis && (v.zustand === 'eeg' || v.zustand === 'angegeben')) {
    aus.push('Bei negativem Börsenpreis keine Vergütung (§ 51a EEG).');
  }
  if (v.hergeleitetCtKwh != null && v.zustand === 'eeg') {
    for (const n of v.naeherung) aus.push(NAEHERUNG[n]);
  }
  return aus;
}

/** Die Zeile „Einspeisevergütung“ unter „Strom & Geld“ mit mehreren EA: „2 Erzeugungsanlagen“ und je EA ihr Satz. */
export function mehrereZeile(liste: Erzeugungsanlagen): { wert: string; sub: string } {
  const n = liste.erzeugungsanlagen.length;
  return {
    wert: `${n} Erzeugungsanlagen`,
    sub: liste.erzeugungsanlagen.map((ea) => `EA ${ea.nummer}: ${satzZeile(ea).wert}`).join(' · '),
  };
}

/**
 * Was Fahrplan und Erlöse heute tatsächlich rechnen - der eine Satz der
 * Anlage. Ehrlich dazu, solange die Sätze je EA nur angezeigt werden.
 */
export function nurAnzeigeHinweis(anlage: Einspeiseverguetung | null): string {
  if (!anlage) {
    return 'Fahrplan und Erlöse rechnen bis auf Weiteres mit einem Satz für die ganze Anlage - die Sätze je Erzeugungsanlage sind hier nur angezeigt.';
  }
  const z = verguetungZeile(anlage);
  return `Fahrplan und Erlöse rechnen bis auf Weiteres mit einem Satz für die ganze Anlage: ${z.wert} (${z.sub}). Die Sätze je Erzeugungsanlage sind hier nur angezeigt.`;
}

/** „„WR Garage“ (5,0 kWp) speist noch keine Erzeugungsanlage.“ */
export function vorschlagText(v: ErzeugungsanlageVorschlag): string {
  const name = v.name ? `„${v.name}“` : 'Ein weiterer Erzeuger';
  return `${name} (${fmtNum(v.leistungKwp, 'kWp', 1)}) speist noch keine Erzeugungsanlage.`;
}

/** Folgt EA 1 der Anlage, kommen diese Angaben aus ihr - das sagt die EA dazu. */
export const FOLGT_ANLAGE =
  'Solange sie die einzige Erzeugungsanlage ist, übernimmt EA 1 Leistung, Inbetriebnahme, MaStR-Nummer und eigenen Satz aus Ihrer Anlage („Registrierung (MaStR)“ und „Einspeisevergütung“).';

// ------------------------------------------------------------------------------------------ Eingabe

export interface Entwurf {
  name: string;
  art: ErzeugungsanlageArt;
  /** ISO-Tag oder leer. */
  inbetriebnahme: string;
  leistung: string;
  einspeiseart: Einspeiseart | '';
  satz: string;
  see: string;
}

export const LEER: Entwurf = {
  name: '',
  art: 'pv',
  inbetriebnahme: '',
  leistung: '',
  einspeiseart: '',
  satz: '',
  see: '',
};

export function entwurfAus(ea: Erzeugungsanlage): Entwurf {
  return {
    name: ea.name ?? '',
    art: ea.art,
    inbetriebnahme: ea.inbetriebnahme ?? '',
    leistung: ea.fassung?.leistungKwp != null ? String(ea.fassung.leistungKwp).replace('.', ',') : '',
    einspeiseart: ea.fassung?.einspeiseart ?? '',
    satz: ea.fassung?.satzAngegebenCtKwh != null ? String(ea.fassung.satzAngegebenCtKwh).replace('.', ',') : '',
    see: ea.registryUnitId ?? '',
  };
}

export interface Pruefung {
  feld: 'name' | 'leistung' | 'satz' | 'see' | 'inbetriebnahme';
  text: string;
}

/** Die getippte Leistung: leer = nicht erhoben (null), ungültig = undefined. */
export function leistungAus(text: string): number | null | undefined {
  if (text.trim() === '') return null;
  const v = zahl(text);
  return v != null && v > 0 ? v : undefined;
}

/** Der getippte Satz in ct/kWh: leer = keiner (null), ungültig = undefined; 0 ist eine Angabe. */
export function satzAus(text: string): number | null | undefined {
  if (text.trim() === '') return null;
  const v = zahl(text);
  return v != null && v >= 0 && v <= 100 ? v : undefined;
}

/** Die SEE-Nummer ohne Leerzeichen, groß; leer = keine. */
export function seeAus(text: string): string | null {
  const s = text.replace(/\s+/g, '').toUpperCase();
  return s === '' ? null : s;
}

/** Prüft den Entwurf wie der Server - der Server bleibt maßgeblich. Die erste Abweichung zuerst. */
export function pruefe(e: Entwurf, heute: string): Pruefung | null {
  if (e.name.trim().length > 80) return { feld: 'name', text: 'Der Name darf höchstens 80 Zeichen lang sein.' };
  if (e.inbetriebnahme && e.inbetriebnahme > heute)
    return { feld: 'inbetriebnahme', text: 'Die Inbetriebnahme liegt in der Zukunft.' };
  if (leistungAus(e.leistung) === undefined)
    return { feld: 'leistung', text: 'Bitte geben Sie die Leistung als Zahl über 0 an, z. B. 9,8.' };
  if (satzAus(e.satz) === undefined)
    return { feld: 'satz', text: 'Bitte geben Sie den Satz als Zahl in ct/kWh zwischen 0 und 100 an, z. B. 8,2.' };
  const see = seeAus(e.see);
  if (see && !/^SEE\d{12}$/.test(see))
    return { feld: 'see', text: 'Die MaStR-Nummer beginnt mit SEE und hat danach 12 Ziffern.' };
  return null;
}

/** „Satz: 9,50 ct/kWh“ für eine Fassung in der Zeitleiste; „von Inbetriebnahme an“ ohne Tag. */
export function fassungText(f: Erzeugungsanlage['fassungen'][number]): string {
  const ab = f.gueltigAb ? `ab ${tagText(f.gueltigAb)}` : 'von der Inbetriebnahme an';
  const teile = [ab, f.leistungKwp != null ? fmtNum(f.leistungKwp, 'kWp', 1) : `Leistung ${NICHT_ERHOBEN}`];
  if (f.einspeiseart) teile.push(EINSPEISEART[f.einspeiseart]);
  if (f.satzAngegebenCtKwh != null) teile.push(`eigener Satz ${satzText(f.satzAngegebenCtKwh)}`);
  return teile.join(' · ');
}

/** Ein Verweis auf eine Komponente: „WR Hybrid, Eingang 2 · seit 01.05.2025“. */
export function komponenteText(k: Erzeugungsanlage['komponenten'][number]): string {
  const name = `${k.name || 'Komponente'}${k.eingang != null ? `, Eingang ${k.eingang}` : ''}`;
  return k.gueltigBis ? `${name} · ${tagText(k.gueltigAb)} bis ${tagText(k.gueltigBis)}` : `${name} · seit ${tagText(k.gueltigAb)}`;
}
