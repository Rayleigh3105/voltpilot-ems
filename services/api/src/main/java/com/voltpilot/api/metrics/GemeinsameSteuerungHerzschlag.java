package com.voltpilot.api.metrics;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * AP-15 IP-11: der zuletzt empfangene Herzschlag-Block {@code gemeinsame_steuerung} je Box
 * (Vertrag docs/contracts/v2/mqtt-plan-result.md, „Spiegel im Herzschlag“), gehalten für die
 * Box-Metriken des {@link GemeinsameSteuerungMetrikSammler}.
 *
 * <p><b>Im Prozess, nicht in der Datenbank.</b> Der Block spiegelt nur, er entscheidet nichts; die
 * Überwachung braucht den JETZIGEN Stand. Nach einem Neustart ist er leer, bis der nächste
 * Herzschlag kommt — „unbekannt“ statt eines erfundenen Werts. Eine stumme Box behält ihren letzten
 * Block; ob er aktuell ist, sagt {@code voltpilot_uems_box_herzschlag_age_seconds}.
 *
 * <p><b>Geschlossene Vokabulare.</b> Die Wächter-Stufe wird zum Label-Wert; ein Wort außerhalb des
 * Vertrags wird darum überlesen statt übernommen — eine fehlerhafte Box erzeugt keine neue Reihe.
 * Fehlt der Block im Herzschlag (Plan gelöscht, alte Box), fällt der Eintrag weg.
 *
 * <p>An denselben Schalter gebunden wie die UEMS-Metriken: abgeschaltet gibt es diesen Halter nicht,
 * und der Status-Zuhörer überliest den Block wie vor IP-11.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.metrics.uems.enabled", havingValue = "true",
        matchIfMissing = true)
public class GemeinsameSteuerungHerzschlag {

    /** Die Stufen des Wächters, wie {@code export_guard.state} der Box (Vertrag, Spalte „Bedeutung“). */
    public static final List<String> WAECHTER_STUFEN =
            List.of("aus", "ueberwacht", "regelt", "haelt", "zieht_zusammen", "sicherheitskappe");

    /** Die Richtungen des Blocks {@code waechter}; {@code bezug} sendet die Box erst ab IP-18/IP-19. */
    public static final List<String> RICHTUNGEN = List.of("einspeisung", "bezug");

    /**
     * Der Block einer Box. Eine Richtung fehlt in {@code waechter}, wenn die Box für sie keine Stufe
     * sendet — nie als {@code aus} ergänzt.
     */
    public record Block(UUID planId, Map<String, String> waechter) {}

    private final Map<UUID, Block> bloecke = new ConcurrentHashMap<>();

    /** Übernimmt den Block eines gültigen Herzschlags; {@code null} oder kein Objekt = kein Block. */
    public void merke(UUID deviceId, JsonNode block) {
        if (deviceId == null) {
            return;
        }
        if (block == null || !block.isObject()) {
            bloecke.remove(deviceId);
            return;
        }
        UUID planId = null;
        try {
            planId = block.hasNonNull("plan_id") ? UUID.fromString(block.get("plan_id").asText()) : null;
        } catch (IllegalArgumentException ignored) {
            // Eine unlesbare plan_id macht den Block nicht wertlos: die Wächter-Stufe gilt trotzdem.
        }
        Map<String, String> waechter = new LinkedHashMap<>();
        JsonNode w = block.get("waechter");
        if (w != null && w.isObject()) {
            for (String richtung : RICHTUNGEN) {
                JsonNode stufe = w.get(richtung);
                if (stufe != null && stufe.isTextual() && WAECHTER_STUFEN.contains(stufe.asText())) {
                    waechter.put(richtung, stufe.asText());
                }
            }
        }
        bloecke.put(deviceId, new Block(planId, Map.copyOf(waechter)));
    }

    /** Der Block einer Box; {@code null} = seit dem Start kein Herzschlag mit Block. */
    public Block block(UUID deviceId) {
        return bloecke.get(deviceId);
    }

    /** Alle Boxen, deren jüngster Herzschlag einen Block trug. */
    public Set<UUID> boxen() {
        return Set.copyOf(bloecke.keySet());
    }
}
