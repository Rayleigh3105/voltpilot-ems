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
 * Vertrag verletzt, wird NICHT gesprochen: er zeigt nur den Strich. Seit AP-13
 * IP-6 (E11 = A, D5) steht unter dem Strich der Karte, WARUM: der Satz des
 * Grundes aus dem Ergebnis-Vertrag (`grundSatz`), mit den Feldern der Antwort
 * und den Namen des Registers — fehlt ein Name, steht kein Satz statt eines
 * geratenen. In der Zeile trägt nur `noch_nicht_gebildet` ein Wort („noch nicht
 * gerechnet“ ist nicht „keine Werte“, Captain 15.09.2026).
 *
 * Die Karte nennt die ANZAHL der Lücken neben dem Verlauf („Verlauf 85 % · 1 Lücke“):
 * jede Lücke (Ereignis-Art `data_gap`) einmal, so wie die Route sie an den Schritt
 * hängt — gezählt, nicht gerechnet, nichts aufgefüllt (Captain 15.09.2026).
 *
 * REIN: kein Netz, kein Zustand, keine Uhr.
 */

import type {
  MessstelleRegisterZeile,
  MessstelleWerte,
  MessstelleWerteQuelle,
  MessstelleWerteRaster,
  MessstelleWerteWert,
} from './api';
import { UEMS_FASSUNG, UEMS_LUECKE, UEMS_MESSSTELLE, UEMS_NOCH_NICHT_GERECHNET, UEMS_VERSION } from './glossar';
import { KEINE_DATENQUELLE, zeitpunktText, type ZeileWoerter } from './messstellen';
import { MONATE, WOCHENTAGE, datumVon, isoWoche } from './picker/datum';
import { BERECHNET_DIFFERENZ, BERECHNET_SALDO, BERECHNET_SUMME } from './uemsBilanz';
import { zahlText } from './uemsEreignis';
import {
  ANZEIGE_EINHEITEN,
  FASSUNG_KENNZEICHEN,
  GRUENDE,
  GRUND_ANTEIL,
  KEINE_WERTE,
  OHNE_ZAHL,
  TRENNER,
  VOLLSTAENDIG,
  fassung,
  grundSatz,
  menge,
  pruefe,
  pruefeMenge,
  teile,
  zustandMitHerkunft,
  type Ergebnis,
} from './uemsErgebnis';
import { herkunftsZeile, kennzeichenSprung, zoneSatz, type Stueck, type Zeitraum } from './uemsOberflaechen';
import { datumText, type Tag } from './uemsOrtsbaum';

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

/** Die Karte einer Messstelle: dazu die Anzahl der Lücken und der Satz, warum eine Zahl fehlt. */
export interface MessstellenKarte extends Karte {
  luecken: string | null;
  /**
   * Unter dem Strich: der Satz des Grundes (`grundDes`, AP-13 IP-6) — am noch nicht gebildeten Schritt zeichengleich
   * `UEMS_NOCH_NICHT_GERECHNET_SATZ`. `null` unter einer Zahl, ohne Grund und wo ein Platzhalter keinen Namen hat.
   */
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
 * Die Periode der Adresse als Wahl der Zeit-Leiste (AP-13 E9; seit IP-4 alle vier Zeiträume von E5):
 * `periode=2026-10-25` · `periode=2026-W44` · `periode=2026-10` · `periode=2026` — oder `null`, wenn sie fehlt oder
 * kein Kalendertag, keine ISO-Woche, kein Monat bzw. kein Jahr ist: dann öffnet die Sektion wie ohne Angabe.
 */
export const periodeAus = (periode: string | null | undefined): { art: Zeitraum; wert: string } | null => {
  const p = periode ?? '';
  if (/^\d{4}$/.test(p)) return { art: 'jahr', wert: p };
  if (/^\d{4}-W\d{2}$/.test(p)) {
    // Eine 53. Woche gibt es nicht in jedem Jahr — nur eine Woche, die es gibt, schreibt sich selbst zurück.
    const montag = datumVon(p, 'woche');
    return montag && isoWoche(montag) === p ? { art: 'woche', wert: p } : null;
  }
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(p);
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

/**
 * Die Karte aus der Antwort der Periode (Raster `tag` bzw. `monat`, genau ein Schritt). `namen` sind die Bindungen,
 * wie das Register sie nennt (`quellenNamen`) — nur der Grund-Satz braucht sie.
 */
export const karte = (antwort: MessstelleWerte, namen: QuellenNamen = {}): MessstellenKarte | null => {
  const w = antwort.werte[0];
  if (!w) return null;
  const a = anzeige(antwort, w, true);
  // Die Fassung spricht nur ein gesprochener Schritt, und nur mit einem Wert, den der Vertrag kennt.
  const bekannt = w.fassung !== null && Object.prototype.hasOwnProperty.call(FASSUNG_KENNZEICHEN, w.fassung);
  const gesprochen = a.zustand !== null && bekannt;
  return {
    ...a,
    titel: antwort.raster === 'jahr' ? w.von.slice(0, 4) : antwort.raster === 'monat' ? monatTitel(w.von) : tagTitel(w.von),
    tagesdauer: antwort.raster === 'tag' ? w.tagesdauer : null,
    fassung: gesprochen ? fassung(w.fassung) : null,
    fassungWert: gesprochen ? w.fassung : null,
    // Die Anzahl der Lücken nennt, wie die Fassung, nur ein gesprochener Schritt.
    luecken: a.zustand !== null ? luecken(w) : null,
    // Unter dem Strich steht, warum — nur dort, wo die Route keine Zahl hat (AP-13 IP-6, D5).
    grund: a.zahl === OHNE_ZAHL && w.menge === null ? grundDes(antwort, w, namen) : null,
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
      // Im Jahr stehen die Monate in der Liste (AP-13 IP-4).
      beschriftung: antwort.raster === 'tag' ? tagTitel(w.von, false) : antwort.raster === 'monat' ? monatTitel(w.von) : (w.beschriftung ?? w.von),
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

// ------------------------------------------------------------------ Warum eine Zahl fehlt (AP-13 IP-6, E11 = A, D5)

/** Eine Bindung, wie das Register sie nennt — die Werte-Route liefert nur ihre Kennung. */
export interface BindungsNamen {
  /** „Netzzähler Lindach (GR-10)“: der Name der Komponente mit dem Kennzeichen ihres Geräts (Vertrag `woher.quelle`). */
  quelle: string;
  /**
   * „Wirkenergie Bezug (Netzzähler Halle 1)“: der Name des Messwerts mit dem NAMEN seiner Komponente. Der Vertrag
   * (`woher.kanal`) nennt ihr Kennzeichen („K-3“) — das Register liefert zur Bindung aber nur die Kennung der Komponente.
   */
  kanal: string;
}

/** Die Namen je Kennung der Bindung — `quellen[].id` der Werte-Route ist `quelle.fuehrend.id` des Registers. */
export type QuellenNamen = Readonly<Record<string, BindungsNamen>>;

/**
 * Die Namen der Bindungen, die das Register heute kennt: die führende und die davor. Eine Bindung ohne Namen der
 * Komponente oder des Messwerts fehlt — ein Satz mit einer Kennung statt eines Namens wäre keiner des Vertrags.
 */
export const quellenNamen = (quelle: MessstelleRegisterZeile['quelle'] | null | undefined): QuellenNamen => {
  const namen: Record<string, BindungsNamen> = {};
  for (const b of [quelle?.fuehrend, quelle?.davor]) {
    if (!b?.komponente_name || !b.kanal_name) continue;
    namen[b.id] = { quelle: `${b.komponente_name} (${b.geraet.geraet})`, kanal: `${b.kanal_name} (${b.komponente_name})` };
  }
  return namen;
};

const zeitwert = (iso: string): number => Date.parse(iso);

/** Die Bindungen der Antwort, die den Schritt berühren — nach ihrem Beginn, wie `MessstelleWerteRegeln.deckung` sie liest. */
const beruehrend = (antwort: MessstelleWerte, w: MessstelleWerteWert): MessstelleWerteQuelle[] =>
  antwort.quellen
    .filter((q) => zeitwert(q.gueltig_ab) < zeitwert(w.bis) && (q.gueltig_bis === null || zeitwert(q.gueltig_bis) > zeitwert(w.von)))
    .sort((a, b) => zeitwert(a.gueltig_ab) - zeitwert(b.gueltig_ab));

/**
 * Der Satz, warum ein Schritt keine Zahl hat (E11 = A, D5): `grundSatz` des Ergebnis-Vertrags mit den Platzhaltern, die
 * der Vertrag unter `woher` nennt —
 *  - `keine_quelle`: Kennzeichen und Name der Messstelle;
 *  - `quelle_teilweise`: die Bindung, die IM Schritt beginnt, mit ihrem Namen und dem Tag ihres Beginns in der Zone der
 *    Antwort. Endet die Deckung nur, ohne dass eine beginnt, gibt es keinen „gilt seit“-Satz;
 *  - `anteil_nicht_gespeichert`: der Anteil der Bindung des Schritts und der Name ihres Messwerts;
 *  - `version_nicht_gespeichert`: die angefragte Version und die neueste des Schritts.
 * `null` ohne Grund, bei einem Code, den der Vertrag nicht kennt, und wo ein Platzhalter keinen Wert hat — kein Satz
 * nennt eine Ursache, die kein Modul geliefert hat.
 */
export const grundDes = (antwort: MessstelleWerte, w: MessstelleWerteWert, namen: QuellenNamen = {}): string | null => {
  const code = w.grund;
  if (code === null || !GRUENDE.some((g) => g.code === code)) return null;
  switch (code) {
    case 'keine_quelle':
      return grundSatz(code, { messstelle: [antwort.messstelle.kennzeichen, antwort.messstelle.name].filter(Boolean).join(' ') });
    case 'quelle_teilweise': {
      const q = beruehrend(antwort, w).find((b) => zeitwert(b.gueltig_ab) > zeitwert(w.von));
      const n = q ? namen[q.id] : undefined;
      return q && n ? grundSatz(code, { quelle: n.quelle, ab: datumText(q.gueltig_ab.slice(0, 10)) }) : null;
    }
    case 'anteil_nicht_gespeichert': {
      const q = beruehrend(antwort, w).find((b) => b.anteil !== null);
      const n = q ? namen[q.id] : undefined;
      return q?.anteil && n ? grundSatz(code, { anteil: GRUND_ANTEIL[q.anteil], kanal: n.kanal }) : null;
    }
    case 'version_nicht_gespeichert':
      return antwort.version !== null && w.versionen !== null
        ? grundSatz(code, { n: String(antwort.version), max: String(w.versionen) })
        : null;
    default:
      return grundSatz(code, {});
  }
};

// ------------------------------------------------------------------ Werte ohne Datenquelle (AP-13 IP-6, Z4)

export interface OhneQuelle {
  titel: string;
  satz: string;
}

/**
 * Z4 · Werte ohne Datenquelle: im GANZEN Zeitraum führt keine Quelle — keine Bindung in der Antwort, jeder Schritt
 * `keine_quelle`. Eine Liste voller Striche ist dann keine Auskunft; die Sektion zeigt stattdessen Titel und Satz des
 * Grundes. Eine berechnete Messstelle kommt nie hierher; `null`, sobald eine Bindung den Zeitraum berührt.
 */
export const ohneQuelle = (antwort: MessstelleWerte | null): OhneQuelle | null => {
  if (!antwort || antwort.messstelle.art === 'berechnet' || antwort.quellen.length > 0 || antwort.werte.length === 0) return null;
  if (!antwort.werte.every((w) => w.grund === 'keine_quelle')) return null;
  const satz = grundDes(antwort, antwort.werte[0]);
  return satz === null ? null : { titel: KEINE_DATENQUELLE, satz };
};

export const QUELLE_GILT_SEIT = '{quelle} gilt seit {datum} — ab dann stehen hier Werte.';
export const QUELLE_GILT_AB = '{quelle} gilt ab {datum} — ab dann stehen hier Werte.';
/** Ohne Namen im Register: die Quelle ohne Namen, nie ihre Kennung. */
export const DIE_DATENQUELLE = 'Die Datenquelle';
export const QUELLE_AB_ZEIGEN = 'Ab {datum} zeigen';
export const QUELLE_ZUORDNEN = 'Quelle zuordnen';
export const QUELLE_OHNE_RECHT = 'Eine Datenquelle ordnet zu, wer diese Messstelle bearbeiten darf.';

/**
 * Der nächste Schritt aus einem Zeitraum ohne Datenquelle (Z4: benannt, kein Knopf ohne Ziel), aus dem Register von heute:
 *  - `ab`: die heute führende Quelle beginnt NACH dem Zeitraum — der Satz nennt sie, der Knopf blättert zu ihrem ersten
 *    Tag (nur, wenn der schon da ist);
 *  - `zuordnen`: heute führt keine Quelle, und der Wirt darf eine zuordnen (Messstellen-Dialog, Schritt „Quelle“);
 *  - `hinweis`: heute führt keine Quelle, und das Recht fehlt — der Satz sagt, wer es kann.
 * ⚠ „Ablesung eintragen“ (Z4, O15) steht NICHT hier: eine Ablesung an einer Messstelle hat weder Route noch Fläche —
 * AP-09 IP-7 schreibt Werte einer Bezugsgröße. `null` ohne Register (der Dialog an den Gesamtwert-Karten), an einer
 * berechneten Messstelle und wo das Register dem Zeitraum widerspricht.
 */
export type OhneQuelleWeg =
  | { art: 'ab'; tag: Tag; satz: string; knopf: string | null }
  | { art: 'zuordnen'; knopf: string }
  | { art: 'hinweis'; satz: string };

export const ohneQuelleWeg = (
  quelle: MessstelleRegisterZeile['quelle'] | null | undefined,
  bis: Tag,
  heute: Tag,
  darfZuordnen: boolean,
): OhneQuelleWeg | null => {
  if (!quelle || quelle.stand === 'berechnet') return null;
  if (quelle.stand === 'keine_datenquelle') {
    return darfZuordnen ? { art: 'zuordnen', knopf: QUELLE_ZUORDNEN } : { art: 'hinweis', satz: QUELLE_OHNE_RECHT };
  }
  const b = quelle.fuehrend;
  if (!b) return null;
  const tag = b.gueltig_ab.slice(0, 10);
  if (tag <= bis) return null;
  const datum = datumText(tag);
  const schonDa = tag <= heute;
  return {
    art: 'ab',
    tag,
    satz: (schonDa ? QUELLE_GILT_SEIT : QUELLE_GILT_AB)
      .replace('{quelle}', quellenNamen(quelle)[b.id]?.quelle ?? DIE_DATENQUELLE)
      .replace('{datum}', datum),
    knopf: schonDa ? QUELLE_AB_ZEIGEN.replace('{datum}', datum) : null,
  };
};

// ------------------------------------ Herkunft einer BERECHNETEN Zahl (AP-13 IP-11, D4)

export const HERKUNFT_TITEL = 'Herkunft';
export const HERKUNFT_FORMEL = 'Formel: {formel}';
export const HERKUNFT_FASSUNG_N = `${UEMS_FASSUNG} {n}`;
export const HERKUNFT_BERECHNET_AM = 'berechnet am {am}';
export const HERKUNFT_VERSION_N = `${UEMS_VERSION} {n}`;
/** D4: „ohne Angabe: …“ — eine halbe Herkunft wird gesagt, nie verschwiegen. */
export const HERKUNFT_OHNE_ANGABE = 'ohne Angabe: {was}';

/** Der Formel-Typ in Kundenwörtern — dieselben drei Wörter wie an der Bilanz-Fläche (AP-10 §5.6). */
export const FORMEL_WORT: Readonly<Record<string, string>> = {
  gewichtete_summe: BERECHNET_SUMME,
  rest: BERECHNET_DIFFERENZ,
  saldo: BERECHNET_SALDO,
};

/** Was an einer Herkunft fehlen kann (`fehlt[]` der Hülle), in Kundenwörtern. Ein unbekanntes Feld bleibt, wie es kam. */
export const HERKUNFT_FEHLT_WORT: Readonly<Record<string, string>> = {
  art: 'Art',
  messstelle: UEMS_MESSSTELLE,
  periode: 'Periode',
  verteilung: 'Verteilung',
  eingaenge: 'Eingänge',
  eingang_messstelle: 'Eingänge',
  formel_typ: 'Formel',
  formel_fassung: `${UEMS_FASSUNG} der Formel`,
  bilanz_rolle: 'Rolle in der Bilanz',
  berechnet_am: 'Zeitpunkt der Rechnung',
  ausloeser: 'Anlass',
  ergebnis: 'Ergebnis',
};

export interface BerechneteHerkunft {
  /** „berechnet (Summe) · Formel: Fassung 2“ · „berechnet am 01.11.2026, 00:20“ · „Version 2“. */
  zeilen: string[];
  /** Je Eingang eine Zeile in Stücken — sein Kennzeichen ist der Sprung (D1) MIT Periode und Version (D2). */
  eingaenge: Stueck[][];
  /** „ohne Angabe: Eingänge.“ — `null`, wenn die Herkunft vollständig ist. */
  fehlt: string | null;
}

const alsText = (x: unknown): string | null => (typeof x === 'string' && x.length > 0 ? x : null);

/**
 * D4 — die Karte einer BERECHNETEN Messstelle spricht ihre Herkunft: Formel-Typ und Fassung, Zeitpunkt,
 * Version und Anlass, und je Eingang eine Zeile, deren Messstelle ein Sprung ist (Periode der Karte,
 * Version DIESES Eingangs). `null` an einer gemessenen Zahl und an einem Schritt ohne Zahl — dort trägt
 * die Route die Hülle gar nicht, und es wird keine erfunden.
 *
 * Gelesen wird die Hülle `{satz, fehlt}` nach `bilanzwert-herkunft.schema.json` (AP-10 IP-12), Feld für
 * Feld geprüft: was nicht in der erwarteten Form ankommt, steht nicht da — nie geraten, nie gerechnet.
 */
export const berechneteHerkunft = (
  w: Pick<MessstelleWerteWert, 'herkunft'>,
  zone: string,
  periode: string | null,
): BerechneteHerkunft | null => {
  const h = w.herkunft;
  if (!h) return null;
  const fehlt =
    h.fehlt.length === 0
      ? null
      : `${fuelleKarte(HERKUNFT_OHNE_ANGABE, { was: [...new Set(h.fehlt.map((f) => HERKUNFT_FEHLT_WORT[f] ?? f))].join(', ') })}.`;
  const satz = h.satz;
  if (!satz) return { zeilen: [], eingaenge: [], fehlt };
  const typ = alsText(satz.formel_typ);
  const fassung = satz.formel_fassung;
  const berechnetAm = alsText(satz.berechnet_am);
  const version = typeof satz.version === 'number' ? satz.version : null;
  const kopf = [
    typ ? (FORMEL_WORT[typ] ?? typ) : null,
    typeof fassung === 'number'
      ? fuelleKarte(HERKUNFT_FORMEL, { formel: fuelleKarte(HERKUNFT_FASSUNG_N, { n: fassung }) })
      : alsText(fassung)
        ? fuelleKarte(HERKUNFT_FORMEL, { formel: alsText(fassung) as string })
        : null,
  ].filter((t): t is string => t !== null);
  const eingaenge = Array.isArray(satz.eingaenge) ? (satz.eingaenge as Array<Record<string, unknown>>) : [];
  return {
    zeilen: [
      ...(kopf.length > 0 ? [kopf.join(TRENNER)] : []),
      ...(berechnetAm && !Number.isNaN(Date.parse(berechnetAm))
        ? [fuelleKarte(HERKUNFT_BERECHNET_AM, { am: zeitpunktText(berechnetAm, zone) })]
        : []),
      ...(version === null ? [] : [fuelleKarte(HERKUNFT_VERSION_N, { n: version })]),
    ],
    eingaenge: eingaenge.map((e) => {
      const kennzeichen = alsText(e.messstelle) ?? '';
      const eigene = typeof e.version === 'number' ? e.version : null;
      const text = [
        kennzeichen,
        alsText(e.zustand),
        eigene === null ? null : fuelleKarte(HERKUNFT_VERSION_N, { n: eigene }),
        ...(Array.isArray(e.kennzeichen) ? e.kennzeichen.map(String) : []),
      ]
        .filter((t): t is string => t !== null && t !== '')
        .join(TRENNER);
      return herkunftsZeile(text, (k) => kennzeichenSprung(k, { periode, version: eigene }));
    }),
    fehlt,
  };
};

const fuelleKarte = (vorlage: string, werte: Record<string, string | number>): string =>
  vorlage.replace(/\{([a-z_]+)\}/g, (_, k: string) => String(werte[k] ?? `{${k}}`));

// ------------------------------------------------------------------ Nebengrößen (AP-13 V8)

export const NEBENGROESSEN_TITEL = 'Weitere Größen';
export const NEBENGROESSEN_SATZ = 'Letzter Wert aus der Box — Werte und Verlauf gibt es hier nur für {hauptgroesse}.';

export interface Nebengroessen {
  titel: string;
  /** „Wirkleistung 148,6 kW · 10:15 Uhr“ — Wortlaut des Registers (`zeileWoerter.nebenwerte`). */
  zeilen: string[];
  satz: string;
}

/**
 * V8: eine Nebengröße (Wirkleistung, Ladestand) hat keine Werte-Route — die Seite nennt ihren letzten Wert aus dem
 * Register und sagt, dass Werte und Verlauf nur der Hauptgröße gehören. Der Weg zum Register-Verlauf der Geräteseite fehlt:
 * das Register nennt zur Bindung weder Anlage noch Box-Referenz, ohne die die Geräteseite keine Adresse hat. `null` ohne
 * Nebengröße mit Wert.
 */
export const nebengroessen = (
  woerter: Pick<ZeileWoerter, 'nebenwerte'> | null,
  haupt: { groesse: string; richtung: string },
): Nebengroessen | null => {
  if (!woerter || woerter.nebenwerte.length === 0) return null;
  const hauptgroesse = haupt.richtung === 'richtungslos' ? haupt.groesse : `${haupt.groesse} ${haupt.richtung}`;
  return {
    titel: NEBENGROESSEN_TITEL,
    zeilen: woerter.nebenwerte.map((n) => `${n.groesse} ${n.text} · ${n.zeit}`),
    satz: NEBENGROESSEN_SATZ.replace('{hauptgroesse}', hauptgroesse),
  };
};
