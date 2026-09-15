/**
 * Die TAGES- und MONATSKARTE einer Messstelle (UEMS AP-08 IP-11) als reine
 * Ableitung: aus der Antwort von `GET /api/v1/messstellen/{kennzeichen}/werte`
 * (IP-9) wird, was die Karte und ihre Liste zeigen.
 *
 * Die Karte zeigt DREI Dinge nebeneinander, nie nur das erste: die Menge, ihren
 * Zustand samt Herkunft („vollständig (Menge aus Zählerständen)“) und die
 * Abdeckung des Verlaufs („Verlauf 85 %“) — dass beides zugleich stimmt, ist E1.
 * Dazu sagt die Karte IMMER, ob die Zahl feststeht: „vorläufig“ oder
 * „endgültig“ (ergebnis-zustand 1.7, Captain 14.09.2026 „Ja, immer zeigen“) —
 * was die Route für GENAU die gezeigte Periode liefert, nie abgeleitet (ein
 * vorläufiger Monat kann endgültige Tage haben). Die Fassung ist nicht der
 * Zustand: der eine sagt, ob die Zahl feststeht, der andere, ob sie vollständig ist.
 *
 * Hier wird NICHTS gerechnet und kein Satz formuliert:
 *  - Zahl, Zustand, Verlauf und Kennzeichen kommen aus dem Ergebnis-Vertrag
 *    (`uemsErgebnis.ts`: `menge`, `teile`, `zustandMitHerkunft`), die Rundung
 *    bestimmt die EBENE (E11);
 *  - Beschriftung („02:00–03:00 MESZ“) und Tagesdauer („25 Stunden
 *    (Zeitumstellung)“) liefert die Route (E10) — die Fläche liest sie nur;
 *  - `null` ist ein Strich, nie 0.
 *
 * Ein Schritt ohne Zustand (die Route nennt dann `grund`) oder einer, der den
 * Vertrag verletzt, wird NICHT gesprochen: er zeigt nur den Strich. Nur der Grund
 * `noch_nicht_gebildet` bekommt ein Wort (Zeile) bzw. einen Satz (Karte) aus
 * `glossar.ts` — „noch nicht gerechnet“ ist nicht „keine Werte“, und nur das eine
 * löst sich von selbst (Captain 15.09.2026).
 *
 * Die Karte nennt die ANZAHL der Lücken neben dem Verlauf („Verlauf 85 % · 1 Lücke“):
 * jede Lücke (Ereignis-Art `data_gap`) einmal, so wie die Route sie an den Schritt
 * hängt — gezählt, nicht gerechnet, nichts aufgefüllt (Captain 15.09.2026).
 *
 * REIN: kein Netz, kein Zustand, keine Uhr.
 */

import type { MessstelleWerte, MessstelleWerteQuelle, MessstelleWerteRaster, MessstelleWerteWert } from './api';
import { UEMS_LUECKE, UEMS_NOCH_NICHT_GERECHNET, UEMS_NOCH_NICHT_GERECHNET_SATZ } from './glossar';
import { MONATE, WOCHENTAGE } from './picker/datum';
import { zahlText } from './uemsEreignis';
import {
  ANZEIGE_EINHEITEN,
  FASSUNG_KENNZEICHEN,
  KEINE_WERTE,
  OHNE_ZAHL,
  VOLLSTAENDIG,
  fassung,
  menge,
  pruefe,
  pruefeMenge,
  teile,
  zustandMitHerkunft,
  type Ergebnis,
} from './uemsErgebnis';
import { zoneSatz } from './uemsOberflaechen';

/** Tag oder Monat — was die Karte zusammenfasst. */
export type KartenArt = 'tag' | 'monat';

/** Der Ton eines Abzeichens (die Varianten des `Badge` im Designsystem). */
export type Ton = 'ok' | 'warn' | 'off';

/** Was EIN Schritt anzeigt. */
export interface WertAnzeige {
  /** „2.304 kWh“ oder „—“. */
  zahl: string;
  /** Das Zustandswort (an der Karte samt Herkunft); `null` = der Schritt wird nicht gesprochen. */
  zustand: string | null;
  /** „Verlauf 85 %“; `null` = keine Abdeckung bekannt. */
  abdeckung: string | null;
  /** Die Kennzeichen-Sätze — Wortlaut und Reihenfolge wie geliefert. */
  kennzeichen: string[];
  zustandTon: Ton;
  abdeckungTon: Ton;
}

/** Die Karte oben: der Tag bzw. der Monat als EIN Schritt. */
export interface Karte extends WertAnzeige {
  titel: string;
  /** Nur am Tag: „25 Stunden (Zeitumstellung)“ bzw. „23 Stunden (Zeitumstellung)“. */
  tagesdauer: string | null;
  /**
   * „vorläufig“ bzw. „endgültig“ für GENAU diese Periode (`fassung` der Route);
   * `null` = die Route kennt keine Fassung oder der Schritt wird nicht gesprochen.
   */
  fassung: string | null;
  /** Der Wert der Route zur Fassung — nur für die Darstellung (Ton), nie für einen Satz. */
  fassungWert: MessstelleWerteWert['fassung'];
  /**
   * „1 Lücke“ · „3 Lücken“ — steht im Abzeichen des Verlaufs. Nur die Karte einer Messstelle nennt sie
   * (Kennzahl und Bericht bauen ihre Karte ohne); fehlt sie oder ist sie `null`, steht keine Anzahl.
   */
  luecken?: string | null;
}

/** Die Karte einer Messstelle: dazu die Anzahl der Lücken und der Satz eines noch nicht gebildeten Schritts. */
export interface MessstellenKarte extends Karte {
  luecken: string | null;
  /** `UEMS_NOCH_NICHT_GERECHNET_SATZ` an einem noch nicht gebildeten Schritt, sonst `null`. */
  grund: string | null;
}

/** Eine Zeile der Liste: eine Stunde des Tages bzw. ein Tag des Monats. */
export interface Zeile extends WertAnzeige {
  schluessel: string;
  beschriftung: string;
  /** Nur in der Tagesliste des Monats. */
  tagesdauer: string | null;
  /** `UEMS_NOCH_NICHT_GERECHNET` an einem noch nicht gebildeten Schritt, sonst `null` — in der Zeile das Wort, nie der Satz. */
  grund: string | null;
}

/** Eine Anfrage an die Route (Tage in der Zeitzone des Standorts, `bis` einschließlich). */
export interface Anfrage {
  raster: MessstelleWerteRaster;
  von: string;
  bis: string;
}

const zwei = (n: number): string => String(n).padStart(2, '0');

/** Der letzte Tag eines Monats `JJJJ-MM` als `JJJJ-MM-TT`. */
const letzterTag = (monat: string): string => {
  const [j, m] = monat.split('-').map(Number);
  return `${monat}-${zwei(new Date(Date.UTC(j, m, 0)).getUTCDate())}`;
};

/**
 * Die zwei Anfragen einer Karte: die Periode selbst (EIN Schritt) und ihre
 * Liste — am Tag die Stunden, im Monat die Tage. `wert` ist `JJJJ-MM-TT` bzw.
 * `JJJJ-MM`.
 */
export const anfragen = (art: KartenArt, wert: string): { karte: Anfrage; liste: Anfrage } => {
  if (art === 'tag') {
    return { karte: { raster: 'tag', von: wert, bis: wert }, liste: { raster: 'stunde', von: wert, bis: wert } };
  }
  const von = `${wert}-01`;
  const bis = letzterTag(wert);
  return { karte: { raster: 'monat', von, bis }, liste: { raster: 'tag', von, bis } };
};

/**
 * Die Periode der Adresse (`periode=2026-10-25` · `periode=2026-10`, AP-13 E9) als Wahl der Zeit-Leiste — oder
 * `null`, wenn sie fehlt oder kein Kalendertag bzw. -monat ist: dann öffnet die Sektion wie ohne Angabe.
 */
export const periodeAus = (periode: string | null | undefined): { art: KartenArt; wert: string } | null => {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(periode ?? '');
  if (!m) return null;
  const [j, mo, t] = [Number(m[1]), Number(m[2]), m[3] === undefined ? 1 : Number(m[3])];
  if (mo < 1 || mo > 12 || t < 1 || new Date(Date.UTC(j, mo - 1, t)).getUTCMonth() !== mo - 1) return null;
  return { art: m[3] === undefined ? 'monat' : 'tag', wert: m[0] };
};

/** Der Kalendertag des Beginns, wie die Route ihn schreibt (Ortszeit des Standorts, mit Versatz). */
const kalendertag = (von: string): { j: number; m: number; t: number } => {
  const [j, m, t] = von.slice(0, 10).split('-').map(Number);
  return { j, m, t };
};

/** „Di 03.11.2026“ — der Tag in der Ortszeit des Standorts. */
export const tagTitel = (von: string, mitJahr = true): string => {
  const { j, m, t } = kalendertag(von);
  const wochentag = WOCHENTAGE[(new Date(Date.UTC(j, m - 1, t)).getUTCDay() + 6) % 7];
  return `${wochentag} ${zwei(t)}.${zwei(m)}.${mitJahr ? j : ''}`;
};

/** „November 2026“. */
export const monatTitel = (von: string): string => {
  const { j, m } = kalendertag(von);
  return `${MONATE[m - 1]} ${j}`;
};

const tonDesZustands = (zustand: string | null): Ton => {
  if (zustand === VOLLSTAENDIG) return 'ok';
  if (zustand === null || zustand === KEINE_WERTE) return 'off';
  return 'warn';
};

const STRICH: WertAnzeige = {
  zahl: OHNE_ZAHL,
  zustand: null,
  abdeckung: null,
  kennzeichen: [],
  zustandTon: 'off',
  abdeckungTon: 'off',
};

/**
 * Was ein Schritt zum Sprechen braucht: die Messstelle (gespeicherte Einheit),
 * das Raster (die Ebene der Rundung) und — nur für die Herkunft — die Quellen.
 * Die Antwort von `…/werte` erfüllt es, die Historie von `…/werte/versionen` auch.
 */
export interface Rahmen {
  messstelle: MessstelleWerte['messstelle'];
  raster: MessstelleWerteRaster;
  quellen?: MessstelleWerteQuelle[];
}

/**
 * EIN Schritt als Anzeige. `mitHerkunft` setzt die Herkunft der Menge ans
 * Zustandswort (die Karte); die Zeilen einer Liste tragen das Wort allein.
 */
export const anzeige = (
  antwort: Rahmen,
  w: MessstelleWerteWert,
  mitHerkunft: boolean,
): WertAnzeige => {
  const ebene = antwort.raster;
  const gespeichert = antwort.messstelle.einheit;
  const einheit = ANZEIGE_EINHEITEN.find((a) => a.gespeichert === gespeichert);
  // Ohne Zustand spricht der Schritt nicht; eine Einheit ohne Anzeige ebenso wenig.
  if (w.zustand === null || !einheit || pruefeMenge(gespeichert, ebene).length > 0) return STRICH;
  const ergebnis: Ergebnis = {
    wert: w.menge,
    einheit: einheit.angezeigt,
    ebene,
    zustand: w.zustand,
    abdeckungProzent: w.abdeckung_prozent,
    kennzeichen: w.kennzeichen,
  };
  // Ein Ergebnis, das den Vertrag verletzt, wird nicht gesprochen (auch nicht seine Zahl).
  if (pruefe(ergebnis).length > 0) return STRICH;
  const t = teile(ergebnis);
  const herleitung = mitHerkunft ? ((antwort.quellen ?? []).find((q) => q.id === w.quelle)?.herleitung ?? null) : null;
  return {
    zahl: menge(w.menge, gespeichert, ebene),
    zustand: zustandMitHerkunft(w.zustand, herleitung, w.menge),
    abdeckung: t.abdeckung,
    kennzeichen: t.kennzeichen,
    zustandTon: tonDesZustands(w.zustand),
    abdeckungTon: w.abdeckung_prozent === 100 ? 'ok' : 'warn',
  };
};

/** Die Lücken eines Schritts: jede Lücke (Ereignis-Art `data_gap`) EINMAL, so wie die Route sie an den Schritt hängt. */
const lueckenDes = (w: MessstelleWerteWert): number =>
  new Set(w.ereignisse.filter((e) => e.art === 'data_gap').map((e) => e.id)).size;

/**
 * „1 Lücke“ · „3 Lücken“ — oder `null`: ohne Lücke und bei Verlauf 100 %. Dort sind alle erwarteten Werte
 * da; eine Lücke, die die Route trotzdem nennt, ist nachgeliefert (der Lücken-Melder schließt sie mit
 * `nachgeliefert_am` und löscht sie nie, F9) — „Verlauf 100 % · 1 Lücke“ wäre ein Widerspruch.
 */
export const luecken = (w: MessstelleWerteWert): string | null => {
  const n = lueckenDes(w);
  if (n === 0 || w.abdeckung_prozent === 100) return null;
  return `${zahlText(n)} ${n === 1 ? UEMS_LUECKE.singular : UEMS_LUECKE.plural}`;
};

/** Ein Schritt, den die Route „noch nicht gebildet“ nennt — er wird nicht gesprochen, sagt aber, warum. */
const nochNichtGebildet = (a: WertAnzeige, w: MessstelleWerteWert): boolean =>
  a.zustand === null && w.grund === 'noch_nicht_gebildet';

/** Die Karte aus der Antwort der Periode (Raster `tag` bzw. `monat`, genau ein Schritt). */
export const karte = (antwort: MessstelleWerte): MessstellenKarte | null => {
  const w = antwort.werte[0];
  if (!w) return null;
  const a = anzeige(antwort, w, true);
  // Die Fassung spricht nur ein gesprochener Schritt, und nur mit einem Wert, den der Vertrag kennt.
  const bekannt = w.fassung !== null && Object.prototype.hasOwnProperty.call(FASSUNG_KENNZEICHEN, w.fassung);
  const gesprochen = a.zustand !== null && bekannt;
  return {
    ...a,
    titel: antwort.raster === 'monat' ? monatTitel(w.von) : tagTitel(w.von),
    tagesdauer: antwort.raster === 'tag' ? w.tagesdauer : null,
    fassung: gesprochen ? fassung(w.fassung) : null,
    fassungWert: gesprochen ? w.fassung : null,
    // Die Anzahl der Lücken nennt, wie die Fassung, nur ein gesprochener Schritt.
    luecken: a.zustand !== null ? luecken(w) : null,
    grund: nochNichtGebildet(a, w) ? UEMS_NOCH_NICHT_GERECHNET_SATZ : null,
  };
};

/**
 * Die Liste unter der Karte: am Tag die Stunden mit der Beschriftung der Route
 * (die doppelte Stunde mit MESZ/MEZ, die fehlende fehlt), im Monat die Tage mit
 * ihrer Tagesdauer. Ein noch nicht gebildeter Schritt trägt das Wort „noch nicht
 * gerechnet“ (die Karte den Satz); die Anzahl der Lücken steht nur an der Karte.
 */
export const liste = (antwort: MessstelleWerte): Zeile[] =>
  antwort.werte.map((w) => {
    const a = anzeige(antwort, w, false);
    return {
      ...a,
      schluessel: w.von,
      beschriftung: antwort.raster === 'tag' ? tagTitel(w.von, false) : (w.beschriftung ?? w.von),
      tagesdauer: antwort.raster === 'tag' ? w.tagesdauer : null,
      grund: nochNichtGebildet(a, w) ? UEMS_NOCH_NICHT_GERECHNET : null,
    };
  });

// ------------------------------------------------------------------ Werte an der Messstelle (AP-13 IP-3)

/**
 * Der Kopf der Werte (AP-13 E12 = A): „Zeiten in Europe/Berlin (Zeitzone des Standorts Werk Ahrenberg)“ — Zone und
 * Herkunft aus DER Antwort, nie aus dem Browser (`uemsOberflaechen.zoneSatz`). Den Namen des Standorts kennt der
 * Wirt (die Messstellen-Seite aus dem Register); ohne ihn steht „(Zeitzone des Standorts)“.
 */
export const zeitenKopf = (
  antwort: Pick<MessstelleWerte, 'zeitzone' | 'zeitzone_herkunft'>,
  standortName?: string | null,
): string => zoneSatz(antwort.zeitzone, antwort.zeitzone_herkunft, standortName);

/** Die gewählte Version ist heute die neueste (AP-13 §5.6, O10). */
export const VERSION_NEUESTE = 'Sie sehen Version {n} — heute die neueste';

/** Die gewählte Version ist eine frühere — „gilt“ wie in der Historie („gilt jetzt“, AP-08 IP-18). */
export const VERSION_FRUEHERE = 'Sie sehen Version {n} — heute gilt Version {neueste}';

/**
 * Der Hinweis zur Version der Adresse (`version=n`, AP-13 E9): nur, wenn die Karte GENAU diese Version zeigt und
 * spricht — `version` am Schritt ist die gezeigte, `versionen` die Zahl der Versionen der Periode. Ohne gewählte
 * Version, an einem Schritt, der nicht gesprochen wird (etwa `version_nicht_gespeichert`), oder ohne `versionen` steht
 * keiner: „Sie sehen Version 2“ über einem Strich wäre falsch.
 */
export const versionHinweis = (antwort: MessstelleWerte, gewaehlt: number | null): string | null => {
  const w = antwort.werte[0];
  if (gewaehlt === null || !w || w.version !== gewaehlt || w.versionen === null || gewaehlt > w.versionen) return null;
  if (karte(antwort)?.zustand == null) return null;
  return (gewaehlt === w.versionen ? VERSION_NEUESTE : VERSION_FRUEHERE)
    .replace('{n}', String(gewaehlt))
    .replace('{neueste}', String(w.versionen));
};
