# Saldo-Schreibweg (AP-10 IP-16)

`MessstelleFormelDto.Anlegen` nimmt `formel_typ` und `gueltig_ab` optional entgegen.
Fehlend bleibt die gewichtete Summe mit Fassung 1 seit Beginn; alte Konstruktoren bleiben erhalten.
`MessstelleFormelService` prüft das Saldo-Paar aus der Stellung am Gültigkeitstag:
zwei gemessene Wirkenergie-Messstellen, Hauptzähler Bezug plus und Abgabe minus derselben Anlage,
Faktor 1, ganzer Eingang. Der Geräte-Kontext wird vor der Typprüfung unverändert geprüft.

`V20260917106000` erweitert nur die Fassungs-Typen und den Hauptgrößen-CHECK:
`saldiert` ist eine berechnete Intervallmenge. Gemessene Größen und Quellen behalten ihren Katalog.
Der Typ-Zwilling leitet die Hauptgröße ab; die bestehende Fassungslogik wahrt Größe, Kreisprüfung
und inklusive Tage. Vor der ersten Fassung ist der Live-Wert unbekannt, keine Nullsumme.

`BerechnetePeriodenLauf` reicht die gespeicherten Eingangsmengen derselben Periode an
`MessstelleFormelRegeln.periodenwert` weiter. Sample-Live und der alte Sample-Verlauf geben
für Saldo keine Zahl aus: Zählerstände und kW-Samples sind keine Intervallmengen.
Die Werte stehen im AP-08-Mengen-Leseweg `…/messstellen/{kennzeichen}/werte`.

Nachweise: `MessstelleFormelFassungApiTest`, `UemsBerechnetePeriodenwerteTest`,
`SummenwertKontextServiceTest`, Formel-Vektorleser und die sechs Migrations-Nachbarn.
Vertrag: [Formel](../../contracts/v2/messstelle-formel.md).
