import { describe, expect, it } from 'vitest';
import { ioZustandView, VERALTET_MS, type IoModulZustandDto } from './ioZustand';

const now = Date.parse('2026-09-24T12:00:00Z');

function dto(over: Partial<IoModulZustandDto> = {}): IoModulZustandDto {
  return {
    entityId: 'm-1',
    label: 'I/O-Modul',
    inputs: [
      { channel: 1, on: true, consumerId: null, consumerName: null },
      { channel: 2, on: false, consumerId: null, consumerName: null },
    ],
    outputs: [
      { channel: 3, on: true, consumerId: 'c-3', consumerName: 'Heizstab' },
      { channel: 4, on: false, consumerId: null, consumerName: null },
    ],
    receivedAt: new Date(now - 20_000).toISOString(),
    ...over,
  };
}

describe('ioZustandView', () => {
  it('zeigt gemeldete Zustaende und den Verbraucher je Ausgang', () => {
    const v = ioZustandView(dto(), now);
    expect(v.eingaenge.map((z) => [z.label, z.wert])).toEqual([
      ['Eingang DI1', 'ein'],
      ['Eingang DI2', 'aus'],
    ]);
    expect(v.ausgaenge[0]).toMatchObject({ label: 'Ausgang DO3', wert: 'ein', detail: 'schaltet Heizstab' });
    expect(v.ausgaenge[1]).toMatchObject({ wert: 'aus', detail: 'frei' });
    expect(v.veraltet).toBe(false);
    expect(v.stand).toMatch(/^Zuletzt gemeldet/);
    expect(v.leer).toBeNull();
  });

  it('zeigt einen nicht gemeldeten Kanal als Luecke, nie als aus', () => {
    const v = ioZustandView(dto({
      outputs: [{ channel: 5, on: null, consumerId: 'c-5', consumerName: 'Pumpe' }],
    }), now);
    expect(v.ausgaenge[0].wert).toBe('—');
    expect(v.ausgaenge[0].detail).toBe('schaltet Pumpe');
  });

  it('weist einen alten Zustand als veraltet aus', () => {
    const v = ioZustandView(dto({ receivedAt: new Date(now - VERALTET_MS - 1000).toISOString() }), now);
    expect(v.veraltet).toBe(true);
    expect(v.ausgaenge[0]).toMatchObject({ wert: 'ein (veraltet)', ton: 'warn' });
  });

  it('nennt den Grund, wenn nichts gemeldet ist', () => {
    const v = ioZustandView(dto({ inputs: [], outputs: [], receivedAt: null }), now);
    expect(v.leer).toContain('nichts gemeldet');
    expect(v.stand).toBeNull();
    expect(ioZustandView(null, now).leer).toContain('nichts gemeldet');
  });

  it('bietet einen freien Ausgang zum Test-Schalten an, einen vergebenen nie', () => {
    const v = ioZustandView(dto(), now);
    expect(v.ausgaenge[0]).toMatchObject({ channel: 3, schalten: null });
    expect(v.ausgaenge[1]).toMatchObject({ channel: 4, schalten: { on: true, label: 'Test: 2 Min. an' } });
    const an = ioZustandView(dto({
      outputs: [{ channel: 4, on: true, consumerId: null, consumerName: null }],
    }), now);
    expect(an.ausgaenge[0].schalten).toEqual({ on: false, label: 'Aus' });
  });

  it('bietet bei veraltetem Zustand das Einschalten an, nie ein geratenes Aus', () => {
    const v = ioZustandView(dto({
      receivedAt: new Date(now - VERALTET_MS - 1000).toISOString(),
      outputs: [{ channel: 4, on: true, consumerId: null, consumerName: null }],
    }), now);
    expect(v.ausgaenge[0].schalten?.on).toBe(true);
  });

  it('zeigt vergebene Ausgaenge auch ohne Meldung - als Luecke', () => {
    const v = ioZustandView(dto({
      inputs: [],
      outputs: [{ channel: 3, on: null, consumerId: 'c-3', consumerName: 'Heizstab' }],
      receivedAt: null,
    }), now);
    expect(v.leer).toBeNull();
    expect(v.ausgaenge[0]).toMatchObject({ wert: '—', detail: 'schaltet Heizstab' });
  });
});
