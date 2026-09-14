package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import com.voltpilot.api.web.BezugsdatenImportController;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.context.PropertyPlaceholderAutoConfiguration;
import org.springframework.boot.convert.ApplicationConversionService;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.util.unit.DataSize;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.yaml.snakeyaml.Yaml;

/**
 * Die Spring-Verdrahtung der Import-Vorschau (UEMS AP-09 IP-12) — der Teil, den der Testcontainers-Lauf nie anfasst:
 * der tägliche Takt der Zeilentext-Aufbewahrung (Vorgabe AN in {@code application.yml}, AUS im Testlauf) und die
 * Upload-Grenze, die MockMvc nicht durchsetzt (sie ist dieselbe Zahl wie {@link CsvLeser#BYTES_HOECHSTENS}, und
 * darüber antwortet die Route mit dem Befund des Lesers).
 */
class ZeilentextAufbewahrungWiringTest {

    private static final String SCHALTER = "voltpilot.uems.zeilentexte.enabled";

    @Configuration(proxyBeanMethods = false)
    static class Nachbarn {

        @Bean("adminJdbcTemplate")
        JdbcTemplate adminJdbcTemplate() {
            return mock(JdbcTemplate.class);
        }
    }

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withInitializer(ctx -> ctx.getBeanFactory().setConversionService(ApplicationConversionService.getSharedInstance()))
            .withConfiguration(AutoConfigurations.of(PropertyPlaceholderAutoConfiguration.class))
            .withUserConfiguration(Nachbarn.class, ZeilentextAufbewahrung.class, ZeilentextAufbewahrungLaeufer.class,
                    ZeilentextAufbewahrungSchedulingConfig.class);

    @Test
    void derTaktVerdrahtetSichMitDerAufbewahrung() {
        runner.withPropertyValues(SCHALTER + "=true").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).hasSingleBean(ZeilentextAufbewahrungLaeufer.class);
            assertThat(context).hasSingleBean(ZeilentextAufbewahrungSchedulingConfig.class);
        });
    }

    /** Der Not-Aus nimmt den Takt UND seinen Thread-Pool — nie die Aufbewahrung selbst. */
    @Test
    void derNotAusNimmtDenTaktNieDieAufbewahrung() {
        runner.withPropertyValues(SCHALTER + "=false").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).doesNotHaveBean(ZeilentextAufbewahrungLaeufer.class);
            assertThat(context).doesNotHaveBean(ZeilentextAufbewahrungSchedulingConfig.class);
            assertThat(context).hasSingleBean(ZeilentextAufbewahrung.class);
        });
    }

    @Test
    @SuppressWarnings("unchecked")
    void dieAusgelieferteVorgabeIstAnUndDerTestlaufSchaltetSieAus() throws Exception {
        Map<String, Object> yml = yml();
        Map<String, Object> z = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) yml.get("voltpilot"))
                .get("uems")).get("zeilentexte");
        assertThat(z.get("enabled")).isEqualTo("${VOLTPILOT_UEMS_ZEILENTEXTE_ENABLED:true}");
        assertThat(Files.readString(Path.of("pom.xml"))).contains("<" + SCHALTER + ">false</" + SCHALTER + ">");
    }

    /** E14/C1: die Multipart-Grenze IST die Grenze des Lesers — 5MB bei Spring sind 5 242 880 Bytes. */
    @Test
    @SuppressWarnings("unchecked")
    void dieUploadGrenzeIstDieDesLesers() throws Exception {
        Map<String, Object> multipart = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) yml()
                .get("spring")).get("servlet")).get("multipart");
        assertThat(DataSize.parse(String.valueOf(multipart.get("max-file-size"))).toBytes()).isEqualTo(CsvLeser.BYTES_HOECHSTENS);
        assertThat(DataSize.parse(String.valueOf(multipart.get("max-request-size"))).toBytes())
                .as("Platz für die Zuordnung").isGreaterThan(CsvLeser.BYTES_HOECHSTENS);
        assertThat(multipart.get("resolve-lazily")).as("erst die Route liest — so antwortet sie selbst").isEqualTo(true);
    }

    @Test
    void ueberDerGrenzeAntwortetDieRouteMitDemBefundDesLesers() {
        BezugsdatenImportController c = new BezugsdatenImportController(mock(ImportVorschauService.class),
                new com.fasterxml.jackson.databind.ObjectMapper());
        ResponseEntity<Map<String, Object>> r = c.zuGross(new MaxUploadSizeExceededException(CsvLeser.BYTES_HOECHSTENS));
        assertThat(r.getStatusCode().value()).isEqualTo(413);
        assertThat(r.getBody()).containsEntry("code", "datei_zu_gross").containsEntry("message", "Die Datei ist zu groß.");
        assertThat((Map<String, Object>) r.getBody().get("datei")).containsEntry("zusatz", "zu_viele_bytes");
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> yml() throws Exception {
        try (InputStream in = getClass().getResourceAsStream("/application.yml")) {
            assertThat(in).as("application.yml auf dem Klassenpfad").isNotNull();
            return (Map<String, Object>) new Yaml().loadAll(in).iterator().next();
        }
    }
}
