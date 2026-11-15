package com.voltpilot.api.steuerlogik;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.flows.WeitereArtefakte;
import com.voltpilot.api.repo.SteuerlogikRepository;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Die aktiven Steuerlogiken einer Anlage im vollständigen Satz auf {@code …/v2/flows} (Bericht Abschnitt 6.8:
 * "die Cloud schickt Logik nur an Boxen, die es melden"): nur an eine führende Box und nur das gespeicherte
 * Artefakt, Byte für Byte wie der Dienst es gebaut hat. Eine mitlaufende Logik braucht {@code steuerlogik_mitlauf},
 * eine scharfe {@code steuerlogik_scharf} - eine Box, die nur mitlaufen kann, bekommt nie ein scharfes Bündel. Eine
 * übersetzte Regel (Stufe 6) braucht dazu {@code steuerlogik_regeln}, eine übersetzte Steuerart oder ein übersetzter
 * Heizstab-Regler {@code steuerlogik_steuerarten}.
 */
@Component
public class SteuerlogikAuslieferung implements WeitereArtefakte {

    /** Das Wort in {@code supports[]} für den Mitlauf (edge-supports.md). */
    public static final String FAEHIGKEIT = "steuerlogik_mitlauf";
    /** Das Wort in {@code supports[]} für das Schalten nach einer Logik (Stufe 3). */
    public static final String FAEHIGKEIT_SCHARF = "steuerlogik_scharf";
    /**
     * Das Wort in {@code supports[]} für übersetzte Regeln (Stufe 6, Zusammenführen): der Kern kennt die Ergänzungen,
     * in die sich eine Regel übersetzt, und ist der Kern der Gleichheitsvektoren.
     */
    public static final String FAEHIGKEIT_REGELN = "steuerlogik_regeln";

    private static final Logger log = LoggerFactory.getLogger(SteuerlogikAuslieferung.class);

    private final SteuerlogikRepository logiken;
    private final BoxFaehigkeiten faehigkeiten;
    private final SteuerwegGeraete geraete;
    private final ObjectMapper json;

    public SteuerlogikAuslieferung(SteuerlogikRepository logiken, BoxFaehigkeiten faehigkeiten,
            SteuerwegGeraete geraete, ObjectMapper json) {
        this.logiken = logiken;
        this.faehigkeiten = faehigkeiten;
        this.geraete = geraete;
        this.json = json;
    }

    @Override
    public List<JsonNode> artefakte(UUID siteId, UUID gateway) {
        List<SteuerlogikRepository.Auslieferung> aktive = logiken.aktiveArtefakte(siteId);
        if (aktive.isEmpty()) return List.of();
        List<JsonNode> out = new ArrayList<>();
        // Eine scharfe Übersetzung einer Steuerart oder eines Heizstabs geht genau dann hinaus, wenn ihr alter Weg
        // draußen bleibt (der Flow aus dem Satz, der Block aus der Registry): nie zwei Wege für ein Gerät.
        Set<UUID> flowsImKern = null;
        Set<UUID> staebeImKern = null;
        for (SteuerlogikRepository.Auslieferung a : aktive) {
            if (a.ausSteuerart() && a.scharf()) {
                if (SteuerlogikRepository.HERKUNFT_STEUERART.equals(a.herkunft())) {
                    if (flowsImKern == null) flowsImKern = geraete.ersetzteFlows(siteId, gateway);
                    if (!flowsImKern.contains(a.herkunftFlowId())) continue;
                } else {
                    if (staebeImKern == null) staebeImKern = geraete.imKern(siteId, gateway);
                    if (!staebeImKern.contains(a.herkunftGeraet())) continue;
                }
            }
            String wort = a.scharf() ? FAEHIGKEIT_SCHARF : FAEHIGKEIT;
            if (!faehigkeiten.kann(gateway, wort)) {
                log.warn("steuerlogik: Logik der Anlage {} nicht ausgeliefert - Box {} meldet {} nicht", siteId,
                        gateway, wort);
                continue;
            }
            if (a.ausRegel() && !faehigkeiten.kann(gateway, FAEHIGKEIT_REGELN)) {
                log.warn("steuerlogik: übersetzte Regel der Anlage {} nicht ausgeliefert - Box {} meldet {} nicht",
                        siteId, gateway, FAEHIGKEIT_REGELN);
                continue;
            }
            if (a.ausSteuerart() && !faehigkeiten.kann(gateway, SteuerwegGeraete.FAEHIGKEIT)) {
                log.warn("steuerlogik: übersetzte Steuerart der Anlage {} nicht ausgeliefert - Box {} meldet {} nicht",
                        siteId, gateway, SteuerwegGeraete.FAEHIGKEIT);
                continue;
            }
            try {
                out.add(json.readTree(a.artefakt()));
            } catch (Exception e) {
                log.warn("steuerlogik: gespeichertes Artefakt der Anlage {} unlesbar, übersprungen: {}", siteId,
                        e.getMessage());
            }
        }
        return out;
    }
}
