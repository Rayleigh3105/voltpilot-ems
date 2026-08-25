package com.voltpilot.api.consumers;

import com.voltpilot.api.simulation.SimulationHttp;
import java.net.URI;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Thin client of the solve service's {@code POST /replan} (D8): one real
 * planning cycle for one site. Rides the SAME {@link SimulationHttp} seam and
 * base-url as the Ersparnis-Simulation proxy - the solve surface is ONE
 * service, so there is exactly one base-url to keep in sync. It reports every
 * refusal/failure to its caller; event-driven callers keep that request pending
 * and retry within their own per-site rate limit.
 *
 * <p>Deliberately NOT a {@code @Component}: {@code SimulationHttp} is never a
 * bean by default (the ObjectProvider seam with the {@code JdkSimulationHttp}
 * fallback lives in {@code SimulationConfig}), so a component with a hard
 * constructor dependency would refuse EVERY context start - prod included.
 * {@code SimulationConfig} constructs this bean like its two siblings.
 */
public class ReplanClient {

    private static final Logger log = LoggerFactory.getLogger(ReplanClient.class);

    private final SimulationHttp http;
    private final URI baseUri;

    public ReplanClient(SimulationHttp http, String baseUrl) {
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
            log.warn("event replan for site {} failed: {}",
                    siteId, e.getMessage());
            return false;
        }
    }
}
