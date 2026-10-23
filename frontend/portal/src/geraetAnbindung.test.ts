import { describe, expect, it } from 'vitest';
import type { Device, UemsDatenquelle } from './api';
import type { AufbauAnbindung, AufbauBaum, AufbauGeraet, AufbauWeg } from './aufbauBaum';
import {
  anbindungen,
  anbindungKurz,
  geraetImAufbau,
  kopfZustand,
  verlaufZeilen,
  type GeraetImAufbau,
} from './geraetAnbindung';

const NBSP = String.fromCharCode(160);

const halle1: Device = {
  id: 'box-1', siteId: 's-1', externalRef: 'edge-5mz8bdd', kind: 'inverter', name: null,
  status: 'active', lastSeenAt: null, createdAt: null,
};
const halle2: Device = { ...halle1, id: 'box-2', externalRef: 'edge-7hk2aaa', name: 'Halle 2' };

function quelle(o: Partial<UemsDatenquelle> = {}): UemsDatenquelle {
  return {
    id: 'dq-1', kennzeichen: 'DQ-1', name: 'Anlagensteuerung', anlage: 's-1', protokoll: 'modbus_tcp',
    adresse: '192.168.4.165:503', geraete_ids: [1], netz: null, mehrere_leser: false, steuerquelle: false,
    vergleichsquelle: false, kadenz_s: 5, archiviert_am: null,
    zustaendige_box: { id: 'box-1', name: 'edge-5mz8bdd', heimat_anlage: 's-1' }, zeitraeume: [],
    rueckmeldung: {
      zustand: 'liefert', fehlerklasse: null, seit: null, gelesen_am: '2026-10-23T09:42:00Z',
      anfragen_pro_minute: 12, messwerte_pro_minute: 305, gemeldet_am: '2026-10-23T09:42:05Z', text: 'Liefert Daten',
    },
    ...o,
  };
}

const anb = (q: UemsDatenquelle, o: Partial<AufbauAnbindung> = {}): AufbauAnbindung => ({
  quelleId: q.id, kennzeichen: q.kennzeichen, weg: 'Modbus TCP · 192.168.4.165:503',
  box: q.zustaendige_box ? { id: q.zustaendige_box.id, name: q.zustaendige_box.name } : null, stoerung: null, ...o,
});

function geraet(o: Partial<AufbauGeraet> = {}): AufbauGeraet {
  return {
    id: 'as-1', art: 'geraet', titel: 'Anlagensteuerung', anbindungText: null, gateway: null, anbindungen: [],
    karte: { komponenten: [{ entityId: 'as-1' }] }, ...o,
  } as unknown as AufbauGeraet;
}

const wert = (a: ReturnType<typeof anbindungen>[number], label: string) => a.zeilen.find((z) => z.label === label);

describe('GE-2 · der Abschnitt „Anbindung"', () => {
  it('1 : 1 — Weg, lesende Box mit Weg dorthin, Empfang, Last, Takt, Kennung klein und der Box-Wechsel', () => {
    const q = quelle();
    const [a, ...rest] = anbindungen({
      imAufbau: { geraet: geraet({ anbindungen: [anb(q)] }), gateway: null },
      datenquellen: [q], devices: [halle1], siteId: 's-1', gemeinsamZustand: null,
    });
    expect(rest).toEqual([]);
    expect(a.titel).toBe('Anbindung');
    expect(a.zeilen.map((z) => z.label)).toEqual(['Weg', 'Gelesen von', 'Empfang', 'Last an der Box', 'Lesetakt']);
    expect(wert(a, 'Weg')?.wert).toBe('Modbus TCP · 192.168.4.165:503 · Geräte-ID 1');
    expect(wert(a, 'Gelesen von')).toMatchObject({ wert: 'VoltPilot-Box edge-5mz8bdd', href: '#/anlage/s-1/box/edge-5mz8bdd' });
    expect(wert(a, 'Empfang')).toMatchObject({ wert: 'Liefert Daten', ton: 'ok' });
    expect(wert(a, 'Empfang')?.detail).toMatch(/^Zuletzt gelesen 23\.10\.2026/);
    // Dieselbe Rechnung wie Box-Seite und Box-Zeile (GE-4): max(12/30, 305/600), Prozent ohne Stelle.
    expect(wert(a, 'Last an der Box')).toMatchObject({
      wert: `51${NBSP}%`, detail: '12 von 30 Anfragen/min · 305 von 600 Messwerten/min',
    });
    expect(wert(a, 'Lesetakt')?.wert).toBe(`alle 5${NBSP}s`);
    expect(a.kennung).toBe('Kennung DQ-1');
    expect(a.wechsel).toEqual({ art: 'dialog' });
    expect(a.hinweis).toBeNull();
    expect(anbindungKurz([a])).toBe('Modbus TCP · 192.168.4.165:503 · Geräte-ID 1 · Liefert Daten');
  });

  it('liefert nicht: Fehlerklasse und Seit im Empfang, als Achtung', () => {
    const q = quelle({
      rueckmeldung: { ...quelle().rueckmeldung!, zustand: 'liefert_nicht', fehlerklasse: 'timeout', seit: '2026-10-23T08:00:00Z' },
    });
    const [a] = anbindungen({
      imAufbau: { geraet: geraet({ anbindungen: [anb(q)] }), gateway: null },
      datenquellen: [q], devices: [halle1], siteId: 's-1', gemeinsamZustand: null,
    });
    expect(wert(a, 'Empfang')).toMatchObject({ wert: 'Liefert keine Daten', ton: 'warn' });
    expect(wert(a, 'Empfang')?.detail).toMatch(/· Seit 23\.10\.2026/);
  });

  it('ohne zuständige Box: „Von keiner Box gelesen" — kein Empfang, keine Last', () => {
    const q = quelle({ zustaendige_box: null, rueckmeldung: null });
    const [a] = anbindungen({
      imAufbau: { geraet: geraet({ anbindungen: [anb(q)] }), gateway: null },
      datenquellen: [q], devices: [halle1], siteId: 's-1', gemeinsamZustand: null,
    });
    expect(a.zeilen.map((z) => z.label)).toEqual(['Weg', 'Gelesen von', 'Lesetakt']);
    expect(wert(a, 'Gelesen von')).toMatchObject({ wert: 'Von keiner Box gelesen', href: null, ton: 'off' });
  });

  it('eine laufende Übergabe steht sichtbar da: wohin, seit wann, woher', () => {
    const q = quelle({
      uebergabe: {
        zustand: 'Übergabe ausstehend', seit: '2026-10-23T10:05:00Z',
        box_alt: { id: 'box-1', name: 'edge-5mz8bdd', heimat_anlage: 's-1' },
        box_neu: { id: 'box-2', name: 'Halle 2', heimat_anlage: 's-1' },
      },
    });
    const [a] = anbindungen({
      imAufbau: { geraet: geraet({ anbindungen: [anb(q)] }), gateway: null },
      datenquellen: [q], devices: [halle1, halle2], siteId: 's-1', gemeinsamZustand: null,
    });
    const u = wert(a, 'Übergabe');
    expect(u).toMatchObject({ wert: 'Wechselt zu VoltPilot-Box Halle 2', ton: 'warn' });
    expect(u?.detail).toMatch(/^seit 23\.10\.2026, \d\d:05 · bisher VoltPilot-Box edge-5mz8bdd$/);
  });

  it('hinter einem Gateway: „Gelesen über Gateway DQ-3 (4 Geräte)", eigene Geräte-ID; Box-Wechsel und Last am Gateway', () => {
    const q = quelle({ id: 'dq-3', kennzeichen: 'DQ-3', name: 'Zählergateway', adresse: '192.168.10.31:502', geraete_ids: [1, 2, 3, 4] });
    const gw = { id: 'dq-3', geraete: [{}, {}, {}, {}] } as unknown as AufbauWeg;
    const [a] = anbindungen({
      imAufbau: {
        geraet: geraet({ anbindungen: [anb(q)], anbindungText: 'Geräte-ID 2', gateway: { id: 'dq-3', titel: 'Zählergateway' } }),
        gateway: gw,
      },
      datenquellen: [q], devices: [halle1], siteId: 's-1', gemeinsamZustand: null,
    });
    expect(wert(a, 'Weg')?.wert).toBe('Modbus TCP · 192.168.10.31:502 · Geräte-ID 2');
    // GE-5: der Weg führt auf die Seite des Gateways — über die Box, die es liest.
    expect(wert(a, 'Gelesen über')).toMatchObject({ wert: 'Gateway DQ-3 (4 Geräte)', href: '#/anlage/s-1/geraet/edge-5mz8bdd/dq-3' });
    expect(wert(a, 'Last an der Box')).toBeUndefined();
    expect(a.wechsel).toBeNull();
    expect(a.hinweis).toBe('Box und Last gelten für alle 4 Geräte an diesem Gateway — ein Wechsel der Box nimmt alle mit.');
  });

  it('eine Steuerquelle wechselt nach der Weiche der Box-Seite (AP-15 T6)', () => {
    const q = quelle({ steuerquelle: true });
    const angebot = (gemeinsamZustand: string | null) => anbindungen({
      imAufbau: { geraet: geraet({ anbindungen: [anb(q)] }), gateway: null },
      datenquellen: [q], devices: [halle1], siteId: 's-1', gemeinsamZustand,
    })[0].wechsel;
    expect(angebot(null)).toMatchObject({ art: 'satz' });
    expect(angebot('beobachtet')).toEqual({ art: 'dialog' });
    expect(angebot('anteile_aktiv')).toMatchObject({ art: 'gemeinsam', href: '#/anlage/s-1/technik?abschnitt=gemeinsam' });
  });

  it('ohne bekannten Weg kein Abschnitt — und eine unbekannte Quelle wird nicht geraten', () => {
    const q = quelle();
    expect(anbindungen({ imAufbau: null, datenquellen: [q], devices: [], siteId: 's-1', gemeinsamZustand: null })).toEqual([]);
    expect(anbindungen({
      imAufbau: { geraet: geraet({ anbindungen: [] }), gateway: null },
      datenquellen: [q], devices: [], siteId: 's-1', gemeinsamZustand: null,
    })).toEqual([]);
    expect(anbindungen({
      imAufbau: { geraet: geraet({ anbindungen: [anb(q)] }), gateway: null },
      datenquellen: [], devices: [], siteId: 's-1', gemeinsamZustand: null,
    })).toEqual([]);
  });

  it('zwei Wege: der zweite heißt „Weitere Anbindung"', () => {
    const q1 = quelle();
    const q2 = quelle({ id: 'dq-2', kennzeichen: 'DQ-2' });
    const a = anbindungen({
      imAufbau: { geraet: geraet({ anbindungen: [anb(q1), anb(q2)] }), gateway: null },
      datenquellen: [q1, q2], devices: [halle1], siteId: 's-1', gemeinsamZustand: null,
    });
    expect(a.map((x) => [x.titel, x.kennung])).toEqual([['Anbindung', 'Kennung DQ-1'], ['Weitere Anbindung', 'Kennung DQ-2']]);
  });
});

describe('GE-2 · ein Zustand im Kopf', () => {
  const eigen = { wort: 'liefert Daten', ton: 'ok' as const, detail: 'vor 5 Sek.' };

  it('eine gemeldete Störung des Wegs gewinnt, mit Grund (Regel der Aufbau-Zeile)', () => {
    const imAufbau: GeraetImAufbau = {
      geraet: geraet({ anbindungen: [anb(quelle(), { stoerung: { wort: 'Liefert keine Daten', grund: 'Zeitüberschreitung · Seit 23.10.2026, 10:00' } })] }),
      gateway: null,
    };
    expect(kopfZustand(eigen, imAufbau)).toEqual({
      wort: 'Liefert keine Daten', ton: 'warn', detail: 'Zeitüberschreitung · Seit 23.10.2026, 10:00',
    });
  });

  it('ohne Störung — auch bei „Box meldet noch nicht je Quelle" — bleibt der eigene Zustand', () => {
    expect(kopfZustand(eigen, { geraet: geraet({ anbindungen: [anb(quelle())] }), gateway: null })).toBe(eigen);
    expect(kopfZustand(eigen, null)).toBe(eigen);
  });
});

describe('GE-2 · das Gerät der Seite im Aufbau', () => {
  const g = geraet({ id: 'z-1', karte: { komponenten: [{ entityId: 'zaehler' }] } as AufbauGeraet['karte'], gateway: { id: 'dq-3', titel: 'Gateway' } });
  const gw = { id: 'dq-3', geraete: [g] } as unknown as AufbauWeg;
  const baum = {
    wurzel: null, boxZahl: 1,
    anlagen: [
      { id: 's-1', aktuell: true, boxen: [{ geraete: [g], wege: [gw] }], ohneBox: [], wegeOhneBox: [] },
      { id: 's-2', aktuell: false, boxen: [{ geraete: [geraet()], wege: [] }], ohneBox: [], wegeOhneBox: [] },
    ],
  } as unknown as AufbauBaum;

  it('findet es über die Komponenten der Seite, samt seinem Gateway', () => {
    expect(geraetImAufbau(baum, ['zaehler'])).toEqual({ geraet: g, gateway: gw });
  });

  it('sucht nur in der geöffneten Anlage und rät nie', () => {
    expect(geraetImAufbau(baum, ['as-1'])).toBeNull();
    expect(geraetImAufbau(baum, [])).toBeNull();
    expect(geraetImAufbau(null, ['zaehler'])).toBeNull();
  });
});

describe('GE-2 · Verlauf der Anbindung', () => {
  it('spricht den Satz des Servers, nennt Box und Urheber; ohne Satz steht der Code', () => {
    const zeilen = verlaufZeilen([
      {
        id: 7, art: 'zustaendigkeit_gewechselt', text: 'Zuständigkeit gewechselt',
        box: { id: 'box-2', name: 'Halle 2', heimat_anlage: 's-1' }, ergebnis: null,
        gilt_ab: '2026-10-23T10:05:00Z', urheber: { name: 'Ines Kaltenbach', rolle: 'kundenadministrator', art: 'kunde' },
        zeitpunkt: '2026-10-23T10:04:10Z',
      },
      {
        id: 6, art: 'neu_im_vokabular', box: null, ergebnis: null, gilt_ab: '2026-10-22T08:00:00Z',
        urheber: { name: 'VoltPilot', rolle: null, art: 'voltpilot' }, zeitpunkt: '2026-10-22T08:00:00Z',
      },
    ], [halle1, halle2]);
    expect(zeilen[0]).toMatchObject({ id: '7', text: 'Zuständigkeit gewechselt', detail: 'VoltPilot-Box Halle 2 · Ines Kaltenbach' });
    expect(zeilen[0].zeit).toMatch(/^23\.10\.2026, \d\d:05$/);
    expect(zeilen[1]).toMatchObject({ text: 'neu_im_vokabular', detail: 'VoltPilot' });
  });
});
