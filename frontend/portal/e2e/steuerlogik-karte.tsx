import './rollen-fixture';
import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { api, ApiError, type SteuerlogikKarte, type SteuerlogikVerlauf } from '../src/api';
import { keycloak } from '../src/auth';
import { LogikKarte } from '../src/steuerung/LogikKarte';
import { LogikBlatt } from '../src/steuerung/LogikBlatt';
import gepinnt from '../../../docs/contracts/v2/examples/steuerlogik-karte.valid.wasser.json';
import winter from '../../../docs/contracts/v2/examples/steuerlogik-karte-saetze.heizung-winter.json';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';
import '../src/steuerung/steuerung.css';

(keycloak as unknown as { token: string }).token = 'e2e-token';
(keycloak as unknown as { updateToken: () => Promise<boolean> }).updateToken = async () => false;

/**
 * E2E-Bühne „Steuerlogik-Karte“ (Stufe 3): die Karte einer scharfen Logik im Reiter „Geräte“ und ihr Blatt „Warum?“.
 * `?stand=wasser` ist die Antwort der API Byte für Byte (`steuerlogik-karte.valid.wasser.json`, gepinnt von
 * `SteuerlogikScharfApiTest` aus dem Block der Box und der Antwort des Dienstes). `?stand=winter` zeigt die Karte
 * „Heizung“ des Heizungs-Beispiels mit dem Schalter „Winterregelung“: Lage, Hilfesatz und Gerät aus einem Lauf
 * (`steuerlogik-karte-saetze.heizung-winter.json`), also mit denselben Zahlen; `?stand=stoerung` einen Fühler ohne
 * Wert, `?stand=haelt` eine Logik, die auf der Box nicht läuft, `?stand=leser` eine Person ohne Recht zum Ändern.
 * Fiktive Daten.
 */
const stand = new URLSearchParams(window.location.search).get('stand') ?? 'wasser';
const JETZT = new Date('2026-11-14T09:08:00Z');

function karteFuer(s: string): SteuerlogikKarte {
  const k = structuredClone(gepinnt) as unknown as SteuerlogikKarte;
  if (s === 'winter') {
    // Lage, Hilfesatz der Winterregelung und Gerät aus EINEM Lauf des Heizungs-Beispiels (gepinnt von
    // edge-app/core/internal/logik/karte_saetze_test.go): beide Sätze tragen dieselben Werte von jetzt.
    const w = winter.winter;
    k.name = winter.logik;
    k.lage = winter.lage as SteuerlogikKarte['lage'];
    k.stellwerte = [{
      kennung: w.kennung, name: w.name, art: 'boolean', einheit: null, von: null, bis: null, schritt: null,
      optionen: null, zielwert: false, darf: 'customer', wert: w.wert, wertBox: w.wert, text: w.text, hilfe: w.hilfe,
      frei: true, aendern: true, uebernommen: true,
    }];
    const stand = { stufe: winter.geraet.stufe };
    k.geraete = k.geraete.slice(0, 1).map((g) => ({ ...g, kennung: winter.geraet.kennung, name: winter.geraet.name,
      ist: stand, befehl: stand, wunsch: stand, schutz: null }));
    k.warum = null;
  }
  if (s === 'stoerung') {
    k.lage = { nr: 1, titel: 'Störung Fühler', art: 'fault', satz: 'Der Fühler liefert keinen Wert. Der Heizstab bleibt aus.' };
    k.stoerungen = [{ code: 'lage', text: 'Störung Fühler' }, { code: 'wert_fehlt', text: 'Ohne Wert: Speicher.' }];
    k.geraete = k.geraete.map((g) => ({ ...g, ist: { stufe: 0 }, befehl: { stufe: 0 }, wunsch: { stufe: 0 }, schutz: null }));
  }
  if (s === 'haelt') {
    k.lage = null;
    k.gemeldetAm = null;
    k.warum = null;
    k.stoerungen = [{ code: 'haelt_an', text: 'Die Logik läuft auf der Box nicht. Ihre Geräte schalten gerade nicht nach ihr.' }];
    k.geraete = k.geraete.map((g) => ({ ...g, ist: null, befehl: null, wunsch: null, schutz: null }));
  }
  if (s === 'leser') k.stellwerte = k.stellwerte.map((w) => ({ ...w, aendern: false }));
  return k;
}

const verlauf: SteuerlogikVerlauf = {
  logikId: gepinnt.logikId,
  tag: '2026-11-14',
  wechsel: [
    { box: 'b', fassung: 1, laufSeit: '2026-11-14T09:00:00Z', nr: 1, t: '2026-11-14T09:02:02Z', geraet: 'heizstab', was: 'ist', neu: { stufe: 3 }, andere: { stufe: 3 }, lage: 'Heizt aus dem Netz' },
    { box: 'b', fassung: 1, laufSeit: '2026-11-14T09:00:00Z', nr: 2, t: '2026-11-14T09:07:05Z', geraet: 'heizstab', was: 'wunsch', neu: { stufe: 0 }, andere: { stufe: 3 }, lage: 'Wartet auf Sonnenstrom' },
  ],
  schritte: [
    { fassung: 1, was: 'stellwert', am: '2026-11-14T08:55:00Z', von: 'Jonas Wendlinger', rolle: 'kundenadministrator', daten: { kennung: 'mindest', name: 'Nie kälter als', alt: '40 °C', neu: '42 °C', stand: 1 } },
    { fassung: 1, was: 'scharf', am: '2026-11-14T09:00:00Z', von: 'VoltPilot Betrieb', rolle: 'voltpilot_betrieb', daten: null },
  ],
};

const gesendet: { kennung: string; wert: unknown }[] = [];
(window as unknown as { gesendet: typeof gesendet }).gesendet = gesendet;
const ok = <T,>(wert: T) => () => Promise.resolve(structuredClone(wert));
const belegt: Record<string, (...args: never[]) => Promise<unknown>> = {
  siteSteuerlogikVerlauf: ok(verlauf),
  siteSteuerlogikWert: ((_site: string, _logik: string, kennung: string, wert: unknown) => {
    gesendet.push({ kennung, wert });
    return Promise.resolve({ logikId: gepinnt.logikId, kennung, wert, stand: gesendet.length + 1, veroeffentlicht: true });
  }) as never,
};
const offen = api as unknown as Record<string, unknown>;
for (const [name, wert] of Object.entries(offen)) {
  if (typeof wert !== 'function') continue;
  offen[name] = belegt[name] ?? (() => Promise.reject(new ApiError(404, `E2E-Bühne: ${name} ist nicht belegt`)));
}

function Buehne() {
  const [karte, setKarte] = useState(() => karteFuer(stand));
  const [blatt, setBlatt] = useState(new URLSearchParams(window.location.search).get('blatt') === '1');
  const stelle = async (kennung: string, wert: unknown) => {
    await api.siteSteuerlogikWert('site-1', karte.logikId, kennung, wert);
    setKarte((k) => ({ ...k, stand: k.stand + 1, stellwerte: k.stellwerte.map((s) => (s.kennung === kennung ? { ...s, wert, uebernommen: false } : s)) }));
  };
  return (
    <div className="stn" style={{ maxWidth: 1180, margin: '0 auto', padding: '0 16px' }}>
      <div className="stn-main steuerung">
        <LogikKarte karte={karte} jetzt={JETZT} sendet={null} onWarum={() => setBlatt(true)} onSchalter={(k, an) => void stelle(k, an ? 'on' : 'off')} />
      </div>
      {blatt && <LogikBlatt siteId="site-1" karte={karte} jetzt={JETZT} onClose={() => setBlatt(false)} onStelle={stelle} />}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Buehne />
  </React.StrictMode>,
);
