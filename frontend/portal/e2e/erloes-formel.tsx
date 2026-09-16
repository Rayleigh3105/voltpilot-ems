import './rollen-fixture';
import ReactDOM from 'react-dom/client';

import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';
import '../src/components/Erloese.css';

import { Card } from '../designsystem/components/core/Card';
import { Icon } from '../designsystem/components/core/Icon';
import { SteuerungFormel } from '../src/components/SteuerungFormel';
import type { SteuerungFormelInput } from '../src/erloesKomposition';

/**
 * Die Erlös-Karte des Captain-Screenshots (01.09.2026), einmal je Tarif-Lage.
 * Sie misst genau das, was die Abnahme fordert: der Aufklapper kostet
 * zugeklappt EINE Zeile, und nichts läuft am Telefon über den Rand.
 */
const FAELLE: Array<{ id: string; titel: string; input: SteuerungFormelInput }> = [
  {
    id: 'dv',
    titel: 'Direktvermarktung · dynamischer Tarif · Prämie 0',
    input: {
      tarifArt: 'dynamisch',
      tarifParamCtKwh: 18,
      tarifPriced: true,
      bezugspreisCtKwh: 32.5,
      plantKind: 'direktvermarktung',
      marktpraemieEur: 0,
      anzulegenderWertCtKwh: 6.9,
      marketValueSolarCtKwh: 7.0,
      bestandSichtbar: true,
    },
  },
  {
    id: 'fest',
    titel: 'Eigenverbrauch · fester Tarif',
    input: { tarifArt: 'fest', tarifParamCtKwh: 30, tarifPriced: true, bezugspreisCtKwh: 30, bestandSichtbar: true },
  },
  { id: 'ohne', titel: 'Ohne hinterlegten Stromtarif', input: { tarifArt: 'ohne' } },
  { id: 'portfolio', titel: 'Portfolio · mehrere Anlagen', input: { tarifneutral: true } },
];

function ErloesKarte({ id, titel, input }: { id: string; titel: string; input: SteuerungFormelInput }) {
  return (
    <Card padding="lg" radius="lg" className="vp-erg-karte" data-fall={id} style={{ marginBottom: 16, minWidth: 0 }}>
      <p style={{ margin: 0, fontSize: '0.8rem', fontWeight: 700, color: '#718096' }}>{titel}</p>
      <p style={{ margin: '6px 0 0', fontSize: '1.9rem', fontWeight: 800 }}>+ 12,73 €</p>
      <p className="vp-erg-satz">
        Di., 01.09.2026: So viel hat Ihre Anlage unterm Strich eingebracht.
      </p>
      <p className="vp-erg-steering vp-erg-steering-ok">
        <Icon name="zap" size={14} aria-hidden="true" />
        davon 3,73 € durch VoltPilots Steuerung
      </p>
      <SteuerungFormel input={input} />
      {input.bestandSichtbar && (
        <p className="vp-erg-bestand">
          <span className="vp-erg-bestand-satz">
            <Icon name="battery" size={14} aria-hidden="true" />
            dazu 28,0 kWh im Speicher für später · Planwert 5,29 €
          </span>
          <span className="vp-erg-bestand-badge">Geplant</span>
        </p>
      )}
    </Card>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <div style={{ padding: 16, minWidth: 0 }}>
    {FAELLE.map((f) => (
      <ErloesKarte key={f.id} {...f} />
    ))}
    {/* Die SCHMALE Cockpit-Schiene: sie ist auch bei 1440 px keine 300 px
        breit - dort muss die Erklaerung einspaltig umbrechen. */}
    <div data-fall="schiene" style={{ width: 288, minWidth: 0 }}>
      <Card padding="md" radius="lg" style={{ minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: '0.8rem', fontWeight: 700, color: '#718096' }}>
          Schmale Schiene (288 px)
        </p>
        <p style={{ margin: '4px 0 0', fontSize: '1.9rem', fontWeight: 800 }}>+ 12,73 €</p>
        <SteuerungFormel input={FAELLE[0].input} />
      </Card>
    </div>
  </div>,
);
