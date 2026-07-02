package com.voltpilot.api.mastr;

import java.io.IOException;
import java.net.URI;
import java.util.Map;

/**
 * Minimal HTTP transport behind the MaStR clients so tests can serve recorded
 * fixtures without any network (the {@code FakeHttpClient} pattern from
 * services/market-data). The production implementation is {@link JdkMastrHttp}.
 */
public interface MastrHttp {

    Response post(URI uri, Map<String, String> headers, String body) throws IOException;

    Response get(URI uri) throws IOException;

    record Response(int status, String body) {
    }
}
