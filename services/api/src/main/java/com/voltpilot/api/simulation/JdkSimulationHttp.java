package com.voltpilot.api.simulation;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/** JDK {@link HttpClient} transport with hard connect/request timeouts. */
public class JdkSimulationHttp implements SimulationHttp {

    private final HttpClient client;
    private final Duration timeout;

    public JdkSimulationHttp(Duration timeout) {
        this.timeout = timeout;
        this.client = HttpClient.newBuilder().connectTimeout(timeout).build();
    }

    @Override
    public Response post(URI uri, String jsonBody) throws IOException {
        HttpRequest request = HttpRequest.newBuilder(uri)
                .timeout(timeout)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(jsonBody))
                .build();
        return send(request);
    }

    @Override
    public Response get(URI uri) throws IOException {
        return send(HttpRequest.newBuilder(uri).timeout(timeout).GET().build());
    }

    private Response send(HttpRequest request) throws IOException {
        try {
            HttpResponse<String> res = client.send(request, HttpResponse.BodyHandlers.ofString());
            return new Response(res.statusCode(), res.body());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("interrupted", e);
        }
    }
}
