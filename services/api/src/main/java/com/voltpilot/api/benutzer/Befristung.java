package com.voltpilot.api.benutzer;

import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.zugriff.ZugriffAenderung;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;

/**
 * „Gültig bis“ beim Anlegen eines Kontos und beim Ändern einer Zuweisung (AP-19 Folge IP-13; RE3, R6: „Einsicht vom
 * 20. bis 31.01.2029“ in einem Schritt). Letzter Tag, einschließlich, im Kalender des Kundenbereichs — dieselben Regeln
 * wie {@code POST /api/v1/zugriff} ({@link ZugriffAenderung#befristbar}, {@link ZugriffAenderung#vorHeute}), aber
 * geprüft, BEVOR etwas geschrieben ist, und mit den Fehlern der Benutzerverwaltung.
 */
final class Befristung {
    private Befristung() {}

    /** {@code null} = unbefristet (Feld fehlt oder leer); sonst der letzte Tag. */
    static LocalDate lesen(String wert, Rolle rolle, ZugriffAenderung aenderung) {
        if (wert == null || wert.isBlank()) return null;
        LocalDate bis;
        try { bis = LocalDate.parse(wert.trim()); }
        catch (DateTimeParseException e) {
            throw new BenutzerFehler(400, "anfrage_ungueltig", "Bitte geben Sie den letzten Tag als Datum an.");
        }
        if (!ZugriffAenderung.befristbar(rolle)) {
            throw new BenutzerFehler(400, "anfrage_ungueltig", "Befristen lässt sich nur die Rolle Einsicht.");
        }
        if (aenderung.vorHeute(bis)) {
            throw new BenutzerFehler(422, "gueltig_bis_vergangen",
                    "Bitte wählen Sie als letzten Tag heute oder einen späteren Tag.");
        }
        return bis;
    }
}
