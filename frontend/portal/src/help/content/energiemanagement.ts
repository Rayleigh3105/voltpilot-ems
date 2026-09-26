import type { HelpArticle } from '../model';

/**
 * UEMS AP-20 IP-22 (E7 = A, E8 = A): was VoltPilot für das Energiemanagement festhält und was beim Kunden bleibt.
 * Jeder Text ist ein Satz aus dem Konzept, Wort für Wort, in der Form der Beschreibung: ein Funktionssatz steht nur
 * hier, solange seine Zusage in der geltenden Bewertung belegt ist, mit seiner Kundenaufgabe daneben; darunter alle
 * neun Kundenaufgaben (eigener Satz aus dem Konzept, sonst der Text der Bewertung). Das prüft
 * `tools/bewertung/produktbeschreibung.py --check` von außen — dieser Artikel verweist auf nichts dort.
 * Verantwortungs- und Grenz-Satz gleichen `UEMS_VERANTWORTUNG` und `UEMS_NORMGRENZE` in `glossar.ts` (Wächter in
 * `copy.test.ts`).
 */
export const energiemanagementArticles: HelpArticle[] = [
  {
    id: 'energiemanagement', category: 'verstehen',
    title: 'Was VoltPilot für Ihr Energiemanagement festhält — und was bei Ihnen bleibt',
    summary: 'Was außerhalb von VoltPilot bei Ihnen bleibt, steht bei jeder Funktion dabei.',
    keywords: ['Energiemanagement', 'Verantwortung', 'Aufgaben', 'Kennzahl', 'Bezugsbasis', 'Kompetenz', 'Nachweis', 'Gesamtabzug', 'Vertragsende', 'Recht', 'Klimawandel', 'Norm', 'Grenze'],
    sections: [
      { id: 'festhalten', title: 'Was VoltPilot festhält', paragraphs: [
        'VoltPilot misst, rechnet Kennzahlen und vergleicht mit Ihrer Bezugsbasis; was die Zahlen bedeuten, entscheiden Sie.',
      ], note: 'Warum ein Monat anders war und ob eine Maßnahme gewirkt hat, sagen Sie selbst, mit Begründung. VoltPilot schlägt vor und zeigt die Messwerte.' },
      { id: 'bei-ihnen', title: 'Was bei Ihnen bleibt', paragraphs: [
        'Ihr Energiemanagement als Ganzes einführen, mit Mitteln ausstatten, aufrechterhalten und verbessern.',
        'Festlegen, welche Kompetenz nötig ist, und sie nachweisen, tun Sie selbst. VoltPilot hält an der Person nur den Verweis auf Ihren Nachweis.',
        'Ob Sie rechtliche Anforderungen einhalten, bewerten Sie selbst. VoltPilot bewertet das nicht.',
        'Warum ein Monat anders war und ob eine Maßnahme gewirkt hat, sagen Sie selbst, mit Begründung. VoltPilot schlägt vor und zeigt die Messwerte.',
        'Ob der Klimawandel für Ihr Energiemanagement eine Rolle spielt, beurteilen Sie. VoltPilot führt dazu keine Angaben.',
        'Vor dem Ende Ihres Vertrags laden Sie den Gesamtabzug und bewahren ihn selbst auf.',
        'Messmittel und Zähler prüfen lassen, die Messplanung verantworten, eine Einstufung fachlich tragen.',
        'Interne Audits durchführen (Gespräche, Begehung), Auditorinnen und Auditoren auswählen und ihre Unabhängigkeit sichern.',
        'Entscheidungen der Leitung treffen und verantworten; Originale in Ihren Systemen führen, wo VoltPilot nur verweist.',
      ] },
      { id: 'grenze', title: 'Grenze', paragraphs: [
        'Inhalte und Entscheidungen Ihres Energiemanagements verantwortet Ihr Unternehmen. VoltPilot hält fest, wer was wann entschieden hat, und beurteilt nicht, ob Ihr Energiemanagement genügt.',
        'VoltPilot unterstützt Ihr Energiemanagement mit Messung, Kennzahlen und Berichten. Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden.',
      ] },
    ],
    related: ['messwerte', 'portfolio', 'kontakt'],
  },
];
