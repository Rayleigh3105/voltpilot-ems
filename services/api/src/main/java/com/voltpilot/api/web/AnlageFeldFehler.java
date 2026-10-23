package com.voltpilot.api.web;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.FieldError;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * Anlage-Flow a1, Befund F4: jede Ablehnung 400 hieß im Portal „Bitte prüfen Sie den Namen Ihrer
 * Anlage“, auch bei einer Einspeisegrenze mit drei Nachkommastellen - die Antwort der
 * Bean-Validation nannte kein Feld. Jetzt antwortet {@code POST}/{@code PUT /api/v1/sites} in der
 * Form der Ortsstruktur: {@code {code: "anfrage_ungueltig", feld, message}} mit einem deutschen
 * Satz, das Portal markiert das Feld und setzt den Fokus. Die Grenzen stehen weiter an
 * {@code CreateSiteRequest}/{@code UpdateSiteRequest}; die Sätze nennen sie nur.
 */
@RestControllerAdvice(assignableTypes = SiteController.class)
public class AnlageFeldFehler {

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<Map<String, Object>> ungueltig(MethodArgumentNotValidException e) {
        FieldError f = e.getBindingResult().getFieldError();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", "anfrage_ungueltig");
        body.put("feld", f == null ? null : f.getField());
        body.put("message", f == null ? "Bitte prüfen Sie Ihre Angaben." : satz(f.getField(), f.getCode()));
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(body);
    }

    /** Der Satz zum Feld und zur verletzten Regel ({@code Digits}, {@code DecimalMin}, …). */
    static String satz(String feld, String regel) {
        boolean stellen = "Digits".equals(regel);
        return switch (feld) {
            case "name" -> "Bitte geben Sie einen Namen für Ihre Anlage ein.";
            case "maxFeedInKw" -> stellen
                    ? "Höchstens zwei Nachkommastellen und unter 1.000.000 kW, z. B. 29,99."
                    : "Die Einspeisegrenze muss größer als 0 kW sein.";
            case "anzulegenderWertCtKwh" -> stellen
                    ? "Höchstens drei Nachkommastellen und unter 100.000 ct/kWh, z. B. 8,113."
                    : "Der anzulegende Wert darf nicht negativ sein.";
            case "tarifParamCtKwh" -> stellen
                    ? "Höchstens drei Nachkommastellen und unter 100.000 ct/kWh, z. B. 32,5."
                    : "Der Preis darf nicht negativ sein.";
            case "latitude", "longitude" -> "Der Punkt auf der Karte ist ungültig. Bitte setzen Sie ihn neu.";
            default -> "Bitte prüfen Sie diese Angabe.";
        };
    }
}
