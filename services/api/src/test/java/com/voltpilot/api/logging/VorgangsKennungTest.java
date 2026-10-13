package com.voltpilot.api.logging;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantFilter;
import jakarta.servlet.Filter;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.slf4j.MDC;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.autoconfigure.http.HttpMessageConvertersAutoConfiguration;
import org.springframework.boot.autoconfigure.jackson.JacksonAutoConfiguration;
import org.springframework.boot.autoconfigure.web.embedded.EmbeddedWebServerFactoryCustomizerAutoConfiguration;
import org.springframework.boot.autoconfigure.web.servlet.DispatcherServletAutoConfiguration;
import org.springframework.boot.autoconfigure.web.servlet.ServletWebServerFactoryAutoConfiguration;
import org.springframework.boot.autoconfigure.web.servlet.WebMvcAutoConfiguration;
import org.springframework.boot.autoconfigure.web.servlet.error.ErrorMvcAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Die Vorgangs-Kennung an einem echten Tomcat (docs/k8s-readiness.md, Abschnitt "Logs") - ohne Docker
 * und ohne die Anwendung: nur Webserver, {@link VorgangsKennung}, der echte {@link TenantFilter} und
 * zwei Probe-Routen. MockMvc genügt hier nicht, denn geprüft wird gerade das, was Tomcat außerhalb der
 * Filterkette tut.
 *
 * <p>Ein einziger Arbeitsfaden ({@code threads.max=1}): jede Anfrage läuft im selben Faden wie die
 * vorige, ein Rest der vorigen würde also sichtbar.
 */
@SpringBootTest(
        classes = VorgangsKennungTest.MiniAnwendung.class,
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"server.tomcat.threads.max=1", "server.tomcat.threads.min-spare=1"})
class VorgangsKennungTest {

    private static final String MANDANT = "7f3c1e6a-2b4d-4c8e-9a10-5d6e7f8091a2";
    private static final String TEST_MANDANT = "X-Test-Mandant";
    /** Die Meldung der Probe-Ausnahme - daran ist Tomcats Zeile zu DIESER Anfrage zu erkennen. */
    private static final String UNBEHANDELT = "absichtlich unbehandelt";
    private static final ObjectMapper JSON = new ObjectMapper();

    @Configuration(proxyBeanMethods = false)
    @ImportAutoConfiguration({
        ServletWebServerFactoryAutoConfiguration.class,
        EmbeddedWebServerFactoryCustomizerAutoConfiguration.class,
        DispatcherServletAutoConfiguration.class,
        WebMvcAutoConfiguration.class,
        ErrorMvcAutoConfiguration.class,
        HttpMessageConvertersAutoConfiguration.class,
        JacksonAutoConfiguration.class
    })
    @Import({VorgangsKennung.class, Probe.class})
    static class MiniAnwendung {

        /** Derselbe Filter wie in der gesicherten Kette; hier hängt Spring Boot ihn an die Servlet-Kette. */
        @Bean
        TenantFilter tenantFilter() {
            return new TenantFilter();
        }

        /** Ersatz für die Bearer-Anmeldung: ein Token mit dem Mandanten aus der Test-Kopfzeile. */
        @Bean
        FilterRegistrationBean<Filter> anmeldung() {
            Filter filter = (request, response, kette) -> {
                String mandant = ((jakarta.servlet.http.HttpServletRequest) request).getHeader(TEST_MANDANT);
                if (mandant != null) {
                    Jwt jwt = new Jwt("token", Instant.now(), Instant.now().plusSeconds(300),
                            Map.of("alg", "none"), Map.of("tenant_id", mandant));
                    SecurityContextHolder.getContext().setAuthentication(new TestingAuthenticationToken(jwt, null));
                }
                try {
                    kette.doFilter(request, response);
                } finally {
                    SecurityContextHolder.clearContext();
                }
            };
            FilterRegistrationBean<Filter> bean = new FilterRegistrationBean<>(filter);
            bean.setOrder(0);
            return bean;
        }
    }

    @RestController
    static class Probe {

        /** Was eine Route im MDC vorfindet. */
        @GetMapping("/probe")
        Map<String, String> probe() {
            Map<String, String> mdc = MDC.getCopyOfContextMap();
            return mdc == null ? Map.of() : mdc;
        }

        @GetMapping("/kaputt")
        String kaputt() {
            throw new IllegalStateException(UNBEHANDELT);
        }
    }

    @LocalServerPort int port;

    /** Eine Fehlerzeile von Tomcat und das MDC des Fadens, der sie schreibt. */
    private record TomcatZeile(String meldung, Map<String, String> mdc) {
    }

    private final List<TomcatZeile> fehlerzeilen = new CopyOnWriteArrayList<>();

    /**
     * Tomcat schreibt über java.util.logging. Mitgehört wird dort und nicht in Logback: ob die Brücke
     * zwischen beiden in dieser JVM gerade steht, hängt von den Spring-Kontexten der Tests davor ab
     * (ein geschlossener Kontext baut sie ab). Die Brücke läuft im schreibenden Faden - was hier im MDC
     * steht, ist genau das, was die Log-Zeile im Betrieb trägt.
     */
    private final Handler mithoerer = new Handler() {
        @Override
        public void publish(LogRecord zeile) {
            if (zeile.getLevel().intValue() >= Level.SEVERE.intValue()
                    && String.valueOf(zeile.getLoggerName()).startsWith("org.apache.catalina.core")
                    && String.valueOf(zeile.getMessage()).contains(UNBEHANDELT)) {
                Map<String, String> mdc = MDC.getCopyOfContextMap();
                fehlerzeilen.add(new TomcatZeile(zeile.getMessage(), mdc == null ? Map.of() : mdc));
            }
        }

        @Override
        public void flush() {
        }

        @Override
        public void close() {
        }
    };

    @BeforeEach
    void mithoeren() {
        Logger.getLogger("").addHandler(mithoerer);
    }

    @AfterEach
    void aufhoeren() {
        Logger.getLogger("").removeHandler(mithoerer);
    }

    private HttpResponse<String> get(String pfad, String... kopfzeilen) throws Exception {
        HttpRequest.Builder anfrage = HttpRequest.newBuilder(URI.create("http://localhost:" + port + pfad))
                .timeout(Duration.ofSeconds(10)).GET();
        if (kopfzeilen.length > 0) {
            anfrage.headers(kopfzeilen);
        }
        return HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()
                .send(anfrage.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static String kennung(HttpResponse<String> antwort) {
        return antwort.headers().firstValue(VorgangsKennung.KOPFZEILE).orElse(null);
    }

    @Test
    void uebernimmtDieKennungDesIngressUndGibtSieInDerAntwortZurueck() throws Exception {
        String vomIngress = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";

        HttpResponse<String> antwort = get("/probe", VorgangsKennung.KOPFZEILE, vomIngress);

        assertThat(antwort.statusCode()).isEqualTo(200);
        assertThat(kennung(antwort)).isEqualTo(vomIngress);
        assertThat(JSON.readTree(antwort.body()).get("request_id").asText())
                .as("die Route läuft unter derselben Kennung").isEqualTo(vomIngress);
    }

    @Test
    void erzeugtJeAnfrageEineEigeneKennungWennKeineMitkommt() throws Exception {
        HttpResponse<String> erste = get("/probe");
        HttpResponse<String> zweite = get("/probe");

        assertThat(kennung(erste)).matches("[0-9a-f]{32}");
        assertThat(JSON.readTree(erste.body()).get("request_id").asText()).isEqualTo(kennung(erste));
        assertThat(kennung(zweite)).matches("[0-9a-f]{32}").isNotEqualTo(kennung(erste));
    }

    @Test
    void ersetztEineKennungDieNichtInDieEngeFormPasst() throws Exception {
        HttpResponse<String> antwort = get("/probe", VorgangsKennung.KOPFZEILE, "abc \"level\":\"ERROR\"");

        assertThat(antwort.statusCode()).as("ersetzt, nicht abgewiesen").isEqualTo(200);
        assertThat(kennung(antwort)).matches("[0-9a-f]{32}");
    }

    @ParameterizedTest
    @ValueSource(strings = {"0a1b2c3d4e5f60718293a4b5c6d7e8f9", "7f3c1e6a-2b4d-4c8e-9a10-5d6e7f8091a2", "a", "A.b_c-1"})
    void nimmtAnWasNurAusBuchstabenZiffernPunktStrichUndUnterstrichBesteht(String mitgeschickt) {
        assertThat(VorgangsKennung.uebernehmenOderErzeugen(mitgeschickt)).isEqualTo(mitgeschickt);
    }

    @ParameterizedTest
    @NullSource
    @ValueSource(strings = {"", " ", "mit leerzeichen", "zeile\numbruch", "a\"b", "ä", "a/b", "a,b",
            "0123456789012345678901234567890123456789012345678901234567890123x"})
    void erzeugtStattZuUebernehmenWasLeerZuLangOderFremdIst(String mitgeschickt) {
        assertThat(VorgangsKennung.uebernehmenOderErzeugen(mitgeschickt)).matches("[0-9a-f]{32}");
    }

    @Test
    void dieRouteSiehtDenMandantenSolangeErGilt() throws Exception {
        JsonNode mdc = JSON.readTree(get("/probe", TEST_MANDANT, MANDANT).body());

        assertThat(mdc.get("tenant_id").asText()).isEqualTo(MANDANT);
        assertThat(mdc.has("request_id")).isTrue();
    }

    /**
     * Der Grund für das Valve: Tomcats Zeile zur unbehandelten Ausnahme entsteht, nachdem jeder Filter
     * zurückgekehrt ist - und trägt trotzdem beide Kennungen.
     */
    @Test
    void tomcatsZeileZurUnbehandeltenAusnahmeTraegtVorgangUndMandant() throws Exception {
        String vomIngress = "feedfacefeedfacefeedfacefeedface";

        HttpResponse<String> antwort = get("/kaputt", VorgangsKennung.KOPFZEILE, vomIngress, TEST_MANDANT, MANDANT);

        assertThat(antwort.statusCode()).isEqualTo(500);
        assertThat(kennung(antwort)).as("auch die Fehlerantwort nennt ihre Kennung").isEqualTo(vomIngress);
        assertThat(fehlerzeilen).as("Tomcats Zeile zur Ausnahme").hasSize(1);
        assertThat(fehlerzeilen.get(0).mdc()).containsOnly(
                Map.entry("request_id", vomIngress), Map.entry("tenant_id", MANDANT));
    }

    /** Derselbe Arbeitsfaden bedient die nächste Anfrage - von der gescheiterten davor bleibt nichts. */
    @Test
    void nachEinerGescheitertenAnfrageTraegtDerFadenNichtsWeiter() throws Exception {
        get("/kaputt", VorgangsKennung.KOPFZEILE, "feedfacefeedfacefeedfacefeedface", TEST_MANDANT, MANDANT);

        HttpResponse<String> danach = get("/probe");

        assertThat(JSON.readTree(danach.body()).fieldNames()).toIterable().containsExactly("request_id");
        assertThat(JSON.readTree(danach.body()).get("request_id").asText())
                .isEqualTo(kennung(danach)).isNotEqualTo("feedfacefeedfacefeedfacefeedface");
    }
}
