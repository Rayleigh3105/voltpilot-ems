import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Button } from '../designsystem/components/core/Button';
import { api } from '../src/api';
import { rechteAus } from '../src/berichtDialoge';
import { BerichtAnlegenDialog } from '../src/components/BerichtAnlegenDialog';
import { BerichtSeite } from '../src/pages/BerichtSeite';
import { setSelbstauskunft } from '../src/rollen';
import { selbstauskunftFuer } from '../src/test/berichtFixtures';
import { lvBuehne } from '../src/test/leistungsvergleichFixtures';
import { ahrenbergUnternehmen, werkAhrenberg } from '../src/test/standorteFixtures';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';
// Im Portal kommt `BerichtSeite` nur über `BerichtePage`, das diese Datei lädt (`.vp-br-dl`: einspaltig ≤ 640 px, Umbruch
// der Prüfsumme). Die Bühne hängt die Seite direkt ein und lädt sie darum selbst — sonst misst die Spec eine Seite ohne ihr CSS.
import '../src/pages/BerichtePage.css';

/**
 * Bühne des Leistungsvergleichs (UEMS AP-17 IP-24, R8): der ECHTE Dialog „Bericht anlegen“ und die ECHTE Berichtsseite
 * mit den Routen aus `src/test/leistungsvergleichFixtures.ts` — Ines Kaltenbach legt am 12.01.2028 den Leistungsvergleich
 * Dezember 2027 für KZ-0004 an, gibt ihn als Stand Nr. 1 frei und ruft das PDF ab. `window.__lv` zählt, was das Portal
 * schickte. Eigene Bühne, damit `startansicht` (und ihre Specs) unberührt bleibt.
 */
const zustand = { nr: null as number | null, anlegen: [] as unknown[], dateien: [] as string[] };
(window as unknown as { __lv: typeof zustand }).__lv = zustand;
const me = selbstauskunftFuer('Ines Kaltenbach');
setSelbstauskunft(me);
Object.assign(api, lvBuehne(zustand as Parameters<typeof lvBuehne>[0]), {
  standorte: async () => ({ standorte: [werkAhrenberg()] }),
  unternehmen: async () => ahrenbergUnternehmen(),
});

function Buehne() {
  const [offen, setOffen] = useState(false);
  const [kennung, setKennung] = useState<string | null>(null);
  return (
    <main className="vp-main" style={{ padding: 16 }}>
      {kennung ? (
        <BerichtSeite kennung={kennung} onListe={() => setKennung(null)} />
      ) : (
        <Button onClick={() => setOffen(true)}>Bericht anlegen</Button>
      )}
      <BerichtAnlegenDialog
        open={offen}
        onClose={() => setOffen(false)}
        rechte={rechteAus(me)}
        onAngelegt={(b) => {
          setOffen(false);
          setKennung(b.kennung);
        }}
        onOeffnen={(k) => {
          setOffen(false);
          setKennung(k);
        }}
      />
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Buehne />);
