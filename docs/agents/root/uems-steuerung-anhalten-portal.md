# Steuerung anhalten und fortsetzen im Portal (AP-01 IP-11)

Die Steuerungsseite liest `GET /api/v1/funktionen`, ordnet die Teilnahme über die Anlagenkennung zu und zeigt bei
`eingerichtet` „Eingerichtet am … — Steuerung noch nicht gestartet“, bei `angehalten` „Angehalten seit …“.
Anhalten und Fortsetzen verwenden ausschließlich die gebauten Funktionsrouten; die Standort-Karte ruft die
Standort-Route für alle teilnehmenden Anlagen auf.

- Der gemeinsame Bestätigungsweg ist `components/FunktionSteuerungAktion.tsx`. Vor jedem Schreiben nennt er die
  betroffenen Anlagen und die Folgen. Sichtbar wird er nur mit `steuerung.anhalten_fortsetzen` aus `rollen.ts`.
- Die Server-Aktionslisten sind das Tor: ohne `anhalten` oder `fortsetzen` gibt es keinen Knopf. Die Standort-Karte
  leitet ihre Betroffenenliste aus genau den Teilnahmen ab, die dieselbe Aktion erlauben.
- Während `angehalten` bekommt `JetztZone` keine Handeingriffs-Affordanz. Regeln und Betriebsmodelle bleiben lesbar
  und bearbeitbar, sind aber abgedimmt und tragen „wirkt nicht — angehalten seit …“.
- Eine Anlage mit `kein_objekt` bleibt auf ihrer Steuerungsseite still. In der Funktions-Karte entfällt der ganze
  Steuern-Abschnitt, wenn am Standort keine Anlage teilnimmt; reine Messkunden sehen dadurch keine Steuer-Wörter.

Nachweise: `steuerungArea.test.ts`, `FunktionSteuerungAktion.test.tsx`, `JetztZone.test.tsx`,
`SteuerungSection.test.tsx`, `funktionenKarte.test.ts` und `e2e/steuerung-anhalten.spec.ts` (375/1440 px).
