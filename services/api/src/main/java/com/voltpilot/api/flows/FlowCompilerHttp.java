package com.voltpilot.api.flows;

import java.io.IOException;
import java.net.URI;

/**
 * Minimal HTTP transport behind {@link FlowCompilerClient} so tests can serve a
 * fake flowc sidecar without any network (the {@code SimulationHttp}/MastrHttp
 * seam pattern). Production implementation: {@link JdkFlowCompilerHttp}.
 */
public interface FlowCompilerHttp {

    Response post(URI uri, String jsonBody) throws IOException;

    record Response(int status, String body) {
    }
}
