# UEMS-Energiemanagement: internes Audit – Routen (AP-19 IP-18)

Neu am 25.09.2026: die Routen über `internes_audit` und `internes_audit_eintrag` aus IP-16
([Datenhaltung](uems-audit-feststellung-datenhaltung.md)). Konzept: AP-19 §4.6 IA1–IA5, §5.4, §5.6, R9
(`vp-uems-ap19-fundament/report.md`). Noch keine Fläche (Portal IP-20); Feststellung und Wirksamkeit baut IP-19.

| Stelle | Was |
|---|---|
| `InternesAuditController` | `GET/POST /api/v1/energiemanagement/audits` (`?tag=`), `GET/PUT …/{id}`, `POST …/{id}/durchgefuehrt · hinweise · abschliessen · absagen`; Schreiben `@Recht(energiemanagement.verwalten, UNTERNEHMEN)`, Abschließen `energiemanagement.freigeben` (KA U · EM U; Bearbeiter, Leser, Einsicht → 403); keine Löschroute |
| `InternesAuditService` | Prüfungen und Ablehnungs-Codes (`openapi.yaml`); Uhr `uhrStellen` (heute, „nie in der Zukunft“, Jahr im Kennzeichen über `angelegt_am`); `kopie(...)` baut die Abschluss-Kopie mit genau den Schlüsseln des Triggers; das Auditprogramm rechnet `naechstes` über `EnergiemanagementRegeln.ueberpruefung` (Art `internes_audit`, Rhythmus aus `energiemanagement_einstellung`, sonst 12) |
| `InternesAuditRepository` | SQL unter RLS + Zaun; jeder Übergang eine Zeile `energiemanagement_aenderung` (`audit_geplant · audit_geaendert · audit_durchgefuehrt · hinweis · audit_abgeschlossen · audit_abgesagt`) |
| `AuditVerzeichnis` · `AuditVerantwortung` | Verzeichnis-Quelle „Audits“ (Gruppe `audits_feststellungen`, nur abgeschlossene bis zum Stichtag, Ort mit Bericht-Verweis „Wortlaut in VoltPilot, Original bei Ihnen: …“) und Verantwortungs-Quelle (Art `internes_audit`, jeder Zustand) — beide nur über den Dienst |
| Nachweis | `InternesAuditApiTest` (R9, 403 inkl. Einsicht, Zaun, Ändern/Absagen), `InternesAuditSchnittstelleVertragTest` (openapi ↔ DTO ↔ Vokabular, Kopie = Vektor `27a580b9…`), Zeilen in `RechtMatrixApiTest` |

⚠ **Die Maßnahme am Hinweis steht nur in der Kopie:** `internes_audit_eintrag` hat keine Spalte dafür. Beim Abschließen
nennt `massnahmen: [{hinweis, massnahme}]` sie je Hinweis; angenommen wird nur eine Maßnahme mit Herkunft `audit` und
der Kennung DIESES Audits (422 `massnahme_unbekannt`; die Herkunft seit AP-19 IP-17). Ohne Angabe steht
`"massnahme": null` in der Kopie; mit M-2029-0002 ist sie byte-gleich der Referenz (R9, im API-Test über die echte
Maßnahmen-Route — die Kennung M-JJJJ hängt an der Uhr von `KennzahlService`).
⚠ **Personen in der Kopie:** „festgestellt von“ = Kürzel der Person (ohne Kürzel der Name), „eingetragen von“ = Kürzel
der Person, die mit dem Konto verknüpft ist (ohne Person der Kontoname) — so trifft die Kopie die Referenzdatei.
⚠ **Feststellungen der Kopie** liest der Dienst aus `feststellung.audit_id`; der Trigger vergleicht sie beim Abschluss —
wer IP-19 baut, legt Feststellungen nur am durchgeführten Audit an (sonst `feststellung_audit_durchgefuehrt`).
⚠ **Zaun:** ein Audit ohne Standort sieht nur, wer unternehmensweit liest; der Termin ist kein Filter — das
Auditprogramm zeigt jeden Zustand, `naechstes` nur aus durchgeführten Audits bis `tag`.
