package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/**
 * Die Antwort auf „Jetzt lesen" (Einheitsmodell Stufe 3, Konzept
 * vp-modbus-baukasten-k6 §2.3/§2.5) - der Moment, in dem ein Skalierungsfehler
 * SICHTBAR wird.
 *
 * <p><b>Roh UND skaliert stehen nebeneinander, immer.</b> Das ist der ganze
 * Zweck: „13 750" neben „1 375,0 °C" sagt einem Menschen in einer Sekunde, dass
 * die Skalierung um den Faktor 10 danebenliegt - eine Zahl allein sagt es nie.
 * {@code registers} trägt zusätzlich die rohen 16-Bit-Wörter, damit auch eine
 * falsche Wortreihenfolge sichtbar wird und nicht bloß falsch ist.
 *
 * <p><b>Ein Fehlschlag trägt NIE einen Wert.</b> Alle Zahlen sind geboxt und
 * {@code NON_NULL}: eine Lesung, die nicht geklappt hat, hat keinen Messwert -
 * nie eine 0, die sich wie eine Messung liest (die Hausregel „Lücke statt
 * Null").
 *
 * @param hint der Plausibilitäts-HINWEIS, falls einer auffällt. Er sperrt
 *     nichts - ein Register, das wir für unplausibel halten, kann am echten
 *     Gerät richtig sein.
 * @param receipt ob dieser Lauf das Speichern freigibt (die
 *     Verbindungstest-Pflicht). So sieht der Assistent ohne Zweitfrage, ob der
 *     „Anlegen"-Knopf aufgehen darf.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record SelfBuildReadResult(
        boolean ok,
        Double raw,
        List<Integer> registers,
        Double value,
        String unit,
        String hint,
        String errorCode,
        String message,
        boolean receipt) {
}
