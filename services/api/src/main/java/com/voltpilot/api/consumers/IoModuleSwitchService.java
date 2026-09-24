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
 * Test-Schalten eines Ausgangs eines I/O-Moduls von der Geräteseite (Ebyte M31):
 * „geht der Ausgang überhaupt?" - für jeden Kunden, ohne Regel und ohne
 * Verbraucher.
 *
 * <p><b>Es ist der geführte Schalt-Test, kein Dauerschalter.</b> Er reist als
 * {@code switch_test} über den Probe-Kanal (Transport {@code ebyte_modbus_tcp});
 * die Box armiert das automatische Aus VOR dem Schreiben, die Dauer ist auf
 * {@link #MAX_SECONDS} begrenzt (Vertrag {@code ttl_s}), und ein erneuter Klick
 * startet die Dauer neu. Ein dauerhaftes Schalten gehört einem Verbraucher - mit
 * seinen Grenzen, Schonzeiten und seinem Handeingriff.
 *
 * <p>Ein Ausgang, der einem Verbraucher gehört, wird hier NICHT eingeschaltet
 * (409 mit dem Namen des Verbrauchers): der Verbraucher-Executor zöge ihn beim
 * nächsten Takt auf seinen Plan zurück, und der Test umginge dessen Schutz.
 * Ausschalten bleibt immer erlaubt - es ist die sichere Richtung. Die Box prüft
 * beides ein zweites Mal selbst.
 */
@Service
public class IoModuleSwitchService {

    /** Die längste Testdauer, die der Vertrag trägt ({@code switch_test.ttl_s}). */
    public static final int MAX_SECONDS = 120;

    /** {@code on=true} schaltet für {@code seconds} (Vorgabe 120) ein, {@code false} sofort aus. */
    public record Request(Boolean on, Integer seconds) {}

    /**
     * Das Ergebnis in Kundenworten. {@code state} ist der vom Gerät
     * ZURÜCKGELESENE Zustand ({@code null} = nicht gelesen), nie der Befehl;
     * {@code offAfterSeconds} nennt das automatische Aus.
     */
    public record Outcome(boolean ok, int channel, Boolean state, Integer offAfterSeconds,
            String message) {}

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

    public Outcome test(UUID siteId, UUID ioEntityId, int channel, Request req, String actor) {
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
        int seconds = req.seconds() == null ? MAX_SECONDS
                : Math.max(1, Math.min(MAX_SECONDS, req.seconds()));
        Integer port = c.hasNonNull("port") ? c.get("port").asInt() : null;
        Integer unit = c.hasNonNull("unit_id") ? c.get("unit_id").asInt() : null;
        ProbePublisher.SwitchOp op = new ProbePublisher.SwitchOp(
                on ? "switch_test" : "switch_cancel", "ausgang", host.trim(), port, unit, "coil",
                channel - 1, 5, on ? 1 : null, 0, on ? seconds : null, null,
                "ebyte_modbus_tcp");
        ProbeResult result = probes.switchOp(siteId, null, op, actor);
        return outcome(channel, on, result);
    }

    static Outcome outcome(int channel, boolean on, ProbeResult result) {
        if (result == null || result.errorCode() != null || result.results() == null
                || result.results().isEmpty()) {
            String msg = result != null && result.message() != null ? result.message()
                    : "Die Anlage hat nicht geantwortet.";
            return new Outcome(false, channel, null, null, msg);
        }
        ProbeResult.OpResult line = result.results().get(0);
        if (!line.ok()) {
            return new Outcome(false, channel, null, null,
                    line.message() != null ? line.message() : "Der Ausgang ließ sich nicht schalten.");
        }
        ProbeResult.Switched sw = line.switched();
        Boolean state = sw == null || sw.readback() == null ? null : sw.readback() != 0;
        Integer offAfter = sw == null ? null : sw.offAfterS();
        String msg = on
                ? "Ausgang DO" + channel + " ist eingeschaltet und schaltet nach "
                        + (offAfter == null ? MAX_SECONDS : offAfter) + " Sekunden von selbst ab."
                : "Ausgang DO" + channel + " ist ausgeschaltet.";
        if (state != null && state != on) {
            msg = "Der Befehl wurde angenommen, aber das Gerät meldet den Ausgang als "
                    + (state ? "EIN" : "AUS") + ".";
        }
        return new Outcome(true, channel, state, offAfter, msg);
    }

    private JsonNode parse(String json) {
        try {
            return json == null ? null : mapper.readTree(json);
        } catch (Exception e) {
            return null;
        }
    }
}
