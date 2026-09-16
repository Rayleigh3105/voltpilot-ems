import './rollen-fixture';
import ReactDOM from 'react-dom/client';
import { api, ApiError, type ErsatzwertEingabe, type KorrekturDetail } from '../src/api';
import { WerteSektion } from '../src/components/WerteSektion';
import { MessstellenPage } from '../src/pages/MessstellenPage';
import { RechteStandort } from '../src/rollen';
import { korrekturDetail, korrekturQuellen, korrekturVorschau, LUECKE } from '../src/test/korrekturFixtures';
import { f8Tag, f8Stunden, f8Viertelstunden } from '../src/test/werteKarteFixtures';
import { ahrenbergRegister } from '../src/test/messstellenRegisterFixtures';
import { FIXTURE_IDS } from '../src/test/standorteFixtures';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

// Die echten Portal-Komponenten mit API-Antworten aus Ahrenberg; kein nachgebauter Dialog.
const params = new URLSearchParams(location.search);
let detail = korrekturDetail(params.has('ersteller'), params.has('frei') ? 'freigegeben' : 'vorschlag');
const schreiben: unknown[] = [], vorschauen: ErsatzwertEingabe[] = [];
let fehler = params.has('konflikt');
Object.assign(window, { korrekturSchreiben: schreiben, korrekturVorschauen: vorschauen });
function entscheidung(status: KorrekturDetail['status'], grund: string) {
  if (fehler) { fehler = false; throw new ApiError(409, 'Die Werte haben sich inzwischen geändert. Bitte neu laden.', { code: 'status_passt_nicht' }); }
  schreiben.push({ status, grund }); detail = korrekturDetail(false, status); return detail;
}
Object.assign(api, {
  messstellenRegister: async () => ahrenbergRegister({ stichtag: '2026-11-06' }),
  uemsGeraete: async () => ({ geraete: [] }), datenquellen: async () => ({ datenquellen: [] }),
  korrekturen: async () => [detail], korrektur: async () => detail,
  ersatzwertLuecken: async () => [LUECKE],
  ersatzwertVorschau: async (_: string, e: ErsatzwertEingabe) => { vorschauen.push(e); return korrekturVorschau(); },
  ersatzwertErfassen: async (_: string, e: ErsatzwertEingabe) => { schreiben.push(e); return korrekturDetail(true); },
  korrekturFreigeben: async (_: string, grund: string) => entscheidung('freigegeben', grund),
  korrekturAblehnen: async (_: string, grund: string) => entscheidung('abgelehnt', grund),
  korrekturZuruecknehmen: async (_: string, grund: string) => entscheidung('zurueckgenommen', grund),
  ersatzwertZuruecknehmen: async (_: string, grund: string) => { entscheidung('zurueckgenommen', grund); return { kennung: 'EW-2026-0003', fassung: 2, status: 'zurueckgenommen', korrektur: detail.kennung }; },
  messstelleWerte: async (_: string, raster: string) => {
    const w = raster === 'tag' ? f8Tag() : raster === 'stunde' ? f8Stunden() : f8Viertelstunden();
    if (raster === 'tag') Object.assign(w.werte[0], { menge: 1344, zustand: 'unvollständig', kennzeichen: [], erhalten: 841, abdeckung_prozent: 58 });
    else w.werte.forEach(x => { if (Date.parse(x.von) >= Date.parse(LUECKE.von)) Object.assign(x, { menge: null, zustand: 'keine Werte', kennzeichen: [], erhalten: 0, abdeckung_prozent: 0 }); });
    // Der Marker der Box-Tausch-Geschichte F11 führt in die Methodenwahl mit 1872 kWh.
    w.werte.forEach(x => { x.ereignisse = x.ereignisse.map(ev => ({ ...ev, id: LUECKE.id, von: LUECKE.von, bis: LUECKE.bis })); });
    return w;
  },
});
ReactDOM.createRoot(document.getElementById('root')!).render(<RechteStandort.Provider value={FIXTURE_IDS.st1}>
  <main style={{ maxWidth: 1080, margin: '0 auto', padding: '24px 16px' }}>
    {params.has('liste') ? <MessstellenPage ebene={{ art: 'standort', id: FIXTURE_IDS.st1, name: 'Werk Ahrenberg' }} bereichDa zone="Europe/Berlin" />
    : <WerteSektion kennzeichen="MS-10" messstelle="MS-10 · Netzbezug Halle 2" kopf={<h1>Netzbezug Halle 2</h1>} anfang={{ art: 'tag', wert: '2026-11-03' }} heute="2026-11-06" standortName="Werk Ahrenberg"
      korrekturKontext={{ standort: FIXTURE_IDS.st1, quellen: korrekturQuellen(), einheit: 'kWh' }} />}
  </main>
</RechteStandort.Provider>);
