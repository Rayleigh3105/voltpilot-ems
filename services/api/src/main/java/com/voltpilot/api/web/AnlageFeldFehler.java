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
 *
 * <p>Paket 3 („Fehler am Feld überall“): dieselbe Form an den Routen, die der Anlege-Weg in Schritt 3
 * spricht - Speicher und Modulleistung ({@code PUT /sites/{id}/battery}, {@code /pv}) und die Übernahme
 * eines gefundenen Geräts ({@code POST /sites/{id}/v2-entities/adopt}).
 */
@RestControllerAdvice(assignableTypes = {SiteController.class, SiteBatteryController.class,
        SiteEntityAdoptController.class})
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
            case "capacityKwp" -> stellen
                    ? "Höchstens zwei Nachkommastellen, z. B. 9,8 kWp."
                    : "Bitte geben Sie die Leistung der Solarmodule als Zahl über 0 kWp an, z. B. 9,8.";
            case "capacityKwh" -> "Bitte geben Sie die Kapazität des Speichers als Zahl über 0 kWh an, z. B. 10.";
            case "maxChargeKw", "maxDischargeKw" ->
                    "Bitte geben Sie die Leistung des Speichers als Zahl über 0 kW an, z. B. 5.";
            case "roundtripEfficiencyPct" -> "Der Wirkungsgrad liegt zwischen 1 und 100 %.";
            case "maxPowerKw" -> "Bitte geben Sie die Leistung als Zahl von 0 bis 10.000 kW an, z. B. 11.";
            case "registryUnitId" -> "Die MaStR-Nummer hat höchstens 64 Zeichen, z. B. SEE966831669444.";
            default -> "Bitte prüfen Sie diese Angabe.";
        };
    }
}
