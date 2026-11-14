package com.voltpilot.api.steuerlogik;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.flows.FlowCompilerHttp;
import java.io.IOException;
import java.net.URI;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Die Brücke zum Logik-Dienst ({@code POST {base}/artefakt}, internal/logikdienst/http.go): 200 trägt Artefakt,
 * Prüfbericht und die gestellten Werte, 422 eine unlesbare Logik (nur {@code message}), eine gesperrte (mit
 * {@code bericht}) oder unpassende Werte ({@code grund: stellwerte}), alles andere ist ein nicht erreichbarer Dienst. Den Hash rechnet nur der Dienst - die API prüft die Form und reicht weiter.
 */
public class SteuerlogikDienstClient implements SteuerlogikDienst {

    private static final Logger log = LoggerFactory.getLogger(SteuerlogikDienstClient.class);

    private final FlowCompilerHttp http;
    private final URI baseUri;
    private final ObjectMapper json;

    public SteuerlogikDienstClient(FlowCompilerHttp http, URI baseUri, ObjectMapper json) {
        this.http = http;
        this.baseUri = baseUri;
        this.json = json;
    }

    @Override
    public Artefakt artefakt(Auftrag auftrag) {
        ObjectNode request = json.createObjectNode();
        request.put("text", auftrag.text());
        request.put("flow_id", auftrag.logikId().toString());
        request.put("flow_version", auftrag.fassung());
        request.put("compiled_at", auftrag.gebautAm().toString());
        if (auftrag.ort() != null) {
            ObjectNode site = request.putObject("site");
            if (auftrag.ort().zeitzone() != null) site.put("timezone", auftrag.ort().zeitzone());
            if (auftrag.ort().breite() != null) site.put("latitude", auftrag.ort().breite());
            if (auftrag.ort().laenge() != null) site.put("longitude", auftrag.ort().laenge());
        }
        if (auftrag.registry() != null) {
            try {
                request.set("registry", json.readTree(auftrag.registry()));
            } catch (IOException e) {
                log.warn("logik_dienst.registry_unlesbar: {}", e.getMessage());
            }
        }
        if (auftrag.scharf()) request.put("armed", true);
        if (auftrag.werte() != null) {
            ObjectNode settings = request.putObject("settings");
            settings.put("revision", auftrag.werte().stand());
            ObjectNode values = settings.putObject("values");
            auftrag.werte().werte().forEach(values::set);
            if (auftrag.werteBehalten()) request.put("settings_keep_fitting", true);
        }
        FlowCompilerHttp.Response response;
        try {
            response = http.post(baseUri.resolve("/artefakt"), json.writeValueAsString(request));
        } catch (IOException e) {
            log.warn("logik_dienst.unreachable: {}", e.toString());
            throw SteuerlogikDienstException.nichtErreichbar();
        }
        JsonNode body = parse(response.body());
        if (response.status() == 200) {
            JsonNode artefakt = body == null ? null : body.get("artifact");
            if (artefakt == null || !"artifact".equals(artefakt.path("kind").asText())
                    || !"steuerlogik".equals(artefakt.path("bundle").path("format").asText())
                    || !artefakt.path("content_hash").asText().matches("^sha256:[0-9a-f]{64}$")
                    || !auftrag.logikId().toString().equals(artefakt.path("flow_id").asText())
                    || artefakt.path("flow_version").asInt() != auftrag.fassung()) {
                log.warn("logik_dienst.unexpected_body");
                throw SteuerlogikDienstException.nichtErreichbar();
            }
            SteuerlogikDienst.Werte werte = null;
            JsonNode settings = body.get("settings");
            if (settings != null && settings.isObject()) {
                Map<String, JsonNode> values = new LinkedHashMap<>();
                settings.path("values").fields().forEachRemaining(e -> values.put(e.getKey(), e.getValue()));
                werte = new SteuerlogikDienst.Werte(settings.path("revision").asLong(), values);
            }
            List<SteuerlogikDienst.Verworfen> verworfen = new ArrayList<>();
            for (JsonNode v : body.path("verworfen")) {
                verworfen.add(new SteuerlogikDienst.Verworfen(v.path("kennung").asText(), v.path("grund").asText()));
            }
            return new Artefakt(artefakt, body.path("bericht"), werte, verworfen);
        }
        if (response.status() == 422 && body != null) {
            String message = body.path("message").asText("Die Logik wurde abgelehnt.");
            if ("stellwerte".equals(body.path("grund").asText())) {
                throw new SteuerlogikDienstException(SteuerlogikDienstException.STELLWERTE, message, null);
            }
            JsonNode bericht = body.get("bericht");
            if (bericht != null && bericht.isObject()) {
                throw new SteuerlogikDienstException(SteuerlogikDienstException.GESPERRT, message, bericht);
            }
            throw new SteuerlogikDienstException(SteuerlogikDienstException.UNLESBAR, message, null);
        }
        log.warn("logik_dienst.unexpected_status: {} {}", response.status(), response.body());
        throw SteuerlogikDienstException.nichtErreichbar();
    }

    private JsonNode parse(String body) {
        if (body == null || body.isBlank()) return null;
        try {
            return json.readTree(body);
        } catch (IOException e) {
            return null;
        }
    }
}
