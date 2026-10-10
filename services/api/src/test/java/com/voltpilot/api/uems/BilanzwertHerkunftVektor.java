package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.converter.json.Jackson2ObjectMapperBuilder;

/**
 * Für die API-Tests der Herkunft (UEMS AP-10 IP-12): der Herkunfts-Satz eines §7-Falls, wie ihn die Route ausliefern
 * muss — Zeichen für Zeichen. Die Antwort wird mit demselben Jackson-Stand wieder geschrieben, mit dem Spring Boot sie
 * geschrieben hat; Reihenfolge der Schlüssel, Dezimaltext und {@code null} bleiben dabei, wie sie auf der Leitung waren.
 */
final class BilanzwertHerkunftVektor {

    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final ObjectMapper ROUTE = Jackson2ObjectMapperBuilder.json().build();

    private BilanzwertHerkunftVektor() {}

    /** Die Hülle {@code {satz, fehlt: []}} der ersten vollständigen Prüfung {@code herkunft} des Falls. */
    static String umschlag(String datei, String fall) throws Exception {
        JsonNode v = ROUTE.readTree(Files.readString(V2.resolve(datei)));
        for (JsonNode c : v.path("cases")) {
            if (!fall.equals(c.path("id").asText())) {
                continue;
            }
            for (JsonNode p : c.path("pruefungen")) {
                if ("herkunft".equals(p.path("regel").asText()) && !p.path("ergebnis").path("satz").isNull()) {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("satz", p.path("ergebnis").path("satz"));
                    m.put("fehlt", p.path("ergebnis").path("fehlt"));
                    return ROUTE.writeValueAsString(m);
                }
            }
        }
        throw new AssertionError("kein Herkunfts-Satz für " + datei + " · " + fall);
    }

    /** Das Feld {@code herkunft} einer (reihenfolgetreu gelesenen) Antwort, so wie es auf der Leitung stand. */
    static String route(JsonNode herkunft) throws Exception {
        return ROUTE.writeValueAsString(herkunft);
    }
}
