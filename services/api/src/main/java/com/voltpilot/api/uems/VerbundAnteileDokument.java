package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Rolle;
import com.voltpilot.api.uems.SteuerungsverbundZweischritt.Schritt;
import com.voltpilot.api.uems.SteuerungsverbundZweischritt.Tabelle;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.EnumMap;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;

/**
 * Das Anteils-Dokument auf dem Draht (Vertrag {@code docs/contracts/v2/mqtt-verbund-anteile.md}, Y1): gespeichert
 * (retained) auf dem eigenen {@code v2}-Teilbaum JEDER Box des Verbunds, mit Epoche, Revision, Schritt, der GANZEN
 * Tabelle beider Richtungen und {@code verteilbar} — die Box prüft die Summe selbst ({@link
 * SteuerungsverbundAnteile#dokumentPruefen}). Es reist nie im Plan. Rein bis auf Jackson.
 */
public final class VerbundAnteileDokument {

    public static final String SCHEMA_VERSION = "1.0";

    private VerbundAnteileDokument() {}

    /** Downlink je Box. */
    public static String topic(UUID tenant, UUID site, UUID box) {
        return "ems/" + tenant + "/" + site + "/" + box + "/v2/verbund-anteile";
    }

    /** Uplink der Quittung je Box. */
    public static String resultTopic(UUID tenant, UUID site, UUID box) {
        return "ems/" + tenant + "/" + site + "/" + box + "/v2/verbund-anteile-result";
    }

    /** Die Nutzlast für EINE Box; {@code device_id} = die Box des Topics (Topic- und Payload-Identität). */
    public static byte[] nutzlast(ObjectMapper mapper, UUID tenant, UUID site, UUID box, long epoche, long revision,
            Schritt schritt, Tabelle tabelle, Instant veroeffentlicht) {
        return nutzlast(mapper, tenant, site, box, null, epoche, revision, schritt, tabelle, veroeffentlicht);
    }

    /**
     * Wie oben, mit der Rolle der Box des Topics (wahlfrei, IP-17): die Box hält sie mit dem Anteil und spiegelt sie im
     * Herzschlag. {@code null} = ohne das Feld; eine Lese-Box bekommt kein Dokument.
     */
    public static byte[] nutzlast(ObjectMapper mapper, UUID tenant, UUID site, UUID box, Rolle rolle, long epoche,
            long revision, Schritt schritt, Tabelle tabelle, Instant veroeffentlicht) {
        return nutzlast(mapper, tenant, site, box, rolle, epoche, revision, schritt, tabelle, null, veroeffentlicht);
    }

    /**
     * Wie oben, mit der Reserve der anderen steuerbaren Verbraucher dieser Box ({@code reserve_verbraucher.bezug},
     * wahlfrei, AP-15 Folge von IP-19; {@link SteuerungsverbundAbleitung#reserveVerbraucher}). {@code null} = ohne das
     * Feld; eine Box, die es nicht kennt, ignoriert es ({@code schema_version} bleibt 1.0).
     */
    public static byte[] nutzlast(ObjectMapper mapper, UUID tenant, UUID site, UUID box, Rolle rolle, long epoche,
            long revision, Schritt schritt, Tabelle tabelle, BigDecimal reserveBezugKw, Instant veroeffentlicht) {
        return nutzlast(mapper, tenant, site, box, rolle, epoche, revision, schritt, tabelle, reserveBezugKw, null,
                veroeffentlicht);
    }

    /**
     * Wie oben, zusätzlich mit dem erklärten Höchstwert des Ungeregelten hinter dem Abgang dieser Box
     * ({@code ungeregelt_hinter_abgang.bezug}, wahlfrei, AP-15 Folge von IP-19, B3;
     * {@link SteuerungsverbundAbleitung#ungeregeltHinterAbgang}): die mitsteuernde Box zieht ihn blind von ihrem Anteil
     * ab. {@code null} = ohne das Feld (Byte für Byte wie vorher); {@code schema_version} bleibt 1.0.
     */
    public static byte[] nutzlast(ObjectMapper mapper, UUID tenant, UUID site, UUID box, Rolle rolle, long epoche,
            long revision, Schritt schritt, Tabelle tabelle, BigDecimal reserveBezugKw, BigDecimal ungeregeltBezugKw,
            Instant veroeffentlicht) {
        ObjectNode n = mapper.createObjectNode();
        n.put("schema_version", SCHEMA_VERSION);
        n.put("tenant_id", tenant.toString());
        n.put("site_id", site.toString());
        n.put("device_id", box.toString());
        n.put("epoche", epoche);
        n.put("revision", revision);
        n.put("schritt", schritt.code());
        if (rolle == Rolle.FUEHRT || rolle == Rolle.STEUERT_MIT) {
            n.put("rolle", rolle.code());
        }
        ObjectNode v = n.putObject("verteilbar");
        ObjectNode a = n.putObject("anteile");
        for (Grenzart r : SteuerungsverbundAnteile.RICHTUNGEN) {
            v.put(r.code(), tabelle.verteilbar().get(r));
            ObjectNode je = a.putObject(r.code());
            new TreeMap<>(tabelle.anteile().getOrDefault(r, Map.of())).forEach(je::put);
        }
        if (reserveBezugKw != null) {
            n.putObject("reserve_verbraucher").put(Grenzart.BEZUG.code(), reserveBezugKw);
        }
        if (ungeregeltBezugKw != null) {
            n.putObject("ungeregelt_hinter_abgang").put(Grenzart.BEZUG.code(), ungeregeltBezugKw);
        }
        n.put("published_at", veroeffentlicht.toString());
        try {
            return mapper.writeValueAsString(n).getBytes(StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** Was die Box aus Topic und Nutzlast liest: ihre Identität aus dem TOPIC und das Dokument aus der Nutzlast. */
    public record Gelesen(SteuerungsverbundAnteile.Identitaet identitaet, SteuerungsverbundAnteile.Dokument dokument,
            Schritt schritt) {}

    /**
     * Liest ein Dokument so, wie die Box es tut: das Topic nennt die Box; weicht die Nutzlast in Mandant, Anlage oder
     * Box davon ab, ist es nicht ihres ({@code null} — verworfen, ohne Quittung). Die Summenprüfung macht danach
     * {@link SteuerungsverbundAnteile#dokumentPruefen}.
     */
    public static Gelesen lesen(ObjectMapper mapper, String topic, byte[] nutzlast) {
        try {
            String[] p = topic == null ? new String[0] : topic.split("/");
            if (p.length != 6 || !"ems".equals(p[0]) || !"v2".equals(p[4]) || !"verbund-anteile".equals(p[5])) {
                return null;
            }
            JsonNode root = mapper.reader().with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readTree(nutzlast);
            if (root == null || !root.isObject() || !SCHEMA_VERSION.equals(root.path("schema_version").asText())
                    || !p[3].equals(root.path("device_id").asText())
                    || !root.path("epoche").canConvertToLong() || !root.path("revision").canConvertToLong()) {
                return null;
            }
            Map<Grenzart, BigDecimal> verteilbar = new EnumMap<>(Grenzart.class);
            Map<Grenzart, Map<String, BigDecimal>> anteile = new EnumMap<>(Grenzart.class);
            for (Grenzart r : SteuerungsverbundAnteile.RICHTUNGEN) {
                JsonNode v = root.path("verteilbar").path(r.code());
                if (!v.isNumber()) {
                    return null;
                }
                verteilbar.put(r, v.decimalValue());
                JsonNode je = root.path("anteile").path(r.code());
                if (je.isObject()) {
                    Map<String, BigDecimal> m = new TreeMap<>();
                    je.fields().forEachRemaining(e -> m.put(e.getKey(), e.getValue().decimalValue()));
                    anteile.put(r, m);
                }
            }
            return new Gelesen(new SteuerungsverbundAnteile.Identitaet(p[1], p[2], p[3]),
                    new SteuerungsverbundAnteile.Dokument(root.path("tenant_id").asText(), root.path("site_id").asText(),
                            root.path("epoche").asLong(), root.path("revision").asLong(), verteilbar, anteile),
                    Schritt.aus(root.path("schritt").asText()));
        } catch (Exception e) {
            return null;
        }
    }
}
