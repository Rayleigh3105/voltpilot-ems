import ref from '../../../../docs/contracts/v2/uems-referenzunternehmen.json';
import type { Netzanschluss } from '../api';
import { FIXTURE_IDS } from './standorteFixtures';

/** Ausschließlich Ahrenberg; künstlich sind nur die technischen IDs. */
export function ahrenbergNetzanschluesse(): Netzanschluss[] {
  const anlagen: Record<string, string> = { 'AN-1': FIXTURE_IDS.an1, 'AN-2': FIXTURE_IDS.an2, 'AN-3': FIXTURE_IDS.an3 };
  return ref.netzanschluesse.map((n) => {
    const a = ref.anlagen.find((a) => a.netzanschluss === n.kennzeichen)!;
    return {
      id: `na-${n.kennzeichen}`,
      kennzeichen: n.kennzeichen,
      name: n.name,
      standort: { id: n.standort === 'ST-1' ? FIXTURE_IDS.st1 : FIXTURE_IDS.st2, kurzzeichen: n.standort },
      malo: n.malo,
      netzbetreiber: n.netzbetreiber,
      anschluss_kva: n.anschluss_kva,
      vereinbart_kw: n.vereinbart_kw,
      messung: 'RLM',
      gueltig_ab: null,
      gueltig_bis: null,
      hinweise: [],
      angelegt_am: '2026-10-01T00:00:00+02:00',
      anlagen: [
        {
          id: `bindung-${a.kennzeichen}`,
          anlage: { id: anlagen[a.kennzeichen], name: a.name },
          gueltig_ab: a.seit.slice(0, 10),
          gueltig_bis: null,
        },
      ],
    };
  });
}
