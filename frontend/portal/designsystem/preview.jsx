// Documentation entry only; renders the current shared components with fictional values.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from './components/core/Button';
import { Badge } from './components/core/Badge';
import { Card } from './components/core/Card';
import { Icon } from './components/core/Icon';
import { IconTile } from './components/core/IconTile';
import { Stat } from './components/core/Stat';
import { Input } from './components/forms/Input';
import { Switch } from './components/forms/Switch';

function Buttons() {
  return <><p className="label">Aktionen</p><div className="group">
    <Button>Speichern</Button><Button variant="outline">Details</Button>
    <Button variant="ghost">Abbrechen</Button><Button disabled>Deaktiviert</Button>
  </div><div className="group">{['sm', 'md', 'lg'].map(size => <Button key={size} size={size}>{size}</Button>)}
    <Button iconRight={<Icon name="chevron-right" size={18} />}>Weiter</Button>
  </div><div className="onhero group"><Button variant="white">Öffnen</Button><Button variant="outline-light">Kontakt</Button></div>
  <p className="label">Status</p><div className="group"><Badge variant="ok" dot>Verbunden</Badge><Badge variant="warn">Daten veraltet</Badge><Badge variant="off">Inaktiv</Badge></div></>;
}
function Cards() {
  return <><div className="grid">{[['solar', 'sun', 'PV-Erzeugung'], ['battery', 'battery', 'Speicher'], ['ev', 'zap', 'Ladepunkt']].map(([category, icon, title]) =>
    <Card key={category} accent={category}><IconTile category={category} size={56}><Icon name={icon} size={28} /></IconTile><h4>{title}</h4><p className="body">Messwerte und Zustand prüfen.</p></Card>)}</div>
    <div className="stats"><Stat value="8,2 kW" label="PV-Leistung · Beispiel" /><Stat value="24 kWh" label="Erzeugung heute · Beispiel" /></div></>;
}
function Forms() {
  const [on, setOn] = React.useState(true);
  return <div className="grid"><div className="stack"><Input label="E-Mail" type="email" placeholder="name@firma.de" /><Input label="PLZ" error="Bitte gültige PLZ eingeben" /></div>
    <div className="stack"><Input label="Firma" placeholder="Musterfirma GmbH" /><Switch checked={on} onChange={() => setOn(!on)} label="Dynamischer Tarif" /></div></div>;
}
const root = document.getElementById('root');
const View = { buttons: Buttons, cards: Cards, forms: Forms }[root.dataset.preview];
createRoot(root).render(<View />);
