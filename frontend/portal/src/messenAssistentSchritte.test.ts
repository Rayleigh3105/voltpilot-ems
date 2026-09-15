import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  adresseFehltSatz,
  alleGewaehlt,
  auswahlSatz,
  fehltArt,
  fertigSatz,
  hauptzaehlerFehlt,
  hauptzaehlerJeAnlage,
  istVorschlagGeaendert,
  messenEingerichtet,
  messenPruefliste,
  ortKorrekturen,
  ortWahlenAm,
  stellungWort,
  uebernahmeSatz,
  uebernehmenAnfrage,
  vorschlagSchluessel,
  type MessenPruefZeile,
} from './messenAssistent';
import { messen } from './uemsFunktion';
import {
  ahrenbergMessen,
  C1_AB,
  C1_IDS,
  ENERGIEKARTEN,
  geraeteAhrenberg,
  registerNachUebernahme,
  uebernommen,
  vorschlagHalle2,
} from './test/messenAssistentFixtures';
import { ortsbaumAhrenberg } from './test/ortsbaumFixtures';
import { ahrenbergHeute, FIXTURE_IDS, werkAhrenberg } from './test/standorteFixtures';

/**
 * Die Schritte 3 bis 5 des Assistenten „Messen & Auswerten" (UEMS AP-01 IP-9b) als reine Regel —
 * der Prüfnachweis des Reports: der Vorschlag für WAGO C-1 ergibt vier Messstellen, und die
 * Hauptzähler-Regel greift. Dazu die Anfrage an die AP-04-Routen, die Prüfliste aus Fakten und der
 * Satz auf „Fertig". Zahlen und Kennzeichen nur aus dem Referenzunternehmen Ahrenberg.
 */

const ROOT = resolve(process.cwd(), '../..');
const REFERENZ = JSON.parse(readFileSync(resolve(ROOT, 'docs/contracts/v2/uems-referenzunternehmen.json'), 'utf8'));
const FUNKTION_VECTORS = JSON.parse(readFileSync(resolve(ROOT, 'docs/contracts/v2/funktion-zustand-vectors.json'), 'utf8'));
const VORSCHLAG_DIENST = readFileSync(
  resolve(ROOT, 'services/api/src/main/java/com/voltpilot/api/uems/MessstelleVorschlagService.java'),
  'utf8',
);

const { an1, an2, st1 } = FIXTURE_IDS;
const JETZT = new Date('2026-10-20T08:15:30Z');
const schluessel = (komponente: string) => `${komponente}|Wirkenergie Bezug`;
const zeile = (zeilen: MessenPruefZeile[], art: MessenPruefZeile['art']) => zeilen.find((z) => z.art === art);

describe('Schritt 3 — der Vorschlag für WAGO C-1 (Halle 2)', () => {
  it('ergibt vier Messstellen: EK-1 wird Hauptzähler, EK-2 … EK-4 hängen als Unterzähler an ihm', () => {
    const l = vorschlagHalle2();
    const halle2 = l.vorschlaege.filter((v) => v.anlage === an2);
    expect(halle2).toHaveLength(4);
    expect(l.vorschlaege).toHaveLength(4);
    expect(halle2.map((v) => v.kennzeichen)).toEqual(['MS-0001', 'MS-0002', 'MS-0003', 'MS-0004']);
    expect(halle2.map((v) => v.komponente)).toEqual([C1_IDS.k81, C1_IDS.k82, C1_IDS.k83, C1_IDS.k84]);
    expect(halle2.map(stellungWort)).toEqual(['Hauptzähler', 'Unterzähler von MS-0001', 'Unterzähler von MS-0001', 'Unterzähler von MS-0001']);
    for (const v of halle2) {
      expect(v.quelle.kanal).toBe('Wirkenergie Bezug');
      expect(v.hauptgroesse).toMatchObject({ groesse: 'Wirkenergie', richtung: 'Bezug' });
      expect(v.ort).toBe('ST-1');
      expect(v.ab).toBe(C1_AB);
    }
    // Die Leistung derselben Karte wird keine zweite Messstelle — mit Grund sichtbar.
    expect(l.ausgelassen.filter((a) => a.kanal === 'Wirkleistung')).toHaveLength(4);
  });

  it('die vier Vorschläge SIND MS-10 … MS-13 des Referenzunternehmens — gleiche Karte, gleiche Stellung, gleicher Hauptzähler', () => {
    const l = vorschlagHalle2();
    const ausReferenz = new Map<string, string>(ENERGIEKARTEN.map((k) => [k.kennzeichen, k.id]));
    const vorschlagVonMs = new Map<string, string>();
    for (const k of ENERGIEKARTEN) {
      const ms = REFERENZ.messstellen.find((m: { kennzeichen: string }) => m.kennzeichen === k.messstelle);
      expect(ms.fuehrende_quelle[0]).toMatchObject({ komponente: k.kennzeichen, einbau: 'C-1', kanal: 'Wirkenergie Bezug', gueltig_ab: C1_AB });
      expect(ms.name).toBe(k.messstelleName);
      const v = l.vorschlaege.find((x) => x.komponente === ausReferenz.get(k.kennzeichen))!;
      vorschlagVonMs.set(k.messstelle, v.kennzeichen);
      const stellung = ms.elektrische_stellung[0];
      expect(stellung.anlage).toBe('AN-2');
      expect(v.stellung).toBe(stellung.stellung);
      expect(v.unterzaehler_von?.messstelle ?? null).toBe(stellung.unterzaehler_von ? vorschlagVonMs.get(stellung.unterzaehler_von) : null);
    }
    expect(REFERENZ.komponenten.find((k: { kennzeichen: string }) => k.kennzeichen === 'K-8.1').geraet).toBe('GR-7');
  });

  it('Hauptzähler-Regel: genau ein Hauptzähler je Anlage — der von Halle 1 zählt für Halle 2 nicht', () => {
    const l = vorschlagHalle2();
    const je = hauptzaehlerJeAnlage(l, alleGewaehlt(l));
    expect(je.get(an2)?.map((v) => v.kennzeichen)).toEqual(['MS-0001']);
    expect(je.has(an1)).toBe(false);
  });

  it('Hauptzähler-Regel: ohne MS-0001 geht keiner seiner Unterzähler — mit dem Satz des Servers, Wort für Wort', () => {
    const l = vorschlagHalle2();
    const ohneHaupt = new Set(alleGewaehlt(l));
    ohneHaupt.delete(schluessel(C1_IDS.k81));
    const saetze = hauptzaehlerFehlt(l, ohneHaupt);
    expect([...saetze.keys()]).toEqual([schluessel(C1_IDS.k82), schluessel(C1_IDS.k83), schluessel(C1_IDS.k84)]);
    expect(saetze.get(schluessel(C1_IDS.k82))).toBe(
      '„Zähler Energiekarte EK-2 (Spritzguss SG07–SG10)“ ist als Unterzähler von MS-0001 vorgeschlagen — übernehmen Sie diesen Hauptzähler mit.',
    );
    // Derselbe Wortlaut wie die Ablehnung des Servers (422 `bezug_fehlt`) — kein zweiter Satz.
    expect(VORSCHLAG_DIENST).toContain('"“ ist als Unterzähler von " + b.messstelle()');
    expect(VORSCHLAG_DIENST).toContain('" vorgeschlagen — übernehmen Sie diesen Hauptzähler mit."');

    expect(hauptzaehlerFehlt(l, alleGewaehlt(l)).size).toBe(0);
    expect(hauptzaehlerFehlt(l, new Set()).size).toBe(0);
    const nurUnterzaehlerWeg = new Set([schluessel(C1_IDS.k81)]);
    expect(hauptzaehlerFehlt(l, nurUnterzaehlerWeg).size).toBe(0);
  });

  it('hat Halle 2 schon einen Hauptzähler, schlägt die Liste keinen zweiten vor — die Unterzähler hängen am bestehenden', () => {
    const l = vorschlagHalle2({ hauptzaehlerHalle2: 'MS-10' });
    // EK-1 misst dann den Netzanschluss ein zweites Mal: Kandidat für eine Vergleichsquelle an MS-10 (Regel 8).
    expect(l.vorschlaege.find((v) => v.komponente === C1_IDS.k81)).toBeUndefined();
    expect(l.ausgelassen.find((a) => a.komponente === C1_IDS.k81 && a.kanal === 'Wirkenergie Bezug')).toMatchObject({
      grund: 'vergleich_kandidat',
      zu: 'MS-10',
    });
    expect(hauptzaehlerJeAnlage(l, alleGewaehlt(l)).size).toBe(0);
    const unter = l.vorschlaege;
    expect(unter).toHaveLength(3);
    expect(unter.map((v) => v.unterzaehler_von)).toEqual(
      unter.map(() => ({ messstelle: 'MS-10', bestehend: true, komponente: null, kanal: null })),
    );
    // Ein Unterzähler einer BESTEHENDEN Messstelle hängt an nichts, was hier fehlen könnte.
    expect(hauptzaehlerFehlt(l, new Set(unter.map(vorschlagSchluessel))).size).toBe(0);
  });

  it('die Anfrage schickt jede gewählte Zeile, wie sie gezeigt wurde — nur ein geänderter Name reist mit', () => {
    const l = vorschlagHalle2();
    const gewaehlt = alleGewaehlt(l);
    gewaehlt.delete(schluessel(C1_IDS.k84));
    const a = uebernehmenAnfrage(l, gewaehlt, {
      [schluessel(C1_IDS.k81)]: '  Netzbezug Halle 2 ',
      [schluessel(C1_IDS.k82)]: l.vorschlaege[1].name,
      [schluessel(C1_IDS.k83)]: '   ',
    });
    expect(a.vorschlaege).toEqual([
      {
        komponente: C1_IDS.k81,
        kanal: 'Wirkenergie Bezug',
        hauptgroesse: l.vorschlaege[0].hauptgroesse,
        nebengroessen: [],
        stellung: 'Hauptzähler',
        ab: C1_AB,
        name: 'Netzbezug Halle 2',
      },
      { komponente: C1_IDS.k82, kanal: 'Wirkenergie Bezug', hauptgroesse: l.vorschlaege[1].hauptgroesse, nebengroessen: [], stellung: 'Unterzähler', ab: C1_AB },
      { komponente: C1_IDS.k83, kanal: 'Wirkenergie Bezug', hauptgroesse: l.vorschlaege[2].hauptgroesse, nebengroessen: [], stellung: 'Unterzähler', ab: C1_AB },
    ]);
    expect(auswahlSatz(gewaehlt.size, l.vorschlaege.length)).toBe('3 von 4 Vorschlägen gewählt');
    expect(auswahlSatz(1, 1)).toBe('1 von 1 Vorschlag gewählt');
  });

  it('Gebäude und Bereich werden danach über die AP-04-Route geschrieben — als Korrektur am Tag der Übernahme', () => {
    const l = vorschlagHalle2();
    const a = uebernehmenAnfrage(l, alleGewaehlt(l), {});
    const r = uebernommen(l, a);
    const orte = Object.fromEntries(ENERGIEKARTEN.map((k) => [schluessel(k.id), k.ort]));
    orte[schluessel(C1_IDS.k84)] = 'ST-1';
    expect(ortKorrekturen(l, a, r, orte)).toEqual([
      { messstelle: 'ms-ms-0001', kennzeichen: 'MS-0001', anfrage: { kennzeichen: 'G-2', gueltig_ab: '2026-10-01', korrektur: true } },
      { messstelle: 'ms-ms-0002', kennzeichen: 'MS-0002', anfrage: { kennzeichen: 'B-4', gueltig_ab: '2026-10-01', korrektur: true } },
      { messstelle: 'ms-ms-0003', kennzeichen: 'MS-0003', anfrage: { kennzeichen: 'B-3', gueltig_ab: '2026-10-01', korrektur: true } },
    ]);
    // Steht eine Messstelle nicht mehr am vorgeschlagenen Standort, rührt der Assistent ihren Ort nicht an.
    const woanders = { ...r, messstellen: r.messstellen.map((m) => ({ ...m, orte: [{ ...m.orte![0], kennzeichen: 'G-1' }] })) };
    expect(ortKorrekturen(l, a, woanders, orte)).toEqual([]);
  });

  it('die Orte einer Zeile sind dieser Standort mit seinen Gebäuden und Bereichen — kein fremder Standort', () => {
    const orte = ortWahlenAm(ahrenbergHeute(), ortsbaumAhrenberg(), st1);
    expect(orte[0]).toMatchObject({ kurzzeichen: 'ST-1', art: 'standort' });
    expect(orte.map((o) => o.kurzzeichen)).toEqual(expect.arrayContaining(['G-2', 'B-3', 'B-4', 'B-5']));
    expect(orte.every((o) => o.standortId === st1)).toBe(true);
    expect(ortWahlenAm(ahrenbergHeute(), null, st1).map((o) => o.kurzzeichen)).toEqual(['ST-1']);
    expect(ortWahlenAm(null, null, st1)).toEqual([]);
  });

  it('Sätze der Übernahme und der 409 „geändert"', () => {
    expect(uebernahmeSatz(4, 0)).toBe('4 Messstellen übernommen');
    expect(uebernahmeSatz(1, 1)).toBe('1 Messstelle übernommen, 1 gab es schon');
    expect(istVorschlagGeaendert({ status: 409, body: { code: 'vorschlag_geaendert' } })).toBe(true);
    expect(istVorschlagGeaendert({ status: 409, body: { code: 'bereits_angelegt' } })).toBe(false);
  });
});

describe('Schritt 4 — die Prüfliste aus Fakten: Standort, Box, Datenlage, Hauptzähler', () => {
  it('ordnet JEDES Wort, das die Regel `messen()` in den Vektoren spricht, genau einer Zeile zu', () => {
    const woerter = (FUNKTION_VECTORS.cases as { familie: string; expected: { fehlt?: string[] } }[])
      .filter((c) => c.familie === 'messen')
      .flatMap((c) => c.expected.fehlt ?? []);
    expect(woerter.length).toBeGreaterThan(0);
    expect(woerter.filter((w) => fehltArt(w) === null)).toEqual([]);
    // Und jede Form, die die Regel bilden kann.
    const m = messen({
      standort: 'Werk Ahrenberg',
      angelegt: true,
      standortEingerichtet: false,
      standortArchiviertAm: null,
      eingerichtetAm: null,
      boxen: [{ name: 'Box Halle 2', verbunden: false }],
      messstellen: [
        { kennzeichen: 'MS-12', manuell: false, quelleVorhanden: true, letzterGuterWert: null, jeEinWert: false, kadenzS: 60 },
        { kennzeichen: 'MS-11', manuell: false, quelleVorhanden: true, letzterGuterWert: '2026-10-20T06:00:00Z', jeEinWert: true, kadenzS: 60 },
      ],
      anlagen: [
        { name: 'Werk Ahrenberg – Halle 1', hauptzaehlerAnzahl: 0 },
        { name: 'Werk Ahrenberg – Halle 2', hauptzaehlerAnzahl: 2 },
      ],
      jetzt: '2026-10-20T08:15:30Z',
      zeitzone: 'Europe/Berlin',
    });
    expect(m.fehlt.map(fehltArt)).toEqual(['standort', 'box', 'datenlage', 'datenlage', 'hauptzaehler', 'hauptzaehler']);
  });

  it('alles erfüllt: vier Zeilen in Fakten, und die Regel nennt „Messen & Auswerten" eingerichtet', () => {
    const register = registerNachUebernahme();
    const fs = ahrenbergMessen(register);
    const zeilen = messenPruefliste({ standort: werkAhrenberg(), funktion: fs, geraete: geraeteAhrenberg(JETZT), register, jetzt: JETZT });
    expect(zeilen.map((z) => [z.art, z.bestanden, z.text])).toEqual([
      ['standort', true, 'Standort Werk Ahrenberg'],
      ['box', true, 'Box Halle 1 und Box Halle 2 verbunden'],
      ['datenlage', true, '5 von 5 Messstellen liefern Daten'],
      ['hauptzaehler', true, 'Hauptzähler MS-01 (Werk Ahrenberg – Halle 1), MS-0001 (Werk Ahrenberg – Halle 2)'],
    ]);
    expect(zeilen.every((z) => z.weg === null && z.details.length === 0 && z.fehlt.length === 0)).toBe(true);
    expect(messenEingerichtet(fs)).toBe(true);
  });

  it('MS-0003 wartet auf erste Daten: die Zeile nennt Messstelle, Zustand und Karte — und den Weg zur Datenquelle', () => {
    const register = registerNachUebernahme({ wartet: ['MS-0003'] });
    const fs = ahrenbergMessen(register);
    expect(fs.messen.zustand).toBe('entwurf');
    expect(messenEingerichtet(fs)).toBe(false);
    const d = zeile(messenPruefliste({ standort: werkAhrenberg(), funktion: fs, geraete: geraeteAhrenberg(JETZT), register, jetzt: JETZT }), 'datenlage')!;
    expect(d).toEqual({
      art: 'datenlage',
      bestanden: false,
      text: '4 von 5 Messstellen liefern Daten',
      fehlt: ['erste Daten MS-0003'],
      details: ['MS-0003 Montage Linie M1: Wartet auf erste Daten · Zähler Energiekarte EK-3 (Montage M1)'],
      weg: { text: 'Zur Datenquelle', ziel: 2 },
    });
  });

  it('Box Halle 2 offline: das Urteil ist das der Regel, die Zeile nennt die Box', () => {
    const register = registerNachUebernahme();
    const fs = ahrenbergMessen(register, { boxHalle2Verbunden: false });
    const b = zeile(messenPruefliste({ standort: werkAhrenberg(), funktion: fs, geraete: geraeteAhrenberg(JETZT, 'offline'), register, jetzt: JETZT }), 'box')!;
    expect(b).toEqual({
      art: 'box',
      bestanden: false,
      text: '1 von 2 Boxen verbunden',
      fehlt: ['Verbindung Box Halle 2'],
      details: ['Box Halle 2: offline'],
      weg: { text: 'Zur Datenquelle', ziel: 2 },
    });
    const ohneBoxen = zeile(messenPruefliste({ standort: werkAhrenberg(), funktion: fs, geraete: null, register, jetzt: JETZT }), 'box')!;
    expect(ohneBoxen.bestanden).toBe(false);
  });

  it('ohne Hauptzähler an Halle 2: die Zeile nennt, was die Regel vermisst, und führt zu den Messstellen', () => {
    const register = registerNachUebernahme({ ohne: ['MS-0001'] });
    const fs = ahrenbergMessen(register);
    const h = zeile(messenPruefliste({ standort: werkAhrenberg(), funktion: fs, geraete: geraeteAhrenberg(JETZT), register, jetzt: JETZT }), 'hauptzaehler')!;
    expect(h).toEqual({
      art: 'hauptzaehler',
      bestanden: false,
      text: 'Hauptzähler MS-01 (Werk Ahrenberg – Halle 1)',
      fehlt: ['Hauptzähler Werk Ahrenberg – Halle 2'],
      details: [],
      weg: { text: 'Zu den Messstellen', ziel: 3 },
    });
  });

  it('ein Standort im Entwurf ohne Adresse: rot mit dem Satz aus Schritt 1 und dem Weg in den Standort-Dialog', () => {
    const st = werkAhrenberg({ zustand: 'entwurf', esFehlt: ['adresse'], adresse: null });
    const fs = ahrenbergMessen(registerNachUebernahme());
    const mitStandort = { ...fs, messen: { ...fs.messen, zustand: 'entwurf' as const, fehlt: ['Standort-Angaben Werk Ahrenberg'] } };
    const s = zeile(messenPruefliste({ standort: st, funktion: mitStandort, geraete: [], register: [], jetzt: JETZT }), 'standort')!;
    expect(s).toEqual({
      art: 'standort',
      bestanden: false,
      text: 'Standort Werk Ahrenberg',
      fehlt: ['Standort-Angaben Werk Ahrenberg'],
      details: [adresseFehltSatz('Werk Ahrenberg')],
      weg: { text: 'Adresse nachtragen', ziel: 'adresse' },
    });
    expect(adresseFehltSatz('Werk Ahrenberg')).toBe('Für Werk Ahrenberg fehlt noch die Adresse.');
  });
});

describe('Schritt 5 — Fertig', () => {
  it('sagt, dass Messen & Auswerten eingerichtet UND aktiv ist — ohne Start-Knopf', () => {
    expect(fertigSatz('Werk Ahrenberg')).toBe('Messen & Auswerten ist für Werk Ahrenberg eingerichtet und aktiv.');
  });
});
