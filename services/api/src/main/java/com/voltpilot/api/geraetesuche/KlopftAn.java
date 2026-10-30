package com.voltpilot.api.geraetesuche;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * OCPP „klopft an“ ({@code docs/contracts/ocpp-klopft-an.md}): das Feld {@code rejected} im Herzschlag-Block
 * {@code chargers} - die Ladesäulen, deren Kennung die Box in den letzten 24 h abgewiesen hat. Der Leser ist tolerant:
 * ein Eintrag, der eine Regel verletzt, wird überlesen; eine unzulässige Adresse allein wird überlesen, die Kennung
 * bleibt (sie ist, was „Zulassen“ braucht). Go-Zwilling {@code edge-app/core/internal/geraetesuche/klopftan.go}.
 */
public final class KlopftAn {

    public static final int MAX_EINTRAEGE = 16;
    public static final int MAX_VERSUCHE = 100_000;

    /** Dieselbe Form, die {@code POST …/charging-config/charge-points} annimmt. */
    private static final Pattern KENNUNG = Pattern.compile("[A-Za-z0-9._-]{1,64}");

    /** @param ip null = fehlt oder überlesen */
    public record Eintrag(String chargePointId, String ip, Instant zuerst, Instant zuletzt, int versuche) {
    }

    private KlopftAn() {
    }

    /**
     * Die abgewiesenen Säulen aus dem Block {@code chargers}; null = unbekannt (Feld fehlt, ältere Box, keine Liste) -
     * nie „niemand klopft an“.
     *
     * @param boxAdressen die eigenen Adressen der Box, soweit die API sie kennt
     */
    public static List<Eintrag> lesen(JsonNode chargers, List<String> boxAdressen) {
        JsonNode liste = chargers == null ? null : chargers.get("rejected");
        if (liste == null || !liste.isArray()) {
            return null;
        }
        List<Eintrag> out = new ArrayList<>();
        Set<String> gesehen = new HashSet<>();
        for (JsonNode e : liste) {
            if (out.size() == MAX_EINTRAEGE) {
                break;
            }
            Eintrag eintrag = eintrag(e, boxAdressen);
            if (eintrag != null && gesehen.add(eintrag.chargePointId())) {
                out.add(eintrag);
            }
        }
        return List.copyOf(out);
    }

    private static Eintrag eintrag(JsonNode e, List<String> boxAdressen) {
        try {
            String id = e.path("id").asText("");
            JsonNode versuche = e.path("attempts");
            if (!e.path("id").isTextual() || !KENNUNG.matcher(id).matches() || !versuche.isIntegralNumber()
                    || !versuche.canConvertToInt() || versuche.asInt() < 1 || versuche.asInt() > MAX_VERSUCHE) {
                return null;
            }
            Instant zuerst = OffsetDateTime.parse(e.path("first_seen").asText()).toInstant();
            Instant zuletzt = OffsetDateTime.parse(e.path("last_seen").asText()).toInstant();
            if (zuletzt.isBefore(zuerst)) {
                return null;
            }
            String ip = e.path("ip").isTextual() ? e.path("ip").asText() : null;
            if (ip != null && (ip.indexOf('/') >= 0 || Suchbereich.suchbereich(ip).grund() != null
                    || boxAdressen.contains(ip))) {
                ip = null;
            }
            return new Eintrag(id, ip, zuerst, zuletzt, versuche.asInt());
        } catch (RuntimeException ex) {
            return null;
        }
    }
}
