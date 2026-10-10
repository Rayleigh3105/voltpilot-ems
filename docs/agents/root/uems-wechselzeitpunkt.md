# Angekündigten Wechsel berichtigen (AP-04 A3)

`POST /api/v1/geraete/{id}/austausch/zeitpunkt` adressiert den Vorgänger und trägt
`{bisher, zeitpunkt, grund?}`. Beide Zeitpunkte müssen noch in der Zukunft liegen.
Die Kennung ist wie beim Wechsel `messstelle.quelle`; fremde Geräte bleiben 404.
409 nennt `grund` und `satz`: wirksam, inzwischen geändert oder Messwerte zwischen
den Grenzen. Vergangenes gehört zum AP-08-Korrekturweg.

`WechselzeitpunktService` sperrt beide Einbauten und die Messwerttabellen während
Prüfung und Schreiben. Auch Altdaten ohne Komponentenkennung werden konservativ
innerhalb derselben Anlage berücksichtigt. Eine Transaktion verschiebt Gerät,
Karten, Komponentenspeisungen, Quellenbindungen und die beim Wechsel beginnenden
Einstellungsfassungen. Beim Vorziehen endet zuerst der Vorgänger; beim Verschieben
nach hinten beginnt zuerst der Nachfolger, damit die Exklusionen nie überlappen.

Die ursprüngliche Ankündigung bleibt in beiden Journalen. Die Berichtigung ergänzt
`zaehler_gewechselt` mit `anlass=zeitpunkt_berichtigt` sowie einen `edited`-Eintrag
mit altem/neuem Zeitpunkt und eigener Notiz in `component_change_event`. Diese
beiden Belege sind Bestandteil der atomaren Berichtigung.

Migration `V20260917114000` erweitert nur fünf Spaltenrechte: den Einbaubeginn von
Gerät/Karte und den Gültigkeitsbeginn von Speisung/Bindung/Einstellung. Bestehende
Endrechte werden wiederverwendet. Trigger prüfen Zukunft und Wechselbeleg unter
RLS; verzögerte Trigger prüfen die gemeinsame Gerätegrenze. Die bisherigen
Quellen-/Einstellungswächter lassen nur diese zeitliche Ausnahme zu. Kein DELETE,
kein neuer Identitäts- oder Messwert-Schreibweg, keine neuen Spalten.

Weitere Wege zum Objekt: Quellenwechsel an der Messstelle und Austausch am Gerät
teilen `ZaehlerwechselService`; Controllerkarten nutzen denselben Weg. Quellen-
Beenden/Archivieren und neue Einstellungsfassungen bleiben beim bisherigen
Schreibweg. Box-Nachfolge und Datenquellen-Zuständigkeit sind andere Identitäten.

Portal: `ZaehlerwechselDialog` erkennt das noch angekündigte Einbaupaar und öffnet
`WechselzeitpunktDialog` mit dem Standort-Zeitpunktpicker. Der Geräte-Einstieg heißt
„Zeitpunkt berichtigen“; auch der Quellen-Einstieg verwendet denselben Dialog.
Die Einträge im Komponenten-Verlauf bleiben lesbar, einschließlich Berichtigungen.

Nachweis: `ZaehlerwechselApiTest.a3AngekuendigtenWechselzeitpunktKorrigieren`
prüft beide Richtungen, Einstellungen, Protokolle, Rollback, fremd 404, wirksam 409,
Messwerte und DB-Sperre. A6 prüft zusätzlich alle vier Karten. Die A3-Platzhalter-
Methode ist durch diese echte Abnahme ersetzt. Browser: `zaehlerwechsel.spec.ts`,
`controllerwechsel.spec.ts`, `geraet-herkunft.spec.ts`, 375/1440 Pixel.
