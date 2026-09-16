/**
 * Die Antworten der Werte-Route für den VERGLEICH (UEMS AP-13 IP-5) — die Fälle **O11** und **O12** des Reports.
 *
 * O11: MS-12 (Montage Linie M1) November 2026 6 300 kWh gegen Oktober 2026 6 040 kWh in **Version 2** (korrigiert) =
 * +260 kWh (+4,3 %); MS-10 (Netzbezug Halle 2) 35 800 gegen 36 900 = −1 100 kWh (−3,0 %); der Vorjahresmonat November
 * 2025 liegt vor dem Bestehen — keine Werte, keine leere Kurve.
 *
 * O12: MS-06 (Spritzguss SG01–SG06) 55 100 kWh und MS-11 (Spritzguss SG07–SG10) 22 400 kWh im Oktober 2026
 * nebeneinander; MS-04 (Laden / Entladen), MS-21 (Volumen in m³) und MS-03 (Erzeugung) passen nicht.
 *
 * Die Zahlen sind die Annahmen aus AP-12 B6 bzw. die des Referenzunternehmens (Fassung 1.1); die Form der Schritte ist
 * die von `werteKarteFixtures` — ein Fixture erfindet nie ein Feld, das die Route nicht liefert.
 */
import type { MessstelleWerte, MessstelleWerteWert } from '../api';
import { MS_06, MS_10, antwort, schritt, stundenDes, tagSchritt, tagesgrenzen, voll } from './werteKarteFixtures';
import { stundenDesTages } from '../bezugsPeriode';
import { verschiebe } from '../picker/datum';

type Messstelle = MessstelleWerte['messstelle'];

export const MS_11: Messstelle = { ...MS_06, id: '6a0e1d4c-0000-4000-8000-000000000011', kennzeichen: 'MS-11', name: 'Spritzguss SG07–SG10' };
export const MS_12: Messstelle = { ...MS_06, id: '6a0e1d4c-0000-4000-8000-000000000012', kennzeichen: 'MS-12', name: 'Montage Linie M1' };

/** Die Grenzen eines Kalendermonats in der Zone des Standorts, so wie die Route sie schreibt. */
const monatsgrenzen = (monat: string): { von: string; bis: string } => {
  const [j, m] = monat.split('-').map(Number);
  const naechster = m === 12 ? `${j + 1}-01-01` : `${j}-${String(m + 1).padStart(2, '0')}-01`;
  return { von: tagesgrenzen(`${monat}-01`).von, bis: tagesgrenzen(naechster).von };
};

const stundenIm = (monat: string): number => {
  const { von, bis } = monatsgrenzen(monat);
  return Math.round((Date.parse(bis) - Date.parse(von)) / 3_600_000);
};

/**
 * Die Karte eines Monats: EIN Schritt, vollständig aus Ständen gebildet. `version` = die gelieferte Fassung der Zahl,
 * `versionen` = wie viele es gibt (ab 2 trägt die Karte „korrigiert“).
 */
export const monatKarte = (
  messstelle: Messstelle,
  monat: string,
  menge: number,
  { version = 1, versionen = 1, fassung = 'endgueltig' as MessstelleWerteWert['fassung'] } = {},
): MessstelleWerte => {
  const g = monatsgrenzen(monat);
  const stunden = stundenIm(monat);
  return antwort(messstelle, 'monat', g.von, g.bis, [
    schritt({ ...g, stunden, gebildet_aus: 'monat', ...voll(menge, stunden * 4), fassung, version, versionen }),
  ]);
};

/**
 * Die Tage eines Monats: die Monatsmenge über die Tage verteilt, mit dem Wochen-Gang eines Werks (am Wochenende
 * `wochenende` der Werktagslast) und den Stunden des Tages — die SUMME bleibt die Monatsmenge, damit Karte und Liste
 * einander nicht widersprechen. Das Bild der Reihe, nicht ihre Aussage.
 */
export const monatTage = (messstelle: Messstelle, monat: string, menge: number, wochenende = 0.55): MessstelleWerte => {
  const g = monatsgrenzen(monat);
  const erster = `${monat}-01`;
  const tage: string[] = [];
  for (let t = erster; t.slice(0, 7) === monat; t = verschiebe(t, 1)) tage.push(t);
  const gewicht = (tag: string): number => {
    const [j, m, d] = tag.split('-').map(Number);
    const wochentag = new Date(Date.UTC(j, m - 1, d)).getUTCDay();
    return (stundenDesTages(tag, 'Europe/Berlin') / 24) * (wochentag === 0 || wochentag === 6 ? wochenende : 1);
  };
  const summe = tage.reduce((t, tag) => t + gewicht(tag), 0);
  return antwort(
    messstelle,
    'tag',
    g.von,
    g.bis,
    tage.map((tag) => {
      const h = stundenDesTages(tag, 'Europe/Berlin');
      return tagSchritt(tag, { ...voll(Math.round((menge * gewicht(tag) * 1000) / summe) / 1000, h * 4), fassung: 'endgueltig' });
    }),
  );
};

/** Ein Monat ganz VOR dem Bestehen der Messstelle: keine Bindung, jeder Schritt „keine Werte“ mit `keine_quelle`. */
export const monatOhneQuelle = (messstelle: Messstelle, monat: string): MessstelleWerte => {
  const g = monatsgrenzen(monat);
  return antwort(
    messstelle,
    'monat',
    g.von,
    g.bis,
    [
      schritt({
        ...g,
        stunden: stundenIm(monat),
        zustand: 'keine Werte',
        grund: 'keine_quelle',
        quelle: null,
        fassung: null,
        version: null,
        versionen: null,
        gebildet_aus: null,
      }),
    ],
    false,
  );
};

// ------------------------------------------------------------------ O11 · MS-12 und MS-10, November gegen Oktober

/** MS-12 · November 2026: 6 300 kWh, vollständig, endgültig. */
export const ms12November = (): MessstelleWerte => monatKarte(MS_12, '2026-11', 6300);

/** MS-12 · Oktober 2026: 6 040 kWh in Version 2 — der Vergleichswert trägt seine Fassung (O11). */
export const ms12Oktober = (): MessstelleWerte => monatKarte(MS_12, '2026-10', 6040, { version: 2, versionen: 2 });

/** MS-10 · November 2026: 35 800 kWh. */
export const ms10November = (): MessstelleWerte => monatKarte(MS_10, '2026-11', 35800);

/** MS-10 · Oktober 2026: 36 900 kWh, Version 1 — ohne Zusatz an der Δ-Zeile. */
export const ms10Oktober = (): MessstelleWerte => monatKarte(MS_10, '2026-10', 36900);

/** MS-12 · November 2025: vor dem Bestehen — die Route antwortet ohne Bindung und ohne Zahl. */
export const ms12Vorjahr = (): MessstelleWerte => monatOhneQuelle(MS_12, '2025-11');

/** Die Tage des Novembers und des Oktobers an MS-12 — die zwei Reihen der Überlagerung. */
export const ms12NovemberTage = (): MessstelleWerte => monatTage(MS_12, '2026-11', 6300);
export const ms12OktoberTage = (): MessstelleWerte => monatTage(MS_12, '2026-10', 6040, 0.35);

// ------------------------------------------------------------------ O12 · MS-06 neben MS-11

/** MS-11 · Oktober 2026: 22 400 kWh (O12). */
export const ms11Oktober = (): MessstelleWerte => monatKarte(MS_11, '2026-10', 22400, { fassung: 'vorlaeufig' });
export const ms11OktoberTage = (): MessstelleWerte => monatTage(MS_11, '2026-10', 22400, 0.3);

/** MS-11 · November 2026 — für die Δ-Zeile der zweiten Reihe gegen IHRE Vorperiode (VG4). */
export const ms11November = (): MessstelleWerte => monatKarte(MS_11, '2026-11', 21500);

/** Die Stunden eines Tages an einer beliebigen Reihe — für die Überlagerung im Zeitraum „Tag“. */
export const tagStunden = (messstelle: Messstelle, tag: string, jeStunde: number): MessstelleWerte => {
  const g = tagesgrenzen(tag);
  return antwort(messstelle, 'stunde', g.von, g.bis, stundenDes(tag, () => voll(jeStunde, 60)));
};

/** Die Karte eines Tages. */
export const tagKarte = (messstelle: Messstelle, tag: string, menge: number): MessstelleWerte => {
  const g = tagesgrenzen(tag);
  const h = stundenDesTages(tag, 'Europe/Berlin');
  return antwort(messstelle, 'tag', g.von, g.bis, [tagSchritt(tag, { ...voll(menge, h * 60), fassung: 'endgueltig' })]);
};
