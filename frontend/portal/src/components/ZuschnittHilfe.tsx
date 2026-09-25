import { Icon } from '../../designsystem/components/core/Icon';
import { SAETZE } from '../energiemanagement';
import { UEMS_ENERGIEMANAGEMENT, UEMS_NORMGRENZE, UEMS_VERANTWORTUNG } from '../glossar';

const GEFUEHRT = 'in VoltPilot geführt';
const WORTLAUT = 'Wortlaut in VoltPilot, Original bei Ihnen';
const VERWEIS = 'Verweis auf Ihr System';
const BEI_IHNEN = 'bei Ihnen, nicht in VoltPilot';

/** Die vier Stufen (G1) und was sie heißen — die Lesehilfe aus §3.2 in Kundenwörtern. */
const STUFEN: readonly [string, string][] = [
  [GEFUEHRT, 'Der Eintrag lebt in VoltPilot mit Fassungen und Rechten; die Entscheidung wird hier festgehalten.'],
  [WORTLAUT, 'VoltPilot hält den Text als Fassung; das unterschriebene Original liegt bei Ihnen, hier steht ein Verweis darauf.'],
  [VERWEIS, 'VoltPilot hält nur Bezeichnung, Ablage, Kennung, Fassungsangabe und — wenn Sie möchten — Adresse und Prüfsumme.'],
  [BEI_IHNEN, 'Das führen Sie ganz in Ihren eigenen Systemen.'],
];

type Teil = { teil: string; stufe: string; haelt: string; bleibt: string; system: string };

/**
 * Der Zuschnitt (Konzept §3.2, `zuschnitt.json`, Entscheid E1 = A): je Teil, was VoltPilot hält und was bei Ihnen
 * bleibt — sechzehn Teile und vier Nachbarn. Die Spalte „Norm (intern)“ steht NIE hier (AP-14 S1, SP2); die Wörter
 * sind die Kundenwörter (SP3: „Einhaltung prüfen“, nie „Bewertung“ allein).
 */
const TEILE: readonly Teil[] = [
  { teil: 'Anwendungsbereich', stufe: GEFUEHRT, haelt: 'Dokument der Art „Anwendungsbereich“: Wortlaut, Standorte, Energieträger, Ausschlüsse mit Begründung, Freigabe durch die Leitung, Überprüfung; daneben der Betrachtungsumfang der energetischen Bewertung mit einem Vergleichs-Satz', bleibt: 'die Festlegung selbst — sie entscheidet die Leitung', system: '—' },
  { teil: 'Kontext und interessierte Parteien', stufe: VERWEIS, haelt: 'Dokument der Art „Kontext“ als Verweis oder kurzer Wortlaut, mit Fassung und Überprüfung; eine Eingabe der Managementbewertung', bleibt: 'die Analyse der Themen und Parteien', system: 'QM-Handbuch, Strategiepapier' },
  { teil: 'Rechtliche Anforderungen', stufe: VERWEIS, haelt: 'Dokument der Art „Rechtliche Anforderungen“ als Verweis auf Ihr Kataster, mit Fassungsangabe und Überprüfung', bleibt: 'das Rechtskataster und die Prüfung, ob Sie die Anforderungen einhalten', system: 'Rechtskataster-Dienst, Umweltrecht-Werkzeug' },
  { teil: 'Energiepolitik', stufe: WORTLAUT, haelt: 'Dokument der Art „Energiepolitik“: Wortlaut, Fassung, Freigabe durch die Leitung, Bekanntmachung, Überprüfung; das unterschriebene Original als Verweis mit Prüfsumme', bleibt: 'Inhalt und Verpflichtung der Leitung; das unterschriebene Original', system: 'Dokumentenablage, QM-Laufwerk' },
  { teil: 'Aufgaben im Energiemanagement', stufe: GEFUEHRT, haelt: 'Aufgaben, Personen (auch ohne Konto) und Zeiträume, je mit „entschieden von“; „Wer ist wofür verantwortlich“ über alle Einträge', bleibt: 'Bestellung, Stellenbeschreibung, Organigramm — als Verweis ein Beleg', system: 'Personalsystem' },
  { teil: 'Risiken und Chancen', stufe: VERWEIS, haelt: 'Dokument der Art „Risiken und Chancen“ als Verweis oder kurzer Wortlaut, mit Überprüfung; eine Eingabe der Managementbewertung; Maßnahmen daraus über einen Beschluss', bleibt: 'das Risiko-Management des Unternehmens', system: 'Risiko-Register, QM-Werkzeug' },
  { teil: 'Kompetenz', stufe: VERWEIS, haelt: 'Dokument der Art „Kompetenz (Nachweis)“ je Person oder Aufgabe als Verweis, ohne Überprüfung', bleibt: 'Schulungsplanung, Qualifikation und die Nachweise selbst', system: 'Personal- oder Schulungssystem' },
  { teil: 'Kommunikation', stufe: GEFUEHRT, haelt: 'die Bekanntmachung an jedem Dokument — an wen, wann, über welchen Weg; ein Kommunikationsplan als Dokument der Art „Kommunikation“', bleibt: 'die Kanäle (Aushang, Intranet, Besprechung) und der Vorschlagsweg der Belegschaft', system: 'Intranet' },
  { teil: 'Verzeichnis', stufe: GEFUEHRT, haelt: 'das Verzeichnis aller Nachweise; je Dokument Kennzeichen, Fassung, Freigabe, gültig ab, Überprüfung, Ablage, Prüfsumme — ohne Datei', bleibt: 'Dateien, Ablage, Berechtigungen und Versionen beliebiger Dateien', system: 'Dokumentenablage' },
  { teil: 'Betrieb und Instandhaltung', stufe: VERWEIS, haelt: 'Dokument der Art „Betrieb und Instandhaltung“ am Energieeinsatz als Verweis, auf der Seite des Einsatzes sichtbar', bleibt: 'Arbeitspläne, Wartung, Betriebsanweisungen', system: 'Instandhaltungssystem' },
  { teil: 'Auslegung', stufe: VERWEIS, haelt: 'Dokument der Art „Auslegung (Nachweis)“ als Verweis', bleibt: 'die Planungsunterlagen', system: 'Planungsablage der Technik' },
  { teil: 'Beschaffung', stufe: VERWEIS, haelt: 'Dokument der Art „Beschaffung“ — die Vorgabe — als Verweis', bleibt: 'Einkaufsvorgänge und Lieferantenbewertung', system: 'ERP, Einkauf' },
  { teil: 'Interne Audits', stufe: GEFUEHRT, haelt: 'jedes interne Audit mit Auditorin oder Auditor, Unabhängigkeit, Umfang, Hinweisen, Feststellungen und Abschluss mit Prüfsumme; der Rhythmus', bleibt: 'die Durchführung (Gespräche, Begehung), die Qualifikation; der unterschriebene Bericht als Verweis', system: 'QM-Werkzeug, Dokumentenablage' },
  { teil: 'Managementbewertung', stufe: GEFUEHRT, haelt: 'Eingaben aus Kennzahlen, energetischer Bewertung, Energiezielen und Maßnahmen; Sitzung, Beschlüsse der Leitung, Stand mit Prüfsumme und die Folgen', bleibt: 'die Sitzung selbst und die Entscheidung der Leitung', system: '—' },
  { teil: 'Feststellung, Maßnahme, Wirksamkeit', stufe: GEFUEHRT, haelt: 'die Feststellung mit Quelle, sofortiger Behebung, Ursache als Aussage einer Person und ähnlichen Fällen; die Maßnahmen und die Wirksamkeit als Stand', bleibt: 'die Suche nach der Ursache; Feststellungen aus Qualität, Umwelt und Arbeitsschutz', system: 'QM-Werkzeug' },
  { teil: 'Verweise und Abzüge', stufe: VERWEIS, haelt: 'Verweise mit Ablage, Kennung und Adresse; das Verzeichnis als CSV; der Kalender-Abzug der Wiedervorlage', bleibt: 'die führenden Systeme', system: 'Dokumentenablage, QM, Personal, Instandhaltung, ERP, Kalender' },
];

const NACHBARN: readonly Teil[] = [
  { teil: 'Ressourcen', stufe: BEI_IHNEN, haelt: 'nur als Beschluss „Ressourcen“ einer Managementbewertung, im Wortlaut', bleibt: 'Budget, Personal, Mittel', system: 'ERP, Controlling' },
  { teil: 'Bewusstsein', stufe: BEI_IHNEN, haelt: '— die Bekanntmachung belegt die Mitteilung, nicht das Bewusstsein', bleibt: 'Unterweisung und Kultur', system: '—' },
  { teil: 'Einhaltung rechtlicher Anforderungen prüfen', stufe: BEI_IHNEN, haelt: '— das Ergebnis kann als Verweis unter „Rechtliche Anforderungen“ stehen', bleibt: 'die Prüfung selbst', system: 'Rechtskataster-Dienst' },
  { teil: 'Fortlaufende Verbesserung', stufe: GEFUEHRT, haelt: 'im Bereich „Ziele und Maßnahmen“: Energieziele, Maßnahmen, Abweichungen und ihre Wirkung', bleibt: '—', system: '—' },
];

function Tafel({ teile, testid }: { teile: readonly Teil[]; testid: string }) {
  return (
    <table className="vp-ez-tafel" data-testid={testid}>
      <thead>
        <tr>
          <th scope="col">Teil</th>
          <th scope="col">VoltPilot hält</th>
          <th scope="col">Bleibt bei Ihnen</th>
          <th scope="col">Typisch bei Ihnen in</th>
        </tr>
      </thead>
      <tbody>
        {teile.map((t) => (
          <tr key={t.teil}>
            <th scope="row">
              <span>{t.teil}</span>
              <br />
              <span className="vp-em-stufe">{t.stufe}</span>
            </th>
            <td data-label="VoltPilot hält">{t.haelt}</td>
            <td data-label="Bleibt bei Ihnen">{t.bleibt}</td>
            <td data-label="Typisch bei Ihnen in">{t.system}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Die Zuschnitt-Hilfe (UEMS AP-19 IP-9, §5.1): eine statische Seite „Was VoltPilot führt — was bei Ihnen liegt.“ —
 * je Teil die Stufe, was VoltPilot hält, was bei Ihnen bleibt und in welchem System es typisch liegt. Nichts wird
 * gezählt oder beurteilt; kein Teil fällt ganz heraus, aber in jedem liegt der Inhalt ganz oder zum Teil bei Ihnen.
 */
export function ZuschnittHilfe({ onZurueck }: { onZurueck?: () => void }) {
  return (
    <div className="vp-ez" data-testid="zuschnitt-hilfe">
      {onZurueck && (
        <button type="button" className="vp-ez-zurueck" onClick={onZurueck} data-testid="zuschnitt-zurueck">
          <Icon name="chevron-left" size={16} />
          {UEMS_ENERGIEMANAGEMENT}
        </button>
      )}
      <h1>{SAETZE.zuschnitt_titel}</h1>
      <p className="vp-ez-satz">
        Für jeden Teil Ihres Energiemanagements steht hier, was VoltPilot festhält und was bei Ihnen bleibt. Kein Teil
        fällt ganz heraus — aber in jedem liegt der Inhalt ganz oder zum Teil bei Ihnen, und jede Zeile im Verzeichnis
        sagt, wo das Original liegt.
      </p>
      <section className="vp-ez-karte" aria-label="Die vier Stufen">
        <dl className="vp-em-dl">
          {STUFEN.map(([stufe, text]) => (
            <div key={stufe} style={{ display: 'contents' }}>
              <dt>
                <span className="vp-em-stufe">{stufe}</span>
              </dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="vp-ez-karte">
        <h2>Die Teile</h2>
        <Tafel teile={TEILE} testid="zuschnitt-teile" />
      </section>
      <section className="vp-ez-karte">
        <h2>Daneben</h2>
        <p className="vp-ez-leise">Diese Themen gehören zum Umfeld; VoltPilot führt sie nicht als eigenen Eintrag im Energiemanagement.</p>
        <Tafel teile={NACHBARN} testid="zuschnitt-nachbarn" />
      </section>
      <div className="vp-em-saetze">
        <p className="vp-ez-grenze">{UEMS_VERANTWORTUNG}</p>
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </div>
    </div>
  );
}
