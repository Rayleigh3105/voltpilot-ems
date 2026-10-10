# Ersatzwerte in gröberen Perioden (AP-08 IP-13/IP-17, Nacharbeit E7/E9)

`ErsatzwertPerioden` und der reine Portal-Zwilling `ersatzwertPerioden.ts` rechnen gegen
`verbrauch-vectors.json/ersatzwert_perioden`. `KaskadeStufen` ruft die Regel für d–g an;
a–c behalten `VerbrauchRegeln.mitErsatzwerten` und die Invariante Summe = gemessener Zuwachs.

- **d:** IP-13 prüft die Ablesestände und rechnet Z4. Die Kaskade liest dessen neueste
  Viertelstunden-Version mit genau diesem Ersatzwert. Sie ersetzt den bisherigen Beitrag
  durch den neuen (F12: 14,28 → 14,81, also +0,53 kWh in Tag, Monat und Jahr).
  Fehlende oder nicht passende Viertelstunden-Version: benannte Ablehnung, keine halbe Kaskade.
- **e:** ein Betrag kann eine Spanne bis zu einem Kalendermonat in der Standort-Zone tragen.
  Er erzeugt **keine** Viertelstundenanteile. Eine gröbere Periode übernimmt ihn nur, wenn sie
  seine ganze Spanne enthält. Angeschnittene Tage erhalten keine erfundene Aufteilung.
- **e/f/g mit Viertelstunden:** die Menge der ersetzten Viertelstunde wird aus dem bisherigen
  Beitrag herausgenommen und durch den eingegebenen/übernommenen Betrag ersetzt. Keinen
  Betrag zusätzlich auf einen bereits enthaltenen Messwert addieren.
- **Grundlage:** immer die Messwerte mit freigegebenen Korrekturen, ohne frühere Ersatzwerte.
  Rücknahme rechnet daraus neu; Originale bleiben erhalten. Abdeckung bleibt gemessen.
- **Fehlender Monat:** ein belegter Monatsbetrag braucht keine gemessene Viertelstunde innerhalb
  des Monats. Die Wertart wird wie bei IP-13 aus der nächstliegenden gespeicherten Viertelstunde
  derselben Reihe gelesen; unbekannte Wertarten bleiben abgelehnt.
- `ErsatzwertPerioden.geltende` verwendet die Prüfung von IP-13 und dessen Kennungsreihenfolge.
  Ein Periodenbetrag belegt seine ganze Spanne bei der Überschneidungsprüfung.

Die bisherige Ablehnung `betrag_fuer_mehrere_viertelstunden` bleibt an der **Verteilungsfunktion**
richtig: sie darf aus einem gröberen Betrag kein Profil machen. Der Job nimmt einen zulässigen
Periodenbetrag dagegen an, schreibt keine Viertelstunden und übergibt an die Kaskade. Der alte
Vektorblock `ersatzwerte` bleibt byte-gleich; die gröberen Ergebnisse stehen im ergänzten Block.

Nachweise: `ErsatzwertPeriodenTest`, `UemsErsatzwertMethodenTest`, `UemsKaskadeErsatzwertTest`,
`ersatzwertPerioden.test.ts`; alle Leser der Verbrauchsvektoren bei Änderungen mitlaufen lassen.
Keine neue Migration. Freigabe-Grenze und Kundenrouten sind der folgende Bauabschnitt.
