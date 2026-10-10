import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { ZEIT_SAETZE } from './geraetEinstellungen';
import {
  abgelesenSatz,
  ablehnung,
  ABLESUNG_ZUKUNFT,
  ablesungAblehnung,
  ablesungPruefen,
  abschlussSatz,
  KEINE_KOMPONENTE,
  OHNE_ANLAGE,
  WEG,
  WEG_GESPERRT,
  wegBestand,
  wegGesperrt,
  anlageWahlen,
  anlegenAnfrage,
  ersterIdentitaetFehler,
  fremdeAnlageSatz,
  groesseAus,
  groesseOptionen,
  groesseWaehlen,
  HAUPT,
  hauptzaehlerSatz,
  identitaetPruefen,
  kanalBereitsFuehrendSatz,
  kanalOptionen,
  KENNZEICHEN_CHIP,
  kennzeichenBelegtSatz,
  kennzeichenHinweis,
  leereGroesse,
  leereIdentitaet,
  ortAnfrage,
  ortHinweis,
  ortOptionen,
  ortWahlen,
  passtNichtSatz,
  PFLICHT,
  quelleFolgenSatz,
  quellePruefen,
  richtungOptionen,
  SATZ_ALLGEMEIN,
  SATZ_KENNZEICHEN_FORMAT,
  SATZ_SELBST,
  stellungAnfrage,
  stellungOptionen,
  tagHinweis,
  unterzaehlerOptionen,
  vorschlagKnopf,
  zuordnungPruefen,
  type Identitaet,
  type Zuordnung,
  type ZuordnungBestand,
} from './messstelleDialog';
import {
  kanaeleK5,
  registerHeute,
  registerZeile,
  VORSCHLAG,
} from './test/messstelleDialogFixtures';
import { halle1, ortsbaumAhrenberg } from './test/ortsbaumFixtures';
import { ahrenbergHeute, FIXTURE_IDS } from './test/standorteFixtures';

/**
 * Der Messstellen-Dialog (UEMS AP-04 IP-6) — die reine Hälfte. Der Prüfnachweis des Reports:
 * Pflichtfelder, Kennzeichen-Format und Vorbelegung, Hauptzähler-Regel (409 → Wortlaut). Alle
 * Beispiele aus dem Referenzunternehmen Ahrenberg.
 */

/**
 * Die FEHLER-Tabelle (AP-04 §5.12), Spalte „Wortlaut“ — WÖRTLICH abgeschrieben, ohne die äußeren
 * Anführungszeichen der Zelle. Ein geänderter Satz im Dialog muss hier auffallen.
 */
const TABELLE = {
  hauptzaehler_vorhanden:
    'Werk Ahrenberg – Halle 1 hat bereits einen Hauptzähler: MS-01 Netzbezug Halle 1. Wählen Sie „Unterzähler von MS-01“ oder ändern Sie MS-01.',
  kennzeichen_belegt:
    'MS-01 ist bereits vergeben (Netzbezug Halle 1). Kennzeichen sind je Unternehmen eindeutig — auch archivierte bleiben belegt.',
  kennzeichen_format: 'Erlaubt sind 2–16 Zeichen: Großbuchstaben, Ziffern, „-“, „.“, „/“.',
  quelle_passt_nicht:
    'Der Messwert „Wirkleistung“ (kW, Momentanwert) kann die Größe „Wirkenergie · Zählerstand“ nicht liefern. Wählen Sie „Wirkenergie Bezug (Zählerstand)“ oder ändern Sie die Wertart auf Intervallmenge (aus Leistung integriert).',
  kanal_bereits_fuehrend:
    'Dieser Messwert speist bereits MS-06 (führend). Ein Messwert kann nur eine Messstelle führend speisen — als Vergleichsquelle ist er möglich.',
  stellung_fremde_anlage: 'MS-11 gehört zu Halle 2. Ein Unterzähler kann nur auf eine Messstelle derselben Anlage zeigen.',
  stellung_selbst: 'Eine Messstelle kann nicht ihr eigener Unterzähler sein.',
} as const;

/** §5.1 „Fertig“, wörtlich. */
const FERTIG_51 = 'MS-0017 Lagerhalle Lindach gesamt ist eingerichtet und aktiv · wartet auf erste Daten';

const WIRKENERGIE_BEZUG_ZS = { groesse: 'Wirkenergie', richtung: 'Bezug', einheit: 'kWh', wertart: 'Zählerstand' };

function spritzguss(over: Partial<Identitaet> = {}): Identitaet {
  return {
    ...leereIdentitaet(VORSCHLAG),
    name: 'Spritzguss SG01–SG06',
    hauptgroesse: { groesse: 'Wirkenergie', richtung: 'Bezug', wertart: 'Zählerstand' },
    ...over,
  };
}

const anlageName = (id: string) =>
  ahrenbergHeute()
    .standorte.flatMap((s) => s.anlagen)
    .find((a) => a.id === id)?.name ?? null;

describe('Pflichtfelder — was fehlen darf und was nicht', () => {
  it('leer angelegt: Name und Größe fehlen; das vorbelegte Kennzeichen, Notiz und Nebengrößen dürfen fehlen', () => {
    const e = identitaetPruefen(leereIdentitaet(VORSCHLAG), 'anlegen');
    expect(e.felder).toEqual({ name: PFLICHT.name, groesse: PFLICHT.groesse });
    expect(ersterIdentitaetFehler(e)).toBe('name');
    // Richtung und Wertart werden erst gefragt, wenn eine Größe steht — sonst drei Sätze für eine Lücke.
    expect(e.felder.richtung).toBeUndefined();
  });

  it('eine Größe ohne Richtung und Wertart nennt beide', () => {
    const e = identitaetPruefen(spritzguss({ hauptgroesse: { groesse: 'Wirkenergie', richtung: '', wertart: '' } }), 'anlegen');
    expect(e.felder).toEqual({ richtung: PFLICHT.richtung, wertart: PFLICHT.wertart });
    expect(ersterIdentitaetFehler(e)).toBe('richtung');
  });

  it('vollständig ohne Notiz und Nebengröße ist fehlerfrei; ein leeres Kennzeichen vergibt den Vorschlag', () => {
    expect(ersterIdentitaetFehler(identitaetPruefen(spritzguss(), 'anlegen'))).toBeNull();
    expect(ersterIdentitaetFehler(identitaetPruefen(spritzguss({ kennzeichen: '' }), 'anlegen'))).toBeNull();
  });

  it('ein Name nur aus Leerzeichen fehlt', () => {
    expect(identitaetPruefen(spritzguss({ name: '   ' }), 'anlegen').felder.name).toBe(PFLICHT.name);
  });

  it('eine angefangene Nebengröße muss vollständig sein und darf die Hauptgröße nicht wiederholen', () => {
    const e = identitaetPruefen(
      spritzguss({
        nebengroessen: [
          { groesse: 'Wirkleistung', richtung: 'Bezug', wertart: 'Momentanwert' },
          { groesse: 'Wirkleistung', richtung: '', wertart: '' },
          { groesse: 'Wirkenergie', richtung: 'Bezug', wertart: 'Intervallmenge' },
        ],
      }),
      'anlegen',
    );
    expect(e.neben).toEqual([null, PFLICHT.nebengroesse, PFLICHT.doppelt]);
    expect(ersterIdentitaetFehler(e)).toBe('neben-1');
  });

  it('bearbeiten: das Kennzeichen ist Pflicht (die Schnittstelle ersetzt es ganz), die Hauptgröße wird nicht gefragt', () => {
    const e = identitaetPruefen({ ...spritzguss({ kennzeichen: '' }), hauptgroesse: leereGroesse() }, 'bearbeiten');
    expect(e.felder).toEqual({ kennzeichen: SATZ_KENNZEICHEN_FORMAT });
  });

  it('Zuordnung: Ort und Stellung dürfen fehlen; eine Stellung braucht Anlage, ein Unterzähler seinen Bezug, beides einen Tag', () => {
    const leer: Zuordnung = { ort: '', anlage: '', stellung: '', unterzaehlerVon: '', gueltigAb: '2026-10-20' };
    expect(zuordnungPruefen(leer)).toEqual({});
    expect(zuordnungPruefen({ ...leer, stellung: 'Unterzähler' })).toEqual({
      anlage: PFLICHT.anlage,
      unterzaehlerVon: PFLICHT.unterzaehler,
    });
    expect(zuordnungPruefen({ ...leer, anlage: FIXTURE_IDS.an1 })).toEqual({ stellung: PFLICHT.stellung });
    expect(zuordnungPruefen({ ...leer, ort: 'B-1', gueltigAb: '' })).toEqual({ gueltigAb: PFLICHT.tag });
  });

  it('Quelle: ohne Komponente gibt es nichts zu binden; mit Komponente fehlt der Messwert, und die Uhrzeit wird nie geraten', () => {
    const neben = [{ groesse: 'Wirkleistung', richtung: 'Bezug', wertart: 'Momentanwert' }];
    expect(quellePruefen({ komponente: '', kanaele: {}, datum: '', uhrzeit: '' }, neben)).toEqual({
      fehler: {},
      anfragen: [],
      zeitpunkt: null,
    });
    const k5 = `${FIXTURE_IDS.an1}|k-5`;
    expect(quellePruefen({ komponente: k5, kanaele: {}, datum: '2026-10-20', uhrzeit: '09:00' }, neben).fehler).toEqual({
      kanal: PFLICHT.kanal,
    });
    // 28.03.2027 02:30 gibt es in Europe/Berlin nicht (Zeitumstellung).
    expect(
      quellePruefen({ komponente: k5, kanaele: { [HAUPT]: 'active_energy_import' }, datum: '2027-03-28', uhrzeit: '02:30' }, neben)
        .fehler,
    ).toEqual({ zeitpunkt: ZEIT_SAETZE.nicht_vorhanden });
  });
});

describe('Kennzeichen — Format und Vorbelegung (E7)', () => {
  it('ist mit dem Vorschlag des Servers vorbelegt und trägt den Chip „automatisch · änderbar“', () => {
    const f = leereIdentitaet(VORSCHLAG);
    expect(f.kennzeichen).toBe('MS-0022');
    expect(kennzeichenHinweis(f.kennzeichen, VORSCHLAG, 'anlegen')).toBe(KENNZEICHEN_CHIP);
    expect(kennzeichenHinweis('', VORSCHLAG, 'anlegen')).toBe('Leer vergibt MS-0022.');
    expect(kennzeichenHinweis('HV-1', VORSCHLAG, 'anlegen')).toBeNull();
    expect(kennzeichenHinweis('MS-0022', VORSCHLAG, 'bearbeiten')).toBeNull();
  });

  it('ein eigenes Kennzeichen verdrängt den Vorschlag nicht — er bleibt einen Klick entfernt (FEHLER-Tabelle „Vorschlag bleibt stehen“)', () => {
    expect(vorschlagKnopf('MS-01', VORSCHLAG, 'anlegen')).toBe('Vorschlag MS-0022 übernehmen');
    expect(vorschlagKnopf(VORSCHLAG, VORSCHLAG, 'anlegen')).toBeNull();
    expect(vorschlagKnopf('', VORSCHLAG, 'anlegen')).toBeNull();
    expect(vorschlagKnopf('MS-01', VORSCHLAG, 'bearbeiten')).toBeNull();
  });

  it('unverändert oder leer bleibt das Feld aus der Anfrage — dann vergibt der Server und sein Zähler rückt vor', () => {
    expect('kennzeichen' in anlegenAnfrage(spritzguss(), VORSCHLAG)).toBe(false);
    expect('kennzeichen' in anlegenAnfrage(spritzguss({ kennzeichen: '' }), VORSCHLAG)).toBe(false);
    expect(anlegenAnfrage(spritzguss({ kennzeichen: 'SG/01-06' }), VORSCHLAG).kennzeichen).toBe('SG/01-06');
  });

  it.each([
    ['MS-0022', true],
    ['SG/01-06', true],
    ['HV.1', true],
    ['AB', true],
    ['A'.repeat(16), true],
    ['ms-01', false],
    ['M', false],
    ['A'.repeat(17), false],
    ['MS 01', false],
    [' MS-01', false],
    ['MS_01', false],
    ['MS-Ä1', false],
  ])('„%s“ → gültig: %s (nichts wird umgewandelt)', (kandidat, gueltig) => {
    const e = identitaetPruefen(spritzguss({ kennzeichen: kandidat }), 'anlegen');
    expect(e.felder.kennzeichen).toBe(gueltig ? undefined : TABELLE.kennzeichen_format);
  });
});

describe('Größen-Katalog', () => {
  it('bietet nur die Strom-Größen des Katalogs an — kein Gas, keine Richtung „saldiert“', () => {
    expect(groesseOptionen().map((o) => o.value)).toEqual([
      'Wirkenergie',
      'Wirkleistung',
      'Blindenergie',
      'Scheinleistung',
      'Ladestand',
    ]);
    expect(richtungOptionen('Wirkenergie').map((o) => o.value)).not.toContain('saldiert');
  });

  it('eine andere Größe behält, was weiter passt, und wählt, was es nur einmal gibt', () => {
    expect(groesseWaehlen(leereGroesse(), 'Scheinleistung')).toEqual({
      groesse: 'Scheinleistung',
      richtung: 'richtungslos',
      wertart: 'Momentanwert',
    });
    expect(groesseWaehlen({ groesse: 'Wirkenergie', richtung: 'Bezug', wertart: 'Zählerstand' }, 'Wirkleistung')).toEqual({
      groesse: 'Wirkleistung',
      richtung: 'Bezug',
      wertart: 'Momentanwert',
    });
  });

  it('die Einheit folgt aus dem Katalog; die Anfrage ist gemessen, Strom, mit Nebengröße', () => {
    expect(groesseAus({ groesse: 'Wirkenergie', richtung: 'Bezug', wertart: 'Zählerstand' })).toEqual(WIRKENERGIE_BEZUG_ZS);
    expect(groesseAus({ groesse: 'Wirkleistung', richtung: 'Bezug', wertart: 'Zählerstand' })).toBeNull();
    expect(
      anlegenAnfrage(
        spritzguss({ notiz: ' Maschinenreihe ', nebengroessen: [{ groesse: 'Wirkleistung', richtung: 'Bezug', wertart: 'Momentanwert' }] }),
        VORSCHLAG,
      ),
    ).toEqual({
      name: 'Spritzguss SG01–SG06',
      art: 'gemessen',
      medium: 'Strom',
      hauptgroesse: WIRKENERGIE_BEZUG_ZS,
      nebengroessen: [{ groesse: 'Wirkleistung', richtung: 'Bezug', einheit: 'kW', wertart: 'Momentanwert' }],
      notiz: 'Maschinenreihe',
    });
  });
});

describe('FEHLER-Tabelle §5.12 — der Wortlaut aus den Fakten', () => {
  it('Kennzeichen-Format und „eigener Unterzähler“ stehen wörtlich', () => {
    expect(SATZ_KENNZEICHEN_FORMAT).toBe(TABELLE.kennzeichen_format);
    expect(SATZ_SELBST).toBe(TABELLE.stellung_selbst);
  });

  it('Kennzeichen belegt', () => {
    expect(
      kennzeichenBelegtSatz({ kennzeichen: 'MS-01', messstelle: 'MS-01', name: 'Netzbezug Halle 1', archiviert: false, frueher: false }),
    ).toBe(TABELLE.kennzeichen_belegt);
    // Ein früheres Kennzeichen nennt, wer es heute trägt — wie die Schnittstelle.
    expect(
      kennzeichenBelegtSatz({ kennzeichen: 'MS-6', messstelle: 'MS-06', name: 'Spritzguss SG01–SG06', archiviert: false, frueher: true }),
    ).toBe('MS-6 ist bereits vergeben (Spritzguss SG01–SG06, heute MS-06). Kennzeichen sind je Unternehmen eindeutig — auch archivierte bleiben belegt.');
  });

  it('zweiter Hauptzähler', () => {
    expect(hauptzaehlerSatz('Werk Ahrenberg – Halle 1', { kennzeichen: 'MS-01', name: 'Netzbezug Halle 1', anlage: FIXTURE_IDS.an1 })).toBe(
      TABELLE.hauptzaehler_vorhanden,
    );
  });

  it('„Unterzähler von“ zeigt auf eine fremde Anlage', () => {
    expect(fremdeAnlageSatz('MS-11', 'Halle 2')).toBe(TABELLE.stellung_fremde_anlage);
  });

  it('Kanal bereits führend gebunden', () => {
    expect(kanalBereitsFuehrendSatz('MS-06')).toBe(TABELLE.kanal_bereits_fuehrend);
  });

  it('Kanal passt nicht zur Größe — mit beiden Wegen, solange die Hauptgröße noch offen ist; danach nur der, der geht', () => {
    const [energie, leistung] = kanaeleK5();
    expect(passtNichtSatz(leistung, WIRKENERGIE_BEZUG_ZS, 'wertart', energie, true)).toBe(TABELLE.quelle_passt_nicht);
    expect(passtNichtSatz(leistung, WIRKENERGIE_BEZUG_ZS, 'wertart', energie, false)).toBe(
      'Der Messwert „Wirkleistung“ (kW, Momentanwert) kann die Größe „Wirkenergie · Zählerstand“ nicht liefern. Wählen Sie „Wirkenergie Bezug (Zählerstand)“.',
    );
  });
});

describe('Hauptzähler-Regel — die Schnittstelle antwortet 409, der Kunde liest die Tabelle', () => {
  const koerper = {
    code: 'hauptzaehler_vorhanden',
    message: TABELLE.hauptzaehler_vorhanden,
    tag: '2026-10-20',
    bestehend: { kennzeichen: 'MS-01', name: 'Netzbezug Halle 1', anlage: FIXTURE_IDS.an1 },
  };

  it('baut den Satz aus den Fakten — auch wenn die Schnittstelle einen anderen Satz schickte', () => {
    const a = ablehnung(new ApiError(409, 'irgendein anderer Satz', { ...koerper, message: 'irgendein anderer Satz' }), {
      schritt: 2,
      anlageName,
    });
    expect(a).toEqual({ code: 'hauptzaehler_vorhanden', feld: 'stellung', satz: TABELLE.hauptzaehler_vorhanden });
  });

  it('behält den Zusatzsatz der Schnittstelle bei anderer Richtung', () => {
    const zusatz = `${TABELLE.hauptzaehler_vorhanden} Ein zweiter Hauptzähler in anderer Richtung (Abgabe neben Bezug) ist nur erlaubt, wenn beide denselben Zähler lesen — das zeigt erst ihre führende Quelle.`;
    expect(ablehnung(new ApiError(409, zusatz, { ...koerper, message: zusatz }), { schritt: 2, anlageName }).satz).toBe(zusatz);
  });

  it('kennt der Dialog die Anlage nicht, gilt der Satz der Schnittstelle', () => {
    const a = ablehnung(new ApiError(409, TABELLE.hauptzaehler_vorhanden, koerper), { schritt: 2, anlageName: () => null });
    expect(a.satz).toBe(TABELLE.hauptzaehler_vorhanden);
  });

  it('Kennzeichen belegt steht am Kennzeichen, eine fremde Anlage am „Unterzähler von“', () => {
    const belegt = ablehnung(
      new ApiError(409, 'x', {
        code: 'kennzeichen_belegt',
        message: 'x',
        bestehend: { kennzeichen: 'MS-01', messstelle: 'MS-01', name: 'Netzbezug Halle 1', archiviert: false, frueher: false },
      }),
      { schritt: 1, anlageName },
    );
    expect(belegt).toEqual({ code: 'kennzeichen_belegt', feld: 'kennzeichen', satz: TABELLE.kennzeichen_belegt });
    const fremd = ablehnung(
      new ApiError(422, 'x', {
        code: 'stellung_ungueltig',
        message: 'x',
        grund: 'fremde_anlage',
        bestehend: { kennzeichen: 'MS-11', name: 'Spritzguss SG07–SG10', anlage: FIXTURE_IDS.an2 },
      }),
      { schritt: 2, anlageName: () => 'Halle 2' },
    );
    expect(fremd).toEqual({ code: 'stellung_ungueltig', feld: 'unterzaehlerVon', satz: TABELLE.stellung_fremde_anlage });
  });

  it('ohne lesbare Antwort ein allgemeiner Satz über dem Fuß; ein „gültig ab“ im Schritt Quelle ist der Zeitpunkt', () => {
    expect(ablehnung(null, { schritt: 1, anlageName })).toEqual({ code: null, feld: null, satz: SATZ_ALLGEMEIN });
    expect(
      ablehnung(new ApiError(400, 'x', { code: 'anfrage_ungueltig', message: 'x', feld: 'gueltig_ab' }), { schritt: 3, anlageName })
        .feld,
    ).toBe('zeitpunkt');
    expect(
      ablehnung(new ApiError(409, 'x', { code: 'kanal_bereits_fuehrend', message: 'x', bestehende_messstelle: 'MS-06' }), {
        schritt: 3,
        anlageName,
      }),
    ).toEqual({ code: 'kanal_bereits_fuehrend', feld: 'kanal', satz: TABELLE.kanal_bereits_fuehrend });
  });
});

describe('Zuordnung — nur zulässige Ziele', () => {
  it('Orte: Standort, Gebäude, Bereiche mit Pfad — archivierte nie', () => {
    const baum = ortsbaumAhrenberg({
      gebaeude: [halle1({ bereiche: [...halle1().bereiche, { ...halle1().bereiche[0], id: 'x', kurzzeichen: 'B-9', name: 'Alt', zustand: 'archiviert' }] })],
    });
    const orte = ortWahlen(ahrenbergHeute(), { [FIXTURE_IDS.st1]: baum });
    expect(orte.map((o) => o.pfad)).toEqual([
      'Werk Ahrenberg',
      'Werk Ahrenberg › Halle 1',
      'Werk Ahrenberg › Halle 1 › Halle 1 Nord',
      'Werk Ahrenberg › Halle 1 › Halle 1 Süd',
      'Werk Lindach',
    ]);
  });

  it('Ort-Auswahl: der Name vorn, gruppiert nach Standort — der ganze Pfad steht unter dem Feld', () => {
    const orte = ortWahlen(ahrenbergHeute(), { [FIXTURE_IDS.st1]: ortsbaumAhrenberg({ gebaeude: [halle1()] }) });
    expect(ortOptionen(orte).slice(0, 3)).toEqual([
      { value: 'ST-1', label: 'Werk Ahrenberg', sub: 'Standort', group: 'Werk Ahrenberg' },
      { value: 'G-1', label: 'Halle 1', sub: 'Gebäude', group: 'Werk Ahrenberg' },
      { value: 'B-1', label: 'Halle 1 Nord', sub: 'Bereich in Halle 1', group: 'Werk Ahrenberg' },
    ]);
    expect(ortHinweis(orte[2], 'MS-0022')).toBe('Werk Ahrenberg › Halle 1 › Halle 1 Nord · Bereich');
    expect(ortHinweis(null, 'MS-0022')).toBe(
      'Ohne Ort bleibt MS-0022 ein Entwurf. Eingerichtet ist eine Messstelle mit Kennzeichen, Name, Hauptgröße und Ort.',
    );
  });

  it('Anlagen: mit Ort nur die seines Standorts', () => {
    expect(anlageWahlen(ahrenbergHeute(), FIXTURE_IDS.st2).map((a) => a.name)).toEqual(['Werk Lindach']);
    expect(anlageWahlen(ahrenbergHeute(), null)).toHaveLength(3);
  });

  it('der Hauptzähler nennt, wer es in der Anlage schon ist — und sperrt nichts', () => {
    const an1 = anlageWahlen(ahrenbergHeute(), null)[0];
    const haupt = stellungOptionen(registerHeute(), an1, null).find((o) => o.value === 'Hauptzähler')!;
    expect(haupt.sub).toBe('Die maßgebliche Messung am Netzanschluss — in Werk Ahrenberg – Halle 1 schon MS-01, MS-02.');
    expect(haupt.disabled).toBeUndefined();
  });

  it('„Unterzähler von“: nur dieselbe Anlage, nie sie selbst, nie eine, die schon unter ihr hängt', () => {
    expect(unterzaehlerOptionen(registerHeute(), FIXTURE_IDS.an1, null).map((o) => o.value)).toEqual(['MS-01', 'MS-02', 'MS-06']);
    expect(unterzaehlerOptionen(registerHeute(), FIXTURE_IDS.an1, 'MS-01').map((o) => o.value)).toEqual(['MS-02']);
    const kette = [...registerHeute(), registerZeile({ kennzeichen: 'MS-30', name: 'Unter MS-06', anlage: FIXTURE_IDS.an1, stellung: 'Unterzähler', unterzaehlerVon: 'MS-06' })];
    expect(unterzaehlerOptionen(kette, FIXTURE_IDS.an1, 'MS-06').map((o) => o.value)).toEqual(['MS-01', 'MS-02']);
  });

  it('unverändert schreibt nichts, derselbe Tag korrigiert, ein Unterzähler trägt seinen Bezug', () => {
    const bestand: ZuordnungBestand = {
      ort: 'B-1',
      ortAb: '2026-10-20',
      anlage: FIXTURE_IDS.an1,
      stellung: 'Unterzähler',
      unterzaehlerVon: 'MS-01',
      stellungAb: '2026-10-01',
    };
    const z: Zuordnung = { ort: 'B-1', anlage: FIXTURE_IDS.an1, stellung: 'Unterzähler', unterzaehlerVon: 'MS-01', gueltigAb: '2026-10-20' };
    expect(ortAnfrage(z, bestand)).toBeNull();
    expect(stellungAnfrage(z, bestand)).toBeNull();
    expect(ortAnfrage({ ...z, ort: 'B-2' }, bestand)).toEqual({ kennzeichen: 'B-2', gueltig_ab: '2026-10-20', korrektur: true });
    expect(stellungAnfrage({ ...z, stellung: 'Hauptzähler' }, bestand)).toEqual({
      anlage: FIXTURE_IDS.an1,
      stellung: 'Hauptzähler',
      unterzaehler_von: null,
      gueltig_ab: '2026-10-20',
    });
  });

  it('„Gilt ab“ sagt rückwirkend und geplant als Wort', () => {
    expect(tagHinweis('2026-10-20', '2026-10-20')).toBe('ab heute');
    expect(tagHinweis('2026-10-01', '2026-10-20')).toBe('rückwirkend ab 01.10.2026');
    expect(tagHinweis('2027-03-01', '2026-10-20')).toBe('geplant ab 01.03.2027');
  });
});

describe('Quelle — nur passende Messwerte, ausgegraut mit Grund', () => {
  it('Wirkenergie Bezug passt; Wirkleistung und Abgabe nennen ihren Grund; ein fremd führender Messwert ist gesperrt', () => {
    const optionen = kanalOptionen(kanaeleK5(), WIRKENERGIE_BEZUG_ZS, null, 'haupt');
    expect(optionen.map((o) => [o.label, o.disabled])).toEqual([
      ['Wirkenergie Bezug', true],
      ['Wirkleistung', true],
      ['Wirkenergie Abgabe', true],
    ]);
    expect(optionen[0].disabledHint).toBe(TABELLE.kanal_bereits_fuehrend);
    expect(optionen[2].disabledHint).toBe(
      'Der Messwert „Wirkenergie Abgabe“ (kWh, Zählerstand, Abgabe) kann die Größe „Wirkenergie · Bezug“ nicht liefern.',
    );
  });

  it('die eigene Führung sperrt nicht; der wählbare steht oben und sagt, wozu er passt', () => {
    const optionen = kanalOptionen(kanaeleK5(), WIRKENERGIE_BEZUG_ZS, 'MS-06', 'haupt');
    expect(optionen[0]).toMatchObject({ label: 'Wirkenergie Bezug', disabled: false, sub: 'Zählerstand · kWh · alle 15 min · passt zur Hauptgröße' });
    expect(optionen[1].disabledHint).toBe(
      'Der Messwert „Wirkleistung“ (kW, Momentanwert) kann die Größe „Wirkenergie · Zählerstand“ nicht liefern. Wählen Sie „Wirkenergie Bezug (Zählerstand)“.',
    );
  });

  it('bindet je gewählter Größe einen Messwert zum selben Zeitpunkt — die Hauptgröße ohne `groesse`', () => {
    const u = quellePruefen(
      {
        komponente: `${FIXTURE_IDS.an1}|k-5`,
        kanaele: { [HAUPT]: 'active_energy_import', 'Wirkleistung|Bezug': 'active_power' },
        datum: '2026-10-20',
        uhrzeit: '09:00',
      },
      [{ groesse: 'Wirkleistung', richtung: 'Bezug', wertart: 'Momentanwert' }],
    );
    expect(u.anfragen).toEqual([
      { komponente: 'k-5', kanal: 'active_energy_import', rolle: 'fuehrend', gueltig_ab: '2026-10-20T09:00:00+02:00' },
      {
        groesse: { groesse: 'Wirkleistung', richtung: 'Bezug' },
        komponente: 'k-5',
        kanal: 'active_power',
        rolle: 'fuehrend',
        gueltig_ab: '2026-10-20T09:00:00+02:00',
      },
    ]);
  });

  it('„Was geschieht“ — ab jetzt wartet sie auf erste Daten, rückwirkend steht die Rückwirkung da', () => {
    const basis = { kennzeichen: 'MS-0022', komponente: 'Unterzähler Spritzguss SG01–SG06', messwerte: ['Wirkenergie Bezug'] };
    expect(quelleFolgenSatz({ ...basis, zeitpunkt: '2026-10-20T09:00:00+02:00', jetzt: '2026-10-20T09:00:30+02:00' })).toBe(
      'MS-0022 liest ab 20.10.2026, 09:00 Uhr Unterzähler Spritzguss SG01–SG06 · Wirkenergie Bezug. Bis zu den ersten Werten steht „wartet auf erste Daten“.',
    );
    expect(quelleFolgenSatz({ ...basis, zeitpunkt: '2026-10-18T09:00:00+02:00', jetzt: '2026-10-20T09:00:00+02:00' })).toBe(
      'MS-0022 liest ab 18.10.2026, 09:00 Uhr Unterzähler Spritzguss SG01–SG06 · Wirkenergie Bezug. Der Eintrag gilt rückwirkend (2 Tage).',
    );
  });
});

describe('Abschluss — die Stufe kommt vom Server', () => {
  const ms17 = { kennzeichen: 'MS-0017', name: 'Lagerhalle Lindach gesamt', lebenszyklus: 'aktiv', fehlt: [] };

  it('§5.1 wörtlich: eingerichtet und aktiv, wartet auf erste Daten', () => {
    expect(abschlussSatz(ms17, { fassung: 'anlegen', quelleGebunden: true, quelleVorhanden: true })).toBe(FERTIG_51);
  });

  it('ohne Quelle „noch keine Quelle“ (E8, Konzept Messen m1 Anhang A F), ohne Ort ein Entwurf mit dem, was fehlt', () => {
    expect(abschlussSatz(ms17, { fassung: 'anlegen', quelleGebunden: false, quelleVorhanden: false })).toBe(
      'MS-0017 Lagerhalle Lindach gesamt ist eingerichtet und aktiv · noch keine Quelle',
    );
    expect(
      abschlussSatz({ ...ms17, lebenszyklus: 'entwurf', fehlt: ['ort'] }, { fassung: 'anlegen', quelleGebunden: false, quelleVorhanden: false }),
    ).toBe('MS-0017 Lagerhalle Lindach gesamt ist als Entwurf gespeichert — es fehlt: Ort.');
  });
});

describe('Schritt 3 · Woher kommen die Werte? (Messen m2)', () => {
  const ziel = (laufend: boolean) => ({
    schluessel: HAUPT,
    groesse: { groesse: 'Wirkenergie', richtung: 'Bezug' },
    rolle: 'haupt' as const,
    label: 'Messwert für die Hauptgröße · Wirkenergie · Bezug',
    laufend: laufend
      ? { komponente: 'k', kanal: 'c', rolle: 'fuehrend', gueltig_ab: '2026-10-01T00:00:00+02:00', gueltig_bis: null }
      : null,
  });

  it('die zwei Wege heißen wie im Captain-Punkt, beide gleichwertig', () => {
    expect(WEG.geraet.titel).toBe('Automatisch von einem Gerät');
    expect(WEG.ablesen.titel).toBe('Von Hand ablesen');
  });

  it('der Bestand legt den Weg fest: Ablesungen → ablesen, eine laufende oder gebundene Quelle → Gerät, sonst offen', () => {
    expect(wegBestand([ziel(false)], 'ablesung')).toBe('ablesen');
    expect(wegBestand([ziel(false)], 'gebunden')).toBe('geraet');
    expect(wegBestand([ziel(true)], null)).toBe('geraet');
    expect(wegBestand([ziel(false)], 'keine_datenquelle')).toBeNull();
    expect(wegBestand([ziel(false)], null)).toBeNull();
  });

  it('gesperrte Wege tragen ihren Grund: ohne Anlage, ohne Komponente, kein Zählerstand, schon der andere Weg', () => {
    const offen = { bestand: null, wertart: 'Zählerstand', quellAnlagen: 1, komponenten: 3 };
    expect(wegGesperrt('geraet', offen)).toBeNull();
    expect(wegGesperrt('ablesen', offen)).toBeNull();
    expect(wegGesperrt('geraet', { ...offen, quellAnlagen: 0 })).toBe(OHNE_ANLAGE);
    expect(wegGesperrt('geraet', { ...offen, komponenten: 0 })).toBe(KEINE_KOMPONENTE);
    // Noch nicht geladen ist kein „keine Komponente“.
    expect(wegGesperrt('geraet', { ...offen, komponenten: null })).toBeNull();
    expect(wegGesperrt('ablesen', { ...offen, wertart: 'Intervallmenge' })).toBe(WEG_GESPERRT.keinZaehlerstand);
    expect(wegGesperrt('geraet', { ...offen, bestand: 'ablesen' })).toBe(WEG_GESPERRT.schonAbgelesen);
    expect(wegGesperrt('ablesen', { ...offen, bestand: 'ablesen' })).toBeNull();
    expect(wegGesperrt('ablesen', { ...offen, bestand: 'geraet' })).toBe(WEG_GESPERRT.schonGeraet);
    expect(wegGesperrt('geraet', { ...offen, bestand: 'geraet', quellAnlagen: 0 })).toBeNull();
  });

  it('„Wird seit … von Hand abgelesen“ - mit und ohne letzte Ablesung', () => {
    expect(abgelesenSatz({ seit: '2024-10-01T00:00:00+02:00', zuletzt: '2026-10-01T07:15:00+02:00' })).toBe(
      'Wird seit 01.10.2024 von Hand abgelesen, zuletzt am 01.10.2026.',
    );
    expect(abgelesenSatz({ seit: '2026-10-20T08:30:00+02:00', zuletzt: null })).toBe(
      'Wird seit 20.10.2026 von Hand abgelesen. Es gibt noch keine Ablesung.',
    );
  });

  it('die erste Ablesung: Ortszeit auf die Minute, nie in der Zukunft, der Stand als deutsche Zahl, ohne Monat', () => {
    const jetzt = '2026-10-20T09:00:00+02:00';
    expect(ablesungPruefen({ datum: '2026-10-20', uhrzeit: '08:30', stand: '1.250.000' }, jetzt, 'kWh')).toEqual({
      fehler: {},
      anfrage: { zeitpunkt: '2026-10-20T08:30:00+02:00', stand: '1.250.000', zuordnung_monat: null },
    });
    expect(ablesungPruefen({ datum: '2026-10-20', uhrzeit: '09:01', stand: '1' }, jetzt, 'kWh').fehler).toEqual({
      ablesezeit: ABLESUNG_ZUKUNFT,
    });
    expect(ablesungPruefen({ datum: '2026-10-20', uhrzeit: '08:30', stand: ' ' }, jetzt, 'kWh').fehler).toEqual({
      stand: PFLICHT.stand,
    });
    expect(ablesungPruefen({ datum: '2026-10-20', uhrzeit: '08:30', stand: '-5' }, jetzt, 'kWh').fehler.stand).toBe(
      'Mengen sind nicht negativ.',
    );
    // Die doppelte Stunde der Zeitumstellung wird nie geraten.
    expect(ablesungPruefen({ datum: '2026-10-25', uhrzeit: '02:30', stand: '1' }, '2026-10-26T09:00:00+01:00', 'kWh').fehler).toEqual({
      ablesezeit: ZEIT_SAETZE.zweimal,
    });
    expect(ablesungPruefen({ datum: '', uhrzeit: '08:30', stand: '1' }, jetzt, 'kWh').anfrage).toBeNull();
  });

  it('Ablehnungen des Ablesungs-Wegs stehen am Feld - der Satz des Servers, sonst der allgemeine', () => {
    const satz = 'Datum und Uhrzeit prüfen.';
    expect(ablesungAblehnung(new ApiError(422, satz, { code: 'zeitpunkt_ungueltig', message: satz }))).toEqual({
      feld: 'ablesezeit',
      satz,
    });
    expect(
      ablesungAblehnung(new ApiError(422, 'x', { code: 'zahl_unlesbar', message: 'Den Zählerstand …', feld: 'stand' })),
    ).toEqual({ feld: 'stand', satz: 'Den Zählerstand …' });
    expect(ablesungAblehnung(new ApiError(409, 'Konflikt', { code: 'konflikt', message: 'Konflikt' })).feld).toBe('ablesezeit');
    expect(ablesungAblehnung(new ApiError(422, 'Nein', { code: 'quelle_passt_nicht', message: 'Nein' }))).toEqual({
      feld: null,
      satz: 'Nein',
    });
    expect(ablesungAblehnung(null)).toEqual({ feld: null, satz: SATZ_ALLGEMEIN });
  });

  it('der Fertig-Satz nach der ersten Ablesung', () => {
    const ms = { kennzeichen: 'MS-0022', name: 'Spritzguss', lebenszyklus: 'aktiv', fehlt: [] };
    expect(
      abschlussSatz(ms, { fassung: 'anlegen', quelleGebunden: false, quelleVorhanden: false, abgelesen: true }),
    ).toBe('MS-0022 Spritzguss ist eingerichtet und aktiv · wird von Hand abgelesen');
  });
});
