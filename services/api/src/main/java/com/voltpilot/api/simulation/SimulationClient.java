package com.voltpilot.api.simulation;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/**
 * Thin proxy onto the Python simulation service (design report §2): the api
 * owns auth/tenancy/master-data resolution, the service owns the math. The
 * service's German error messages (400 validation, 429 saturation) are
 * relayed verbatim; transport failures become 502 with customer-facing copy.
 */
public class SimulationClient {

    private static final Logger log = LoggerFactory.getLogger(SimulationClient.class);

    private static final String UNAVAILABLE_MESSAGE =
            "Der Simulationsdienst ist gerade nicht erreichbar. "
                    + "Bitte versuchen Sie es in wenigen Minuten erneut.";

    private final SimulationHttp http;
    private final URI baseUri;
    private final ObjectMapper json;

    public SimulationClient(SimulationHttp http, URI baseUri, ObjectMapper json) {
        this.http = http;
        this.baseUri = baseUri;
        this.json = json;
    }

    /** Submit a job; returns the simulation id (202) or maps the refusal. */
    public String submit(Map<String, Object> payload) {
        SimulationHttp.Response response;
        try {
            response = http.post(resolve("/simulations"), json.writeValueAsString(payload));
        } catch (IOException e) {
            log.warn("simulation.submit_unreachable: {}", e.toString());
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, UNAVAILABLE_MESSAGE, e);
        }
        if (response.status() == 202) {
            Object id = parse(response.body()).get("simulationId");
            if (id instanceof String s && !s.isBlank()) {
                return s;
            }
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, UNAVAILABLE_MESSAGE);
        }
        if (response.status() == 400 || response.status() == 429) {
            throw new ResponseStatusException(
                    HttpStatus.valueOf(response.status()), upstreamMessage(response));
        }
        log.warn("simulation.submit_unexpected_status: {}", response.status());
        throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, UNAVAILABLE_MESSAGE);
    }

    /** Poll a job; {@code null} when the service does not know the id. */
    public Map<String, Object> status(String simulationId) {
        SimulationHttp.Response response;
        try {
            response = http.get(resolve("/simulations/" + simulationId));
        } catch (IOException e) {
            log.warn("simulation.status_unreachable: {}", e.toString());
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, UNAVAILABLE_MESSAGE, e);
        }
        if (response.status() == 200) {
            return parse(response.body());
        }
        if (response.status() == 404) {
            return null;
        }
        log.warn("simulation.status_unexpected_status: {}", response.status());
        throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, UNAVAILABLE_MESSAGE);
    }

    private URI resolve(String path) {
        String base = baseUri.toString();
        return URI.create(base.endsWith("/") ? base.substring(0, base.length() - 1) + path
                : base + path);
    }

    private Map<String, Object> parse(String body) {
        try {
            return json.readValue(body, new TypeReference<Map<String, Object>>() {
            });
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, UNAVAILABLE_MESSAGE, e);
        }
    }

    private String upstreamMessage(SimulationHttp.Response response) {
        try {
            Object message = parse(response.body()).get("message");
            if (message instanceof String s && !s.isBlank()) {
                return s;
            }
        } catch (ResponseStatusException ignored) {
            // fall through to the generic copy
        }
        return UNAVAILABLE_MESSAGE;
    }
}
