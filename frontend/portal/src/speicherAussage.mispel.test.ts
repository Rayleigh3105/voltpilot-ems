import { describe, expect, it } from 'vitest';
import type { SiteEarnings } from './api';
import { speicherSchritte, speicherWert } from './erloesEbenen';
import { mehrwertBand } from './erloeseSeite';
import { haendlerModus, mispelGutschrift, type MispelMonat } from './mispelMengen';
import { preisVergleich } from './preisVergleich';
import {
  NETZLADEN_MISPEL_AB_KWH,
  speicherAussage,
  type SpeicherEingabe,
} from './speicherAussage';
import VEKTOREN from './speicherAussage.vektoren.json';

/**
 * **MiSpeL MP-18c — die Speicher-Erklärung an MiSpeL-Anlagen** (Bedienkonzept
 * BK-W5, Variante A, Captain 04.10.2026 „w5 vote do A“).
 *
 * An einem MiSpeL-Tag mit Netzladen ins Netz (Σ (1)¼ und Σ (2)¼ je ab 1 kWh,
 * Anlage 1 S. 33–34) heißt die Zahl „auf der Stromrechnung“, darunter steht
 * „Netzladen nach MiSpeL: … gespeichert, … ins Netz · Gutschrift offen“; nach
 * dem Monatslauf die Gutschrift (20) und im Monat die Summe. An jedem anderen
 * Tag, im Händler-Modus (außer dem Wort „geschätzt“) und an Anlagen ohne
 * MiSpeL bleibt jede Ausgabe Wort für Wort wie bisher — das prüft der
 * Bestandsschutz unten an jedem Fall der Vektordatei.
 */
const NB = new RegExp(String.fromCharCode(160), 'g');
const sp = (s: string | null | undefined) => (s == null ? null : s.replace(NB, ' '));

interface Fall {
  name: string;
  now: string;
  kontext?: Record<string, unknown>;
  money: SpeicherEingabe;
}
const FAELLE = (VEKTOREN as unknown as { faelle: Fall[] }).faelle;
const BESTAND = FAELLE.filter((f) => f.money.mispelNetzstromverbrauchSpeicherKwh == null);

/** Der Beispieltag des Bedienkonzepts: Kühlhaus Seebach, Mi. 17.11.2027, abgeschlossen. */
const SEEBACH: SiteEarnings = {
  ...(FAELLE.find((f) => f.name.startsWith('MiSpeL 17.11.2027 abgeschlossen'))!.money as object),
  actualEur: 93.98,
  arbitrageEur: 12.4,
} as unknown as SiteEarnings;
const NACH_DEM_TAG = new Date('2027-11-18T09:00:00+01:00');

describe('MP-18c · Schritte der Rechnung an einem Tag mit Netzladen nach MiSpeL', () => {
  const zeilen = speicherSchritte({
    money: SEEBACH,
    steuerungEur: -0.84,
    steuerungGeplantEur: 0.62,
    laeuft: false,
  });
  const text = zeilen.map((z) => `${z.formel} | ${z.herkunft}`);

  it('Schritt 3 heißt „auf der Stromrechnung“, Schritt 2 lädt nie aus dem Netz', () => {
    expect(sp(text.find((t) => t.startsWith('Schritt 3')))).toMatch(/^Schritt 3 · Steuerung auf der Stromrechnung: /);
    expect(text.find((t) => t.startsWith('Schritt 2'))).toContain('— lädt nie aus dem Netz');
  });

  it('Schritt 4 nennt (1)¼ und (2)¼ und die Gutschrift des Monats: offen', () => {
    const s4 = sp(text.find((t) => t.startsWith('Schritt 4')));
    expect(s4).toBe(
      'Schritt 4 · Netzladen nach MiSpeL | 312,0 kWh Netzstrom gespeichert ((1)¼), 214,6 kWh ins Netz ((2)¼), ' +
        'Gerätewerte. Schritt 1 bezahlt diesen Netzstrom mit Umlagen und Netzentgelt. Was davon zurückkommt, ' +
        'bestimmt Anlage 1 für den ganzen Kalendermonat: (13) − (15) = (16), daraus (20). Für November: offen.',
    );
  });

  it('kein Rückfall-Satz „anders geladen und entladen … nicht ausgezahlt“', () => {
    expect(text.join('\n')).not.toMatch(/anders geladen|nicht ausgezahlt/);
    // Auch wenn ein älterer Server den Rückfall noch schickte.
    const alt = speicherSchritte({
      money: { ...SEEBACH, steuerungGruende: ['anders_geladen'] },
      steuerungEur: -0.84,
      laeuft: false,
    });
    expect(alt.map((z) => z.herkunft).join('\n')).not.toMatch(/nicht ausgezahlt/);
  });

  it('der Fahrplan-Wert trägt „ohne MiSpeL-Gutschrift“', () => {
    const plan = zeilen.find((z) => z.formel.startsWith('Fahrplan'))!;
    expect(plan.herkunft).toContain('wie Schritt 3 ohne MiSpeL-Gutschrift');
  });

  it('nach dem Monatslauf steht die Gutschrift (20) in Schritt 4', () => {
    const z = speicherSchritte({
      money: SEEBACH,
      steuerungEur: -0.84,
      laeuft: false,
      mispelGutschrift: { monat: 'November', eur: 253.71, mengeKwh: 1926.667 },
    });
    expect(sp(z.find((r) => r.formel.startsWith('Schritt 4'))!.herkunft)).toMatch(
      /Für November: \+ 253,71 € aus dem Monatslauf\.$/,
    );
  });
});

describe('MP-18c · dieselbe Ableitung für Cockpit, Erlöse, Fahrplan und Portfolio', () => {
  it('Kennzahl der Erlöse-Seite: „Stromrechnung · Netzladen nach MiSpeL, Gutschrift im Monat“', () => {
    const speicher = speicherAussage(SEEBACH, { now: NACH_DEM_TAG })!;
    expect(mehrwertBand(speicher, 'day')?.unter).toBe('Stromrechnung · Netzladen nach MiSpeL, Gutschrift im Monat');
  });

  it('kein „unter Null“ und kein Rot über gewolltes Netzladen; der Planwert trägt den Zusatz', () => {
    const a = speicherAussage(SEEBACH, { now: NACH_DEM_TAG, steuerungGeplantEur: 0.62 })!;
    expect(a.chip).toBe('Gutschrift offen');
    expect(a.anzeigeTon).toBe('neutral');
    expect(a.geplant).toMatch(/— ohne MiSpeL-Gutschrift$/);
    expect(sp(a.kurz)).toBe('Steuerung · Stromrechnung − 0,84 €');
    expect(a.netzladenMispel?.labelLang).toBe('Auf der Stromrechnung');
  });

  it('auch an einem Plus-Tag steht die Netzladen-Zeile (ohne Grund des Servers)', () => {
    const a = speicherAussage(
      { ...SEEBACH, savedSteuerungEur: 1.5, savedEur: 14, steuerungGruende: [] },
      { now: NACH_DEM_TAG },
    )!;
    expect(sp(a.grundZeile)).toBe('Netzladen nach MiSpeL: 312,0 kWh gespeichert, 214,6 kWh ins Netz · Gutschrift offen');
    expect(a.chip).toBe('Gutschrift offen');
  });

  it('die Schwelle ist 1 kWh je Menge — wie der Server', () => {
    expect(NETZLADEN_MISPEL_AB_KWH).toBe(1);
    const knapp = speicherAussage(
      { ...SEEBACH, mispelNetzeinspeisungSpeicherKwh: 0.99, steuerungGruende: ['anders_geladen'] },
      { now: NACH_DEM_TAG },
    )!;
    expect(knapp.netzladenMispel).toBeNull();
    expect(knapp.chip).toBe('unter Null');
  });
});

describe('MP-18c · der Monat: Stromrechnung, Gutschrift (20), zusammen', () => {
  const monat: SpeicherEingabe = {
    range: 'month',
    from: '2027-10-31T23:00:00Z',
    to: '2027-11-30T23:00:00Z',
    savedEur: 20,
    savedSpeicherEur: 24.86,
    savedSteuerungEur: -4.86,
  };
  const jetzt = new Date('2027-12-12T09:00:00+01:00');

  it('bestimmt: die Gutschrift daneben und die Summe', () => {
    const a = speicherAussage(monat, {
      now: jetzt,
      mispelGutschrift: { monat: 'November', eur: 253.71, mengeKwh: 1926.667 },
    })!;
    expect(a.mispelMonat?.gutschriftLabel).toBe('MiSpeL-Gutschrift nach Anlage 1');
    expect(sp(a.mispelMonat?.gutschriftWert)).toBe('+ 253,71 €');
    expect(sp(a.mispelMonat?.zusammen)).toBe('+ 248,85 €');
    // Kein „unter Null“ neben einer Summe im Plus; offen heißt der Chip „Gutschrift offen“.
    expect(a.chip).toBeNull();
    expect(a.anzeigeTon).toBe('neutral');
  });

  it('offen: keine Summe, nie 0 €', () => {
    const a = speicherAussage(monat, {
      now: jetzt,
      mispelGutschrift: { monat: 'November', eur: null, mengeKwh: 1926.667 },
    })!;
    expect(a.mispelMonat?.gutschriftWert).toBe('offen');
    expect(a.mispelMonat?.zusammen).toBeNull();
    expect(a.chip).toBe('Gutschrift offen');
  });

  it('ohne Netzladen im Monat ((20) fehlt oder unter 1 kWh) bleibt die Karte wie bisher', () => {
    const ohne = speicherAussage(monat, { now: jetzt })!;
    for (const g of [null, { monat: 'November', eur: 0, mengeKwh: 0 }]) {
      expect(speicherAussage(monat, { now: jetzt, mispelGutschrift: g })).toEqual(ohne);
    }
  });

  it('die Gutschrift kommt nur bestimmt herein, wenn BEIDE Teile bestimmt sind', () => {
    const betrag = (stand: 'bestimmt' | 'offen', eur: number | null) => ({
      stand,
      eur,
      mengeKwh: 1926.667,
      formel: '(20)',
      satzCt: null,
      grund: null,
    });
    const m = (u: 'bestimmt' | 'offen', n: 'bestimmt' | 'offen') =>
      ({
        monat: '2027-11',
        mispel: true,
        foerderweg: 'marktpraemie_abgrenzung',
        wert: {
          vermiedeneUmlagen: betrag(u, 67.54),
          vermiedenesNetzentgelt: betrag(n, 186.17),
          marktpraemie: null,
          summeOhneMarktpraemieEur: 253.71,
          ustPct: 19,
        },
      }) as unknown as MispelMonat;
    expect(mispelGutschrift(m('bestimmt', 'bestimmt'))).toEqual({ monat: 'November', eur: 253.71, mengeKwh: 1926.667 });
    expect(mispelGutschrift(m('bestimmt', 'offen'))?.eur).toBeNull();
    expect(mispelGutschrift({ ...m('bestimmt', 'bestimmt'), mispel: false })).toBeNull();
    expect(mispelGutschrift(null)).toBeNull();
  });
});

describe('MP-18c · Händler-Modus: der Netzlade-Anteil heißt „geschätzt“ (W5 = A)', () => {
  it('nur im Förderweg „ungeförderte Direktvermarktung“', () => {
    expect(haendlerModus({ foerderweg: 'ungefoerdert' })).toBe(true);
    expect(haendlerModus({ foerderweg: 'marktpraemie_abgrenzung' })).toBe(false);
    expect(haendlerModus(null)).toBe(false);
  });

  it('„davon durch Netzladen + 12,40 € geschätzt“ — sonst Wort für Wort wie bisher', () => {
    expect(sp(speicherWert(SEEBACH, true, true, true))).toBe('darf aus dem Netz laden · davon durch Netzladen + 12,40 € geschätzt');
    expect(sp(speicherWert(SEEBACH, true, true))).toBe('darf aus dem Netz laden · davon durch Netzladen + 12,40 €');
    const mit = preisVergleich({ money: SEEBACH, netzladenErlaubt: true, geschaetzt: true });
    const ohne = preisVergleich({ money: SEEBACH, netzladenErlaubt: true });
    expect(sp(mit.fuss)).toContain('+ 12,40 € geschätzt');
    expect(sp(ohne.fuss)).not.toContain('geschätzt');
  });
});

describe('MP-18c · Bestandsschutz: ohne MiSpeL-Mengen ist jede Ausgabe dieselbe', () => {
  it('jeder Bestandsfall der Vektordatei: Felder fehlen = Felder null = Mengen unter der Schwelle', () => {
    expect(BESTAND.length).toBeGreaterThanOrEqual(17);
    for (const f of BESTAND) {
      const ctx = { now: new Date(f.now), ...f.kontext };
      const vorher = speicherAussage(f.money, ctx);
      const leer = speicherAussage(
        { ...f.money, mispelNetzstromverbrauchSpeicherKwh: null, mispelNetzeinspeisungSpeicherKwh: null },
        ctx,
      );
      const knapp = speicherAussage(
        { ...f.money, mispelNetzstromverbrauchSpeicherKwh: 312, mispelNetzeinspeisungSpeicherKwh: 0.4 },
        ctx,
      );
      expect(leer, f.name).toEqual(vorher);
      expect(knapp, f.name).toEqual(vorher);
      expect(vorher?.netzladenMispel ?? null, f.name).toBeNull();
      expect(vorher?.mispelMonat ?? null, f.name).toBeNull();
    }
  });

  it('die Schritte eines Bestandstages bleiben gleich, auch mit einer Gutschrift im Kontext', () => {
    const money = { ...SEEBACH, mispelNetzstromverbrauchSpeicherKwh: null, mispelNetzeinspeisungSpeicherKwh: null };
    const input = { money, steuerungEur: -0.84, steuerungGeplantEur: 0.62, laeuft: false };
    const vorher = speicherSchritte(input);
    expect(speicherSchritte({ ...input, mispelGutschrift: { monat: 'November', eur: 253.71, mengeKwh: 1926.667 } })).toEqual(vorher);
    expect(vorher.map((z) => z.formel).join('\n')).not.toMatch(/Stromrechnung|Schritt 4|MiSpeL/);
  });
});
