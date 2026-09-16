import { SummenwertAssistent, type SummenwertEinstieg } from './SummenwertAssistent';

/** Bestehende Anlagen-/Kennzahlen-Einstiege öffnen denselben Assistenten ohne Vorauswahl. */
export function GesamtwertDialog(props: SummenwertEinstieg & { open: boolean; onClose: () => void }) {
  return <SummenwertAssistent {...props} />;
}
