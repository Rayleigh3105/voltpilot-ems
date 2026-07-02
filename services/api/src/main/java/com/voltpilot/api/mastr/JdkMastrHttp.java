package com.voltpilot.api.mastr;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;

/** JDK {@link HttpClient} transport with hard connect/request timeouts. */
public class JdkMastrHttp implements MastrHttp {

    private final HttpClient client;
    private final Duration timeout;

    public JdkMastrHttp(Duration timeout) {
        this.timeout = timeout;
        this.client = HttpClient.newBuilder().connectTimeout(timeout).build();
    }

    @Override
    public Response post(URI uri, Map<String, String> headers, String body) throws IOException {
        HttpRequest.Builder builder = HttpRequest.newBuilder(uri)
                .timeout(timeout)
                .POST(HttpRequest.BodyPublishers.ofString(body));
        headers.forEach(builder::header);
        return send(builder.build());
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
