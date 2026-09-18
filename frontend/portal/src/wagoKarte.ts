/**
 * UEMS AP-05 IP-11 — die reinen Regeln der WAGO-Energiekarte an einer Messstelle:
 * der Dialog „Karte getauscht“ (E6) und der Hebel „Wandler/Anwenderskalierung prüfen“.
 *
 * Drei Sätze, die dieses Paket trägt:
 *  - **Ein Kartentausch ist eine Gerätegrenze OHNE Gerätewechsel** (Report §8 E6, Abnahme A10):
 *    Gerät, Komponente und Messstelle bleiben; nichts wird gelöscht, die Geschichte der alten
 *    Karte bleibt vollständig lesbar. Darum entsteht hier kein dritter Wechsel-Mechanismus neben
 *    Zähler- und Controllerwechsel — nur ein Ereignis an derselben Komponente.
 *  - **Der Hebel erscheint nur aus BELEGEN.** Er braucht zwei gespeicherte Tatsachen: einen
 *    eingetragenen Kartentausch UND eine fehlende Angabe zur Anwenderskalierung. Ohne Tausch
 *    gibt es keinen Hebel — ein Dauerhinweis an jeder Karte wäre eine Vermutung, kein Befund.
 *  - **Nichts behauptet „geprüft“.** „nicht erfasst“ bleibt „nicht erfasst“ und wird nie zu
 *    einem Faktor, einer Null oder einem Haken.
 *
 * REIN: kein Netz, kein Zustand, keine Uhr — `jetzt` kommt herein.
 */
import type { WagoKartenangaben, WagoKartenwechsel } from './api';
import { zeitText } from './uemsEreignis';
import { ablesestandWert } from './zahl';

/** Was der Kunde über die dokumentierte Karte liest — fehlend bleibt sichtbar fehlend. */
export const NICHT_ERFASST = 'nicht erfasst';

/**
 * Wer überhaupt Kartenangaben haben KANN: der Hersteller des Einbaus ist WAGO. Die Antwort auf
 * die Route bleibt die Wahrheit (404 = keine WAGO-Komponente); diese Regel verhindert nur, dass
 * jede andere Messstelle danach fragt. Kein Hersteller = nicht fragen, nie raten.
 */
export const WAGO_HERSTELLER = 'wago';
export function kannKartenangabenHaben(hersteller: string | null | undefined): boolean {
  return (hersteller ?? '').trim().toLowerCase() === WAGO_HERSTELLER;
}

export const KARTE_TITEL = 'Energiekarte';
export const KARTE_TAUSCHEN = 'Karte getauscht';

/** Der Hebel — eine Aufgabe, kein Urteil über die Werte. */
export const HEBEL_TITEL = 'Wandler und Anwenderskalierung prüfen';

/**
 * Die dokumentierten Angaben als Zeilen. Jede Zeile nennt die Angabe und was dazu gespeichert
 * ist; keine Zeile rechnet, keine Zeile füllt eine fehlende Angabe auf.
 */
export function kartenAngaben(karte: WagoKartenangaben): string[] {
  return [
    `Steckplatz: ${karte.slot === null ? NICHT_ERFASST : String(karte.slot)}`,
    `Anwenderskalierung: ${karte.anwenderskalierung === null ? NICHT_ERFASST
      : karte.anwenderskalierung ? 'eingeschaltet — die Karte rechnet den Wandler selbst um'
        : 'ausgeschaltet — die Karte liefert Werte ohne den Wandler'}`,
    `Register 35: ${karte.register35 === null ? NICHT_ERFASST : String(karte.register35)}`,
  ];
}

/**
 * Der Hebel „Wandler und Anwenderskalierung prüfen“ — NUR aus Belegen (Report §8, Zelle IP-11).
 *
 * Er erscheint genau dann, wenn beides gespeichert ist: ein eingetragener Kartentausch (der
 * Beleg, dass eine ANDERE Karte steckt) und eine fehlende Angabe zur Anwenderskalierung (die
 * offene Stelle). Ist die Angabe erhoben, verschwindet er — ohne dass jemand etwas abhakt.
 */
export function kartenHebel(
  karte: WagoKartenangaben | null,
  zone: string,
): { titel: string; satz: string } | null {
  if (karte === null || karte.kartenwechsel === null || karte.anwenderskalierung !== null) return null;
  return {
    titel: HEBEL_TITEL,
    satz: `Seit dem Kartentausch am ${zeitText(karte.kartenwechsel, zone)} ist für diese Karte `
      + 'nicht erfasst, ob sie selbst mit dem Wandlerverhältnis rechnet. Bitte lassen Sie Wandler '
      + 'und Anwenderskalierung am Gerät prüfen und tragen Sie das Ergebnis ein.',
  };
}

/** Die Eingaben des Dialogs — der Zeitpunkt kommt aus dem Zeitpunkt-Feld, der Rest von Hand. */
export interface KartenwechselEingabe {
  zeitpunkt: string | null;
  endstand: string;
  einheit: string | null;
  einstellungenPruefen: boolean;
}

export const KARTENWECHSEL_SAETZE = {
  zeitpunkt_fehlt: 'Bitte wählen Sie den Zeitpunkt des Kartentauschs.',
  im_voraus: 'Ein Kartentausch wird nicht im Voraus eingetragen.',
  endstand_zahl: 'Bitte geben Sie einen Zählerstand ab 0 an.',
  endstand_ohne_einheit: 'Der Endstand lässt sich hier keinem einzelnen Zählwerk zuordnen.',
} as const;

/**
 * Prüft die Eingaben und bildet den Auftrag. Der Endstand ist FREIWILLIG: bleibt er leer, wird
 * kein Stand erfunden — die Lücke bleibt eine Lücke.
 */
export function kartenwechselPruefen(
  e: KartenwechselEingabe,
  jetzt: string,
): { fehler: string | null; body: WagoKartenwechsel | null } {
  if (e.zeitpunkt === null) return { fehler: KARTENWECHSEL_SAETZE.zeitpunkt_fehlt, body: null };
  if (Date.parse(e.zeitpunkt) > Date.parse(jetzt)) {
    return { fehler: KARTENWECHSEL_SAETZE.im_voraus, body: null };
  }
  const roh = e.endstand.trim();
  const wert = roh ? ablesestandWert(roh) : null;
  if (roh && (wert === null || wert < 0)) {
    return { fehler: KARTENWECHSEL_SAETZE.endstand_zahl, body: null };
  }
  if (roh && !e.einheit) return { fehler: KARTENWECHSEL_SAETZE.endstand_ohne_einheit, body: null };
  return {
    fehler: null,
    body: {
      zeitpunkt: e.zeitpunkt,
      endstand: wert,
      einheit: wert === null ? null : e.einheit,
      einstellungenPruefen: e.einstellungenPruefen,
    },
  };
}

/**
 * Was der Kunde nach dem Eintrag liest — nur aus dem, was gespeichert wurde. Der Satz über den
 * Zählerstand ist die Abnahme des Programms seit AP-08: ein Sprung an einer Gerätegrenze ist
 * kein Verbrauch, und eine Lücke wird nicht aufgefüllt.
 */
export function kartenwechselFolgen(
  auftrag: WagoKartenwechsel,
  karte: WagoKartenangaben,
  zone: string,
): string[] {
  const saetze = [
    `Karte getauscht am ${zeitText(auftrag.zeitpunkt, zone)} — das Gerät bleibt dasselbe.`,
    'Messstelle, Kennzeichen und Zuordnung bleiben. Nichts wurde gelöscht: die Werte der alten '
      + 'Karte bleiben vollständig lesbar.',
    'Ein Sprung des Zählerstands an dieser Stelle zählt nicht als Verbrauch. Fehlende Werte '
      + 'werden nicht aufgefüllt.',
  ];
  if (auftrag.endstand !== null) {
    saetze.push(`Endstand der alten Karte: ${auftrag.endstand.toLocaleString('de-DE')}`
      + `${auftrag.einheit ? ` ${auftrag.einheit}` : ''}.`);
  }
  saetze.push(auftrag.einstellungenPruefen
    ? `${HEBEL_TITEL}: Für die neue Karte ist nicht erfasst, ob sie selbst mit dem `
      + 'Wandlerverhältnis rechnet. Die Aufgabe steht ab jetzt an der Messstelle.'
    : 'Die dokumentierten Kartenangaben bleiben unverändert.');
  if (karte.kartenwechsel === null) {
    saetze.push('Der Kartentausch ist gespeichert, im Verlauf erscheint er beim nächsten Laden.');
  }
  return saetze;
}
