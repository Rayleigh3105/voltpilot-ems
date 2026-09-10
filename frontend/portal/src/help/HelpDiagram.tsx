import { Icon } from '../../designsystem/components/core/Icon';

export function HelpDiagram({ kind }: { kind: 'energy' | 'loop' | 'day' }) {
  if (kind === 'energy') return <figure className="vp-help-diagram">
    <div className="vp-help-energy" role="img" aria-label="Mögliche Energieflüsse: PV versorgt Verbraucher, lädt den Speicher oder speist ins Netz ein. Speicher und Netz können Verbraucher versorgen.">
      <div className="vp-help-energy-node solar"><Icon name="sun" size={26} /><strong>PV-Erzeugung</strong><span>Strom vom eigenen Dach</span></div>
      <div className="vp-help-energy-arrow" aria-hidden="true">↓</div>
      <div className="vp-help-energy-center"><strong>Ihre Anlage</strong><span>Erzeugen · nutzen · verschieben</span></div>
      <div className="vp-help-energy-branches" aria-hidden="true"><span>↕</span><span>↓</span><span>↕</span></div>
      <div className="vp-help-energy-bottom">
        <div className="vp-help-energy-node battery"><strong>Speicher</strong><span>Für später aufbewahren</span></div>
        <div className="vp-help-energy-node load"><strong>Verbraucher</strong><span>Haus, Betrieb, Fahrzeug</span></div>
        <div className="vp-help-energy-node grid"><strong>Stromnetz</strong><span>Beziehen und einspeisen</span></div>
      </div>
    </div>
    <figcaption>Mögliche Wege, keine Live-Messung. Die tatsächliche Richtung sehen Sie im Cockpit.</figcaption>
  </figure>;
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
