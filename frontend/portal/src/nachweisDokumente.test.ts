import { describe, expect, it } from 'vitest';
import type { EnergiemanagementDokument, EnergiemanagementDokumentKurz, EnergiemanagementFassung } from './api';
import { erklaerWoerter, woerter } from './components/nachweisen/erklaerung';
import {
  anlass,
  bekanntmachungen,
  dokumenteBild,
  dokumenteErklaerung,
  fassungErklaerung,
  fassungsZeitleiste,
  grundKurz,
  kurzzeile,
  listenStatus,
  originalBild,
  saetze,
  seitenStatus,
  stufen,
  vorigeFassung,
  wegeText,
  wortlautMitNeuem,
} from './nachweisDokumente';

const IK = { sub: 'ik', name: 'Ines Kaltenbach', rolle: 'energiemanager', art: 'kunde' as const };
const RF = { id: 'rf', name: 'Robert Falk', funktion: 'Geschäftsführer', kuerzel: 'RF', mit_konto: false };
const eingetragen = (am: string, akteur = IK) => ({ akteur, am });

function fassung(nr: number, status: EnergiemanagementFassung['status'], teil: Partial<EnergiemanagementFassung> = {}): EnergiemanagementFassung {
  return {
    nr,
    form: 'wortlaut',
    wortlaut: 'Wir messen den Energieeinsatz.',
    verweis: null,
    anwendungsbereich: null,
    status,
    begruendung: null,
    beschluss_kennung: null,
    pruefsumme: status === 'entwurf' ? null : 'sha256:x',
    vieraugen: false,
    entschieden_von: status === 'entwurf' ? null : RF,
    entschieden_am: status === 'entwurf' ? null : '2026-12-15',
    freigabe_begruendung: null,
    freigabe: status === 'entwurf' ? null : eingetragen('2026-12-15T10:00:00Z'),
    zweite_person: null,
    ablehnung_begruendung: null,
    freigegeben_am: null,
    eingetragen: eingetragen('2026-12-10T09:00:00Z'),
    ...teil,
  };
}

const ueberpruefung = (faellig: string | null, tage: number | null) => ({
  abruf: '2029-04-30',
  faellig_am: faellig,
  basis: null,
  fassung: null,
  tage,
  satz: null,
  grund: faellig ? null : ('nachweis' as const),
});

function kurz(teil: Partial<EnergiemanagementDokumentKurz>): EnergiemanagementDokumentKurz {
  return {
    id: teil.kennzeichen ?? 'D-0001',
    kennzeichen: 'D-0001',
    art: 'energiepolitik',
    art_wort: 'Energiepolitik',
    klasse: 'vorgabe',
    titel: 'Energiepolitik',
    bezug: { art: 'unternehmen', standort: null },
    zustand: 'gueltig',
    gueltige_fassung: 1,
    ueberpruefung: ueberpruefung('2030-03-20', -324),
    eingetragen: eingetragen('2026-12-10T09:00:00Z'),
    ...teil,
  };
}

/** Die Energiepolitik der Referenzwelt am 30.04.2029: Fassung 2 seit 20.03.2029 (Beschluss B3), bekannt gemacht am 25.03. */
function politik(teil: Partial<EnergiemanagementDokument> = {}): EnergiemanagementDokument {
  const f1 = fassung(1, 'abgeloest', { wortlaut: 'Wir messen den Energieeinsatz. Wir setzen uns jährlich Energieziele.' });
  const f2 = fassung(2, 'freigegeben', {
    wortlaut: 'Wir messen den Energieeinsatz. Wir setzen uns jährlich Energieziele. Beim Kauf von Maschinen berücksichtigen wir den Energieeinsatz über die Nutzungsdauer.',
    begruendung: 'Beschluss B3 der Managementbewertung 2028',
    beschluss_kennung: 'BR-2029-0001/B3',
    entschieden_am: '2029-03-20',
    eingetragen: eingetragen('2029-03-10T08:00:00Z'),
  });
  return {
    ...kurz({ gueltige_fassung: 2 }),
    ueberpruefung_monate: 12,
    beleg: { bezeichnung: 'Energiepolitik Fassung 1, unterschrieben', ablage: 'QM-Laufwerk, Ordner Energiemanagement/Politik', kennung: 'EP-2026', adresse: null, sha256: null },
    fassungen: [f1, f2],
    eintraege: [
      { id: 1, art: 'bekannt_gemacht', fassung: 1, am: '2026-12-18', person: null, entschieden_von: null, kreis: 'alle Mitarbeitenden beider Werke', weg: 'aushang', weg_wortlaut: null, begruendung: null, beschluss_kennung: null, kommentar: null, satz: null, eingetragen: eingetragen('2026-12-18T10:00:00Z') },
      { id: 2, art: 'bekannt_gemacht', fassung: 2, am: '2029-03-25', person: null, entschieden_von: null, kreis: 'alle Mitarbeitenden beider Werke', weg: 'aushang', weg_wortlaut: null, begruendung: null, beschluss_kennung: null, kommentar: null, satz: null, eingetragen: eingetragen('2029-03-25T10:00:00Z') },
      { id: 3, art: 'bekannt_gemacht', fassung: 2, am: '2029-03-25', person: null, entschieden_von: null, kreis: 'alle Mitarbeitenden beider Werke', weg: 'intranet', weg_wortlaut: null, begruendung: null, beschluss_kennung: null, kommentar: null, satz: null, eingetragen: eingetragen('2029-03-25T10:00:00Z') },
    ],
    saetze: { kopf: null, ueberpruefung: null, freigabe_gesperrt: null },
    verlauf: [],
    ...teil,
  };
}

describe('Liste der Dokumente (§6.5)', () => {
  const liste = [
    kurz({ id: 'p', kennzeichen: 'D-0001', titel: 'Energiepolitik', gueltige_fassung: 2, ueberpruefung: ueberpruefung('2030-03-20', -324) }),
    kurz({ id: 'a', kennzeichen: 'D-0002', art: 'anwendungsbereich', titel: 'Anwendungsbereich des Energiemanagements', ueberpruefung: ueberpruefung('2030-02-13', -289) }),
    kurz({ id: 'k', kennzeichen: 'D-0004', art: 'betrieb', titel: 'Kriterien Spritzguss', ueberpruefung: ueberpruefung('2029-11-10', -194) }),
    kurz({ id: 'u', kennzeichen: 'D-0005', art: 'kompetenz', klasse: 'nachweis', titel: 'Unterweisung Zeitschaltung', ueberpruefung: ueberpruefung(null, null), bezug: { art: 'person', standort: null, person: { id: 'md', name: 'Murat Demirci', funktion: 'Schichtführer', kuerzel: 'MD', mit_konto: false } } }),
  ];

  it('ordnet Vorgaben nach der nächsten Prüfung und trennt die Nachweise; die Fassung steht erst ab Fassung 2', () => {
    const b = dokumenteBild(liste);
    expect(b.vorgaben.map((z) => z.titel)).toEqual(['Kriterien Spritzguss', 'Anwendungsbereich des Energiemanagements', 'Energiepolitik']);
    expect(b.vorgaben.map((z) => z.unter)).toEqual([null, null, 'Fassung 2']);
    expect(b.vorgaben[0].datum).toEqual({ wort: 'bis', tag: '2029-11-10', ton: 'bald' });
    expect(b.nachweise).toHaveLength(1);
    expect(b.nachweise[0]).toMatchObject({ unter: 'Murat Demirci', datum: null, zeichen: 'nachweis' });
    expect(listenStatus(b)).toEqual({ zeichen: 'festgehalten', text: '4 gelten', sub: null, warn: false });
  });

  it('eine überfällige Prüfung steht mit „seit“ im Warnton, mit dem Verb „Prüfen“ und als Antwort der Status-Zeile', () => {
    const b = dokumenteBild([...liste.slice(0, 2), kurz({ id: 'k', titel: 'Kriterien', ueberpruefung: ueberpruefung('2029-04-10', 20) })]);
    expect(b.vorgaben[0]).toMatchObject({ titel: 'Kriterien', datum: { wort: 'seit', tag: '2029-04-10', ton: 'ueber' }, verb: 'Prüfen' });
    expect(listenStatus(b)).toEqual({ zeichen: 'ueber', text: '1 Prüfung überfällig', sub: '· 3 gelten', warn: true });
  });

  it('ein Entwurf ohne Fassung steht oben mit Zeichen, ein Aufgehobener leise am Ende; gezählt wird nie ein Anteil', () => {
    const b = dokumenteBild([...liste, kurz({ id: 'e', titel: 'Beschaffung', zustand: 'entwurf', gueltige_fassung: null, ueberpruefung: ueberpruefung(null, null) }), kurz({ id: 'x', titel: 'Alt', zustand: 'aufgehoben', ueberpruefung: null })]);
    expect(b.vorgaben[0]).toMatchObject({ titel: 'Beschaffung', unter: 'Entwurf', zeichen: 'entwurf' });
    expect(b.aufgehoben.map((z) => z.titel)).toEqual(['Alt']);
    expect(listenStatus(b)).toEqual({ zeichen: 'entwurf', text: '1 Entwurf wartet', sub: '· 4 gelten', warn: false });
    expect(listenStatus(dokumenteBild([])).text).toBe('Noch kein Dokument festgehalten.');
  });
});

describe('Seite eines Dokuments (§6.5)', () => {
  it('Energiepolitik Fassung 2: „● gilt · Robert Falk“, Stufen mit Tag, Kurzzeile „Fassung 2“', () => {
    const d = politik();
    expect(seitenStatus(d)).toEqual({ zeichen: 'festgehalten', text: 'gilt', sub: '· Robert Falk', warn: false, still: false });
    expect(kurzzeile(d)).toBe('Fassung 2');
    expect(stufen(d)).toEqual([
      { titel: 'Entwurf', datum: '10.03.2029', zustand: 'done' },
      { titel: 'Freigegeben', datum: '20.03.2029', zustand: 'done' },
      { titel: 'Bekannt', datum: '25.03.2029', zustand: 'done' },
      { titel: 'Prüfen', datum: 'bis 20.03.2030', zustand: 'an' },
    ]);
    expect(anlass(d, 'ik')).toBeNull();
  });

  it('ein Verweis: keine Stufe „Entwurf“, ohne Bekanntmachung auch keine Stufe „Bekannt“', () => {
    const d = politik({
      art: 'rechtliche_anforderungen',
      gueltige_fassung: 1,
      ueberpruefung: ueberpruefung('2029-12-05', -219),
      eintraege: [],
      fassungen: [fassung(1, 'freigegeben', { form: 'verweis', wortlaut: null, entschieden_am: '2028-12-05', verweis: { ablage: 'Rechtskataster-Dienst (Abonnement)', kennung: 'RK-AHR', datum: '2028-12-01', bezeichnung: null, adresse: 'https://kataster.example/ahr', fassungsangabe: null, sha256: null } })],
    });
    expect(kurzzeile(d)).toBe('Fassung 1 · Verweis');
    expect(stufen(d).map((s) => s.titel)).toEqual(['Freigegeben', 'Prüfen']);
    expect(originalBild(d, d.fassungen[0])).toMatchObject({ verweis: true, ablage: 'Rechtskataster-Dienst (Abonnement)', kennung: 'RK-AHR', stand: 'Stand 01.12.2028', oeffnen: 'https://kataster.example/ahr' });
  });

  it('ein wartender Entwurf ist der Anlass „Freigeben“; ein Antrag wartet auf eine zweite Person - wer beantragt hat, sieht keinen Knopf', () => {
    const entwurf = politik({ fassungen: [...politik().fassungen, fassung(3, 'entwurf', { begruendung: 'Hinweis aus dem Audit 2029' })] });
    expect(seitenStatus(entwurf)).toMatchObject({ zeichen: 'entwurf', text: 'Fassung 3 wartet auf Freigabe', sub: null });
    expect(anlass(entwurf, 'ik')).toEqual({ art: 'freigeben', fassung: 3 });
    const antrag = politik({ fassungen: [...politik().fassungen, fassung(3, 'beantragt', { vieraugen: true })] });
    expect(seitenStatus(antrag).text).toBe('Fassung 3 wartet auf Bestätigung');
    expect(anlass(antrag, 'ik')).toEqual({ art: 'antrag_wartet', fassung: 3 });
    expect(anlass(antrag, 'jw')).toEqual({ art: 'bestaetigen', fassung: 3 });
    const neu = politik({ zustand: 'entwurf', gueltige_fassung: null, fassungen: [fassung(1, 'beantragt', { vieraugen: true, freigabe: eingetragen('2029-04-29T08:00:00Z') })] });
    expect(stufen(neu)).toEqual([
      { titel: 'Entwurf', datum: '10.12.2026', zustand: 'done' },
      { titel: 'Beantragt', datum: '29.04.2029', zustand: 'an' },
      { titel: 'Bestätigt', datum: 'zweite Person', zustand: 'offen' },
    ]);
  });

  it('eine überfällige Prüfung: Status im Warnton, Anlass „Prüfen“, Stufe „Prüfen seit …“', () => {
    const d = politik({ ueberpruefung: ueberpruefung('2029-03-20', 41) });
    expect(seitenStatus(d)).toMatchObject({ zeichen: 'ueber', text: 'Prüfung seit 20.03.2029', warn: true });
    expect(anlass(d, null)).toEqual({ art: 'pruefen' });
    expect(stufen(d).at(-1)).toEqual({ titel: 'Prüfen', datum: 'seit 20.03.2029', zustand: 'an' });
  });

  it('aufgehoben: grau, ohne Stufen und ohne Anlass; alle Fassungen bleiben lesbar', () => {
    const d = politik({
      zustand: 'aufgehoben',
      ueberpruefung: null,
      eintraege: [{ id: 9, art: 'aufgehoben', fassung: null, am: '2030-05-12', person: null, entschieden_von: RF, kreis: null, weg: null, weg_wortlaut: null, begruendung: 'Ersetzt durch das Handbuch.', beschluss_kennung: null, kommentar: null, satz: null, eingetragen: eingetragen('2030-05-12T10:00:00Z') }],
    });
    expect(seitenStatus(d)).toEqual({ zeichen: 'offen', text: 'aufgehoben seit 12.05.2030', sub: null, warn: false, still: true });
    expect(stufen(d)).toEqual([]);
    expect(anlass(d, 'ik')).toBeNull();
    expect(fassungsZeitleiste(d).map((z) => z.wort)).toEqual(['aufgehoben', 'überholt']);
  });
});

describe('Neu in Fassung n und Grund', () => {
  it('hinterlegt nur die Sätze, die es in der vorigen Fassung nicht gab', () => {
    const d = politik();
    const f2 = d.fassungen[1];
    const r = wortlautMitNeuem(vorigeFassung(d, f2)?.wortlaut ?? null, f2.wortlaut!);
    expect(r.neueSaetze).toEqual(['Beim Kauf von Maschinen berücksichtigen wir den Energieeinsatz über die Nutzungsdauer.']);
    expect(r.absaetze[0].filter((s) => s.neu)).toHaveLength(1);
    expect(r.absaetze[0].map((s) => s.text).join('')).toBe(f2.wortlaut);
  });

  it('ohne vorige Fassung ist nichts „neu“; Absätze bleiben Absätze, Abkürzungen trennen keinen Satz', () => {
    expect(wortlautMitNeuem(null, 'Erster Satz. Zweiter.').neueSaetze).toEqual([]);
    expect(saetze('Wir messen z. B. Strom. Und Gas.\n\nZweiter Absatz.')).toEqual([['Wir messen z. B. Strom.', 'Und Gas.'], ['Zweiter Absatz.']]);
  });

  it('der Grund in höchstens vier Wörtern: Beschluss, sonst der Anfang der Begründung', () => {
    expect(grundKurz({ beschluss_kennung: 'BR-2029-0001/B3', begruendung: 'Beschluss B3 der Managementbewertung 2028' })).toBe('Beschluss 3');
    expect(grundKurz({ beschluss_kennung: null, begruendung: 'Hinweis aus dem Audit 2029 zur Einarbeitung.' })).toBe('Hinweis aus dem Audit …');
    expect(grundKurz({ beschluss_kennung: null, begruendung: 'Ablesung korrigiert.' })).toBe('Ablesung korrigiert');
    expect(grundKurz({ beschluss_kennung: null, begruendung: null })).toBeNull();
  });
});

describe('Original, Bekanntmachung und Zeitleiste', () => {
  it('Entscheid 10: das Original der Fassung, sonst das der früheren - das Original am Dokument gehört zu Fassung 1', () => {
    const d = politik();
    expect(originalBild(d, d.fassungen[1])).toMatchObject({ fassung: 1, ablage: 'QM-Laufwerk, Ordner Energiemanagement/Politik', kennung: 'EP-2026', verweis: false });
    const mitEigenem = politik({ fassungen: [d.fassungen[0], { ...d.fassungen[1], original: { ablage: 'QM-Laufwerk, Politik 2029', bezeichnung: null, kennung: null, adresse: null, sha256: null } }] });
    expect(originalBild(mitEigenem, mitEigenem.fassungen[1])).toMatchObject({ fassung: 2, ablage: 'QM-Laufwerk, Politik 2029' });
    expect(originalBild(politik({ beleg: null }), d.fassungen[1])).toBeNull();
  });

  it('eine Bekanntmachung über zwei Wege ist eine Mitteilung', () => {
    const b = bekanntmachungen(politik().eintraege);
    expect(b[0]).toEqual({ fassung: 2, am: '2029-03-25', kreis: 'alle Mitarbeitenden beider Werke', wege: ['Aushang', 'Intranet'], person: null });
    expect(wegeText(b[0].wege)).toBe('Aushang und Intranet');
    expect(wegeText(['Aushang', 'Intranet', 'E-Mail'])).toBe('Aushang, Intranet und E-Mail');
  });

  it('die Zeitleiste: neueste zuerst, „gilt“ und „überholt“, mit Tag und Person', () => {
    expect(fassungsZeitleiste(politik())).toEqual([
      { nr: 2, wort: 'gilt', ton: 'gilt', datum: '20.03.2029', person: 'Robert Falk', grund: 'Beschluss B3 der Managementbewertung 2028' },
      { nr: 1, wort: 'überholt', ton: 'still', datum: '15.12.2026', person: 'Robert Falk', grund: null },
    ]);
  });
});

describe('Erklär-Blätter (Entscheid 24, Text-Grenze 45 Wörter)', () => {
  it('„Was ist eine Fassung?“ mit dem Beispiel aus dem eigenen Dokument', () => {
    const e = fassungErklaerung(politik());
    expect(e.beiIhnen).toBe('Energiepolitik: Fassung 2 gilt seit 20.03.2029, Fassung 1 ist überholt.');
    expect(erklaerWoerter(e)).toBeLessThanOrEqual(45);
  });

  it('„Vorgabe oder Nachweis?“ nennt je ein Beispiel aus der Liste und bleibt unter der Grenze', () => {
    const e = dokumenteErklaerung([kurz({ titel: 'Energiepolitik' }), kurz({ klasse: 'nachweis', titel: 'Unterweisung Zeitschaltung Werkzeugheizungen' })]);
    expect(e.beiIhnen).toBe('Vorgabe: Energiepolitik. Nachweis: Unterweisung Zeitschaltung Werkzeugheizungen.');
    expect(erklaerWoerter(e)).toBeLessThanOrEqual(45);
    expect(woerter(e.klartext)).toBeLessThanOrEqual(25);
  });
});
