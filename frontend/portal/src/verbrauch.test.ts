import { describe, expect, it } from 'vitest';
import type { BewertungMessabdeckung, BewertungRangliste, Messbedarf } from './api';
import { canonicalVerbrauchHash, energieeinsatzRoute, hashForRoute, pageRoute, parseRoute } from './nav';
import { ahrenbergRangliste } from './test/bewertungFixtures';
import {
  blaettern,
  grenzen,
  kannVor,
  letzterVollerMonat,
  mengeImSatz,
  nennerJeMonat,
  verbrauchBild,
  verbrauchCsv,
  verlaufBild,
  vorjahrVergleich,
  vorjahrVon,
  zeitraumAdresse,
  zeitraumAusAdresse,
  zeitraumKurz,
  zeitraumLang,
  type VerbrauchZeitraum,
} from './verbrauch';

const NB = String.fromCharCode(160);
const MONAT: VerbrauchZeitraum = { art: 'monat', bis: '2026-10' };

/** Zwölf Monate Hauptzähler (eine Anlage) als Herkunft jedes Einsatzes — wie die Route sie schickt. */
function zwoelfMonate(bis: string, werte: (number | null)[], vorjahr = false): BewertungRangliste {
  const r = ahrenbergRangliste();
  const [j, m] = bis.split('-').map(Number);
  const monate = werte.map((_, i) => {
    const idx = j * 12 + (m - 1) - (werte.length - 1 - i) - (vorjahr ? 12 : 0);
    return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
  });
  const bilanzwerte = monate.map((mo, i) => ({
    anlage: 'Halle 1', von: `${mo}-01`, bis: `${mo}-28`, wert: werte[i] === null ? null : String(werte[i]), version: 1,
    zustand: werte[i] === null ? 'keine Werte' : 'vollständig', eingaenge: [{ objekt: 'HZ-1', wert: null, version: 1, zustand: null }],
  }));
  const summe = werte.reduce<number>((a, w) => a + (w ?? 0), 0);
  return {
    ...r,
    von: `${monate[0]}-01`,
    bis: `${monate[monate.length - 1]}-28`,
    monate: werte.length,
    nenner: { wert: String(summe), einheit: 'kWh', vorhanden: 1, gesamt: 1, anlagen: '1 von 1', zustand: 'vollständig' },
    einsaetze: r.einsaetze.map((e) => ({ ...e, herkunft: { ...e.herkunft, nenner: { wert: String(summe), anlagen: '1 von 1', bilanzwerte } } })),
  };
}

const abdeckung = (): BewertungMessabdeckung => {
  const r = ahrenbergRangliste();
  return {
    von: r.von, bis: r.bis, umfang_id: null, umfang_fassung: null, teilansicht: false,
    summe: { nenner: r.nenner, gemessen_zugeordnet: '125740', abdeckung_prozent: '67.8', k8: 'unter_schwelle', ersatz: '0', ungemessen: '59640', ungemessen_prozent: '32.2' },
    je_einsatz: r.einsaetze.map((e) => ({
      id: e.id, kennzeichen: e.kennzeichen, name: e.name, prozess_id: e.prozess_id, traeger: e.traeger, einheit: 'kWh', menge: e.menge,
      gemessen: e.herkunft.eingaenge.map((x) => ({ id: `ms-${x.objekt}`, kennzeichen: x.objekt, ort: 'G-1 Halle 1', menge: x.wert, einheit: 'kWh' })),
      geplant: [], ersatz: [], ungemessen: [],
    })),
    je_ort: r.anlagen.map((a) => ({
      art: 'anlage' as const, id: a.id, kennzeichen: null, name: a.name, traeger: 'Strom' as const, einheit: 'kWh', gemessen: [], geplant: [], ersatz: [],
      ungemessen: { anlage_id: a.id, anlage: a.name, menge: a.rest, anteil_prozent: a.rest_anteil_prozent },
    })),
  };
};

const offenerBedarf = { kennzeichen: 'MB-1', wortlaut: 'Lüftung, Beleuchtung und Allgemeinstrom Halle 1', zustand: 'offen' } as unknown as Messbedarf;

describe('die Adresse: `#/portfolio/verbrauch`, ein Energieeinsatz darunter, die alte Adresse leitet weiter', () => {
  it('Liste und Seite eines Einsatzes; `#/portfolio/bewertung/{id}` führt mit ihren Parametern dorthin', () => {
    expect(hashForRoute(pageRoute('portfolio-verbrauch'))).toBe('#/portfolio/verbrauch');
    expect(parseRoute('#/portfolio/verbrauch')).toEqual(pageRoute('portfolio-verbrauch'));
    expect(hashForRoute(energieeinsatzRoute('ee-1'))).toBe('#/portfolio/verbrauch/ee-1');
    expect(parseRoute('#/portfolio/verbrauch/ee-1')).toEqual(energieeinsatzRoute('ee-1'));
    expect(canonicalVerbrauchHash('#/portfolio/bewertung/ee-8?entscheid=messbedarf_frist&kennzeichen=MB-1')).toBe(
      '#/portfolio/verbrauch/ee-8?entscheid=messbedarf_frist&kennzeichen=MB-1',
    );
    // Die Bewertung selbst bleibt, wo sie ist.
    expect(canonicalVerbrauchHash('#/portfolio/bewertung')).toBeNull();
    expect(canonicalVerbrauchHash('#/portfolio/verbrauch/ee-1')).toBeNull();
  });
});

describe('Zeitraum: Monat oder zwölf Monate, nie über den letzten vollen Monat hinaus', () => {
  it('der letzte volle Monat folgt der Zeitzone des Unternehmens', () => {
    expect(letzterVollerMonat(new Date('2026-10-06T10:00:00Z'))).toBe('2026-09');
    // 31.12. 23:30 UTC ist in Berlin schon der 1. Januar.
    expect(letzterVollerMonat(new Date('2026-12-31T23:30:00Z'))).toBe('2026-12');
    expect(letzterVollerMonat(new Date('2027-01-15T12:00:00Z'))).toBe('2026-12');
  });

  it('Grenzen, Vorjahr, Texte', () => {
    expect(grenzen(MONAT)).toEqual({ von: '2026-10-01', bis: '2026-10-31' });
    expect(grenzen({ art: 'zwoelf', bis: '2026-09' })).toEqual({ von: '2025-10-01', bis: '2026-09-30' });
    expect(grenzen({ art: 'monat', bis: '2028-02' })).toEqual({ von: '2028-02-01', bis: '2028-02-29' });
    expect(vorjahrVon({ art: 'zwoelf', bis: '2026-09' })).toEqual({ art: 'zwoelf', bis: '2025-09' });
    expect(zeitraumKurz(MONAT)).toBe('Oktober 2026');
    expect(zeitraumKurz({ art: 'zwoelf', bis: '2026-09' })).toBe('Okt 2025 – Sep 2026');
    expect(zeitraumLang({ art: 'zwoelf', bis: '2026-09' })).toBe('Oktober 2025 bis September 2026');
  });

  it('blättert je Monat bzw. je zwölf Monate und bleibt am letzten vollen Monat stehen', () => {
    expect(blaettern(MONAT, -1, '2026-10')).toEqual({ art: 'monat', bis: '2026-09' });
    expect(blaettern({ art: 'monat', bis: '2026-12' }, 1, '2027-03')).toEqual({ art: 'monat', bis: '2027-01' });
    expect(blaettern({ art: 'zwoelf', bis: '2026-09' }, -1, '2026-09')).toEqual({ art: 'zwoelf', bis: '2025-09' });
    expect(blaettern({ art: 'zwoelf', bis: '2026-01' }, 1, '2026-09')).toEqual({ art: 'zwoelf', bis: '2026-09' });
    expect(kannVor(MONAT, '2026-10')).toBe(false);
    expect(kannVor({ art: 'monat', bis: '2026-08' }, '2026-10')).toBe(true);
  });

  it('liest und schreibt die Adresse; die Vorgabe bleibt ohne Parameter, ein Monat in der Zukunft gilt nicht', () => {
    expect(zeitraumAusAdresse('#/portfolio/verbrauch', '2026-09')).toEqual({ art: 'monat', bis: '2026-09' });
    expect(zeitraumAusAdresse('#/portfolio/verbrauch?zeitraum=12monate&bis=2026-03', '2026-09')).toEqual({ art: 'zwoelf', bis: '2026-03' });
    expect(zeitraumAusAdresse('#/portfolio/verbrauch?bis=2027-01', '2026-09')).toEqual({ art: 'monat', bis: '2026-09' });
    expect(zeitraumAusAdresse('#/portfolio/verbrauch?bis=2026-13', '2026-09')).toEqual({ art: 'monat', bis: '2026-09' });
    expect(zeitraumAdresse('#/portfolio/verbrauch', { art: 'monat', bis: '2026-09' }, '2026-09')).toBe('#/portfolio/verbrauch');
    expect(zeitraumAdresse('#/portfolio/verbrauch', { art: 'zwoelf', bis: '2026-03' }, '2026-09')).toBe('#/portfolio/verbrauch?zeitraum=12monate&bis=2026-03');
  });
});

describe('Vorjahr: roh, ohne Farbe, Pfeil erst ab 0,5 %', () => {
  it('unverändert, Pfeil, kein Vorjahr', () => {
    expect(vorjahrVergleich(1000, 1004)).toEqual({ text: 'unverändert ggü. Vorjahr', richtung: 'gleich' });
    expect(vorjahrVergleich(1100, 1000)).toEqual({ text: `▲ 10${NB}% ggü. Vorjahr`, richtung: 'rauf' });
    expect(vorjahrVergleich(970, 1000)).toEqual({ text: `▼ 3${NB}% ggü. Vorjahr`, richtung: 'runter' });
    expect(vorjahrVergleich(1000, null)).toEqual({ text: 'Vorjahr noch nicht verfügbar', richtung: null });
    // Fehlend ist keine Null: ohne Menge kein Vergleich.
    expect(vorjahrVergleich(null, 1000)).toBeNull();
  });

  it('große Mengen im Satz in Millionen', () => {
    expect(mengeImSatz(2_503_200)).toBe('2,5 Millionen kWh');
    expect(mengeImSatz(199_500)).toBe(`199.500${NB}kWh`);
  });
});

describe('verbrauchBild: Antwort zuerst, Balken einer Farbe, der Rest am Ende', () => {
  it('Monat: größter Bereich im Satz, Kachel mit Zuordnung nach K8, Reihen absteigend, Rest mit Ort und Plan', () => {
    const r = ahrenbergRangliste();
    const b = verbrauchBild({
      zeitraum: MONAT, rangliste: r, vorjahr: r, abdeckung: abdeckung(),
      einstufungen: new Map([[r.einsaetze[0].id, true], [r.einsaetze[1].id, false]]),
      messbedarfe: [offenerBedarf],
    });
    expect(b.leer).toBe(false);
    expect(b.antwort).toBe(`${r.einsaetze[0].name} braucht mit 42${NB}% den größten Teil des Stroms.`);
    expect(b.antwortBreit).toBe(`${r.einsaetze[0].name} braucht mit 42${NB}% den größten Teil des Stroms; 68${NB}% des Stroms sind einem Bereich zugeordnet.`);
    expect(b.untertitel).toBe('Strom · Oktober 2026 · alle Zähler vollständig');
    expect(b.kachel).toMatchObject({
      titel: 'Strom im Oktober 2026', wert: '185.380',
      vorjahr: { text: 'unverändert ggü. Vorjahr', richtung: 'gleich' },
      zugeordnet: { text: `68${NB}% einem Bereich zugeordnet`, ton: 'warn' },
      unterzeile: 'Hauptzähler von 3 von 3 Anlagen · vollständig',
    });
    const mengen = b.bereiche.map((x) => x.menge);
    expect(mengen).toEqual([...mengen].sort((x, y) => (y ?? 0) - (x ?? 0)));
    expect(b.bereiche[0]).toMatchObject({ wesentlich: true, mengeText: '77.500', anteil: `41,8${NB}%`, marke: null });
    expect(b.bereiche[1].wesentlich).toBe(false);
    expect(b.bereiche[2].wesentlich).toBeNull();
    // Der größte Bereich setzt den Maßstab der Balken — auch für den Rest, der darunter grau steht.
    expect(b.bereiche[0].balken).toBe(100);
    expect(b.rest).toMatchObject({ mengeText: '59.640', anteil: `32,2${NB}%` });
    expect(b.rest?.balken).toBeCloseTo((59640 / 77500) * 100);
    expect(b.rest?.satz).toBe('Halle 1 und Halle 2 und Werk Lindach ohne eigenen Zähler · geplant: Lüftung, Beleuchtung und Allgemeinstrom Halle 1');
    expect(b.rest?.ort?.name).toBe('Halle 1');
    // Ort mit Namen (aus der Messabdeckung), dann der Vorjahresvergleich; ohne Messstellen in der Zeile kein „Zähler …“.
    expect(b.bereiche[0].unterzeile).toEqual([{ text: 'Halle 1' }, { text: 'unverändert ggü. Vorjahr', fest: true }]);
    expect(b.hinweise).toEqual([]);
    expect(b.weitere).toEqual([{ traeger: 'Gas', zeilen: [expect.objectContaining({ wert: `1.240${NB}m³`, satz: null })] }]);
  });

  it('ohne Vorjahr kein Vergleich; ein unvollständiger Bereich sagt warum und führt zur Ablesung', () => {
    const r = ahrenbergRangliste();
    r.einsaetze[1] = { ...r.einsaetze[1], zustand: 'unvollständig', messstellen: [{ id: 'ms-7', kennzeichen: 'MS-07', anlage_id: null, einheit: 'kWh', menge: '15900', zustand: 'unvollständig' }] };
    const b = verbrauchBild({ zeitraum: MONAT, rangliste: r, vorjahr: null, abdeckung: null, einstufungen: null, messbedarfe: null });
    expect(b.kachel.vorjahr).toBeNull();
    expect(b.bereiche.find((x) => x.id === r.einsaetze[1].id)?.marke).toBe('unvollständig');
    expect(b.untertitel).toBe('Strom · Oktober 2026 · nicht alle Zähler vollständig');
    expect(b.hinweise).toEqual([
      { ton: 'warn', satz: `Für Oktober 2026 fehlen Werte von ${r.einsaetze[1].name} (Zähler MS-07) – sein Anteil ist darum zu klein.`, weg: { text: 'Ablesung eintragen', messstelle: 'ms-7' } },
    ]);
    // Ohne Messabdeckung steht der Rest trotzdem da, sein Anteil aus der Rangliste.
    expect(b.rest).toMatchObject({ anteil: `32,2${NB}%`, satz: 'Strom ohne eigenen Zähler' });
  });

  it('ein negativer Rest steht nie als negative Zahl, sondern als Satz mit Weg', () => {
    const r = { ...ahrenbergRangliste(), rest: '-3200' };
    const b = verbrauchBild({ zeitraum: MONAT, rangliste: r, vorjahr: null, abdeckung: null, einstufungen: null, messbedarfe: null });
    expect(b.rest).toBeNull();
    expect(b.hinweise.at(-1)).toEqual({
      ton: 'warn',
      satz: `Die Bereiche ergeben 3.200${NB}kWh mehr als der Hauptzähler – vermutlich ist ein Zähler doppelt zugeordnet.`,
      weg: { text: 'Zuordnung prüfen', messstelle: null },
    });
  });

  it('noch keine Bereiche: Leerzustand; Gas ohne Werte sagt warum, nicht „0“', () => {
    expect(verbrauchBild({ zeitraum: MONAT, rangliste: ahrenbergRangliste(true), vorjahr: null, abdeckung: null, einstufungen: null, messbedarfe: null }).leer).toBe(true);
    const r = ahrenbergRangliste();
    r.weitere_traeger = r.weitere_traeger.map((e) => ({ ...e, name: 'Heizung Verwaltung (Gas)', menge: null, zustand: 'keine Werte' }));
    const b = verbrauchBild({ zeitraum: MONAT, rangliste: r, vorjahr: null, abdeckung: null, einstufungen: null, messbedarfe: null });
    expect(b.weitere[0].zeilen[0]).toEqual({
      id: r.weitere_traeger[0].id,
      name: 'Heizung Verwaltung',
      wert: null,
      satz: 'Noch nicht gemessen: Gaszähler lassen sich noch nicht als Messstelle anlegen. Bis dahin lässt sich der Gasbezug als Bezugsgröße führen.',
    });
  });

  it('zwölf Monate: Menge in Millionen, Vorjahr, größter gegen kleinsten Monat; Datenlage in Monaten', () => {
    const werte = [216300, 222600, 228900, 226800, 222600, 214200, 205800, 199500, 193200, 189000, 184800, 199500];
    const r = zwoelfMonate('2026-09', werte);
    const vj = zwoelfMonate('2026-09', werte, true);
    const z: VerbrauchZeitraum = { art: 'zwoelf', bis: '2026-09' };
    const verlauf = verlaufBild(r, vj, '2026-09');
    const b = verbrauchBild({ zeitraum: z, rangliste: r, vorjahr: vj, abdeckung: null, einstufungen: null, messbedarfe: null, verlauf });
    expect(b.antwort).toBe(
      `In zwölf Monaten 2,5 Millionen kWh Strom${NB}– so viel wie im Jahr davor. Der Dezember brauchte am meisten, 24${NB}% mehr als der August.`,
    );
    expect(b.antwortBreit).toBeNull();
    expect(b.untertitel).toBe('Strom · Oktober 2025 bis September 2026 · 12 von 12 Monaten vollständig');
    expect(b.kachel.titel).toBe('Strom in zwölf Monaten');
  });
});

describe('Monatsverlauf: Säulen ab null, Vorjahr als Punkt, fehlend ist keine Null', () => {
  it('zwölf Säulen, Jahreszahl am ersten Monat und am Januar, runde Achsenwerte', () => {
    const werte = [216300, 222600, 228900, 226800, 222600, 214200, 205800, 199500, 193200, 189000, 184800, null];
    const v = verlaufBild(zwoelfMonate('2026-09', werte), zwoelfMonate('2026-09', werte.map((w) => w ?? 199500), true), '2026-09');
    expect(v.saeulen.map((s) => s.monat)).toEqual([
      '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09',
    ]);
    expect(v.saeulen.filter((s) => s.jahr).map((s) => [s.monat, s.jahr])).toEqual([['2025-10', '2025'], ['2026-01', '2026']]);
    expect(v.saeulen[11]).toMatchObject({ wert: null, vollstaendig: false, hoehe: 0, vorjahr: 199500 });
    expect(v.achse.map((a) => a.text)).toEqual(['100.000', '200.000']);
    // Die höchste Säule bleibt unter dem oberen Rand, damit ihr Vorjahrespunkt Platz hat.
    expect(Math.max(...v.saeulen.map((s) => s.hoehe))).toBeLessThan(92);
  });

  it('der Hauptzähler je Monat summiert mehrere Anlagen; fehlt einer der Wert, hat der Monat keinen', () => {
    const r = zwoelfMonate('2026-09', [100, 200]);
    const zwei = { ...r, nenner: { ...r.nenner, gesamt: 2 } };
    const mit = zwei.einsaetze[0].herkunft.nenner!.bilanzwerte;
    zwei.einsaetze[0].herkunft.nenner!.bilanzwerte = [...mit, { ...mit[0], anlage: 'Halle 2', wert: '50' }, { ...mit[1], anlage: 'Halle 2', wert: null, zustand: 'keine Werte' }];
    const n = nennerJeMonat(zwei);
    expect(n.get('2026-08')).toEqual({ monat: '2026-08', wert: 150, vollstaendig: true });
    expect(n.get('2026-09')).toEqual({ monat: '2026-09', wert: null, vollstaendig: false });
  });
});

describe('CSV: ungerundet, Dezimalpunkt, ISO-Zeitraum', () => {
  it('je Bereich eine Zeile, dazu Rest und Hauptzähler', () => {
    const csv = verbrauchCsv(ahrenbergRangliste()).split('\n');
    expect(csv[0]).toBe('Bereich;Kennzeichen;Traeger;Menge;Einheit;Anteil_Prozent;Zustand;Von;Bis');
    expect(csv).toContain('Keinem Bereich zugeordnet;;Strom;59640;kWh;;vollständig;2026-10-01;2026-10-31');
    expect(csv.at(-1)).toBe('Hauptzähler gesamt;;Strom;185380;kWh;100;vollständig;2026-10-01;2026-10-31');
  });
});
