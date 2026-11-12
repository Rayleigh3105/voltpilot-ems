package com.voltpilot.api.geraete;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Die EINE Stelle, die „keine Daten" für das endgültige Löschen einer AUSGEBAUTEN Box festlegt
 * (vp-box-endgueltig-loeschen; Captain 11.11.2026: endgültig löschbar, wenn die Box nie Daten
 * geliefert hat). Jede Tabelle mit einer Spalte {@code device_id} ist hier GENAU EINER von drei
 * Klassen zugeordnet - {@code BoxEndgueltigLoeschenMigrationTest#jedeTabelleMitDeviceIdIstEingeordnet}
 * hält die Zuordnung gegen das tatsächliche Schema vollständig, eine NEUE Tabelle ohne Eintrag macht
 * den Test rot. Im Zweifel gilt eine Box als „hat Daten": zweifelhafte Tabellen stehen in
 * {@link #AUFZEICHNUNGEN}, nie in den anderen beiden Klassen.
 *
 * <ul>
 *   <li>{@link #AUFZEICHNUNGEN}: eine Zeile heißt „die Box hat Daten" - das Löschen wird mit 409 und
 *       der Liste der Datenarten abgelehnt. Dazu zählen auch Verläufe, die eine Kaskade sonst still
 *       mitrisse (Spec Punkt 2: eine Kaskade, die Historie löschen würde, ist ein Grund zur
 *       Ablehnung, nicht zum Löschen).</li>
 *   <li>{@link #KASKADE_UNBEDENKLICH}: reine Cloud-Absicht oder Topologie - entsteht ohne jede
 *       Meldung der Box und wird mit ihr hinfällig (dieselbe Einordnung wie beim „Vom Kunden
 *       lösen", {@code BoxLoesenMigrationTest}).</li>
 *   <li>{@link #BLEIBT_OHNE_FK}: kein Fremdschlüssel auf {@code device} - die Zeilen überleben das
 *       Löschen ABSICHTLICH (Werkstatt und Fernwartung tragen gar keine {@code device_id}; sie
 *       adressieren die Kennung und bleiben dadurch von selbst).</li>
 * </ul>
 *
 * <p>Dazu kommen drei Datenarten außerhalb dieser Tabellen-Sicht: {@code herzschlag} (Spalten an
 * {@code device} selbst), {@code messstellen_belege} und {@code berichtsstaende} (die beiden
 * Belegregeln aus {@code uems_messreihen_belege}/{@code uems_berichts_belege}, geprüft vom Dienst
 * unter RLS). Die DB-Rückversicherung bleibt wie beim Lösen: jede RESTRICT-Tabelle lehnt das
 * DELETE selbst ab (23503), fände die Anwendung hier doch nichts.
 */
public final class BoxDatenBestand {

    private BoxDatenBestand() {
    }

    /** Datenart {@code herzschlag}: die Box hat sich je gemeldet (Zustand oder LAN-Adresse). */
    public static final String HERZSCHLAG = "herzschlag";

    /**
     * Die Aufzeichnungen je Datenart, in der Reihenfolge der 409-Liste. Jede Tabelle trägt
     * {@code device_id}; eine Zeile macht die Box unlöschbar.
     */
    public static final Map<String, List<String>> AUFZEICHNUNGEN = aufzeichnungen();

    private static Map<String, List<String>> aufzeichnungen() {
        Map<String, List<String>> m = new LinkedHashMap<>();
        m.put("messwerte", List.of("telemetry", "telemetry_v2", "device_measurement_sample",
                "device_measurement_event", "device_measurement_point_state",
                "device_measurement_rollup_5m", "device_measurement_rollup_15m",
                "messreihe_ereignis", "messreihe_luecke_stand"));
        // Die Messpunkt-Auswahl ist eine Einstellung, ihre Historie eine Aufzeichnung; beide
        // verweisen mit ON DELETE RESTRICT auf device (V20260913150000) - im Zweifel „hat Daten".
        m.put("messauswahl", List.of("device_measurement_selection", "device_measurement_selection_event"));
        m.put("meldungen", List.of("device_edge_version", "device_update_status", "box_update_verlauf"));
        m.put("befehle", List.of("device_command_log", "register_write_event",
                "ocpp_action", "ocpp_action_intent", "ocpp_action_audit"));
        m.put("ocpp", List.of("ocpp_station", "ocpp_connector_state", "ocpp_protocol_event",
                "ocpp_connector_status_event", "ocpp_authorization_event", "ocpp_transaction",
                "ocpp_meter_sample", "ocpp_station_status_event", "ocpp_configuration_key",
                "ocpp_configuration_unknown_key", "ocpp_station_capability",
                // MiSpeL MP-38: signierte Zählerstände der Ladesäule (OCMF) - ohne Fremdschlüssel auf device,
                // darum prüft erst diese Liste sie.
                "ladepunkt_signierter_messwert"));
        m.put("rueckmeldungen", List.of("device_control_status", "device_curtailment_status",
                "device_curtailment_unit", "device_source_status", "device_data_source_status",
                "consumer_runtime_status", "device_battery_control", "device_charge_connector",
                "device_charge_point", "device_charging_budget", "flow_device_ack", "flow_node_status",
                "data_source_box_receipt", "wechselrichter_untergrenze", "steuerungsverbund_mitglied",
                "steuerungsverbund_geraet", "steuerungsverbund_anteil_verlust",
                "steuerungsverbund_sprungprobe"));
        m.put("freigaben", List.of("device_control_activation"));
        m.put("komponenten", List.of("entity_observed_state", "device_component_apply"));
        // LinkedHashMap, nicht Map.copyOf: die Reihenfolge IST die Reihenfolge der 409-Liste.
        return java.util.Collections.unmodifiableMap(m);
    }

    /** Reine Cloud-Absicht/Topologie: darf mit der Box verschwinden (Grund je Tabelle). */
    public static final Map<String, String> KASKADE_UNBEDENKLICH = Map.ofEntries(
            Map.entry("measurement_point", "Topologie: ON DELETE SET NULL, beim Ausbau schon gelöst"),
            Map.entry("asset", "Topologie: ON DELETE SET NULL, beim Ausbau schon gelöst"),
            Map.entry("entity_registry_state", "Topologie: ON DELETE SET NULL, beim Ausbau schon gelöst"),
            Map.entry("plan_zustellung", "Cloud-Plan AN die Box - wird mit ihr hinfällig"),
            Map.entry("geraetesuche", "Such-Auftrag (Absicht) - wird mit der Box hinfällig"));

    /** Kein Fremdschlüssel auf {@code device}: diese Zeilen überleben das Löschen absichtlich. */
    public static final Map<String, String> BLEIBT_OHNE_FK = Map.ofEntries(
            Map.entry("box_loesen_protokoll", "Audit-Protokoll von L1 - lebt per Definition über die Box hinaus"),
            Map.entry("box_endgueltig_geloescht_protokoll",
                    "Das eigene Audit-Protokoll dieses Wegs - entsteht GENAU beim Löschen"),
            Map.entry("device_enrollment", "Einrichtungs-/Zertifikats-Historie der Referenz - bleibt (Spec Punkt 2)"),
            Map.entry("data_source_assignment", "Zuständigkeits-Zeiträume ohne FK (Bestand, uems-loeschwege.md); "
                    + "aktive verhindert schon der Ausbau"),
            Map.entry("data_source_aenderung", "Zuständigkeits-Protokoll - 'der Eintrag überlebt seine Box' "
                    + "(V20260911180000)"),
            Map.entry("device_site_assignment", "Umzugs-Snapshots, FKs bewusst entfernt (V20260843000000) - "
                    + "ein Löschen darf den damaligen Umzug weder blockieren noch fälschen"),
            Map.entry("geraetesuche_protokoll", "Such-Protokoll ohne Geräte-FK - überlebt den Läufer und die Box"),
            Map.entry("device_update_target", "OTA-Ziel (Absicht) ohne FK; das Abmelden räumt es schon "
                    + "(RolloutService.onDeviceUnclaimed), ein Rest wäre Absicht ohne Wirkung"),
            Map.entry("move_provisioning_operation", "Umzugs-Auftrag (Absicht) ohne FK - ohne die Box "
                    + "wirkungslos"),
            Map.entry("schedule", "Cloud-Plan AN die Box, ohne FK (Hypertable) - Absicht, keine Messung"),
            Map.entry("rollout_device", "OTA-Zuweisung (Absicht) ohne FK - ohne die Box wirkungslos"),
            Map.entry("rollout_event", "OTA-Zuweisungs-Ereignis (Absicht) ohne FK - ohne die Box wirkungslos"));

    /** Jede hier eingeordnete Tabelle, für den Vollständigkeits-Test. */
    public static Set<String> alleEingeordneten() {
        var alle = new java.util.TreeSet<String>();
        AUFZEICHNUNGEN.values().forEach(alle::addAll);
        alle.addAll(KASKADE_UNBEDENKLICH.keySet());
        alle.addAll(BLEIBT_OHNE_FK.keySet());
        return alle;
    }

    /**
     * EIN Statement für den ganzen Bestand: je Datenart ein OR über die EXISTS ihrer Tabellen,
     * {@code herzschlag} aus den Spalten an {@code device} selbst. {@code JOIN site}/{@code JOIN
     * tenant} wie {@code BoxBefundSql}: derselbe Standort-Zaun-Nachweis, und die Akte braucht die
     * Stammdaten daneben.
     */
    public static String abfrage() {
        StringBuilder sql = new StringBuilder("""
                SELECT d.id AS device_id, d.tenant_id, d.site_id, t.name AS tenant_name,
                       s.name AS site_name, d.external_ref, d.created_at AS verbunden_am,
                       d.ausgebaut_am,
                       (d.device_status_seen_at IS NOT NULL OR d.lan_seen_at IS NOT NULL) AS herzschlag""");
        AUFZEICHNUNGEN.forEach((datenart, tabellen) -> {
            sql.append(",\n       (");
            for (int i = 0; i < tabellen.size(); i++) {
                if (i > 0) {
                    sql.append("\n        OR ");
                }
                sql.append("EXISTS (SELECT 1 FROM ").append(tabellen.get(i))
                        .append(" x WHERE x.device_id = d.id)");
            }
            sql.append(") AS ").append(datenart);
        });
        sql.append("""
                \n  FROM device d
                  JOIN site s ON s.id = d.site_id
                  JOIN tenant t ON t.id = s.tenant_id
                """);
        return sql.toString();
    }

    /** Eine Zeile des Bestands: Stammdaten der Box plus die gefundenen Datenarten (Reihenfolge der Liste). */
    public record Zeile(java.util.UUID deviceId, java.util.UUID tenantId, java.util.UUID siteId,
            String tenantName, String siteName, String externalRef, java.time.Instant verbundenAm,
            java.time.Instant ausgebautAm, List<String> datenarten) {
    }

    public static Zeile zeile(ResultSet rs, int rowNum) throws SQLException {
        List<String> datenarten = new ArrayList<>();
        if (rs.getBoolean(HERZSCHLAG)) {
            datenarten.add(HERZSCHLAG);
        }
        for (String datenart : AUFZEICHNUNGEN.keySet()) {
            if (rs.getBoolean(datenart)) {
                datenarten.add(datenart);
            }
        }
        java.sql.Timestamp ausgebaut = rs.getTimestamp("ausgebaut_am");
        return new Zeile(
                rs.getObject("device_id", java.util.UUID.class),
                rs.getObject("tenant_id", java.util.UUID.class),
                rs.getObject("site_id", java.util.UUID.class),
                rs.getString("tenant_name"),
                rs.getString("site_name"),
                rs.getString("external_ref"),
                rs.getTimestamp("verbunden_am").toInstant(),
                ausgebaut == null ? null : ausgebaut.toInstant(),
                List.copyOf(datenarten));
    }
}
