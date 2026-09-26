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
 * Ein Ausgang mit seinem Ein/Aus-Schalter auf der Geräteseite (wie in Home
 * Assistant: der Zustand bleibt, bis erneut geschaltet wird).
 *
 * `schalten` ist `null`, wenn der Ausgang einem Verbraucher gehört: dann
 * schaltet ihn dessen Handeingriff (mit Grenzen und Schonzeiten) - der
 * Verbraucher zöge ihn sonst beim nächsten Takt zurück. Ist der Zustand
 * unbekannt oder veraltet, werden BEIDE Richtungen angeboten, statt einen
 * Zustand zu raten.
 */
export interface IoAusgangZeile extends Zeile {
  channel: number;
  schalten: { on: boolean; label: string }[] | null;
}

const EIN = { on: true, label: 'Einschalten' };
const AUS = { on: false, label: 'Ausschalten' };

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
      schalten: k.consumerId ? null : an === true ? [AUS] : an === false ? [EIN] : [EIN, AUS],
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

/** Die Belegung eines Moduls in Zahlen - die große Zahl seiner Bühne. */
export interface IoBelegung {
  /** Wie viele VERSCHIEDENE Verbraucher an seinen Ausgängen hängen. */
  verbraucher: number;
  /** Wie viele Ausgänge einem Verbraucher gehören. */
  belegt: number;
  /** Wie viele Ausgänge das Modul gemeldet hat. */
  ausgaenge: number;
  /** Wie viele Eingänge das Modul gemeldet hat. */
  eingaenge: number;
}

/**
 * Die Belegung aus der letzten Meldung - `null`, solange das Modul nichts
 * gemeldet hat (dann gibt es keine Zahl, nie eine geratene „8").
 */
export function ioBelegung(dto: IoModulZustandDto | null): IoBelegung | null {
  if (!dto || dto.outputs.length + dto.inputs.length === 0) return null;
  const verbraucher = new Set(
    dto.outputs.map((k) => k.consumerId).filter((id): id is string => Boolean(id)),
  );
  return {
    verbraucher: verbraucher.size,
    belegt: dto.outputs.filter((k) => k.consumerId).length,
    ausgaenge: dto.outputs.length,
    eingaenge: dto.inputs.length,
  };
}

/**
 * Der Satz der Modul-Bühne: WAS gerade eingeschaltet ist. Wie viele
 * Verbraucher angeschlossen sind, sagt die Zahl darüber, die Belegung der
 * Klemmenplan darunter - der Satz wiederholt keins von beiden.
 *
 * ⚠ Nur aus einer AKTUELLEN Meldung: ein veralteter oder unbekannter Zustand
 * behauptet nichts (wie alt er ist, sagt der Klemmenplan). „Alle aus" steht
 * nur, wenn JEDER belegte Ausgang gemeldet ist.
 */
export function ioBelegungSatz(dto: IoModulZustandDto | null, now: number): string | null {
  const b = ioBelegung(dto);
  if (!dto || !b) return null;
  if (b.ausgaenge === 0) return `${b.eingaenge} Eingänge, keine Ausgänge gemeldet.`;
  if (b.belegt === 0) return b.ausgaenge === 1 ? 'Der Ausgang ist frei.' : `Alle ${b.ausgaenge} Ausgänge sind frei.`;
  const at = dto.receivedAt ? Date.parse(dto.receivedAt) : Number.NaN;
  if (!Number.isFinite(at) || now - at > VERALTET_MS) return null;
  const an = new Map<string, string>();
  let gemeldet = 0;
  for (const k of dto.outputs) {
    if (!k.consumerId || k.on == null) continue;
    gemeldet += 1;
    if (k.on) an.set(k.consumerId, k.consumerName?.trim() || 'Verbraucher');
  }
  if (an.size > 0) return `Eingeschaltet: ${[...an.values()].join(', ')}.`;
  if (gemeldet < b.belegt) return null;
  return b.verbraucher === 1
    ? 'Der angeschlossene Verbraucher ist gerade aus.'
    : `Alle ${b.verbraucher} Verbraucher sind gerade aus.`;
}
