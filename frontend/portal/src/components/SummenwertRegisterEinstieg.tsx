import { Button } from '../../designsystem/components/core/Button';
import { SUMMENWERT } from '../glossar';
import { Recht } from './Recht';
import { VpPicker } from './VpPicker';
import { useSummenwertAssistent } from './SummenwertAssistent';

/** Das Register führt in denselben Anlagen-Assistenten wie Verlauf und Gerätekarte. */
export function SummenwertRegisterEinstieg({ anlagen, gewaehlt, onGespeichert }: {
  anlagen: { value: string; label: string }[]; gewaehlt: string | null; onGespeichert: () => void;
}) {
  const { oeffneSummenwertAssistent, assistent } = useSummenwertAssistent();
  const id = gewaehlt ?? (anlagen.length === 1 ? anlagen[0].value : null);
  const oeffne = (siteId: string) => oeffneSummenwertAssistent({ siteId, kontext: { art: 'anlage' }, onGespeichert });
  return <><Recht aktion="messstelle.formel">{id ? <Button variant="outline" onClick={() => oeffne(id)}>{SUMMENWERT} anlegen</Button>
    : anlagen.length > 1 ? <VpPicker label={`${SUMMENWERT} anlegen in`} value="" options={anlagen} onChange={oeffne} /> : null}</Recht>{assistent}</>;
}
