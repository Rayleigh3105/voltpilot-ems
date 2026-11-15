/**
 * Der Anfang einer neuen Logik (Steuerlogik Stufe 4): kein leeres Blatt, sondern eine kleine, vollständige Logik,
 * die die Prüfung besteht - ein Gerät läuft mit Sonnenstrom, der sonst ins Netz ginge. Von dort baut man im Aufbau
 * oder im Text weiter. Welchen Ausgang das Gerät bekommt, sagt der Logik-Dienst (`/quellen`: was die Box an ihm
 * ausführt).
 */
import type { LogikQuellen } from '../../api';
import { blockZeilen, skalar } from './text';

type Geraet = LogikQuellen['geraete'][number];

/** Der Ausgang, den das Gerät mit dem Zustand `sonnenstrom` bekommt. */
export function startAusgang(g: Geraet): Record<string, string> {
  if (g.ausgaenge.includes('on_off') && g.typ !== 'heat-pump-sgready') return { on_off: 'sonnenstrom' };
  if (g.ausgaenge.includes('level')) return { level: `if(sonnenstrom, ${g.ausgangszahl ?? 1}, 0)` };
  if (g.ausgaenge.includes('mode')) {
    const arten = g.betriebsarten ?? [];
    if (arten.includes('boost') && arten.includes('normal')) return { mode: 'if(sonnenstrom, boost, normal)' };
    if (arten.length) return { mode: arten[0] };
  }
  if (g.ausgaenge.includes('on_off')) return { on_off: 'sonnenstrom' };
  if (g.ausgaenge.includes('setpoint') && g.sollwert) {
    const e = g.sollwert.einheit;
    return { setpoint: `if(sonnenstrom, ${g.sollwert.bis ?? 0} ${e}, ${g.sollwert.von ?? 0} ${e})` };
  }
  return { on_off: 'sonnenstrom' };
}

/** Der Text einer neuen Logik mit einem Gerät. */
export function startText(name: string, g: Geraet): string {
  const geraet = g.name;
  const ausgang = startAusgang(g);
  const zeilen = [
    'logic: 1',
    `name: ${skalar(name)}`,
    `description: ${skalar(`Schaltet ${geraet} mit Sonnenstrom, der sonst ins Netz ginge.`)}`,
    '',
    'devices:',
    ...blockZeilen({ geraet: { entity: g.entity_id, name: geraet } }, 2),
    '',
    'inputs:',
    '  netz: {source: site.grid, name: Netzbezug, max_age: 60 s}',
    '',
    'settings:',
    '  ueberschuss: {name: Einschalten ab Einspeisung, default: 1 kW, range: [0.2 kW, 10 kW], step: 0.1 kW, editable_by: customer}',
    '',
    'states:',
    '  sonnenstrom:',
    '    type: boolean',
    '    on_when:',
    '      - Es wird seit 5 Minuten eingespeist: holds(netz < -ueberschuss, 5 min)',
    '    off_when_any:',
    '      - Strom kommt seit 2 Minuten aus dem Netz: holds(netz > 0.1 kW, 2 min)',
    '      - Der Netzbezug ist unbekannt: unknown(netz)',
    `    on_text: ${skalar(`${geraet} läuft mit Sonnenstrom`)}`,
    `    off_text: ${skalar(`${geraet} geht aus`)}`,
    '    after_restart: off',
    '',
    'outputs:',
    ...blockZeilen({ geraet: ausgang }, 2),
    '',
    'status:',
    '  - when: unknown(netz)',
    '    title: Kein Netzwert',
    '    type: fault',
    `    text: ${skalar(`Der Zähler am Netz liefert keinen Wert. ${geraet} bleibt aus.`)}`,
    '  - when: sonnenstrom',
    '    title: Läuft mit Sonnenstrom',
    '    type: solar',
    `    text: ${skalar(`${geraet} läuft, solange mehr als {ueberschuss} übrig sind.`)}`,
    '  - else: true',
    '    title: Wartet auf Sonnenstrom',
    '    type: waiting',
    `    text: ${skalar(`Sobald mehr als {ueberschuss} ins Netz gehen, schaltet ${geraet} ein.`)}`,
    '',
  ];
  return zeilen.join('\n');
}
