import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BILANZ_HINWEIS,
  DEFAULT_INTERVAL_S,
  HOST_NOT_PRIVATE,
  MAX_CHANNELS,
  geraetFehler,
  isPrivateHost,
  istBreit,
  lesbar,
  leseErgebnis,
  leselastHinweis,
  leseRumpf,
  messwerteFehler,
  modiconDeutung,
  neueVerbindung,
  neueZeile,
  speicherRumpf,
  zeilenFehler,
  type MesswertZeile,
} from './selbstbau';

function zeile(over: Partial<MesswertZeile> = {}): MesswertZeile {
  return { ...neueZeile(), label: 'Vorlauf', address: '100', ...over };
}

function lan() {
  return { ...neueVerbindung(), host: '192.168.1.50' };
}

describe('LAN-only', () => {
  /**
   * ⚠ Der Beweis, dass Portal, api und Box DIESELBE Regel sprechen: die
   * Vektoren kommen aus der GETEILTEN Datei, die auch der Go- und der
   * Java-Zwilling lesen. Eine eigene Liste hier wäre eine zweite Wahrheit.
   */
  it('spricht genau die geteilten Vektoren', () => {
    const raw = readFileSync(
      resolve(__dirname, '../../../docs/contracts/lan-host-vectors.json'),
      'utf8',
    );
    const vectors = JSON.parse(raw) as {
      private: { host: string; why: string }[];
      public: { host: string; why: string }[];
    };
    expect(vectors.private.length).toBeGreaterThan(0);
    expect(vectors.public.length).toBeGreaterThan(0);

    for (const v of vectors.private) {
      expect(isPrivateHost(v.host), `privat: ${v.host} (${v.why})`).toBe(true);
    }
    for (const v of vectors.public) {
      expect(isPrivateHost(v.host), `NICHT privat: ${v.host} (${v.why})`).toBe(false);
    }
  });

  it('lehnt ein öffentliches Ziel mit dem Weg heraus ab', () => {
    expect(geraetFehler({ ...neueVerbindung(), host: '8.8.8.8' })).toContain(HOST_NOT_PRIVATE);
    expect(HOST_NOT_PRIVATE).toContain('IP-Adresse');
    expect(geraetFehler(lan())).toEqual([]);
  });

  it('nennt eine fehlende Adresse, statt sie als „nicht privat" zu tarnen', () => {
    const fehler = geraetFehler(neueVerbindung());
    expect(fehler.some((f) => f.includes('Adresse des Geräts'))).toBe(true);
    expect(fehler).not.toContain(HOST_NOT_PRIVATE);
  });
});

describe('Poll-Budget + Kanal-Form', () => {
  it('deckelt Anzahl und Mindestabstand', () => {
    const viele = Array.from({ length: MAX_CHANNELS + 1 }, (_, i) =>
      zeile({ label: `Wert ${i}`, address: String(100 + i) }));
    expect(messwerteFehler(viele).some((f) => f.includes('Höchstens 16'))).toBe(true);

    expect(zeilenFehler(zeile({ minReadIntervalS: '1' }))
      .some((f) => f.includes('mindestens 5'))).toBe(true);
    // Genau an der Grenze ist erlaubt.
    expect(zeilenFehler(zeile({ minReadIntervalS: '5' }))).toEqual([]);
  });

  it('weist zwei Messwerte auf demselben Register ab', () => {
    const doppelt = [zeile({ label: 'A' }), zeile({ label: 'B' })];
    expect(messwerteFehler(doppelt).some((f) => f.includes('dasselbe Register'))).toBe(true);
    // Eine andere Adresse ist in Ordnung.
    expect(messwerteFehler([zeile({ label: 'A' }), zeile({ label: 'B', address: '101' })]))
      .toEqual([]);
  });

  it('verlangt mindestens einen Messwert', () => {
    expect(messwerteFehler([]).some((f) => f.includes('mindestens einen Messwert'))).toBe(true);
  });

  it('nimmt ein deutsches Komma als Zahl an', () => {
    // ⚠ Ohne die Komma-Behandlung wäre „0,1" ein NaN und der Kunde bekäme eine
    // Fehlermeldung über ein korrekt ausgefülltes Feld.
    expect(zeilenFehler(zeile({ scale: '0,1' }))).toEqual([]);
    expect(speicherRumpf('X', lan(), [zeile({ scale: '0,1' })])
      .channels as { scale: number }[]).toEqual([expect.objectContaining({ scale: 0.1 })]);
  });

  it('lehnt eine Skalierung 0 ab - sie macht aus jedem Messwert eine 0', () => {
    expect(zeilenFehler(zeile({ scale: '0' })).some((f) => f.includes('Skalierung'))).toBe(true);
  });

  it('rechnet die Leselast vor und warnt nur, wenn es sich lohnt', () => {
    expect(leselastHinweis([zeile()])).toContain('0,1');
    expect(leselastHinweis([zeile()])).not.toContain('Abstand erhöhen');

    const viele = Array.from({ length: 12 }, (_, i) =>
      zeile({ label: `W${i}`, address: String(200 + i), minReadIntervalS: '5' }));
    expect(leselastHinweis(viele)).toContain('2,4');
    expect(leselastHinweis(viele)).toContain('Abstand erhöhen');

    expect(leselastHinweis([])).toBeNull();
  });

  it('zeigt die Wortreihenfolge nur bei 32 Bit', () => {
    expect(istBreit('u16')).toBe(false);
    expect(istBreit('s16')).toBe(false);
    expect(istBreit('u32')).toBe(true);
    expect(istBreit('float32')).toBe(true);
    // Ein 16-Bit-Messwert schickt IMMER „big" - ein unsichtbares Feld darf
    // keinen Wert transportieren, den niemand gewählt hat.
    const rumpf = speicherRumpf('X', lan(), [zeile({ dataType: 'u16', wordOrder: 'little' })]);
    expect((rumpf.channels as { wordOrder: string }[])[0].wordOrder).toBe('big');
  });
});

describe('„Jetzt lesen"', () => {
  it('zeigt Roh und skaliert nebeneinander - der Moment, in dem der Fehler sichtbar wird', () => {
    const e = leseErgebnis({ ok: true, raw: 13750, registers: [13750], value: 1375, unit: '°C',
      hint: 'Diese Temperatur sieht nach einer falschen Skalierung aus.' });
    expect(e.zustand).toBe('bestanden');
    if (e.zustand !== 'bestanden') return;
    expect(e.roh).toBe('13.750');
    expect(e.skaliert).toBe('1.375 °C');
    expect(e.register).toBe('13750');
    expect(e.hinweis).toContain('Skalierung');
  });

  it('trägt bei einem Fehlschlag NIE einen Wert', () => {
    const e = leseErgebnis({ ok: false, errorCode: 'unreachable' });
    expect(e.zustand).toBe('fehlgeschlagen');
    if (e.zustand !== 'fehlgeschlagen') return;
    expect(e.text).toContain('antwortet nichts');
    expect(e).not.toHaveProperty('roh');
  });

  it('erfindet zu einem unbekannten Code keine Erklärung', () => {
    const e = leseErgebnis({ ok: false, errorCode: 'ganz_neu', message: 'Serverwort.' });
    expect(e.zustand === 'fehlgeschlagen' && e.text).toBe('Serverwort.');
    const leer = leseErgebnis({ ok: false, errorCode: 'ganz_neu' });
    expect(leer.zustand === 'fehlgeschlagen' && leer.text).toBe('Die Lesung ist fehlgeschlagen.');
    expect(leseErgebnis(null).zustand).toBe('fehlgeschlagen');
  });

  it('zeigt eine fehlende Zahl als „—", nie als 0', () => {
    const e = leseErgebnis({ ok: true, raw: null, value: null, unit: 'kW' });
    expect(e.zustand === 'bestanden' && e.roh).toBe('—');
    expect(e.zustand === 'bestanden' && e.skaliert).toBe('—');
  });

  it('schickt beim Lesen keinen Mindestabstand mit - der gilt dem Poll, nicht der Probe', () => {
    const rumpf = leseRumpf(lan(), zeile()) as { channel: Record<string, unknown> };
    expect(rumpf.channel).not.toHaveProperty('minReadIntervalS');
    expect(rumpf.channel.address).toBe(100);
  });
});

describe('Name, Bilanz und Lesen von selbst', () => {
  it('nennt in der Bilanz-Zusage, was sich NICHT ändert', () => {
    expect(BILANZ_HINWEIS).toContain('Energiebilanz');
    expect(BILANZ_HINWEIS).toContain('Wechselrichter');
  });

  it('schickt ohne Namen keinen - der Server nennt es dann „Eigenes Modbus-Gerät"', () => {
    expect(speicherRumpf('  ', lan(), []).label).toBeUndefined();
  });

  it('setzt den Mindestabstand einer neuen Zeile auf die Vorgabe', () => {
    expect(neueZeile().minReadIntervalS).toBe(String(DEFAULT_INTERVAL_S));
  });

  it('liest eine Zeile, sobald Register, Skalierung und Offset stimmen - ein Name ist dafür nicht nötig', () => {
    expect(lesbar(zeile({ label: '' }))).toBe(true);
    expect(lesbar(zeile({ address: '' }))).toBe(false);
    expect(lesbar(zeile({ address: '70000' }))).toBe(false);
    expect(lesbar(zeile({ scale: '0' }))).toBe(false);
    expect(lesbar(zeile({ offset: 'x' }))).toBe(false);
  });
});

describe('Modicon-Lesart', () => {
  it('nennt die zweite Lesart einer fünfstelligen Nummer - und rechnet nie still um', () => {
    expect(modiconDeutung('40011')).toMatchObject({ kind: 'holding', address: 10, knopf: 'Als Holding-Register 10 lesen' });
    expect(modiconDeutung('30775')).toMatchObject({ kind: 'input', address: 774 });
    expect(modiconDeutung('40011')?.text).toMatch(/Der gelesene Wert zeigt, welche Zahl stimmt/);
  });

  it('schweigt bei allem, was keine Modicon-Nummer sein kann', () => {
    for (const a of ['', '10', '30000', '40000', '50001', '4001.5']) expect(modiconDeutung(a)).toBeNull();
  });
});
