import { describe, expect, it } from 'vitest';
import type { EntityLocalSetup, MastrPreview, SiteAsset } from './api';
import {
  bekannterSpeicher,
  erzeugerPlaene,
  gefundeneZeilen,
  kwpText,
  pruefeKwp,
  pruefeSpeicher,
  pvLage,
  registerortWarnung,
} from './anlageBestaetigen';

function quelle(over: Partial<EntityLocalSetup>): EntityLocalSetup {
  return {
    id: 'q',
    kind: 'source',
    role: 'pv-generation',
    brand: 'Fronius',
    model: 'Symo 10.0',
    label: null,
    reportedAt: '2026-10-23T10:00:00Z',
    adoptedEntityId: null,
    ...over,
  };
}

function asset(over: Partial<SiteAsset>): SiteAsset {
  return {
    id: 'a', type: 'pv', deviceId: null, capacityKwh: null, maxChargeKw: null, maxDischargeKw: null,
    roundtripEfficiencyPct: null, speicherschonung: null, pvCapacityKwp: null, moduleCount: null, azimuthDeg: null,
    tiltDeg: null, commissionedOn: null, registry: null, registryUnitId: null, registryFetchedAt: null,
    ...over,
  };
}

describe('Schritt 3 „Was gehört zu Ihrer Anlage?" (Anlage-Flow a1, Paket 2)', () => {
  it('die Liste: Wechselrichter zuerst, dann die übernehmbaren, die einzuordnenden, die übernommenen', () => {
    const zeilen = gefundeneZeilen([
      quelle({ id: 'uebernommen', adoptedEntityId: 'e1', role: 'grid-meter', brand: 'Eastron', model: 'SDM630' }),
      quelle({ id: 'unbekannt', role: 'battery-x', brand: 'Irgendwas', model: null }),
      quelle({ id: 'pv' }),
      quelle({ id: 'wr', kind: 'inverter', role: null, brand: 'Deye', model: 'SUN-10K' }),
    ]);
    expect(zeilen.map((z) => [z.id, z.art, z.titel])).toEqual([
      ['wr', 'wechselrichter', 'Wechselrichter'],
      ['pv', 'gemeldet', 'PV-Erzeuger'],
      ['unbekannt', 'einordnung', 'Energiequelle'],
      ['uebernommen', 'uebernommen', 'Netz-Zähler'],
    ]);
    expect(erzeugerPlaene(zeilen).map((p) => p.sourceId)).toEqual(['pv']);
  });

  it('F17: bekannte kWp sind eine Tatsache - nie ein zweites Mal gebucht; sonst geht die Zahl an den Erzeuger oder die Anlage', () => {
    const plan = erzeugerPlaene(gefundeneZeilen([quelle({ id: 'pv' })]));
    expect(pvLage([asset({ pvCapacityKwp: 9.8, registry: 'mastr', registryUnitId: 'SEE1' })], plan)).toEqual({
      art: 'bekannt',
      kwp: 9.8,
      ausRegister: true,
      mastrNummer: 'SEE1',
    });
    expect(pvLage([asset({ pvCapacityKwp: 6.05 })], [])).toMatchObject({ art: 'bekannt', ausRegister: false });
    expect(pvLage([asset({ pvCapacityKwp: 0 })], plan)).toEqual({ art: 'frage', ziel: 'erzeuger' });
    expect(pvLage([], [])).toEqual({ art: 'frage', ziel: 'anlage' });
    expect(pvLage(null, [])).toEqual({ art: 'frage', ziel: 'anlage' });
  });

  it('der Speicher der Anlagen-Daten', () => {
    expect(bekannterSpeicher([asset({ type: 'battery', capacityKwh: 10.2 })])).toEqual({ kwh: 10.2 });
    expect(bekannterSpeicher([asset({ type: 'battery', capacityKwh: null })])).toBeNull();
  });

  it('die Leistung: leer heißt „weiß ich nicht“ (nie 0), sonst dieselben Grenzen wie der Server', () => {
    expect(pruefeKwp('')).toEqual({ ok: true, wert: null });
    expect(pruefeKwp('9,8')).toEqual({ ok: true, wert: 9.8 });
    expect(pruefeKwp('1.234,5')).toEqual({ ok: true, wert: 1234.5 });
    expect(pruefeKwp('9,875')).toEqual({ ok: false, satz: 'Höchstens zwei Nachkommastellen, z. B. 9,8 kWp.' });
    expect(pruefeKwp('0')).toMatchObject({ ok: false });
    expect(pruefeKwp('neun')).toMatchObject({ ok: false });
    expect(pruefeKwp('100000')).toMatchObject({ ok: false });
  });

  it('der Speicher: beide Zahlen Pflicht, sobald er gewählt ist', () => {
    expect(pruefeSpeicher('10', '5')).toEqual({ werte: { kwh: 10, kw: 5 } });
    expect(Object.keys(pruefeSpeicher('', ''))).toEqual(['kwh', 'kw']);
    expect(Object.keys(pruefeSpeicher('10', '0'))).toEqual(['kw']);
  });

  it('R4: der Ort aus dem Register gegen die Adresse - ein Satz nur, wenn die Postleitzahl nicht passt', () => {
    const p = { plz: '89150', ort: 'Laichingen' } as MastrPreview;
    expect(registerortWarnung(p, '91710', 'Gunzenhausen')).toBe(
      'Das Register nennt 89150 Laichingen, Ihre Anlage steht in 91710 Gunzenhausen. Ist das die richtige Nummer?',
    );
    expect(registerortWarnung(p, '89150', 'Laichingen')).toBeNull();
    expect(registerortWarnung(p, null, null)).toBeNull();
    expect(registerortWarnung({ ...p, plz: null }, '91710', 'Gunzenhausen')).toBeNull();
  });

  it('die Zahl mit Einheit, deutsch und mit geschütztem Leerzeichen', () => {
    expect(kwpText(9.8)).toBe('9,8 kWp');
  });
});
