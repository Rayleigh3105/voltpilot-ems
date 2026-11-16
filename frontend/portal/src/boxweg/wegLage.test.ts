import { describe, expect, it } from 'vitest';
import type { BoxSoftwareUpdate, Device } from '../api';
import {
  DATENSPERRE_MS, SOFTWARE_OBERGRENZE_MS, UMSCHALT_LAENGER_MS, UMSCHALT_PRUEFEN_MS, UMSCHALT_SUPPORT_MS,
  UPDATE_UNGEFRAGT, wegLage,
} from './wegLage';

const T0 = new Date('2026-11-10T12:00:00Z');

function box(partial: Partial<Device> = {}): Device {
  return {
    id: 'd1',
    siteId: 's1',
    externalRef: 'edge-k7m2xq3',
    kind: 'inverter',
    name: null,
    status: 'claimed',
    lastSeenAt: null,
    createdAt: T0.toISOString(),
    anmeldung: null,
    ...partial,
  };
}

function nach(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

describe('wegLage · die Szenarien aus Bericht Abschnitt 4.3/5', () => {
  it('Normal: Box startet, Chip läuft, noch kein Signal', () => {
    const lage = wegLage(box(), nach(30_000));
    expect(lage.aktiv).toBe('startet');
    expect(lage.stationen.eingesteckt).toBe('dashed');
    expect(lage.stationen.startet).toBe('active');
    expect(lage.hinweis).toBe('keiner');
    expect(lage.chipText).toBe('Startet · 0:30');
  });

  it('Anmeldung da: "Eingesteckt" gilt rückwirkend als geschehen, Station Anmeldung ist done', () => {
    const lage = wegLage(box({ anmeldung: { zuletztAngefragtAm: nach(20_000).toISOString(), schluesselAbgeholtAm: null } }), nach(25_000));
    expect(lage.stationen.eingesteckt).toBe('done');
    expect(lage.stationen.startet).toBe('done');
    expect(lage.stationen.anmeldung).toBe('done');
    expect(lage.stationen.datenverbindung).toBe('active');
    expect(lage.aktiv).toBe('datenverbindung');
    expect(lage.titel).toBe('Ihre Box ist im Internet');
    expect(lage.liefSchon).toBe(false);
  });

  it('Box steckte schon (liefSchon): Anmeldung vor dem Claim', () => {
    const lage = wegLage(
      box({ createdAt: T0.toISOString(), anmeldung: { zuletztAngefragtAm: new Date(T0.getTime() - 60_000).toISOString(), schluesselAbgeholtAm: null } }),
      nach(5_000),
    );
    expect(lage.liefSchon).toBe(true);
    expect(lage.satz).toContain('1½ Minuten');
  });

  it('Langsam aber normal: ab 3:00 ohne Signal', () => {
    const lage = wegLage(box(), nach(UMSCHALT_LAENGER_MS + 1000));
    expect(lage.hinweis).toBe('laenger');
    expect(lage.stationen.startet).toBe('active');
  });

  it('Bitte prüfen: ab 5:00 ohne Signal, Station wird zum Problem', () => {
    const lage = wegLage(box(), nach(UMSCHALT_PRUEFEN_MS + 1000));
    expect(lage.hinweis).toBe('pruefen');
    expect(lage.stationen.startet).toBe('problem');
  });

  it('Support: ab 15:00 ohne Signal', () => {
    const lage = wegLage(box(), nach(UMSCHALT_SUPPORT_MS + 1000));
    expect(lage.hinweis).toBe('support');
  });

  it('Datenverbindung gesperrt: Anmeldung da, 75s später noch kein Herzschlag', () => {
    const lage = wegLage(
      box({ anmeldung: { zuletztAngefragtAm: nach(10_000).toISOString(), schluesselAbgeholtAm: nach(10_050).toISOString() } }),
      nach(10_000 + DATENSPERRE_MS + 1000),
    );
    expect(lage.hinweis).toBe('datensperre');
    expect(lage.stationen.datenverbindung).toBe('problem');
    expect(lage.titel).toBe('Die Datenverbindung kommt nicht durch');
  });

  it('Online: erster Herzschlag da, egal wie lange es dauerte', () => {
    const lage = wegLage(
      box({ anmeldung: { zuletztAngefragtAm: nach(5_000).toISOString(), schluesselAbgeholtAm: nach(5_000).toISOString() }, lastSeenAt: nach(20_000).toISOString() }),
      nach(21_000),
    );
    expect(lage.online).toBe(true);
    expect(lage.aktiv).toBe('anlage');
    expect(Object.values(lage.stationen).every((s) => s === 'done' || s === 'active')).toBe(true);
    expect(lage.titel).toBe('Ihre Box ist online');
  });

  it('Box war online und schweigt: kein neuer Herzschlag seit über 5 Minuten', () => {
    const lage = wegLage(box({ lastSeenAt: new Date(T0.getTime() + 60_000).toISOString() }), nach(60_000 + 6 * 60_000));
    expect(lage.online).toBe(false);
    expect(lage.stale).toBe(true);
    expect(lage.titel).toContain('meldet sich gerade nicht');
  });

  it('ohne createdAt bricht die Lage nicht (Chip bei 0:00)', () => {
    const lage = wegLage(box({ createdAt: null }), nach(5000));
    expect(lage.chipText).toBe('Startet · 0:00');
  });
});

describe('wegLage · Konzept vp-edge-light-wlan-s5 (E1=B): Verbindung und der Weg zurück', () => {
  it('Online per WLAN mit gutem Empfang trägt die Verbindung, ohne Einrichtungs-Hinweis', () => {
    const lage = wegLage(box({ lastSeenAt: nach(10_000).toISOString(), linkKind: 'wlan', signalDbm: -55 }), nach(10_000));
    expect(lage.verbindung).toEqual({ art: 'wlan', schwach: false });
    expect(lage.einrichtungshinweis).toBeNull();
  });

  it('Noch nie online: keine Verbindung behauptet, egal was später gemeldet würde', () => {
    const lage = wegLage(box(), nach(30_000));
    expect(lage.verbindung.art).toBeNull();
    expect(lage.einrichtungshinweis).toBeNull();
  });

  it('Still, zuletzt per WLAN da: der Weg über das Einrichtungs-WLAN wird genannt', () => {
    const lage = wegLage(box({ lastSeenAt: new Date(T0.getTime() + 60_000).toISOString(), linkKind: 'wlan' }), nach(60_000 + 6 * 60_000));
    expect(lage.stale).toBe(true);
    expect(lage.einrichtungshinweis).toMatch(/VoltPilot-Einrichtung/);
  });

  it('Still, zuletzt per Kabel da: kein WLAN-Hinweis (es gibt kein Einrichtungs-WLAN zu nennen)', () => {
    const lage = wegLage(box({ lastSeenAt: new Date(T0.getTime() + 60_000).toISOString(), linkKind: 'kabel' }), nach(60_000 + 6 * 60_000));
    expect(lage.stale).toBe(true);
    expect(lage.einrichtungshinweis).toBeNull();
  });
});

describe('wegLage · Station „Software“ (Erstverbindung S2, E4 = B: der Weg wartet)', () => {
  const online = () => box({ lastSeenAt: nach(170_000).toISOString() });
  const jetzt = nach(180_000);
  const update = (over: Partial<BoxSoftwareUpdate>): BoxSoftwareUpdate => ({
    phase: 'laedt', release: 'edge-light-2026.11.13', seit: nach(120_000).toISOString(), fertigAm: null,
    updateLaeuft: true, ...over,
  });

  it('kein Update fällig: sofort erledigt, Weiter wie heute', () => {
    const lage = wegLage(online(), jetzt, update({ phase: 'keins', release: null, seit: null }));
    expect(lage.stationen.software).toBe('done');
    expect(lage.aktiv).toBe('anlage');
    expect(lage.titel).toBe('Ihre Box ist online');
    expect(lage.weiterFrei).toBe(true);
    expect(wegLage(online(), jetzt, null).weiterFrei, 'älteres Backend hält niemanden fest').toBe(true);
  });

  it('noch nicht gefragt oder die Automatik entscheidet noch: warten, kein Weiter', () => {
    for (const u of [UPDATE_UNGEFRAGT, update({ phase: 'prueft', release: null })]) {
      const lage = wegLage(online(), jetzt, u);
      expect(lage.aktiv).toBe('software');
      expect(lage.stationen.anlage).toBe('dashed');
      expect(lage.titel).toBe('Ihre Box sucht nach neuer Software');
      expect(lage.weiterFrei).toBe(false);
    }
  });

  it('Update läuft: Fortschritt mit Restzeit, Satz zum Neustart, kein Weiter - auch still im Neustart', () => {
    const lage = wegLage(online(), jetzt, update({}));
    expect(lage.aktiv).toBe('software');
    expect(lage.stationen.software).toBe('active');
    expect(lage.titel).toBe('Ihre Box holt die neueste Software');
    expect(lage.satz).toBe('Bitte kurz warten. Ihre Box startet dabei einmal neu.');
    expect(lage.chipText).toBe('Software · 1:00');
    expect(lage.software).toEqual({ stand: 'laeuft', schritt: 'laden', anteil: 1 / 3, restText: 'noch etwa 2 Min.' });
    expect(lage.weiterFrei).toBe(false);

    const still = wegLage(box({ lastSeenAt: nach(60_000).toISOString() }), nach(500_000), update({ phase: 'startet_neu' }));
    expect(still.online).toBe(false);
    expect(still.aktiv).toBe('software');
    expect(still.software?.schritt).toBe('neustart');
    expect(still.software?.anteil).toBe(0.75);
    expect(still.software?.restText).toBe('noch etwa 1 Min.');
    expect(wegLage(online(), jetzt, update({ phase: 'prueft_box' })).software?.anteil).toBe(0.75);
  });

  it('fertig: auf dem neuesten Stand, Weiter erscheint', () => {
    const lage = wegLage(online(), jetzt, update({ phase: 'fertig', fertigAm: jetzt.toISOString(), updateLaeuft: false }));
    expect(lage.stationen.software).toBe('done');
    expect(lage.titel).toBe('Ihre Box ist auf dem neuesten Stand');
    expect(lage.weiterFrei).toBe(true);
  });

  it('zurückgenommen oder nicht zugewiesen: „kommt später“, ruhiger Satz, Weiter erscheint', () => {
    const lage = wegLage(online(), jetzt, update({ phase: 'spaeter', updateLaeuft: false }));
    expect(lage.stationen.software).toBe('spaeter');
    expect(lage.titel).toBe('Ihre Box ist online');
    expect(lage.satz).toBe('Die neue Software kommt später. Darum kümmern wir uns.');
    expect(lage.weiterFrei).toBe(true);
  });

  it('Obergrenze 12 Minuten: läuft im Hintergrund weiter, Weiter erscheint', () => {
    const spaet = nach(120_000 + SOFTWARE_OBERGRENZE_MS);
    const lage = wegLage(box({ lastSeenAt: spaet.toISOString() }), spaet, update({ phase: 'startet_neu' }));
    expect(lage.software?.stand).toBe('laenger');
    expect(lage.titel).toBe('Das dauert länger als üblich');
    expect(lage.weiterFrei).toBe(true);
  });
});
