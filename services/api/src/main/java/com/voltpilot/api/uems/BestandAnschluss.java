package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/**
 * Der heutige Anschluss einer Bestands-Komponente in den Wörtern einer Datenquelle (UEMS AP-06
 * IP-4, Vertrag {@code docs/contracts/v2/data-source-assignment.md} §8 „Vom Transport zum
 * Protokoll“). Rein, ohne Spring — der Rohstoff von {@link DatenquelleRegeln#vorschlagsliste}.
 *
 * <p>Wie eine Box eine Komponente liest, steht bis IP-4 an der Komponente selbst:
 * {@code measurement_point.communication} (der Transport des Treibers) und
 * {@code connection_json} (seine Felder — {@code EntityRegistryService.driverBlock} reicht sie
 * UNVERÄNDERT an die Box). Übersetzt wird nur, was eindeutig ist; nie geraten:
 *
 * <ul>
 *   <li>Modbus TCP ({@code modbus_tcp}, {@code kostal_modbus}, {@code kaco_modbus}, der Selbstbau
 *       {@code modbus_baukasten}) und SunSpec-Modbus ({@code sunspec_tcp}, {@code fronius_sunspec}):
 *       {@code ip:port}, die Geräte-ID ist {@code unit_id}.</li>
 *   <li>Solarman-Datenlogger ({@code solarman_v5}, Deye): {@code ip:port/serial} — die Seriennummer
 *       des Datenloggers gehört zum Weg (ohne sie liest der Treiber nicht), die Geräte-ID ist die
 *       Slave-ID {@code mb_slave_id}.</li>
 *   <li>HTTP-Auskunft ({@code kaco_http}, {@code fronius_solar_api}, {@code goe_http_api},
 *       {@code shelly_http}, der Batterie-Anschluss {@code http_local}): {@code schema://host:port}
 *       — {@code https}, wo der Treiber es nimmt ({@code scheme: https} oder
 *       {@code insecure_tls}, bei {@code http_local} {@code endpoint.tls}), sonst {@code http}.</li>
 *   <li>MQTT-Themen ({@code mqtt_local}): das EINE Thema aller Zuordnungen; liest die Komponente
 *       mehrere Themen, gibt es keinen gemeinsamen Filter — keine Adresse.</li>
 *   <li>OCPP-Station ({@link #ocpp}): die Stations-Kennung.</li>
 *   <li>Die Tabelle ist VOLLSTÄNDIG: jedes Transport-Wort, das eine Bestandsanlage tragen kann
 *       (Vorlagen des Katalogs und des Admin-Werkzeugs, Selbstbau, Batterie-Anschluss, die
 *       Treiber der Box), steht darin ({@code BestandAnschlussTest}). Ein Wort, das es trotzdem
 *       nicht kennt, geht als SEIN Wort weiter und wird von der Regel verworfen
 *       ({@code protokoll_unbekannt}) — die Rückwand, nie eine Abbildung auf ein anderes Wort.</li>
 * </ul>
 *
 * Ein fehlender Port oder eine fehlende Geräte-ID ist die Vorgabe des Treibers — dieselbe, die die
 * Box einsetzt (eine 0 liest ihr Treiber wie „fehlt“) und die die Vorlage im Katalog vorbelegt
 * ({@code BestandAnschlussTest} hält die Ports am Katalog).
 *
 * Ohne Transport oder ohne lesbare Felder ist die Adresse {@code null} — die Regel sagt dann
 * {@code keine_adresse}. Der Lesetakt ist {@code interval_s} der Verbindung (dort legt der
 * Anlege-Weg ihn seit Stufe 1 ab, der Push hebt ihn auf die Treiber-Ebene), sonst {@code null} —
 * nicht erhoben. Die Spalte {@code measurement_point.interval_s} ist KEIN Beleg: sie trägt die
 * Vorgabe 5 jeder Zeile, und der Push reicht sie nicht an die Box.
 */
public final class BestandAnschluss {

    private BestandAnschluss() {}

    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * Der Anschluss in den Wörtern einer Quelle.
     *
     * @param protokoll ein Wort des Vokabulars, das Transport-Wort ohne Übersetzung, oder
     *                  {@code null} (kein Transport)
     * @param adresse   normalisiert wie eine Quelle sie speichert ({@link DatenquelleAdresse}),
     *                  oder {@code null}
     */
    public record Anschluss(String protokoll, String adresse, Integer geraeteId, Integer kadenzS) {}

    /**
     * Wie ein Transport gelesen wird: Protokoll, Vorgaben des Treibers für Port und Geräte-ID, Art
     * der Adresse.
     */
    record Transport(String protokoll, Integer standardPort, Integer standardGeraeteId, Weg weg) {}

    enum Weg { MODBUS, MODBUS_BAUKASTEN, SOLARMAN, HTTP, HTTP_LOCAL, MQTT_LOCAL }

    /** Die geschlossene, vollständige Tabelle — ein neuer Transport kommt hierher UND in den Vertrag. */
    static final Map<String, Transport> TRANSPORTE = Map.ofEntries(
            Map.entry("modbus_tcp", new Transport("modbus_tcp", 502, 1, Weg.MODBUS)),
            Map.entry("kostal_modbus", new Transport("modbus_tcp", 1502, 71, Weg.MODBUS)),
            Map.entry("kaco_modbus", new Transport("modbus_tcp", 502, 1, Weg.MODBUS)),
            Map.entry("modbus_baukasten", new Transport("modbus_tcp", 502, 1, Weg.MODBUS_BAUKASTEN)),
            Map.entry("sunspec_tcp", new Transport("sunspec_modbus", 502, 1, Weg.MODBUS)),
            Map.entry("fronius_sunspec", new Transport("sunspec_modbus", 502, 1, Weg.MODBUS)),
            Map.entry("solarman_v5", new Transport("solarman_v5", 8899, 1, Weg.SOLARMAN)),
            Map.entry("kaco_http", new Transport("http", 8484, null, Weg.HTTP)),
            Map.entry("fronius_solar_api", new Transport("http", 80, null, Weg.HTTP)),
            Map.entry("goe_http_api", new Transport("http", 80, null, Weg.HTTP)),
            Map.entry("shelly_http", new Transport("http", 80, null, Weg.HTTP)),
            Map.entry("ebyte_modbus_tcp", new Transport("modbus_tcp", 502, 1, Weg.MODBUS)),
            Map.entry("http_local", new Transport("http", null, null, Weg.HTTP_LOCAL)),
            Map.entry("mqtt_local", new Transport("mqtt", null, null, Weg.MQTT_LOCAL)));

    /**
     * @param communication  {@code measurement_point.communication}
     * @param connectionJson {@code measurement_point.connection_json} als Text (oder {@code null})
     */
    public static Anschluss aus(String communication, String connectionJson) {
        JsonNode c = lies(connectionJson);
        Integer kadenz = kadenz(c);
        String wort = text(communication);
        if (wort == null) {
            return new Anschluss(null, null, null, kadenz);
        }
        Transport t = TRANSPORTE.get(wort);
        if (t == null) {
            // Kein Wort im Vokabular: weiter als SEIN Wort — die Regel verwirft es.
            return new Anschluss(wort, null, null, kadenz);
        }
        return switch (t.weg()) {
            case MODBUS -> modbus(t, text(c.get("ip")), c.get("port"),
                    geraeteId(c.get("unit_id"), t.standardGeraeteId(), true), kadenz);
            case MODBUS_BAUKASTEN -> {
                // Der Selbstbau nimmt eine 0 als Geräte-ID ernst (SelfBuildDefinition), nur „fehlt“ ist 1.
                JsonNode tr = c.path("transport");
                yield modbus(t, text(tr.get("host")), tr.get("port"),
                        geraeteId(tr.get("unit_id"), t.standardGeraeteId(), false), kadenz);
            }
            case SOLARMAN -> {
                String host = text(c.get("ip"));
                String seriennummer = text(c.get("serial"));
                String adresse = host == null || seriennummer == null ? null
                        : normalisiert(t.protokoll(), host + ":" + port(c.get("port"), t.standardPort()) + "/"
                                + seriennummer);
                yield new Anschluss(t.protokoll(), adresse,
                        geraeteId(c.get("mb_slave_id"), t.standardGeraeteId(), true), kadenz);
            }
            case HTTP -> {
                boolean tls = "https".equals(text(c.get("scheme"))) || c.path("insecure_tls").asBoolean(false);
                yield http(t, tls, text(c.get("ip")), port(c.get("port"), t.standardPort()), "", kadenz);
            }
            case HTTP_LOCAL -> {
                JsonNode e = c.path("endpoint");
                boolean tls = e.path("tls").asBoolean(false);
                String pfad = text(e.get("path"));
                yield http(t, tls, text(e.get("host")), port(e.get("port"), tls ? 443 : 80),
                        pfad == null ? "" : (pfad.startsWith("/") ? pfad : "/" + pfad), kadenz);
            }
            case MQTT_LOCAL -> {
                Set<String> themen = new LinkedHashSet<>();
                c.path("mappings").forEach(m -> {
                    String thema = text(m.get("topic"));
                    if (thema != null) {
                        themen.add(thema);
                    }
                });
                yield new Anschluss(t.protokoll(), themen.size() == 1 ? themen.iterator().next() : null, null,
                        kadenz);
            }
        };
    }

    /** Eine OCPP-Station: ihre Kennung ist die Adresse (Vertrag §2). */
    public static Anschluss ocpp(String chargePointId) {
        String id = text(chargePointId);
        return new Anschluss("ocpp", id == null ? null : normalisiert("ocpp", id), null, null);
    }

    private static Anschluss modbus(Transport t, String host, JsonNode port, Integer geraeteId, Integer kadenz) {
        String adresse = host == null ? null : normalisiert(t.protokoll(), host + ":" + port(port, t.standardPort()));
        return new Anschluss(t.protokoll(), adresse, geraeteId, kadenz);
    }

    private static Anschluss http(Transport t, boolean tls, String host, Integer port, String pfad, Integer kadenz) {
        String adresse = host == null ? null
                : normalisiert(t.protokoll(), (tls ? "https" : "http") + "://" + host + ":" + port + pfad);
        return new Anschluss(t.protokoll(), adresse, null, kadenz);
    }

    /** Die gespeicherte Form — eine Adresse ohne Form ist keine (nie eine halbe). */
    private static String normalisiert(String protokoll, String roh) {
        try {
            return DatenquelleAdresse.normalisiere(protokoll, roh);
        } catch (DatenquelleAdresse.Ungueltig e) {
            return null;
        }
    }

    private static Integer port(JsonNode n, Integer standard) {
        if (n != null && n.canConvertToInt() && n.asInt() > 0) {
            return n.asInt();
        }
        if (n != null && n.isTextual() && n.asText().strip().matches("[0-9]{1,5}")) {
            return Integer.parseInt(n.asText().strip());
        }
        return standard;
    }

    /**
     * Die Geräte-ID (Unit- bzw. Slave-ID): fehlt sie, die Vorgabe des Treibers; eine 0 liest ein
     * Treiber der Box wie „fehlt“ ({@code nullIstVorgabe}); keine Zahl zwischen 0 und 255: keine.
     */
    private static Integer geraeteId(JsonNode n, Integer vorgabe, boolean nullIstVorgabe) {
        if (n == null || n.isNull() || (n.isTextual() && n.asText().isBlank())) {
            return vorgabe;
        }
        Integer id = null;
        if (n.isIntegralNumber() && n.canConvertToInt()) {
            id = n.asInt();
        } else if (n.isTextual() && n.asText().strip().matches("[0-9]{1,3}")) {
            id = Integer.parseInt(n.asText().strip());
        }
        if (id == null || id < 0 || id > 255) {
            return null;
        }
        return id == 0 && nullIstVorgabe ? vorgabe : id;
    }

    private static Integer kadenz(JsonNode c) {
        JsonNode i = c.get("interval_s");
        return i != null && i.isNumber() && i.asInt() >= 1 && i.asInt() <= 86_400 ? i.asInt() : null;
    }

    private static JsonNode lies(String text) {
        if (text == null || text.isBlank()) {
            return JSON.createObjectNode();
        }
        try {
            JsonNode n = JSON.readTree(text);
            return n != null && n.isObject() ? n : JSON.createObjectNode();
        } catch (JsonProcessingException e) {
            return JSON.createObjectNode();
        }
    }

    private static String text(JsonNode n) {
        return n == null || n.isNull() || !n.isValueNode() ? null : text(n.asText());
    }

    private static String text(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }
}
