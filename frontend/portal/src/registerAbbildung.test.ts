import { describe, expect, it } from 'vitest';
import {
  groesseAus,
  kategorieWort,
  richtungAus,
  wertartAus,
} from './registerAbbildung';

/**
 * Der Frontend-Zwilling von `MesskanalAbbildung.java` - die Vertrags-Tabellen
 * sind zeichengleich; ein Katalogwort ohne Vertragswort ergibt `null` (nie ein
 * geratenes Nachbarwort). `kategorieWort` ist die reine Anzeige-Erweiterung.
 */
describe('registerAbbildung: die Katalogwörter in Vertragswörter', () => {
  it('groesseAus bildet nur die fünf summierbaren Messgrößen ab, sonst null', () => {
    expect(groesseAus('active_power')).toBe('Wirkleistung');
    expect(groesseAus('active_energy')).toBe('Wirkenergie');
    expect(groesseAus('reactive_energy')).toBe('Blindenergie');
    expect(groesseAus('apparent_power')).toBe('Scheinleistung');
    expect(groesseAus('soc')).toBe('Ladestand');
    // Spannung/Strom/Temperatur/Frequenz tragen KEINE Vertrags-Größe.
    expect(groesseAus('voltage')).toBeNull();
    expect(groesseAus('temperature')).toBeNull();
    expect(groesseAus('reactive_power')).toBeNull();
    expect(groesseAus(null)).toBeNull();
    expect(groesseAus('gibt_es_nicht')).toBeNull();
  });

  it('richtungAus bildet die Richtungen ab; ein richtungsloser Kanal bleibt null', () => {
    expect(richtungAus('generation')).toBe('Erzeugung');
    expect(richtungAus('import')).toBe('Bezug');
    expect(richtungAus('export')).toBe('Abgabe');
    expect(richtungAus('charge_discharge')).toBe('Laden / Entladen');
    expect(richtungAus('none')).toBe('richtungslos');
    expect(richtungAus('import_export')).toBe('richtungslos');
    // Der Gen-Port: der Katalog gibt gar keine Richtung.
    expect(richtungAus(null)).toBeNull();
    expect(richtungAus('gibt_es_nicht')).toBeNull();
  });

  it('wertartAus bildet gauge/counter auf die Vertragswörter ab; alles andere ist keine', () => {
    // Die Wörter des Formel-Modells (uemsMessstelle GROESSEN_KATALOG.wertarten),
    // NICHT die rohen gauge/counter - sonst würde der Summen-Guard „gemischt".
    expect(wertartAus('gauge')).toBe('Momentanwert');
    expect(wertartAus('counter')).toBe('Zählerstand');
    // Zustand/Text/Merker/Ereignis tragen keinen summierbaren Zahlenwert.
    expect(wertartAus('state')).toBeNull();
    expect(wertartAus('text')).toBeNull();
    expect(wertartAus('bitfield')).toBeNull();
    expect(wertartAus('event')).toBeNull();
    expect(wertartAus('none')).toBeNull();
    expect(wertartAus(null)).toBeNull();
  });

  it('kategorieWort nennt die Größe, sonst die rohe Messgröße, sonst die Wertart', () => {
    expect(kategorieWort('active_power', 'gauge')).toBe('Wirkleistung');
    expect(kategorieWort('voltage', 'gauge')).toBe('Spannung');
    expect(kategorieWort('temperature', 'gauge')).toBe('Temperatur');
    expect(kategorieWort('current', 'gauge')).toBe('Strom');
    expect(kategorieWort('power_factor', 'gauge')).toBe('Leistungsfaktor');
    // Kein Zahlenwert: die Art des Werts trägt das Wort.
    expect(kategorieWort(null, 'state')).toBe('Zustand');
    expect(kategorieWort(null, 'text')).toBe('Text');
    // Unbekannt → gar kein Vorwort, nie ein geratenes.
    expect(kategorieWort(null, 'none')).toBeNull();
    expect(kategorieWort(null, null)).toBeNull();
  });
});
