# Energiemanagement (AP-19): Bestandsschutz, kein Schalter — Wegweiser und Abschluss

Einstieg in alle 26 Pakete von AP-19 (Konzept `vp-uems-ap19-fundament`, entschieden 24.09.2026, E1–E10 = A, W1–W15
übernommen). Grundgedanke: VoltPilot hält fest, der Kunde entscheidet, und jede Zeile sagt, wo das Original liegt —
Dokument mit Fassung und Freigabe („entschieden von“, auch Personen ohne Konto), Verweis mit Prüfsumme statt Datei (E2),
Aufgaben und „Wer ist wofür verantwortlich“, Rolle „Einsicht“ (nur lesen), internes Audit → Feststellung → Maßnahme →
Wirksamkeit durch eine Person, Managementbewertung als Stand mit Beschlüssen der Leitung. Kundenwörter nach SP1–SP5 aus
`frontend/portal/src/glossar.ts` (`UEMS_ENERGIEMANAGEMENT` …, `UEMS_VERANTWORTUNG`), Wächter `copy.test.ts` (Block AP-19
IP-3). Begriffe: Glossar `docs/fachmodell/glossar.md` (Nachtrag AP-19, zwölf Einträge).

## Einstieg je Paket

| Pakete | Schicht | Wegweiser |
|---|---|---|
| IP-1 | Referenzunternehmen 1.10 (Dokumente, Personen, Aufgaben, Audits, Feststellungen, Managementbewertung; W11) | `uems-referenzunternehmen-die-eine-beispi.md` (Abschnitt 1.10) |
| IP-2 | Vertrag `energiemanagement-vectors.json`, Zwillinge Java/TS/Python (Überprüfung, Wiedervorlage, Vergleich, Verzeichnis-Zeile) | `uems-energiemanagement-vertrag.md` |
| IP-3 | Sprach-Wächter, Kundenwörter, Verantwortungs-Satz (SP1–SP5, W3, W6, W7) | `frontend/portal/src/copy.test.ts`, `glossar.ts` |
| IP-4 | Nachträge Phase 1 (W1 Herkunft per CHECK, W11, W13, Leser der Reservierung `massnahme_bewertet`) | `uems-verbesserung-datenhaltung.md`, `docs/contracts/v2/events-vocabulary-vectors.json`, `docs/contracts/v2/kennzahl.md` |
| IP-5, IP-16 | Datenhaltung: Person, Aufgabe, Dokument, Fassung, Anwendungsbereich; internes Audit, Feststellung, Wirksamkeit | `uems-energiemanagement-datenhaltung.md`, `uems-audit-feststellung-datenhaltung.md` |
| IP-6, IP-10 | Personen und Aufgaben, „Wer ist wofür verantwortlich“, Aufgaben ohne Person | `uems-energiemanagement-personen.md` |
| IP-7 | Dokument: Routen, Freigabe, Überprüfung, Bekanntmachung, Vergleich | `uems-energiemanagement-dokumente.md` |
| IP-8 | Verzeichnis: Leser über alle Quellen, CSV | Zeile „Verzeichnis“ in `uems-uebersicht.md` |
| IP-11, IP-12 | Rechte: Lesen und Freigeben getrennt; Rolle „Einsicht“ | `uems-rechte-matrix-nachtraege.md`, `uems-benutzerverwaltung.md`, `uems-geltungsbereich.md` |
| IP-14 | Nachweise am Einsatz und an der Person, Bekanntmachungen | `uems-energiemanagement-nachweise.md` |
| IP-17 | Maßnahme: Herkunft geweitet (Feststellung, internes Audit, Managementbewertung; CHECK-Tausch) | `uems-verbesserung-datenhaltung.md`, `uems-massnahme-routen.md` |
| IP-18, IP-19 | Internes Audit; Feststellung, Einträge, Wirksamkeit | `uems-audit-routen.md`, `uems-feststellung-routen.md` |
| IP-9, IP-13, IP-15, IP-20, IP-24 | Portal: Bereich, Verzeichnis, Dokumente, Aufgaben, Nachweise, Audits, Feststellungen, Wiedervorlage, Managementbewertung je Jahr | `uems-energiemanagement-portal.md` |
| IP-21 | Wiedervorlage, Kalender-Abzug, Baustein „Energiemanagement“ | `uems-energiemanagement-wiedervorlage.md` |
| IP-22 | Vorlage „Managementbewertung“ Nr. 7: Abschnitte, acht Quellenarten | Zeile „Vorlage Managementbewertung“ in `uems-uebersicht.md`, `docs/contracts/v2/bericht.md` |
| IP-23 | Sitzung, Beschlüsse, Folgen der Managementbewertung (MG4–MG7); Folge: Beschluss-Kennung an Aufgabe, Fassung und „geprüft, bleibt“ nennt einen bestehenden Beschluss (422 `beschluss_unbekannt`) | `uems-managementbewertung-beschluesse.md` |
| IP-25 | Bestandsschutz, dieser Wegweiser, Glossar, Fachmodell, Release-Notiz-Zeile | unten |
| IP-26 | Abnahme der Plan-Konstruktion (NW-6): `UemsEnergiemanagementAbnahmeTest` | folgt nach IP-25 |

## Kein Schalter, keine Naht, keine Drehbuch-Zeile

AP-19 schreibt nie von selbst: jeder Eintrag entsteht durch eine Person über eine Route. Darum gibt es keinen Schalter
`voltpilot.uems.energiemanagement.*`, keinen Läufer, keinen Ereignis-Hörer, keine Nachricht, keinen gitops-Wert und
keine Zeile in §12 oder §15 von `docs/rollout/uems-erste-freigabe.md` (§6.6). Die Wiedervorlage rechnet beim Abruf, der
Kalender-Abzug ist ein Abruf (E10). Wer AP-19 eine Naht geben will, braucht einen neuen Entscheid — die Quelltext-Probe
in `UemsEnergiemanagementBestandsschutzTest#keinSchalterKeinLaeuferKeineNaht` wird dann rot.

## Bestandsschutz (IP-25, NW-5, R15)

- **`UemsEnergiemanagementBestandsschutzTest`** (Docker, ohne Spring): Ahrenberg aus `infra/local/seed/ahrenberg.sql`
  auf der Fassung VOR `V20260925013500`, dazu je ein Stand der Vorgänger — Monatsbericht mit Abruf (AP-12), energetische
  Bewertung (AP-16), Leistungsvergleich an KZ-0004 mit BB-0001 (AP-17), Energieziel und zwei Maßnahmen (`von_hand`,
  `energieziel`), eine mit Bewertung Stand Nr. 1 (AP-18). Danach bis `LETZTE_AP19` und dann alle späteren Migrationen.
  Jede Bestandstabelle byte-gleich — keine Zeile ist Ausnahme. Die 17 AP-19-Tabellen (`NEUE_TABELLEN`) sind leer,
  „Einsicht“ ist niemandem zugewiesen.
- **Benannte Ausnahmen, nur im Schema:** genau zwei CHECK-Tausche an fremden Tabellen (`GETAUSCHTE_CHECKS`:
  `massnahme_herkunft_chk` W1, `bericht_abruf_actor_rolle_chk` W10), beide validiert; genau vier Vokabulare als
  Vereinigung geweitet (`GEWEITETE_VOKABULARE`: `verbesserung_vokabular`, `zugriff_rolle`, `bericht_vokabular`,
  `bericht_vorlage`) — jedes alte Wort bleibt mit seiner Nummer; ein neues, `energiemanagement_vokabular()`. Die
  Rollen-Spalte und die getrennten Lese-Kennungen liegen in `rechte-matrix.json`: `RechtMatrixApiTest` (KA und EM
  behalten jede Zelle).
- **Kein Baustein ohne Inhalt:** der Baustein erscheint nur, wenn die Wiedervorlage fällige Zeilen oder Vorschau hat
  (`energiemanagementBaustein` in `wiedervorlage.ts`, `EnergiemanagementBaustein.test.tsx`); ohne AP-19-Eintrag sind
  alle AP-19-Quellen leer, und der Bereich zeigt die Nachweise der Vorgänger mit „Hier ist noch nichts festgehalten.“
- **Robust gegen spätere Programme:** „genau diese Tabellen, CHECKs und Vokabulare“ wird auf `LETZTE_AP19` gemessen;
  danach nur noch „Bestand byte-gleich, AP-19-Tabellen leer, kein Wort und kein Tausch verschwindet“.
- **Wer ein AP-19-Paket nach IP-25 baut:** eine neue AP-19-Tabelle kommt in `NEUE_TABELLEN`, eine neue AP-19-Migration
  hebt `LETZTE_AP19`; ein weiterer Tausch an einer fremden Tabelle kommt mit Begründung in `GETAUSCHTE_CHECKS`.

## Vermerke

- **Release-Notiz:** die Zeile „Unter „Energiemanagement“ …“ in `docs/rollout/release-notiz-vorlage.md` ist die
  einzige Hand des Betreibers (§8.3) — Ablage, Keycloak je Kunde, Schlüsselverwaltung und SMTP gehörten nur zu den nicht
  gewählten Optionen. Wächter: `copy.test.ts` (Block AP-19 IP-3, Fall „Release-Notiz“, und AP-14 S1–S3).
- **Datenschutz:** Personen ohne Konto sind personenbezogene Daten; sie bleiben, solange eine Zeile sie nennt. Am Ende
  eines Kundenbereichs wird **nicht anonymisiert** (Berichtigung AP-20 W1, E10 = A): beendet → Mitnahme (Gesamtabzug)
  → nach der Frist gelöscht, mit Löschnachweis ohne Personendaten — [Vertragsende](uems-kundenbereich-beendet.md).
- **Seed:** der Demo-Seed bleibt auf 1.4 (AP-18 W14); jede Bühne legt Dokumente, Aufgaben und Audits nach der
  Referenzdatei 1.10 selbst an.
