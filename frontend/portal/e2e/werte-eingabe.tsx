import './rollen-fixture';
import ReactDOM from 'react-dom/client';
import { api, ApiError } from '../src/api';
import { RechteStandort } from '../src/rollen';
import { BezugsgroessenPage } from '../src/pages/BezugsgroessenPage';
import { MessstelleSeite } from '../src/pages/MessstelleSeite';
import { ahrenbergBezugsgroessen, ahrenbergProzesse, ahrenbergKostenstellen } from '../src/test/kennzahlAnlegenFixtures';
import { ahrenbergUnternehmen, ahrenbergHeute, FIXTURE_IDS } from '../src/test/standorteFixtures';
import { ortsbaumAhrenberg, ortsbaumLindach } from '../src/test/ortsbaumFixtures';
import { ahrenbergRegister } from '../src/test/messstellenRegisterFixtures';
import { ms21, prozesseVon, verteilungVon, protokollMs06 } from '../src/test/messstelleSeiteFixtures';
import { quellenDerMessstellenBuehne } from '../src/test/messstelleQuellenFixtures';
import { bezugswert, gasAblesungen, BEZUG_PERSON } from '../src/test/werteEingabeFixtures';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';
const params = new URLSearchParams(location.search);
let werte = params.has('leer') ? [] : [bezugswert()];
let ablesungen = gasAblesungen().slice(0, 1);
const posts: unknown[] = []; Object.assign(window, { wertAufrufe: posts });
const antwort = (wert: string) => {
  const w = bezugswert(wert.replaceAll('.', '').replace(',', '.'), 2); w.fassungen.unshift(...werte.flatMap(w => w.fassungen));
  if (params.has('vier')) { const alt = werte[0]; alt.vorschlag = { kennung: 'BK-2026-0001', betrag: w.wirksamer_betrag!, ersetzt_fassung: 1, begruendung: 'Tippfehler — eine Null fehlte', urheber: BEZUG_PERSON, eingetragen_am: '2026-11-03T10:00:00Z' }; return { urteil: 'vorschlag', satz: 'Vorschlag gesendet — bis zur Freigabe gilt der bisherige Wert.', kennung: alt.vorschlag.kennung, hinweise: [], wert: alt }; }
  werte = [w]; return { urteil: 'berichtigung', satz: 'Wert gespeichert.', kennung: null, hinweise: [], wert: w };
};
Object.assign(api, {
  bezugsgroessen: async () => ({ bezugsgroessen: ahrenbergBezugsgroessen().bezugsgroessen.filter(b => b.kennzeichen === 'BZ-2'), bezugsflaechen: [] }),
  unternehmen: async () => ahrenbergUnternehmen(), standorte: async () => ahrenbergHeute(),
  standortOrte: async (id: string) => id === FIXTURE_IDS.st1 ? ortsbaumAhrenberg() : ortsbaumLindach(),
  prozesse: async () => ({ prozesse: ahrenbergProzesse() }), kostenstellen: async () => ({ kostenstellen: ahrenbergKostenstellen() }),
  messstellenRegister: async () => ahrenbergRegister(),
  bezugsgroesseWerte: async () => ({ werte }),
  bezugswertEingeben: async (id: string, body: { wert: string }) => { posts.push({ id, ...body }); const w = bezugswert(body.wert.replaceAll('.', '').replace(',', '.')); werte = [w]; return { urteil: 'neu', satz: 'Wert gespeichert.', kennung: null, hinweise: [], wert: w }; },
  bezugswertBerichtigen: async (id: string, periode: string, body: { wert: string }) => { posts.push({ id, periode, ...body }); return antwort(body.wert); },
  messstelle: async () => ms21(), messstelleProzesse: async () => prozesseVon(ms21()), messstelleVerteilung: async () => verteilungVon(ms21()),
  messstelleQuellen: async () => quellenDerMessstellenBuehne(ms21().id, '2026-11-03T10:00:00Z'),
  messstelleAenderungen: async () => ({ ...protokollMs06(), eintraege: [] }),
  uemsGeraete: async () => ({ geraete: [] }), datenquellen: async () => ({ datenquellen: [] }),
  messstelleWerte: async () => { throw new ApiError(404, 'Keine Datenquelle', { code: 'keine_quelle' }); },
  ablesungen: async () => ablesungen,
  ablesungEintragen: async (kz: string, body: { zeitpunkt: string; stand: string; zuordnung_monat: string | null }) => {
    posts.push({ kz, ...body }); const a = { ...gasAblesungen()[1], zeitpunkt: body.zeitpunkt, stand: Number(body.stand.replaceAll('.', '').replace(',', '.')), monat: body.zuordnung_monat ? `${body.zuordnung_monat}-01` : null }; ablesungen = [...ablesungen, a];
    return { urteil: 'eingetragen', korrektur: null, ablesung: a, ablesezeitraum: { menge: 1240, zustand: 'vollständig', kennzeichen: 'Ablesezeitraum 01.10. 07:15 – 02.11. 07:40 (Zuordnung durch den Kunden)' } };
  },
  ablesungBerichtigen: async (kz: string, zeit: string, body: { stand: string; zuordnung_monat: string | null }) => {
    posts.push({ kz, zeit, ...body }); return { urteil: 'vorschlag', korrektur: 'K-2026-0001', ablesung: ablesungen.find(a => a.zeitpunkt === zeit), ablesezeitraum: null };
  },
});
ReactDOM.createRoot(document.getElementById('root')!).render(<main style={{ maxWidth: 1100, margin: '0 auto', padding: 16 }}><RechteStandort.Provider value={FIXTURE_IDS.st1}>{params.has('ablesung') ? <MessstelleSeite id={ms21().id} onListe={() => {}} /> : <BezugsgroessenPage />}</RechteStandort.Provider></main>);
