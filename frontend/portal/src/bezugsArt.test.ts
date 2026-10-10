import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALLE,
  EINHEIT_DER_MESSSTELLE,
  einheitenDer,
  geltungDer,
  herkunftDer,
  periodenDer,
  pruefen,
  type Art,
  type ArtEingang,
  type Vokabular,
} from './bezugsArt';

/**
 * Das Modul der ARTEN (UEMS AP-09 §4.2) gegen den Block `arten` der geteilten
 * Vektor-Datei `docs/contracts/v2/bezugsdaten-vectors.json`. Der Java-Zwilling
 * `BezugsArtTest` fährt dieselbe Datei — beide grün heißt: dieselbe Antwort auf
 * jede Prüfung. Die Schema-Treue des Blocks prüft `bezugsdaten.test.ts`.
 */

type Json = any;

const V2 = resolve(process.cwd(), '../../docs/contracts/v2');
const lies = (datei: string): Json => JSON.parse(readFileSync(resolve(V2, datei), 'utf8'));
const vectors: Json = lies('bezugsdaten-vectors.json');
const referenz: Json = lies('uems-referenzunternehmen.json');

const arten = vectors.arten.je_art as Record<string, Art>;
const pruefungen = vectors.arten.pruefungen as Array<{
  name: string;
  art: string;
  beispiel: string | null;
  eingang: ArtEingang;
  ergebnis: { abweichend: string[] };
  hinweis?: string;
}>;
const vok: Vokabular = {
  wertart: vectors.vokabulare.wertart,
  geltung_art: vectors.vokabulare.geltung_art,
  periode_art: vectors.vokabulare.periode_art,
  herkunft_art: vectors.vokabulare.herkunft_art,
  einheiten: vectors.einheiten,
};
const alleEinheiten = Object.values(vok.einheiten).flat();

describe('bezugsArt — jede Art spricht nur Wörter der vorhandenen Vokabulare', () => {
  it('das Vokabular der Arten ist nicht leer', () => {
    expect(Object.keys(arten).length).toBeGreaterThan(0);
  });

  for (const [wort, art] of Object.entries(arten)) {
    it(`${wort} · ${art.name}`, () => {
      expect(art.name.trim()).not.toBe('');
      if (Array.isArray(art.einheiten)) {
        expect(art.einheiten.length).toBeGreaterThan(0);
        expect(new Set(art.einheiten).size).toBe(art.einheiten.length);
        // Die Einheiten fragt das Modul bei bezugsEinheit an — keine fällt heraus.
        expect(einheitenDer(art, vok.einheiten, null)).toEqual(art.einheiten);
      } else {
        expect([ALLE, EINHEIT_DER_MESSSTELLE]).toContain(art.einheiten);
      }
      expect(vok.wertart).toContain(art.wertart);
      expect(new Set(art.perioden).size).toBe(art.perioden.length);
      expect(periodenDer(art, vok.periode_art)).toEqual(art.perioden);
      // Nur ein Periodenwert hat Perioden (M1).
      expect(art.perioden.length === 0).toBe(art.wertart !== 'periodenwert');
      if (Array.isArray(art.geltung)) {
        expect(art.geltung.length).toBeGreaterThan(0);
        expect(new Set(art.geltung).size).toBe(art.geltung.length);
        expect(geltungDer(art, vok.geltung_art)).toEqual(art.geltung);
      } else {
        expect(art.geltung).toBe(ALLE);
      }
      expect(art.herkunft.length).toBeGreaterThan(0);
      expect(new Set(art.herkunft).size).toBe(art.herkunft.length);
      expect(herkunftDer(art, vok.herkunft_art)).toEqual(art.herkunft);
    });
  }
});

describe('bezugsArt — die Prüfungen der Datei', () => {
  for (const p of pruefungen) {
    it(p.name, () => {
      expect(pruefen(p.art, p.eingang, arten, vok)).toEqual(p.ergebnis.abweichend);
    });
  }
});

describe('bezugsArt — die Zusagen ohne eigene Prüfung', () => {
  it('die Beispiele sind GENAU die Bezugsgrößen des Referenzunternehmens und passen zu ihrer Art', () => {
    const je = new Map<string, Json>((referenz.bezugsgroessen as Json[]).map((b) => [b.kennzeichen, b]));
    const beispiele = new Set<string>();
    for (const p of pruefungen) {
      if (p.beispiel === null) continue;
      beispiele.add(p.beispiel);
      const b = je.get(p.beispiel);
      expect(b, `${p.beispiel} im Referenzunternehmen`).toBeDefined();
      expect(p.ergebnis.abweichend, `${p.beispiel} passt zu seiner Art`).toEqual([]);
      expect(p.eingang.einheit).toBe(b.einheit_code);
      expect(p.eingang.periode_art).toBe(b.periode_code);
      expect(p.eingang.wertart).toBe(b.wertart);
      if (b.geltung_art !== p.eingang.geltung_art) {
        expect(p.hinweis ?? '', `${p.beispiel}: die Abweichung nennt ihren Grund`).toContain(`„${b.geltung_art}“`);
      }
    }
    expect([...beispiele].sort()).toEqual([...je.keys()].sort());
  });

  it('eine Einheit, die die Art nicht führt, passt nicht — auch wenn sie im Vokabular steht', () => {
    let abgelehnt = 0;
    for (const [wort, art] of Object.entries(arten)) {
      const messstelle = art.einheiten === EINHEIT_DER_MESSSTELLE ? alleEinheiten[0] : null;
      const gefuehrt = einheitenDer(art, vok.einheiten, messstelle);
      expect(gefuehrt.length, `${wort} führt Einheiten`).toBeGreaterThan(0);
      for (const einheit of alleEinheiten) {
        const eingang: ArtEingang = {
          wertart: art.wertart,
          geltung_art: geltungDer(art, vok.geltung_art)[0],
          einheit,
          periode_art: art.perioden[0] ?? null,
          herkunft_art: art.herkunft[0],
          einheit_der_messstelle: messstelle,
        };
        const soll = gefuehrt.includes(einheit) ? [] : ['einheit'];
        expect(pruefen(wort, eingang, arten, vok), `${wort} in ${einheit}`).toEqual(soll);
        abgelehnt += soll.length;
      }
    }
    expect(abgelehnt).toBeGreaterThan(0);
  });

  it('keine zweite Liste: das Modul nennt keine Art und kein Wort eines Vokabulars', () => {
    const quelle = readFileSync(resolve(process.cwd(), 'src/bezugsArt.ts'), 'utf8');
    const woerter = new Set<string>([
      ...Object.keys(arten),
      ...Object.values(arten).map((a) => a.name),
      ...alleEinheiten,
      ...vok.wertart,
      ...vok.geltung_art,
      ...vok.periode_art,
      ...vok.herkunft_art,
    ]);
    // Die beiden Verweise der Datei sind Wörter des Moduls; „messstelle" ist zugleich ein Geltungsbereich.
    woerter.delete(ALLE);
    woerter.delete(EINHEIT_DER_MESSSTELLE);
    for (const wort of woerter) {
      expect(quelle.includes(`'${wort}'`) || quelle.includes(`"${wort}"`), `bezugsArt.ts nennt „${wort}"`).toBe(false);
    }
  });
});
