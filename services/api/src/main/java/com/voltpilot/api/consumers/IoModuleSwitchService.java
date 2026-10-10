package com.voltpilot.api.consumers;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.probe.ProbePublisher;
import com.voltpilot.api.probe.ProbeResult;
import com.voltpilot.api.probe.ProbeService;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Ein/Aus eines Ausgangs eines I/O-Moduls von der Geräteseite (Ebyte M31) -
 * wie ein Schalter in Home Assistant, für jeden Kunden, ohne Regel und ohne
 * Verbraucher.
 *
 * <p>Er reist als {@code switch_set} über den Probe-Kanal (Transport
 * {@code ebyte_modbus_tcp}) und bleibt stehen, bis erneut geschaltet wird - es
 * gibt keinen Auto-Aus. Die Schutzgrenze liegt im Gerät: fällt die Box aus,
 * schaltet der Geräte-Watchdog alle Ausgänge AUS. Freie Modbus-Register haben
 * diesen Schutz nicht und bekommen diesen Weg deshalb nie.
 *
 * <p>Ein Ausgang, der einem Verbraucher gehört, wird hier NICHT eingeschaltet
 * (409): der Verbraucher-Executor zöge ihn beim nächsten Takt auf seinen Plan
 * zurück, und das Schalten umginge dessen Schutz - dort schaltet der
 * Handeingriff. Ausschalten bleibt immer erlaubt. Die Box prüft beides ein
 * zweites Mal selbst.
 */
@Service
public class IoModuleSwitchService {

    /** {@code on=true} schaltet ein, {@code false} aus - dauerhaft. */
    public record Request(Boolean on) {}

    /**
     * Das Ergebnis in Kundenworten. {@code state} ist der vom Gerät
     * ZURÜCKGELESENE Zustand ({@code null} = nicht gelesen), nie der Befehl.
     */
    public record Outcome(boolean ok, int channel, Boolean state, String message) {}

    private final ConsumerRepository consumers;
    private final ProbeService probes;
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public IoModuleSwitchService(ConsumerRepository consumers, ProbeService probes,
            JdbcTemplate jdbc, ObjectMapper mapper) {
        this.consumers = consumers;
        this.probes = probes;
        this.jdbc = jdbc;
        this.mapper = mapper;
    }

    public Outcome set(UUID siteId, UUID ioEntityId, int channel, Request req, String actor) {
        if (req == null || req.on() == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Bitte angeben, ob der Ausgang ein- oder ausgeschaltet werden soll.");
        }
        if (channel < 1 || channel > 256) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Den Ausgang " + channel + " gibt es nicht.");
        }
        List<String> conn = jdbc.queryForList(
                "SELECT connection_json::text FROM measurement_point "
                        + "WHERE site_id = ? AND id = ? AND entity_type = 'io-module'",
                String.class, siteId, ioEntityId);
        if (conn.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "I/O-Modul nicht gefunden.");
        }
        JsonNode c = parse(conn.get(0));
        String host = c == null ? null : c.path("ip").asText(null);
        if (host == null || host.isBlank()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Für dieses I/O-Modul ist keine Adresse hinterlegt.");
        }
        boolean on = req.on();
        if (on) {
            UUID owner = consumers.ioChannelOwner(siteId, ioEntityId, channel);
            if (owner != null) {
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                        "Ausgang DO" + channel + " gehört zu einem Verbraucher. Bitte dort per "
                                + "Handeingriff schalten.");
            }
        }
        Integer port = c.hasNonNull("port") ? c.get("port").asInt() : null;
        Integer unit = c.hasNonNull("unit_id") ? c.get("unit_id").asInt() : null;
        // Wie jeder Einmal-Auftrag (UEMS AP-06 IP-8): an die Box, die das Modul
        // liest, sonst an die führende - nie an eine beliebige Box der Anlage.
        ProbeResult result = probes.switchOp(siteId, null, ioEntityId,
                ProbePublisher.SwitchOp.ioSet(host.trim(), port, unit, channel, on), actor);
        return outcome(channel, on, result);
    }

    static Outcome outcome(int channel, boolean on, ProbeResult result) {
        if (result == null || result.errorCode() != null || result.results() == null
                || result.results().isEmpty()) {
            String msg = result != null && "timeout".equals(result.errorCode())
                    ? "Die Anlage hat nicht rechtzeitig geantwortet. Der angezeigte Zustand "
                            + "aktualisiert sich, sobald die Box wieder meldet."
                    : result != null && result.message() != null ? result.message()
                    : "Die Anlage hat nicht geantwortet.";
            return new Outcome(false, channel, null, msg);
        }
        ProbeResult.OpResult line = result.results().get(0);
        if (!line.ok()) {
            return new Outcome(false, channel, null,
                    line.message() != null ? line.message() : "Der Ausgang ließ sich nicht schalten.");
        }
        ProbeResult.Switched sw = line.switched();
        Boolean state = sw == null || sw.readback() == null ? null : sw.readback() != 0;
        String msg = "Ausgang DO" + channel + " ist " + (on ? "eingeschaltet." : "ausgeschaltet.");
        if (state != null && state != on) {
            msg = "Der Befehl wurde angenommen, aber das Gerät meldet den Ausgang als "
                    + (state ? "EIN" : "AUS") + ".";
        }
        return new Outcome(true, channel, state, msg);
    }

    private JsonNode parse(String json) {
        try {
            return json == null ? null : mapper.readTree(json);
        } catch (Exception e) {
            return null;
        }
    }
}
