import { BerichteListe } from '../components/nachweisen/BerichteListe';
import { STANDORT_BERICHTE } from '../ebenenNav';
import { BerichtSeite } from './BerichtSeite';
import './BerichtePage.css';

/**
 * „Unternehmen › Berichte“ (UEMS AP-12 IP-13, `#/portfolio/berichte`) und die Berichtsseite
 * (`#/portfolio/berichte/{kennung}`) — seit AP-13 IP-2 auch „Berichte dieses Standorts“
 * (`#/standort/{id}/berichte`, Ü8/K3): dieselbe Liste, nur Berichte mit Geltung genau dieser Standort.
 *
 * Seit Konzept Nachweisen n1, Runde 2 (§6.4), ist die Liste die von Nachweisen (`components/nachweisen/BerichteListe`):
 * zwei Zähler, die Entscheidung zuerst, eine Zeile je Bericht mit „PDF“; Bewertung und Managementbewertung öffnen ihre
 * eigene Seite (Entscheid 15). Eine 403 (die Unterstützung liest nie einen Bericht) steht als Satz der Route da.
 */
export function BerichtePage({
  kennung = null,
  onOeffnen,
  onListe,
  standort = null,
  onBewertung,
  onManagementbewertung,
}: {
  kennung?: string | null;
  onOeffnen: (kennung: string) => void;
  onListe: () => void;
  /** AP-13 IP-2: „Berichte dieses Standorts“; `null` = das Unternehmen. */
  standort?: { id: string; name: string } | null;
  /** AP-16 IP-25: eine neu angelegte energetische Bewertung öffnet die Seite „Bewertung“ statt der Berichtsseite. */
  onBewertung?: () => void;
  /** Entscheid 15 (Konzept Nachweisen n1): die Managementbewertung liest man auf ihrer eigenen Seite. */
  onManagementbewertung?: (kennung: string) => void;
}) {
  if (kennung) {
    return (
      <BerichtSeite
        key={kennung}
        kennung={kennung}
        onListe={onListe}
        zurListe={standort ? STANDORT_BERICHTE : undefined}
        onBewertung={onBewertung}
        onManagementbewertung={onManagementbewertung}
      />
    );
  }
  return <BerichteListe standort={standort} onOeffnen={onOeffnen} onBewertung={onBewertung} onManagementbewertung={onManagementbewertung} />;
}
