import { describe, expect, it } from 'vitest';
import {
  anlageSteuert,
  ausfallSaetze,
  befundSaetze,
  boxNamen,
  boxZeilen,
  dauerText,
  entwurfAus,
  entwurfLuecken,
  ergebnisHinweise,
  karteSichtbar,
  koerper,
  lage,
  lueckenAusAntwort,
  urteilSatz,
  verlustZeile,
  zustandsZeile,
} from './gemeinsameSteuerungFlaeche';
import { ahrenbergFunktionen } from './test/funktionenFixtures';
import { GS_IDS, gsBoxen, gsEingerichtet, gsVorschlag, gsZustand } from './test/gemeinsameSteuerungFixtures';
import { FIXTURE_IDS } from './test/standorteFixtures';

const JETZT = new Date('2027-06-15T11:40:00Z');

describe('AP-15 IP-23 · Sichtbarkeit der Karte (§5.2: steuert UND mehr als eine Box)', () => {
  const f = ahrenbergFunktionen();
  it('nur messend: nie — auch mit zwei Boxen', () => {
    expect(anlageSteuert(f, FIXTURE_IDS.an2)).toBe(false);
    expect(karteSichtbar({ steuert: anlageSteuert(f, FIXTURE_IDS.an2), boxen: 2, eingerichtet: false })).toBe(false);
  });
  it('steuernd mit einer Box: nicht', () => {
    expect(anlageSteuert(f, FIXTURE_IDS.an1)).toBe(true);
    expect(karteSichtbar({ steuert: true, boxen: 1, eingerichtet: false })).toBe(false);
  });
  it('steuernd mit zwei Boxen: ja', () => {
    expect(karteSichtbar({ steuert: true, boxen: 2, eingerichtet: false })).toBe(true);
  });
  it('unbekannte Funktionen sind nie „steuert“', () => {
    expect(anlageSteuert(null, FIXTURE_IDS.an1)).toBe(false);
  });
  it('eine eingerichtete Gemeinsame Steuerung bleibt erreichbar, auch wenn nur eine Box übrig ist', () => {
    expect(karteSichtbar({ steuert: true, boxen: 1, eingerichtet: true })).toBe(true);
    expect(karteSichtbar({ steuert: false, boxen: 2, eingerichtet: true })).toBe(false);
  });
});

describe('AP-15 IP-23 · Zustände (S1: eingerichtet · wird geprüft · aktiv · angehalten)', () => {
  const namen = boxNamen(gsBoxen(JETZT), gsEingerichtet());
  it('ordnet die Vertragszustände den vier Kundenzuständen zu', () => {
    expect(lage(gsZustand('nicht_eingerichtet'))).toBe('nicht_eingerichtet');
    expect(lage(gsZustand('erklaert'))).toBe('eingerichtet');
    expect(lage(gsZustand('beobachtet'))).toBe('wird_geprueft');
    expect(lage(gsZustand('anteile_aktiv'))).toBe('aktiv');
    expect(lage(gsZustand('angehalten'))).toBe('angehalten');
    expect(lage({ eingerichtet: true, zustand: 'aufgeloest' })).toBe('nicht_eingerichtet');
  });
  it('spricht die Zustandszeile wörtlich aus §5.8', () => {
    const e = gsEingerichtet();
    expect(zustandsZeile(gsZustand('nicht_eingerichtet'), null, namen)).toBeNull();
    expect(zustandsZeile(gsZustand('erklaert'), e, namen)).toBe('Gemeinsame Steuerung eingerichtet');
    expect(zustandsZeile(gsZustand('beobachtet'), e, namen))
      .toBe('Eingerichtet · wird geprüft. VoltPilot prüft die Anlage mit einer kurzen Messung und schaltet sie frei.');
    expect(zustandsZeile(gsZustand('anteile_aktiv'), e, namen))
      .toBe('Gemeinsame Steuerung aktiv · 2 Boxen · Einspeisung höchstens 100 kW · Bezug höchstens 550 kW');
    expect(zustandsZeile(gsZustand('angehalten'), e, namen))
      .toBe('Gemeinsame Steuerung angehalten. Box Halle 1 steuert allein; alle Boxen halten weiter ihren Anteil.');
  });
  it('Box-Zeilen: führend zuerst, mitsteuernd mit Anteil — vor dem Freischalten „vorgesehen“', () => {
    const e = gsEingerichtet();
    expect(boxZeilen(gsZustand('anteile_aktiv'), e, namen, new Map(), 'B').map((z) => z.text)).toEqual([
      'Box Halle 1 führt die Anlage · regelt am Netzanschluss',
      'Box Verwaltung steuert mit · hält ihren Anteil: Einspeisung 60 kW · Bezug 77 kW',
    ]);
    expect(boxZeilen(gsZustand('beobachtet'), e, namen, new Map(), 'B')[1].text)
      .toBe('Box Verwaltung steuert mit, sobald VoltPilot freischaltet · vorgesehener Anteil: Einspeisung 60 kW · Bezug 77 kW');
  });
  it('was fehlt: Update, Signal — die Sprungprobe ist Sache von VoltPilot und steht nicht da', () => {
    expect(befundSaetze(gsZustand('beobachtet'), namen).map((b) => b.text)).toEqual([
      'Box Verwaltung braucht ein Update für die gemeinsame Steuerung.',
      'Die Ladepunkte müssen an der Box hängen, die das Signal des Netzbetreibers bekommt.',
    ]);
    expect(befundSaetze({ ...gsZustand('erklaert'), fehlt: [{ wort: 'kein_netzanschluss' }] }, namen))
      .toEqual([{ text: 'Bitte zuerst den Netzanschluss dieser Anlage eintragen.', weg: 'netzanschluss' }]);
    expect(befundSaetze({ ...gsZustand('erklaert'), fehlt: [{ wort: 'fuehrende_box_misst_nicht', box_id: GS_IDS.e1 }] }, namen)[0].text)
      .toBe('Für die gemeinsame Steuerung muss eine Box den Zähler am Netzanschluss lesen.');
    expect(befundSaetze({ ...gsZustand('anteile_aktiv'), fehlt: [{ wort: 'fuehrende_box_misst_nicht', box_id: GS_IDS.e1 }] }, namen)[0].text)
      .toBe('Box Halle 1 sieht den Netzzähler nicht; sie hält ihren sicheren Anteil.');
  });
});

describe('AP-15 IP-23 · Ausfall-Sätze (A1, A2, A4) nur mit Anteilen in Kraft', () => {
  const namen = boxNamen(gsBoxen(JETZT), null);
  it('A1: die mitsteuernde Box antwortet seit ihrem letzten Herzschlag nicht (Zone der Anlage)', () => {
    const boxen = gsBoxen(JETZT, { verwaltungSeit: 30 * 60 });
    expect(ausfallSaetze(gsZustand('anteile_aktiv'), boxen, namen, JETZT).get(GS_IDS.e4))
      .toBe('Box Verwaltung antwortet seit 13:10 nicht. Die Grenze am Netzanschluss bleibt eingehalten; ihre Geräte laufen mit ihren sicheren Vorgabewerten.');
  });
  it('A2: die führende Box antwortet nicht', () => {
    const boxen = gsBoxen(JETZT, { halle1Seit: 30 * 60 });
    expect(ausfallSaetze(gsZustand('angehalten'), boxen, namen, JETZT).get(GS_IDS.e1))
      .toBe('Box Halle 1 antwortet nicht. Niemand regelt gerade am Netzanschluss; jede Box und jedes Gerät hält seinen sicheren Anteil.');
  });
  it('A4: beide Boxen nicht verbunden', () => {
    const boxen = gsBoxen(JETZT, { halle1Seit: 3600, verwaltungSeit: 3600 });
    expect([...ausfallSaetze(gsZustand('anteile_aktiv'), boxen, namen, JETZT).values()])
      .toEqual(Array(2).fill('Beide Boxen sind nicht verbunden. Die Grenze am Netzanschluss halten sie selbst ein.'));
  });
  it('vor dem Freischalten hält keine Box einen Anteil: kein Satz; eine Box ohne Herzschlag ist unbekannt', () => {
    const boxen = gsBoxen(JETZT, { verwaltungSeit: 3600 });
    expect(ausfallSaetze(gsZustand('beobachtet'), boxen, namen, JETZT).size).toBe(0);
    const ohne = [boxen[0], { ...boxen[1], lastSeenAt: null }];
    expect(ausfallSaetze(gsZustand('anteile_aktiv'), ohne, namen, JETZT).size).toBe(0);
  });
});

describe('AP-15 IP-23 · Verlust-Zeile (R2): kWh ist eine Untergrenze, die gebundene Zeit exakt', () => {
  const r2 = { kwh: 0, gebunden_s: 32760, tage: 1 };
  it('kWh 0 (der Referenzfall im Feld): beide Varianten nennen die Stunden', () => {
    expect(verlustZeile(r2, 'A')).toBe('Heute 9,1 Stunden begrenzt, weil diese Box den Netzanschluss nicht sieht.');
    expect(verlustZeile(r2, 'B')).toBe('Heute 9,1 Stunden begrenzt, weil diese Box den Netzanschluss nicht sieht.');
  });
  it('kWh > 0: nie ohne „mindestens“ — A nur kWh, B die Zeit und kWh als Zusatz; abgerundet', () => {
    const v = { kwh: 160.8, gebunden_s: 32760, tage: 1 };
    expect(verlustZeile(v, 'A')).toBe('Heute mindestens 160 kWh nicht erzeugt, weil diese Box den Netzanschluss nicht sieht.');
    expect(verlustZeile(v, 'B'))
      .toBe('Heute 9,1 Stunden begrenzt, weil diese Box den Netzanschluss nicht sieht — mindestens 160 kWh nicht erzeugt.');
  });
  it('nichts gebunden, nichts gemeldet: keine Zeile', () => {
    expect(verlustZeile(null, 'B')).toBeNull();
    expect(verlustZeile({ kwh: 0.4, gebunden_s: 0, tage: 1 }, 'A')).toBeNull();
  });
  it('Dauer in Minuten unter einer Stunde, eine Stunde im Singular', () => {
    expect(dauerText(40 * 60)).toBe('40 Minuten');
    expect(dauerText(3600)).toBe('1 Stunde');
  });
  it('steht nur an der mitsteuernden Box und nur mit Anteilen in Kraft', () => {
    const namen = boxNamen(gsBoxen(JETZT), null);
    const zeilen = boxZeilen(gsZustand('anteile_aktiv', r2), gsEingerichtet(), namen, new Map(), 'B');
    expect(zeilen.map((z) => z.verlust)).toEqual([null, 'Heute 9,1 Stunden begrenzt, weil diese Box den Netzanschluss nicht sieht.']);
    expect(boxZeilen(gsZustand('beobachtet', r2), gsEingerichtet(), namen, new Map(), 'B').every((z) => z.verlust === null)).toBe(true);
  });
});

describe('AP-15 IP-23 · Einrichten in sechs Fragen', () => {
  it('belegt vor: beide Boxen, Halle 1 am Netzanschluss, jede Komponente mit Schreibfreigabe, 473 kW aus Messwerten', () => {
    const e = entwurfAus(gsVorschlag(), gsZustand('nicht_eingerichtet'));
    expect(e.boxen.map((b) => b.mit)).toEqual([true, true]);
    expect(e.fuehrt).toBe(GS_IDS.e1);
    expect(e.boxen[0].geraete.map((g) => [g.name, g.richtung, g.nenn])).toEqual([
      ['Hybrid-Wechselrichter 100 kW', 'einspeisung', '100'],
      ['Batteriespeicher 200 kWh', 'bezug', ''],
    ]);
    expect(e.boxen[1].geraete).toHaveLength(7);
    expect(e.vorbehaltBezug).toBe('473');
    expect(e.erzeugerArt).toBeNull();
  });
  it('zeigt jede Lücke an ihrer Stelle: Netzzähler-Quelle, Erzeuger (Pflicht), Nennleistung des Speichers', () => {
    const e = entwurfAus(gsVorschlag(), gsZustand('nicht_eingerichtet'));
    expect(entwurfLuecken(e).map((l) => [l.frage, l.komponenteId ?? l.boxId ?? null])).toEqual([
      [2, GS_IDS.e1],
      [4, null],
      [5, GS_IDS.k2],
    ]);
  });
  it('baut den Körper des PUT mit Rollen, Messpunkten, Signal und allen Geräten', () => {
    const e = entwurfAus(gsVorschlag(), gsZustand('nicht_eingerichtet'));
    e.boxen[0].messpunkt = GS_IDS.dq2;
    e.boxen[0].signal = 'ja';
    e.boxen[0].geraete[1].nenn = '100';
    e.boxen[1].messpunkt = GS_IDS.dq10;
    e.boxen[1].signal = 'nein';
    e.erzeugerArt = 'keine';
    expect(entwurfLuecken(e)).toEqual([]);
    const k = koerper(e);
    expect(k.mitglieder.map((m) => [m.rolle, m.messpunkt_id, m.vorgabe_signal, m.geraete.length])).toEqual([
      ['fuehrt', GS_IDS.dq2, 'ja', 2],
      ['steuert_mit', GS_IDS.dq10, 'nein', 7],
    ]);
    expect(k.ungesteuerte_erzeuger).toBe('keine');
    expect(k.vorbehalt).toEqual({ bezug_kw: 473 });
  });
  it('übersetzt die 422-Lücken an ihre Stelle (Frage 4 und 5)', () => {
    expect(lueckenAusAntwort({ code: 'erklaerung_unvollstaendig', fehlt: [
      { wort: 'komponente', box_id: GS_IDS.e4, komponente_id: GS_IDS.k12 },
      { wort: 'ungesteuerte_erzeuger' },
    ] }).map((l) => [l.frage, l.komponenteId ?? null])).toEqual([[5, GS_IDS.k12], [4, null]]);
    expect(lueckenAusAntwort({ code: 'erst_anhalten' })).toEqual([]);
  });
  it('Frage 6: 40/60 und 0/77, beide passen — und die vier Sätze aus §5.2 Nr. 6', () => {
    const e = gsEingerichtet();
    expect(urteilSatz(e.ergebnis?.einspeisung)).toBe('Ja — die Anlage passt zur Grenze am Netzanschluss.');
    expect(urteilSatz(e.ergebnis?.bezug)).toBe('Ja — die Anlage passt zur Grenze am Netzanschluss.');
    expect(urteilSatz(null)).toBe('Noch nicht zu rechnen — dafür fehlen Angaben aus den Fragen davor.');
    expect(urteilSatz({ ...e.ergebnis!.einspeisung!, urteil: 'auslegung_passt_nicht', summe_rueckfall_kw: 100, verteilbar_kw: 70 }))
      .toBe('Nein — ohne ihre Boxen kämen die Geräte auf 100 kW, die Grenze lässt 70 kW zu.');
    const namen = boxNamen(gsBoxen(JETZT), e);
    const h = ergebnisHinweise(e, gsZustand('beobachtet'), namen);
    expect(h.map((x) => x.text)).toEqual([
      'Box Verwaltung braucht ein Update für die gemeinsame Steuerung.',
      'Am Gerät PV-Wechselrichter Verwaltung 60 kW ist kein sicherer Rückfallwert hinterlegt — es zählt mit seiner vollen Leistung.',
      'Der Ladepark hängt an einer Box, die den Netzanschluss nicht sieht: er bekommt fest 77 kW. An Box Halle 1 bekäme er, was am Anschluss frei ist.',
      'Die Ladepunkte müssen an der Box hängen, die das Signal des Netzbetreibers bekommt.',
    ]);
    expect(h[1].rueckfall).toEqual({ komponenteId: GS_IDS.k12, richtung: 'einspeisung' });
  });
});
