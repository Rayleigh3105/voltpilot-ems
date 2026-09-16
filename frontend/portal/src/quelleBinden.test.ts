import { describe, expect, it } from 'vitest';
import { zeitpunktAus } from './geraetEinstellungen';
import { registerHeute } from './test/messstelleDialogFixtures';
import {
  JETZT,
  JETZT_NACH_WECHSEL,
  K1_ID,
  K3_ID,
  kanaeleK1,
  kanaeleK3,
  quellenMs01,
  quellenMs06,
} from './test/quelleBindenFixtures';
import {
  bindenPruefen,
  folgenSatz,
  KEINE_DATENQUELLE,
  KEINE_VERGLEICHSQUELLE,
  keinZielSatz,
  messwertOptionen,
  messwertZeilen,
  OHNE_BEWERTUNG,
  quelleKarte,
  quelleText,
  zielZeilen,
  zweckOptionen,
  type BindenEingabe,
} from './quelleBinden';
import type { Messkanal } from './api';
import type { Groesse } from './uemsMessstelle';

/** Zahl und Einheit trennt ein GESCHÜTZTES Leerzeichen (`wertText`) — nie ein gewöhnliches. */
const NBSP = String.fromCharCode(160);

const WIRKENERGIE_BEZUG: Groesse = { groesse: 'Wirkenergie', richtung: 'Bezug', einheit: 'kWh', wertart: 'Zählerstand' };
const WIRKENERGIE_MENGE: Groesse = { groesse: 'Wirkenergie', richtung: 'Bezug', einheit: 'kWh', wertart: 'Intervallmenge' };
const WIRKLEISTUNG_BEZUG: Groesse = { groesse: 'Wirkleistung', richtung: 'Bezug', einheit: 'kW', wertart: 'Momentanwert' };
const WIRKLEISTUNG_ABGABE: Groesse = { groesse: 'Wirkleistung', richtung: 'Abgabe', einheit: 'kW', wertart: 'Momentanwert' };

const alle = [...kanaeleK3(), ...kanaeleK1()];
const finde = (name: string): Messkanal => {
  const k = alle.find((x) => x.anzeigename === name);
  if (!k) throw new Error(`Messwert „${name}“ gibt es im Referenzunternehmen nicht`);
  return k;
};

/** EINE Zeile der Tabelle: was das Urteil über genau diesen Messwert an genau dieser Größe sagt. */
function zeile(messwert: string, ziel: Groesse, o: { anteil?: boolean; speist?: Messkanal['speist'] } = {}) {
  const k = { ...finde(messwert), speist: o.speist ?? [] };
  const z = messwertZeilen([k], ziel, { rolle: 'fuehrend', eigenesKennzeichen: 'MS-01', anteil: o.anteil ?? true })[0];
  return { messwert, passend: z.passend, anteil: z.anteil, herleitung: z.herleitung, grund: z.grund };
}

/**
 * UEMS AP-04 IP-14 · der Prüfnachweis des Pakets: die Passungs-Ableitung (Regel 7) als TABELLE —
 * je Fall eine Zeile, passend oder nicht, und wenn nicht: mit dem Grund, den der Kunde liest.
 *
 * Alle Messwerte und Größen stammen aus dem Referenzunternehmen Ahrenberg (K-3 Netzzähler Halle 1,
 * K-1 Hybrid-Wechselrichter 100 kW). Geurteilt wird ausschließlich vom Vertrags-Zwilling
 * `uemsMessstelle.passung` — dieser Test hält fest, WAS die Fläche daraus zeigt.
 */
describe('UEMS AP-04 IP-14 · Regel 7 als Tabelle: was passt, was nicht — und warum nicht', () => {
  it('je Fall der Regel eine Zeile', () => {
    const tabelle = [
      // ── passend ────────────────────────────────────────────────────────────
      zeile('Wirkenergie Bezug', WIRKENERGIE_BEZUG),
      zeile('Wirkenergie Bezug', WIRKENERGIE_MENGE),
      zeile('Wirkleistung', WIRKLEISTUNG_BEZUG),
      zeile('Wirkleistung', WIRKLEISTUNG_ABGABE),
      zeile('PV-Leistung', { ...WIRKLEISTUNG_BEZUG, richtung: 'Erzeugung' }),
      zeile('Speicherleistung', { ...WIRKENERGIE_BEZUG, richtung: 'Laden / Entladen', wertart: 'Intervallmenge' }),
      // ── passt nicht ────────────────────────────────────────────────────────
      zeile('Wirkenergie Bezug', WIRKLEISTUNG_BEZUG),
      zeile('PV-Leistung', WIRKENERGIE_BEZUG),
      zeile('Wirkenergie Abgabe', WIRKENERGIE_BEZUG),
      zeile('Ladestand', WIRKLEISTUNG_BEZUG),
      zeile('Spannung L1', WIRKLEISTUNG_BEZUG),
      zeile('Wirkleistung', WIRKLEISTUNG_BEZUG, { anteil: false }),
      zeile('Wirkleistung', { ...WIRKLEISTUNG_BEZUG, richtung: 'Erzeugung' }),
    ];
    expect(tabelle).toEqual([
      // Messwert · passend · Anteil · Herleitung · Grund
      { messwert: 'Wirkenergie Bezug', passend: true, anteil: null, herleitung: 'zaehlerstand', grund: null },
      { messwert: 'Wirkenergie Bezug', passend: true, anteil: null, herleitung: 'differenzen', grund: null },
      { messwert: 'Wirkleistung', passend: true, anteil: 'positiv', herleitung: 'momentanwert', grund: null },
      { messwert: 'Wirkleistung', passend: true, anteil: 'negativ', herleitung: 'momentanwert', grund: null },
      { messwert: 'PV-Leistung', passend: true, anteil: null, herleitung: 'momentanwert', grund: null },
      { messwert: 'Speicherleistung', passend: true, anteil: null, herleitung: 'integration', grund: null },
      {
        messwert: 'Wirkenergie Bezug',
        passend: false,
        anteil: null,
        herleitung: null,
        grund:
          'Der Messwert „Wirkenergie Bezug“ (kWh, Zählerstand) kann die Größe „Wirkleistung · Momentanwert“ nicht liefern.',
      },
      {
        messwert: 'PV-Leistung',
        passend: false,
        anteil: null,
        herleitung: null,
        grund:
          'Der Messwert „PV-Leistung“ (kW, Momentanwert) kann die Größe „Wirkenergie · Zählerstand“ nicht liefern.',
      },
      {
        messwert: 'Wirkenergie Abgabe',
        passend: false,
        anteil: null,
        herleitung: null,
        grund:
          'Der Messwert „Wirkenergie Abgabe“ (kWh, Zählerstand, Abgabe) kann die Größe „Wirkenergie · Bezug“ nicht liefern.',
      },
      {
        messwert: 'Ladestand',
        passend: false,
        anteil: null,
        herleitung: null,
        grund:
          'Der Messwert „Ladestand“ (%, Momentanwert) kann die Größe „Wirkleistung · Momentanwert“ nicht liefern.',
      },
      {
        messwert: 'Spannung L1',
        passend: false,
        anteil: null,
        herleitung: null,
        grund:
          'Der Messwert „Spannung L1“ (V, Momentanwert) kann die Größe „Wirkleistung · Momentanwert“ nicht liefern.',
      },
      {
        messwert: 'Wirkleistung',
        passend: false,
        anteil: null,
        herleitung: null,
        grund: 'Der Messwert „Wirkleistung“ (kW, Momentanwert) kann die Größe „Wirkleistung · Bezug“ nicht liefern.',
      },
      {
        messwert: 'Wirkleistung',
        passend: false,
        anteil: null,
        herleitung: null,
        grund:
          'Der Messwert „Wirkleistung“ (kW, Momentanwert) kann die Größe „Wirkleistung · Erzeugung“ nicht liefern.',
      },
    ]);
  });

  it('ein Messwert, der eine ANDERE Messstelle führend speist, ist gesperrt — als Vergleich bleibt er möglich', () => {
    const speist: Messkanal['speist'] = [
      {
        messstelle_id: 'ms-06',
        messstelle: 'MS-06',
        groesse: 'Wirkenergie',
        richtung: 'Bezug',
        rolle: 'fuehrend',
        zweck: null,
        gueltig_ab: '2024-03-12T00:00:00+01:00',
        gueltig_bis: null,
        anteil: null,
      },
    ];
    const k = { ...finde('Wirkenergie Bezug'), speist };
    const gesperrt = messwertZeilen([k], WIRKENERGIE_BEZUG, { rolle: 'fuehrend', eigenesKennzeichen: 'MS-01' })[0];
    expect(gesperrt.passend).toBe(false);
    expect(gesperrt.grund).toBe(
      'Dieser Messwert speist bereits MS-06 (führend). Ein Messwert kann nur eine Messstelle führend speisen — ' +
        'als Vergleichsquelle ist er möglich.',
    );
    const alsVergleich = messwertZeilen([k], WIRKENERGIE_BEZUG, { rolle: 'vergleich', eigenesKennzeichen: 'MS-01' })[0];
    expect(alsVergleich.passend).toBe(true);
    expect(alsVergleich.grund).toBeNull();
  });

  it('EIN Vorzeichen-Wert speist Bezug UND Abgabe — nur nie denselben Teil zweimal führend (AP-08 E15)', () => {
    const speistBezug: Messkanal['speist'] = [
      {
        messstelle_id: 'ms-01',
        messstelle: 'MS-01',
        groesse: 'Wirkleistung',
        richtung: 'Bezug',
        rolle: 'fuehrend',
        zweck: null,
        gueltig_ab: '2024-03-12T00:00:00+01:00',
        gueltig_bis: null,
        anteil: 'positiv',
      },
    ];
    const k = { ...finde('Wirkleistung'), speist: speistBezug };
    const wahl = { rolle: 'fuehrend' as const, eigenesKennzeichen: 'MS-02', anteil: true };
    // MS-02 will die ABGABE — ein anderer Teil desselben Werts, also erlaubt.
    expect(messwertZeilen([k], WIRKLEISTUNG_ABGABE, wahl)[0]).toMatchObject({ passend: true, anteil: 'negativ' });
    // Denselben Bezugs-Teil ein zweites Mal führend: gesperrt, mit dem Kennzeichen der anderen Messstelle.
    expect(messwertZeilen([k], WIRKLEISTUNG_BEZUG, wahl)[0].grund).toContain('speist bereits MS-01 (führend)');
  });

  it('die wählbaren Messwerte stehen oben — die übrigen bleiben SICHTBAR, grau und mit Grund', () => {
    const zeilen = messwertZeilen(kanaeleK3(), WIRKLEISTUNG_BEZUG, {
      rolle: 'fuehrend',
      eigenesKennzeichen: 'MS-01',
      anteil: true,
    });
    expect(zeilen.map((z) => z.name)).toEqual(['Wirkleistung', 'Wirkenergie Bezug', 'Wirkenergie Abgabe', 'Spannung L1']);
    expect(zeilen.filter((z) => z.passend)).toHaveLength(1);
    // Kein Messwert fehlt, und jeder gesperrte trägt einen Satz — samt dem Weg, der bleibt.
    expect(zeilen).toHaveLength(kanaeleK3().length);
    for (const z of zeilen.filter((x) => !x.passend)) {
      expect(z.grund).toMatch(/nicht liefern\./);
      expect(z.grund).toContain('Wählen Sie „Wirkleistung (Momentanwert)“.');
    }
  });

  it('die Auswahl sagt am wählbaren Messwert, welchen Teil eines Vorzeichen-Werts sie liest', () => {
    const zeilen = messwertZeilen(kanaeleK3(), WIRKLEISTUNG_BEZUG, {
      rolle: 'fuehrend',
      eigenesKennzeichen: 'MS-01',
      anteil: true,
    });
    const optionen = messwertOptionen(zeilen, WIRKLEISTUNG_BEZUG);
    expect(optionen[0]).toMatchObject({ label: 'Wirkleistung', disabled: false });
    expect(optionen[0].sub).toContain('liest den Bezugs-Teil des Werts');
    expect(optionen[1]).toMatchObject({ disabled: true });
    expect(optionen[1].disabledHint).toContain('nicht liefern');
  });
});

/**
 * Dieselbe Regel von der anderen Seite: „Als Messstelle verwenden“ an der Komponente (§5.2) fragt,
 * WELCHE Messstellen-Größe diesen einen Messwert lesen kann.
 */
describe('UEMS AP-04 IP-14 · „Als Messstelle verwenden“ — die Ziele EINES Messwerts', () => {
  const register = registerHeute();

  it('nennt nur passende Größen wählbar und begründet jede andere', () => {
    const ziele = zielZeilen(register, finde('Wirkenergie Bezug'), 'fuehrend');
    const passend = ziele.filter((z) => z.passend);
    expect(passend.map((z) => z.messstelle)).toEqual([
      'MS-01 · Netzbezug Halle 1',
      'MS-06 · Spritzguss SG01–SG06',
      'MS-10 · Netzbezug Halle 2',
      'MS-11 · Spritzguss SG07–SG10',
      'MS-16 · Netzbezug Lindach',
    ]);
    // MS-02 misst die Abgabe — dieselbe Regel, derselbe Satz, nur andersherum gelesen.
    const abgabe = ziele.find((z) => z.messstelle.startsWith('MS-02'));
    expect(abgabe).toMatchObject({ passend: false });
    expect(abgabe?.grund).toContain('kann die Größe „Wirkenergie · Abgabe“ nicht liefern');
  });

  it('sagt es, wenn KEINE Messstelle diesen Messwert lesen kann — mit dem Weg, der bleibt', () => {
    const ziele = zielZeilen(register, finde('Ladestand'), 'fuehrend');
    expect(ziele.every((z) => !z.passend)).toBe(true);
    expect(keinZielSatz(ziele, 'Ladestand')).toBe(
      'Keine Messstelle hat eine Messgröße, die „Ladestand“ liefern kann. Legen Sie eine mit der passenden Messgröße an.',
    );
    expect(keinZielSatz([], 'Ladestand')).toBe(
      'Es gibt noch keine Messstelle, die „Ladestand“ lesen könnte. Legen Sie zuerst eine an.',
    );
  });
});

/**
 * E3 — der eigentliche Gewinn: die Quelle-Karte zeigt, was die führende und was die
 * Vergleichsquelle sagt, NEBENEINANDER und ohne jede Bewertung (Abnahmefall A8).
 */
describe('UEMS AP-04 IP-14 · die Quelle-Karte: beide Werte nebeneinander (E3, A8)', () => {
  it('A8 — MS-01: führend 312,4 kW, Vergleich 309,8 kW (Plausibilität), kein Prozentwert', () => {
    const karten = quelleKarte(quellenMs01(), JETZT);
    expect(karten.map((k) => k.titel)).toEqual([
      'Hauptgröße · Wirkenergie · Bezug',
      'Nebengröße · Wirkleistung · Bezug',
    ]);
    const leistung = karten[1];
    expect(leistung.werte).toHaveLength(2);
    expect(leistung.werte[0]).toMatchObject({
      rolle: 'führend',
      fuehrend: true,
      quelle: 'Netzzähler Halle 1 · GR-2 · Wirkleistung',
      wert: `312,4${NBSP}kW`,
      anteil: 'liest den Bezugs-Teil des Werts',
      zeitraum: 'seit 12.03.2024',
    });
    expect(leistung.werte[1]).toMatchObject({
      rolle: 'Vergleich · Plausibilität',
      fuehrend: false,
      quelle: 'Hybrid-Wechselrichter 100 kW · GR-1 · Einspeise-/Bezugsleistung am Wechselrichter',
      wert: `309,8${NBSP}kW`,
      zeitraum: 'seit 15.10.2026, 09:00 Uhr',
    });
    // E3: keine Bewertung — nirgends eine Abweichung, ein Prozentwert oder eine Ampel.
    const text = JSON.stringify(karten);
    expect(text).not.toMatch(/Abweichung|%|Ampel|plausibel|Toleranz/);
    expect(OHNE_BEWERTUNG).toBe('Beide Werte stehen nebeneinander; bewertet wird nichts.');
  });

  it('die Hauptgröße ohne Vergleichsquelle sagt es — und nennt den nächsten Schritt', () => {
    const karten = quelleKarte(quellenMs01(), JETZT);
    expect(karten[0].werte[0]).toMatchObject({ wert: `1.284.912,4${NBSP}kWh`, rolle: 'führend' });
    expect(karten[0].leerVergleich).toBe(KEINE_VERGLEICHSQUELLE);
    expect(karten[0].leerFuehrend).toBeNull();
    // Es läuft eine führende Quelle: eine zweite wäre ein Zählerwechsel, kein Binden.
    expect(karten[0].fuehrendMoeglich).toBe(false);
  });

  it('ohne führende Quelle steht der Leerzustand, nie eine 0 — und „Quelle binden“ ist möglich', () => {
    const liste = quellenMs01();
    const ohne = { ...liste, groessen: [{ ...liste.groessen[0], fuehrend: null, zeitstrahl: [] }] };
    const karte = quelleKarte(ohne, JETZT)[0];
    expect(karte.werte).toEqual([]);
    expect(karte.leerFuehrend).toBe(KEINE_DATENQUELLE);
    expect(karte.fuehrendMoeglich).toBe(true);
  });

  it('die Historie zeigt den Zählerwechsel — und die Lücke bleibt eine eigene, sichtbare Zeile', () => {
    const karte = quelleKarte(quellenMs06(), JETZT_NACH_WECHSEL)[0];
    expect(karte.historie.map((h) => [h.wert, h.zeitraum, h.zustand, h.marke])).toEqual([
      [
        'Unterzähler Spritzguss SG01–SG06 · GR-4 Z-5b · Wirkenergie Bezug',
        'seit 18.11.2026, 10:47 Uhr',
        'gueltig',
        'gilt heute',
      ],
      ['Lücke', '18.11.2026, 10:40 Uhr bis 18.11.2026, 10:47 Uhr', 'luecke', null],
      [
        'Unterzähler Spritzguss SG01–SG06 · GR-4 Z-5a · Wirkenergie Bezug',
        '12.03.2024 bis 18.11.2026, 10:40 Uhr',
        'beendet',
        null,
      ],
    ]);
  });

  it('eine Quelle ohne Werte sagt, dass sie wartet — nie eine 0', () => {
    const liste = quellenMs01();
    const ohneWert = {
      ...liste,
      groessen: [{ ...liste.groessen[0], fuehrend: { ...liste.groessen[0].fuehrend!, letzter_wert: null } }],
    };
    expect(quelleKarte(ohneWert, JETZT)[0].werte[0]).toMatchObject({ wert: null, ohneWert: 'Wartet auf erste Daten.' });
  });

  it('die Quelle nennt Komponente, Gerät (mit Einbau) und Messwert', () => {
    expect(quelleText(quellenMs06().quellen[0])).toBe(
      'Unterzähler Spritzguss SG01–SG06 · GR-4 Z-5a · Wirkenergie Bezug',
    );
  });
});

/** Was der Dialog sicher weiß, bevor er schickt — und was er dann genau schickt. */
describe('UEMS AP-04 IP-14 · der Dialog prüft, was er selbst weiß', () => {
  const eingabe = (over: Partial<BindenEingabe> = {}): BindenEingabe => ({
    ziel: '',
    komponente: `a1|${K3_ID}`,
    kanal: 'sunspec.model_203.w',
    zweck: '',
    datum: '2026-10-20',
    uhrzeit: '10:15',
    ...over,
  });
  const ziel = {
    messstelleId: 'ms-01',
    kennzeichen: 'MS-01',
    groesse: WIRKLEISTUNG_BEZUG,
    hauptgroesse: false,
  };
  const messwert = {
    kanal: 'sunspec.model_203.w',
    name: 'Wirkleistung',
    detail: null,
    passend: true,
    anteil: 'positiv' as const,
    herleitung: 'momentanwert' as const,
    grund: null,
    komponente: K3_ID,
  };

  it('eine führende Quelle an einer Nebengröße nennt ihre Größe und ihren Anteil', () => {
    const u = bindenPruefen(eingabe(), { rolle: 'fuehrend', ziel, messwert }, zeitpunktAus);
    expect(u.fehler).toEqual({});
    expect(u.anfrage).toEqual({
      groesse: { groesse: 'Wirkleistung', richtung: 'Bezug' },
      komponente: K3_ID,
      kanal: 'sunspec.model_203.w',
      rolle: 'fuehrend',
      anteil: 'positiv',
      gueltig_ab: '2026-10-20T10:15:00+02:00',
    });
  });

  it('an der HAUPTGRÖSSE nennt die Anfrage keine Größe — das ist die Vorgabe der Route', () => {
    const u = bindenPruefen(
      eingabe(),
      { rolle: 'fuehrend', ziel: { ...ziel, hauptgroesse: true }, messwert },
      zeitpunktAus,
    );
    expect(u.anfrage && 'groesse' in u.anfrage).toBe(false);
  });

  it('eine Vergleichsquelle ohne Zweck geht nicht los (E3)', () => {
    const ohne = bindenPruefen(eingabe(), { rolle: 'vergleich', ziel, messwert }, zeitpunktAus);
    expect(ohne.anfrage).toBeNull();
    expect(ohne.fehler.zweck).toBe('Bitte wählen Sie den Zweck der Vergleichsquelle.');
    const mit = bindenPruefen(
      eingabe({ zweck: 'Plausibilität' }),
      { rolle: 'vergleich', ziel, messwert },
      zeitpunktAus,
    );
    expect(mit.anfrage).toMatchObject({ rolle: 'vergleich', zweck: 'Plausibilität' });
  });

  it('die drei Zwecke sind die des Vertrags — jeder mit dem Satz, wofür er da ist', () => {
    expect(zweckOptionen().map((o) => o.value)).toEqual(['Plausibilität', 'Ersatz bei Ausfall', 'Abrechnungszähler']);
    for (const o of zweckOptionen()) expect(o.sub).toBeTruthy();
  });

  it('ein gesperrter Messwert kommt gar nicht erst los — der Grund steht am Feld', () => {
    const gesperrt = { ...messwert, passend: false, grund: 'Dieser Messwert speist bereits MS-06 (führend).' };
    const u = bindenPruefen(eingabe(), { rolle: 'fuehrend', ziel, messwert: gesperrt }, zeitpunktAus);
    expect(u.anfrage).toBeNull();
    expect(u.fehler.kanal).toBe('Dieser Messwert speist bereits MS-06 (führend).');
  });

  it('eine Uhrzeit, die es an dem Tag nicht gibt, wird nie geraten', () => {
    const u = bindenPruefen(eingabe({ datum: '2027-03-28', uhrzeit: '02:30' }), { rolle: 'fuehrend', ziel, messwert }, zeitpunktAus);
    expect(u.fehler.zeitpunkt).toBe('Diese Uhrzeit gibt es an diesem Tag nicht (Zeitumstellung).');
  });

  it('die Folgen-Karte nennt nur Fakten — führend und Vergleich sagen Verschiedenes', () => {
    const gemeinsam = {
      kennzeichen: 'MS-01',
      zeitpunkt: '2026-10-20T10:15:00+02:00',
      jetzt: JETZT,
      komponente: 'Netzzähler Halle 1',
      messwert: 'Wirkleistung',
      anteil: 'positiv' as const,
      richtung: 'Bezug',
    };
    expect(folgenSatz({ ...gemeinsam, rolle: 'fuehrend', zweck: null, rueckwirkendAbzeichen: null })).toBe(
      'MS-01 liest ab 20.10.2026, 10:15 Uhr Netzzähler Halle 1 · Wirkleistung (liest den Bezugs-Teil des Werts). ' +
        'Bis zu den ersten Werten steht „wartet auf erste Daten“.',
    );
    expect(
      folgenSatz({ ...gemeinsam, rolle: 'fuehrend', zweck: null, rueckwirkendAbzeichen: 'rückwirkend (25 min)' }),
    ).toContain('Der Eintrag gilt rückwirkend (25 min).');
    expect(
      folgenSatz({ ...gemeinsam, rolle: 'vergleich', zweck: 'Plausibilität', rueckwirkendAbzeichen: null }),
    ).toBe(
      'MS-01 vergleicht ab 20.10.2026, 10:15 Uhr Netzzähler Halle 1 · Wirkleistung ' +
        '(liest den Bezugs-Teil des Werts) (Plausibilität). Beide Werte stehen nebeneinander; bewertet wird nichts.',
    );
  });
});
