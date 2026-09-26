# Prüfpaket für die Fachperson (AP-20 IP-11)

> Eine mögliche Softwarezertifizierung, Förderlistung oder rechtliche Bewertung entsteht nicht automatisch durch dieses Paket.

Dieses Paket legt Ihnen die Zuordnung von VoltPilot zur Gliederung der Norm vor. Sie lesen sie an Ihrer lizenzierten Ausgabe und tragen je Zeile Ihre Lesart ein: trägt, Anmerkung oder Widerspruch, mit Name, Datum und Text (FP1). **Das Paket enthält keinen Normtext.** Jede Zeile trägt nur die Abschnittsnummer und eine eigene Umschreibung der Crew; Anforderungen lesen Sie an Ihrer Ausgabe.

Ihre Unabhängigkeit: Sie beraten VoltPilot nicht bei der Umsetzung dessen, was Sie bewerten (FP2). Eine Zertifizierung, ein Rechtsgutachten oder eine Prüfung des Betriebsteils ist nicht Ihr Auftrag.

Gebaut von `tools/bewertung/pruefpaket.py`, nie von Hand. Prüfsummen in `pruefpaket.sha256`.

| Angabe | Wert |
|---|---|
| Stand des Pakets | 25.09.2026 (Stichtag der Normfassung) |
| Normfassung | ISO 50001:2018 einschließlich Amd 1:2024 · DIN EN ISO 50001:2018-12 mit DIN EN ISO 50001/A1:2024-12 |
| Matrix | docs/bewertung/nachweismatrix.json · Fassung 1 · SHA-256 `e140fbdfe13002f68f097ad51531a047cffd3749573b82065dd05a104a2234da` |
| Bewertung | docs/bewertung/bewertungen/BWB-2026-01.json · BWB-2026-01 · entwurf · Stand `09862815f` · SHA-256 `5450ec7d3f8b90f395eaa5588b5cb8ecc3cec8030902250099163159b724fbe4` |
| Normtext | nicht enthalten; Sie bringen Ihre lizenzierte Ausgabe mit |

## 1 Norm-Teil

30 Zeilen. Je Träger: 15 hält fest · 7 Verweis auf das System des Kunden · 4 misst · 4 bleibt beim Kunden. Gezählt wird der Träger, nie eine Erfüllung. Jede Zeile ist offen, bis Ihre Lesart sie trägt (RF-03).

Träger: **hält fest** — VoltPilot führt die Aufzeichnung selbst · **misst** — VoltPilot misst und rechnet · **Verweis** — VoltPilot hält nur den Verweis auf das Original im System des Kunden · **bleibt beim Kunden** — VoltPilot trägt nichts dazu bei.

### 4.1

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Innere und äußere Themen, die das Energiemanagement betreffen; seit der Änderung 1 auch die Frage, ob der Klimawandel dazugehört |
| Träger | Verweis auf das System des Kunden |
| Kundenaufgabe | KA-05: Beurteilen, ob der Klimawandel und klimabezogene Anforderungen für Ihr Energiemanagement relevant sind. VoltPilot führt dazu keine Angaben. |
| Herkunft der Zuordnung | FM/vp-uems-ap19-fundament/zuschnitt.json Z. 2 (Dokument „Kontext“ als Verweis); Klimafrage aus der Änderung 1 als Kundenaufgabe KA-05, VoltPilot führt dazu keine Angaben (AP-20 E1, ist/D D1) |

Keine Zusage von VoltPilot an dieser Zeile.

### 4.2

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Wer ein Interesse am Energiemanagement hat und was diese Parteien erwarten, auch rechtlich und klimabezogen |
| Träger | Verweis auf das System des Kunden |
| Kundenaufgabe | KA-05: Beurteilen, ob der Klimawandel und klimabezogene Anforderungen für Ihr Energiemanagement relevant sind. VoltPilot führt dazu keine Angaben. |
| Herkunft der Zuordnung | FM/vp-uems-ap19-fundament/zuschnitt.json Z. 2 und Z. 3 (Kontext, rechtliche Anforderungen als Verweis); klimabezogene Erwartungen als Kundenaufgabe KA-05 (AP-20 E1, ist/D D1) |

Keine Zusage von VoltPilot an dieser Zeile.

### 4.3

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Wofür das Energiemanagement gilt: Standorte, Energieträger und begründete Ausschlüsse als festgehaltenes Dokument |
| Träger | hält fest |
| Kundenaufgabe | KA-09: Entscheidungen der Leitung treffen und verantworten; Originale in Ihren Systemen führen, wo VoltPilot nur verweist. |
| Herkunft der Zuordnung | FM/vp-uems-ap19-fundament/zuschnitt.json Z. 1 (Dokument „Anwendungsbereich“, daneben der Betrachtungsumfang der Bewertung, AP-16); docs/agents/root/uems-energiemanagement-dokumente.md |

| Zusage | Wortlaut | Urteil im Entwurf |
|---|---|---|
| Z-004 | Die erforderlichen Entscheidungen und Nachweise sind auffindbar; die Verantwortung des Kunden bleibt ausdrücklich erkennbar. | offen |
| Z-056 | Unter „Energiemanagement“ halten Sie Energiepolitik, Anwendungsbereich und weitere Dokumente mit Fassung und Freigabe fest, dazu Aufgaben, interne Audits, Feststellungen und die Managementbewertung mit den Beschlüssen Ihrer Leitung. | belegt |

### 4.4

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Das Energiemanagement als Ganzes aufbauen, am Laufen halten und weiterentwickeln |
| Träger | bleibt beim Kunden |
| Kundenaufgabe | KA-01: Ihr Energiemanagement als Ganzes einführen, mit Mitteln ausstatten, aufrechterhalten und verbessern. |
| Herkunft der Zuordnung | zugeordnet in AP-20 IP-7 (L-012): ganz beim Kunden, KA-01; VoltPilot trägt nur Teile, die andere Zeilen nennen. Zuvor nur FM/vp-uems-ap19-fundament/ist/C-luecken.md:31 |

Keine Zusage von VoltPilot an dieser Zeile.

### 5.1

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Wie die Leitung Verantwortung für das Energiemanagement übernimmt und es sichtbar mitträgt |
| Träger | hält fest |
| Kundenaufgabe | KA-09: Entscheidungen der Leitung treffen und verantworten; Originale in Ihren Systemen führen, wo VoltPilot nur verweist. |
| Herkunft der Zuordnung | FM/vp-uems-ap19-fundament/zuschnitt.json Z. 4 (mit 5.2 an der Energiepolitik: Wortlaut in VoltPilot, unterschriebenes Original beim Kunden) |

| Zusage | Wortlaut | Urteil im Entwurf |
|---|---|---|
| Z-004 | Die erforderlichen Entscheidungen und Nachweise sind auffindbar; die Verantwortung des Kunden bleibt ausdrücklich erkennbar. | offen |

### 5.2

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Die Grundsatzerklärung der Leitung zur Energie, mit Fassung und Freigabe |
| Träger | hält fest |
| Kundenaufgabe | KA-09: Entscheidungen der Leitung treffen und verantworten; Originale in Ihren Systemen führen, wo VoltPilot nur verweist. |
| Herkunft der Zuordnung | FM/vp-uems-ap19-fundament/zuschnitt.json Z. 4; docs/agents/root/uems-energiemanagement-dokumente.md |

| Zusage | Wortlaut | Urteil im Entwurf |
|---|---|---|
| Z-004 | Die erforderlichen Entscheidungen und Nachweise sind auffindbar; die Verantwortung des Kunden bleibt ausdrücklich erkennbar. | offen |
| Z-056 | Unter „Energiemanagement“ halten Sie Energiepolitik, Anwendungsbereich und weitere Dokumente mit Fassung und Freigabe fest, dazu Aufgaben, interne Audits, Feststellungen und die Managementbewertung mit den Beschlüssen Ihrer Leitung. | belegt |

### 5.3

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Wer im Energiemanagement welche Aufgabe, Verantwortung und Befugnis hat, das Team eingeschlossen |
| Träger | hält fest |
| Kundenaufgabe | KA-09: Entscheidungen der Leitung treffen und verantworten; Originale in Ihren Systemen führen, wo VoltPilot nur verweist. |
| Herkunft der Zuordnung | FM/vp-uems-ap19-fundament/zuschnitt.json Z. 5 (Aufgaben im Energiemanagement geführt); docs/agents/root/uems-energiemanagement-personen.md |

| Zusage | Wortlaut | Urteil im Entwurf |
|---|---|---|
| Z-004 | Die erforderlichen Entscheidungen und Nachweise sind auffindbar; die Verantwortung des Kunden bleibt ausdrücklich erkennbar. | offen |
| Z-056 | Unter „Energiemanagement“ halten Sie Energiepolitik, Anwendungsbereich und weitere Dokumente mit Fassung und Freigabe fest, dazu Aufgaben, interne Audits, Feststellungen und die Managementbewertung mit den Beschlüssen Ihrer Leitung. | belegt |

### 6.1

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Welche Risiken und Chancen das Energiemanagement berücksichtigt und wie es darauf eingeht |
| Träger | Verweis auf das System des Kunden |
| Kundenaufgabe | KA-09: Entscheidungen der Leitung treffen und verantworten; Originale in Ihren Systemen führen, wo VoltPilot nur verweist. |
| Herkunft der Zuordnung | FM/vp-uems-ap19-fundament/zuschnitt.json Z. 6 (Verweis auf das Risiko-Management des Kunden, Eingabe der Managementbewertung) |

Keine Zusage von VoltPilot an dieser Zeile.

### 6.2

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Energieziele setzen und planen, mit welchen Maßnahmen, Verantwortlichen und Terminen sie erreicht werden sollen |
| Träger | hält fest |
| Kundenaufgabe | KA-04: Ursachen benennen und die Wirkung einer Maßnahme belegen — als Aussage einer Person mit Begründung. VoltPilot schlägt vor und zeigt Messwerte. |
| Herkunft der Zuordnung | AP-18 Energieziel und Maßnahme: FM/vp-uems-ap18-fundament/ist/C-luecken-iso-50001.md:4, :23, :33; docs/agents/root/uems-massnahme-routen.md. Ursachenregel „Ursache braucht Fakt“: docs/agents/root/erklaerbarkeit-stufe-0-die-echtheits-reg.md:9–10 (aus AGENTS.md ausgelagert), PG/plan.md:413 und :659; nicht „AP-08 E7“, das ist der Kasten Ersatzwerte (AP-20 W7) |

| Zusage | Wortlaut | Urteil im Entwurf |
|---|---|---|
| Z-003 | Die Software behauptet keine Ursache, die die Daten nicht tragen. | belegt |
| Z-039 | Eine Maßnahme ist mit Ziel, Verantwortlichem, Messgrundlage und Ergebnis verbunden. | belegt |
| Z-053 | Unter „Ziele und Maßnahmen“ setzen Sie an einer Energieleistungskennzahl Energieziele und planen Maßnahmen mit Verantwortlichen und Terminen. | belegt |

### 6.3

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Den Energieeinsatz erheben und auswerten und die wesentlichen Einsätze begründet bestimmen |
| Träger | hält fest |
| Kundenaufgabe | KA-07: Messmittel und Zähler prüfen lassen, die Messplanung verantworten, eine Einstufung fachlich tragen. |
| Herkunft der Zuordnung | zugeordnet in AP-20 IP-7 (L-012): AP-16 Betrachtungsumfang, Energieeinsatz, Kriterien und Einstufung; PG/plan.md:600–612; docs/agents/root/uems-bewertung.md |

| Zusage | Wortlaut | Urteil im Entwurf |
|---|---|---|
| Z-001 | Eine Einstufung als wesentlich ist begründet, versioniert und mit den verwendeten Daten verbunden. | belegt |
| Z-047 | Unter „Bewertung“ legen Sie fest, welche Prozesse Energie einsetzen. | belegt |
| Z-048 | Die Messwerte schlagen eine Rangliste vor; einstufen, mit Begründung, tun Sie selbst. | belegt |

### 6.4

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Kennzahlen, an denen die Energieleistung gemessen und über die Zeit verfolgt wird |
| Träger | misst |
| Kundenaufgabe | KA-04: Ursachen benennen und die Wirkung einer Maßnahme belegen — als Aussage einer Person mit Begründung. VoltPilot schlägt vor und zeigt Messwerte. |
| Herkunft der Zuordnung | AP-17 Energieleistungskennzahl: FM/vp-uems-ap17-fundament/ist/C-luecken-iso-50001.md:4; docs/agents/root/uems-bezugsbasis.md |

| Zusage | Wortlaut | Urteil im Entwurf |
|---|---|---|
| Z-002 | Ein Rückgang der Produktion wird nicht automatisch als Effizienzverbesserung bewertet. | belegt |
| Z-051 | Nach der Freigabe heißt die Kennzahl Energieleistungskennzahl; der Vergleich mit der Bezugsbasis und der Bericht „Leistungsvergleich“ zeigen je Monat, was gemessen und was erwartet war, ein Urteil nur bereinigt und mit seinem Rahmen. | belegt |

### 6.5

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Der Bezugszeitraum, gegen den spätere Energieleistung verglichen wird, und wann er neu gesetzt wird |
| Träger | misst |
| Kundenaufgabe | KA-04: Ursachen benennen und die Wirkung einer Maßnahme belegen — als Aussage einer Person mit Begründung. VoltPilot schlägt vor und zeigt Messwerte. |
| Herkunft der Zuordnung | AP-17 Bezugsbasis: FM/vp-uems-ap17-fundament/ist/C-luecken-iso-50001.md:4, :40; docs/agents/root/uems-bezugsbasis.md |

| Zusage | Wortlaut | Urteil im Entwurf |
|---|---|---|
| Z-002 | Ein Rückgang der Produktion wird nicht automatisch als Effizienzverbesserung bewertet. | belegt |
| Z-050 | Mit einer Bezugsbasis legen Sie an einer Kennzahl fest, gegen welchen Zeitraum spätere Monate verglichen werden. | belegt |
| Z-051 | Nach der Freigabe heißt die Kennzahl Energieleistungskennzahl; der Vergleich mit der Bezugsbasis und der Bericht „Leistungsvergleich“ zeigen je Monat, was gemessen und was erwartet war, ein Urteil nur bereinigt und mit seinem Rahmen. | belegt |

### 6.6

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Festlegen, welche Energiedaten wie, wie oft und mit welchen Messmitteln erfasst werden |
| Träger | misst |
| Kundenaufgabe | KA-07: Messmittel und Zähler prüfen lassen, die Messplanung verantworten, eine Einstufung fachlich tragen. |
| Herkunft der Zuordnung | AP-16 Messbedarf und Messplanung, AP-17 Normalisierung: FM/vp-uems-ap17-fundament/ist/C-luecken-iso-50001.md:4, :53; PG/plan.md:612; Messung AP-04 bis AP-07 |

| Zusage | Wortlaut | Urteil im Entwurf |
|---|---|---|
| Z-007 | Für jeden unterstützten Messwert sind Herkunft und Umrechnung nachgewiesen. Ein Simulator ersetzt diesen Hardwarebeleg nicht. | offen |
| Z-009 | Ein neuer reiner Messkunde kann den vollständigen Weg von der Datenquelle bis zum Bericht nutzen. | offen |

### 7.1

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Mittel für das Energiemanagement bereitstellen: Personal, Budget, Technik |
| Träger | bleibt beim Kunden |
| Kundenaufgabe | KA-01: Ihr Energiemanagement als Ganzes einführen, mit Mitteln ausstatten, aufrechterhalten und verbessern. |
| Herkunft der Zuordnung | FM/vp-uems-ap19-fundament/zuschnitt.json Z. 17 (draußen; nur die Beschluss-Art „Ressourcen“ der Managementbewertung) |

Keine Zusage von VoltPilot an dieser Zeile.

### 7.2

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Welche Fähigkeiten die beteiligten Personen brauchen und wie das sichergestellt und belegt wird |
| Träger | Verweis auf das System des Kunden |
| Kundenaufgabe | KA-02: Festlegen, welche Kompetenz nötig ist, sie sicherstellen und nachweisen; Bewusstsein schaffen. VoltPilot hält an der Person nur den Verweis auf Ihren Nachweis. |
| Herkunft der Zuordnung | FM/vp-uems-ap19-fundament/zuschnitt.json Z. 7 (an der Person nur der Verweis auf den Nachweis des Kunden, ohne Überprüfung) |

Keine Zusage von VoltPilot an dieser Zeile.

### 7.3

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Dass die Beschäftigten die Energiepolitik und ihren eigenen Beitrag kennen |
| Träger | bleibt beim Kunden |
| Kundenaufgabe | KA-02: Festlegen, welche Kompetenz nötig ist, sie sicherstellen und nachweisen; Bewusstsein schaffen. VoltPilot hält an der Person nur den Verweis auf Ihren Nachweis. |
| Herkunft der Zuordnung | FM/vp-uems-ap19-fundament/zuschnitt.json Z. 18 (draußen: Unterweisung und Kultur) |

Keine Zusage von VoltPilot an dieser Zeile.

### 7.4

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Was über das Energiemanagement wem, wann und auf welchem Weg mitgeteilt wird, nach innen und außen |
| Träger | hält fest |
| Kundenaufgabe | KA-09: Entscheidungen der Leitung treffen und verantworten; Originale in Ihren Systemen führen, wo VoltPilot nur verweist. |
| Herkunft der Zuordnung | FM/vp-uems-ap19-fundament/zuschnitt.json Z. 8 (Bekanntmachung geführt; die Kanäle beim Kunden) |

| Zusage | Wortlaut | Urteil im Entwurf |
|---|---|---|
| Z-004 | Die erforderlichen Entscheidungen und Nachweise sind auffindbar; die Verantwortung des Kunden bleibt ausdrücklich erkennbar. | offen |

### 7.5.1

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Welche Dokumente und Aufzeichnungen das Energiemanagement braucht |
| Träger | hält fest |
| Kundenaufgabe | KA-09: Entscheidungen der Leitung treffen und verantworten; Originale in Ihren Systemen führen, wo VoltPilot nur verweist. |
| Herkunft der Zuordnung | FM/vp-uems-ap19-fundament/zuschnitt.json Z. 9 (Verzeichnis geführt); docs/agents/root/uems-energiemanagement-nachweise.md |

| Zusage | Wortlaut | Urteil im Entwurf |
|---|---|---|
| Z-004 | Die erforderlichen Entscheidungen und Nachweise sind auffindbar; die Verantwortung des Kunden bleibt ausdrücklich erkennbar. | offen |

### 7.5.2

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Dokumente anlegen und ändern: Kennzeichnung, Fassung, Prüfung und Freigabe |
| Träger | hält fest |
| Kundenaufgabe | KA-09: Entscheidungen der Leitung treffen und verantworten; Originale in Ihren Systemen führen, wo VoltPilot nur verweist. |
| Herkunft der Zuordnung | FM/vp-uems-ap19-fundament/zuschnitt.json Z. 9 (Fassung und Freigabe geführt, ohne Datei); docs/agents/root/uems-energiemanagement-dokumente.md |

| Zusage | Wortlaut | Urteil im Entwurf |
|---|---|---|
| Z-004 | Die erforderlichen Entscheidungen und Nachweise sind auffindbar; die Verantwortung des Kunden bleibt ausdrücklich erkennbar. | offen |
| Z-056 | Unter „Energiemanagement“ halten Sie Energiepolitik, Anwendungsbereich und weitere Dokumente mit Fassung und Freigabe fest, dazu Aufgaben, interne Audits, Feststellungen und die Managementbewertung mit den Beschlüssen Ihrer Leitung. | belegt |

### 7.5.3

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Dokumente und Aufzeichnungen lenken: verfügbar halten, schützen, aufbewahren, Änderungen nachvollziehen |
| Träger | hält fest |
| Kundenaufgabe | KA-06: Ihre eigenen Aufbewahrungspflichten erfüllen: vor dem Ende Ihres Vertrags den Gesamtabzug laden und selbst aufbewahren. |
| Herkunft der Zuordnung | FM/vp-uems-ap19-fundament/zuschnitt.json Z. 9 (Lenkung geführt); Betrieb: Sicherung, Aufbewahrung, Zugriffsschutz (AP-20 ist/D D4); docs/backup-restore.md |

| Zusage | Wortlaut | Urteil im Entwurf |
|---|---|---|
| Z-004 | Die erforderlichen Entscheidungen und Nachweise sind auffindbar; die Verantwortung des Kunden bleibt ausdrücklich erkennbar. | offen |
| Z-006 | Ein Nutzer mit Zugriff auf Standort A kann Werte von Standort B auch nicht über eine Unternehmenskennzahl oder einen Export ableiten. | belegt |
| Z-013 | Server in Deutschland | offen |
| Z-014 | Verschlüsselt | offen |
| Z-015 | Physische Sicherung mit Wiederherstellung auf den Punkt, 7 tägliche und 4 wöchentliche Stände (Kurzform) | offen |
| Z-016 | Zehn Jahre Viertelstundenwerte und erforderliche Nachweisgrundlagen | offen |
| Z-017 | VoltPilot sieht Kundendaten nur mit Gewährung durch den Kundenadministrator; der Notfall-Zugriff ist laut und protokolliert (Kurzform) | offen |
| Z-057 | Ihre Dateien bleiben in Ihren Systemen; das Portal zeigt, wo das Original liegt, und nennt die Fristen in der Wiedervorlage. | belegt |
| Z-058 | Die Rolle „Einsicht“ erlaubt nur das Ansehen. | belegt |

### 8.1

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Betrieb und Wartung der wesentlichen Energieeinsätze nach festgelegten Vorgaben planen und steuern |
| Träger | Verweis auf das System des Kunden |
| Kundenaufgabe | KA-09: Entscheidungen der Leitung treffen und verantworten; Originale in Ihren Systemen führen, wo VoltPilot nur verweist. |
| Herkunft der Zuordnung | FM/vp-uems-ap19-fundament/zuschnitt.json Z. 10 (Verweis am Energieeinsatz auf Arbeitspläne und Wartung des Kunden) |

| Zusage | Wortlaut | Urteil im Entwurf |
|---|---|---|
| Z-008 | Gemeinsame harte Grenzen werden auch bei Kommunikationsproblemen nachweislich eingehalten. Organisatorisch gemeinsam verwaltete, elektrisch getrennte Standorte werden nicht als ein Stromsystem behandelt. | offen |
| Z-011 | Mehrere Boxen werden nicht als eine Einheit optimiert. Jede Box liest ihre Quellen. | offen |

### 8.2

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Bei neuen oder geänderten Anlagen und Prozessen die Energieleistung schon in der Planung berücksichtigen |
| Träger | Verweis auf das System des Kunden |
| Kundenaufgabe | KA-09: Entscheidungen der Leitung treffen und verantworten; Originale in Ihren Systemen führen, wo VoltPilot nur verweist. |
| Herkunft der Zuordnung | FM/vp-uems-ap19-fundament/zuschnitt.json Z. 11 (Verweis auf die Planungsunterlagen des Kunden) |

Keine Zusage von VoltPilot an dieser Zeile.

### 8.3

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Beim Einkauf von Energie, Anlagen und Dienstleistungen die Energieleistung heranziehen |
| Träger | Verweis auf das System des Kunden |
| Kundenaufgabe | KA-09: Entscheidungen der Leitung treffen und verantworten; Originale in Ihren Systemen führen, wo VoltPilot nur verweist. |
| Herkunft der Zuordnung | FM/vp-uems-ap19-fundament/zuschnitt.json Z. 12 (Verweis auf Einkauf und Lieferantenbewertung des Kunden) |

Keine Zusage von VoltPilot an dieser Zeile.

### 9.1.1

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Energieleistung und Energiemanagement überwachen, messen, auswerten und bewerten |
| Träger | misst |
| Kundenaufgabe | KA-04: Ursachen benennen und die Wirkung einer Maßnahme belegen — als Aussage einer Person mit Begründung. VoltPilot schlägt vor und zeigt Messwerte. |
| Herkunft der Zuordnung | zugeordnet in AP-20 IP-7 (L-012): Messung, Kennzahlen und Berichte AP-04 bis AP-13, Leistungsvergleich AP-17, Auffälligkeit AP-18; FM/vp-uems-ap18-fundament/ist/C-luecken-iso-50001.md:4, :43. Ursachenregel „Ursache braucht Fakt“: docs/agents/root/erklaerbarkeit-stufe-0-die-echtheits-reg.md:9–10 (aus AGENTS.md ausgelagert), PG/plan.md:413 und :659; nicht „AP-08 E7“, das ist der Kasten Ersatzwerte (AP-20 W7) |

| Zusage | Wortlaut | Urteil im Entwurf |
|---|---|---|
| Z-002 | Ein Rückgang der Produktion wird nicht automatisch als Effizienzverbesserung bewertet. | belegt |
| Z-009 | Ein neuer reiner Messkunde kann den vollständigen Weg von der Datenquelle bis zum Bericht nutzen. | offen |
| Z-051 | Nach der Freigabe heißt die Kennzahl Energieleistungskennzahl; der Vergleich mit der Bezugsbasis und der Bericht „Leistungsvergleich“ zeigen je Monat, was gemessen und was erwartet war, ein Urteil nur bereinigt und mit seinem Rahmen. | belegt |
| Z-054 | Ist ein abgeschlossener Monat schlechter, als die Bezugsbasis erwarten lässt, vermerkt das Portal eine Auffälligkeit; ob daraus eine Abweichung oder eine Maßnahme wird und ob die Wirkung einer Maßnahme belegt ist, entscheiden Sie selbst, mit Begründung. | belegt |

### 9.1.2

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Prüfen, ob rechtliche und andere Anforderungen zur Energie eingehalten werden |
| Träger | bleibt beim Kunden |
| Kundenaufgabe | KA-03: Bewerten, ob Sie rechtliche und andere Anforderungen einhalten. VoltPilot bewertet das nicht. |
| Herkunft der Zuordnung | FM/vp-uems-ap19-fundament/zuschnitt.json Z. 19 (draußen: die Bewertung selbst) und Z. 3 (Rechtskataster als Verweis) |

Keine Zusage von VoltPilot an dieser Zeile.

### 9.2.1

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Interne Audits: wozu sie dienen und dass sie in geplanten Abständen stattfinden |
| Träger | hält fest |
| Kundenaufgabe | KA-08: Interne Audits durchführen (Gespräche, Begehung), Auditorinnen und Auditoren auswählen und ihre Unabhängigkeit sichern. |
| Herkunft der Zuordnung | FM/vp-uems-ap19-fundament/zuschnitt.json Z. 13 (Audit, Hinweis und Feststellung geführt; Durchführung beim Kunden) |

| Zusage | Wortlaut | Urteil im Entwurf |
|---|---|---|
| Z-005 | AP-19: Audit, Feststellung, Maßnahme und Wirksamkeit durch eine Person (Kurzform; Teil der Abnahme, zuschnitt.json Z. 13 und 15) | belegt |
| Z-056 | Unter „Energiemanagement“ halten Sie Energiepolitik, Anwendungsbereich und weitere Dokumente mit Fassung und Freigabe fest, dazu Aufgaben, interne Audits, Feststellungen und die Managementbewertung mit den Beschlüssen Ihrer Leitung. | belegt |

### 9.2.2

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Interne Audits planen: Programm, Umfang, Auswahl unabhängiger Auditierender, Bericht an die Leitung |
| Träger | hält fest |
| Kundenaufgabe | KA-08: Interne Audits durchführen (Gespräche, Begehung), Auditorinnen und Auditoren auswählen und ihre Unabhängigkeit sichern. |
| Herkunft der Zuordnung | FM/vp-uems-ap19-fundament/zuschnitt.json Z. 13 |

| Zusage | Wortlaut | Urteil im Entwurf |
|---|---|---|
| Z-005 | AP-19: Audit, Feststellung, Maßnahme und Wirksamkeit durch eine Person (Kurzform; Teil der Abnahme, zuschnitt.json Z. 13 und 15) | belegt |

### 9.3

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Die Leitung bewertet das Energiemanagement in Abständen: Eingaben, Ergebnisse, Beschlüsse |
| Träger | hält fest |
| Kundenaufgabe | KA-09: Entscheidungen der Leitung treffen und verantworten; Originale in Ihren Systemen führen, wo VoltPilot nur verweist. |
| Herkunft der Zuordnung | FM/vp-uems-ap19-fundament/zuschnitt.json Z. 14 (Vorlage, Sitzung und Beschlüsse geführt); docs/agents/root/uems-managementbewertung-beschluesse.md |

| Zusage | Wortlaut | Urteil im Entwurf |
|---|---|---|
| Z-004 | Die erforderlichen Entscheidungen und Nachweise sind auffindbar; die Verantwortung des Kunden bleibt ausdrücklich erkennbar. | offen |
| Z-056 | Unter „Energiemanagement“ halten Sie Energiepolitik, Anwendungsbereich und weitere Dokumente mit Fassung und Freigabe fest, dazu Aufgaben, interne Audits, Feststellungen und die Managementbewertung mit den Beschlüssen Ihrer Leitung. | belegt |

### 10.1

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Mit Abweichungen umgehen: korrigieren, Ursachen klären, handeln und die Wirksamkeit prüfen |
| Träger | hält fest |
| Kundenaufgabe | KA-04: Ursachen benennen und die Wirkung einer Maßnahme belegen — als Aussage einer Person mit Begründung. VoltPilot schlägt vor und zeigt Messwerte. |
| Herkunft der Zuordnung | FM/vp-uems-ap19-fundament/zuschnitt.json Z. 15 (Feststellung, Maßnahme, Wirksamkeit geführt; die Ursachenanalyse beim Kunden). Ursachenregel „Ursache braucht Fakt“: docs/agents/root/erklaerbarkeit-stufe-0-die-echtheits-reg.md:9–10 (aus AGENTS.md ausgelagert), PG/plan.md:413 und :659; nicht „AP-08 E7“, das ist der Kasten Ersatzwerte (AP-20 W7) |

| Zusage | Wortlaut | Urteil im Entwurf |
|---|---|---|
| Z-005 | AP-19: Audit, Feststellung, Maßnahme und Wirksamkeit durch eine Person (Kurzform; Teil der Abnahme, zuschnitt.json Z. 13 und 15) | belegt |
| Z-056 | Unter „Energiemanagement“ halten Sie Energiepolitik, Anwendungsbereich und weitere Dokumente mit Fassung und Freigabe fest, dazu Aufgaben, interne Audits, Feststellungen und die Managementbewertung mit den Beschlüssen Ihrer Leitung. | belegt |

### 10.2

| Feld | Inhalt |
|---|---|
| Umschreibung (eigene Worte) | Energieleistung und Energiemanagement fortlaufend verbessern |
| Träger | hält fest |
| Kundenaufgabe | KA-04: Ursachen benennen und die Wirkung einer Maßnahme belegen — als Aussage einer Person mit Begründung. VoltPilot schlägt vor und zeigt Messwerte. |
| Herkunft der Zuordnung | FM/vp-uems-ap19-fundament/zuschnitt.json Z. 20; AP-18: FM/vp-uems-ap18-fundament/ist/C-luecken-iso-50001.md:73. Ursachenregel „Ursache braucht Fakt“: docs/agents/root/erklaerbarkeit-stufe-0-die-echtheits-reg.md:9–10 (aus AGENTS.md ausgelagert), PG/plan.md:413 und :659; nicht „AP-08 E7“, das ist der Kasten Ersatzwerte (AP-20 W7) |

| Zusage | Wortlaut | Urteil im Entwurf |
|---|---|---|
| Z-003 | Die Software behauptet keine Ursache, die die Daten nicht tragen. | belegt |
| Z-054 | Ist ein abgeschlossener Monat schlechter, als die Bezugsbasis erwarten lässt, vermerkt das Portal eine Auffälligkeit; ob daraus eine Abweichung oder eine Maßnahme wird und ob die Wirkung einer Maßnahme belegt ist, entscheiden Sie selbst, mit Begründung. | belegt |

## 2 Übersicht für Prüfende und Produktbeschreibung

Im Entwurf, gelesen aus `docs/bewertung/produktbeschreibung/`:

| Datei | SHA-256 |
|---|---|
| beschreibung.md | `385e97e26aa255c4c13e0a410bfab0fe043ae5b2b1867767ac13acd13081d1ad` |
| produktbeschreibung.json | `3c05821eea231e8657fa2e5919b7cf9f7cc9d2cb98dd46cc36e2ff6a192556ea` |
| produktbeschreibung.sha256 | `e57401c946e41a561fb0551578601930ca1d38885aa30322d16350ccd9e474d5` |
| uebersicht-fuer-pruefende.md | `d8fabecb0b6d742730c29f5ef8cde99e165a458a7025e656a3f7ad5f2b8f0056` |

## 3 Frageliste

Zu jeder Zeile des Norm-Teils zwei Fragen: **Stimmt die Zuordnung** (Träger, Zusagen, Kundenaufgabe) und **ist die Lesart tragfähig**, die VoltPilot aus ihr macht? Ihre Antwort ist die Lesart der Zeile. Dazu die folgenden Fragen, deren Antwort in `antworten` der Vorlage steht:

**F-01 · Gliederung** (4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 7.1, 7.2, 7.3, 7.4, 7.5.1, 7.5.2, 7.5.3, 8.1, 8.2, 8.3, 9.1.1, 9.1.2, 9.2.1, 9.2.2, 9.3, 10.1, 10.2)

Stimmt die Gliederung der 30 Zeilen mit Ihrer Ausgabe überein: die Abschnitte der zweiten Ebene von 4 bis 10, dazu 7.5, 9.1 und 9.2 in ihre Unterabschnitte geteilt? Die Gliederung ist aus eigenem Wissen der Crew, nicht aus einer lizenzierten Ausgabe.

**F-02 · Zuordnung ohne Vorlage** (4.4)

Trägt die Zuordnung von 4.4? Träger: bleibt beim Kunden, Kundenaufgabe KA-01. Herkunft: zugeordnet in AP-20 IP-7 (L-012): ganz beim Kunden, KA-01; VoltPilot trägt nur Teile, die andere Zeilen nennen. Zuvor nur FM/vp-uems-ap19-fundament/ist/C-luecken.md:31. Bis AP-20 IP-7 hatte die Zeile keine Zuordnung (L-012).

**F-03 · Zuordnung ohne Vorlage** (6.3)

Trägt die Zuordnung von 6.3? Träger: hält fest, Kundenaufgabe KA-07. Herkunft: zugeordnet in AP-20 IP-7 (L-012): AP-16 Betrachtungsumfang, Energieeinsatz, Kriterien und Einstufung; PG/plan.md:600–612; docs/agents/root/uems-bewertung.md. Bis AP-20 IP-7 hatte die Zeile keine Zuordnung (L-012).

**F-04 · Zuordnung ohne Vorlage** (9.1.1)

Trägt die Zuordnung von 9.1.1? Träger: misst, Kundenaufgabe KA-04. Herkunft: zugeordnet in AP-20 IP-7 (L-012): Messung, Kennzahlen und Berichte AP-04 bis AP-13, Leistungsvergleich AP-17, Auffälligkeit AP-18; FM/vp-uems-ap18-fundament/ist/C-luecken-iso-50001.md:4, :43. Ursachenregel „Ursache braucht Fakt“: docs/agents/root/erklaerbarkeit-stufe-0-die-echtheits-reg.md:9–10 (aus AGENTS.md ausgelagert), PG/plan.md:413 und :659; nicht „AP-08 E7“, das ist der Kasten Ersatzwerte (AP-20 W7). Bis AP-20 IP-7 hatte die Zeile keine Zuordnung (L-012).

**F-05 · Klimafrage der Änderung 1** (4.1, 4.2)

Reicht es für 4.1 und 4.2, die Klimafrage der Änderung 1 ganz als Kundenaufgabe zu führen? KA-05: Beurteilen, ob der Klimawandel und klimabezogene Anforderungen für Ihr Energiemanagement relevant sind. VoltPilot führt dazu keine Angaben. Oder erwartet Ihre Lesart, dass VoltPilot dazu etwas festhält?

**F-06 · Grenze zwischen Verweis und geführt** (4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 7.2, 7.4, 7.5.1, 7.5.2, 7.5.3, 8.1, 8.2, 8.3, 9.2.1, 9.2.2, 9.3, 10.1, 10.2)

Liegt die Grenze zwischen Verweis und geführt richtig? Bei 4.1, 4.2, 6.1, 7.2, 8.1, 8.2, 8.3 verweist VoltPilot nur auf das System des Kunden und führt das Original nicht (Kundenaufgabe KA-09 oder die der Zeile). Bei 4.3, 5.1, 5.2, 5.3, 6.2, 6.3, 7.4, 7.5.1, 7.5.2, 7.5.3, 9.2.1, 9.2.2, 9.3, 10.1, 10.2 hält VoltPilot fest. Genügt ein Verweis dort, wo er steht, und reicht das Festhalten dort, wo es steht, oder braucht eine Zeile den anderen Träger?

## 4 Protokoll-Vorlage

`protokoll-vorlage.json` trägt je Norm-Zeile und je Frage leere Felder. Füllen Sie je gelesener Zeile:

| Feld | Inhalt |
|---|---|
| `name` | Ihr Name |
| `datum` | Tag der Lesart, JJJJ-MM-TT |
| `lesart` | `traegt`, `anmerkung` oder `widerspruch` |
| `text` | Ihre Aussage in eigenen Worten, ohne Normtext |

Im Kopf `fachperson`: Name, Rolle, eine Bestätigung der Unabhängigkeit von der Entwicklung (FP2) und die Ausgabe, an der Sie gelesen haben. Was danach geschieht (AP-20 IP-12): **trägt** macht die Zeile „nicht maschinell prüfbar“ mit Ihrem Namen; **Anmerkung** hält sie offen mit Ihrem Text; **Widerspruch** wird eine Lücke des Betreibers, kein Satz ändert sich still (FP3). Eine Zeile ohne Lesart bleibt offen; Ihre Bestätigung trägt nur die Zeilen, die Sie gelesen haben. Das ausgefüllte Protokoll bekommt eine eigene Prüfsumme und liegt neben der Matrix (FP4).
