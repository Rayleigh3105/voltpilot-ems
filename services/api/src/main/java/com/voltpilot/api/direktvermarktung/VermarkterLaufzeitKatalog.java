package com.voltpilot.api.direktvermarktung;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

/**
 * Die GEPACKTE Laufzeit-Sicht der Partnerprofile ({@code edge-app/core/internal/direktvermarkter/
 * profiles.json}, erzeugt von {@code catalog/direktvermarkter/tools/package_edge_runtime.py}; Maven-Ressource
 * {@code direktvermarkter-laufzeit/profiles.json} in diesem Modul). Anders als {@link PartnerKatalog} (die
 * Anzeige-Sicht aus den Autorendateien) liest diese Klasse genau die Form, die auch die Box einbettet - mit
 * AUFGELÖSTEN {@code offen (Fxx)}-Werten -, damit die Zustellung den Partner-Teilbaum byte-gleich ins retained
 * Profil-Dokument übernehmen kann (Vertrag {@code docs/contracts/v2/direktvermarktung-zustellung.md} §2):
 * EINE Quelle der Auflösung, nie zwei driftende.
 */
@Component
public class VermarkterLaufzeitKatalog {

    private static final Logger log = LoggerFactory.getLogger(VermarkterLaufzeitKatalog.class);
    private static final String RESSOURCE = "direktvermarkter-laufzeit/profiles.json";

    private final ObjectMapper json;
    private final Map<String, JsonNode> partner = new ConcurrentHashMap<>();
    private volatile boolean geladen;

    public VermarkterLaufzeitKatalog(ObjectMapper json) {
        this.json = json;
    }

    /** Der Laufzeit-Teilbaum eines Partners (das {@code profil}-Feld des Dokuments), oder {@code null}. */
    public JsonNode profil(String partnerId) {
        lade();
        return partner.get(partnerId);
    }

    private synchronized void lade() {
        if (geladen) return;
        try (InputStream in = new ClassPathResource(RESSOURCE).getInputStream()) {
            JsonNode doc = json.readTree(in);
            if (!"1.0".equals(doc.path("schema_version").asText())) {
                log.error("direktvermarktung: Laufzeit-Katalog mit schema_version {} - keine Zustellung",
                        doc.path("schema_version").asText());
            } else {
                for (JsonNode p : doc.path("partner")) {
                    String id = p.path("id").asText();
                    if (!id.isBlank()) partner.put(id, p);
                }
            }
        } catch (IOException e) {
            // Fail-safe wie der Go-Leser: ohne Katalog wird schlicht nichts zugestellt, nie ein halbes Profil.
            log.error("direktvermarktung: Laufzeit-Katalog nicht lesbar ({}) - keine Zustellung", e.toString());
        }
        geladen = true;
    }
}
