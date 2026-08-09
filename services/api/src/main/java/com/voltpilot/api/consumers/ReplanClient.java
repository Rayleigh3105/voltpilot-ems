package com.voltpilot.api.consumers;

import com.voltpilot.api.simulation.SimulationHttp;
import java.net.URI;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Thin client of the solve service's {@code POST /replan} (D8): one real
 * planning cycle for one site. Rides the SAME {@link SimulationHttp} seam and
 * base-url as the Ersparnis-Simulation proxy - the solve surface is ONE
 * service, so there is exactly one base-url to keep in sync. Best-effort: a
 * refused/failed replan only logs (the 15-minute tick replans anyway).
 */
@Component
public class ReplanClient {

    private static final Logger log = LoggerFactory.getLogger(ReplanClient.class);

    private final SimulationHttp http;
    private final URI baseUri;

    public ReplanClient(SimulationHttp http,
            @Value("${voltpilot.simulation.base-url:http://simulation:8095}") String baseUrl) {
        this.http = http;
        this.baseUri = URI.create(baseUrl.endsWith("/")
                ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl);
    }

    /** Trigger one replan; true when the solve service accepted and ran it. */
    public boolean replan(UUID siteId) {
        try {
            SimulationHttp.Response response = http.post(URI.create(baseUri + "/replan"),
                    "{\"site_id\":\"" + siteId + "\"}");
            if (response.status() == 200) {
                log.info("event replan for site {} done: {}", siteId, response.body());
                return true;
            }
            log.warn("event replan for site {} refused ({}): {}", siteId, response.status(),
                    response.body());
            return false;
        } catch (Exception e) {
            log.warn("event replan for site {} failed: {} (the 15-min tick replans anyway)",
                    siteId, e.getMessage());
            return false;
        }
    }
}
