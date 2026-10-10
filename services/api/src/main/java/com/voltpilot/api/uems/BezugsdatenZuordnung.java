package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.BezugsdatenImportDto;
import java.util.Map;

/** Eine Stelle für die Abbildung der API-Zuordnung auf die reine Vorschau-Regel. */
public final class BezugsdatenZuordnung {
    private BezugsdatenZuordnung() {}

    public static ImportVorschau.Zuordnung aus(BezugsdatenImportDto.Zuordnung a) {
        if (a == null) {
            throw BezugsgroesseAbgelehnt.anfrage("zuordnung");
        }
        BezugsdatenImportDto.Csv c = a.csv();
        if (c != null && c.kodierung() != null && !CsvLeser.KODIERUNGEN.contains(c.kodierung())) {
            throw BezugsgroesseAbgelehnt.anfrage("csv.kodierung");
        }
        if (c != null && c.trennzeichen() != null && !CsvLeser.TRENNZEICHEN.contains(c.trennzeichen())) {
            throw BezugsgroesseAbgelehnt.anfrage("csv.trennzeichen");
        }
        BezugsdatenImportDto.Spalten s = a.spalten();
        ImportVorschau.Zuordnung z = new ImportVorschau.Zuordnung(
                c == null ? CsvLeser.Vorgabe.ERKENNEN : new CsvLeser.Vorgabe(c.kodierung(), c.trennzeichen(), c.kopfzeile()),
                s == null ? null : new ImportVorschau.Spalten(s.periode(), s.bis(), s.wert(), s.einheit(), s.bezug(), s.bemerkung()),
                a.deutung(), a.zahlformat(), leer(a.einheit()), leer(a.bezugsgroesse()),
                a.bezugTabelle() == null ? Map.of() : a.bezugTabelle(), a.synonyme() == null ? Map.of() : a.synonyme());
        String fehler = ImportVorschau.zuordnungFehler(z);
        if (fehler != null) {
            throw BezugsgroesseAbgelehnt.anfrage(fehler);
        }
        return z;
    }

    private static String leer(String text) {
        return text == null || text.isBlank() ? null : text;
    }
}
