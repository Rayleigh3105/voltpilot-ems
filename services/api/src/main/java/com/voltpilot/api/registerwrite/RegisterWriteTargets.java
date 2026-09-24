package com.voltpilot.api.registerwrite;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityObservedRepository;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.web.dto.DeviceDto;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * Der GERÄTE-PICKER des Register-Drawers (Konzept
 * {@code vp-reg-schreib-konzept-p8} §2.3, Stufe 2): welche Geräte dieser Anlage
 * überhaupt als Ziel eines Register-Schreibvorgangs in Frage kommen, und was
 * die Plattform über sie weiß.
 *
 * <p><b>Es entsteht KEINE neue Wahrheit.</b> Alles kommt aus zwei Quellen, die
 * es längst gibt: dem, was die BOX über ihre eigene Einrichtung meldet
 * ({@code entity_observed_state}, {@code local_setup} - Einheitsmodell Stufe 2)
 * und den portal-verwalteten Komponenten
 * ({@code measurement_point.connection_json}). Es wird nichts geraten und
 * nichts nachgerechnet.
 *
 * <p><b>⚠ DIE ENTSCHEIDUNG BLEIBT AUF DEM GERÄT.</b> {@code writable} ist eine
 * ANZEIGE-Hilfe, kein Tor: sie spiegelt die Regeln, die die Box ohnehin selbst
 * prüft (Transport, IP vorhanden, Solarman gehört auf die primäre Lane), damit
 * ein Mensch den Grund VOR dem Klick liest statt als Ablehnung danach. Wer hier
 * eine zusätzliche Regel einführt, hat eine zweite Politik gebaut, die von der
 * des Geräts abweichen kann - genau das, was dieser Pfad überall vermeidet.
 *
 * <p><b>Ein Gerät, das NICHT beschrieben werden kann, wird trotzdem GENANNT.</b>
 * Es einfach wegzulassen erzeugte die Frage „warum steht meine Wallbox nicht in
 * der Liste?" und beantwortete sie nirgends; genannt mit Grund ist es die
 * gleiche Information ohne das Rätsel.
 */
@Service
public class RegisterWriteTargets {

    /** Die Lane-Wörter des Kontrakts. */
    public static final String LANE_PRIMARY = RegisterWritePublisher.Order.LANE_PRIMARY;
    public static final String LANE_ENTITY = RegisterWritePublisher.Order.LANE_ENTITY;
    public static final String LANE_LAN = RegisterWritePublisher.Order.LANE_LAN;

    /**
     * Transporte, über die NIE ein Modbus-Register geschrieben wird - sie
     * sprechen HTTP. Der Grund wird genannt, nicht das Gerät verschwiegen.
     */
    private static final Set<String> HTTP_TRANSPORTS = Set.of(
            "fronius_solar_api", "goe_http_api", "shelly_http");

    /**
     * Transporte, deren Geräte-Socket der Box-KERN allein besitzt und deren
     * Ausgänge nur über die Verbrauchersteuerung geschaltet werden (Ebyte-
     * I/O-Modul): ein freier Registerzugriff schaltete ein Relais an Arbiter,
     * Schutzgrenzen und Geräte-Watchdog vorbei - über einen zweiten Socket.
     */
    private static final Set<String> CORE_OWNED_TRANSPORTS = Set.of("ebyte_modbus_tcp");

    static final String NUR_VERBRAUCHERSTEUERUNG =
            "Die Ausgänge dieses I/O-Moduls schaltet VoltPilot nur über die "
            + "Verbrauchersteuerung, nicht über einen freien Registerzugriff.";

    /** Der Transport, der auf die PRIMÄRE Lane gehört (ein Socket, ein Besitzer). */
    private static final String SOLARMAN = "solarman_v5";

    /** Der Rollen-Name, unter dem eine Box ihren Wechselrichter meldet. */
    private static final String ROLE_INVERTER = "inverter";

    /**
     * Die ECHTE Ablehnung in Kundenworten - ein Gerät, das kein Modbus spricht,
     * hat keine Register, und das bleibt wahr, egal wie die Fläche heißt.
     *
     * <p>Sie steht bewusst EINMAL: derselbe Fall trat an drei Stellen auf
     * (primärer Wechselrichter, Komponente, gemeldete Quelle) und wurde dreimal
     * verschieden formuliert.
     */
    static final String HTTP_KEIN_MODBUS =
            "Dieses Gerät wird über seine Web-Schnittstelle gelesen - Modbus-Register gibt es "
            + "dort nicht.";

    /**
     * Ein Ziel des Pickers.
     *
     * @param writable ob die Plattform einen Schreibweg SIEHT. {@code false}
     *                 trägt immer einen {@code reason}; {@code true} ist keine
     *                 Zusage - die Box entscheidet.
     * @param family   die Register-Familie, aus der das Register-Wissen spricht.
     *                 {@code null} = die Box hat sie (noch) nicht gemeldet, und
     *                 dann bleibt JEDES Register „unbekannt" statt mit einer
     *                 fremden Bedeutung beschriftet zu werden.
     * @param primaryAlias ⚠ das Ziel NENNT eine Komponente, wird aber über die
     *                 PRIMÄRE Lane erreicht (Geräteseiten Stufe 2, Captain-
     *                 Entscheid E4). Die {@code entityId} bleibt gesetzt, damit
     *                 der Vorgang der KOMPONENTE gehört (Journal, Geräte-
     *                 Verlauf); auf dem Draht reist er als primärer Auftrag -
     *                 der Umschlag der primären Lane trägt gar kein
     *                 {@code entity_id}, es ändert sich also NICHTS an dem, was
     *                 die Box bekommt oder prüft.
     */
    public record Target(String lane, UUID deviceId, UUID entityId, String label, String brand,
            String model, String family, String communication, String host, Integer port,
            Integer unitId, boolean writable, String reason, boolean primaryAlias) {

        /** Ein gewöhnliches Ziel - kein Alias (der Normalfall). */
        public Target(String lane, UUID deviceId, UUID entityId, String label, String brand,
                String model, String family, String communication, String host, Integer port,
                Integer unitId, boolean writable, String reason) {
            this(lane, deviceId, entityId, label, brand, model, family, communication, host, port,
                    unitId, writable, reason, false);
        }
    }

    private final DeviceRepository devices;
    private final EntityObservedRepository observed;
    private final EntityRegistryRepository registry;
    private final ObjectMapper mapper;

    public RegisterWriteTargets(DeviceRepository devices, EntityObservedRepository observed,
            EntityRegistryRepository registry, ObjectMapper mapper) {
        this.devices = devices;
        this.observed = observed;
        this.registry = registry;
        this.mapper = mapper;
    }

    /**
     * Die Ziele dieser Anlage: je Gerät der primäre Wechselrichter, dazu jede
     * portal-verwaltete Komponente mit hinterlegter Anbindung.
     */
    public List<Target> forSite(UUID siteId) {
        List<Target> out = new ArrayList<>();
        List<DeviceDto> ofSite = devices.findAll().stream()
                .filter(d -> siteId.equals(d.siteId()))
                .toList();
        List<EntityObservedRepository.ObservedRow> rows = observed.forSite(siteId);
        for (DeviceDto d : ofSite) {
            out.add(primaryTarget(d, rows));
        }
        for (EntityRegistryRepository.EntityRow e : registry.entitiesForSite(siteId)) {
            componentTarget(e).ifPresent(out::add);
        }
        // ⚠ Die von der BOX gemeldeten Quellen sind Geräte im Kunden-LAN, die
        // (noch) KEINE Entität sind - sie haben also keine Kennung, über die
        // die Box sie auflösen könnte. Ihr Weg ist deshalb die FREIE Lane, mit
        // dem gemeldeten Endpunkt vorbefüllt: die Adresse steht ohnehin schon
        // im Portal, sie hier zu verschweigen hieße nur, dass sie jemand
        // abtippt.
        Set<String> alreadyOffered = out.stream()
                .map(RegisterWriteTargets::endpointKey)
                .filter(k -> k != null)
                .collect(java.util.stream.Collectors.toSet());
        for (EntityObservedRepository.ObservedRow r : rows) {
            if (isInverter(r)) {
                continue; // steht schon als primäres Ziel
            }
            sourceTarget(r).filter(t -> !alreadyOffered.contains(endpointKey(t)))
                    .ifPresent(out::add);
        }
        return List.copyOf(out);
    }

    /**
     * Der Endpunkt als Schlüssel - damit ein Gerät, das SCHON als Komponente
     * angeboten wird, nicht ein zweites Mal als freie Adresse erscheint.
     */
    private static String endpointKey(Target t) {
        return t.host() == null ? null
                : t.host() + ":" + (t.port() == null ? 502 : t.port())
                        + "#" + (t.unitId() == null ? 1 : t.unitId());
    }

    /** Eine von der Box gemeldete Quelle als Ziel der freien LAN-Lane. */
    private Optional<Target> sourceTarget(EntityObservedRepository.ObservedRow r) {
        if (!"local".equals(r.source())) {
            return Optional.empty();
        }
        EntityObservedRepository.EdgeLink link = r.edgeLink();
        JsonNode conn = parse(link == null ? null : link.connectionJson());
        String host = text(conn, "ip");
        if (host == null) {
            // Ohne Adresse ist es kein Ziel im LAN - und eine erfundene wäre
            // schlimmer als keine.
            return Optional.empty();
        }
        String communication = link == null ? null : link.communication();
        String label = r.label() == null || r.label().isBlank()
                ? sourceName(r) : r.label();
        boolean writable = true;
        String reason = null;
        if (SOLARMAN.equals(communication)) {
            // ⚠ HIER ist es eine ECHTE Ablehnung, kein Alias: dieses Gerät hängt
            // an einem EIGENEN Logger, die primäre Lane meint aber den
            // Wechselrichter, den die Box selbst eingerichtet hat - ein Alias
            // schickte den Auftrag an ein ANDERES Gerät. Der Satz nennt deshalb
            // den Weg statt eines Transports, den niemand kennen muss.
            writable = false;
            reason = "Dieses Gerät hängt an einem eigenen Logger. Richten Sie es zuerst als "
                    + "Komponente ein - dann kennt VoltPilot seinen Schreibweg.";
        } else if (communication != null && HTTP_TRANSPORTS.contains(communication)) {
            writable = false;
            reason = HTTP_KEIN_MODBUS;
        } else if (communication != null && CORE_OWNED_TRANSPORTS.contains(communication)) {
            writable = false;
            reason = NUR_VERBRAUCHERSTEUERUNG;
        }
        // ⚠ Die FAMILIE der Quelle wird NICHT übernommen: die freie Lane nennt
        // einen Endpunkt, kein eingerichtetes Gerät, und die Box kann dort nicht
        // beweisen, WAS antwortet. Jedes Register bleibt dort „unbekannt".
        return Optional.of(new Target(LANE_LAN, r.deviceId(), null, label, r.edgeBrand(),
                r.edgeModel(), null, communication, host, integer(conn, "port"), unit(conn),
                writable, reason));
    }

    private static String sourceName(EntityObservedRepository.ObservedRow r) {
        String brand = r.edgeBrand() == null ? "" : r.edgeBrand().trim();
        String model = r.edgeModel() == null ? "" : r.edgeModel().trim();
        String joined = (brand + " " + model).trim();
        return joined.isEmpty() ? "Gerät im Netzwerk" : joined;
    }

    /**
     * Die Register-Familie des primären Wechselrichters EINES Geräts - genau
     * der Schlüssel, unter dem das Register-Wissen spricht. {@code null} heißt
     * „die Box hat sie nicht gemeldet", nie „es gibt keine".
     */
    public String primaryFamily(UUID siteId, UUID deviceId) {
        String reported = observed.forSite(siteId).stream()
                .filter(r -> deviceId.equals(r.deviceId()) && isInverter(r))
                .map(r -> r.edgeLink() == null ? null : r.edgeLink().family())
                .filter(f -> f != null && !f.isBlank())
                .findFirst().orElse(null);
        if (reported != null) {
            return reported;
        }
        // ⚠ ZWEITE QUELLE, damit die Bedeutung nicht am Herzschlag hängt: auf
        // einer portal-verwalteten Anlage steht die Familie in der gespeicherten
        // Definition des Wechselrichters. Ohne diesen Rückgriff verlöre eine
        // Anlage, deren Box (noch) kein local_setup meldet, den Klartext-Namen
        // ihres Registers - obwohl das Portal ihn kennt.
        return registry.entitiesForSite(siteId).stream()
                .filter(e -> deviceId.equals(e.deviceId()))
                .filter(e -> SOLARMAN.equals(e.communication())
                        || "battery-hybrid".equals(e.entityType()))
                .map(EntityRegistryRepository.EntityRow::family)
                .filter(f -> f != null && !f.isBlank())
                .findFirst().orElse(null);
    }

    /** Die Familie eines beliebigen Ziels (Komponente bzw. primärer Wechselrichter). */
    public String familyFor(UUID siteId, UUID deviceId, String lane, UUID entityId) {
        if (LANE_ENTITY.equals(lane) && entityId != null) {
            return registry.entitiesForSite(siteId).stream()
                    .filter(e -> entityId.equals(e.id()))
                    .map(EntityRegistryRepository.EntityRow::family)
                    .filter(f -> f != null && !f.isBlank())
                    .findFirst().orElse(null);
        }
        if (LANE_PRIMARY.equals(lane)) {
            return primaryFamily(siteId, deviceId);
        }
        // ⚠ Eine freie LAN-Adresse hat per Konstruktion KEINE bekannte Familie:
        // niemand hat dieses Gerät je eingerichtet. Jedes Register dort ist
        // „unbekannt" - und das ist die ehrlichste Auskunft, die es gibt.
        return null;
    }

    private Target primaryTarget(DeviceDto device,
            List<EntityObservedRepository.ObservedRow> rows) {
        EntityObservedRepository.ObservedRow inv = rows.stream()
                .filter(r -> device.id().equals(r.deviceId()) && isInverter(r))
                .findFirst().orElse(null);
        String name = device.name() == null || device.name().isBlank()
                ? device.externalRef() : device.name();
        if (inv == null) {
            // Die Box hat ihre Einrichtung (noch) nicht gemeldet. Das Ziel bleibt
            // wählbar - die primäre Lane nennt ohnehin keinen Endpunkt, die Box
            // nimmt IHREN Wechselrichter -, aber ohne Familie ist jedes Register
            // dort „unbekannt".
            return new Target(LANE_PRIMARY, device.id(), null,
                    "Primärer Wechselrichter · " + name, null, null, null, null, null, null, null,
                    true, null);
        }
        EntityObservedRepository.EdgeLink link = inv.edgeLink();
        String communication = link == null ? null : link.communication();
        JsonNode conn = parse(link == null ? null : link.connectionJson());
        String label = deviceLabel(inv, name);
        String reason = null;
        boolean writable = true;
        if (communication != null && HTTP_TRANSPORTS.contains(communication)) {
            writable = false;
            reason = HTTP_KEIN_MODBUS;
        }
        return new Target(LANE_PRIMARY, device.id(), null, label, inv.edgeBrand(), inv.edgeModel(),
                link == null ? null : link.family(), communication,
                text(conn, "ip"), integer(conn, "port"), unit(conn), writable, reason);
    }

    private Optional<Target> componentTarget(EntityRegistryRepository.EntityRow e) {
        JsonNode conn = parse(e.connectionJson());
        String communication = e.communication();
        if (conn == null && (communication == null || communication.isBlank())) {
            // Eine komponierte Zeile ohne jede Anbindung ist kein Gerät im LAN -
            // sie hier zu nennen wäre ein Angebot ohne Gegenstand.
            return Optional.empty();
        }
        String label = e.label() == null || e.label().isBlank() ? e.entityType() : e.label();
        String host = text(conn, "ip");
        boolean writable = true;
        String reason = null;
        if (SOLARMAN.equals(communication)) {
            // ⚠ DAS IST EINE ABBILDUNG, KEINE ABLEHNUNG (Captain-Entscheid E4).
            // Die Transport-Tatsache bleibt wahr - dieser Socket gehört dem
            // Wechselrichter-Tab, und der wird über die primäre Lane erreicht -,
            // aber sie ist unsere, nicht die des Kunden: der frühere Satz
            // („bitte den primären Wechselrichter als Ziel wählen") erschien
            // ausgerechnet auf der Seite DIESES Wechselrichters und schickte
            // einen Menschen dorthin, wo er schon stand. Die Box bekommt
            // weiterhin einen Auftrag auf der primären Lane, ihre Politik
            // (Admit/WriteOnce, Selbstkonflikt-Sperre) ist unberührt.
            return Optional.of(new Target(LANE_PRIMARY, e.deviceId(), e.id(), label, e.brand(),
                    e.model(), e.family(), communication, host, integer(conn, "port"), unit(conn),
                    true, null, true));
        }
        if (communication != null && HTTP_TRANSPORTS.contains(communication)) {
            writable = false;
            reason = HTTP_KEIN_MODBUS;
        } else if (communication != null && CORE_OWNED_TRANSPORTS.contains(communication)) {
            writable = false;
            reason = NUR_VERBRAUCHERSTEUERUNG;
        } else if (host == null) {
            writable = false;
            reason = "Für dieses Gerät ist keine IP-Adresse hinterlegt.";
        }
        return Optional.of(new Target(LANE_ENTITY, e.deviceId(), e.id(), label, e.brand(),
                e.model(), e.family(), communication, host, integer(conn, "port"), unit(conn),
                writable, reason));
    }

    private static boolean isInverter(EntityObservedRepository.ObservedRow r) {
        return "local".equals(r.source()) && ROLE_INVERTER.equalsIgnoreCase(r.edgeRole());
    }

    /**
     * Der Anzeige-Name eines gemeldeten Wechselrichters. Der vom Betreiber
     * vergebene Name gewinnt; sonst Marke und Modell, sonst das Gerät.
     */
    private static String deviceLabel(EntityObservedRepository.ObservedRow inv, String fallback) {
        if (inv.label() != null && !inv.label().isBlank()) {
            return inv.label();
        }
        String brand = inv.edgeBrand() == null ? "" : inv.edgeBrand().trim();
        String model = inv.edgeModel() == null ? "" : inv.edgeModel().trim();
        String joined = (brand + " " + model).trim();
        return joined.isEmpty() ? "Primärer Wechselrichter · " + fallback : joined;
    }

    private JsonNode parse(String json) {
        if (json == null || json.isBlank()) {
            return null;
        }
        try {
            JsonNode n = mapper.readTree(json);
            return n.isObject() ? n : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static String text(JsonNode n, String field) {
        if (n == null) {
            return null;
        }
        String v = n.path(field).asText(null);
        return v == null || v.isBlank() ? null : v.trim();
    }

    private static Integer integer(JsonNode n, String field) {
        if (n == null || !n.hasNonNull(field) || !n.path(field).isNumber()) {
            return null;
        }
        int v = n.path(field).asInt();
        return v <= 0 || v > 0xffff ? null : v;
    }

    /** Die Unit-ID heißt je nach Transport {@code unit_id} oder {@code mb_slave_id}. */
    private static Integer unit(JsonNode n) {
        Integer u = integer(n, "unit_id");
        return u != null ? u : integer(n, "mb_slave_id");
    }
}
