import type { ControllerwechselVorschau } from '../api';
import { c1 } from './geraetHerkunftFixtures';
export const CONTROLLER_AM = '2027-02-05T14:00:00+01:00';
export function controllerVorschau(): ControllerwechselVorschau {
  const g = c1();
  return { zeitpunkt: CONTROLLER_AM, karten: g.teile!.map(k => ({ id: k.id, steckplatz: k.steckplatz, bezeichnung: k.bezeichnung, typ: k.typ, seriennummer: k.seriennummer })),
    folgen: g.komponenten.map((k, i) => ({ bindung: `q-${i}`, karte: g.teile![i].id, komponente: k.entity_id,
      messstelle: `ms-${i + 10}`, kennzeichen: `MS-${i + 10}`, groesse: 'Wirkenergie', richtung: 'Bezug', rolle: 'fuehrend', einheit: 'kWh', zaehlerstand: true })) };
}
