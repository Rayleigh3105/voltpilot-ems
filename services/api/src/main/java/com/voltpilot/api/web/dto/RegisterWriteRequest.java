package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.UUID;

/**
 * Was der Mensch im Register-Drawer eingetragen hat - ROH, in seiner eigenen
 * Schreibweise.
 *
 * <p><b>Adresse und Wert sind absichtlich Zeichenketten.</b> Das Journal
 * speichert sie VERBATIM (Captain-Schärfung 19.08.2026): steht später die Frage
 * „ich habe 231 getippt, nicht 0x00E7", zeigt die Papier-Spur die exakte
 * Eingabe und nicht unsere Normalisierung. Die Zahl daneben entsteht im Server
 * ({@link com.voltpilot.api.registerwrite.RegisterKnowledge}).
 *
 * <p>Der Bestätigungs-Token des Kontrakts wird NICHT hier erwartet: das Portal
 * baut ihn aus dem, was der Mensch gesehen hat. Er ist Protokoll-Sicherheit,
 * kein Tipp-Zwang („ohne Hürden").
 *
 * @param deviceId       das Ziel-Gerät; ohne Angabe entscheidet das einzige
 *                       Gerät der Anlage, mehrere werden beim Namen genannt.
 * @param registerKind   {@code holding} (Vorgabe) oder {@code coil}.
 * @param address        die getippte Adresse, dezimal oder {@code 0x}-hex.
 * @param value          der getippte ROHWERT (kein kW) - nur beim Schreiben.
 * @param expectedBefore der Ist-Wert der Vorschau. Er reist als Wächter mit: hat
 *                       sich das Register seither geändert, verweigert die Box,
 *                       statt blind zu überschreiben.
 * @param writeFc        5|6|16, oder leer - dann entscheidet die Box (Spule 5,
 *                       Holding 16; FC16 ist die Vorauswahl, weil viele
 *                       Firmwares einen FC6-Rahmen ANNEHMEN und nie übernehmen).
 * @param note           der Grund, verbatim ins Journal. PFLICHT bei Registern
 *                       der Klasse {@code netz_compliance} (D5).
 */
public record RegisterWriteRequest(
        UUID deviceId,
        @Size(max = 16) String registerKind,
        @NotBlank @Size(max = 16) String address,
        @Size(max = 16) String value,
        @Min(0) @Max(65535) Integer expectedBefore,
        @Min(5) @Max(16) Integer writeFc,
        @Size(max = 500) String note) {
}
