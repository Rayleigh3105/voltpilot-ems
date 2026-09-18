/**
 * UEMS AP-05 IP-11 — die Regeln der Energiekarte und die Verlauf-Marker der Box-Ereignisse.
 *
 * Die beiden Abnahmefälle des Reports (§7) stehen hier als Testfälle:
 *  - **A8** — Rücksetzung an EK-3 am 15.01.2027 09:12: der Verlauf spricht „Zähler
 *    zurückgesetzt“, und ein Marker füllt nichts auf.
 *  - **A10** — Kartenwechsel EK-4 am 20.03.2027: Gerätegrenze OHNE Gerätewechsel, wahlweise mit
 *    Endstand, und die Prüfaufgabe trägt danach den Hebel.
 */
import { describe, expect, it } from 'vitest';
import type { WagoKartenangaben } from './api';
import { markerSatz } from './uemsVerlauf';
import {
  HEBEL_TITEL,
  KARTENWECHSEL_SAETZE,
  kartenAngaben,
  kartenHebel,
  kartenwechselFolgen,
  kartenwechselPruefen,
  kannKartenangabenHaben,
} from './wagoKarte';

const ZONE = 'Europe/Berlin';
const JETZT = '2027-03-20T15:00:00+01:00';
/** A10: Kartenwechsel EK-4 (defekt) am 20.03.2027. */
const A10_AM = '2027-03-20T09:30:00+01:00';
/** A8: Rücksetzung per WAGO-I/O-CHECK an EK-3, 09:12. */
const A8_AM = '2027-01-15T09:12:00+01:00';

function karte(over: Partial<WagoKartenangaben> = {}): WagoKartenangaben {
  return { slot: 5, anwenderskalierung: false, register35: 0, version: 3, kartenwechsel: null, ...over };
}

describe('A8 · die fünf Karten-Ereignisse sprechen im Verlauf', () => {
  it('jede der fünf Arten hat einen Kundensatz mit ihrem Zeitpunkt', () => {
    const arten: Array<[string, string]> = [
      ['counter_reset', 'Zähler zurückgesetzt'],
      ['range_limit', 'Bereichsbegrenzung'],
      ['frozen_source', 'Werte eingefroren'],
      ['device_restart', 'Neustart des Geräts'],
      ['layout_changed', 'Aufbau geändert'],
    ];
    for (const [art, wort] of arten) {
      const satz = markerSatz({ art, von: A8_AM, bis: null }, ZONE);
      expect(satz, art).not.toBeNull();
      expect(satz, art).toContain(wort);
      // Der Zeitpunkt steht in Standort-Zeit im Satz — 09:12, nicht 08:12 (UTC).
      expect(satz, art).toContain('09:12');
      // Kein englisches Vertragswort erreicht die Kundensicht.
      expect(satz, art).not.toContain(art);
    }
  });

  it('kein Marker behauptet einen Wert: er nennt, was gemeldet wurde, und füllt keine Lücke', () => {
    const satz = markerSatz({ art: 'frozen_source', von: A8_AM, bis: null }, ZONE)!;
    expect(satz).not.toMatch(/\d+,\d+\s*kWh/);
    expect(satz).not.toContain('0,0');
  });

  it('eine Art außerhalb des Vokabulars bleibt stumm — nie ein geratener Satz', () => {
    expect(markerSatz({ art: 'wago_irgendwas', von: A8_AM, bis: null }, ZONE)).toBeNull();
  });
});

describe('A10 · der Dialog „Karte getauscht"', () => {
  it('bildet den Auftrag mit Zeitpunkt, Endstand und Prüfaufgabe', () => {
    const { fehler, body } = kartenwechselPruefen(
      { zeitpunkt: A10_AM, endstand: '6.184,37', einheit: 'kWh', einstellungenPruefen: true }, JETZT,
    );
    expect(fehler).toBeNull();
    expect(body).toEqual({
      zeitpunkt: A10_AM, endstand: 6184.37, einheit: 'kWh', einstellungenPruefen: true,
    });
  });

  it('der Endstand ist freiwillig — ohne ihn wird kein Stand erfunden', () => {
    const { body } = kartenwechselPruefen(
      { zeitpunkt: A10_AM, endstand: '', einheit: 'kWh', einstellungenPruefen: false }, JETZT,
    );
    expect(body?.endstand).toBeNull();
    expect(body?.einheit).toBeNull();
  });

  it('weist einen Zeitpunkt im Voraus, eine unlesbare Zahl und einen Stand ohne Zählwerk ab', () => {
    expect(kartenwechselPruefen(
      { zeitpunkt: '2027-03-21T09:30:00+01:00', endstand: '', einheit: 'kWh', einstellungenPruefen: true }, JETZT,
    ).fehler).toBe(KARTENWECHSEL_SAETZE.im_voraus);
    expect(kartenwechselPruefen(
      { zeitpunkt: A10_AM, endstand: 'sechs', einheit: 'kWh', einstellungenPruefen: true }, JETZT,
    ).fehler).toBe(KARTENWECHSEL_SAETZE.endstand_zahl);
    expect(kartenwechselPruefen(
      { zeitpunkt: A10_AM, endstand: '-1', einheit: 'kWh', einstellungenPruefen: true }, JETZT,
    ).fehler).toBe(KARTENWECHSEL_SAETZE.endstand_zahl);
    expect(kartenwechselPruefen(
      { zeitpunkt: A10_AM, endstand: '10', einheit: null, einstellungenPruefen: true }, JETZT,
    ).fehler).toBe(KARTENWECHSEL_SAETZE.endstand_ohne_einheit);
    expect(kartenwechselPruefen(
      { zeitpunkt: null, endstand: '', einheit: 'kWh', einstellungenPruefen: true }, JETZT,
    ).fehler).toBe(KARTENWECHSEL_SAETZE.zeitpunkt_fehlt);
  });

  it('die Folgen sagen: Gerät bleibt, nichts gelöscht, kein Verbrauch aus dem Sprung', () => {
    const { body } = kartenwechselPruefen(
      { zeitpunkt: A10_AM, endstand: '6.184,37', einheit: 'kWh', einstellungenPruefen: true }, JETZT,
    );
    const saetze = kartenwechselFolgen(body!, karte({ kartenwechsel: A10_AM, anwenderskalierung: null }), ZONE);
    const text = saetze.join(' ');
    expect(text).toContain('das Gerät bleibt dasselbe');
    expect(text).toContain('Nichts wurde gelöscht');
    expect(text).toContain('zählt nicht als Verbrauch');
    expect(text).toContain('6.184,37 kWh');
    expect(text).toContain(HEBEL_TITEL);
    // Kein Steuer- und kein Geldwort in einem Satz über eine Messeinrichtung.
    expect(text).not.toMatch(/€|Euro|Kosten|Erlös|schalt|steuer/i);
  });
});

describe('A10 · der Hebel erscheint NUR aus Belegen', () => {
  it('ohne eingetragenen Kartentausch gibt es ihn nicht — auch ohne Angabe zur Skalierung', () => {
    expect(kartenHebel(karte({ anwenderskalierung: null, kartenwechsel: null }), ZONE)).toBeNull();
  });

  it('mit Kartentausch UND fehlender Angabe erscheint er, mit dem Zeitpunkt des Belegs', () => {
    const h = kartenHebel(karte({ anwenderskalierung: null, kartenwechsel: A10_AM }), ZONE);
    expect(h?.titel).toBe(HEBEL_TITEL);
    expect(h?.satz).toContain('20.03.2027');
    expect(h?.satz).toContain('nicht erfasst');
  });

  it('ist die Angabe erhoben, verschwindet er — ohne dass jemand etwas abhakt', () => {
    expect(kartenHebel(karte({ anwenderskalierung: true, kartenwechsel: A10_AM }), ZONE)).toBeNull();
    expect(kartenHebel(karte({ anwenderskalierung: false, kartenwechsel: A10_AM }), ZONE)).toBeNull();
  });

  it('ohne Karte gibt es weder Hebel noch Fläche', () => {
    expect(kartenHebel(null, ZONE)).toBeNull();
  });
});

describe('gefragt wird nur, wo Kartenangaben überhaupt sein können', () => {
  it('nur der Hersteller WAGO — Schreibweise egal, aber nie geraten', () => {
    expect(kannKartenangabenHaben('WAGO')).toBe(true);
    expect(kannKartenangabenHaben(' wago ')).toBe(true);
    expect(kannKartenangabenHaben('Janitza')).toBe(false);
    expect(kannKartenangabenHaben('')).toBe(false);
    expect(kannKartenangabenHaben(null)).toBe(false);
    expect(kannKartenangabenHaben(undefined)).toBe(false);
  });
});

describe('die dokumentierten Angaben behaupten nichts', () => {
  it('fehlend bleibt sichtbar fehlend und wird nie eine Null oder ein Faktor', () => {
    const zeilen = kartenAngaben(karte({ slot: null, anwenderskalierung: null, register35: null }));
    expect(zeilen.every((z) => z.includes('nicht erfasst'))).toBe(true);
    expect(zeilen.join(' ')).not.toMatch(/: 0\b|Faktor 1\b/);
  });

  it('nennt eingeschaltet und ausgeschaltet mit ihrer Bedeutung', () => {
    expect(kartenAngaben(karte({ anwenderskalierung: true }))[1]).toContain('rechnet den Wandler selbst um');
    expect(kartenAngaben(karte({ anwenderskalierung: false }))[1]).toContain('ohne den Wandler');
  });
});
