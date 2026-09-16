import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UemsDatenquelle, UemsDatenquelleZeitraum, UemsGeraet } from './api';
import {
  boxAmGeraet,
  boxSatz,
  boxWechsel,
  boxWechselAmGeraet,
  quellenJeGeraet,
  wechselFelder,
  wechselZu,
  zustaendigkeit,
} from './boxAnQuelle';
import { zeitpunktText } from './messstellen';
import { markerSatz } from './uemsVerlauf';

/**
 * „Die Box an der Quelle“ (UEMS AP-13 IP-12, L6 · W10).
 *
 * JEDE Zahl, jedes Kennzeichen und jeder Name kommt aus
 * `docs/contracts/v2/uems-referenzunternehmen.json` (Kunststoffwerk Ahrenberg) — hier steht kein
 * abgeschriebener Wert. Der Box-Tausch am 04.11.2026 09:38 (E-2 → E-2′, Zeitachse der Referenz)
 * ist der Fall, an dem sich das Paket messen lassen muss.
 */
const WURZEL = resolve(process.cwd(), '../../docs/contracts/v2');
const daten = JSON.parse(readFileSync(resolve(WURZEL, 'uems-referenzunternehmen.json'), 'utf8')) as Record<string, any>;

const BOXEN: Record<string, any> = Object.fromEntries(daten.boxen.map((b: any) => [b.kennzeichen, b]));
const QUELLEN: Record<string, any> = Object.fromEntries(daten.datenquellen.map((q: any) => [q.kennzeichen, q]));
const GERAETE: Record<string, any> = Object.fromEntries(daten.geraete.map((g: any) => [g.kennzeichen, g]));

/** Der Tausch-Zeitpunkt steht in der Referenz an der ausgebauten Box — nicht im Test. */
const TAUSCH: string = BOXEN['E-2'].ausgebaut_am;
/** Die Nachfolgerin nennt ihre Vorgängerin selbst. */
const NACHFOLGERIN = daten.boxen.find((b: any) => b.vorgaenger === 'E-2');

const id = (kz: string): string => `id-${kz}`;

const box = (kz: string) => ({ id: id(kz), name: BOXEN[kz].name as string, heimat_anlage: BOXEN[kz].heimat_anlage as string });

/**
 * Eine Datenquelle in der Form der Route (`GET …/sites/{id}/data-sources`) mit der Zeitachse ihrer
 * Zuständigkeiten. `zeitraeume` wird aus der Referenz gebildet: jede Box liest ab ihrer
 * Inbetriebnahme, bis sie ausgebaut wird; die Nachfolgerin übernimmt genau dann.
 */
function quelle(kz: string, zeitraeume: UemsDatenquelleZeitraum[]): UemsDatenquelle {
  const q = QUELLEN[kz];
  return {
    id: id(kz),
    kennzeichen: q.kennzeichen,
    name: q.hinweis ?? null,
    anlage: q.anlage,
    protokoll: q.protokoll,
    adresse: q.adresse,
    geraete_ids: q.geraete_ids,
    netz: q.netz,
    mehrere_leser: false,
    steuerquelle: q.steuerquelle,
    vergleichsquelle: false,
    kadenz_s: q.kadenz_s,
    archiviert_am: null,
    zustaendige_box: null,
    zeitraeume,
  };
}

/** Die Zeitachse einer Quelle, die Box `alt` bis zum Tausch und danach ihre Nachfolgerin liest. */
const mitTausch = (kz: string, alt: string, neu: string): UemsDatenquelle =>
  quelle(kz, [
    { box: box(alt), effective_from: BOXEN[alt].in_betrieb_ab, effective_to: TAUSCH },
    { box: box(neu), effective_from: TAUSCH, effective_to: null },
  ]);

/** Die Zeitachse einer Quelle, die dieselbe Box durchgehend liest. */
const durchgehend = (kz: string, b: string): UemsDatenquelle =>
  quelle(kz, [{ box: box(b), effective_from: BOXEN[b].in_betrieb_ab, effective_to: null }]);

const geraet = (kz: string): UemsGeraet => ({
  id: id(kz),
  kennzeichen: GERAETE[kz].kennzeichen,
  einbau_kennzeichen: GERAETE[kz].einbauten?.[0] ?? GERAETE[kz].kennzeichen,
  ausgebaut_am: null,
  komponenten: [],
  data_source_id: id(GERAETE[kz].datenquelle),
});

const ZONE = 'Europe/Berlin';
const registerZeit = (iso: string) => zeitpunktText(iso, ZONE);

// AN-2 nach dem Tausch: beide Quellen der Anlage wechseln im selben Augenblick die Box.
const an2 = () => [mitTausch('DQ-4', 'E-2', 'E-2′'), mitTausch('DQ-5', 'E-2', 'E-2′')];

describe('Zuständigkeit → Satz (L6)', () => {
  it('nennt die Box und ihr „seit“ im Wortlaut von L6', () => {
    const nachher = new Date(Date.parse(TAUSCH) + 60_000).toISOString();
    const z = zustaendigkeit(mitTausch('DQ-4', 'E-2', 'E-2′'), nachher);
    expect(z).not.toBeNull();
    expect(z!.name).toBe(NACHFOLGERIN.name);
    expect(z!.seit).toBe(TAUSCH);
    expect(boxSatz(z, registerZeit)).toBe(`gelesen von ${NACHFOLGERIN.name} seit 04.11.2026 09:38`);
  });

  it('nennt VOR dem Tausch die alte Box, seit ihrer Inbetriebnahme', () => {
    const davor = new Date(Date.parse(TAUSCH) - 60_000).toISOString();
    const z = zustaendigkeit(mitTausch('DQ-4', 'E-2', 'E-2′'), davor);
    expect(boxSatz(z, registerZeit)).toBe(`gelesen von ${BOXEN['E-2'].name} seit 01.10.2026`);
  });

  it('der Tausch-Augenblick gehört schon der neuen Box (halboffen, `effective_to` zählt nicht mit)', () => {
    const z = zustaendigkeit(mitTausch('DQ-4', 'E-2', 'E-2′'), TAUSCH);
    expect(z!.name).toBe(NACHFOLGERIN.name);
  });

  it('ohne Zuständigkeit steht NICHTS — keine 0, kein „unbekannt“', () => {
    const vorher = new Date(Date.parse(BOXEN['E-2'].in_betrieb_ab) - 60_000).toISOString();
    expect(zustaendigkeit(mitTausch('DQ-4', 'E-2', 'E-2′'), vorher)).toBeNull();
    expect(boxSatz(null, registerZeit)).toBeNull();
  });

  it('eine Lücke ohne Box bleibt eine Lücke — die nächste Box wird nicht vorgezogen', () => {
    const luecke = quelle('DQ-4', [
      { box: box('E-2'), effective_from: BOXEN['E-2'].in_betrieb_ab, effective_to: TAUSCH },
      { box: box('E-2′'), effective_from: NACHFOLGERIN.in_betrieb_ab, effective_to: null },
    ]);
    // Zwischen Ende und Beginn liegt hier nichts; mit einem späteren Beginn stünde in der Lücke kein Satz.
    const spaeter = quelle('DQ-4', [
      { box: box('E-2'), effective_from: BOXEN['E-2'].in_betrieb_ab, effective_to: TAUSCH },
      { box: box('E-2′'), effective_from: new Date(Date.parse(TAUSCH) + 120_000).toISOString(), effective_to: null },
    ]);
    expect(zustaendigkeit(luecke, TAUSCH)).not.toBeNull();
    expect(zustaendigkeit(spaeter, new Date(Date.parse(TAUSCH) + 60_000).toISOString())).toBeNull();
  });

  it('eine Box ohne Kundennamen bekommt keinen Satz — eine rohe Kennung ist kein Kundensatz', () => {
    const ohneNamen = quelle('DQ-4', [
      { box: { id: id('E-2'), name: null, heimat_anlage: null }, effective_from: BOXEN['E-2'].in_betrieb_ab, effective_to: null },
    ]);
    expect(zustaendigkeit(ohneNamen, TAUSCH)).toBeNull();
  });
});

describe('Der Weg Komponente → Gerät → Datenquelle (Befund an AP-06)', () => {
  it('verbindet über `geraet.data_source_id` — die Quelle nennt ihre Geräte nicht selbst', () => {
    const karte = quellenJeGeraet([geraet('GR-7'), geraet('GR-8')], an2());
    expect(karte.get(id('GR-7'))!.kennzeichen).toBe(GERAETE['GR-7'].datenquelle);
    expect(karte.get(id('GR-8'))!.kennzeichen).toBe(GERAETE['GR-8'].datenquelle);
  });

  it('L6 am Register-Gerät GR-7 (WAGO-Controller C-1): „gelesen von Box Halle 2 (neu) seit …“', () => {
    const karte = quellenJeGeraet([geraet('GR-7')], an2());
    const nachher = new Date(Date.parse(TAUSCH) + 60_000).toISOString();
    expect(boxSatz(boxAmGeraet(karte, id('GR-7'), nachher), registerZeit)).toBe(
      `gelesen von ${NACHFOLGERIN.name} seit 04.11.2026 09:38`,
    );
  });

  it('ein Gerät ohne Datenquelle steht nicht in der Karte und bekommt keinen Satz', () => {
    const ohne: UemsGeraet = { ...geraet('GR-7'), data_source_id: null };
    const karte = quellenJeGeraet([ohne], an2());
    expect(karte.size).toBe(0);
    expect(boxAmGeraet(karte, id('GR-7'), TAUSCH)).toBeNull();
    expect(boxAmGeraet(karte, null, TAUSCH)).toBeNull();
  });
});

describe('Box-Tausch und Übergabe aus der Zeitachse (V5)', () => {
  it('liest den Box-Tausch am 04.11.2026 09:38 aus der Zeitachse', () => {
    const alle = an2();
    const w = boxWechsel(alle[0], alle);
    expect(w).toHaveLength(1);
    expect(w[0].zeitpunkt).toBe(TAUSCH);
    expect(registerZeit(w[0].zeitpunkt)).toBe('04.11.2026 09:38');
    expect(w[0].anlass).toBe('box_tausch');
    expect(w[0].namen[w[0].boxAlt]).toBe(BOXEN['E-2'].name);
    expect(w[0].namen[w[0].boxNeu]).toBe(NACHFOLGERIN.name);
  });

  it('behält die alte Box eine andere Quelle, ist es eine ÜBERGABE, kein Tausch', () => {
    // Wartung Box Halle 1 (Zeitachse 10.04.2027): nur DQ-3 wechselt, DQ-1 und DQ-2 bleiben bei E-1.
    const wartung = daten.zeitachse.find((e: any) => String(e.ereignis).includes('Wartung Box Halle 1'));
    const zeitpunkt: string = wartung.zeitpunkt;
    const dq3 = quelle('DQ-3', [
      { box: box('E-1'), effective_from: BOXEN['E-1'].in_betrieb_ab, effective_to: zeitpunkt },
      { box: box('E-2′'), effective_from: zeitpunkt, effective_to: null },
    ]);
    const alle = [dq3, durchgehend('DQ-1', 'E-1'), durchgehend('DQ-2', 'E-1')];
    const w = boxWechsel(dq3, alle);
    expect(w).toHaveLength(1);
    expect(w[0].anlass).toBe('uebergabe');
    // Ohne die übrigen Quellen der Anlage sähe derselbe Wechsel wie ein Tausch aus — darum `alle`.
    expect(boxWechsel(dq3)[0].anlass).toBe('box_tausch');
  });

  it('eine Lücke zwischen zwei Zeiträumen ist KEIN Wechsel', () => {
    const mitLuecke = quelle('DQ-4', [
      { box: box('E-2'), effective_from: BOXEN['E-2'].in_betrieb_ab, effective_to: TAUSCH },
      { box: box('E-2′'), effective_from: new Date(Date.parse(TAUSCH) + 120_000).toISOString(), effective_to: null },
    ]);
    expect(boxWechsel(mitLuecke, [mitLuecke])).toHaveLength(0);
  });

  it('findet die Wechsel über das Gerät der Bindung', () => {
    const alle = an2();
    const karte = quellenJeGeraet([geraet('GR-7')], alle);
    expect(boxWechselAmGeraet(karte, id('GR-7'), alle)[0].zeitpunkt).toBe(TAUSCH);
    expect(boxWechselAmGeraet(karte, null, alle)).toHaveLength(0);
  });
});

describe('Der Marker im Verlauf spricht die Boxen (IP-4-Sätze)', () => {
  // Die Zeitachse der Referenz: erste Lesung der neuen Box zwei Minuten nach der Übernahme.
  const ERSTE_LESUNG: string = daten.zeitachse.find((e: any) => String(e.ereignis).includes('Erste Lesung von E-2′')).zeitpunkt;
  const ereignis = { art: 'handover', von: TAUSCH, bis: ERSTE_LESUNG };

  it('ohne Zeitachse bleibt es beim Kurz-Satz der Art — keine geratene Box', () => {
    expect(markerSatz(ereignis, ZONE)).toBe('Übergabe von 04.11.2026 09:38 bis 09:40');
  });

  it('mit der Zeitachse steht der volle Box-Tausch-Satz', () => {
    const alle = an2();
    expect(markerSatz(ereignis, ZONE, boxWechsel(alle[0], alle))).toBe(
      `Box-Tausch: ${NACHFOLGERIN.name} ersetzt ${BOXEN['E-2'].name} — keine Werte von 04.11.2026 09:38 bis 09:40`,
    );
  });

  it('ein Wechsel zu einem anderen Augenblick ergänzt den Marker NICHT', () => {
    const alle = an2();
    const fremd = { ...ereignis, von: new Date(Date.parse(TAUSCH) + 600_000).toISOString() };
    expect(markerSatz(fremd, ZONE, boxWechsel(alle[0], alle))).toContain('Übergabe');
  });

  it('ohne beide Box-Namen gibt es keine Ergänzung', () => {
    const w = boxWechsel(an2()[0], an2())[0];
    expect(wechselFelder(w)).not.toBeNull();
    expect(wechselFelder({ ...w, namen: {} })).toBeNull();
    expect(wechselZu([w], TAUSCH)).toBe(w);
    expect(wechselZu([w], ERSTE_LESUNG)).toBeNull();
  });
});
