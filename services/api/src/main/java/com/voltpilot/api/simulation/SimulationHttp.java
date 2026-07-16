package com.voltpilot.api.simulation;

import java.io.IOException;
import java.net.URI;

/**
 * Minimal HTTP transport behind {@link SimulationClient} so tests can serve a
 * fake simulation service without any network (the MastrHttp seam pattern).
 * Production implementation: {@link JdkSimulationHttp}.
 */
public interface SimulationHttp {

    Response post(URI uri, String jsonBody) throws IOException;

    Response get(URI uri) throws IOException;

    record Response(int status, String body) {
    }
}
