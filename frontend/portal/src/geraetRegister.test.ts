import { describe, expect, it } from 'vitest';
import type {
  DeviceExportLimit,
  RegisterKnowledgeFamily,
  RegisterWriteEvent,
  SiteSource,
} from './api';
import { NBSP } from './format';
import { NO_DATA } from './nodata';
import { abrufFehler, KEINE_REGISTER, registerSicht, ROH_HINWEIS } from './geraetRegister';

const NOW = Date.parse('2026-08-21T10:00:00Z');

const limit: DeviceExportLimit = {
  limitKw: 33,
  register: '0x00e7',
  readAt: '2026-08-21T06:12:00Z',
};

const wissen: RegisterKnowledgeFamily[] = [
  {
    family: 'hybrid_3p',
    brand: 'deye',
    label: 'Deye 3-phasig',
    registers: [
      {
        address: 231,
        addressHex: '0x00E7',
        label: 'Einspeisegrenze',
        clazz: 'netz_compliance',
        scale: 10,
        unit: 'kW',
        note: null,
      },
    ],
  },
];

function write(over: Partial<RegisterWriteEvent> = {}): RegisterWriteEvent {
  return {
    id: 7, requestId: 'r-7', source: 'portal', deviceId: 'gw', deviceRef: 'edge-1',
    lane: 'primary', entityId: null, targetLabel: 'Deye', registerKind: 'holding',
    address: 231, addressHex: '0x00E7', addressInput: '0x00E7', valueInput: '7000',
    note: null, valueRaw: 7000, expectedBefore: 3300, registerLabel: 'Einspeisegrenze',
    // Der Vermerk des SERVERS, wörtlich in seiner Form (`RegisterKnowledge`):
    // Rohwert × Skala = Wert. Die Skala von 0x00E7 ist 0,01.
    registerClass: 'netz_compliance', scaleNote: 'Rohwert × 0.01 = 70,0 kW', origin: 'kunde',
    actorName: 'demo', actorRole: null, viaTenantSwitcher: false,
    requestedAt: '2026-08-21T09:00:00Z', beforeRaw: 3300, afterRaw: 7000, adopted: true,
    outcome: 'ok', reason: null, answeredAt: '2026-08-21T09:00:05Z',
    ...over,
  };
}

const source: SiteSource = {
  deviceId: 'gw', sourceId: 'inverter', kind: 'primary', role: null, label: null,
  brand: 'deye', model: 'SUN-30K-SG01HP3-EU', pvKw: 21.2, powerKw: -30, loadKw: 5.5,
  health: 'ok', readAt: '2026-08-21T09:59:55Z', reportedAt: '2026-08-21T09:59:55Z',
};

describe('registerSicht - die gelesenen Register EINES Geräts', () => {
  it('fügt die drei Bestands-Quellen zu EINER Tabelle', () => {
    const v = registerSicht({
      art: 'hauptgeraet', exportLimit: limit, writes: [write()], source,
      familie: 'hybrid_3p', knowledge: wissen, now: NOW,
    });
    expect(v.zeilen.map((z) => z.quelle))
      .toEqual(['taeglich', 'schreibvorgang', 'telemetrie', 'telemetrie', 'telemetrie']);
    expect(v.leer).toBeNull();
  });

  it('rechnet ein Rohwort NIE zurück - „—" ist ein gültiger Wert', () => {
    const v = registerSicht({
      art: 'hauptgeraet', exportLimit: limit, familie: 'hybrid_3p', knowledge: wissen,
      now: NOW,
    });
    const zeile = v.zeilen[0];
    // 33,0 kW × Skala 10 wären 3300 - dieses Wort kam aber nie über die Leitung.
    expect(zeile.roh).toBe(NO_DATA);
    expect(zeile.dekodiert).toBe(`33,0${NBSP}kW`);
    expect(zeile.register).toBe('0x00E7');
    // Der Name kommt aus dem Wissen DIESER Familie, samt Warnklasse.
    expect(zeile.bedeutung).toBe('Einspeisegrenze');
    expect(zeile.klasse).toBe('netz_compliance');
  });

  it('nennt ohne bekannte Familie KEINEN Namen, nur die Adresse', () => {
    const v = registerSicht({
      art: 'quelle', exportLimit: limit, familie: null, knowledge: wissen, now: NOW,
    });
    // Dieselbe Adresse heisst auf einer anderen Baureihe etwas anderes.
    expect(v.zeilen[0].bedeutung).toBe('Einspeisegrenze im Gerät');
    expect(v.zeilen[0].klasse).toBeNull();
    // Auch eine FREMDE Familie liefert nichts.
    const fremd = registerSicht({
      art: 'quelle', exportLimit: limit, familie: 'hybrid_1p', knowledge: wissen, now: NOW,
    });
    expect(fremd.zeilen[0].bedeutung).toBe('Einspeisegrenze im Gerät');
  });

  it('liest den dekodierten Wert aus dem Vermerk des SERVERS, statt zu rechnen', () => {
    const mit = registerSicht({ art: 'hauptgeraet', writes: [write()], now: NOW });
    expect(mit.zeilen[0].roh).toBe('7000');
    // ⚠ Der echte Fehlgriff, den das verhindert: selbst gerechnet wären es
    // „700,0 kW" (÷10 statt ×0,01) - der Server sagt 70,0 kW.
    expect(mit.zeilen[0].dekodiert).toBe('70,0 kW');

    // Ohne Vermerk bleibt es beim Rohwort - nie eine erfundene Einheit.
    const ohne = registerSicht({
      art: 'hauptgeraet', writes: [write({ scaleNote: null })], now: NOW,
    });
    expect(ohne.zeilen[0].roh).toBe('7000');
    expect(ohne.zeilen[0].dekodiert).toBe(NO_DATA);
    // Eine unbekannte Form des Vermerks wird GANZ gezeigt, nie zu einer Zahl
    // umgedeutet.
    const wirr = registerSicht({
      art: 'hauptgeraet', writes: [write({ scaleNote: 'irgendwas' })], now: NOW,
    });
    expect(wirr.zeilen[0].dekodiert).toBe('irgendwas');
  });

  it('lässt einen Vorgang ohne Rohwort ganz weg', () => {
    // Eine Vorschau ohne Quittung hat kein Wort - eine Zeile ohne beides wäre
    // eine Behauptung über eine Lesung, die es nicht gab.
    const v = registerSicht({
      art: 'hauptgeraet', writes: [write({ beforeRaw: null, afterRaw: null })], now: NOW,
    });
    expect(v.zeilen).toHaveLength(0);
  });

  it('zeigt einen fehlenden Messwert gar nicht - nie eine 0', () => {
    const v = registerSicht({
      art: 'quelle',
      source: { ...source, powerKw: null, loadKw: null },
      now: NOW,
    });
    expect(v.zeilen.map((z) => z.bedeutung)).toEqual(['Solarleistung']);
    // Die Richtung ist ein WORT, nie ein Vorzeichen.
    const netz = registerSicht({ art: 'quelle', source, now: NOW });
    expect(netz.zeilen.find((z) => z.bedeutung === 'Netzleistung')?.dekodiert)
      .toBe(`30,0${NBSP}kW Einspeisung`);
  });

  it('sagt die GRENZE nur, wenn die Roh-Spalte wirklich leer ist', () => {
    const nurMessung = registerSicht({ art: 'quelle', source, now: NOW });
    expect(nurMessung.hinweis).toBe(ROH_HINWEIS);
    const mitRoh = registerSicht({
      art: 'hauptgeraet', writes: [write()], source, now: NOW,
    });
    expect(mitRoh.hinweis).toBeNull();
  });

  it('nennt bei Box und Ladesäule den GRUND, statt eine leere Tabelle zu zeigen', () => {
    const box = registerSicht({ art: 'box', exportLimit: limit, source, now: NOW });
    expect(box.zeilen).toHaveLength(0);
    expect(box.leer).toBe(KEINE_REGISTER.box);
    const saeule = registerSicht({ art: 'ladepunkt', now: NOW });
    expect(saeule.leer).toBe(KEINE_REGISTER.ladepunkt);
    // Und ein Gerät, von dem noch nichts vorliegt, sagt genau das.
    const leer = registerSicht({ art: 'quelle', now: NOW });
    expect(leer.leer).toMatch(/noch keine gelesenen Register/);
    expect(leer.hinweis).toBeNull();
  });
});

describe('Fehler beim reinen Register-Lesen', () => {
  it('behauptet bei einem Timeout nie, dass vielleicht geschrieben wurde', () => {
    const text = abrufFehler({
      errorCode: 'timeout',
      message: 'Es ist nicht sicher, ob geschrieben wurde.',
    });
    expect(text).toContain('Es wurde nichts geschrieben');
    expect(text).toContain('erneut lesen');
    expect(text).not.toContain('nicht sicher');
  });

  it('erhält einen genaueren Gerätefehler', () => {
    expect(abrufFehler({ errorCode: 'modbus_exception', message: 'Illegale Adresse.' }))
      .toBe('Illegale Adresse.');
  });
});
