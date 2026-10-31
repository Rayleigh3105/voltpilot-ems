package com.voltpilot.api.consumers;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

/**
 * Ein Heizstab als EIN Gerät über die Ausgänge eines Shelly (Heizstab-Konzept V1, Paket 3).
 *
 * <p>Heute wurde jede Verbraucher-Komponente {@code generic-load}, und ein Verbraucher hatte
 * genau einen Schaltweg (je Shelly-Ausgang eine Komponente). Wählt der Kunde beim Anlegen
 * „Heizstab“ ({@code consumerType = heating-rod}) über eine AUSGANGSMENGE
 * ({@code connection.channels}), entsteht hier ein Gerät vom Typ {@code heating-rod}:
 *
 * <ul>
 *   <li>die Menge ist geprüft wie auf der Box ({@link HeizstabAusgaenge}),</li>
 *   <li>mehrere Ausgänge nur bei Stern mit N (240-V-Regel des Shelly Pro 3),</li>
 *   <li>jeder Ausgang gehört genau einem Gerät (kein zweiter Schreiber),</li>
 *   <li>die Box der Anlage kann Ausgangsmenge und Regler ({@code heizstab_regler}) - eine
 *       ältere Box schaltete sonst nur den ersten Ausgang,</li>
 *   <li>das Verbraucherprofil ist ein Stufenprofil ({@code stepped}, {@code levels_kw} = kW je
 *       Stufe), Bestätigung über den Schaltzustand ({@code relay_state}), eingeordnet UNTER dem
 *       Speicher ({@code storage_first}, HZ-6), Ausfallverhalten aus.</li>
 * </ul>
 *
 * <p>Die Verbindung selbst bleibt die Komponenten-Verbindung: der Registry-Push trägt sie
 * unverändert als {@code driver.connection} zur Box ({@code channels}, {@code output_kw},
 * {@code stages}, {@code rotation}; {@code anschluss} überliest die Box).
 */
@Component
public class HeizstabGeraet {

    /** Der Verbrauchertyp, den das Anlegen wählt. */
    public static final String TYP = "heating-rod";

    /** Die Fähigkeit der Box (edge-supports.md). */
    public static final String FAEHIGKEIT = "heizstab_regler";

    /** Mindestlauf und -pause des Profils (Konzept §3, Vorschlag). */
    static final int MINDESTLAUF_S = 300;
    static final int MINDESTPAUSE_S = 300;

    private final JdbcTemplate jdbc;
    private final BoxFaehigkeiten faehigkeiten;
    private final ConsumerRepository consumers;
    private final ObjectMapper mapper = new ObjectMapper();

    public HeizstabGeraet(JdbcTemplate jdbc, BoxFaehigkeiten faehigkeiten, ConsumerRepository consumers) {
        this.jdbc = jdbc;
        this.faehigkeiten = faehigkeiten;
        this.consumers = consumers;
    }

    /** Ob dieses Anlegen einen Heizstab über eine Ausgangsmenge meint. */
    public static boolean gemeint(String consumerType) {
        return TYP.equals(consumerType);
    }

    /**
     * Prüft das Anlegen oder Ändern eines Heizstabs, bevor etwas geschrieben wird.
     *
     * @param selbst die eigene Komponente beim Ändern (ihre Ausgänge zählen nicht als belegt)
     */
    public void pruefe(UUID siteId, UUID selbst, String communication, Map<String, Object> connection) {
        if (!"shelly_http".equals(communication)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Ein Heizstab über mehrere Ausgänge geht heute nur mit einem Shelly.");
        }
        if (!HeizstabAusgaenge.istMenge(connection)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Die Ausgänge des Heizstabs fehlen.");
        }
        String fehler = HeizstabAusgaenge.fehler(connection);
        if (fehler == null) {
            fehler = HeizstabAusgaenge.anschlussFehler(connection);
        }
        if (fehler != null) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, fehler);
        }
        Integer belegt = belegterAusgang(siteId, selbst, connection);
        if (belegt != null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Ausgang " + belegt + " dieses Shelly gehört schon zu einem anderen Gerät. Jeder Ausgang "
                            + "darf nur ein Gerät schalten.");
        }
        if (!boxKann(siteId)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Die VoltPilot-Box dieser Anlage kann einen Heizstab über mehrere Ausgänge noch nicht "
                            + "schalten - erst nach einem Update der Box.");
        }
    }

    /** Ob der Regler der Box diesen Verbraucher führt: ein Heizstab über eine Ausgangsmenge. */
    public boolean regeltDieBox(UUID siteId, UUID entityId) {
        List<String> c = jdbc.queryForList("SELECT connection_json::text FROM measurement_point "
                + "WHERE site_id = ? AND id = ? AND entity_type = ? AND communication = 'shelly_http'",
                String.class, siteId, entityId, TYP);
        return !c.isEmpty() && HeizstabAusgaenge.istMenge(lies(c.get(0)));
    }

    /** Ob ein Heizstab über eine Ausgangsmenge einen NICHT bestätigten Anschluss hat (schaltet nicht). */
    public boolean anschlussOffen(UUID siteId, UUID entityId) {
        List<String> c = jdbc.queryForList("SELECT connection_json::text FROM measurement_point "
                + "WHERE site_id = ? AND id = ? AND entity_type = ? AND communication = 'shelly_http'",
                String.class, siteId, entityId, TYP);
        if (c.isEmpty()) {
            return false;
        }
        Map<String, Object> conn = lies(c.get(0));
        return HeizstabAusgaenge.istMenge(conn) && !HeizstabAusgaenge.anschlussBestaetigt(conn);
    }

    /** Ob eine aktive Box der Anlage Ausgangsmenge und Regler kann. */
    public boolean boxKann(UUID siteId) {
        List<UUID> boxen = jdbc.queryForList(
                "SELECT id FROM device WHERE site_id = ? AND ausgebaut_am IS NULL", UUID.class, siteId);
        return boxen.stream().anyMatch(b -> faehigkeiten.kann(b, FAEHIGKEIT));
    }

    /**
     * Der erste Ausgang dieser Verbindung, den schon ein anderes Gerät derselben Anlage am selben
     * Shelly (IP und Port) schaltet - als einzelner {@code channel} oder in einer Menge.
     */
    Integer belegterAusgang(UUID siteId, UUID selbst, Map<String, Object> connection) {
        String ip = String.valueOf(connection.get("ip")).trim();
        int port = port(connection.get("port"));
        List<Integer> meine = HeizstabAusgaenge.ausgaenge(connection);
        List<Map<String, Object>> andere = jdbc.queryForList(
                "SELECT id, connection_json::text AS c FROM measurement_point WHERE site_id = ? "
                        + "AND communication = 'shelly_http' AND connection_json IS NOT NULL",
                siteId);
        for (Map<String, Object> row : andere) {
            if (Objects.equals(row.get("id"), selbst)) {
                continue;
            }
            Map<String, Object> c = lies((String) row.get("c"));
            if (c == null || !ip.equals(String.valueOf(c.get("ip")).trim()) || port(c.get("port")) != port) {
                continue;
            }
            List<Integer> belegt = HeizstabAusgaenge.ausgaenge(c);
            for (int ch : meine) {
                if (belegt.contains(ch)) {
                    return ch;
                }
            }
        }
        return null;
    }

    /** Die Schutzgrenzen des Geräts: höchstens die oberste Stufe, Ausfallverhalten aus. */
    public String guards(Map<String, Object> connection) {
        ObjectNode g = mapper.createObjectNode();
        List<HeizstabAusgaenge.Stufe> stufen = HeizstabAusgaenge.stufen(connection);
        ObjectNode limits = g.putObject("limits");
        if (!stufen.isEmpty()) {
            limits.put("max_consumption_kw", stufen.get(stufen.size() - 1).kw().doubleValue());
        }
        g.putObject("failsafe").put("behavior", "off");
        return g.toString();
    }

    /**
     * Legt das Stufenprofil an (oder führt die Stufen eines bestehenden nach): {@code stepped},
     * {@code levels_kw} = kW je erlaubter Stufe, Nennleistung = oberste Stufe.
     */
    public void profil(UUID tenantId, UUID siteId, UUID entityId, Map<String, Object> connection) {
        List<HeizstabAusgaenge.Stufe> stufen = HeizstabAusgaenge.stufen(connection);
        if (stufen.isEmpty()) {
            return;
        }
        ArrayNode levels = levelsKw(stufen);
        BigDecimal rated = stufen.get(stufen.size() - 1).kw();
        int vorhanden = jdbc.queryForObject("SELECT count(*) FROM consumer_profile WHERE entity_id = ?",
                Integer.class, entityId);
        if (vorhanden > 0) {
            jdbc.update("UPDATE consumer_profile SET control_kind = 'stepped', rated_power_kw = ?, "
                    + "levels_kw = ?::jsonb WHERE entity_id = ?", rated, levels.toString(), entityId);
            return;
        }
        consumers.insertProfile(entityId, tenantId, siteId, "stepped", rated, null, levels.toString(), null,
                null, "storage_first", "allow", false, "off", MINDESTLAUF_S, MINDESTPAUSE_S, null,
                "relay_state");
    }

    /**
     * Die Stufen als {@code levels_kw} des Profils: aufsteigend und MIT der 0 (aus) vorn - die
     * Form, die der Profil-Validator und der Optimierer erwarten ({@code levels_need_zero}).
     */
    static ArrayNode levelsKw(List<HeizstabAusgaenge.Stufe> stufen) {
        ArrayNode levels = new ObjectMapper().createArrayNode();
        levels.add(BigDecimal.ZERO);
        stufen.forEach(s -> levels.add(s.kw()));
        return levels;
    }

    private Map<String, Object> lies(String json) {
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> m = mapper.readValue(json, Map.class);
            return m;
        } catch (Exception e) {
            return null;
        }
    }

    private static int port(Object raw) {
        return raw instanceof Number n && n.intValue() > 0 ? n.intValue() : 80;
    }
}
