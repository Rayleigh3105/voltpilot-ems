import { describe, expect, it } from 'vitest';
import type { ComponentTemplate, UemsDatenquelle, UemsDatenquelleVorschlagsliste } from './api';
import { aufbauDerAnlage, boxGeraeteBlock, type AnlageDaten } from './boxGeraete';
import { gatewayGeraetId, gatewayKennzeichenOf, gatewaySeiteHash } from './geraetAdresse';
import {
  freieGeraeteId,
  gatewayAnhaengen,
  gatewayAnhaengenSatz,
  gatewaySeite,
  gatewayVorbelegung,
  type GatewaySeiteEingabe,
} from './gatewaySeite';
import { initialeVerbindung } from './komponentenAssistent';
import { aufbauHash, ohneAufbauNeu, parseAufbauAn, parseRoute } from './nav';
import { gatewayForm, HS_SITE, hsBox } from './test/boxGeraeteFixtures';

const JETZT = Date.parse('2026-10-23T11:42:00Z');

function seite(d: AnlageDaten, kennzeichen: string, over: Partial<GatewaySeiteEingabe> = {}) {
  return gatewaySeite({
    siteId: d.siteId,
    ref: 'VP-HS-0001',
    kennzeichen,
    anlage: aufbauDerAnlage(d),
    datenquellen: d.datenquellen ?? [],
    zuordnung: d.uemsGeraete != null,
    devices: d.devices,
    gemeinsamZustand: null,
    ...over,
  });
}

const zeile = (z: { label: string }[], label: string) => z.find((x) => x.label === label) as
  { label: string; wert: string; href: string | null; ton: string | null } | undefined;

describe('GE-5 · Adresse der Gateway-Seite', () => {
  it('dq-<n> aus dem Kennzeichen, hin und zurück; nur Ziffern gelten', () => {
    expect(gatewayGeraetId('DQ-3')).toBe('dq-3');
    expect(gatewayKennzeichenOf('dq-3')).toBe('DQ-3');
    expect(gatewayKennzeichenOf('dq-12')).toBe('DQ-12');
    // Eine Entität, die zufällig mit „dq-" beginnt, bleibt ein Gerät.
    expect(gatewayKennzeichenOf('dq-zaehler')).toBeNull();
    expect(gatewayKennzeichenOf('as-anlagensteuerung')).toBeNull();
    expect(gatewayKennzeichenOf(null)).toBeNull();
  });

  it('der Parser liest die Adresse als Gerät hinter der Box — ohne „/" in der Kennung', () => {
    const hash = gatewaySeiteHash(HS_SITE.id, { kennzeichen: 'DQ-3', zustaendige_box: { id: 'box-hs' } }, [hsBox(JETZT)]);
    expect(hash).toBe('#/anlage/site-hs/geraet/VP-HS-0001/dq-3');
    const route = parseRoute(hash!);
    expect(route).toMatchObject({ sub: 'geraet', geraet: { ref: 'VP-HS-0001', geraetId: 'dq-3' } });
  });

  it('liest keine bekannte Box, führt die Adresse über die führende Box; ohne Box gibt es keine', () => {
    expect(gatewaySeiteHash(HS_SITE.id, { kennzeichen: 'DQ-3', zustaendige_box: null }, [hsBox(JETZT)]))
      .toBe('#/anlage/site-hs/geraet/VP-HS-0001/dq-3');
    expect(gatewaySeiteHash(HS_SITE.id, { kennzeichen: 'DQ-3', zustaendige_box: { id: 'fremd' } }, [hsBox(JETZT)]))
      .toBe('#/anlage/site-hs/geraet/VP-HS-0001/dq-3');
    expect(gatewaySeiteHash(HS_SITE.id, { kennzeichen: 'DQ-3', zustaendige_box: null }, [])).toBeNull();
  });

  it('„Gerät an diesem Gateway hinzufügen" führt in den Aufbau mit dem Kennzeichen; das Öffnen verbraucht beides', () => {
    const hash = aufbauHash('site-hs', 'geraet', { an: 'DQ-3' });
    expect(hash).toBe('#/anlage/site-hs/modell?neu=geraet&an=DQ-3');
    expect(parseAufbauAn(hash)).toBe('DQ-3');
    expect(ohneAufbauNeu(hash)).toBe('#/anlage/site-hs/modell');
    // Ohne Gerät kein Weg: `an` gilt nur für „Gerät hinzufügen".
    expect(aufbauHash('site-hs', 'box', { an: 'DQ-3' })).toBe('#/anlage/site-hs/modell?neu=box');
    expect(aufbauHash('site-hs', 'geraet')).toBe('#/anlage/site-hs/modell?neu=geraet');
  });
});

describe('GE-5 · Gateway-Seite', () => {
  it('Gateway-Form mit vier Geräten: Kopf, Geräte mit Seiten und Geräte-ID, Anbindung mit Last und Box-Wechsel', () => {
    const v = seite(gatewayForm(JETZT), 'DQ-3');
    expect(v.art).toBe('gefunden');
    if (v.art !== 'gefunden') return;
    expect(v.titel).toBe('Zählergateway Halle');
    expect(v.zustand).toMatchObject({ wort: 'Liefert Daten', ton: 'ok' });
    expect(v.geraete.map((g) => g.geraeteId)).toEqual(['Geräte-ID 1', 'Geräte-ID 2', 'Geräte-ID 3', 'Geräte-ID 4']);
    expect(v.geraete.map((g) => g.href)).toEqual(['haupt', 'kompressor', 'licht', 'buero']
      .map((z) => `#/anlage/site-hs/geraet/VP-HS-0001/src-${z}`));
    expect(v.geraeteSatz).toBe('4 Geräte · 4 liefern Daten');

    const a = v.anbindung;
    expect(zeile(a.zeilen, 'Weg')?.wert).toBe('Modbus TCP · 192.168.10.31:502 · Geräte-IDs 1–4');
    expect(zeile(a.zeilen, 'Gelesen von')).toMatchObject({ wert: 'VoltPilot-Box Box Halle', href: '#/anlage/site-hs/box/VP-HS-0001' });
    expect(zeile(a.zeilen, 'Empfang')?.wert).toBe('Liefert Daten');
    // Die Last steht hier, weil sie für alle vier gilt (am Gerät dahinter fehlt sie).
    expect(zeile(a.zeilen, 'Last an der Box')?.wert).toBe('23\u00a0%');
    expect(zeile(a.zeilen, 'Lesetakt')?.wert).toBe('alle 10 s');
    expect(zeile(a.zeilen, 'Gelesen über')).toBeUndefined();
    expect(a.wechsel).toEqual({ art: 'dialog' });
    expect(a.hinweis).toBe('Box und Last gelten für alle 4 Geräte an diesem Gateway — ein Wechsel der Box nimmt alle mit.');
    expect(a.kennung).toBe('Kennung DQ-3');
    expect(v.hinzufuegenHref).toBe('#/anlage/site-hs/modell?neu=geraet&an=DQ-3');
  });

  it('Aufbau und Box-Seite führen auf dieselbe Seite — die Gateway-Zeile hat ihren Pfeil, die Wege 1 : 1 und 1 : 0 keinen', () => {
    const d = gatewayForm(JETZT);
    const anlage = aufbauDerAnlage(d)!;
    const wege = anlage.boxen[0].wege;
    expect(wege.map((w) => [w.kennzeichen, w.art, w.href])).toEqual([
      ['DQ-3', 'gateway', '#/anlage/site-hs/geraet/VP-HS-0001/dq-3'],
      ['DQ-5', 'offen', null],
    ]);
    const block = boxGeraeteBlock({
      boxId: 'box-hs', boxRef: 'VP-HS-0001', siteId: HS_SITE.id, box: anlage.boxen[0], datenquellen: d.datenquellen, zuordnung: true,
    });
    expect(block.gateways.map((g) => g.href)).toEqual(['#/anlage/site-hs/geraet/VP-HS-0001/dq-3']);
  });

  it('Gateway ohne Box: „Von keiner Box gelesen", keine Last, der Box-Wechsel bleibt der Weg zu einer Box', () => {
    const d = gatewayForm(JETZT);
    const wege = (d.datenquellen ?? []).map((q): UemsDatenquelle =>
      q.id === 'dq-3' ? { ...q, zustaendige_box: null, rueckmeldung: null } : q);
    const v = seite({ ...d, datenquellen: wege }, 'DQ-3');
    expect(v.art).toBe('gefunden');
    if (v.art !== 'gefunden') return;
    expect(v.zustand).toMatchObject({ wort: 'Von keiner Box gelesen', ton: 'off' });
    expect(zeile(v.anbindung.zeilen, 'Gelesen von')).toMatchObject({ wert: 'Von keiner Box gelesen', ton: 'off', href: null });
    expect(zeile(v.anbindung.zeilen, 'Empfang')).toBeUndefined();
    expect(zeile(v.anbindung.zeilen, 'Last an der Box')).toBeUndefined();
    expect(v.anbindung.wechsel).toEqual({ art: 'dialog' });
    expect(v.geraete).toHaveLength(4);
  });

  it('Anlage ganz ohne Box: der Aufbau bietet keine Adresse an, die Seite steht trotzdem über die Adresse', () => {
    const d = gatewayForm(JETZT, { devices: [] });
    const anlage = aufbauDerAnlage(d)!;
    expect(anlage.wegeOhneBox.find((w) => w.kennzeichen === 'DQ-3')).toMatchObject({ art: 'gateway', href: null });
    const v = seite(d, 'DQ-3');
    expect(v.art).toBe('gefunden');
  });

  it('Gegenprobe 1 : 1: DQ-1 trägt genau ein Gerät — keine Gateway-Seite, sondern der Weg zu seinem Gerät', () => {
    const v = seite(gatewayForm(JETZT), 'DQ-1');
    expect(v).toMatchObject({
      art: 'fehlt',
      titel: 'DQ-1 ist die Anbindung von Wechselrichter Dach',
      weiter: { text: 'Zu Wechselrichter Dach', href: '#/anlage/site-hs/geraet/VP-HS-0001/src-wr' },
    });
  });

  it('Gegenprobe 1 : 0 und unbekannte Kennung: keine Gateway-Seite', () => {
    expect(seite(gatewayForm(JETZT), 'DQ-5')).toMatchObject({
      art: 'fehlt',
      titel: 'An DQ-5 ist noch kein Gerät angebunden',
      weiter: { href: '#/anlage/site-hs/modell?neu=geraet' },
    });
    expect(seite(gatewayForm(JETZT), 'DQ-9')).toMatchObject({
      art: 'fehlt',
      satz: 'Unter der Kennung DQ-9 kennt diese Anlage keinen Anschluss.',
    });
  });

  it('Gegenprobe Identität: vier Zähler an derselben Adresse ohne gespeicherten Verweis sind kein Gateway', () => {
    const d = gatewayForm(JETZT);
    const ohneVerweis = (d.uemsGeraete ?? []).map((g) => (g.data_source_id === 'dq-3' ? { ...g, data_source_id: null } : g));
    expect(seite({ ...d, uemsGeraete: ohneVerweis }, 'DQ-3')).toMatchObject({ art: 'fehlt', titel: 'An DQ-3 ist noch kein Gerät angebunden' });
  });

  it('Zuordnung unbekannt (`…/geraete` fehlt): kein geratenes Gateway', () => {
    expect(seite(gatewayForm(JETZT, { uemsGeraete: null }), 'DQ-3')).toMatchObject({
      art: 'fehlt',
      satz: 'Welche Geräte hinter DQ-3 antworten, ließ sich gerade nicht laden.',
    });
  });
});

describe('GE-5 · Gerät an diesem Gateway hinzufügen', () => {
  const dq3 = (over: Partial<UemsDatenquelle> = {}) =>
    ({ ...(gatewayForm(JETZT).datenquellen ?? []).find((q) => q.id === 'dq-3')!, ...over }) as UemsDatenquelle;

  it('belegt Adresse, Port und die kleinste freie Geräte-ID vor', () => {
    expect(gatewayVorbelegung(dq3())).toEqual({ ip: '192.168.10.31', port: 502, unit_id: 5 });
    expect(freieGeraeteId(dq3({ geraete_ids: [1, 2, 4] }))).toBe(3);
    // Auch die Geräte-IDs der Geräte daran zählen als belegt.
    expect(freieGeraeteId(dq3({
      geraete_ids: [1],
      geraete: [{ id: 'g', kennzeichen: 'GR-1', bezeichnung: null, geraeteart: 'zaehler', geraete_id: 2, komponenten: [] }],
    }))).toBe(3);
    // Ein Weg, den keine Vorlage als Feld trägt, bleibt unbelegt — nie geraten.
    expect(gatewayVorbelegung(dq3({ protokoll: 'http', adresse: 'http://192.168.10.31:80' }))).toBeNull();
  });

  it('die Vorlage nimmt nur die Felder, die sie fragt', () => {
    const vorlage = { transportSchema: [
      { key: 'ip', type: 'text', required: true },
      { key: 'port', type: 'number', default: 502 },
      { key: 'unit_id', type: 'number', default: 1 },
    ] } as unknown as ComponentTemplate;
    expect(initialeVerbindung(vorlage, gatewayVorbelegung(dq3()))).toEqual({ ip: '192.168.10.31', port: 502, unit_id: 5 });
    const ohneUnit = { transportSchema: [{ key: 'ip', type: 'text' }] } as unknown as ComponentTemplate;
    expect(initialeVerbindung(ohneUnit, gatewayVorbelegung(dq3()))).toEqual({ ip: '192.168.10.31' });
    expect(initialeVerbindung(vorlage)).toEqual({ port: 502, unit_id: 1 });
  });

  it('hängt das neue Gerät nur über den Vorschlag des Servers an — so, wie die Liste ihn zeigt', () => {
    const box = { id: 'box-hs', name: 'Box Halle', heimat_anlage: HS_SITE.id };
    const liste = {
      fuehrende_box: box,
      fuehrung: 'eine_box',
      vorschlaege: [
        { kennzeichen: 'DQ-?', box, protokoll: 'modbus_tcp', adresse: '192.168.10.31:502', geraete_ids: [5], kadenz_s: 10,
          steuerquelle: false, ab: '2026-10-23T11:43:00Z', komponenten: [{ id: 'e-neu', name: null, art: 'grid-meter' }],
          grund: 'adresse_an_box_vergeben', text: 'Diese Adresse liest Box Halle bereits als DQ-3 — Gerät dort hinzufügen?',
          ziel: { id: 'dq-3', kennzeichen: 'DQ-3', name: 'Zählergateway Halle' } },
        { kennzeichen: 'DQ-?', box, protokoll: 'modbus_tcp', adresse: '192.168.10.77:502', geraete_ids: [1], kadenz_s: 10,
          steuerquelle: false, ab: '2026-10-23T11:43:00Z', komponenten: [{ id: 'e-anders', name: null, art: 'grid-meter' }],
          grund: null, text: 'Ab …', ziel: null },
      ],
      ausgelassen: [],
    } as unknown as UemsDatenquelleVorschlagsliste;
    expect(gatewayAnhaengen(liste, 'dq-3', 'e-neu')).toEqual([{
      device_id: 'box-hs', protokoll: 'modbus_tcp', adresse: '192.168.10.31:502', komponenten: ['e-neu'], datenquelle_id: 'dq-3',
    }]);
    // Zeigt der Server das Gerät nicht an DIESEM Weg, hängt nichts.
    expect(gatewayAnhaengen(liste, 'dq-3', 'e-anders')).toEqual([]);
    expect(gatewayAnhaengen(liste, 'dq-5', 'e-neu')).toEqual([]);
    expect(gatewayAnhaengenSatz('DQ-3', true)).toBe('Es antwortet jetzt über Gateway DQ-3.');
    expect(gatewayAnhaengenSatz('DQ-3', false)).toContain('noch nicht verknüpft');
  });
});
