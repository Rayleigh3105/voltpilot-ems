package com.voltpilot.api.consumers;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.entities.EntityTypeCatalog;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Der Parameterblock {@code heizstab} im Registry-Push (Heizstab V1, Paket 3;
 * docs/contracts/v2/heizstab-regler.md): die Steuerart eines Heizstabs über eine Shelly-
 * Ausgangsmenge, ausgeführt vom Regler im Go-Core der Box statt von einem Regel-Flow - auch auf
 * Edge Light, die kein Node-RED hat.
 *
 * <p>Der Block geht an eine Box nur, wenn ALLES stimmt:
 * <ol>
 *   <li>der Stab ist ein {@code heating-rod} mit Ausgangsmenge, sein Profil aktiv, und seine
 *       aktive Steuerart enthält „Solar-Überschuss“ (V1 kennt nur diesen Modus),</li>
 *   <li>der Anschluss ist bestätigt (Stern mit N) - „Weiß ich nicht“ schaltet nichts,</li>
 *   <li>die Box meldet {@code heizstab_regler},</li>
 *   <li><b>die Freigabe (HZ-9 = B):</b> der Typ {@code heating-rod} ist im Katalog nicht mehr
 *       {@code simulator_only} (plattformweiter Flip nach Prüfstand und echtem Stab) - oder die
 *       Box ist eine Prüfstand-Box ({@code voltpilot.heizstab.pruefstand-boxen}, vom Betreiber
 *       gesetzt). Bis zum Flip schaltet also nur die Prüfstand-Box automatisch.</li>
 * </ol>
 *
 * <p>Der Vorrang folgt der „Reihenfolge bei knapper Leistung“ (HZ-6): unter dem Speicher
 * ({@code storage_first}) = {@code speicher_zuerst}, darüber = {@code heizstab_zuerst}.
 * Mindestlauf und -pause kommen aus dem Profil. Wo der Block reist, ist die Komponente
 * {@code owner_claimed}: der Regler der Box IST die Regel, der Plan bleibt draußen.
 */
@Component
public class HeizstabPush {

    private static final Logger log = LoggerFactory.getLogger(HeizstabPush.class);
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Die einzige Steuerart-Quelle, die der Regler in V1 ausführt. */
    static final String QUELLE_UEBERSCHUSS = "ueberschuss";

    private final JdbcTemplate jdbc;
    private final BoxFaehigkeiten faehigkeiten;
    private final EntityTypeCatalog katalog;
    private final Set<UUID> pruefstandBoxen;

    public HeizstabPush(JdbcTemplate jdbc, BoxFaehigkeiten faehigkeiten, EntityTypeCatalog katalog,
            @Value("${voltpilot.heizstab.pruefstand-boxen:}") String pruefstandBoxen) {
        this.jdbc = jdbc;
        this.faehigkeiten = faehigkeiten;
        this.katalog = katalog;
        this.pruefstandBoxen = parseBoxen(pruefstandBoxen);
    }

    static Set<UUID> parseBoxen(String raw) {
        if (raw == null || raw.isBlank()) {
            return Set.of();
        }
        return Arrays.stream(raw.split(",")).map(String::trim).filter(s -> !s.isEmpty()).map(s -> {
            try {
                return UUID.fromString(s);
            } catch (IllegalArgumentException e) {
                log.warn("voltpilot.heizstab.pruefstand-boxen: '{}' ist keine Geräte-ID - übergangen", s);
                return null;
            }
        }).filter(java.util.Objects::nonNull).collect(Collectors.toUnmodifiableSet());
    }

    /** Ob die Automatik eines Heizstabs an dieser Box freigegeben ist (HZ-9 = B). */
    public boolean freigegeben(UUID box) {
        if (box != null && pruefstandBoxen.contains(box)) {
            return true;
        }
        EntityTypeCatalog.EntityType typ = katalog.find(HeizstabGeraet.TYP);
        return typ != null && typ.certificationStatus() != null
                && !"simulator_only".equals(typ.certificationStatus());
    }

    /** Die Blöcke je Heizstab-Entität für den Push an DIESE Box (leer = keiner). */
    public Map<UUID, ObjectNode> fuerBox(UUID siteId, UUID box) {
        if (box == null || !faehigkeiten.kann(box, HeizstabGeraet.FAEHIGKEIT) || !freigegeben(box)) {
            return Map.of();
        }
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT mp.id, mp.connection_json::text AS c, cp.storage_relation, cp.min_on_seconds, "
                        + "cp.min_off_seconds, pol.document::text AS doc "
                        + "FROM measurement_point mp "
                        + "JOIN consumer_profile cp ON cp.entity_id = mp.id AND cp.enabled "
                        + "JOIN consumer_policy pol ON pol.entity_id = mp.id AND pol.lifecycle = 'active' "
                        + "WHERE mp.site_id = ? AND mp.entity_type = ? AND mp.communication = 'shelly_http'",
                siteId, HeizstabGeraet.TYP);
        Map<UUID, ObjectNode> out = new LinkedHashMap<>();
        for (Map<String, Object> r : rows) {
            ObjectNode block = block(lies((String) r.get("c")), (String) r.get("storage_relation"),
                    (Integer) r.get("min_on_seconds"), (Integer) r.get("min_off_seconds"),
                    baum((String) r.get("doc")));
            if (block != null) {
                out.put((UUID) r.get("id"), block);
            }
        }
        return out;
    }

    /**
     * Der Block eines Heizstabs (rein, ohne Datenbank); {@code null}, wenn er keinen bekommt.
     *
     * @param connection die Komponenten-Verbindung (Ausgangsmenge, Anschluss)
     * @param storageRelation {@code storage_first} | {@code consumer_first}
     * @param policy das aktive Steuerart-Dokument ({@code requirements[]})
     */
    public static ObjectNode block(Map<String, Object> connection, String storageRelation, Integer minOnS,
            Integer minOffS, JsonNode policy) {
        if (connection == null || !HeizstabAusgaenge.istMenge(connection)
                || HeizstabAusgaenge.fehler(connection) != null
                || !HeizstabAusgaenge.anschlussBestaetigt(connection) || !ueberschussAktiv(policy)) {
            return null;
        }
        ObjectNode b = JSON.createObjectNode();
        b.put("modus", "ueberschuss");
        b.put("vorrang", "storage_first".equals(storageRelation) ? "speicher_zuerst" : "heizstab_zuerst");
        if (minOnS != null && minOnS > 0) {
            b.put("mindestlauf_s", minOnS);
        }
        if (minOffS != null && minOffS > 0) {
            b.put("mindestpause_s", minOffS);
        }
        return b;
    }

    /**
     * Das Steuerart-Dokument OHNE die Quellen, die der Regler der Box ausführt (V1: der
     * Solar-Überschuss) - was der Regel-Compiler dann noch als Flow bauen darf.
     */
    public static JsonNode ohneBoxRegel(JsonNode policy) {
        if (policy == null || !policy.isObject()) {
            return policy;
        }
        ObjectNode copy = ((ObjectNode) policy).deepCopy();
        JsonNode reqs = copy.get("requirements");
        if (reqs != null && reqs.isArray()) {
            com.fasterxml.jackson.databind.node.ArrayNode keep = JSON.createArrayNode();
            reqs.forEach(r -> {
                if (!QUELLE_UEBERSCHUSS.equals(r.path("id").asText())) {
                    keep.add(r);
                }
            });
            copy.set("requirements", keep);
        }
        return copy;
    }

    /** Ob die aktive Steuerart die Quelle „Solar-Überschuss“ trägt (und sie nicht abgeschaltet ist). */
    static boolean ueberschussAktiv(JsonNode policy) {
        JsonNode reqs = policy == null ? null : policy.get("requirements");
        if (reqs == null || !reqs.isArray()) {
            return false;
        }
        for (JsonNode r : reqs) {
            if (QUELLE_UEBERSCHUSS.equals(r.path("id").asText()) && r.path("active").asBoolean(true)) {
                return true;
            }
        }
        return false;
    }

    private static Map<String, Object> lies(String json) {
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> m = json == null ? null : JSON.readValue(json, Map.class);
            return m;
        } catch (Exception e) {
            return null;
        }
    }

    private static JsonNode baum(String json) {
        try {
            return json == null ? null : JSON.readTree(json);
        } catch (Exception e) {
            return null;
        }
    }
}
