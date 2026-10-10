import { describe, expect, it } from 'vitest';
import type { UemsDatenquelleVorschlag, UemsDatenquelleVorschlagsliste } from './api';
import * as dq from './datenquelleVorschlag';
import {
  dqAusgelassen,
  dqErgebnisSatz,
  dqHinzufuegenAnfrage,
  dqUebernehmenAnfrage,
  dqZeilen,
  istDqGeaendert,
  komponentenName,
} from './datenquelleVorschlag';

// Die Formen sind die der echten Antwort (PortalwegMesskundeAbnahmeTest, Anlage E-1/E-2 der Dauerläufer-Vorlage).
const BOX1 = { id: 'b1', name: 'dauerlaeufer-e1', heimat_anlage: 'an1' };
const BOX2 = { id: 'b2', name: 'dauerlaeufer-e2', heimat_anlage: 'an2' };

function vorschlag(teil: Partial<UemsDatenquelleVorschlag>): UemsDatenquelleVorschlag {
  return {
    kennzeichen: 'DQ-2', box: BOX1, protokoll: 'modbus_tcp', adresse: '10.99.1.10:502', geraete_ids: [1],
    kadenz_s: null, steuerquelle: false, ab: '2026-09-21T09:21:00Z',
    komponenten: [{ id: 'k5', name: 'MS-05', art: 'modbus-generic' }, { id: 'k6', name: 'MS-06', art: 'modbus-generic' }],
    grund: null, text: 'Ab 21.09.2026 11:21 liest dauerlaeufer-e1', ziel: null, ...teil,
  };
}

const HALLE2 = vorschlag({
  kennzeichen: 'DQ-3', box: BOX2, adresse: '10.99.2.10:502', komponenten: [{ id: 'k10', name: 'MS-10', art: 'modbus-generic' }],
  grund: 'adresse_an_box_vergeben', text: 'Diese Adresse liest dauerlaeufer-e2 bereits als DQ-1 — Gerät dort hinzufügen?',
  ziel: { id: 'dq1', kennzeichen: 'DQ-1', name: 'Gateway Halle 2' },
});

const liste = (vorschlaege: UemsDatenquelleVorschlag[]): UemsDatenquelleVorschlagsliste => ({
  fuehrende_box: BOX1, fuehrung: 'einzige', vorschlaege,
  ausgelassen: [
    { komponente: { id: 'g', name: null, art: 'grid-meter' }, grund: 'keine_adresse', protokoll: null, anker: null,
      text: 'Für diese Komponente kennt VoltPilot keine eindeutige Adresse, unter der eine Box sie liest — sie bekommt keine Datenquelle' },
    { komponente: { id: 'h', name: null, art: 'house-load' }, grund: 'keine_adresse', protokoll: null, anker: null, text: '…' },
  ],
});

describe('Datenquellen-Vorschlag · Zeilen in Kundensprache', () => {
  it('Box · Protokoll · Adresse, dahinter die Geräte, der Satz des Servers', () => {
    const [z] = dqZeilen(liste([vorschlag({})]));
    expect(z.kopf).toBe('dauerlaeufer-e1 · Modbus TCP · 10.99.1.10:502 (Geräte-ID 1)');
    expect(z.geraete).toBe('MS-05, MS-06');
    expect(z.satz).toBe('Ab 21.09.2026 11:21 liest dauerlaeufer-e1');
    expect(z.art).toBe('frei');
  });

  it('gesperrt mit Ziel → „hinzufügen“; ohne Ziel → gesperrt, ohne Weg', () => {
    const [hin, zu] = dqZeilen(liste([HALLE2, vorschlag({ grund: 'adresse_an_box_vergeben', ziel: null })]));
    expect(hin.art).toBe('hinzufuegen');
    expect(hin.ziel).toBe('DQ-1');
    expect(dq.dqHinzufuegenWort(hin.ziel!)).toBe('Zu DQ-1 hinzufügen');
    expect(zu.art).toBe('gesperrt');
    expect(zu.ziel).toBeNull();
  });

  it('eine Komponente ohne Namen heißt nach ihrer Art, nie nach dem Code', () => {
    expect(komponentenName({ id: 'x', name: null, art: 'grid-meter' })).toBe('Netzanschlusszähler');
    expect(komponentenName({ id: 'x', name: '  ', art: 'house-load' })).toBe('Hausverbrauch');
    expect(komponentenName({ id: 'x', name: null, art: 'unbekannt' })).toBe('Gerät ohne Namen');
  });

  it('ausgelassen: ein Satz je Komponente, mit ihrem Namen', () => {
    const a = dqAusgelassen(liste([]));
    expect(a.map((x) => x.satz.split(':')[0])).toEqual(['Netzanschlusszähler', 'Hausverbrauch']);
  });
});

describe('Datenquellen-Vorschlag · Bestätigung so, wie die Liste sie zeigt', () => {
  it('„Übernehmen“ nimmt genau die freien Zeilen — Box, Weg, Komponenten, kein Ziel', () => {
    expect(dqUebernehmenAnfrage(liste([vorschlag({}), HALLE2]))).toEqual([
      { device_id: 'b1', protokoll: 'modbus_tcp', adresse: '10.99.1.10:502', komponenten: ['k5', 'k6'] },
    ]);
  });

  it('ohne freie Zeile keine Anfrage — der Knopf erscheint nicht (der Server antwortet leer mit 400)', () => {
    expect(dqUebernehmenAnfrage(liste([]))).toEqual([]);
    expect(dqUebernehmenAnfrage(liste([HALLE2]))).toEqual([]);
  });

  it('„Zu DQ-1 hinzufügen“ nennt das Ziel als datenquelle_id', () => {
    expect(dqHinzufuegenAnfrage(HALLE2)).toEqual([
      { device_id: 'b2', protokoll: 'modbus_tcp', adresse: '10.99.2.10:502', komponenten: ['k10'], datenquelle_id: 'dq1' },
    ]);
    expect(dqHinzufuegenAnfrage(vorschlag({ grund: 'adresse_an_box_vergeben' }))).toEqual([]);
  });

  it('409 vorschlag_geaendert / komponente_hat_quelle lädt neu, andere Fehler nicht', () => {
    expect(istDqGeaendert({ status: 409, body: { code: 'vorschlag_geaendert' } })).toBe(true);
    expect(istDqGeaendert({ status: 409, body: { code: 'komponente_hat_quelle' } })).toBe(true);
    expect(istDqGeaendert({ status: 409, body: { code: 'adresse_an_box_vergeben' } })).toBe(false);
    expect(istDqGeaendert({ status: 400, body: { code: 'vorschlag_geaendert' } })).toBe(false);
    expect(istDqGeaendert(null)).toBe(false);
  });

  it('das Ergebnis in einem Satz', () => {
    const q = (kennzeichen: string) => ({ kennzeichen }) as never;
    expect(dqErgebnisSatz({ neu: 1, unveraendert: 0, angehaengt: 0, datenquellen: [q('DQ-2')] })).toBe('Datenquelle DQ-2 angelegt.');
    expect(dqErgebnisSatz({ neu: 0, unveraendert: 0, angehaengt: 1, datenquellen: [q('DQ-1')] })).toBe('Die Geräte gehören jetzt zu DQ-1.');
    expect(dqErgebnisSatz({ neu: 0, unveraendert: 1, datenquellen: [q('DQ-2')] })).toBe('Schon übernommen: DQ-2.');
  });
});

describe('Datenquellen-Vorschlag · Messwelt-Sprache', () => {
  it('kein Wort über Steuern oder Geld', () => {
    const texte = Object.entries(dq).filter(([k, v]) => k.startsWith('DQ_') && typeof v === 'string').map(([, v]) => v as string);
    expect(texte.length).toBeGreaterThan(5);
    for (const t of texte) expect(t).not.toMatch(/steuer|€|erlös|geld|kosten/i);
  });
});
