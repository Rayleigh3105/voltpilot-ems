package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.command.CommandLog;
import com.voltpilot.api.command.CommandLogWriter;
import com.voltpilot.api.control.ControlStatusListener;
import com.voltpilot.api.curtailment.CurtailmentStatusListener;
import com.voltpilot.api.consumers.ConsumerRequirementLedgerWriter;
import com.voltpilot.api.consumers.ConsumerRuntimeStatusListener;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.repo.ControlStatusRepository;
import com.voltpilot.api.repo.ConsumerRuntimeStatusRepository;
import com.voltpilot.api.repo.CurtailmentStatusRepository;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.rules.RuleEventWriter;
import com.voltpilot.api.tenant.TenantContext;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der KOMMANDO-VERLAUF (Kommando-Transparenz V1) gegen eine ECHTE TimescaleDB +
 * Keycloak: die Perioden-Ableitung aus den drei bestehenden Herzschlag-Strömen,
 * die Punkt-Ereignisse, die Lücke, der Verbraucher-Ersatz, die Leseroute und
 * ihr Mandanten-Zaun.
 *
 * <p><b>Die Zeit kommt aus dem HERZSCHLAG, nicht aus der Uhr:</b> der Zuhörer
 * übernimmt {@code control.checked_at} bzw. {@code ts} als Zeitpunkt der
 * Beobachtung - deshalb lässt sich eine zweistündige Lücke hier ohne eine
 * einzige Sekunde Wartezeit nachstellen.
 *
 * <p>Läuft ohne Docker gar nicht (auto-skip). Die BERLIN-Anlage des Dev-Seeds
 * teilen sich mehrere Testklassen, deshalb räumt jeder Test seinen Verlauf am
 * ANFANG ab (die dokumentierte Haus-Disziplin).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class CommandHistoryApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";
    private static final String DEVICE = "00000000-0000-0000-0000-000000000003";
    private static final String TOPIC =
            "ems/" + TENANT_A + "/" + BERLIN_SITE + "/" + DEVICE + "/status";
    /** Die Anlage des ANDEREN Mandanten (Dev-Seed Nordwind). */
    private static final String HAMBURG_SITE = "10000000-0000-0000-0000-000000000002";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Container
    static final KeycloakContainer KEYCLOAK =
            new KeycloakContainer("quay.io/keycloak/keycloak:26.0.5")
                    .withRealmImportFile("keycloak/voltpilot-realm.json");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", () -> APP_USER);
        registry.add("spring.datasource.password", () -> APP_PW);
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
        registry.add("spring.flyway.placeholders.appDbUser", () -> APP_USER);
        registry.add("spring.flyway.placeholders.appDbPassword", () -> APP_PW);

        String realm = KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot";
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> realm);
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> realm + "/protocol/openid-connect/certs");
    }

    /**
     * Ohne diesen Mock ist der Registry-Push ein No-op - das Anlegen eines
     * Verbrauchers würde sonst am fehlenden Publisher scheitern.
     */
    @TestConfiguration
    static class PublisherConfig {
        @Bean
        EntityRegistryPublisher entityRegistryPublisher() {
            EntityRegistryPublisher pub = Mockito.mock(EntityRegistryPublisher.class);
            Mockito.when(pub.publishRegistry(Mockito.any(), Mockito.any(), Mockito.any(),
                    Mockito.any())).thenReturn(true);
            return pub;
        }
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    DeviceRepository deviceRepo;

    @Autowired
    ControlStatusRepository controlStatusRepo;

    @Autowired
    CurtailmentStatusRepository curtailmentStatusRepo;

    @Autowired
    ConsumerRuntimeStatusRepository consumerStatusRepo;

    @Autowired
    ConsumerRequirementLedgerWriter ledgerWriter;

    @Autowired
    RuleEventWriter ruleEventWriter;

    @Autowired
    CommandLogWriter commandLog;

    @Autowired
    com.voltpilot.api.repo.DeviceSourceStatusRepository sourceStatusRepo;

    @BeforeEach
    void clearHistory() {
        // Die Anlage ist geteilt: ohne dieses Abräumen prüfte jeder Test die
        // Zeilen seiner Nachbarn mit (die Preis-Slot-Disziplin des Hauses).
        //
        // ⚠ MIT Mandanten-Kontext, sonst ist das Abräumen ein STILLES No-op:
        // die Tabelle ist RLS/FORCE, und ohne `app.tenant_id` gilt default-deny
        // - das DELETE trifft dann null Zeilen und meldet trotzdem Erfolg.
        asTenantA(() -> {
            jdbc.update("DELETE FROM device_command_log");
            jdbc.update("DELETE FROM device_command_recording");
        });
    }

    /** Führt {@code body} unter Mandant A aus (RLS-Sitzung wie ein Zuhörer). */
    private void asTenantA(Runnable body) {
        TenantContext.set(java.util.UUID.fromString(TENANT_A));
        try {
            body.run();
        } finally {
            TenantContext.clear();
        }
    }

    /**
     * Die Reise EINES Schreibwegs: aus Herzschlägen werden Halteperioden, aus
     * einem gekippten Gate ein Punkt-Ereignis, aus Stille eine benannte Lücke -
     * und die Leseroute gibt das ÄLTESTE zuerst heraus.
     */
    @Test
    void derBatterieVerlaufEntstehtAusDenHerzschlaegenUndBleibtEineWahrheit() {
        ControlStatusListener listener = controlListener();

        // 1. Erster Herzschlag: die Periode beginnt, es wird KEIN Übergang
        //    behauptet (es gibt kein Vorher).
        listener.handle(TOPIC, control("2026-08-16T10:00:00Z", -4.302, true, true, true, "plan",
                -4.302, "[]"));
        // 2. Die Box führt jetzt dem gemessenen Haus nach: ein ANDERER Modus,
        //    also ein eigener Abschnitt - was sie tut, hat sich geändert.
        listener.handle(TOPIC, control("2026-08-16T10:00:15Z", -7.087, true, true, true, "follow",
                -4.302, "[]"));
        // 3. Derselbe Plan-Sollwert, anderer NACHGEFÜHRTER Wert: dieselbe
        //    Periode (§4.2 ⚠ - sonst zerfiele jede Viertelstunde in Dutzende).
        listener.handle(TOPIC, control("2026-08-16T10:00:30Z", -6.500, true, true, true, "follow",
                -4.302, "[]"));
        // 4. Neuer Plan-Sollwert: die Periode endet, die nächste beginnt.
        listener.handle(TOPIC, control("2026-08-16T10:00:45Z", 6.6, true, true, true, "plan", 6.6,
                "[]"));
        // 5. Das Rücklesen widerspricht ENTPRELLT (Rollen benannt): wieder ein
        //    eigener Abschnitt, mit dem Urteil `abweichend`.
        listener.handle(TOPIC, control("2026-08-16T10:01:00Z", 6.6, false, true, true, "plan", 6.6,
                "[\"battery_power\"]"));
        // 6. Der Not-Aus greift: ein Punkt-Ereignis NEBEN dem Abschnittswechsel.
        listener.handle(TOPIC, control("2026-08-16T10:01:15Z", 0.0, true, false, true, "plan", 0.0,
                "[]"));
        // 7. Zwei Stunden Stille, dann wieder ein Herzschlag: die Lücke.
        listener.handle(TOPIC, control("2026-08-16T12:20:00Z", 0.0, true, false, true, "plan", 0.0,
                "[]"));

        List<Map<String, Object>> entries = entries(read(null, "2026-08-16"));
        List<String> kinds = entries.stream().map(e -> String.valueOf(e.get("eventKind"))).toList();
        assertThat(kinds).contains(CommandLog.EVENT_NOTAUS_EIN, CommandLog.EVENT_LUECKE);

        List<Map<String, Object>> perioden = entries.stream()
                .filter(e -> CommandLog.KIND_PERIODE.equals(e.get("kind"))).toList();
        // Sechs Abschnitte: Fahrplan-Sollwert → Nachführung (die zwei
        // Herzschläge derselben Nachführung sind EINER) → neuer Sollwert →
        // abweichend → Not-Aus → nach der Lücke.
        assertThat(perioden).hasSize(6);
        assertThat(perioden.get(0).get("startedAt")).asString().startsWith("2026-08-16T10:00:00");
        assertThat(perioden.get(0).get("verdict")).isEqualTo(CommandLog.VERDICT_BESTAETIGT);
        assertThat(perioden.get(0).get("whyKind")).isEqualTo(CommandLog.WHY_FAHRPLAN);
        assertThat(perioden.get(0).get("whyRef")).isEqualTo("-4.30");
        assertThat(perioden.get(0).get("mode")).isEqualTo("plan");
        assertThat(perioden.get(0).get("endedAt")).asString().startsWith("2026-08-16T10:00:15");
        // Die NACHFÜHRUNG ist EINE Periode, deren Wert wandert - der Plan-Bezug
        // bleibt derselbe, der gefahrene Wert reist als min/max/letzter mit.
        assertThat(perioden.get(1).get("mode")).isEqualTo("follow");
        assertThat(perioden.get(1).get("whyRef")).isEqualTo("-4.30");
        assertThat((Double) perioden.get(1).get("commandedKwMin")).isEqualTo(-7.087);
        assertThat((Double) perioden.get(1).get("commandedKwMax")).isEqualTo(-6.500);
        assertThat((Double) perioden.get(1).get("commandedKwLast")).isEqualTo(-6.500);
        assertThat(perioden.get(1).get("endedAt")).asString().startsWith("2026-08-16T10:00:45");
        assertThat(perioden.get(2).get("whyRef")).isEqualTo("6.60");
        assertThat(perioden.get(3).get("verdict")).isEqualTo(CommandLog.VERDICT_ABWEICHEND);
        // Der Roh-Blick trägt genau das, was der Herzschlag hergibt.
        assertThat(detail(perioden.get(3)).get("mismatchRoles")).isEqualTo("battery_power");
        assertThat(perioden.get(4).get("controlEnabled")).isEqualTo(Boolean.FALSE);

        // Die Lücke schliesst die Periode an ihrem LETZTEN belegten Zeitpunkt -
        // nie bis „jetzt" weiterbehauptet.
        Map<String, Object> luecke = entries.stream()
                .filter(e -> CommandLog.EVENT_LUECKE.equals(e.get("eventKind")))
                .findFirst().orElseThrow();
        assertThat(luecke.get("startedAt")).asString().startsWith("2026-08-16T10:01:15");
        assertThat(luecke.get("endedAt")).asString().startsWith("2026-08-16T12:20:00");
        assertThat(perioden.get(4).get("endedAt")).asString().startsWith("2026-08-16T10:01:15");

        // V1 behauptet KEINE Schreibzyklen und sagt, woher die Zeile stammt.
        assertThat(perioden.get(0).get("cycles")).isNull();
        assertThat(perioden.get(0).get("source")).isEqualTo(CommandLog.SOURCE_CLOUD);

        Map<String, Object> body = read(null, "2026-08-16");
        assertThat(body.get("recordingSince")).isNotNull();
        assertThat(body.get("accuracySeconds")).isEqualTo(CommandLog.ACCURACY_SECONDS);
        // Der Live-Zustand reist mit - dieselben DTOs, die das Cockpit liest.
        assertThat(body.get("control")).isNotNull();
    }

    /**
     * Die Abregelung ist ein EIGENER Strom neben dem Batterie-Sollwert: zwei
     * Geräte-Register, zwei Wahrheiten. Und „nichts angewandt" ist NIE ein
     * widersprechendes Rücklesen.
     */
    @Test
    void dieAbregelungIstEinEigenerStromMitEigenemUrteil() {
        CurtailmentStatusListener listener = curtailListener();
        // Freigegeben, aber nichts angewandt: kein Urteil, denn es gibt nichts
        // zu bestätigen.
        listener.handle(TOPIC, curtail("2026-08-16T10:00:00Z", 2, 2, false, null, null));
        // Jetzt greift die Kappe und wird bestätigt.
        listener.handle(TOPIC, curtail("2026-08-16T10:05:00Z", 2, 2, true, 17.6, Boolean.TRUE));
        // Das Register hält, die Leistung folgt nicht - der 09.08.-Fall.
        listener.handle(TOPIC, curtail("2026-08-16T10:06:00Z", 2, 2, true, 17.6, Boolean.FALSE));

        List<Map<String, Object>> perioden = entries(read(null, "2026-08-16")).stream()
                .filter(e -> CommandLog.STREAM_ABREGELUNG.equals(e.get("stream"))
                        && CommandLog.KIND_PERIODE.equals(e.get("kind")))
                .toList();
        assertThat(perioden).hasSize(3);
        assertThat(perioden.get(0).get("verdict")).isNull();
        assertThat(perioden.get(0).get("mode")).isEqualTo("frei");
        assertThat(perioden.get(1).get("mode")).isEqualTo("abregeln");
        assertThat(perioden.get(1).get("verdict")).isEqualTo(CommandLog.VERDICT_BESTAETIGT);
        assertThat((Double) perioden.get(1).get("commandedKwLast")).isEqualTo(17.6);
        assertThat(perioden.get(2).get("verdict")).isEqualTo(CommandLog.VERDICT_ABWEICHEND);
        assertThat(detail(perioden.get(1)).get("certifiedUnits")).isEqualTo(2);
    }

    /**
     * Der Verbraucher-Strom trägt NUR die Bestätigungs-Dimension - und eine
     * Komponente, die der Herzschlag nicht mehr trägt, wird an ihrem letzten
     * belegten Zeitpunkt geschlossen, ohne dass ein Stopp behauptet würde.
     */
    @Test
    void derVerbraucherStromTraegtNurDasDrahtUrteilUndErsetztDenGanzenSatz() {
        String tok = token("demo", "demo");
        ResponseEntity<Map<String, Object>> created = exchange(HttpMethod.POST,
                "/api/v1/sites/" + BERLIN_SITE + "/consumers", tok, Map.of(
                        "type", "heating-rod", "name", "Heizstab Verlauf", "ratedPowerKw", 3.0,
                        "controlKind", "on_off", "edgeSourceId", "edge-src-cmdlog"));
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String entityId = (String) created.getBody().get("id");
        clearHistory();

        ConsumerRuntimeStatusListener listener = consumerListener();
        listener.handle(TOPIC, consumers("2026-08-16T10:00:00Z", entityId, "running_optimized",
                "true"));
        listener.handle(TOPIC, consumers("2026-08-16T10:00:15Z", entityId, "running_optimized",
                "false"));
        // Derselbe Herzschlag OHNE diese Komponente: die Periode endet, es
        // entsteht KEIN „gestoppt".
        listener.handle(TOPIC, ("{\"tenant_id\":\"" + TENANT_A + "\",\"site_id\":\"" + BERLIN_SITE
                + "\",\"device_id\":\"" + DEVICE + "\",\"ts\":\"2026-08-16T10:00:30Z\","
                + "\"consumers\":{}}").getBytes(StandardCharsets.UTF_8));

        List<Map<String, Object>> perioden = entries(read(entityId, "2026-08-16")).stream()
                .filter(e -> CommandLog.STREAM_VERBRAUCHER.equals(e.get("stream"))).toList();
        assertThat(perioden).hasSize(2);
        assertThat(perioden.get(0).get("verdict")).isEqualTo(CommandLog.VERDICT_BESTAETIGT);
        assertThat(perioden.get(1).get("verdict")).isEqualTo(CommandLog.VERDICT_UNBESTAETIGT);
        // Geschlossen am letzten belegten Zeitpunkt, nicht am Zeitpunkt des
        // Schweigens - und ohne ein Ereignis.
        assertThat(perioden.get(1).get("endedAt")).asString().startsWith("2026-08-16T10:00:15");
        assertThat(perioden).noneMatch(e -> CommandLog.KIND_EREIGNIS.equals(e.get("kind")));
        // Ein Verbraucher WIRD geschrieben - die Fläche darf das sagen.
        assertThat(read(entityId, "2026-08-16").get("writes")).isEqualTo(Boolean.TRUE);
    }

    /**
     * DER GERÄTE-FILTER (Anlagen-Zentrale Stufe 1, §7.4): dieselbe Anlage, drei
     * Adressen, drei verschiedene Antworten - und die Grenze dazwischen ist eine
     * AUSSAGE, keine Bequemlichkeit.
     *
     * <p>Die BOX ist der Schreibweg der Anlage: sie bekommt jede Zeile ihres
     * Geräts, auch die gerätebezogene Abregelung. Ein Gerät DAHINTER bekommt nur
     * die Zeilen SEINER Komponenten - eine anlagenweite Abregelung (EIN
     * Rücklesen über ALLE Einheiten) einem von mehreren Wechselrichtern
     * zuzuschreiben wäre eine erfundene Zuordnung.
     */
    @Test
    void derGeraeteFilterTrenntDieBoxVonDenGeraetenDahinter() {
        String tok = token("demo", "demo");
        ResponseEntity<Map<String, Object>> created = exchange(HttpMethod.POST,
                "/api/v1/sites/" + BERLIN_SITE + "/consumers", tok, Map.of(
                        "type", "heating-rod", "name", "Heizstab Geräte-Filter",
                        "ratedPowerKw", 3.0, "controlKind", "on_off",
                        "edgeSourceId", "src-heizstab"));
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String entityId = (String) created.getBody().get("id");
        clearHistory();

        // Eine gemeldete Quelle OHNE Komponente - das Gerät gibt es, es hat nur
        // noch keine Zuordnung.
        asTenantA(() -> sourceStatusRepo.replaceForDevice(java.util.UUID.fromString(DEVICE),
                java.util.UUID.fromString(TENANT_A), java.util.UUID.fromString(BERLIN_SITE),
                java.time.Instant.parse("2026-08-16T10:00:00Z"),
                List.of(new com.voltpilot.api.repo.DeviceSourceStatusRepository.SourceRow(
                        "src-fronius-1", "source", "pv-generation", null, "fronius_sunspec",
                        "Eco 27.0-3-S", 21.2, null, null, "ok",
                        java.time.Instant.parse("2026-08-16T10:00:00Z")))));

        // Zwei Ströme: der Verbraucher hängt an SEINER Komponente, die
        // Abregelung ist gerätebezogen (entity_id IS NULL).
        consumerListener().handle(TOPIC, consumers("2026-08-16T10:00:00Z", entityId,
                "running_optimized", "true"));
        consumerListener().handle(TOPIC, consumers("2026-08-16T10:00:15Z", entityId,
                "running_optimized", "true"));
        curtailListener().handle(TOPIC, curtail("2026-08-16T10:00:00Z", 2, 2, true, 30.0, true));
        curtailListener().handle(TOPIC, curtail("2026-08-16T10:00:15Z", 2, 2, true, 30.0, true));

        // 1. Die BOX unter ihrer Referenz: BEIDE Ströme.
        Map<String, Object> box = readDevice("demo-inverter-01");
        assertThat(box.get("deviceRef")).isEqualTo("demo-inverter-01");
        // Box oder Gerät dahinter ist ein SERVER-Fakt - die Fläche rät ihn nie.
        assertThat(box.get("deviceIsBox")).isEqualTo(Boolean.TRUE);
        assertThat(streams(box)).contains(CommandLog.STREAM_VERBRAUCHER,
                CommandLog.STREAM_ABREGELUNG);

        // 2. Das Gerät HINTER der Box: nur seine Komponente - die anlagenweite
        //    Abregelung wird ihm NICHT zugeschrieben.
        Map<String, Object> geraet = readDevice("src-heizstab");
        assertThat(streams(geraet)).containsExactly(CommandLog.STREAM_VERBRAUCHER);
        assertThat(geraet.get("writes")).isEqualTo(Boolean.TRUE);
        assertThat(geraet.get("deviceIsBox")).isEqualTo(Boolean.FALSE);
        assertThat(entries(geraet)).allMatch(e -> entityId.equals(e.get("entityId")));

        // 3. Gemeldet, aber ohne Komponente: ehrlich LEER - nie „alle Zeilen".
        Map<String, Object> ohne = readDevice("src-fronius-1");
        assertThat(entries(ohne)).isEmpty();
        assertThat(ohne.get("writes")).isEqualTo(Boolean.FALSE);
        assertThat(ohne.get("recordingSince")).isNotNull();

        // 4. Die Grenzen: unbekannte Adresse 404, Komponente UND Gerät 400,
        //    fremde Anlage 404 (nie 403).
        assertThat(rest.exchange(url("/api/v1/sites/" + BERLIN_SITE
                        + "/command-history?device=gibt-es-nicht"),
                HttpMethod.GET, new HttpEntity<>(bearer(tok)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(rest.exchange(url("/api/v1/sites/" + BERLIN_SITE + "/command-history?entity="
                        + entityId + "&device=src-heizstab"),
                HttpMethod.GET, new HttpEntity<>(bearer(tok)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(rest.exchange(url("/api/v1/sites/" + HAMBURG_SITE
                        + "/command-history?device=demo-inverter-01"),
                HttpMethod.GET, new HttpEntity<>(bearer(tok)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    /**
     * Der Zaun: eine fremde Anlage ist 404 (nie 403), eine unbekannte Komponente
     * ebenso, ein unbekannter Zeitraum 400 - und ein Herzschlag ohne die beiden
     * Blöcke schreibt GAR NICHTS (eine ältere Edge verhält sich zeichengleich
     * wie vorher).
     */
    @Test
    void derVerlaufIstMandantengefencedUndEinAlterHerzschlagSchreibtNichts() {
        String tok = token("demo", "demo");
        assertThat(rest.exchange(url("/api/v1/sites/" + HAMBURG_SITE + "/command-history"),
                HttpMethod.GET, new HttpEntity<>(bearer(tok)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(rest.exchange(url("/api/v1/sites/" + BERLIN_SITE
                        + "/command-history?entity=" + java.util.UUID.randomUUID()),
                HttpMethod.GET, new HttpEntity<>(bearer(tok)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(rest.exchange(url("/api/v1/sites/" + BERLIN_SITE + "/command-history?range=jahr"),
                HttpMethod.GET, new HttpEntity<>(bearer(tok)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(rest.exchange(url("/api/v1/sites/" + BERLIN_SITE + "/command-history"),
                HttpMethod.GET, HttpEntity.EMPTY, String.class).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);

        // Ein Herzschlag ohne `control`/`curtailment`/`consumers`: nichts.
        byte[] bare = ("{\"tenant_id\":\"" + TENANT_A + "\",\"site_id\":\"" + BERLIN_SITE
                + "\",\"device_id\":\"" + DEVICE + "\",\"uptime_seconds\":1}")
                .getBytes(StandardCharsets.UTF_8);
        controlListener().handle(TOPIC, bare);
        curtailListener().handle(TOPIC, bare);
        asTenantA(() -> assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM device_command_log", Integer.class)).isZero());
        // Und damit ist auch der Aufzeichnungs-Beginn ehrlich: es wurde nie
        // hingesehen, also wird nichts behauptet.
        Map<String, Object> body = read(null, null);
        assertThat(body.get("recordingSince")).isNull();
        assertThat(entries(body)).isEmpty();
    }

    /**
     * DER GEMELDETE FALL (19.08.2026, Anlage Pilsting/Herzogau): der „Heute"-Tab
     * begann um 17:26 mit dem Slot „23:45-00:00", direkt gefolgt von
     * „00:00-00:15". Die 23:45-Zeile ist die LETZTE Viertelstunde des VORTAGS -
     * sie ragt nur um Sekunden über Mitternacht, weil der Plan-Sollwert um 00:00
     * wechselt und die Periode erst der NÄCHSTE Herzschlag schliesst.
     *
     * <p>Die Konvention (siehe {@link CommandLog#carryInAfter}): eine Zeile
     * gehört zum Tag ihres STARTS. Sie ist damit nicht verloren, sie steht im
     * Fenster des Vortags - und genau das prüft dieser Test in beide Richtungen.
     */
    @Test
    void derMitternachtsGrenzSlotGehoertZumVortagUndNichtInDenHeuteTab() {
        ControlStatusListener listener = controlListener();
        // 23:45:03 Berliner Zeit des 11.08. - die letzte Viertelstunde des Tages.
        // ⚠ Die Folge-Herzschläge sind PFLICHT und liegen bewusst unter
        // CommandLog.GAP_AFTER (5 min): ein Sprung von 23:45 auf 00:00 wäre eine
        // LÜCKE, die Periode würde schon um 23:45:03 geschlossen und überquerte
        // Mitternacht nie - der Test wäre dann aus dem FALSCHEN Grund grün.
        listener.handle(TOPIC, control("2026-08-11T21:45:03Z", -3.7, true, true, true, "plan",
                -3.7, "[]"));
        for (String weiter : List.of("2026-08-11T21:49:03Z", "2026-08-11T21:53:03Z",
                "2026-08-11T21:57:03Z")) {
            listener.handle(TOPIC, control(weiter, -3.7, true, true, true, "plan", -3.7, "[]"));
        }
        // 00:00:07 Berliner Zeit des 12.08.: neuer Plan-Sollwert. Die Periode des
        // Vortags wird HIER geschlossen - sieben Sekunden nach Mitternacht.
        listener.handle(TOPIC, control("2026-08-11T22:00:07Z", 1.0, true, true, true, "plan",
                1.0, "[]"));
        listener.handle(TOPIC, control("2026-08-11T22:03:07Z", 2.0, true, true, true, "plan",
                2.0, "[]"));

        // Der Grenz-Slot muss WIRKLICH über Mitternacht ragen, sonst prüft der
        // Rest nichts: er beginnt am 11.08. und endet nach 22:00:00Z.
        List<Map<String, Object>> gestern = entries(read(null, "2026-08-11"));
        assertThat(gestern).hasSize(1);
        assertThat(gestern.get(0).get("startedAt")).asString().startsWith("2026-08-11T21:45:03");
        assertThat(gestern.get(0).get("endedAt")).asString().startsWith("2026-08-11T22:00:07");

        // Und der Tag beginnt trotzdem mit SEINEM ersten Slot, nicht mit dem des
        // Vortags - und ohne eine Lücken-Zeile, die es hier nicht gibt.
        List<Map<String, Object>> heute = entries(read(null, "2026-08-12"));
        assertThat(heute).hasSize(2);
        assertThat(heute.get(0).get("startedAt")).asString().startsWith("2026-08-11T22:00:07");
        assertThat(heute.get(1).get("startedAt")).asString().startsWith("2026-08-11T22:03:07");
        assertThat(heute).noneMatch(e -> String.valueOf(e.get("startedAt"))
                .startsWith("2026-08-11T21:45:03"));
        assertThat(heute).allMatch(e -> CommandLog.KIND_PERIODE.equals(e.get("kind")));
    }

    /**
     * Die andere Hälfte derselben Konvention: eine Anweisung, die WIRKLICH in
     * den Tag hineinreicht, muss sichtbar bleiben - sonst begänne der Film mit
     * einem unerklärten Loch, und ein Tag ohne einen einzigen Wechsel behauptete
     * „es wurde nichts geschickt".
     *
     * <p>Gesät wird hier direkt, weil je Gerät und Strom nur EINE Periode offen
     * sein darf - die vier Randfälle sind über Herzschläge nicht in einem Zug
     * herstellbar. Geprüft wird der LESEPFAD, und dort liegt der Fix.
     */
    @Test
    void eineDurchlaufendeUndEineLaufendeAnweisungBleibenImFenster() {
        // Fenster des 12.08.: [2026-08-11T22:00:00Z, 2026-08-12T22:00:00Z)
        asTenantA(() -> {
            // (a) begann gestern 22:00, endete heute 06:00 - stundenlang in Kraft.
            seedPeriod("2026-08-11T20:00:00Z", "2026-08-12T04:00:00Z", -1.0);
            // (b) endete GENAU auf der Fenstergrenze - ein halb-offenes Fenster
            //     hat dort kein Element (der Off-by-one der alten Abfrage).
            seedPeriod("2026-08-11T18:00:00Z", "2026-08-11T22:00:00Z", -2.0);
            // (c) der Mitternachts-Grenzslot: sieben Sekunden Überlappung.
            seedPeriod("2026-08-11T21:50:00Z", "2026-08-11T22:00:07Z", -3.0);
            // (d) läuft noch - sie beschreibt die Gegenwart, egal wann sie begann.
            seedPeriod("2026-08-11T21:59:00Z", null, -4.0);
        });

        List<Double> gezeigt = entries(read(null, "2026-08-12")).stream()
                .map(e -> (Double) e.get("commandedKwFirst")).toList();

        assertThat(gezeigt).containsExactlyInAnyOrder(-1.0, -4.0);
    }

    /**
     * Die zweite Vermutung des Berichts - eine Zwei-Stunden-Verschiebung an der
     * Ingest-Naht - ist damit ausgeschlossen: ein Herzschlag, der seinen
     * Zeitstempel MIT Zonen-Versatz meldet, kommt als derselbe Zeitpunkt zurück.
     * Die Spalten sind {@code TIMESTAMPTZ}, der Weg ist zonenrein.
     */
    @Test
    void derZeitstempelReistUnverschobenDurchIngestSpeicherUndAntwort() {
        // 10:30 Berliner Sommerzeit = 08:30 UTC.
        controlListener().handle(TOPIC, control("2026-08-12T10:30:00+02:00", -5.0, true, true,
                true, "plan", -5.0, "[]"));

        List<Map<String, Object>> heute = entries(read(null, "2026-08-12"));
        assertThat(heute).hasSize(1);
        assertThat(heute.get(0).get("startedAt")).asString().startsWith("2026-08-12T08:30:00");
    }

    // -- Hilfen ---------------------------------------------------------------

    /**
     * Eine Halteperiode direkt setzen (Mandanten-Kontext ist Pflicht - ohne
     * {@code app.tenant_id} verweigert die RLS-Policy das INSERT).
     */
    private void seedPeriod(String startedAt, String endedAt, double commandedKw) {
        jdbc.update("INSERT INTO device_command_log (tenant_id, site_id, device_id, stream, kind, "
                + "started_at, ended_at, last_seen_at, mode, commanded_kw_first, source) VALUES ("
                + "NULLIF(current_setting('app.tenant_id', true), '')::uuid, ?::uuid, ?::uuid, '"
                + CommandLog.STREAM_BATTERIE + "', '" + CommandLog.KIND_PERIODE + "', "
                + "?::timestamptz, ?::timestamptz, ?::timestamptz, 'plan', ?, '"
                + CommandLog.SOURCE_CLOUD + "')",
                BERLIN_SITE, DEVICE, startedAt, endedAt,
                endedAt == null ? startedAt : endedAt, commandedKw);
    }


    private ControlStatusListener controlListener() {
        return new ControlStatusListener("tcp://localhost:1883", "", "", deviceRepo,
                controlStatusRepo, commandLog);
    }

    private CurtailmentStatusListener curtailListener() {
        return new CurtailmentStatusListener("tcp://localhost:1883", "", "", deviceRepo,
                curtailmentStatusRepo, commandLog);
    }

    private ConsumerRuntimeStatusListener consumerListener() {
        return new ConsumerRuntimeStatusListener("tcp://localhost:1883", "", "", deviceRepo,
                consumerStatusRepo, ledgerWriter, ruleEventWriter, commandLog);
    }

    private static byte[] control(String checkedAt, double commandedKw, boolean allMatch,
            boolean controlEnabled, boolean certified, String mode, double plannedKw,
            String mismatchRoles) {
        return ("{\"tenant_id\":\"" + TENANT_A + "\",\"site_id\":\"" + BERLIN_SITE
                + "\",\"device_id\":\"" + DEVICE + "\",\"control_source\":\"schedule\","
                + "\"control\":{\"commanded_kw\":" + commandedKw + ",\"confirmed_kw\":"
                + commandedKw + ",\"all_match\":" + allMatch + ",\"control_enabled\":"
                + controlEnabled + ",\"certified\":" + certified + ",\"mismatch_roles\":"
                + mismatchRoles + ",\"control_path\":\"remote\",\"checked_at\":\"" + checkedAt
                + "\",\"execution\":{\"mode\":\"" + mode + "\",\"planned_kw\":" + plannedKw
                + "}}}").getBytes(StandardCharsets.UTF_8);
    }

    private static byte[] curtail(String checkedAt, int units, int certified, boolean active,
            Double capKw, Boolean allMatch) {
        return ("{\"tenant_id\":\"" + TENANT_A + "\",\"site_id\":\"" + BERLIN_SITE
                + "\",\"device_id\":\"" + DEVICE + "\",\"curtailment\":{\"units\":" + units
                + ",\"certified_units\":" + certified + ",\"control_enabled\":true,\"active\":"
                + active + (capKw == null ? "" : ",\"applied_cap_kw\":" + capKw)
                + (allMatch == null ? "" : ",\"all_match\":" + allMatch)
                + ",\"checked_at\":\"" + checkedAt + "\"}}").getBytes(StandardCharsets.UTF_8);
    }

    private static byte[] consumers(String ts, String entityId, String state, String confirmed) {
        return ("{\"tenant_id\":\"" + TENANT_A + "\",\"site_id\":\"" + BERLIN_SITE
                + "\",\"device_id\":\"" + DEVICE + "\",\"ts\":\"" + ts + "\",\"consumers\":{\""
                + entityId + "\":{\"state\":\"" + state + "\",\"confirmed\":" + confirmed
                + ",\"actual_kw\":3.0}}}").getBytes(StandardCharsets.UTF_8);
    }

    /** Der Verlauf, auf EIN Gerät eingegrenzt (der neue `?device=`-Filter). */
    private Map<String, Object> readDevice(String device) {
        String path = "/api/v1/sites/" + BERLIN_SITE + "/command-history?range=day&at=2026-08-16"
                + "&device=" + device;
        ResponseEntity<Map<String, Object>> res = rest.exchange(url(path), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    /** Die Ströme einer Antwort, ohne Doppel - die Frage ist „welche kommen vor". */
    private static List<String> streams(Map<String, Object> body) {
        return entries(body).stream().map(e -> (String) e.get("stream")).distinct().sorted()
                .toList();
    }

    private Map<String, Object> read(String entityId, String at) {
        String path = "/api/v1/sites/" + BERLIN_SITE + "/command-history?range=day"
                + (entityId == null ? "" : "&entity=" + entityId)
                + (at == null ? "" : "&at=" + at);
        ResponseEntity<Map<String, Object>> res = rest.exchange(url(path), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> entries(Map<String, Object> body) {
        return (List<Map<String, Object>>) body.get("entries");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> detail(Map<String, Object> entry) {
        Map<String, Object> d = (Map<String, Object>) entry.get("detail");
        assertThat(d).as("Roh-Blick").isNotNull();
        return d;
    }

    private ResponseEntity<Map<String, Object>> exchange(HttpMethod method, String path,
            String token, Object body) {
        return rest.exchange(url(path), method, new HttpEntity<>(body, bearer(token)),
                new ParameterizedTypeReference<>() {});
    }

    private String url(String path) {
        return "http://localhost:" + port + path;
    }

    private static HttpHeaders bearer(String token) {
        HttpHeaders h = new HttpHeaders();
        h.setBearerAuth(token);
        h.setContentType(MediaType.APPLICATION_JSON);
        return h;
    }

    private String token(String username, String password) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "password");
        form.add("client_id", "voltpilot-api");
        form.add("client_secret", "voltpilot-api-dev-secret");
        form.add("username", username);
        form.add("password", password);
        form.add("scope", "openid");
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        @SuppressWarnings("unchecked")
        Map<String, Object> body = new TestRestTemplate().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).as("token response").containsKey("access_token");
        return (String) body.get("access_token");
    }
}
