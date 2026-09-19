package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.test.autoconfigure.actuate.observability.AutoConfigureObservability;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.boot.test.web.server.LocalServerPort;

/**
 * Der Scrape-Endpunkt der Datenannahme existiert wirklich, antwortet einem ANONYMEN Aufrufer - und
 * sonst hat sich nichts geoeffnet.
 *
 * <p>Vorbild ist {@code MetricsEndpointSecurityTest} der api. Der ingest hat keinen
 * Security-Starter (wie der Writer auf 8092), es gibt hier also keine Filterkette zu pruefen; die
 * zweite Haelfte zaehlt trotzdem genauso: das Umhaengen von {@code prometheus} auf {@code /metrics}
 * darf die uebrigen Actuator-Endpunkte NICHT mitoeffnen - {@code /env}, {@code /beans} und
 * {@code /configprops} geben Zugangsdaten aus (der ingest traegt die Provisioning-Kennwoerter).
 *
 * <p>Bis zu diesem Paket veroeffentlichte der ingest auf 8091 nur {@code /health} und {@code /info}
 * (PR 966, gitops-PR 37): die Micrometer-Zaehler liefen im Prozess, aber niemand konnte sie
 * abholen.
 */
// ⚠ OHNE DIESE ZEILE IST DER TEST WERTLOS: @SpringBootTest setzt
// management.defaults.metrics.export.enabled=false, der Prometheus-Endpunkt entsteht dann gar nicht
// und /metrics antwortet 404 - das sieht wie ein Fehler in der application.yml aus, ist aber eine
// reine TEST-Vorgabe. Dieselbe Falle steht in MetricsEndpointSecurityTest der api.
@AutoConfigureObservability
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
            "voltpilot.provisioning.enabled=false",
            "voltpilot.telemetry-v2.enabled=false",
            "spring.integration.endpoints.no-auto-startup=*"
        })
class MetrikEndpunktTest {

    @LocalServerPort int port;

    /** Gibt es das Redpanda-Topic events.raw? Hier laeuft kein Redpanda. */
    @MockBean EventsTopicPruefung eventsTopic;

    private HttpResponse<String> get(String path) throws Exception {
        HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
        return client.send(
                HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
                        .timeout(Duration.ofSeconds(10))
                        .GET()
                        .build(),
                HttpResponse.BodyHandlers.ofString());
    }

    @Test
    void derScrapeEndpunktAntwortetAnonymAufSlashMetrics() throws Exception {
        when(eventsTopic.vorhanden()).thenReturn(true);

        HttpResponse<String> antwort = get("/metrics");

        assertThat(antwort.statusCode()).as("anonymes GET /metrics").isEqualTo(200);
        // Und es ist wirklich der Prometheus-Endpunkt - das Umhaengen in der application.yml greift.
        assertThat(antwort.body()).contains("# TYPE").contains("jvm_");
    }

    /**
     * Der eigentliche Zweck des Pakets: die Zaehler der Datenannahme sind ABHOLBAR, ab Start als
     * {@code 0}, und keine Reihe traegt eine Kennung.
     */
    @Test
    void dieZaehlerDerDatenannahmeStehenImScrape() throws Exception {
        when(eventsTopic.vorhanden()).thenReturn(true);

        String rumpf = get("/metrics").body();

        assertThat(rumpf)
                .contains("voltpilot_ingest_angenommen_total")
                .contains("voltpilot_ingest_weitergereicht_total")
                .contains("voltpilot_ingest_verworfen_total")
                .contains("voltpilot_ingest_letzter_schreibzug_age_seconds");
        // Vier Stroeme x drei Gruende, alle ab Start auf 0 - ohne die Schreibweise des Exporters
        // festzunageln (Reihenfolge und Komma der Label sind seine Sache, nicht unsere).
        assertThat(rumpf.lines().filter(l -> l.startsWith("voltpilot_ingest_verworfen_total")).toList())
                .hasSize(12)
                .allSatisfy(zeile -> assertThat(zeile).endsWith(" 0.0"))
                .anySatisfy(zeile -> assertThat(zeile)
                        .contains("grund=\"identitaet\"").contains("strom=\"telemetry\""));

        assertThat(rumpf.lines().filter(l -> l.startsWith("voltpilot_ingest_")).toList())
                .isNotEmpty()
                .allSatisfy(zeile -> assertThat(zeile)
                        .doesNotContain("tenant").doesNotContain("site")
                        .doesNotContain("device").doesNotContain("box"));
    }

    /**
     * Die Freigabe ist ein EXAKTER Endpunkt, kein Platzhalter. {@code /env}, {@code /beans} und
     * {@code /configprops} geben Geheimnisse aus, wenn sie je jemand exponiert; {@code /prometheus}
     * und {@code /actuator/prometheus} sind die Pfade, die das Umhaengen gerade NICHT bedienen soll.
     */
    @ParameterizedTest
    @ValueSource(strings = {"/env", "/beans", "/configprops", "/prometheus", "/actuator/prometheus",
            "/metrics/jvm.memory.used", "/loggers", "/heapdump", "/threaddump"})
    void sonstIstNichtsOffen(String pfad) throws Exception {
        when(eventsTopic.vorhanden()).thenReturn(true);

        assertThat(get(pfad).statusCode()).as("anonymes GET %s", pfad).isNotEqualTo(200);
    }

    /** Die Probe-Pfade sind unveraendert geblieben - das Umhaengen hat sie nicht verschoben. */
    @Test
    void dieProbePfadeBleibenWoSieWaren() throws Exception {
        when(eventsTopic.vorhanden()).thenReturn(true);

        assertThat(get("/health/liveness").statusCode()).isEqualTo(200);
        assertThat(get("/health/readiness").statusCode()).isEqualTo(200);
        assertThat(get("/health").statusCode()).isEqualTo(200);
    }
}
