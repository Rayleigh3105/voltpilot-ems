package com.voltpilot.api.steuerlogik;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.flows.WeitereArtefakte;
import com.voltpilot.api.repo.SteuerlogikRepository;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Die mitlaufenden Steuerlogiken einer Anlage im vollständigen Satz auf {@code …/v2/flows} (Bericht Abschnitt 6.8:
 * "die Cloud schickt Logik nur an Boxen, die es melden"): nur an eine führende Box, die {@code steuerlogik_mitlauf}
 * kann, und nur das gespeicherte Artefakt, Byte für Byte wie der Dienst es gebaut hat.
 */
@Component
public class SteuerlogikAuslieferung implements WeitereArtefakte {

    /** Das Wort in {@code supports[]} (edge-supports.md). */
    public static final String FAEHIGKEIT = "steuerlogik_mitlauf";

    private static final Logger log = LoggerFactory.getLogger(SteuerlogikAuslieferung.class);

    private final SteuerlogikRepository logiken;
    private final BoxFaehigkeiten faehigkeiten;
    private final ObjectMapper json;

    public SteuerlogikAuslieferung(SteuerlogikRepository logiken, BoxFaehigkeiten faehigkeiten, ObjectMapper json) {
        this.logiken = logiken;
        this.faehigkeiten = faehigkeiten;
        this.json = json;
    }

    @Override
    public List<JsonNode> artefakte(UUID siteId, UUID gateway) {
        List<String> texte = logiken.mitlaufendeArtefakte(siteId);
        if (texte.isEmpty()) return List.of();
        if (!faehigkeiten.kann(gateway, FAEHIGKEIT)) {
            log.warn("steuerlogik: {} Logik(en) der Anlage {} nicht ausgeliefert - Box {} meldet {} nicht",
                    texte.size(), siteId, gateway, FAEHIGKEIT);
            return List.of();
        }
        List<JsonNode> out = new ArrayList<>();
        for (String text : texte) {
            try {
                out.add(json.readTree(text));
            } catch (Exception e) {
                log.warn("steuerlogik: gespeichertes Artefakt der Anlage {} unlesbar, übersprungen: {}", siteId,
                        e.getMessage());
            }
        }
        return out;
    }
}
