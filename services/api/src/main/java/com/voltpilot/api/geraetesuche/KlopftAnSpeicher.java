package com.voltpilot.api.geraetesuche;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

/**
 * Die abgewiesenen Ladesäulen je Box, wie der letzte Herzschlag sie meldete ({@code docs/contracts/ocpp-klopft-an.md}):
 * gefüttert von {@code ChargerStatusListener}, gelesen von der Antwort der Gerätesuche ({@code ladesaeulenKlopfenAn}).
 *
 * <p>Ein Spiegel im Speicher, keine Tabelle: das Feld ist Zustand, den die Box selbst 24 h hält und alle 15 s neu
 * sendet; jede Instanz der api hört jeden Herzschlag (N-facher Konsum je Replica), also sieht jede dasselbe. Nach
 * einem Neustart der api ist der Stand bis zum nächsten Herzschlag unbekannt ({@code null}), nie „niemand klopft an“.
 * Ein Herzschlag ohne Block oder ohne {@code rejected} heißt ebenfalls unbekannt (ältere Box).
 */
@Component
public class KlopftAnSpeicher {

    /** Ohne Herzschlag so lange ist der Stand unbekannt — dieselbe Grenze wie {@code box_offline}. */
    static final Duration FRISCH = Duration.ofMinutes(5);
    /** Was die Box zuletzt vor 24 h abwies, hat sie vergessen. */
    static final Duration FENSTER = Duration.ofHours(24);

    private record Stand(UUID tenantId, JsonNode chargers, Instant gemeldetAm) {
    }

    private final Map<UUID, Stand> je = new ConcurrentHashMap<>();

    /** Der Block {@code chargers} eines angenommenen Herzschlags (Identität schon geprüft). */
    public void merken(UUID tenantId, UUID deviceId, JsonNode chargers, Instant am) {
        if (chargers == null || !chargers.isObject() || !chargers.has("rejected")) {
            je.remove(deviceId);
            return;
        }
        je.put(deviceId, new Stand(tenantId, chargers.deepCopy(), am));
    }

    /** Ein Herzschlag ohne Block: der Stand ist unbekannt. */
    public void vergessen(UUID deviceId) {
        je.remove(deviceId);
    }

    /**
     * Die abgewiesenen Säulen dieser Box; null = unbekannt (nichts gemeldet, ältere Box, zu alt, fremder Mandant).
     *
     * @param boxAdressen die eigenen Adressen der Box, soweit die api sie kennt
     */
    public List<KlopftAn.Eintrag> lesen(UUID tenantId, UUID deviceId, List<String> boxAdressen, Instant jetzt) {
        Stand s = je.get(deviceId);
        if (s == null || !s.tenantId().equals(tenantId) || s.gemeldetAm().isBefore(jetzt.minus(FRISCH))) {
            return null;
        }
        List<KlopftAn.Eintrag> eintraege = KlopftAn.lesen(s.chargers(), boxAdressen);
        return eintraege == null ? null : eintraege.stream()
                .filter(e -> !e.zuletzt().isBefore(jetzt.minus(FENSTER))).toList();
    }
}
