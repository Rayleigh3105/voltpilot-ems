import { describe, expect, it } from 'vitest';
import { GERAETESUCHE_GRUPPEN, type GeraetesucheFund } from './geraetesuche';
import {
  GRUPPEN_TITEL,
  bauart,
  dauerText,
  endHinweis,
  ergebnisTitel,
  erkennungWort,
  fortschritt,
  fundAktion,
  fundAdresse,
  fundHinweis,
  fundTitel,
  fundZeile,
  istUebernommen,
  klopftAnZeile,
  knopfLage,
  laeuftNoch,
  letzteSucheSatz,
  merkmalText,
  nichtGesucht,
  nichtsGefunden,
  nichtsGefundenFragen,
  offeneAusgaenge,
  restText,
  startFehlerSatz,
  uebernahmeSchluessel,
  uebernahmeWeg,
  verlaufErgebnis,
  verlaufZeile,
  vorbelegung,
  wann,
  weitere,
  weitereTitel,
  wer,
} from './geraetesucheAnsicht';
import {
  GS_DEYE_HV,
  GS_GOE,
  GS_SHELLY,
  GS_TEMPLATES,
  geraetesucheFaelle,
  gsDeye,
  gsGoe,
  gsShelly,
  gsVerlauf,
} from './test/geraetesucheFixtures';

// 2. November 2026, 10:12 Uhr in Berlin.
const JETZT = Date.parse('2026-11-02T09:12:40Z');
const F = geraetesucheFaelle(JETZT);
const fund = (over: Partial<GeraetesucheFund>): GeraetesucheFund => ({ ...gsGoe, ...over });

describe('Gerätesuche · Gruppen und Zustände', () => {
  it('jede Gruppe der Antwort hat eine Überschrift, in der festen Reihenfolge von Bericht §4', () => {
    expect(Object.keys(GRUPPEN_TITEL)).toEqual([...GERAETESUCHE_GRUPPEN]);
    expect(GRUPPEN_TITEL.nicht_anbindbar).toBe('Erkannt, mit dieser Box noch nicht anbindbar');
  });

  it('fragt nur ab, solange die Box noch nicht fertig gemeldet hat', () => {
    expect(laeuftNoch('wartet')).toBe(true);
    expect(laeuftNoch('laeuft')).toBe(true);
    for (const z of ['fertig', 'abgebrochen', 'fehlgeschlagen', 'abgelehnt', 'keine_antwort'] as const) {
      expect(laeuftNoch(z), z).toBe(false);
    }
  });

  it('Erkennung steht immer als Wort neben dem Ton', () => {
    expect(erkennungWort('sicher')).toEqual({ wort: 'sicher erkannt', ton: 'ok' });
    expect(erkennungWort('wahrscheinlich')).toEqual({ wort: 'wahrscheinlich', ton: 'warn' });
    expect(erkennungWort('unbekannt')).toEqual({ wort: 'nur erreichbar', ton: 'off' });
  });
});

describe('Gerätesuche · Fortschritt', () => {
  it('drei Schritte im Klartext, Restzeit als Text, Anteil über alle Schritte', () => {
    const f = fortschritt(F.laeuft);
    expect(f.schritt).toBe(1);
    expect(f.schritte.map((s) => s.zustand)).toEqual(['fertig', 'aktiv', 'offen']);
    expect(f.schritte[0].zeile).toBe('Heimnetz 192.168.178.0/24 · Netz der Box 192.168.2.0/24');
    expect(f.schritte[1].zeile).toBe('3 von 4 Adressen geprüft');
    expect(f.rest).toBe('Noch etwa 15 Sekunden');
    expect(f.schrittSatz).toBe('Schritt 2 von 3 · Geräte ansprechen');
    expect(f.anteil).toBeCloseTo((1 + 0.75) / 3);
  });

  it('solange die Box nichts gemeldet hat, ist der Anteil unbekannt - nie 0 %', () => {
    const f = fortschritt(F.wartet);
    expect(f.anteil).toBeNull();
    expect(f.rest).toBe('Ihre Box beginnt gleich');
    expect(f.schritte.map((s) => s.zustand)).toEqual(['aktiv', 'offen', 'offen']);
  });

  it('„nachbarn_finden" gehört zu „Heimnetz ansehen"', () => {
    expect(fortschritt(F.fremd).schrittSatz).toBe('Schritt 1 von 3 · Heimnetz ansehen');
  });

  it('die Restzeit rundet und sagt ohne Schätzung kein Zahlwort', () => {
    expect(restText(null)).toBe('Restzeit wird noch geschätzt');
    expect(restText(3)).toBe('Gleich fertig');
    expect(restText(17)).toBe('Noch etwa 15 Sekunden');
    expect(restText(150)).toBe('Noch etwa 3 Minuten');
  });
});

describe('Gerätesuche · ein Fund in Worten', () => {
  it('erfindet keinen Modellnamen: Hersteller und Bauart, sonst das Modell der Box', () => {
    expect(fundTitel(gsDeye)).toBe('Deye Hybrid-Wechselrichter');
    expect(fundTitel(gsShelly)).toBe('Shelly SPSW-003XE16EU');
    expect(fundTitel(gsGoe)).toBe('go-e Wallbox');
    expect(fundTitel(fund({ hersteller: null, modell: null, art: 'modbus_geraet' }))).toBe('Modbus-Gerät');
    expect(fundTitel(fund({ hersteller: 'Unbekannt AG', modell: null, art: 'zaehler' }))).toBe('Unbekannt AG Zähler');
  });

  it('die graue Zeile: Art und Adresse am Telefon, Art und Bauart in der Tabelle', () => {
    expect(fundZeile(gsShelly, true)).toBe('3 Schaltausgänge · 192.168.178.43');
    expect(fundZeile(gsDeye, false)).toBe('Wechselrichter · Hybrid, 3-phasig, Hochvolt');
    expect(bauart(gsGoe)).toBeNull();
    expect(fundAdresse(gsDeye)).toBe('192.168.178.34');
    expect(fundAdresse(gsDeye, true)).toBe('192.168.178.34:8899');
    expect(fundAdresse(fund({ verbindung: {} }))).toBeNull();
  });

  it('Woran erkannt: bekannte Merkmale in Worten, unbekannte bleiben als Wort der Box sichtbar', () => {
    expect(merkmalText('v5_kopf_seriennummer').roh).toBe(false);
    expect(merkmalText('deye_typ_0x0006').text).toBe('Typregister 0x0000 meldet 0x0006.');
    expect(merkmalText('kostal_neu_123')).toEqual({ text: 'kostal_neu_123', roh: true });
  });
});

describe('Gerätesuche · was ein Fund anbietet', () => {
  it('übernehmbar nur sicher oder wahrscheinlich (mit Bestätigung) und mit Vorlage', () => {
    expect(fundAktion(gsGoe, 'bereit', true)).toEqual({ art: 'uebernehmen', bestaetigen: false });
    expect(fundAktion(fund({ erkennung: 'wahrscheinlich' }), 'bereit', true)).toEqual({ art: 'uebernehmen', bestaetigen: true });
    expect(fundAktion(fund({ vorlagen: [] }), 'bereit', true)).toEqual({ art: 'keine' });
    expect(fundAktion(fund({ erkennung: 'unbekannt' }), 'bereit', true)).toEqual({ art: 'keine' });
  });

  it('Geräte, die die Box pflegt: suchen ja, übernehmen nein', () => {
    expect(fundAktion(gsGoe, 'bereit', false)).toEqual({ art: 'keine' });
  });

  it('DP-7 A: eine neue Adresse ist ein Vorschlag an derselben Komponente, nie eine neue', () => {
    const k = { id: 'k-1', name: 'Wallbox Garage' };
    const a = fundAktion(fund({ abgleich: 'adresse_geaendert', komponente: k, bekannteAdresse: '192.168.178.51:80' }), 'braucht_hilfe', true);
    expect(a).toEqual({ art: 'adresse', komponente: k, neu: '192.168.178.52:80', bisher: '192.168.178.51:80' });
    expect(fundHinweis(fund({ abgleich: 'adresse_geaendert', bekannteAdresse: '192.168.178.51:80' })))
      .toBe('Bisher 192.168.178.51:80. Gleiche Seriennummer – es ist dasselbe Gerät. Tipp: feste IP im Router.');
  });

  it('ein Hindernis braucht Hilfe statt eines Knopfs; nicht anbindbar und schon eingerichtet bieten nichts an', () => {
    expect(fundAktion(fund({ hindernis: 'geschuetzt' }), 'braucht_hilfe', true)).toEqual({ art: 'keine' });
    expect(fundHinweis(fund({ hindernis: 'geschuetzt' }))).toContain('VoltPilot meldet sich nie an');
    expect(fundHinweis(fund({ hindernis: 'lokale_api_aus' }))).toContain('HTTP API v2');
    expect(fundAktion(fund({ anbindung: 'nicht_mit_dieser_box' }), 'nicht_anbindbar', true)).toEqual({ art: 'keine' });
    expect(fundHinweis(fund({ anbindung: 'kein_leseweg' }))).toBe('Erkannt, aber VoltPilot kann es noch nicht lesen.');
    expect(fundAktion(gsGoe, 'schon_eingerichtet', true)).toEqual({ art: 'keine' });
    expect(fundAktion(fund({ anbindung: 'selbst_beschreiben', erkennung: 'unbekannt' }), 'vielleicht', true)).toEqual({ art: 'selbst' });
  });

  it('an einer bekannten Adresse ein anderes Gerät: das sagt der Satz, nie „dasselbe"', () => {
    const satz = fundHinweis(fund({ abgleich: 'anderes_geraet_an_bekannter_adresse', komponente: { id: 'k', name: 'Wallbox Garage' } }));
    expect(satz).toBe('An dieser Adresse antwortet ein anderes Gerät als „Wallbox Garage“. Wurde das Gerät getauscht?');
  });
});

describe('Gerätesuche · Übernehmen', () => {
  it('Deye: acht Hochvolt-Modelle zur Wahl, nach Leistung - die Suche kennt die Leistung nicht', () => {
    const w = uebernahmeWeg(gsDeye, GS_TEMPLATES);
    expect(w.art).toBe('modell');
    if (w.art !== 'modell') return;
    expect(w.templates).toHaveLength(8);
    expect(w.templates.map((t) => t.ratedKw)).toEqual([25, 29.9, 29.9, 30, 30, 35, 40, 50]);
  });

  it('Shelly mit drei Ausgängen: je Ausgang eine Komponente; go-e direkt; ohne Vorlage im Katalog „unbekannt"', () => {
    expect(uebernahmeWeg(gsShelly, GS_TEMPLATES)).toEqual({ art: 'ausgang', template: GS_SHELLY, kanaele: 3 });
    expect(uebernahmeWeg({ ...gsShelly, kanaele: 1 }, GS_TEMPLATES)).toEqual({ art: 'direkt', template: GS_SHELLY });
    expect(uebernahmeWeg(gsGoe, GS_TEMPLATES)).toEqual({ art: 'direkt', template: GS_GOE });
    expect(uebernahmeWeg(gsGoe, [])).toEqual({ art: 'unbekannt' });
  });

  it('die Vorbelegung spricht die Schlüssel der Vorlage: unit_id → mb_slave_id, Seriennummer als Text, Kanal', () => {
    expect(vorbelegung(gsDeye, GS_DEYE_HV[0])).toEqual({
      ip: '192.168.178.34', port: 8899, serial: '3115580613', unit_id: 1, mb_slave_id: 1,
    });
    expect(vorbelegung(gsShelly, GS_SHELLY, 2)).toEqual({ ip: '192.168.178.43', port: 80, channel: 2 });
    expect(vorbelegung(gsGoe, GS_GOE)).toEqual({ ip: '192.168.178.52', port: 80 });
  });

  it('ein Schalter gilt erst als übernommen, wenn jeder Ausgang übernommen ist', () => {
    const u = new Set([uebernahmeSchluessel(gsShelly, 0), uebernahmeSchluessel(gsShelly, 2)]);
    expect(offeneAusgaenge(gsShelly, u)).toEqual([1]);
    expect(istUebernommen(gsShelly, u)).toBe(false);
    u.add(uebernahmeSchluessel(gsShelly, 1));
    expect(istUebernommen(gsShelly, u)).toBe(true);
    expect(istUebernommen(gsGoe, new Set([gsGoe.schluessel]))).toBe(true);
  });
});

describe('Gerätesuche · Ergebnis', () => {
  it('Überschriften wie auf der Konzeptseite (m3, m5c, m9)', () => {
    expect(ergebnisTitel(F.fertig, new Set())).toBe('2 Geräte gefunden');
    expect(ergebnisTitel(F.hinweis, new Set())).toBe('1 neues Gerät, 1 Hinweis');
    const nachDeye = new Set([gsDeye.schluessel]);
    expect(ergebnisTitel(F.fertig, nachDeye)).toBe('Noch 1 Gerät');
    expect(ergebnisTitel(F.nichts, new Set())).toBe('Keine Energie-Geräte gefunden');
  });

  it('nichts gefunden heißt: kein Energie-Gerät und keine Ladesäule, die anklopft', () => {
    expect(nichtsGefunden(F.nichts)).toBe(true);
    expect(nichtsGefunden(F.fertig)).toBe(false);
    expect(nichtsGefunden(F.laeuft)).toBe(false);
    expect(nichtsGefunden({ ...F.nichts, ladesaeulenKlopfenAn: F.breit.ladesaeulenKlopfenAn })).toBe(false);
  });

  it('DP-3 A: Telefone und Rechner nur als Zahl, Netz-Technik nur mit Art; ohne Zählung kein Zahlwort', () => {
    expect(weitere(F.fertig)).toEqual({ anzahl: 3, zeile: 'Router, WLAN-Zugangspunkt, 1 Telefon oder Tablet' });
    expect(weitere(F.wartet)).toEqual({ anzahl: null, zeile: null });
    expect(weitereTitel(3)).toBe('3 weitere Geräte');
    expect(weitereTitel(null)).toBe('Weitere Geräte nicht gezählt');
  });

  it('die Prüffragen nennen die Netze, und was die Box nicht gesucht hat', () => {
    const fragen = nichtsGefundenFragen(F.nichts);
    expect(fragen.map((q) => q.frage)).toEqual(['Gerät aus?', 'Anderes Netz?', 'Schnittstelle aus?', 'Nicht gesucht?']);
    expect(fragen[1].antwort).toContain('192.168.178.0/24 und 192.168.2.0/24');
    expect(nichtGesucht(F.nichts)).toContain('Fronius');
    expect(nichtGesucht(F.fertig)).toEqual([]);
    expect(nichtGesucht(F.laeuft)).toEqual([]);
  });

  it('jede beendete Suche, die nicht fertig ist, hat einen Satz', () => {
    expect(endHinweis(F.fertig)).toBeNull();
    expect(endHinweis(F.laeuft)).toBeNull();
    expect(endHinweis(F.abgebrochen)?.satz).toBe('Die Suche wurde abgebrochen. Was bis dahin gefunden war, steht unten.');
    expect(endHinweis(F.keineAntwort)?.satz).toBe('Ihre Box hat die Suche nicht zu Ende gemeldet. Was bis dahin gefunden war, steht unten.');
    expect(endHinweis(F.abgelehnt)?.satz).toContain('Ihre Box weiß nicht, in welchem Heimnetz sie steht');
    expect(endHinweis(F.fehlgeschlagen)?.ton).toBe('fehler');
  });

  it('Ablehnungen beim Start in Worten (409/429)', () => {
    const f = (code: string, extra: object = {}) =>
      ({ code, message: '', suchId: null, zuletztGesehen: null, wiederAb: null, ...extra }) as never;
    expect(startFehlerSatz(f('box_offline', { zuletztGesehen: '2026-11-02T07:40:00Z' })))
      .toBe('Ihre Box meldet sich gerade nicht (zuletzt 08:40). Gesucht wird auf der Box selbst – sobald sie wieder verbunden ist, geht es.');
    expect(startFehlerSatz(f('nicht_unterstuetzt'))).toBe('Update nötig für: Gerätesuche');
    expect(startFehlerSatz(f('zu_oft', { wiederAb: '2026-11-02T09:30:00Z' })))
      .toBe('Bitte einen Moment warten. Je Box sind 6 Suchen pro Stunde möglich. Ab 10:30 geht es wieder.');
  });
});

describe('Gerätesuche · der Knopf (m8)', () => {
  const basis = { lastSeenAt: new Date(JETZT - 20_000).toISOString(), faehigkeiten: ['geraetesuche'], laufend: null, ichName: 'Jonas Wendlinger', jetzt: JETZT };

  it('geht, wenn die Box frisch ist und die Fähigkeit meldet - oder ihre Fähigkeiten unbekannt sind', () => {
    expect(knopfLage(basis)).toEqual({ art: 'bereit' });
    expect(knopfLage({ ...basis, faehigkeiten: null })).toEqual({ art: 'bereit' });
  });

  it('erklärt, warum er nicht geht: offline, Update nötig, läuft schon (mit Person)', () => {
    expect(knopfLage({ ...basis, lastSeenAt: new Date(JETZT - 6 * 60_000).toISOString() }).art).toBe('offline');
    expect(knopfLage({ ...basis, lastSeenAt: null })).toEqual({
      art: 'offline',
      satz: 'Ihre Box meldet sich gerade nicht. Gesucht wird auf der Box selbst – sobald sie wieder verbunden ist, geht es.',
    });
    expect(knopfLage({ ...basis, faehigkeiten: ['data_sources'] })).toEqual({ art: 'update', satz: 'Update nötig für: Gerätesuche' });
    const laufend = { ...gsVerlauf(JETZT)[1], zustand: 'laeuft' as const, gestartetAm: new Date(JETZT - 12_000).toISOString() };
    expect(knopfLage({ ...basis, laufend })).toEqual({
      art: 'laeuft',
      satz: 'Suche läuft · seit 12 s · gestartet von Anna Weber (VoltPilot-Service)',
      suchId: laufend.suchId,
    });
  });
});

describe('Gerätesuche · Verlauf (m10) und Zeiten', () => {
  const jetzt = new Date(JETZT);

  it('„Sie" für die eigene Person, sonst Name und Art der Unterstützung', () => {
    expect(wer({ name: 'Jonas Wendlinger', rolle: null, art: 'kunde' }, 'Jonas Wendlinger')).toBe('Sie');
    expect(wer({ name: 'Anna Weber', rolle: null, art: 'voltpilot' }, 'Jonas Wendlinger')).toBe('Anna Weber (VoltPilot-Service)');
  });

  it('Zeilen der letzten Suchen: Zeit, Person, Ergebnis, Dauer', () => {
    const [heute, abgebrochen, leer] = gsVerlauf(JETZT).map((e) => verlaufZeile(e, 'Jonas Wendlinger', jetzt));
    expect(heute).toEqual({ titel: 'Heute, 10:11', zeile: 'Sie · 2 neue Geräte', rechts: '38 s' });
    expect(abgebrochen.zeile).toBe('Anna Weber (VoltPilot-Service) · abgebrochen');
    expect(abgebrochen.titel).toBe('31.10., 09:12');
    expect(leer.zeile).toBe('Sie · keine Energie-Geräte');
    expect(verlaufErgebnis({ ...gsVerlauf(JETZT)[0], zustand: 'keine_antwort' })).toBe('nicht zu Ende gemeldet');
  });

  it('die letzte Suche als ein Satz auf der Box-Karte (d1)', () => {
    expect(letzteSucheSatz(gsVerlauf(JETZT)[0], jetzt)).toBe('Letzte Suche heute 10:11 · 2 Energie-Geräte, 2 davon noch nicht übernommen');
  });

  it('Tage in Berliner Zeit, Dauern ohne erfundene Null', () => {
    expect(wann('2026-11-01T22:30:00Z', jetzt)).toBe('Gestern, 23:30');
    expect(dauerText(null)).toBeNull();
    expect(dauerText(38_120)).toBe('38 s');
    expect(dauerText(72_000)).toBe('1 min 12 s');
  });

  it('OCPP „klopft an": Adresse, Versuche, zuletzt', () => {
    const [l] = F.breit.ladesaeulenKlopfenAn ?? [];
    expect(klopftAnZeile(l, jetzt)).toBe('192.168.178.81 · 14 Versuche · zuletzt 10:10');
  });
});
