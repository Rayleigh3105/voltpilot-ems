import './rollen-fixture';
/**
 * UEMS EZ-15: der Anlege-Schritt „Steuerung verbinden“ mit erfundenen Daten; alle Aufrufe bleiben im Speicher.
 * `?fall=gore` zeigt eine PV-Anlage mit drei Wechselrichtern, `?fall=fremd` ein fremdes Registerbild,
 * `?fall=steht` einen stehenden Herzschlag; ohne Fall zwei BHKW-Motoren.
 */
import ReactDOM from 'react-dom/client';
import { api, type Device, type NetzVermarktung, type UemsDatenquelle, type UemsDatenquellePruefergebnis } from '../src/api';
import { anlagensteuerungApi } from '../src/anlagensteuerungApi';
import type { ErzeugerKopf } from '../src/anlagensteuerungAssistent';
import { AnlagensteuerungAssistent } from '../src/components/AnlagensteuerungAssistent';
import { ueberwachungApi } from '../src/ueberwachungApi';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

const fall = new URLSearchParams(location.search).get('fall') ?? 'bhkw';
const SITE = { id: 'anlage-lindenhof', name: fall === 'gore' ? 'Solarpark Lindenhof' : 'Biogas Lindenhof' };
const BOX = { id: 'box-1', kind: 'edge', siteId: SITE.id, name: 'VP-7Q4K · Maschinenraum', externalRef: 'VP-7Q4K' } as Device;

const BHKW: ErzeugerKopf = {
  signatur_ok: true, erkannt: true, hauptversion: 1, nebenversion: 0, te_anzahl: 2, herzschlag: 500,
  programmstand: 2610, steuerung_id: 0xa1b2, anlagenart: 2, beschreibung_ab: 140,
  einheiten: [
    { einheit: 1, art: 2, nenn_kw: 66, typ_name: 'MAN E0836LE' },
    { einheit: 2, art: 2, nenn_kw: 33, typ_name: 'KW Energie Smartblock 33' },
  ],
  netzbetreiber_name: 'N-ERGIE Netz GmbH',
  direktvermarkter_name: 'WVV (Stadtwerke Würzburg)',
};
const PV: ErzeugerKopf = {
  signatur_ok: true, erkannt: true, hauptversion: 1, nebenversion: 0, te_anzahl: 3, herzschlag: 40,
  programmstand: 2610, steuerung_id: 0x1c4, anlagenart: 1, beschreibung_ab: 140,
  einheiten: [1, 2, 3].map((n) => ({ einheit: n, art: 1 as const, nenn_kw: 125, typ_name: 'Growatt MAX 125KTL3-X' })),
  netzbetreiber_name: 'N-ERGIE Netz GmbH',
  direktvermarkter_name: '',
};
const FREMD: ErzeugerKopf = { signatur_ok: false, erkannt: false, grund: 'signatur_fremd' };

let lesung = 0;
function antwort(): UemsDatenquellePruefergebnis {
  lesung += 1;
  const kopf = fall === 'fremd' ? FREMD : fall === 'gore' ? PV : BHKW;
  const herz = fall === 'steht' ? kopf.herzschlag : (kopf.herzschlag ?? 0) + 2 * lesung;
  return {
    ergebnis: kopf.erkannt ? 'ok' : 'invalid_response', gewertet: true, text: '', adresse: '192.168.4.165:502',
    zeitpunkt: new Date().toISOString(), dauer_ms: 38,
    antwort: { requestId: `r${lesung}`, results: [{ id: 'erreichbarkeit', ok: kopf.erkannt,
      erzeuger_kopf: kopf.erkannt ? { ...kopf, herzschlag: herz } : kopf }] },
  } as unknown as UemsDatenquellePruefergebnis;
}

const NV: NetzVermarktung = {
  site_id: SITE.id, netzbetreiber: 'N-ERGIE Netz GmbH', direktvermarkter: null, direktvermarkter_kanal: null,
  einspeisemanagement: null, einspeisemanagement_prozent: null,
  namen_aus_bild: { netzbetreiber: null, direktvermarkter: null, gelesen_am: null }, hinweise: [], revision: 0,
};

Object.assign(api, {
  datenquelleAnlegen: async () => ({ id: 'dq-3', kennzeichen: 'DQ-3' }) as UemsDatenquelle,
  datenquelleBearbeiten: async () => ({ id: 'dq-3', kennzeichen: 'DQ-3' }) as UemsDatenquelle,
  datenquellePruefen: async () => antwort(),
  datenquelleZuweisen: async () => ({ urteil: 'erlaubt', text: '', hinweis: null, vergleichsquelle: false }),
  anlagensteuerungen: async () => ({ einrichtung: { moeglich: true, grund: null, boxen: [{ device_id: BOX.id, faehig: true }] }, steuerungen: [] }),
  netzVermarktung: async () => NV,
});
Object.assign(anlagensteuerungApi, {
  anlegen: async (_site: string, body: { bezeichnung: string | null; einheiten: { te_nr: number; bezeichnung: string | null }[] }) => ({
    geraet_id: 'g-7', kennzeichen: 'G-7', bezeichnung: body.bezeichnung, entity_id: 'e-7',
    einheiten: body.einheiten.map((e) => ({ te_nr: e.te_nr, bezeichnung: e.bezeichnung })),
  }),
  namen: async () => NV,
});
Object.assign(ueberwachungApi, { anlegen: async () => ({}) });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <AnlagensteuerungAssistent site={SITE} boxen={[BOX]} onClose={() => {}} onFertig={() => {}} herzschlagAbstandMs={300} />,
);
