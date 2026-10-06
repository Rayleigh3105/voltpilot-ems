import './rollen-fixture';
import { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { api, ApiError, type Messbedarf } from '../src/api';
import { keycloak } from '../src/auth';
import { MessstellenPage } from '../src/pages/MessstellenPage';
import { ee8, mb1, messplanungRouten } from '../src/test/messplanungBuehne';
import { REGISTER_ORT_IDS } from '../src/test/messstellenRegisterFixtures';
import { FIXTURE_IDS } from '../src/test/standorteFixtures';
import { useEntscheidFokus } from '../src/useEntscheidFokus';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

(keycloak as unknown as { token: string }).token = 'e2e-token';
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;

/**
 * Bühne der geplanten Messstellen unter Messen (Konzept Auswerten a1, Entscheid 9): die ECHTE `MessstellenPage` am
 * Unternehmen mit dem Haken der Schale (`useEntscheidFokus`), die Routen von Messbedarf und Messstellen-Dialog aus
 * `messplanungBuehne.ts` (derselbe Weg Bedarf → Messstelle wie am Einsatz) und das Register des Referenzunternehmens
 * (heute 20.10.2026).
 *
 * Adresse: `?person=JW|PH|MD` (Vorgabe JW) · `&plan=zwei|leer` (Vorgabe zwei: MB-1 an Halle 1 mit Struktur, Frist
 * 31.03.2027; MB-2 ohne Ort, Frist 30.09.2026 überschritten) · `&beleg=1` (das Einlösen trifft den Belegschutz) ·
 * `&langsam=1` (das Einlösen antwortet erst nach dem Schließen) · der Hash ist die Route (`#/portfolio/messstellen`, mit
 * `?entscheid=messbedarf_frist&kennzeichen=MB-2` wie der Schritt der Wiedervorlage).
 */
const q = new URLSearchParams(window.location.search);
const halle1 = { id: REGISTER_ORT_IDS['G-1'], art: 'gebaeude' as const, kurzzeichen: 'G-1', name: 'Halle 1', standort_id: FIXTURE_IDS.st1, standort_name: 'Werk Ahrenberg' };
const bedarfe: Messbedarf[] =
  q.get('plan') === 'leer'
    ? []
    : [
        mb1({ ort_ziel: halle1, messgroesse: 'Wirkenergie', richtung: 'Bezug' }),
        mb1({
          id: 'mb000000-0000-4000-8000-000000000002',
          kennzeichen: 'MB-2',
          wortlaut: 'Druckluft-Leckagen Halle 2 messen',
          ort: null,
          groesse: null,
          frist: '2026-09-30',
        }),
      ];
const routen = messplanungRouten('2026-10-20', q.get('person') ?? 'JW', bedarfe);
// `&beleg=1`: zwei freigegebene Berichtsstände zitieren die Bedarfe - der Server lehnt das Einlösen ab (Belegschutz,
// Vertrag `bewertung.md`), mit dem Satz einer Komponente, wie er heute kommt.
const beleg = q.get('beleg')
  ? {
      messbedarfEinloesen: async () => {
        throw new ApiError(409, 'Dieser Messbedarf ist Beleg in 2 freigegebenen Berichtsständen (BR-2026-0002 Nr. 1, BR-2027-0001 Nr. 1). Löschen ist nicht möglich — beenden Sie die Bindung stattdessen.', {
          code: 'berichts_belege',
          codes: ['berichts_belege'],
          berichtsstaende: [{ kennung: 'BR-2026-0002', nr: 1 }, { kennung: 'BR-2027-0001', nr: 1 }],
          messstellen: [],
        });
      },
    }
  : {};
// `&langsam=1`: das Einlösen antwortet erst nach 4 s - wie ein Server, der noch schreibt, während der Kunde den
// Dialog schon schließt (der Bedarf wird erst dann eingelöst).
const langsam = q.get('langsam')
  ? {
      messbedarfEinloesen: async (...a: Parameters<typeof routen.messbedarfEinloesen>) => {
        await new Promise((r) => setTimeout(r, 4000));
        return routen.messbedarfEinloesen(...a);
      },
    }
  : {};
Object.assign(api, routen, beleg, langsam, {
  energieeinsaetze: async () => ({ energieeinsaetze: [ee8()] }),
  standortAusfall: async () => {
    throw new Error('nicht gestellt');
  },
});
if (!window.location.hash) window.history.replaceState(null, '', '#/portfolio/messstellen');

function Wirt() {
  useEntscheidFokus();
  const [, setHash] = useState(window.location.hash);
  useEffect(() => {
    const neu = () => setHash(window.location.hash);
    window.addEventListener('hashchange', neu);
    return () => window.removeEventListener('hashchange', neu);
  }, []);
  return <MessstellenPage ebene={{ art: 'unternehmen', name: 'Kunststoffwerk Ahrenberg GmbH' }} bereichDa />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 16, maxWidth: 1180, margin: '0 auto' }}>
    <Wirt />
  </main>,
);
