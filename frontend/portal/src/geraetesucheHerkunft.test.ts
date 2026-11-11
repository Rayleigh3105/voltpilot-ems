import { describe, expect, it } from 'vitest';
import type { CommandEntry, CommandHistory, GeraetesucheAktivitaet } from './api';
import { film } from './befehle';
import { neuesteZuerst } from './befehleVerlauf';
import { geraetesucheBezug, herkunftSatz, herkunftZeile, sucheZeile } from './geraetesucheHerkunft';

/**
 * Die Herkunft aus der Gerätesuche (Folgepaket vp-gs-folge-herkunft): der Satz an der Komponente und die Zeilen des
 * fünften Stroms `geraetesuche` in der Aktivität der Box (Bild d1).
 */

const JETZT = Date.parse('2026-10-30T09:20:00Z');
const SUCH_ID = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const SIE = { name: 'Jonas Wendlinger', rolle: 'kundenadministrator', art: 'kunde' };
const SERVICE = { name: 'Anna Weber', rolle: 'voltpilot_betrieb', art: 'voltpilot' };

function block(over: Partial<GeraetesucheAktivitaet> = {}): GeraetesucheAktivitaet {
  return {
    suchId: SUCH_ID,
    zustand: 'fertig',
    grund: null,
    dauerMs: 38_120,
    zaehler: { braucht_hilfe: 0, bereit: 1, nicht_anbindbar: 0, vielleicht: 0, schon_eingerichtet: 1, weitere: 2 },
    abgebrochenVon: null,
    komponente: null,
    fund: null,
    gesuchtAm: null,
    ...over,
  };
}

function zeile(over: Partial<CommandEntry> = {}): CommandEntry {
  return {
    id: -(2 ** 50 + 7),
    stream: 'geraetesuche',
    kind: 'ereignis',
    eventKind: 'geraetesuche',
    startedAt: '2026-10-30T08:12:00Z',
    endedAt: '2026-10-30T08:12:38Z',
    mode: null,
    path: null,
    whyKind: null,
    whyRef: null,
    commandedKwFirst: null,
    commandedKwLast: null,
    commandedKwMin: null,
    commandedKwMax: null,
    verdict: null,
    cycles: null,
    cyclesConfirmed: null,
    cyclesNoAnswer: null,
    cyclesMismatch: null,
    controlEnabled: null,
    released: null,
    foreignInfluence: null,
    entityId: null,
    source: 'portal',
    detail: null,
    urheber: SIE,
    geraetesuche: block(),
    ...over,
  };
}

function uebernahme(over: Partial<CommandEntry> = {}): CommandEntry {
  return zeile({
    id: -(2 ** 50 + 9),
    eventKind: 'geraet_uebernommen',
    startedAt: '2026-10-30T08:14:00Z',
    endedAt: null,
    entityId: 'e-wr',
    geraetesuche: block({
      zustand: null, dauerMs: null, zaehler: null, komponente: 'Wechselrichter', fund: 'solarman:3115580613',
      gesuchtAm: '2026-10-30T08:12:00Z',
    }),
    ...over,
  });
}

function history(entries: CommandEntry[]): CommandHistory {
  return {
    recordingSince: '2026-08-01T00:00:00Z',
    accuracySeconds: 15,
    from: '2026-08-02T00:00:00Z',
    to: '2026-10-30T09:20:00Z',
    entityId: null,
    entityLabel: null,
    writes: false,
    truncated: false,
    entries,
    control: null,
    curtailment: null,
  };
}

describe('Herkunft an der Komponente', () => {
  it('„aus der Gerätesuche vom …" mit dem Berliner Tag der Suche', () => {
    const h = { art: 'geraetesuche', suchId: SUCH_ID, gesuchtAm: '2026-10-29T23:30:00Z', uebernommenAm: '2026-10-30T08:00:00Z' };
    // 23:30 UTC ist in Berlin schon der 30.10. - der Tag folgt der Zone des Portals, nicht der des Servers.
    expect(herkunftSatz(h)).toBe('aus der Gerätesuche vom 30.10.2026');
    expect(herkunftZeile(h)).toEqual({ label: 'Angelegt', wert: 'aus der Gerätesuche vom 30.10.2026' });
  });

  it('ohne Herkunft, mit einem fremden Wort oder einem unlesbaren Tag: kein Satz - nie geraten', () => {
    expect(herkunftSatz(null)).toBeNull();
    expect(herkunftSatz(undefined)).toBeNull();
    expect(herkunftSatz({ art: 'import', suchId: SUCH_ID, gesuchtAm: '2026-10-30T08:00:00Z', uebernommenAm: '' })).toBeNull();
    expect(herkunftZeile({ art: 'geraetesuche', suchId: SUCH_ID, gesuchtAm: 'kaputt', uebernommenAm: '' })).toBeNull();
  });

  it('der Bezug beim Übernehmen nennt Suche und Fund; ohne Suche keiner', () => {
    expect(geraetesucheBezug(SUCH_ID, 'goe:204117')).toEqual({ suchId: SUCH_ID, fund: 'goe:204117' });
    expect(geraetesucheBezug(null, 'goe:204117')).toBeNull();
  });
});

describe('Aktivität: die Zeilen des Stroms geraetesuche', () => {
  it('eine Suche: „Gerätesuche im Heimnetz · Sie · 38 s · nur gelesen" mit dem Ergebnis als Wort (d1)', () => {
    const z = sucheZeile(zeile(), 'Jonas Wendlinger');
    expect(z).toEqual({
      satz: 'Gerätesuche im Heimnetz',
      urteil: '1 neues Gerät',
      herkunft: 'Sie · 38 s · nur gelesen',
      ton: 'ruhig',
      laufend: false,
      roh: [{ label: 'Kennung der Suche', wert: SUCH_ID }],
    });
  });

  it('jemand anderes: der Name mit der Art der Unterstützung', () => {
    expect(sucheZeile(zeile({ urheber: SERVICE }), 'Jonas Wendlinger')?.herkunft)
      .toBe('Anna Weber (VoltPilot-Service) · 38 s · nur gelesen');
  });

  it('läuft: ohne Dauer, als laufend; ohne Zwischenstand nach 30 s: „nicht zu Ende gemeldet" in Bernstein', () => {
    const laeuft = sucheZeile(zeile({ endedAt: null, geraetesuche: block({ zustand: 'laeuft', dauerMs: null, zaehler: null }) }), null);
    expect(laeuft).toMatchObject({ urteil: 'läuft', laufend: true, ton: 'info', herkunft: 'Jonas Wendlinger · nur gelesen' });
    const still = sucheZeile(zeile({ endedAt: null, geraetesuche: block({ zustand: 'keine_antwort', dauerMs: null, zaehler: null }) }), null);
    expect(still).toMatchObject({ urteil: 'nicht zu Ende gemeldet', laufend: false, ton: 'warn' });
  });

  it('abgebrochen: wer den Abbruch ausgelöst hat, steht in den technischen Details', () => {
    const z = sucheZeile(zeile({ geraetesuche: block({ zustand: 'abgebrochen', grund: 'auf_wunsch', abgebrochenVon: SERVICE }) }), null);
    expect(z?.urteil).toBe('abgebrochen');
    expect(z?.roh[0]).toEqual({ label: 'Abbruch ausgelöst von', wert: 'Anna Weber (VoltPilot-Service)' });
  });

  it('fertig ohne Zähler: kein erfundenes „keine Energie-Geräte"', () => {
    expect(sucheZeile(zeile({ geraetesuche: block({ zaehler: null }) }), null)?.urteil).toBe('fertig');
  });

  it('eine Übernahme: „Gerät angelegt: Wechselrichter (aus der Gerätesuche)" mit Fund und Suchtag', () => {
    expect(sucheZeile(uebernahme(), 'Jonas Wendlinger')).toEqual({
      satz: 'Gerät angelegt: Wechselrichter (aus der Gerätesuche)',
      urteil: null,
      herkunft: 'Sie',
      ton: 'ok',
      laufend: false,
      roh: [{ label: 'Fund', wert: 'solarman:3115580613' }, { label: 'Gesucht am', wert: '30.10.2026' }],
    });
    expect(sucheZeile(uebernahme({ eventKind: 'adresse_uebernommen' }), null)?.satz)
      .toBe('Neue Adresse übernommen: Wechselrichter (aus der Gerätesuche)');
    expect(sucheZeile(uebernahme({ geraetesuche: block({ zustand: null, komponente: null }) }), null)?.satz)
      .toBe('Gerät angelegt (aus der Gerätesuche) · das Gerät ist inzwischen entfernt');
  });

  it('eine unbekannte Art oder ein fehlender Block behauptet nichts', () => {
    expect(sucheZeile(zeile({ eventKind: 'geraetesuche_neu' }), null)).toBeNull();
    expect(sucheZeile(zeile({ geraetesuche: null }), null)).toBeNull();
    expect(sucheZeile(zeile({ geraetesuche: block({ zustand: null }) }), null)).toBeNull();
  });

  it('im Verlauf: neueste zuerst, Strom „Einrichtung", die Suche nennt nur ihren Beginn', () => {
    const view = neuesteZuerst([history([zeile(), uebernahme()])], JETZT, { gefiltert: true, ich: 'Jonas Wendlinger' });
    const zeilen = view.eintraege.flatMap((e) => (e.art === 'zeile' ? [e.zeile] : []));
    expect(zeilen.map((z) => [z.zeit, z.satz, z.herkunft])).toEqual([
      ['09:14', 'Gerät angelegt: Wechselrichter (aus der Gerätesuche)', 'Sie'],
      ['09:12', 'Gerätesuche im Heimnetz', 'Sie · 38 s · nur gelesen'],
    ]);
    expect(zeilen.every((z) => z.strom === 'Einrichtung')).toBe(true);
    expect(new Set(zeilen.map((z) => z.id)).size).toBe(2);
  });

  it('eine laufende Suche: „ab 09:12"; ohne eigenen Namen steht der Name', () => {
    const laeuft = zeile({ endedAt: null, geraetesuche: block({ zustand: 'laeuft', dauerMs: null, zaehler: null }) });
    const [z] = film(history([laeuft]), JETZT, { datiert: false });
    expect(z.zeit).toBe('ab 09:12');
    expect(z.laufend).toBe(true);
    expect(z.herkunft).toBe('Jonas Wendlinger · nur gelesen');
  });
});
