import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KennzahlVorschau, MessstelleRegisterZeile } from './api';
import * as A from './kennzahlAnlegen';
import { KENNZAHL_VORLAGEN, kennzahlVorlage, vorbelegung } from './kennzahlVorlagen';
import {
  ahrenbergBezugsgroessen,
  ahrenbergKostenstellen,
  ahrenbergProzesse,
  kennzahlVorschauAntwort,
} from './test/kennzahlAnlegenFixtures';
import { ahrenbergKennzahlen } from './test/kennzahlenFixtures';
import { fassungenVon } from './test/kennzahlWerteFixtures';
import { ahrenbergRegister } from './test/messstellenRegisterFixtures';
import { ORT_IDS, ortsbaumAhrenberg, ortsbaumLindach } from './test/ortsbaumFixtures';
import { ahrenbergHeute, ahrenbergUnternehmen, FIXTURE_IDS } from './test/standorteFixtures';
import * as KZ from './uemsKennzahl';

/**
 * Der Assistent „Kennzahl anlegen“ und das Kopieren (UEMS AP-11 IP-14) — gegen den Zwilling `uemsKennzahl.ts` und die
 * Vektoren `docs/contracts/v2/kennzahl-vectors.json`: jeder rote Satz der Fläche IST der Satz der Regel (K13, K16, U2,
 * G3), nie ein eigener Text. Alle Objekte aus dem Referenzunternehmen Ahrenberg.
 */

type Pruefung = { regel: string; name: string; eingang: Record<string, any>; ergebnis: Record<string, any> };

// vitest läuft mit cwd = frontend/portal (wie `uemsKennzahl.test.ts`).
const vektoren: unknown = JSON.parse(readFileSync(resolve(process.cwd(), '../../docs/contracts/v2/kennzahl-vectors.json'), 'utf8'));
const pruefungen: Pruefung[] = [];
const sammle = (x: unknown): void => {
  if (Array.isArray(x)) x.forEach(sammle);
  else if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    if (typeof o.regel === 'string' && typeof o.name === 'string' && 'eingang' in o) pruefungen.push(o as unknown as Pruefung);
    else Object.values(o).forEach(sammle);
  }
};
sammle(vektoren);
const fall = (name: string): Pruefung => {
  const f = pruefungen.find((p) => p.name === name);
  if (!f) throw new Error(`Vektor fehlt: ${name}`);
  return f;
};

const NB = String.fromCharCode(160);
const register = ahrenbergRegister().register;
const { bezugsgroessen, bezugsflaechen } = ahrenbergBezugsgroessen();
const ms = (kz: string): MessstelleRegisterZeile => register.find((z) => z.kennzeichen === kz)!;
const messstelle = (kz: string): A.Seite => ({ art: 'messstelle', zeile: ms(kz) });
const bezugsgroesse = (kz: string): A.Seite => ({ art: 'bezugsgroesse', bg: bezugsgroessen.find((b) => b.kennzeichen === kz)! });
const orte = A.geltungsOrte({
  unternehmen: ahrenbergUnternehmen(),
  standorte: ahrenbergHeute().standorte,
  baeume: [ortsbaumAhrenberg(), ortsbaumLindach()],
  prozesse: ahrenbergProzesse(),
  kostenstellen: ahrenbergKostenstellen(),
  messstellen: register,
});
const ort = (art: string, id: string): A.GeltungOrt => orte.find((o) => o.wert === A.geltungWert(art, id))!;
const NOVEMBER = Date.parse('2026-11-10T08:00:00Z');

describe('Schritt 3: Perioden-Prüfung sofort unter der Auswahl (K13, P1–P3)', () => {
  it('Versuch 1 — je Tag aus BZ-6 (Monat): der rote Satz ist der Satz des Zwillings, „Weiter“ gesperrt', () => {
    const f = fall('Versuch 1: Kennzahl je Tag aus BZ-6 (Monat) → periode_passt_nicht');
    // Die Eingänge, die der Assistent aus Register und Bezugsgröße bildet, SIND die des Vektors.
    expect([A.periodenEingang(messstelle('MS-12')), A.periodenEingang(bezugsgroesse('BZ-6'))]).toEqual(f.eingang.eingaenge);

    const p = A.pruefeBerechnung('quotient', messstelle('MS-12'), bezugsgroesse('BZ-6'), f.eingang.gewuenscht)!;
    expect(p.fehler).toBe('periode_passt_nicht');
    expect(p.satz).toBe(f.ergebnis.kundensatz);
    expect(p.satz).toBe(KZ.periode('tag', f.eingang.eingaenge as KZ.PeriodenEingang[]).kundensatz);
    expect(p.satz).toBe('BZ-6 Gutteile Montage Halle 2 führt Monatswerte. Eine Kennzahl je Tag ist damit nicht bildbar — ein Monatswert wird nie auf Tage verteilt.');
    expect(p.hinweis).toBeNull();

    const e = { ...A.waehle(A.leererEntwurf('Ines Kaltenbach'), 'stromeinsatz_je_stueck'), menge: ['MS-12'], bezug: 'BZ-6', periode: 'tag' as const };
    expect(A.weiterMoeglich(3, e, p, null)).toBe(false);
  });

  it('ohne Wunsch — „BZ-6 führt Monatswerte — die Kennzahl wird je Monat und Jahr gebildet“', () => {
    const f = fall('KZ-0001 ohne Wunsch → Monat und Jahr');
    const p = A.pruefeBerechnung('quotient', messstelle('MS-12'), bezugsgroesse('BZ-6'), null)!;
    expect(p.fehler).toBeNull();
    expect(p.grundperiode).toBe(f.ergebnis.grundperiode);
    expect(p.perioden).toEqual(f.ergebnis.perioden);
    expect(p.hinweis).toBe('BZ-6 führt Monatswerte — die Kennzahl wird je Monat und Jahr gebildet');
    expect(p.einheit).toBe(fall('MS-12 (kWh) je BZ-6 (Stück) → kWh/Stück, nie gekürzt').ergebnis.einheit);
    expect(p.einheitAnzeige).toBe('kWh je Stück');
    const e = { ...A.waehle(A.leererEntwurf('Ines Kaltenbach'), 'stromeinsatz_je_stueck'), menge: ['MS-12'], bezug: 'BZ-6' };
    expect(A.weiterMoeglich(3, e, p, null)).toBe(true);
  });

  it('ein Stammdatum trägt keine Periode: MS-10 je Fläche liest die Tageswerte der Messstelle', () => {
    const mitarbeitende = { ...bezugsgroessen[0], kennzeichen: 'BZ-8', name: 'Mitarbeitende', einheit: 'Personen', wertart: 'stammdatum' as const, periode_art: null };
    const p = A.pruefeBerechnung('quotient', messstelle('MS-10'), { art: 'bezugsgroesse', bg: mitarbeitende }, null)!;
    expect(p.hinweis).toBe('MS-10 führt Tageswerte — die Kennzahl wird je Tag, Woche, Monat und Jahr gebildet');
    expect(p.einheitAnzeige).toBe('kWh je Person');
  });

  it('U2 — ein Anteil aus kWh und Stück: der Satz aus §5.8', () => {
    const p = A.pruefeBerechnung('anteil', messstelle('MS-12'), bezugsgroesse('BZ-6'), null)!;
    expect(p.fehler).toBe('einheit_unpassend');
    expect(p.satz).toBe('Ein Anteil braucht zwei Werte derselben Größe — MS-12 (kWh) und BZ-6 (Stück) ergeben einen Quotienten, keinen Anteil.');
  });
});

describe('Kreis (K16): ein Befund der Vorschau mit Kette spricht der Zwilling', () => {
  for (const name of ['KZ-0012 → KZ-0011 → KZ-0012 → formel_zyklus mit Kette', 'Selbstverweis → Kette der Länge 2']) {
    it(name, () => {
      const f = fall(name);
      const u = KZ.zyklus(f.eingang.kennzeichen, f.eingang.verweise, f.eingang.bestehende);
      expect(u.kette).toEqual(f.ergebnis.kette);
      const b = { code: 'formel_zyklus' as const, message: 'Satz der Route', fakten: { kette: u.kette } };
      expect(A.befundSatz(b)).toBe(f.ergebnis.kundensatz);
      expect(A.befundSchritt(b.code)).toBe(2);
    });
  }

  it('ohne Kette bleibt der Satz der Route stehen', () => {
    expect(A.befundSatz({ code: 'geltung_unbekannt', message: 'Dieses Gebäude gibt es nicht (mehr).', fakten: { feld: 'geltung_id' } })).toBe(
      'Dieses Gebäude gibt es nicht (mehr).',
    );
    expect(A.befundSchritt('periode_passt_nicht')).toBe(3);
    expect(A.befundSchritt('eingang_ausserhalb_geltung')).toBe(4);
  });
});

describe('Schritt 1: Vorlagen als Karten (E9, K20)', () => {
  it('die Vorlagen in Katalog-Reihenfolge, dazu „ohne Vorlage“ — mit Satz und Rechenform in Kundensprache', () => {
    const karten = A.vorlagenKarten();
    expect(karten.map((k) => k.wert)).toEqual([...KENNZAHL_VORLAGEN.map((v) => v.kennung), A.OHNE_VORLAGE]);
    expect(karten[0]).toEqual({
      wert: 'stromeinsatz_je_stueck',
      titel: 'Stromeinsatz je Stück',
      satz: 'Setzt den Strombezug ins Verhältnis zu den guten Stücken, etwa einer Montagelinie.',
      form: 'Menge je Bezugsgröße',
    });
    expect(karten[6].form).toBe('Teil an Ganzem');
  });

  it('eine andere Wahl nimmt keine Eingänge still mit; „ohne Vorlage“ beginnt mit „Menge je Bezugsgröße“', () => {
    const e = { ...A.waehle(A.leererEntwurf('Ines Kaltenbach'), 'stromeinsatz_je_stueck'), menge: ['MS-12'], bezug: 'BZ-6' };
    const autarkie = A.waehle(e, 'autarkiegrad');
    expect(autarkie).toMatchObject({ rechenform: 'anteil', komplement: true, menge: [], bezug: null, zweck: 'Anteil des Verbrauchs, der nicht aus dem Netz kommt' });
    const ohne = A.waehle(autarkie, A.OHNE_VORLAGE);
    expect(ohne).toMatchObject({ rechenform: 'quotient', komplement: false, zweck: '' });
    expect(A.rechenformWaehlen(ohne, 'zusammenfassung')).toMatchObject({ rechenform: 'zusammenfassung', menge: [], paare: [] });
  });
});

describe('Schritt 2 und 3: gefiltert auf die Erwartung der Vorlage', () => {
  const je = (kennung: string) => A.waehle(A.leererEntwurf('Ines Kaltenbach'), kennung);

  it('„Stromeinsatz je Stück“: Menge = Wirkenergie · Bezug (gemessen und Gesamtwert), Bezugsgröße = Stück', () => {
    const menge = A.messstellenAuswahl(register, A.mengeErwartung(je('stromeinsatz_je_stueck')));
    const werte = menge.optionen.map((o) => o.value);
    for (const kz of ['MS-01', 'MS-12', 'MS-18', 'MS-19', 'MS-20']) expect(werte).toContain(kz);
    for (const kz of ['MS-02', 'MS-03', 'MS-04', 'MS-21']) expect(werte).not.toContain(kz);
    expect(menge.passend).toBe(werte.length);
    expect(menge.gesamt).toBe(register.length);
    expect(menge.optionen.find((o) => o.value === 'MS-12')).toMatchObject({
      label: 'MS-12 Montage Linie M1', sub: 'Messstelle · Wirkenergie · Bezug · Halle 2 Montage', group: 'Werk Ahrenberg', disabled: false,
    });
    expect(menge.optionen.find((o) => o.value === 'MS-19')?.sub).toBe('Summenwert · Wirkenergie · Bezug · Kunststoffwerk Ahrenberg GmbH');
    expect(A.erwartungHinweis('Messstelle oder Gesamtwert, Wirkenergie · Bezug', menge)).toBe(
      `Die Vorlage erwartet: Messstelle oder Gesamtwert, Wirkenergie · Bezug. ${menge.passend} von ${register.length} Messstellen passen.`,
    );

    const bezug = A.bezugsgroessenAuswahl(bezugsgroessen, bezugsflaechen, A.bezugErwartung(je('stromeinsatz_je_stueck')) as never);
    expect(bezug.optionen.map((o) => o.value)).toEqual(['BZ-2', 'BZ-6', 'BZ-7']);
    expect(bezug.optionen[1]).toMatchObject({ label: 'BZ-6 Gutteile Montage Halle 2', sub: 'Stück · Monatswerte · Gebäude Halle 2', disabled: false });
  });

  it('„je m²“: keine Bezugsgröße mit Kennzeichen — die Flächen der Struktur stehen gesperrt mit Grund', () => {
    const bezug = A.bezugsgroessenAuswahl(bezugsgroessen, bezugsflaechen, A.bezugErwartung(je('stromeinsatz_je_m2')) as never);
    expect(bezug.passend).toBe(0);
    expect(bezug.optionen).toHaveLength(5);
    expect(bezug.optionen.every((o) => o.disabled && o.disabledHint === A.FLAECHE_KEIN_EINGANG && o.group === A.FLAECHEN_GRUPPE)).toBe(true);
    expect(bezug.optionen[1]).toMatchObject({ label: 'Bezugsfläche Halle 2', sub: 'm² · Stammdatum · Gebäude G-2' });
  });

  it('„Eigenverbrauchsanteil“: der Teil nur als Gesamtwert, ohne Richtung — das Ganze als Erzeugung', () => {
    const e = je('eigenverbrauchsanteil');
    const teil = A.messstellenAuswahl(register, A.mengeErwartung(e)).optionen.map((o) => o.value);
    expect(teil.every((kz) => ms(kz).art === 'berechnet')).toBe(true);
    const ganzes = A.messstellenAuswahl(register, A.bezugErwartung(e) as never, 'MS-03').optionen;
    expect(ganzes.map((o) => o.value)).toEqual(['MS-03']);
    expect(ganzes[0]).toMatchObject({ disabled: true, disabledHint: A.SCHON_GEWAEHLT });
  });

  it('ohne Vorlage bleibt ein Momentanwert sichtbar und nennt den Satz des Zwillings', () => {
    const momentan = { ...ms('MS-12'), kennzeichen: 'MS-99', hauptgroesse: { groesse: 'Wirkleistung', richtung: 'Bezug', einheit: 'kW', wertart: 'Momentanwert' } };
    const o = A.messstellenAuswahl([momentan], null).optionen[0];
    expect(o.disabled).toBe(true);
    expect(o.disabledHint).toBe(KZ.satz('einheit_momentanwert', { objekt: 'MS-99', einheit: 'kW' }));
  });
});

describe('Hebel: mehrere Messstellen → Gesamtwert-Assistent (E2)', () => {
  it('zwei Auswahlen sperren „Weiter“ und nennen die Anlage; zurück kommt der neue Gesamtwert als Menge', () => {
    const e = { ...A.waehle(A.leererEntwurf('Ines Kaltenbach'), 'stromeinsatz_je_stueck'), menge: ['MS-12', 'MS-18'] };
    expect(A.weiterMoeglich(2, e, null, null)).toBe(false);
    const anlage = A.hebelAnlage(register, e.menge)!;
    expect(anlage).toEqual({ id: FIXTURE_IDS.an2, name: 'Werk Ahrenberg – Halle 2' });
    expect(A.hebelOrt(anlage)).toBe('Der Summenwert entsteht an der Anlage Werk Ahrenberg – Halle 2.');
    expect(A.hebelAnlage(register, ['MS-20'])).toBeNull();
    const zurueck = A.nachGesamtwert(e, 'MS-23');
    expect(zurueck.menge).toEqual(['MS-23']);
    expect(A.weiterMoeglich(2, zurueck, null, null)).toBe(true);
  });
});

describe('Schritt 4: Geltungsbereich, Name, Verantwortlich, Zweck (K20, G1, G3)', () => {
  it('KZ-0001 aus der Vorlage: Halle 2 vorgeschlagen, Name vorbelegt, Rechte „Standort Werk Ahrenberg“ — dieselbe Anfrage wie K20', () => {
    const v = kennzahlVorlage('stromeinsatz_je_stueck')!;
    let e = { ...A.waehle(A.leererEntwurf('Ines Kaltenbach'), v.kennung), menge: ['MS-12'], bezug: 'BZ-6' };
    const w = A.geltungVorschlag(e.rechenform, orte, messstelle('MS-12'), bezugsgroesse('BZ-6'));
    expect(w).toBe(A.geltungWert('gebaeude', ORT_IDS.g2));
    const o = ort('gebaeude', ORT_IDS.g2);
    e = { ...e, geltung: w, name: A.nameVorschlag(e, null, o) };
    expect(e.name).toBe('Stromeinsatz je Stück — Halle 2');
    expect(A.nameVorschlag(e, null, null)).toBe('Stromeinsatz je Stück');
    expect(A.rechteGeltung(o)).toEqual({ text: 'Standort Werk Ahrenberg', fehler: null });
    expect(A.geltungText(o)).toBe('Gebäude Halle 2 (G-2)');
    expect(A.pruefeGeltung(o, [A.eingangOrt(messstelle('MS-12'), orte), A.eingangOrt(bezugsgroesse('BZ-6'), orte)])).toBeNull();
    expect(A.weiterMoeglich(4, e, null, null)).toBe(true);

    const a = A.anfrage(e, o);
    const k20 = vorbelegung(v, { art: 'gebaeude', id: ORT_IDS.g2, name: 'Halle 2' });
    expect(a).toEqual({
      ...k20,
      verantwortlich_name: 'Ines Kaltenbach',
      eingaenge: [
        { rolle: 'zaehler', art: 'messstelle', kennzeichen: 'MS-12' },
        { rolle: 'nenner', art: 'bezugsgroesse', kennzeichen: 'BZ-6' },
      ],
    });
    expect(a.kennzeichen).toBeNull();
    expect(A.berechnungText(e)).toBe('Menge je Bezugsgröße · MS-12 je BZ-6');
  });

  it('G3 — Montagehalle Lindach liest MS-12 nicht: der Satz des Zwillings', () => {
    const lindach = ort('gebaeude', ORT_IDS.g5);
    expect(A.rechteGeltung(lindach).text).toBe('Standort Werk Lindach');
    const satz = A.pruefeGeltung(lindach, [A.eingangOrt(messstelle('MS-12'), orte)]);
    expect(satz).toBe('MS-12 liegt in Werk Ahrenberg — eine Kennzahl für Werk Lindach kann sie nicht lesen.');
    const e = { ...A.waehle(A.leererEntwurf('Peter Hollerbach'), 'stromeinsatz_je_stueck'), menge: ['MS-12'], bezug: 'BZ-6', geltung: lindach.wert, name: 'x' };
    expect(A.weiterMoeglich(4, e, null, satz)).toBe(false);
  });

  it('ein Prozess gilt fürs Unternehmen und liest Eingänge beider Standorte', () => {
    const montage = orte.find((o) => o.art === 'prozess' && o.kennzeichen === 'P-2')!;
    expect(A.rechteGeltung(montage)).toEqual({ text: 'Unternehmen', fehler: null });
    expect(A.pruefeGeltung(montage, [A.eingangOrt(messstelle('MS-12'), orte), A.eingangOrt(messstelle('MS-18'), orte)])).toBeNull();
  });

  it('die Auswahl kennt Unternehmen, beide Ortsbäume, Prozesse, Kostenstellen und Messstellen', () => {
    const gruppen = [...new Set(orte.map((o) => o.gruppe))];
    expect(gruppen).toEqual(['Unternehmen', 'Werk Ahrenberg', 'Werk Lindach', 'Prozesse', 'Kostenstellen', 'Messstellen']);
    const halle2 = A.geltungOptionen(orte).find((o) => o.value === A.geltungWert('gebaeude', ORT_IDS.g2));
    expect(halle2).toMatchObject({ label: 'Halle 2', sub: 'Gebäude G-2', group: 'Werk Ahrenberg' });
  });
});

describe('Kopieren an der Kennzahl-Seite (§5.2, K20)', () => {
  it('Form, Name mit neuem Geltungsbereich und Zweck übernommen — Eingänge, Geltungsbereich und Verantwortlich neu', () => {
    const kz1 = ahrenbergKennzahlen()[0];
    const q = A.kopieQuelle(kz1, fassungenVon(kz1.id));
    expect(q).toMatchObject({ kennzeichen: 'KZ-0001', rechenform: 'quotient', geltung_name: 'Halle 2', komplement: false });
    const e = A.leererEntwurf('Peter Hollerbach', q);
    expect(e).toMatchObject({ wahl: A.KOPIE, rechenform: 'quotient', zweck: kz1.zweck, menge: [], bezug: null, geltung: null, verantwortlich: 'Peter Hollerbach' });
    expect(A.nameVorschlag(e, q, null)).toBe('Stromeinsatz Montage je Stück');
    const lindach = ort('gebaeude', ORT_IDS.g5);
    expect(A.nameVorschlag(e, q, lindach)).toBe('Stromeinsatz Montage je Stück — Montagehalle Lindach');
    expect(A.nameVorschlag(e, q, lindach)).toBe(KZ.kopie(q, 'Montagehalle Lindach').name);
    expect(A.eingaengeVon(e)).toEqual([]);
    expect(A.kopieTitel(q)).toBe('Kopie von KZ-0001');
  });
});

describe('Schritt 5: Vorschau — read-only, „vor dem Bestehen“ ist ein Fall (K1, K20)', () => {
  it('KZ-0001 am 10.11.2026: Oktober 0,15 vollständig, September und August vor dem Bestehen', () => {
    const e = { ...A.waehle(A.leererEntwurf('Ines Kaltenbach'), 'stromeinsatz_je_stueck'), menge: ['MS-12'], bezug: 'BZ-6', geltung: A.geltungWert('gebaeude', ORT_IDS.g2) };
    const o = ort('gebaeude', ORT_IDS.g2);
    const v = kennzahlVorschauAntwort(A.anfrage({ ...e, name: A.nameVorschlag(e, null, o) }, o), NOVEMBER);
    expect(A.anlegenMoeglich(v)).toBe(true);
    const zeilen = A.vorschauZeilen(v);
    expect(zeilen.map((z) => [z.periode, z.zahl.replaceAll(NB, ' '), z.zustand, z.kennzeichen, z.satz])).toEqual([
      ['Oktober 2026', '0,15 kWh je Stück', 'vollständig', 'berechnet (Kennzahl)', null],
      ['September 2026', '—', 'vor dem Bestehen', null, null],
      ['August 2026', '—', 'vor dem Bestehen', null, null],
    ]);
    expect(zeilen.map((z) => z.ton)).toEqual(['ok', 'off', 'off']);
    expect(A.vorschauKopf(e, o, 'Standort Werk Ahrenberg', v)).toContainEqual({ wort: 'Einheit', wert: 'kWh je Stück' });
  });

  it('eine Periode ohne Bezugsgröße nennt den Satz der Route; ein Befund sperrt „Anlegen“', () => {
    const ohne: KennzahlVorschau = {
      befunde: [], rechte_geltung: 'standort', standort_id: FIXTURE_IDS.st1, kennung: 'kennzahl.standort_definieren', einheit: 'kWh/Stück',
      einheit_anzeige: 'kWh/Stück', grundperiode: 'monat', perioden: ['monat', 'jahr'], periode_art: 'monat',
      letzte_perioden: [{
        periode_art: 'monat', schluessel: '2026-11', beschriftung: 'November 2026', von: '2026-11-01', bis: '2026-11-30', wert: null, zaehler: '6300',
        nenner: null, zustand: 'keine Werte', richtung: null, grund: 'nenner_fehlt', abdeckung_prozent: null, fassung: null, kennzeichen: [],
        anzeige: '—', kundensatz: 'Für November 2026 fehlt der Wert der Bezugsgröße BZ-6 Gutteile Montage Halle 2.',
      }],
    };
    expect(A.vorschauZeilen(ohne)[0]).toMatchObject({ zahl: '—', zustand: 'keine Werte', ton: 'off', satz: 'Für November 2026 fehlt der Wert der Bezugsgröße BZ-6 Gutteile Montage Halle 2.' });
    expect(A.anlegenMoeglich({ ...ohne, befunde: [{ code: 'periode_passt_nicht', message: 'x', fakten: {} }] })).toBe(false);
    expect(A.anlegenMoeglich(null)).toBe(false);
  });

  it('Fertig: „KZ-0001 angelegt · Fassung 1 gilt seit Beginn“; eine Ablehnung spricht nur ihren Kundensatz', () => {
    expect(A.fertigSatz({ kennzeichen: 'KZ-0001', fassung: 1 })).toBe('KZ-0001 angelegt · Fassung 1 gilt seit Beginn');
    const abgelehnt = Object.assign(new Error('Dafür braucht es die Rolle Energiemanager oder Kundenadministrator.'), { status: 403 });
    expect(A.ablehnungSatz(abgelehnt, A.ANLEGEN_FEHLER)).toBe('Dafür braucht es die Rolle Energiemanager oder Kundenadministrator.');
    expect(A.ablehnungSatz(new TypeError('Failed to fetch'), A.ANLEGEN_FEHLER)).toBe(A.ANLEGEN_FEHLER);
  });
});

describe('Zusammenfassung (§5.6): Kennzahlen statt Menge, Schritt 3 entfällt', () => {
  it('zwei Kennzahlen gleicher Form und Einheit — gewichtet; eine allein reicht nicht', () => {
    const [kz1, kz2] = ahrenbergKennzahlen();
    expect(A.pruefePaare([kz1, kz2])).toMatchObject({ fehler: null, einheit: 'kWh/Stück', hinweis: 'gewichtet (Summe ÷ Summe) · kWh je Stück' });
    expect(A.pruefePaare([kz1])).toMatchObject({ fehler: 'anfrage_ungueltig', satz: 'Eine Zusammenfassung braucht mindestens zwei Kennzahlen.' });
    expect(A.schrittWoerter('zusammenfassung')).toEqual(['Vorlage', 'Kennzahlen', 'entfällt', 'Geltungsbereich', 'Vorschau']);
    expect(A.naechster(2, 'zusammenfassung')).toBe(4);
    expect(A.voriger(4, 'zusammenfassung')).toBe(2);
    expect(A.naechster(2, 'quotient')).toBe(3);
    expect(A.geltungVorschlag('zusammenfassung', orte, null, null)).toBe(A.geltungWert('unternehmen', ahrenbergUnternehmen().id));
    const e = { ...A.rechenformWaehlen(A.waehle(A.leererEntwurf('Ines Kaltenbach'), A.OHNE_VORLAGE), 'zusammenfassung'), paare: ['KZ-0001', 'KZ-0002'] };
    expect(A.eingaengeVon(e)).toEqual([
      { rolle: 'paar', art: 'kennzahl', kennzeichen: 'KZ-0001' },
      { rolle: 'paar', art: 'kennzahl', kennzeichen: 'KZ-0002' },
    ]);
    expect(A.berechnungText(e)).toBe('Kennzahlen zusammenfassen · KZ-0001 + KZ-0002 · gewichtet (Summe ÷ Summe)');
  });
});
