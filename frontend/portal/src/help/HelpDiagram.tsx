import type { HelpSection } from './model';
import energy from './assets/energy-system.svg';
import system from './assets/portal-cloud-box.svg';
import proof from './assets/plan-and-effect.svg';
import storage from './assets/storage-reserves.svg';

const illustrations = {
  energy: { src: energy, alt: 'PV versorgt die Anlage. Speicher und Netz liefern oder nehmen Energie auf; Verbraucher nutzen sie.', caption: 'Mögliche Wege, keine Live-Messung. Die tatsächliche Richtung sehen Sie im Cockpit.' },
  system: { src: system, alt: 'Portal und Cloud-Planung tauschen Angaben aus. Die Box empfängt Pläne, meldet Messwerte und verbindet die Geräte vor Ort.', caption: 'Neue Messungen fließen wieder in die Planung ein.' },
  proof: { src: proof, alt: 'Vier Nachweise: Plan, gesendeter Auftrag, Geräteantwort und gemessene Wirkung.', caption: 'Eine Bestätigung allein belegt noch keine gemessene Wirkung.' },
  storage: { src: storage, alt: 'Technische Untergrenze, Reserve und obere Grenze bestimmen den planbaren Speicherbereich.', caption: 'Schematische Aufteilung ohne Zahlenvorgabe. Ihre tatsächlichen Grenzen stehen in den Einstellungen.' },
};

export function HelpDiagram({ kind }: { kind: NonNullable<HelpSection['diagram']> }) {
  if (kind !== 'loop' && kind !== 'day') {
    const illustration = illustrations[kind];
    return <figure className="vp-help-diagram">
      <img className="vp-help-illustration" src={illustration.src} alt={illustration.alt} loading="lazy" />
      <figcaption>{illustration.caption}</figcaption>
    </figure>;
  }
  const entries = kind === 'loop' ? [
    ['01', 'Messen', 'Die Box meldet Erzeugung, Verbrauch und Gerätezustände.'],
    ['02', 'Planen', 'Vorhersagen, Preise und Grenzen fließen in den Fahrplan ein.'],
    ['03', 'Umsetzen', 'Die Box führt die freigegebenen Vorgaben vor Ort aus.'],
    ['04', 'Prüfen', 'Im Portal vergleichen Sie Planung, Rückmeldung und Ergebnis.'],
  ] : [
    ['Morgens', 'Bedarf decken', 'Wenig Sonne, erster Verbrauch. Netz und Speicher ergänzen die PV.'],
    ['Mittags', 'Sonnenstrom nutzen', 'Verbrauch versorgen und gegebenenfalls Energie für später speichern.'],
    ['Abends', 'Gespeicherte Energie nutzen', 'Weniger PV, weiterer Bedarf. Der Plan berücksichtigt Reserven und Grenzen.'],
  ];
  return <figure className="vp-help-diagram">
    <ol className={`vp-help-sequence ${kind}`}>{entries.map(([label, title, text]) => <li key={label}><span>{label}</span><strong>{title}</strong><p>{text}</p></li>)}</ol>
    <figcaption>{kind === 'loop' ? 'Neue Messungen fließen wieder in die Planung ein.' : 'Vereinfachter Beispieltag. Ihre Anlage kann abhängig von Wetter, Tarif und Einstellungen anders fahren.'}</figcaption>
  </figure>;
}
