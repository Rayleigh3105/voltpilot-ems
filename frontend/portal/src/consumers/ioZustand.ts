/**
 * Die Anzeige-Ableitung eines I/O-Moduls (Ebyte M31) auf seiner Geräteseite:
 * die zuletzt GEMELDETEN Eingänge und Ausgänge, je Ausgang der Verbraucher,
 * der ihn schaltet, und das Alter der Meldung.
 *
 * Rein: die Seite rendert nur, was hier abgeleitet wird.
 *
 * ⚠ Die Ehrlichkeitsregeln des Hauses:
 *  - ein nicht gemeldeter Kanal ist „—", nie „aus" (fehlend ist keine Null);
 *  - ein Zustand, der älter als {@link VERALTET_MS} ist, wird als veraltet
 *    ausgewiesen (die Box meldet bei Änderung und mindestens minütlich) - er
 *    wird nie als aktueller Zustand gezeigt;
 *  - ein Ausgang zeigt, was das Relais GEMELDET hat, nicht was befohlen ist:
 *    Befehl, Rückmeldung und Wirkung bleiben getrennt.
 */
import type { GeraetTon, Zeile } from '../geraetSeite';
import { fmtRelative } from '../format';

/** Ein Kanal aus `GET /io-modules/{id}/zustand`. */
export interface IoKanal {
  channel: number;
  on: boolean | null;
  consumerId: string | null;
  consumerName: string | null;
}

/** Die Antwort von `GET /io-modules/{id}/zustand`. */
export interface IoModulZustandDto {
  entityId: string;
  label: string | null;
  inputs: IoKanal[];
  outputs: IoKanal[];
  receivedAt: string | null;
}

/** Ab wann ein gemeldeter Zustand nicht mehr als aktuell gilt (drei Minuten-Meldungen). */
export const VERALTET_MS = 3 * 60 * 1000;

/**
 * Ein Ausgang mit seiner Schalt-Möglichkeit auf der Geräteseite.
 *
 * `schalten` ist `null`, wenn der Ausgang einem Verbraucher gehört: dann
 * schaltet ihn dessen Handeingriff (mit Grenzen und Schonzeiten), nie der
 * Test hier - der Verbraucher zöge ihn sonst beim nächsten Takt zurück.
 */
export interface IoAusgangZeile extends Zeile {
  channel: number;
  schalten: { on: boolean; label: string } | null;
}

/** Wie lange ein Test-Einschalten hält (die Obergrenze des Vertrags). */
export const TEST_SEKUNDEN = 120;

export interface IoZustandView {
  eingaenge: Zeile[];
  ausgaenge: IoAusgangZeile[];
  /** Der Satz über das Alter der Meldung, oder null ohne Meldung. */
  stand: string | null;
  veraltet: boolean;
  /** Der ehrliche Satz, wenn (noch) nichts gemeldet ist - sonst null. */
  leer: string | null;
}

function zustandWort(on: boolean | null, veraltet: boolean): { wert: string; ton: GeraetTon | null } {
  if (on == null) return { wert: '—', ton: null };
  if (veraltet) return { wert: on ? 'ein (veraltet)' : 'aus (veraltet)', ton: 'warn' };
  return on ? { wert: 'ein', ton: 'ok' } : { wert: 'aus', ton: 'off' };
}

export function ioZustandView(dto: IoModulZustandDto | null, now: number): IoZustandView {
  const at = dto?.receivedAt ? Date.parse(dto.receivedAt) : Number.NaN;
  const hatMeldung = Number.isFinite(at);
  const veraltet = hatMeldung && now - at > VERALTET_MS;
  const eingaenge: Zeile[] = (dto?.inputs ?? []).map((k) => ({
    label: `Eingang DI${k.channel}`,
    ...zustandWort(hatMeldung ? k.on : null, veraltet),
  }));
  const ausgaenge: IoAusgangZeile[] = (dto?.outputs ?? []).map((k) => {
    const an = hatMeldung && !veraltet ? k.on : null;
    return {
      label: `Ausgang DO${k.channel}`,
      ...zustandWort(hatMeldung ? k.on : null, veraltet),
      detail: k.consumerId ? `schaltet ${k.consumerName?.trim() || 'einen Verbraucher'}` : 'frei',
      channel: k.channel,
      schalten: k.consumerId
        ? null
        : an === true
          ? { on: false, label: 'Aus' }
          : { on: true, label: `Test: ${TEST_SEKUNDEN / 60} Min. an` },
    };
  });
  return {
    eingaenge,
    ausgaenge,
    stand: hatMeldung
      ? `Zuletzt gemeldet ${fmtRelative(dto!.receivedAt, new Date(now))}`
      : null,
    veraltet,
    leer: hatMeldung || eingaenge.length + ausgaenge.length > 0 ? null
      : 'Das I/O-Modul hat in den letzten zehn Minuten nichts gemeldet. Sobald die Box es '
        + 'liest, stehen hier seine Eingänge und Ausgänge.',
  };
}
