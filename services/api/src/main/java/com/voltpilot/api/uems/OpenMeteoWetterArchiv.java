package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Map;
import java.util.TreeMap;

/**
 * Das Open-Meteo-Archiv ({@code archive-api.open-meteo.com}, Tagesmittel {@code temperature_2m_mean}) — Parameter und
 * Koordinaten wie der Client des Vorhersage-Dienstes ({@code services/forecast/voltpilot_forecast/openmeteo.py}), aber
 * der ARCHIV-Endpunkt. Ohne Schlüssel im freien Zugang; ein Schlüssel ({@code apikey}) kommt als gitops-Wert.
 * Zeitgrenze für Verbindung und Antwort; jeder Fehler ist ein Ausfall, keine Ausnahme.
 */
public class OpenMeteoWetterArchiv implements WetterArchiv {

    public static final String QUELLE = "Open-Meteo-Archiv";

    private final HttpClient client;
    private final ObjectMapper json;
    private final String basisUrl;
    private final String schluessel;
    private final Duration zeitgrenze;
    private final Clock uhr;

    public OpenMeteoWetterArchiv(String basisUrl, String schluessel, Duration zeitgrenze, ObjectMapper json, Clock uhr) {
        this.client = HttpClient.newBuilder().connectTimeout(zeitgrenze).build();
        this.json = json;
        this.basisUrl = basisUrl.endsWith("/") ? basisUrl.substring(0, basisUrl.length() - 1) : basisUrl;
        this.schluessel = schluessel == null || schluessel.isBlank() ? null : schluessel.strip();
        this.zeitgrenze = zeitgrenze;
        this.uhr = uhr;
    }

    @Override
    public Abruf tagesmittel(BigDecimal breitengrad, BigDecimal laengengrad, LocalDate von, LocalDate bis, ZoneId zone) {
        var abgerufen = uhr.instant();
        try {
            String url = basisUrl + "/v1/archive?latitude=" + breitengrad.toPlainString()
                    + "&longitude=" + laengengrad.toPlainString() + "&start_date=" + von + "&end_date=" + bis
                    + "&daily=temperature_2m_mean&timezone=" + URLEncoder.encode(zone.getId(), StandardCharsets.UTF_8)
                    + (schluessel == null ? "" : "&apikey=" + URLEncoder.encode(schluessel, StandardCharsets.UTF_8));
            HttpResponse<String> antwort = client.send(HttpRequest.newBuilder(URI.create(url)).timeout(zeitgrenze)
                    .GET().build(), HttpResponse.BodyHandlers.ofString());
            if (antwort.statusCode() != 200) {
                return new Abruf(QUELLE, abgerufen, Map.of(), "HTTP " + antwort.statusCode());
            }
            return new Abruf(QUELLE, abgerufen, lesen(json.readTree(antwort.body())), null);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new Abruf(QUELLE, abgerufen, Map.of(), "unterbrochen");
        } catch (Exception e) {
            return new Abruf(QUELLE, abgerufen, Map.of(), e.getClass().getSimpleName());
        }
    }

    /** {@code daily.time[i]} ↔ {@code daily.temperature_2m_mean[i]}; {@code null} fehlt (nie 0). */
    static Map<LocalDate, BigDecimal> lesen(JsonNode doc) {
        JsonNode tage = doc.path("daily").path("time");
        JsonNode mittel = doc.path("daily").path("temperature_2m_mean");
        Map<LocalDate, BigDecimal> aus = new TreeMap<>();
        for (int i = 0; i < tage.size() && i < mittel.size(); i++) {
            if (mittel.get(i).isNumber()) {
                aus.put(LocalDate.parse(tage.get(i).asText()), mittel.get(i).decimalValue());
            }
        }
        return aus;
    }
}
