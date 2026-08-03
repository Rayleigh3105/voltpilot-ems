package com.voltpilot.api.optimizer;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.simulation.SimulationHttp;
import java.io.IOException;
import java.net.URI;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/**
 * Thin proxy onto the optimization service's SYNCHRONOUS what-if re-optimize
 * (design vp-admin-optimizer-ui-design §4.3, shape (a)): the api owns
 * auth/tenancy, the Python service owns the math and re-uses the production
 * solver unchanged.
 *
 * <p>It rides the SAME internal on-demand solve service as the
 * Ersparnis-Simulation ({@code POST /what-if} next to {@code /simulations} on
 * the optimization image's {@code simulate-serve} surface), so it reuses
 * {@link com.voltpilot.api.simulation.SimulationProperties} and the
 * {@link SimulationHttp} transport seam - no second container, no second
 * base-url to keep in sync across both composes. A what-if solves in well
 * under a second, which is exactly why it is synchronous and has no job id.
 *
 * <p>The call NEVER persists or publishes anything - that is a property of the
 * Python module (see its docstring + import-graph test), not of this proxy.
 * Upstream German refusals (400 validation / un-plannable site, 429 saturation)
 * are relayed verbatim; transport failures become 502 with operator-facing
 * copy, so a dead service can never read as "the plan got worse".
 */
public class WhatIfClient {

    private static final Logger log = LoggerFactory.getLogger(WhatIfClient.class);

    static final String UNAVAILABLE_MESSAGE =
            "Der Rechendienst ist gerade nicht erreichbar. Der gespeicherte "
                    + "Fahrplan gilt unverändert - bitte in wenigen Minuten erneut versuchen.";

    private final SimulationHttp http;
    private final URI baseUri;
    private final ObjectMapper json;

    public WhatIfClient(SimulationHttp http, URI baseUri, ObjectMapper json) {
        this.http = http;
        this.baseUri = baseUri;
        this.json = json;
    }

    /** Solve once with and once without the overrides; returns the raw result. */
    public Map<String, Object> reoptimize(Map<String, Object> payload) {
        SimulationHttp.Response response;
        try {
            response = http.post(resolve("/what-if"), json.writeValueAsString(payload));
        } catch (IOException e) {
            log.warn("whatif.unreachable: {}", e.toString());
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, UNAVAILABLE_MESSAGE, e);
        }
        if (response.status() == 200) {
            return parse(response.body());
        }
        // 400 = invalid knobs OR a site that honestly cannot be planned right
        // now; 429 = too many concurrent re-optimizes. Both carry a German
        // reason the operator should read, so they pass through untouched.
        if (response.status() == 400 || response.status() == 429) {
            throw new ResponseStatusException(
                    HttpStatus.valueOf(response.status()), upstreamMessage(response));
        }
        log.warn("whatif.unexpected_status: {}", response.status());
        throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, UNAVAILABLE_MESSAGE);
    }

    private URI resolve(String path) {
        String base = baseUri.toString();
        return URI.create(base.endsWith("/")
                ? base.substring(0, base.length() - 1) + path : base + path);
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
