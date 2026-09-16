import { Button } from '../../designsystem/components/core/Button';
import type { MessstelleQuellenListe, MessstelleWerte } from '../api';
import { useRollen } from '../rollen';
import { ErsatzwertDialog } from './ErsatzwertDialog';
import { KorrekturenDialog } from './KorrekturenDialog';

export interface KorrekturKontext { standort: string; quellen: MessstelleQuellenListe; einheit: string }
export type KorrekturWahl = { art: 'ersatzwert' | 'korrekturen'; ereignis?: string };
export function KorrekturWerkzeuge({ kontext, werte, wahl, onOeffnen, onClose, onGespeichert }: {
  kontext: KorrekturKontext; werte: MessstelleWerte; wahl: KorrekturWahl | null;
  onOeffnen: (wahl: KorrekturWahl, ausloeser: HTMLElement) => void; onClose: () => void; onGespeichert: () => void;
}) {
  const rollen = useRollen();
  return <>
    <div className="vp-korr-aktionen" aria-label="Korrekturen und Ersatzwerte">
      {rollen.darf('ersatzwert.erfassen', kontext.standort) && kontext.quellen.quellen.some(q => q.rolle === 'fuehrend') &&
        <Button variant="outline" data-korrektur-fokus={`${werte.messstelle.kennzeichen}:ersatzwert`} onClick={e => onOeffnen({ art: 'ersatzwert' }, e.currentTarget)}>Ersatzwert eintragen</Button>}
      <Button variant="outline" data-korrektur-fokus={`${werte.messstelle.kennzeichen}:korrekturen`} onClick={e => onOeffnen({ art: 'korrekturen' }, e.currentTarget)}>Korrekturen</Button>
    </div>
    {wahl?.art === 'ersatzwert' && <ErsatzwertDialog kennzeichen={werte.messstelle.kennzeichen} name={werte.messstelle.name ?? ''}
      {...kontext} von={werte.von} bis={werte.bis} zone={werte.zeitzone} ereignis={wahl.ereignis} onClose={onClose} onGespeichert={onGespeichert} />}
    {wahl?.art === 'korrekturen' && <KorrekturenDialog standort={kontext.standort} kennzeichen={werte.messstelle.kennzeichen} zone={werte.zeitzone} onClose={onClose} onGespeichert={onGespeichert} />}
  </>;
}
