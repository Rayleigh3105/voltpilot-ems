import type { Ablesung, BezugsgroesseWert } from '../api';
import ref from '../../../../docs/contracts/v2/uems-referenzunternehmen.json';
export const BEZUG_PERSON = { name: 'Ines Kaltenbach', rolle: 'energiemanager', art: 'kunde' as const };
export function bezugswert(betrag = '4820', fassung = 1): BezugsgroesseWert {
  return { periode_von: '2026-10-01', periode_bis: '2026-10-31', zeitpunkt: null, zeitzone: 'Europe/Berlin', wirksamer_betrag: betrag, wirksame_fassung: fassung, stand_offen: false, vorschlag: null,
    fassungen: [{ fassung, vorgang: fassung === 1 ? 'erstwert' : 'berichtigung', status: 'wirksam', stand: 'endgueltig', betrag, ersetzt_fassung: fassung === 1 ? null : 1, begruendung: fassung === 1 ? null : 'Tippfehler — eine Null fehlte', kennzeichen: [], herkunft: { art: 'eingabe', von_hand: true, import_kennung: null, import_zeile: null, geliefert_text: null, geliefert_einheit: null }, urheber: BEZUG_PERSON, freigeber: null, eingetragen_am: '2026-11-03T09:20:00+01:00' }] };
}
export function gasAblesungen(): Ablesung[] {
  const ms = ref.messstellen.find(m => m.kennzeichen === 'MS-21')!;
  return ms.ablesungen!.map(a => ({ quelle: 'ablesung-ms21', zeitpunkt: a.zeitpunkt, stand: a.stand, monat: a.zuordnung_monat ? `${a.zuordnung_monat}-01` : null, fassung: 1, woher: 'eingabe', urheber: { name: 'Jonas Wendlinger', rolle: 'kundenadministrator' }, korrektur: null, eingetragen_am: a.zeitpunkt }));
}
