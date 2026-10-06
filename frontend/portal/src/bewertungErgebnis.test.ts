import { describe, expect, it } from 'vitest';
import type { BewertungRangliste, EnergieeinsatzEinstufungFassung, Messbedarf } from './api';
import {
  bewertungBeispiel,
  bewertungErgebnis,
  entwurfBild,
  gruendeText,
  kriterienAenderungen,
  kriterienAntrag,
  kriterienFeldLabel,
  kriterienMeldung,
  kriterienSaetze,
  kriterienStartwert,
  standBild,
  statusZeile,
  umfangZeilen,
  vorschlagSatz,
  zeitraumText,
  type ErgebnisEingabe,
} from './bewertungErgebnis';
import { ahrenbergEinsaetze, ahrenbergRangliste, ahrenbergUmfang, ahrenbergUmfangVorgabe, bewertungBuehne } from './test/bewertungFixtures';
import { bewertungStandBuehne } from './test/bewertungStandBuehne';

/** Geschütztes Leerzeichen (U+00A0) zwischen Zahl und Einheit. */
const NB = String.fromCharCode(160);
/** Kein Kürzel der Kriterien auf der Seite (Konzept Auswerten a1 §10.10). */
const KUERZEL = /(^|[^\p{L}\p{N}])K[1-8]([^\p{L}\p{N}]|$)/u;

async function eingabe(ueberschreiben: Partial<ErgebnisEingabe> = {}): Promise<ErgebnisEingabe> {
  const b = bewertungBuehne('voll');
  const einsaetze = (await b.energieeinsaetze()).energieeinsaetze;
  const einstufungen: Record<string, EnergieeinsatzEinstufungFassung[]> = {};
  for (const e of einsaetze) einstufungen[e.id] = (await b.energieeinsatzEinstufungen(e.id)).fassungen;
  return {
    einsaetze,
    rangliste: await b.bewertungRangliste(),
    einstufungen,
    umfang: ahrenbergUmfang('2026-11-20'),
    zeitraum: 'November 2025 bis Oktober 2026',
    messbedarfe: [],
    ...ueberschreiben,
  };
}

/** Die Rangliste der laufenden Demo für die Datengrundlage April 2028 bis März 2029: keine Werte (zwei Uhren). */
function ohneWerte(): BewertungRangliste {
  const r = ahrenbergRangliste();
  const leer = (e: BewertungRangliste['einsaetze'][number]) => ({
    ...e, menge: null, anteil_prozent: null, rang: null, vorschlag: 'unter_schwelle' as const, zustand: 'keine Werte',
    urteil: { K1: 'nicht_anwendbar' as const, K2: 'nicht_anwendbar' as const, K3: 'nicht_anwendbar' as const, K5: 'vorbehalt_datenlage' as const, K6: 'vorbehalt_ersatzwerte' as const },
  });
  return {
    ...r, monate: 12, urteil: { K7: 'erfuellt', K8: 'nicht_anwendbar' },
    nenner: { wert: null, einheit: 'kWh', vorhanden: 0, gesamt: 3, anlagen: '0 von 3', zustand: 'unvollständig' },
    zugeordnet: '0', rest: null, abdeckung_prozent: null,
    anlagen: r.anlagen.map((a) => ({ ...a, nenner: null, rest: null, rest_anteil_prozent: null })),
    einsaetze: r.einsaetze.map(leer), weitere_traeger: r.weitere_traeger.map(leer),
  };
}

const texte = (x: unknown): string[] =>
  typeof x === 'string' ? [x] : Array.isArray(x) ? x.flatMap(texte) : x && typeof x === 'object' ? Object.values(x).flatMap(texte) : [];

describe('die Bewertung als Ergebnis (Konzept Auswerten a1 §6.7)', () => {
  it('beantwortet „Was ist wesentlich?“ in einem Satz: 2 von 7 Bereichen, zusammen 50 % des Stroms', async () => {
    const e = bewertungErgebnis(await eingabe());
    expect(e.antwort).toBe('2 von 7 Bereichen sind wesentlich - zusammen 50 % des Stroms.'.replace(' %', `${NB}%`));
    // EE-3 Druckluft: Vorschlag nicht wesentlich (8,6 %), eingestuft als wesentlich - begründet, ohne Alarm.
    expect(e.zusatz).toBe('Eine Einstufung weicht begründet vom Vorschlag ab.');
    expect(e.formal).toBe('Datengrundlage November 2025 bis Oktober 2026 · Strom aus 3 Anlagen · Gas ohne Anteil');
    expect(e.vertrauen).toBe('Vorläufig: die Datengrundlage umfasst 1 Monat; belastbar ist der Vorschlag ab 12 Monaten.');
  });

  it('gruppiert nach der Einstufung einer Person: wesentlich, nicht wesentlich - Strom nach Menge, Träger ohne Anteil danach', async () => {
    const e = bewertungErgebnis(await eingabe());
    expect(e.gruppen.map((g) => [g.titel, g.reihen.map((r) => r.kennzeichen)])).toEqual([
      ['Wesentliche Bereiche', ['EE-1', 'EE-3']],
      ['Nicht wesentlich', ['EE-2', 'EE-6', 'EE-5', 'EE-4', 'EE-7']],
    ]);
    const [ee1, ee3] = e.gruppen[0].reihen;
    expect(ee1).toMatchObject({ wert: `41,8${NB}%`, menge: `77.500${NB}kWh`, balken: 100, abweichung: false });
    expect(ee1.teile).toEqual([
      { text: 'verantwortlich Murat Demirci' },
      { text: 'Einstufung Fassung 1 seit 06.11.2026', breit: true },
    ]);
    expect(ee3).toMatchObject({ wert: `8,6${NB}%`, balken: 20.5, abweichung: true });
    expect(ee3.teile.map((t) => t.text)).toEqual([
      'Vorschlag „nicht wesentlich“ · eingestuft als wesentlich am 06.11.2026: „8,6 % — unter der Schwelle; Querschnitt für Spritzguss und Montage, Leckageverluste vermutet.“',
    ]);
    // Gas mit Menge, aber ohne Anteil: die Menge steht rechts, kein Balken.
    const ee7 = e.gruppen[1].reihen.at(-1)!;
    expect(ee7).toMatchObject({ wert: `1.240,0${NB}m³`, menge: null, balken: null });
    expect(ee7.teile.map((t) => t.text)).toContain('ohne Anteil - Gas hat keinen gemeinsamen Maßstab mit Strom');
  });

  it('ein Bereich ohne Zähler steht unter „Noch ohne Werte“ mit Grund, nie mit 0', async () => {
    const e = bewertungErgebnis(await eingabe({ rangliste: ohneWerte() }));
    const ohne = e.gruppen.find((g) => g.key === 'ohne_werte')!;
    expect(ohne.titel).toBe('Noch ohne Werte');
    expect(ohne.reihen.map((r) => [r.kennzeichen, r.wert, r.balken])).toEqual([['EE-7', '–', null]]);
    expect(ohne.reihen[0].teile.map((t) => t.text)).toEqual([
      'nicht wesentlich',
      'Gas zählt im Umfang ohne Anteil am Strom; Gaszähler lassen sich noch nicht anlegen',
    ]);
  });

  it('Kacheln: wesentlich 2 von 7, Anteil 50 %, keinem Bereich zugeordnet 32 % (zu wenig, ab 80 % belastbar), offene Messbedarfe', async () => {
    const mb = { id: 'm', kennzeichen: 'MB-1', energieeinsatz_id: ahrenbergEinsaetze()[0].id, wortlaut: 'Lüftung, Beleuchtung und Allgemeinstrom Halle 1', zustand: 'offen' } as Messbedarf;
    const e = bewertungErgebnis(await eingabe({ messbedarfe: [mb] }));
    expect(e.kacheln.wesentlich).toMatchObject({ wert: '2', einheit: 'von 7', sub: `50${NB}% des Stroms`, subBreit: 'Spritzguss, Druckluft' });
    expect(e.kacheln.anteil).toMatchObject({ wert: '50', einheit: '%', sub: `93.400${NB}kWh in 1 Monat` });
    expect(e.kacheln.rest).toMatchObject({ wert: '32', einheit: '%', marke: { text: 'zu wenig', ton: 'warn' }, sub: `ab 80${NB}% zugeordnet ist die Rangfolge belastbar` });
    expect(e.kacheln.bedarfe).toMatchObject({ wert: '1', sub: 'Lüftung, Beleuchtung und Allgemeinstrom Halle 1' });
    expect(e.gruppen[0].reihen[0].teile.at(-1)).toEqual({ text: 'Messbedarf offen' });
  });

  it('die laufende Demo (Datengrundlage ohne Werte): Einstufungen bleiben, Anteile fehlen mit Grund, kein Vorschlag, keine Abweichung', async () => {
    const e = bewertungErgebnis(await eingabe({ rangliste: ohneWerte(), zeitraum: 'April 2028 bis März 2029' }));
    expect(e.antwort).toBe('2 von 7 Bereichen sind wesentlich.');
    expect(e.zusatz).toBeNull();
    expect(e.vertrauen).toBe('Für April 2028 bis März 2029 liegen noch keine Messwerte vor - darum fehlen Anteile und Mengen. Die Einstufungen gelten, wie sie festgelegt sind.');
    expect(e.formal).toBe('Datengrundlage April 2028 bis März 2029 · Gas ohne Anteil');
    expect(e.gruppen.flatMap((g) => g.reihen).filter((r) => r.abweichung)).toEqual([]);
    expect(e.gruppen[0].reihen.map((r) => [r.wert, r.balken])).toEqual([['–', null], ['–', null]]);
    expect(e.kacheln.rest).toMatchObject({ wert: null, marke: null, sub: 'Ohne vollständige Werte des Hauptzählers kein Anteil.' });
    expect(e.kacheln.anteil).toMatchObject({ wert: null, sub: 'noch ohne Messwerte' });
  });

  it('noch nichts eingestuft: VoltPilot schlägt vor, eine Person entscheidet', async () => {
    const e = bewertungErgebnis(await eingabe({ einstufungen: {} }));
    expect(e.antwort).toBe('Noch ist keiner der 7 Bereiche eingestuft.');
    expect(e.zusatz).toBe('VoltPilot schlägt 1 davon als wesentlich vor.');
    expect(e.gruppen.map((g) => g.key)).toEqual(['offen']);
    expect(e.gruppen[0].reihen[0].teile[0].text).toBe(`Vorschlag „wesentlich“ (41,8${NB}% des Stroms, ab 10${NB}%)`);
  });

  it('ohne laufenden Bereich ist die Seite leer - erst der Satz, dann der Knopf', async () => {
    expect(bewertungErgebnis(await eingabe({ einsaetze: [] })).leer).toBe(true);
  });

  it('nennt nie ein Kürzel K1 bis K8, nie „Roh“, nie „Urteil (Band)“', async () => {
    for (const x of [await eingabe(), await eingabe({ rangliste: ohneWerte() }), await eingabe({ einstufungen: {} })]) {
      for (const t of texte(bewertungErgebnis(x))) {
        expect(t, t).not.toMatch(KUERZEL);
        expect(t, t).not.toMatch(/\bRoh\b|Urteil \(Band\)/);
      }
    }
    for (const t of [...kriterienSaetze(await bewertungBuehne('voll').bewertungKriterien()).saetze, vorschlagSatz(ahrenbergRangliste().einsaetze[0])])
      expect(t).not.toMatch(KUERZEL);
  });
});

describe('Statuszeile: gilt die Bewertung?', () => {
  it('gilt: „Gilt · Stand Nr. 2 vom 17.11.2026“ und „nächste Überprüfung bis 17.11.2027“', async () => {
    const s = statusZeile((await bewertungStandBuehne('nr2').berichte()).berichte);
    expect(s).toEqual({ ton: 'ok', satz: `Gilt · Stand Nr.${NB}2 vom 17.11.2026`, sub: 'nächste Überprüfung bis 17.11.2027', faellig: false, hinweis: null });
  });

  it('fällig: die Zeile wird Hinweiskarte mit Datum statt Tageszähler und den Verantwortlichen', async () => {
    const s = statusZeile((await bewertungStandBuehne('faellig').berichte()).berichte);
    expect(s).toMatchObject({ ton: 'warn', faellig: true, satz: 'Überprüfung fällig seit 17.11.2027' });
    expect(s.sub).toBe(`Stand Nr.${NB}2 vom 17.11.2026 - prüfen Sie den Entwurf und geben Sie einen neuen Stand frei.`);
    expect(s.hinweis).toContain('Markus Dorn (EE-1)');
  });

  it('ohne Stand oder ohne Bewertung sagt sie, warum nichts gilt', async () => {
    expect(statusZeile((await bewertungStandBuehne('entwurf').berichte()).berichte)).toMatchObject({ ton: 'off', satz: 'Noch kein Stand freigegeben' });
    expect(statusZeile([])).toMatchObject({ ton: 'off', satz: 'Noch keine Bewertung festgestellt' });
  });

  it('das Beispiel im Aufklapper stammt aus dem gültigen Stand', async () => {
    expect(bewertungBeispiel((await bewertungStandBuehne('nr2').berichte()).berichte)).toBe(
      `Bei Ihnen: Bewertung 2026, Stand Nr.${NB}2 vom 17.11.2026 - 6 Bereiche wesentlich.`,
    );
    expect(bewertungBeispiel([])).toBeNull();
  });
});

describe('Bewertungsstand als Datumsblöcke', () => {
  it('der gültige Stand und der Entwurf (§6.7)', async () => {
    const s = bewertungStandBuehne('nr2');
    const d = await s.bericht('BR-2026-0009');
    const g = d.staende.find((x) => x.ersetzt_durch_nr === null)!;
    expect(standBild(d, g)).toMatchObject({
      wort: 'Stand 2', tag: '17.11.', jahr: '2026', satz: 'Stand Nr. 2 vom 17.11.2026', titel: 'gilt · freigegeben von Ines Kaltenbach',
    });
    expect(standBild(d, g).anlass).toMatch(/^Anlass: /);
    const e = entwurfBild(d.bericht, await s.berichtEntwurf('BR-2026-0009'), true);
    expect(e).toMatchObject({ tag: '17.11.', jahr: '2026', titel: 'Neuer Stand mit den Zahlen bis Oktober 2026' });
    expect(e.warum).toBe('Freigeben, wenn sich etwas geändert hat - die Unterschiede zeigt der Entwurf.');
    expect(entwurfBild(d.bericht, { datenstand: '2026-11-09T10:05:00+01:00' }, false).titel).toBe('Erster Stand mit den Zahlen bis Oktober 2026');
  });
});

describe('Kriterien in Worten (§10.10) und mit Vier-Augen (Befund 6)', () => {
  it('die Sätze der Karte nennen die Schwellen der wirksamen Fassung', async () => {
    const k = kriterienSaetze(await bewertungBuehne('voll').bewertungKriterien());
    expect(k.saetze).toEqual([
      `Er braucht mindestens 10${NB}% des Stroms.`,
      `Er gehört zu den größten Bereichen, die zusammen 80${NB}% ausmachen.`,
      `Er braucht mindestens 100.000${NB}kWh im Jahr.`,
      'Eine Person schätzt ihn begründet als wesentlich ein.',
    ]);
    expect(k.fussnote).toBe(`Belastbar ist der Vorschlag mit mindestens 12 vollen Monaten, 90${NB}% Daten und höchstens 5${NB}% Ersatzwerten. Es gelten die Startwerte von VoltPilot.`);
  });

  it('der Dialog zeigt Wort und Kürzel, der Startwert steht in Worten', () => {
    expect(kriterienFeldLabel('K1')).toBe('Anteil am Strom, ab dem VoltPilot vorschlägt (K1)');
    expect(kriterienFeldLabel('mindest_monate')).toBe('Vorläufig unter so vielen Monaten (K7)');
    expect(kriterienStartwert('K3')).toBe(`Startwert von VoltPilot: 100.000${NB}kWh`);
  });

  it('die Meldung nach dem Speichern folgt dem Status: gilt sofort, wartet auf eine zweite Person, abgelehnt', () => {
    expect(kriterienMeldung({ fassung: 2, freigabe_status: 'freigegeben' }, 'Bewertungsstand Nr. 2 bekommt einen Anstoß.')).toBe(
      'Die neuen Kriterien gelten ab sofort für den Vorschlag (Fassung 2). Keine Einstufung ändert sich dadurch. Bewertungsstand Nr. 2 bekommt einen Anstoß.',
    );
    expect(kriterienMeldung({ fassung: 3, freigabe_status: 'beantragt' }, 'x')).toBe(
      'Die neuen Kriterien (Fassung 3) warten auf die Freigabe durch eine zweite Person. Bis dahin gelten die bisherigen.',
    );
    expect(kriterienMeldung({ fassung: 3, freigabe_status: 'abgelehnt' }, null)).toBe('Die beantragten Kriterien (Fassung 3) sind abgelehnt. Es gelten weiter die bisherigen.');
  });

  it('der Antrag nennt Änderung, Person und wer entscheiden darf', async () => {
    const b = bewertungBuehne('voll', 'IK', '2026-11-20', false, false, false, { antragVon: 'JW' });
    const [antrag, wirksam] = (await b.bewertungKriterienHistorie()).fassungen;
    expect(kriterienAenderungen(wirksam.werte, antrag.werte)).toEqual([`Anteil am Strom, ab dem VoltPilot vorschlägt: 10${NB}% → 8${NB}%`]);
    const ik = kriterienAntrag(antrag, { sub: 'ik', darf: true });
    expect(ik.satz).toBe('Beantragt von Jonas Wendlinger am 20.11.2026: „Druckluft und Montage früher sehen: ab acht Prozent vorschlagen.“');
    expect(ik).toMatchObject({ darfEntscheiden: true, wer: null });
    expect(kriterienAntrag(antrag, { sub: antrag.akteur!.sub, darf: true })).toMatchObject({ darfEntscheiden: false, wer: 'Freigeben oder ablehnen kann eine zweite Person, die Kriterien ändern darf.' });
    expect(kriterienAntrag(antrag, { sub: 'ph', darf: false }).darfEntscheiden).toBe(false);
  });

  it('die Bühne spielt den Dienst: beantragt sperrt weitere Änderungen; freigeben nur durch eine zweite Person; ablehnen nur begründet', async () => {
    const b = bewertungBuehne('voll', 'IK', '2026-11-20', false, false, false, { vieraugen: true });
    const k = await b.bewertungKriterien();
    const f = await b.bewertungKriterienSpeichern({ werte: { ...k.werte, K1: '5' }, begruendung: 'Früher prüfen.' });
    expect(f).toMatchObject({ fassung: 2, freigabe_status: 'beantragt' });
    await expect(b.bewertungKriterienSpeichern({ werte: k.werte, begruendung: 'Noch einmal.' })).rejects.toMatchObject({ status: 409 });
    await expect(b.bewertungKriterienFreigeben(2)).rejects.toMatchObject({ status: 403 });
    expect((await b.bewertungKriterien()).fassung).toBe(1);
    const jw = bewertungBuehne('voll', 'JW', '2026-11-20', false, false, false, { antragVon: 'IK' });
    await expect(jw.bewertungKriterienAblehnen(2, ' ')).rejects.toMatchObject({ status: 422 });
    expect(await jw.bewertungKriterienFreigeben(2)).toMatchObject({ freigabe_status: 'freigegeben', gueltig_ab: '2026-11-20' });
    expect((await jw.bewertungKriterien()).fassung).toBe(2);
  });
});

describe('Umfang in drei Zeilen und Wörter der Dialoge', () => {
  it('Fassung 1: beide Werke, Strom mit Anteil, Gas daneben, seit 04.11.2026 von Ines Kaltenbach', () => {
    expect(umfangZeilen(ahrenbergUmfang('2026-11-20'))).toEqual({
      gespeichert: true,
      standorte: 'Werk Ahrenberg (2 Anlagen) · Werk Lindach (1 Anlage)',
      traeger: 'Strom mit Anteil · Gas ohne Anteil',
      traegerNotiz: 'Gas hat keinen gemeinsamen Maßstab mit Strom und steht daneben.',
      ausschluesse: [],
      gilt: 'seit 04.11.2026 · festgelegt von Ines Kaltenbach',
    });
  });

  it('ohne Fassung: der Vorschlag, kein erfundenes Datum', () => {
    expect(umfangZeilen(ahrenbergUmfangVorgabe('2026-11-04'))).toMatchObject({
      gespeichert: false, traeger: 'Strom mit Anteil', traegerNotiz: null, gilt: 'noch nicht festgelegt - Vorschlag: alle Standorte, Strom',
    });
  });

  it('Gründe, Zeiträume und der Vorschlag des Einstufen-Dialogs in Worten', () => {
    expect(gruendeText(['K1', 'K4'])).toBe('Anteil am Strom über der Schwelle und begründete Einschätzung einer Person');
    expect(zeitraumText('2026-10')).toBe('Oktober 2026');
    expect(zeitraumText('2027-11/2028-10')).toBe('November 2027 bis Oktober 2028');
    expect(zeitraumText(undefined)).toBeNull();
    const [ee1, ee3] = ahrenbergRangliste().einsaetze;
    expect(vorschlagSatz(ee1)).toBe(`VoltPilot schlägt „wesentlich“ vor: 41,8${NB}% des Stroms.`);
    expect(vorschlagSatz(ee3)).toBe('VoltPilot schlägt „nicht wesentlich“ vor - kein Kriterium trifft zu.');
    expect(vorschlagSatz({ ...ee1, menge: null })).toBe('Noch kein Vorschlag - für den Zeitraum fehlen Messwerte. Sie können trotzdem begründet einstufen.');
  });
});
