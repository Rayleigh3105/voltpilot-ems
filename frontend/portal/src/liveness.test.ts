import { describe, expect, it } from 'vitest';
import { deviceHealthForSite, livenessReference, snapshotAgeMs } from './liveness';
import { healthBadge } from './health';
import type { Device } from './api';

const SITE = 'site-1';

function device(lastSeenAt: string | null, id = 'dev-1'): Device {
  return {
    id,
    siteId: SITE,
    externalRef: 'VP-DEMO-0001',
    kind: 'inverter',
    name: null,
    status: 'active',
    lastSeenAt,
    createdAt: '2026-07-30T08:00:00Z',
  };
}

/** Der Kopfzeilen-Satz, den der Kunde wirklich liest. */
function badgeFor(devices: Device[], fetchedAt: number | null, now: number) {
  return healthBadge({ devices: deviceHealthForSite({ devices, fetchedAt }, SITE, now) });
}

const T0 = Date.parse('2026-07-30T10:00:00Z');
const MIN = 60_000;

describe('livenessReference', () => {
  it('ist die Antwortzeit des Servers, nicht die Wanduhr', () => {
    expect(livenessReference(T0, T0 + 12 * MIN)).toBe(T0);
  });

  it('bleibt ohne je geladene Liste unbekannt', () => {
    expect(livenessReference(null, T0)).toBeNull();
    expect(snapshotAgeMs(null, T0)).toBeNull();
  });

  it('klemmt eine verstellte Uhr, statt eine Antwort aus der Zukunft zu erlauben', () => {
    // Ein zurückgestellter Client-Timer darf `lastSeenAt` nicht künstlich
    // verjüngen - der Bezug ist höchstens „jetzt".
    expect(livenessReference(T0 + 5 * MIN, T0)).toBe(T0);
    expect(snapshotAgeMs(T0 + 5 * MIN, T0)).toBe(0);
  });
});

describe('deviceHealthForSite', () => {
  it('zählt nur die Geräte der Anlage', () => {
    const fremd: Device = { ...device(new Date(T0).toISOString(), 'dev-2'), siteId: 'site-2' };
    const counts = deviceHealthForSite(
      { devices: [device(new Date(T0).toISOString()), fremd], fetchedAt: T0 },
      SITE,
      T0,
    );
    expect(counts).toEqual({ deviceCount: 1, onlineCount: 1, waitingCount: 0 });
  });

  it('meldet „noch nichts gemessen" statt Gesundheit, solange nie geladen wurde', () => {
    expect(deviceHealthForSite({ devices: [device(null)], fetchedAt: null }, SITE, T0)).toBeNull();
    // Und die Kopfzeile behauptet dann WEDER Gesundheit NOCH Störung: die
    // Geräte-Zeile fehlt schlicht (die „ein fehlender Fakt trägt nichts bei"-
    // Disziplin von `healthBadge`).
    expect(badgeFor([device(null)], null, T0).findings).toEqual([]);
  });

  it('eine Anlage ganz ohne Gerät bleibt „noch nicht verbunden"', () => {
    expect(deviceHealthForSite({ devices: [], fetchedAt: T0 }, SITE, T0)).toEqual({
      deviceCount: 0,
      onlineCount: 0,
      waitingCount: 0,
    });
    expect(badgeFor([], T0, T0).detail).toBe('Gerät: noch nicht verbunden');
  });
});

describe('Reproduktion: der Banner kippt nicht mehr über einem stehenden Schnappschuss', () => {
  it('gealterte Zeitstempel bei GEDROSSELTEM Poll ⇒ KEINE falsche Warnung', () => {
    const seen = new Date(T0).toISOString();
    const devices = [device(seen)];

    // Frisch geladen: alles in Ordnung.
    expect(badgeFor(devices, T0, T0).label).toBe('Alles in Ordnung');

    // Der Tab liegt im Hintergrund, der Browser drosselt den Takt: die Uhr
    // läuft 12 Minuten weiter, die Liste wurde NICHT erneuert. Genau hier
    // stand vorher „Warnung · Gerät: meldet sich nicht" - obwohl der Server
    // nie etwas dergleichen gemeldet hatte.
    for (const minutes of [6, 12, 45, 180]) {
      const badge = badgeFor(devices, T0, T0 + minutes * MIN);
      expect(badge.state).toBe('ok');
      expect(badge.label).toBe('Alles in Ordnung');
      expect(badge.findings).toEqual([]);
    }
  });

  it('jede frische Antwort aktualisiert Zustand UND Bezugszeit', () => {
    // Nach 12 Minuten kommt der Poll durch: neue Daten, neuer Bezug.
    const now = T0 + 12 * MIN;
    const badge = badgeFor([device(new Date(now).toISOString())], now, now);
    expect(badge.label).toBe('Alles in Ordnung');
  });

  it('ein einzelner fehlgeschlagener Poll kippt den Banner NICHT', () => {
    // Ein Fehlschlag lässt Daten und Bezugszeit unberührt - der abgeleitete
    // Zustand ist damit zeichengleich zu dem vor dem Versuch.
    const devices = [device(new Date(T0).toISOString())];
    const vorher = badgeFor(devices, T0, T0 + 30_000);
    const nachher = badgeFor(devices, T0, T0 + 90_000); // zwei Versuche später
    expect(nachher).toEqual(vorher);
    expect(nachher.state).toBe('ok');
  });

  it('die Warnung erscheint, wenn der SERVER das Gerät wirklich als still meldet', () => {
    // Der Poll läuft (Bezugszeit rückt vor), aber `lastSeenAt` bleibt stehen:
    // JETZT ist die Stille eine Server-Aussage, keine Client-Alterung.
    const stillSeit = new Date(T0).toISOString();

    // Innerhalb des 5-Minuten-Fensters noch ruhig.
    expect(badgeFor([device(stillSeit)], T0 + 4 * MIN, T0 + 4 * MIN).state).toBe('ok');

    const badge = badgeFor([device(stillSeit)], T0 + 20 * MIN, T0 + 20 * MIN);
    expect(badge.state).toBe('warnung');
    expect(badge.detail).toBe('Gerät: meldet sich nicht');
  });

  it('eine bereits gemeldete Stille verschwindet nicht heimlich, wenn der Poll ausfällt', () => {
    // Gegenprobe zur Einfrier-Regel: der eingefrorene Zustand ist der zuletzt
    // BESTÄTIGTE - eine echte Warnung bleibt stehen, sie wird nicht weggeblendet.
    const stillSeit = new Date(T0).toISOString();
    const bestaetigt = T0 + 20 * MIN;
    for (const minutes of [21, 60, 240]) {
      const badge = badgeFor([device(stillSeit)], bestaetigt, T0 + minutes * MIN);
      expect(badge.state).toBe('warnung');
      expect(badge.detail).toBe('Gerät: meldet sich nicht');
    }
  });

  it('ein Gerät ohne erste Daten bleibt „wartet", nie „meldet sich nicht"', () => {
    const badge = badgeFor([device(null)], T0, T0 + 60 * MIN);
    expect(badge.detail).toBe('Gerät: wartet auf erste Daten');
  });
});
