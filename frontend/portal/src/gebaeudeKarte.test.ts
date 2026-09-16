import { describe, expect, it } from 'vitest';
import type { Bilanz } from './api';
import {
  NICHT_MESSBAR,
  OHNE_SYSTEM,
  RECHT_KENNZAHL,
  VERSORGUNG_MUSTER,
  VERSORGUNG_ROUTE,
  darfKennzahlAnlegen,
  energieBlock,
  kennzahlVorschlag,
  kennzahlenDesGebaeudes,
  messstellenBlock,
  offenSatz,
  registerZiel,
} from './gebaeudeKarte';
import { UEMS_NOCH_NICHT_GERECHNET_SATZ } from './glossar';
import { mitVorschlag, leererEntwurf, waehle } from './kennzahlAnlegen';
import { ortAus, ortSchluessel } from './messstellen';
import { standortMessstellenRoute } from './nav';
import { ahrenbergBilanz } from './test/bilanzFixtures';
import { selbstauskunftFuer } from './test/berichtFixtures';
import { rechteAus } from './berichtDialoge';
import { ahrenbergKennzahlen } from './test/kennzahlenFixtures';
import { ahrenbergRegister } from './test/messstellenRegisterFixtures';
import { ORT_IDS } from './test/ortsbaumFixtures';
import faelle from './test/oberflaechenFaelle.json';
import { FIXTURE_IDS } from './test/standorteFixtures';
import { gebaeude as gebaeudeSicht } from './uemsBilanz';
import { versorgungAhrenberg } from './test/versorgungFixtures';
import { versorgungZeilen } from './versorgung';
import type { AnlageBilanz, BilanzPeriode } from './uebersichtBausteine';

/**
 * Die Gebäude-Karte (UEMS AP-13 IP-10 = AP-10 IP-17 Portal-Teil; E4 = A, Ü6, B4) gegen den Referenzfall O4 aus
 * `test/oberflaechenFaelle.json`: Standort › Gebäude › Halle 2, Oktober 2026.
 *
 * Verglichen wird die ZAHL, nicht ihre Schreibweise — die Anzeige setzt Tausenderpunkt und schmales Leerzeichen.
 */

const NBSP = String.fromCharCode(160);
const eben = (s: string | null | undefined) => (s ?? '').split(NBSP).join(' ');
const ziffern = (s: string) => Number((/[\d.]+(?= kWh)/.exec(eben(s))?.[0] ?? 'NaN').split('.').join(''));
type Fall = { id: string; gegeben: Record<string, unknown>; erwartet: Record<string, unknown> };
const fall = (id: string) => (faelle as unknown as { faelle: Fall[] }).faelle.find((f) => f.id === id)!;
const O4 = fall('O4');

const { st1, st2, an1, an2 } = FIXTURE_IDS;
const NAMEN: Record<string, string> = { [an1]: 'Werk Ahrenberg – Halle 1', [an2]: 'Werk Ahrenberg – Halle 2' };
const bilanzen = (ids: string[], periode: BilanzPeriode, am: string): AnlageBilanz[] =>
  ids.map((id) => ({ anlage: { id, name: NAMEN[id] }, bilanz: ahrenbergBilanz(id, periode, am) as Bilanz }));

/** Die Messstellen IM Gebäude am Stichtag, wie der Wirt sie aus dem gefilterten Register baut. */
const imGebaeude = (ort: string, stichtag: string) =>
  new Map(ahrenbergRegister({ ort, stichtag }).register.map((z) => [z.kennzeichen, z.name ?? z.kennzeichen]));

const halle2 = (periode: BilanzPeriode, am: string, stichtag: string, heute = '2026-11-10') =>
  energieBlock({ gebaeudeName: 'Halle 2', periode, am, heute, anlagen: bilanzen([an1, an2], periode, am), imZeitraum: imGebaeude('G-2', stichtag) });

describe('UEMS AP-13 IP-10 · O4 — Standort › Gebäude › Halle 2, Oktober 2026 (E4 = A, Ü6, B4)', () => {
  const block = halle2('monat', '2026-10-01', '2026-10-31');

  it('nur das System Halle 2 erscheint — Halle 1 misst nicht in diesem Gebäude', () => {
    expect(block.hinweis).toBeNull();
    expect(block.systeme.map((s) => s.anlage)).toEqual(['Werk Ahrenberg – Halle 2']);
    expect(block.offen).toEqual([]);
    expect(block.zeitraum).toBe('Oktober 2026');
  });

  it('„Gemessen im Gebäude 32.000 kWh (3 Messstellen)“ — die Summe des Zwillings, nicht der Karte', () => {
    const s = block.systeme[0];
    expect(eben(s.gemessen)).toBe('Gemessen im Gebäude 32.000 kWh (3 Messstellen)');
    expect(ziffern(s.gemessen)).toBe(O4.gegeben.summe_im_gebaeude);
  });

  it('die Posten sind die drei Messstellen des Gebäudes mit ihren Mengen (22.400 · 6.100 · 3.500)', () => {
    const s = block.systeme[0];
    const soll = O4.gegeben.im_gebaeude as Record<string, number>;
    expect(s.posten.map((p) => p.messstelle)).toEqual(['MS-11', 'MS-12', 'MS-13']);
    expect(s.posten.map((p) => p.name)).toEqual(['Spritzguss SG07–SG10', 'Montage Linie M1', 'Lager Halle 2 (Allgemein)']);
    expect(s.posten.map((p) => ziffern(p.menge!))).toEqual(Object.values(soll));
  });

  it('„Außerhalb des Gebäudes, im selben System: Ladepunkt … 1.100 kWh“ — MS-14 zählt NICHT im Gebäude mit', () => {
    const s = block.systeme[0];
    expect(eben(s.ausserhalb!)).toContain('Außerhalb des Gebäudes, im selben System:');
    expect(eben(s.ausserhalb!)).toContain('Ladepunkt Parkplatz Halle 2');
    expect(ziffern(s.ausserhalb!)).toBe(Object.values(O4.gegeben.ausserhalb_im_system as Record<string, number>)[0]);
    expect(s.ausserhalb).not.toContain('MS-14');
  });

  it('„Rest des Systems Werk Ahrenberg – Halle 2: 3.800 kWh nicht verortet“ — der Rest gehört der Anlage (AP-10 E9)', () => {
    const s = block.systeme[0];
    expect(eben(s.rest!)).toBe('Rest des Systems Werk Ahrenberg – Halle 2: 3.800 kWh nicht verortet');
    expect(ziffern(s.rest!)).toBe(O4.gegeben.rest_des_systems);
    expect(s.ziel).toEqual({ page: 'anlagen', siteId: an2, sub: 'energiebilanz' });
  });

  it('KEINE Gebäude-Summe: `gebaeudeverbrauch` ist immer null und erscheint nirgends (B4, §4.8)', () => {
    const sicht = gebaeudeSicht('Halle 2', an2, 'kWh', [], null);
    expect(sicht.gebaeudeverbrauch).toBeNull();
    expect(O4.erwartet.gebaeudeverbrauch).toBeNull();
    expect(JSON.stringify(block)).not.toContain('gebaeudeverbrauch');
    // 32.000 + 1.100 + 3.800 = 36.900 — diese Summe steht an der ANLAGE, nie in der Gebäude-Karte.
    expect(ziffern(JSON.stringify(block))).not.toBe(36900);
    expect(eben(JSON.stringify(block))).not.toContain('36.900');
  });

  it('der Satz der Karte nennt dieselben Teile wie der Referenzfall', () => {
    const s = block.systeme[0];
    const satz = eben([s.gemessen, s.ausserhalb, s.rest].join(' · '));
    for (const zahl of ['32.000', '1.100', '3.800']) expect(satz).toContain(zahl);
    expect(O4.erwartet.energie).toContain('nicht verortet');
  });
});

describe('UEMS AP-13 IP-10 · Block „Messstellen“ — das Register zählt, die Karte spricht nur (Ü6, E13)', () => {
  it('der Satz kommt WÖRTLICH aus dem Aggregat des gefilterten Registers', () => {
    const register = ahrenbergRegister({ ort: 'G-2' });
    const block = messstellenBlock({ standortId: st1, gebaeudeKurzzeichen: 'G-2', register, mitStichtag: false });
    expect(block.text).toBe(register.aggregat.unternehmen.text);
    expect(block.ton).toBe('ok');
    expect(block.anlegen).toBe(false);
  });

  it('BEFUND: das Register sagt „5 von 5“, O4 nennt „3 von 3“ — seit E13 zählen Hauptzähler und berechnete mit', () => {
    // MS-10 (Hauptzähler Halle 2) und MS-15 (berechnet, „Halle 2 nicht zugeordnet“) stehen beide in G-2. Die Karte
    // erfindet keine dritte Zählung: sie sagt, was das Register sagt (AP-13 IP-7, E13). Der Referenzfall stammt aus
    // der Zeit vor E13 — wie schon bei O3 (Werk Lindach „3 von 3“ statt „4 von 4“).
    const block = messstellenBlock({ standortId: st1, gebaeudeKurzzeichen: 'G-2', register: ahrenbergRegister({ ort: 'G-2' }), mitStichtag: false });
    expect(block.text).toBe('5 von 5 Messstellen liefern Daten');
    expect(O4.gegeben.datenlage_gebaeude).toBe('3 von 3 Messstellen liefern Daten');
  });

  it('der Sprung geht ins Register MIT Filter Ort — als Kurzzeichen in der Adresse, lesbar als Lesezeichen', () => {
    const ziel = registerZiel(st1, 'G-2');
    expect(ziel.route).toEqual(standortMessstellenRoute(st1));
    expect(ziel.hash).toBe(`#/standort/${st1}/messstellen?ort=G-2`);
    // …und das Register liest ihn: Kurzzeichen aus der Adresse, Schlüssel der Auswahlliste aus seiner Antwort.
    expect(ortAus(ziel.hash)).toBe('G-2');
    expect(ortSchluessel(ahrenbergRegister(), 'G-2')).toBe(ahrenbergRegister({ ort: 'G-2' }).register[0].ort.id);
  });

  it('ohne Kurzzeichen bleibt es das ganze Register des Standorts — kein Filter aus dem Nichts', () => {
    expect(registerZiel(st1, null).hash).toBe(`#/standort/${st1}/messstellen`);
    expect(ortAus(registerZiel(st1, null).hash)).toBeNull();
  });

  it('Leerzustand: ein Gebäude ohne Messstelle trägt den Weg „Messstelle anlegen“ — mit Stichtag nicht (AP-02 IP-13)', () => {
    const leer = ahrenbergRegister({ ort: 'G-3', stichtag: '2024-01-01' });
    expect(messstellenBlock({ standortId: st1, gebaeudeKurzzeichen: 'G-3', register: leer, mitStichtag: false })).toMatchObject({ text: null, anlegen: true });
    expect(messstellenBlock({ standortId: st1, gebaeudeKurzzeichen: 'G-3', register: leer, mitStichtag: true })).toMatchObject({ text: null, anlegen: false });
  });
});

describe('UEMS AP-13 IP-10 · Block „Kennzahlen“ — Geltung IM Gebäude (Ü6, AP-11 §6.6)', () => {
  const liste = ahrenbergKennzahlen();

  it('Halle 2 zeigt KZ-0001; die Kennzahl von Lindach und die des Unternehmens bleiben draußen', () => {
    const hier = kennzahlenDesGebaeudes(liste, ORT_IDS.g2, [ORT_IDS.b3, ORT_IDS.b4, ORT_IDS.b5]);
    expect(hier?.map((k) => k.kennzeichen)).toEqual(['KZ-0001']);
  });

  it('ein Bereich des Gebäudes zählt mit — seine Kennzahl liegt IM Gebäude und stünde sonst nirgends', () => {
    const imBereich = [{ ...liste[0], id: 'kz-b3', kennzeichen: 'KZ-0009', geltung_art: 'bereich' as const, geltung_id: ORT_IDS.b3 }];
    expect(kennzahlenDesGebaeudes([...liste, ...imBereich], ORT_IDS.g2, [ORT_IDS.b3])?.map((k) => k.kennzeichen)).toEqual(['KZ-0001', 'KZ-0009']);
    // …aber nur die Bereiche DIESES Gebäudes.
    expect(kennzahlenDesGebaeudes([...liste, ...imBereich], ORT_IDS.g2, [])?.map((k) => k.kennzeichen)).toEqual(['KZ-0001']);
  });

  it('eine archivierte Kennzahl erscheint nicht; ohne Kennzahl gibt es den Block nicht (nie leer gezeigt)', () => {
    const archiviert = liste.map((k) => ({ ...k, archiviert_am: '2026-11-01T00:00:00+01:00' }));
    expect(kennzahlenDesGebaeudes(archiviert, ORT_IDS.g2, [])).toBeNull();
    expect(kennzahlenDesGebaeudes(null, ORT_IDS.g2, [])).toBeNull();
    expect(kennzahlenDesGebaeudes([], ORT_IDS.g2, [])).toBeNull();
  });
});

describe('UEMS AP-13 IP-10 · „Kennzahl anlegen“ — nur mit Recht, mit Vorschlag, nie still (G3, AP-11 §6.6)', () => {
  const block = halle2('monat', '2026-10-01', '2026-10-31');
  const rechte = (person: string) => rechteAus(selbstauskunftFuer(person));

  it('der Vorschlag ist GENAU die Menge, die die Karte eben genannt hat — kein Hauptzähler, kein Rest', () => {
    const v = kennzahlVorschlag({ id: ORT_IDS.g2, name: 'Halle 2' }, block)!;
    expect(v.menge).toEqual(['MS-11', 'MS-12', 'MS-13']);
    expect(v.menge).not.toContain('MS-10');
    expect(v.menge).not.toContain('MS-15');
    expect(v.geltung).toBe(`gebaeude:${ORT_IDS.g2}`);
    expect(eben(v.satz)).toContain('Vorgeschlagen: die 3 Messstellen, die in Halle 2 messen (MS-11, MS-12, MS-13).');
  });

  it('der Vorschlag belegt den Entwurf des Assistenten vor — sichtbar, änderbar, und ohne Menge gibt es keinen', () => {
    const v = kennzahlVorschlag({ id: ORT_IDS.g2, name: 'Halle 2' }, block)!;
    const entwurf = mitVorschlag(leererEntwurf('Ines Kaltenbach'), v, []);
    expect(entwurf.menge).toEqual(['MS-11', 'MS-12', 'MS-13']);
    expect(entwurf.geltung).toBe(`gebaeude:${ORT_IDS.g2}`);
    // Wer selbst gewählt hat, behält es — der Vorschlag drängt sich nicht ein zweites Mal auf.
    expect(mitVorschlag({ ...entwurf, menge: ['MS-12'] }, v, []).menge).toEqual(['MS-12']);
    // Eine Vorlage wirft die Menge weg (§5.1) — der Vorschlag kommt mit, soweit er zu ihrer Erwartung passt.
    const register = ahrenbergRegister().register;
    expect(mitVorschlag(waehle(entwurf, 'stromeinsatz_je_stueck'), v, register).menge).toEqual(['MS-11', 'MS-12', 'MS-13']);
    expect(kennzahlVorschlag({ id: ORT_IDS.g2, name: 'Halle 2' }, { zeitraum: 'Oktober 2026', hinweis: NICHT_MESSBAR, systeme: [], offen: [] })).toBeNull();
  });

  it('das Recht wird GEFRAGT, nicht geraten: Kundenadministrator und Energiemanager ja, der Leser nie', () => {
    expect(RECHT_KENNZAHL).toBe('kennzahl.standort_definieren');
    expect(darfKennzahlAnlegen(rechte('Jonas Wendlinger'), st1)).toBe(true);
    expect(darfKennzahlAnlegen(rechte('Ines Kaltenbach'), st1)).toBe(true);
    expect(darfKennzahlAnlegen(rechte('Claudia Berger'), st1)).toBe(false);
  });

  it('der Bearbeiter darf an SEINEM Standort — Peter Hollerbach in Lindach, nicht in Ahrenberg (AP-11 E10)', () => {
    expect(darfKennzahlAnlegen(rechte('Peter Hollerbach'), st2)).toBe(true);
    expect(darfKennzahlAnlegen(rechte('Peter Hollerbach'), st1)).toBe(false);
  });

  it('solange die Selbstauskunft fehlt, steht der Weg nicht (kein Aufblitzen); ist sie nicht zu haben, entscheidet die Route', () => {
    expect(darfKennzahlAnlegen(undefined, st1)).toBe(false);
    expect(darfKennzahlAnlegen(null, st1)).toBe(true);
  });
});

describe('UEMS AP-13 IP-10 · wenn es nichts zu zeigen gibt: Gründe statt Zahlen', () => {
  it('ein Gebäude ohne Messstelle ist „nicht messbar“ (AP-10 F15) — keine 0, kein leerer Block', () => {
    const block = energieBlock({
      gebaeudeName: 'Verwaltung',
      periode: 'monat',
      am: '2026-10-01',
      heute: '2026-11-10',
      anlagen: bilanzen([an1, an2], 'monat', '2026-10-01'),
      imZeitraum: new Map(),
    });
    expect(block.hinweis).toBe(NICHT_MESSBAR);
    expect(block.systeme).toEqual([]);
  });

  it('Messstellen ja, aber keine in einem System: nicht „nicht messbar“, sondern der eigene Satz', () => {
    const block = energieBlock({
      gebaeudeName: 'Verwaltung',
      periode: 'monat',
      am: '2026-10-01',
      heute: '2026-11-10',
      anlagen: bilanzen([an2], 'monat', '2026-10-01'),
      imZeitraum: new Map([['MS-21', 'Gas Heizung Verwaltung']]),
    });
    expect(block.hinweis).toBe(OHNE_SYSTEM);
    expect(block.hinweis).not.toBe(NICHT_MESSBAR);
  });

  it('der laufende Zeitraum ist noch nicht gebildet — nie eine Hochrechnung (E11)', () => {
    const block = halle2('monat', '2026-11-01', '2026-11-10');
    expect(block.hinweis).toBe(UEMS_NOCH_NICHT_GERECHNET_SATZ);
    expect(block.systeme).toEqual([]);
  });

  it('ohne Werte im Zeitraum sagt die Karte „keine Werte“, nie 0', () => {
    const block = halle2('tag', '2026-10-19', '2026-10-19');
    expect(eben(block.systeme[0].gemessen)).toBe('Gemessen im Gebäude: keine Werte (3 Messstellen)');
    expect(block.systeme[0].ton).toBe('off');
  });

  it('eine Anlage ohne abrufbare Bilanz wird GENANNT — sonst sähe die Karte vollständig aus', () => {
    const block = energieBlock({
      gebaeudeName: 'Halle 2',
      periode: 'monat',
      am: '2026-10-01',
      heute: '2026-11-10',
      anlagen: [...bilanzen([an2], 'monat', '2026-10-01'), { anlage: { id: an1, name: NAMEN[an1] }, bilanz: null }],
      imZeitraum: imGebaeude('G-2', '2026-10-31'),
    });
    expect(block.offen).toEqual(['Werk Ahrenberg – Halle 1']);
    expect(offenSatz(block.offen)).toContain('Werk Ahrenberg – Halle 1');
    expect(block.systeme).toHaveLength(1);
  });

  it('solange die Bilanzen oder das Register fehlen, steht keine Zahl da — und kein falscher Grund', () => {
    const ohneBilanz = energieBlock({ gebaeudeName: 'Halle 2', periode: 'monat', am: '2026-10-01', heute: '2026-11-10', anlagen: null, imZeitraum: imGebaeude('G-2', '2026-10-31') });
    expect(ohneBilanz).toMatchObject({ hinweis: null, systeme: [], offen: [] });
    const ohneRegister = energieBlock({ gebaeudeName: 'Halle 2', periode: 'monat', am: '2026-10-01', heute: '2026-11-10', anlagen: bilanzen([an2], 'monat', '2026-10-01'), imZeitraum: null });
    expect(ohneRegister).toMatchObject({ hinweis: null, systeme: [], offen: [] });
  });
});

describe('UEMS AP-10 IP-17 · die Zeile „Versorgung“ ist nach der Route gebaut', () => {
  it(`spricht das Muster aus der Antwort von \`GET ${VERSORGUNG_ROUTE}?stichtag=\``, () => {
    expect(VERSORGUNG_MUSTER).toBe('{gebaeude} ← System {anlage}');
    expect(versorgungZeilen(versorgungAhrenberg()).map((z) => z.text)).toContain(
      'Halle 2 ← System Halle 2 (NA-2)',
    );
  });
});
