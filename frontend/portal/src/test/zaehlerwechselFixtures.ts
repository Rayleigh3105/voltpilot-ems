/** Ahrenberg A1: derselbe Zeitpunkt für Bindungsende und -beginn; erste Telemetrie kommt später. */
import type { ZaehlerwechselVorgang } from '../api';
import { gr4Z5a, gr4Einstellungen, k5Kanaele } from './geraetHerkunftFixtures';
import { quellenMs06 } from './quelleBindenFixtures';
export const WECHSEL_JETZT = '2026-11-18T11:05:00+01:00';
export const WECHSEL_AM = '2026-11-18T10:40:00+01:00';
export const vorherGeraet = () => ({ ...gr4Z5a(), ausgebaut_am: null,
  komponenten: gr4Z5a().komponenten.map(k => ({ ...k, gueltig_bis: null })) });
export const wechselKanaele = () => ({ ...k5Kanaele(), messkanaele: k5Kanaele().messkanaele.map(k => ({ ...k,
  speist: k.speist?.map(s => ({ ...s, gueltig_ab: '2024-03-12T00:00:00+01:00' })) })) });
export const vorherEinstellungen = () => {
  const e = gr4Einstellungen();
  return { ...e, geraet_id: 'g-z5a', einbau: 'Z-5a', historie: e.historie.map(f => ({ ...f,
    gueltig_ab: '2024-03-12T00:00:00+01:00', gueltig_bis: null })) };
};
export function wechselAntwort(): ZaehlerwechselVorgang {
  const [alt, neu] = quellenMs06().quellen;
  const beendet = { ...alt, geraet: { ...alt.geraet, id: 'g-z5a' }, gueltig_bis: WECHSEL_AM,
    endstand: { wert: 1083415.2, einheit: 'kWh' }, status: 'beendet' as const };
  const quelle = { ...neu, geraet: { ...neu.geraet, id: 'g-z5b' }, gueltig_ab: WECHSEL_AM,
    anfangsstand: { wert: 0, einheit: 'kWh' }, letzter_wert: null, status: 'gilt' as const, rueckwirkend: true };
  return { geraet: {
    alt: { id: 'g-z5a', geraet: 'GR-4', einbau: 'Z-5a', seriennummer: '4471023', eingebaut_am: alt.gueltig_ab, ausgebaut_am: WECHSEL_AM },
    neu: { id: 'g-z5b', geraet: 'GR-4', einbau: 'Z-5b', seriennummer: '88231', eingebaut_am: WECHSEL_AM, ausgebaut_am: null },
    verbindung_neu: false }, komponenten: ['k-5'],
    bindungen: [{ messstelle: alt.messstelle_id, kennzeichen: 'MS-06', groesse: 'Wirkenergie', richtung: 'Bezug', rolle: 'fuehrend', beendet, neu: quelle }],
    einstellungen: [{ id: 'e-neu', art: 'wandlerverhaeltnis', komponente: null, kanal: null, anwendung: 'dokumentiert' }],
    marken: 1, rueckwirkung: { art: 'rueckwirkend', minuten: 25, abzeichen: 'rückwirkend (25 min)' }, hinweise: [] };
}
export function wechselQuellen(nachher: boolean) {
  const basis = quellenMs06(), v = wechselAntwort();
  const alt = { ...v.bindungen[0].beendet, gueltig_bis: null, endstand: null, status: 'gilt' as const,
    letzter_wert: { wert: 1083415.2, text: null, einheit: 'kWh', zeitpunkt: WECHSEL_AM } };
  const aktuell = nachher ? v.bindungen[0].neu : alt;
  return { ...basis, stichtag: WECHSEL_JETZT, quellen: nachher ? [v.bindungen[0].beendet, aktuell] : [alt],
    groessen: basis.groessen.map(g => ({ ...g, fuehrend: aktuell, zeitstrahl: nachher
      ? [{ von: alt.gueltig_ab, bis: WECHSEL_AM, quelle: alt.id }, { von: WECHSEL_AM, bis: null, quelle: aktuell.id }]
      : [{ von: alt.gueltig_ab, bis: null, quelle: alt.id }] })) };
}
