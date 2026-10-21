/**
 * Fiktive Beispielwerte für das Cockpit einer Erzeugeranlage (Konzept „Erzeuger am WAGO-Modbus-Server“,
 * Bilder Cockpit Telefon 375 px und Rechner 1440 px; alle Zahlen sind Beispiele). Zwei Fälle wie im
 * Konzept (Namen fiktiv): Büttner (Biogas-BHKW, 2 Motoren, Netzbetreiber begrenzt 60 %, Direktvermarkter ruft 80 kW
 * ab, kein Netzpunkt nach EW-16 C) und Gore (PV, 3 Wechselrichter, Nulleinspeisung, Leitstelle
 * getrennt). Zeiten liegen relativ zu `now`, damit Tests und Bühnen mit fester Uhr dasselbe sehen.
 * Nur für Tests und `e2e/` - nie aus Produktionscode importieren.
 */
import { einheitPunkt, ERZEUGER_PUNKT as P, type ErzeugerJetzt, type ErzeugerWert } from '../erzeuger';

export type ErzeugerFall = 'buettner' | 'gore';

export function erzeugerBeispiel(fall: ErzeugerFall, now: Date): ErzeugerJetzt {
  const vor = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  const mitternacht = new Date(now);
  mitternacht.setHours(0, 0, 0, 0);
  // Gelesen vor 3 s; „seit“ zählt ab der Lesung (Lesezeit − `…_seit_s`, §4.6), deshalb die − 3 unten.
  const gelesen = new Date(now.getTime() - 3000).toISOString();
  const werte: Record<string, ErzeugerWert> = {};
  const setze = (key: string, wert: number | null) => {
    werte[key] = { wert, gelesenAm: gelesen, qualitaet: wert == null ? 'invalid' : 'good' };
  };
  const einheit = (n: number, art: 1 | 2, nennKw: number, istKw: number, sollKw: number, zustand: number, bits: number) => {
    setze(einheitPunkt(n, 'art'), art);
    setze(einheitPunkt(n, 'nenn_kw'), nennKw);
    setze(einheitPunkt(n, 'p_ist_w'), istKw * 1000);
    setze(einheitPunkt(n, 'p_soll_w'), sollKw * 1000);
    setze(einheitPunkt(n, 'zustand'), zustand);
    setze(einheitPunkt(n, 'bits'), bits);
  };

  if (fall === 'buettner') {
    setze(P.anlagenart, 2);
    setze(P.teAnzahl, 2);
    // Bit 3 Erzeugung, Bit 4 Gasspeicher gültig; kein Netzpunkt (EW-16 C, Lesart 10).
    setze(P.aGueltig, 0b11000);
    setze(P.pNvpW, null);
    setze(P.pErzeugungW, 58_900);
    setze(P.anlageZustand, 3);
    setze(P.aBits, 0);
    setze(P.speicherFuellstand, 62);
    setze(P.pInstalliertKw, 99);
    setze(P.nbKanal, 2);
    setze(P.nbBits, 0b111);
    setze(P.nbProzent, 60);
    setze(P.nbSeitS, 72 * 60 - 3);
    setze(P.dvKanal, 1);
    setze(P.dvBits, 0b11011);
    setze(P.dvSollW, 80_000);
    setze(P.dvSeitS, 159 * 60 - 3);
    setze(P.quelleP, 1);
    setze(P.sBits, 0b11);
    setze(P.pGrenzeW, 59_400);
    einheit(1, 2, 66, 39.6, 39.6, 3, 0b1111);
    einheit(2, 2, 33, 19.3, 19.8, 3, 0b1111);
    return {
      steuerung: { geraetId: 'help-wago', name: 'Wago' },
      netzbetreiber: 'Netz Musterstadt GmbH',
      direktvermarkter: 'Stadtwerke Beispiel',
      einheiten: [
        { teNr: 1, art: 'bhkw', typName: 'MAN E0836LE', nennKw: 66 },
        { teNr: 2, art: 'bhkw', typName: 'Smartblock 33', nennKw: 33 },
      ],
      werte,
      wechselHeute: {
        [P.nbBits]: [{ ab: mitternacht.toISOString(), wert: 0b011 }, { ab: vor(340), wert: 0b111 }, { ab: vor(265), wert: 0b011 }, { ab: vor(72), wert: 0b111 }],
        [P.dvBits]: [{ ab: mitternacht.toISOString(), wert: 0b01001 }, { ab: vor(159), wert: 0b11011 }],
        [P.quelleP]: [{ ab: mitternacht.toISOString(), wert: 0 }, { ab: vor(340), wert: 1 }, { ab: vor(265), wert: 0 }, { ab: vor(159), wert: 2 }, { ab: vor(72), wert: 1 }],
      },
    };
  }

  setze(P.anlagenart, 1);
  setze(P.teAnzahl, 3);
  // Bit 0 Netzpunkt gültig, Bit 3 Erzeugung gültig.
  setze(P.aGueltig, 0b01001);
  setze(P.pNvpW, 100);
  setze(P.pErzeugungW, 41_000);
  setze(P.anlageZustand, 3);
  setze(P.aBits, 0);
  setze(P.speicherFuellstand, null);
  setze(P.pInstalliertKw, 265);
  setze(P.nbKanal, 3);
  // Vorgabe gültig, aber die Verbindung zur Leitstelle steht nicht (Bit 1 = 0): 100 % gehalten.
  setze(P.nbBits, 0b001);
  setze(P.nbProzent, 100);
  setze(P.nbSeitS, 12 * 60 - 3);
  setze(P.dvKanal, 0);
  setze(P.dvBits, 0);
  setze(P.quelleP, 3);
  setze(P.sBits, 0b11);
  setze(P.pGrenzeW, 41_200);
  einheit(1, 1, 125, 14.1, 14.2, 3, 0b11);
  einheit(2, 1, 125, 13.6, 13.7, 3, 0b11);
  einheit(3, 1, 125, 13.3, 13.3, 3, 0b11);
  return {
    steuerung: { geraetId: 'help-wago', name: 'Wago' },
    netzbetreiber: 'Netz Musterstadt GmbH',
    direktvermarkter: null,
    einheiten: [1, 2, 3].map((teNr) => ({ teNr, art: 'pv' as const, typName: 'Growatt', nennKw: 125 })),
    werte,
    wechselHeute: {
      [P.nbBits]: [{ ab: mitternacht.toISOString(), wert: 0b011 }, { ab: vor(12), wert: 0b001 }],
      [P.dvBits]: [{ ab: mitternacht.toISOString(), wert: 0 }],
      [P.quelleP]: [{ ab: mitternacht.toISOString(), wert: 0 }, { ab: vor(300), wert: 3 }],
    },
  };
}
