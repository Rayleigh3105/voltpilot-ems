package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;

/**
 * Die Dienste-Zeile der neuen Plattform-Übersicht (Lücke L1,
 * Adminview-Konzept Abschnitt 3.4/4.3 E7): dieselben Werte, die die API
 * längst für Prometheus rechnet ({@code metrics.FleetMetrics}), zusätzlich im
 * Lesemodell der Übersicht. {@code zuletztAm} ist {@code null}, solange der
 * Dienst noch nie etwas gemeldet hat - nie ein erfundenes Alter.
 */
public record AdminPlattformDiensteDto(List<DienstDto> dienste) {

    /** Ein Dienst der Zeile; {@code name} ist stabil und übersetzt sich im Portal. */
    public record DienstDto(String name, Instant zuletztAm) {
    }

    public static AdminPlattformDiensteDto of(Instant optimierer, Instant preise, Instant messwerte,
            Instant tunnelDienst, Instant werkstattDienst) {
        return new AdminPlattformDiensteDto(List.of(
                new DienstDto("optimierer", optimierer),
                new DienstDto("preise", preise),
                new DienstDto("messwerte", messwerte),
                new DienstDto("tunnel-dienst", tunnelDienst),
                new DienstDto("werkstatt-dienst", werkstattDienst)));
    }
}
