package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;

/**
 * Der Messpunkt-Katalog der UEMS-Testcontainers-Klassen. Ihre Testkanäle {@code energy_kwh} und
 * {@code energy_kwh_*} haben keinen
 * Katalogeintrag (Kadenz, Wertart und Lücken-Melder sehen sie weiter als unbekannt), stellen aber die
 * kWh-Zähler der Vektor-Datei nach ({@code verbrauch-vectors.json}, {@code einheit: kWh}). Nur die
 * EINHEIT des Trägers ({@link ReihenKontext}) nennt der Katalog hier darum ausdrücklich — sonst spräche
 * die Regel den Zuwachs ohne Zahl, wie für jede Reihe ohne bekannte Einheit.
 */
final class UemsTestKatalog {

    private UemsTestKatalog() {}

    /** Der echte Katalog; nur {@link MeasurementCatalog#einheit} kennt zusätzlich die Testkanäle als kWh. */
    static MeasurementCatalog mitKwhTestkanaelen() {
        return new MeasurementCatalog(new ObjectMapper()) {
            @Override
            public String einheit(String pointKey) {
                return pointKey != null && (pointKey.equals("energy_kwh") || pointKey.startsWith("energy_kwh_"))
                        ? "kWh" : super.einheit(pointKey);
            }
        };
    }
}
