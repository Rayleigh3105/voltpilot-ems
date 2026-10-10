package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Der Bericht der Box über eine Sprungprobe {@code ems/{t}/{s}/{d}/v2/sprungprobe-result} (UEMS AP-15 IP-21; Vertrag
 * {@code docs/contracts/v2/mqtt-sprungprobe.md} §3). {@link #lesen} ist die reine Vertragsprüfung ohne Datenbank:
 * Topic- und Payload-Identität, Vokabular, Zeiten; {@code null} = verworfen.
 *
 * @param spruenge je Sprung von/bis und die eigene Messung der verstellten Größe vorher/während (Betrag; null =
 *                 unbekannt)
 */
public record SprungprobeBericht(UUID tenantId, UUID siteId, UUID box, UUID probeId, SprungprobeRegel.Art art,
        String stellgroesse, List<Sprung> spruenge, boolean abgebrochen, String grund, Instant ts, String roh) {

    public static final String SCHEMA_VERSION = "1.0";
    public static final String AUFTRAG = "sprungprobe";
    public static final String ERGEBNIS = "sprungprobe-result";

    public record Sprung(Instant von, Instant bis, BigDecimal vorherKw, BigDecimal waehrendKw) {}

    private static final Set<String> FELDER = Set.of("schema_version", "tenant_id", "site_id", "device_id", "probe_id",
            "art", "stellgroesse", "spruenge", "abgebrochen", "grund", "ts");
    private static final Set<String> SPRUNG_FELDER = Set.of("von", "bis", "vorher_kw", "waehrend_kw");

    public static SprungprobeBericht lesen(String topic, byte[] payload, ObjectMapper mapper) {
        try {
            String[] p = topic == null ? new String[0] : topic.split("/");
            if (p.length != 6 || !"ems".equals(p[0]) || !"v2".equals(p[4]) || !ERGEBNIS.equals(p[5])) {
                return null;
            }
            UUID tenant = UUID.fromString(p[1]);
            UUID site = UUID.fromString(p[2]);
            UUID box = UUID.fromString(p[3]);
            JsonNode root = mapper.reader().with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readTree(payload);
            if (root == null || !root.isObject() || !SCHEMA_VERSION.equals(root.path("schema_version").asText())
                    || !p[1].equals(root.path("tenant_id").asText()) || !p[2].equals(root.path("site_id").asText())
                    || !p[3].equals(root.path("device_id").asText()) || !root.path("abgebrochen").isBoolean()
                    || !root.path("spruenge").isArray() || root.path("spruenge").size() > 3) {
                return null;
            }
            for (var it = root.fieldNames(); it.hasNext();) {
                if (!FELDER.contains(it.next())) {
                    return null;
                }
            }
            SprungprobeRegel.Art art = SprungprobeRegel.Art.aus(root.path("art").asText());
            if (art == null) {
                return null;
            }
            UUID probe = UUID.fromString(root.path("probe_id").asText());
            boolean abgebrochen = root.path("abgebrochen").asBoolean();
            JsonNode g = root.path("grund");
            String grund = g.isMissingNode() || g.isNull() ? null : g.isTextual() ? g.asText() : "";
            if (abgebrochen ? !SprungprobeRegel.GRUENDE_ABGEBROCHEN.contains(grund) : grund != null) {
                return null;
            }
            JsonNode s = root.path("stellgroesse");
            String stellgroesse = s.isMissingNode() || s.isNull() ? null : s.asText();
            if (stellgroesse != null && (!s.isTextual() || !stellgroesse.matches("[a-z][a-z0-9_]{0,63}"))) {
                return null;
            }
            List<Sprung> spruenge = new ArrayList<>();
            for (JsonNode j : root.path("spruenge")) {
                Sprung sp = sprung(j);
                if (sp == null) {
                    return null;
                }
                spruenge.add(sp);
            }
            return new SprungprobeBericht(tenant, site, box, probe, art, stellgroesse, List.copyOf(spruenge),
                    abgebrochen, grund, Instant.parse(root.path("ts").asText()), root.toString());
        } catch (Exception e) {
            return null;
        }
    }

    private static Sprung sprung(JsonNode j) {
        if (!j.isObject()) {
            return null;
        }
        for (var it = j.fieldNames(); it.hasNext();) {
            if (!SPRUNG_FELDER.contains(it.next())) {
                return null;
            }
        }
        Instant von = Instant.parse(j.path("von").asText());
        Instant bis = Instant.parse(j.path("bis").asText());
        if (!von.isBefore(bis) || Duration.between(von, bis).getSeconds() > SprungprobeRegel.DAUER_S + 5) {
            return null;
        }
        BigDecimal vorher = kw(j.path("vorher_kw"));
        BigDecimal waehrend = kw(j.path("waehrend_kw"));
        if (vorher != null && vorher.signum() < 0 || waehrend != null && waehrend.signum() < 0) {
            return null; // Beträge der Erzeugung bzw. des Verbrauchs
        }
        return new Sprung(von, bis, vorher, waehrend);
    }

    private static BigDecimal kw(JsonNode n) {
        if (n.isMissingNode() || n.isNull()) {
            return null;
        }
        if (!n.isNumber()) {
            throw new IllegalArgumentException("kw ist keine Zahl");
        }
        return n.decimalValue();
    }

    /** Die eigene Änderung der verstellten Größe: während − vorher, oder null. */
    public static BigDecimal eigene(Sprung s) {
        return s.vorherKw() == null || s.waehrendKw() == null ? null : s.waehrendKw().subtract(s.vorherKw());
    }
}
