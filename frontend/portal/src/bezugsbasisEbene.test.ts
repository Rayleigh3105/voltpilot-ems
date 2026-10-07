import { describe, expect, it } from 'vitest';
import * as Bz from './bezugsbasisEbene';
import { bb1Seite } from './test/kennzahlSeiteFixtures';

/** Die Bezugsbasis eine Ebene unter der Kennzahl (Konzept Auswerten a1 §6.6) - Kopf, Status, Antwort, Fassungen. */
describe('die Ebene der Bezugsbasis', () => {
  const { basis, fassungen } = bb1Seite();
  const f2 = fassungen[1];

  it('Kopf und Statuszeile: „Gilt seit 01.11.2027 · nächste Überprüfung bis 30.04.2030“', () => {
    expect(Bz.ebenenKopf({ name: 'Stromeinsatz Spritzguss je kg' }, basis)).toEqual({
      titel: 'Bezugsbasis',
      kennzeichen: 'BB-0001',
      unter: 'Womit Stromeinsatz Spritzguss je kg verglichen wird - und seit wann',
    });
    expect(Bz.statusZeile(basis, f2, '2029-04-01')).toEqual({ ton: 'ok', text: 'Gilt seit 01.11.2027', leise: 'nächste Überprüfung bis 30.04.2030' });
    expect(Bz.statusZeile(basis, f2, '2026-10-01')?.text).toBe('Gilt ab 01.11.2027');
    expect(Bz.statusZeile({ ...basis, frist: { ueberpruefung_faellig: true, faellig_am: '2029-04-01', faellig_seit_tagen: 29, wiedervorlage_monate: 12 } }, f2, '2029-04-01'))
      .toEqual({ ton: 'warn', text: 'Gilt seit 01.11.2027', leise: 'Überprüfung seit 01.04.2029 fällig' });
    expect(Bz.statusZeile({ ...basis, beendet_zum: '2029-06-30', beendet_grund: 'Linie umgebaut' }, f2, '2029-07-01')).toEqual({
      ton: 'aus', text: 'Beendet zum 30.06.2029', leise: 'Linie umgebaut',
    });
  });

  it('die Fassung am Stichtag: die geltende, vor der ersten die nächste, sonst die der Basis-Zeile', () => {
    // Bühnen-Uhr (April 2029): Fassung 2 gilt; echte Uhr der Demo (Oktober 2026): als Nächstes gilt Fassung 1.
    expect(Bz.fassungAm(basis, '2029-04-01')?.fassung).toBe(2);
    expect(Bz.fassungAm(basis, '2026-10-01')?.fassung).toBe(1);
    expect(Bz.fassungAm(basis, '2027-03-01')?.fassung).toBe(1);
    expect(Bz.fassungAm(basis, '2027-11-01')?.fassung).toBe(2);
    // Ohne freigegebene Fassung die der Basis-Zeile (der jüngste Entwurf).
    const entwurf = { ...basis, fassungen: basis.fassungen.map((f) => ({ ...f, freigabe_status: 'entwurf' as const })) };
    expect(Bz.fassungAm(entwurf, '2029-04-01')?.fassung).toBe(2);
    // Die Statuszeile spricht von derselben Fassung.
    expect(Bz.statusZeile(basis, fassungen[0], '2026-10-01')?.text).toBe('Gilt ab 01.11.2026');
  });

  it('der Antwortsatz: der Basiswert ohne das Wort der Methode, darunter Fassung · Methode · Vergleichszeitraum', () => {
    expect(Bz.ebenenAntwort(f2, 'kWh je kg')).toEqual({
      satz: 'VoltPilot erwartet 0,2837 kWh je kg - so viel wie im Oktober 2026.',
      formal: 'Fassung 2 · Verhältnis · Vergleichszeitraum Oktober 2026',
    });
    // Ohne Basiswert („leer, nie 0“) ein Satz statt einer Zahl; ein Modell nennt seine Methode und die Koeffizienten.
    expect(Bz.ebenenAntwort({ ...f2, basiswert: null }, 'kWh je kg').satz).toBe('Diese Fassung hat keinen Basiswert - VoltPilot rechnet mit ihr keinen erwarteten Wert.');
    const modell = Bz.ebenenAntwort({ ...f2, methode: 'regression_eine_variable', referenzperiode: '2024-11/2025-10', koeffizienten: { a: '10523', b: '0.2343' }, streuung_prozent: '0.8' }, 'kWh je kg');
    expect(modell.satz).toBe('VoltPilot rechnet die Erwartung nach der Methode „Modell mit einer Einflussgröße“, gebildet aus November 2024 bis Oktober 2025.');
    expect(modell.formal).toContain('10 523 kWh Grundlast + 0,2343 kWh je kg');
  });

  it('vorläufig mit Grund und dem, was sie belastbar macht', () => {
    expect(Bz.vorlaeufigSatz(f2)).toEqual({ fett: 'Vorläufig:', satz: 'gebildet aus 1 von 12 Monaten. Belastbar wird sie mit zwölf Monaten; dann lohnt eine neue Fassung.' });
    expect(Bz.vorlaeufigSatz({ ...f2, datenlage: 'vollstaendig' })).toBeNull();
  });

  it('die Fassungen als Datumsblöcke: „seit 01.11. 2027 · Fassung 2 · gilt“, „bis 31.10. 2027 · Fassung 1 · abgelöst“', () => {
    expect(Bz.fassungZeile({ ...f2, gilt_bis: null }, 'freigegeben', 'freigegeben von Ines Kaltenbach am 25.11.2027', '2029-04-01')).toEqual({
      datum: { wort: 'seit', tag: '01.11.', jahr: '2027' },
      titel: 'Fassung 2 · gilt',
      warum: 'Grund: Referenzperiode vervollständigt · freigegeben von Ines Kaltenbach am 25.11.2027',
    });
    expect(Bz.fassungZeile({ ...fassungen[0], gilt_bis: '2027-10-31' }, 'beendet', null, '2029-04-01')).toEqual({
      datum: { wort: 'bis', tag: '31.10.', jahr: '2027' },
      titel: 'Fassung 1 · abgelöst',
      warum: 'galt vom 01.11.2026 bis 31.10.2027',
    });
    expect(Bz.fassungZeile({ ...f2, gilt_bis: null, freigabe_status: 'abgelehnt' }, 'abgelehnt', null, '2029-04-01').datum).toBeNull();
    // Zur echten Uhr der Demo (Oktober 2026): Fassung 2 gilt künftig („ab“), Fassung 1 ebenso - nie „abgelöst“ vor ihrem Ende.
    expect(Bz.fassungZeile({ ...f2, gilt_bis: null }, 'freigegeben', null, '2026-10-01')).toMatchObject({ datum: { wort: 'ab' }, titel: 'Fassung 2 · gilt künftig' });
    expect(Bz.fassungZeile({ ...fassungen[0], gilt_bis: '2027-10-31' }, 'beendet', null, '2027-03-01')).toEqual({
      datum: { wort: 'seit', tag: '01.11.', jahr: '2026' },
      titel: 'Fassung 1 · gilt',
      warum: 'gilt vom 01.11.2026 bis 31.10.2027',
    });
  });

  it('die Überprüfung fragt nach dem letzten Bestätigen - sonst nach der Freigabe', () => {
    expect(Bz.zuletztSatz(basis, f2)).toBe('Zuletzt bestätigt am 30.04.2029. Ist sie noch die richtige Messlatte?');
    expect(Bz.zuletztSatz({ frist: null }, f2)).toBe('Freigegeben am 25.11.2027. Ist sie noch die richtige Messlatte?');
  });
});
