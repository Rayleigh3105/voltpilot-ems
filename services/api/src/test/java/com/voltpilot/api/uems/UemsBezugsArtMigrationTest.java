package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Path;
import java.util.Map;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

@Testcontainers(disabledWithoutDocker = true)
class UemsBezugsArtMigrationTest {
    @Container
    static final PostgreSQLContainer<?> DB = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"));
    static JdbcTemplate db;
    static UUID tenant, unternehmen, eindeutig, mehrdeutig;
    static JsonNode vertrag;

    @BeforeAll
    static void migrieren() throws Exception {
        vertrag = new ObjectMapper().readTree(Path.of("../../docs/contracts/v2/bezugsdaten-vectors.json").toFile());
        db = new JdbcTemplate(new DriverManagerDataSource(DB.getJdbcUrl(), DB.getUsername(), DB.getPassword()));
        String vorher = java.util.Arrays.stream(flyway().load().info().all())
                .map(org.flywaydb.core.api.MigrationInfo::getVersion)
                .filter(v -> v != null && v.compareTo(org.flywaydb.core.api.MigrationVersion.fromVersion("20260918110000")) < 0)
                .max(java.util.Comparator.naturalOrder()).orElseThrow().getVersion();
        flyway().target(vorher).load().migrate();
        tenant = db.queryForObject("INSERT INTO tenant(name) VALUES ('Art-Migration') RETURNING id", UUID.class);
        unternehmen = db.queryForObject("INSERT INTO unternehmen(tenant_id,name,zeitzone) VALUES (?, 'Ahrenberg', 'Europe/Berlin') RETURNING id", UUID.class, tenant);
        eindeutig = alt("BZ-01", "stammdatum", "Personen", null);
        mehrdeutig = alt("BZ-02", "periodenwert", "Stück", "monat");
        db.update("INSERT INTO bezugsgroesse_stammdatum(tenant_id,bezugsgroesse_id,wertart,einheit,wert,gueltig_ab,created_by) VALUES (?,?,'stammdatum','Personen',180,'2026-01-01','test')", tenant, eindeutig);
        flyway().load().migrate();
    }

    @Test
    void katalogIstVollstaendigDerVertragUndJedeArtIstPruefbar() throws Exception {
        ObjectNode erwartet = vertrag.path("arten").path("je_art").deepCopy();
        erwartet.elements().forEachRemaining(a -> ((ObjectNode) a).remove("konzept"));
        assertThat(new ObjectMapper().readTree(db.queryForObject("SELECT bezugsarten()::text", String.class))).isEqualTo(erwartet);
        for (var it = erwartet.fields(); it.hasNext();) {
            var a = it.next();
            JsonNode art = a.getValue();
            String einheit = art.path("einheiten").isArray() ? art.path("einheiten").get(0).asText() : "m³";
            String geltung = art.path("geltung").isArray() ? art.path("geltung").get(0).asText() : "unternehmen";
            String periode = art.path("perioden").isEmpty() ? null : art.path("perioden").get(0).asText();
            assertThat(db.queryForObject("SELECT bezugsart_passt(?,?,?,?,?)", Boolean.class,
                    a.getKey(), art.path("wertart").asText(), einheit, periode, geltung)).as(a.getKey()).isTrue();
        }
        assertThat(db.queryForObject("SELECT bezugsart_passt('gutteile','periodenwert','kg','monat','prozess')", Boolean.class)).isFalse();
        assertThat(db.queryForObject("SELECT bezugsart_passt('unbekannt','periodenwert','kg','monat','prozess')", Boolean.class)).isFalse();
    }

    @Test
    void nachtragIstEindeutigIdempotentUndAendertKeinenWert() {
        assertThat(db.queryForObject("SELECT art FROM bezugsgroesse WHERE id=?", String.class, eindeutig)).isEqualTo("mitarbeitende");
        assertThat(db.queryForObject("SELECT art FROM bezugsgroesse WHERE id=?", String.class, mehrdeutig)).isNull();
        assertThat(db.queryForObject("SELECT wert::text FROM bezugsgroesse_stammdatum WHERE bezugsgroesse_id=?", String.class, eindeutig)).isEqualTo("180.000000");
        assertThat(db.update("UPDATE bezugsgroesse SET art=bezugsart_eindeutig(wertart,einheit,periode_art,geltung_art) WHERE art IS NULL AND bezugsart_eindeutig(wertart,einheit,periode_art,geltung_art) IS NOT NULL")).isZero();
        var spalte = db.queryForMap("SELECT is_nullable,column_default FROM information_schema.columns WHERE table_name='bezugsgroesse' AND column_name='art'");
        assertThat(spalte.get("is_nullable")).isEqualTo("YES");
        assertThat(spalte.get("column_default")).isNull();
        assertThat(db.queryForObject("SELECT has_column_privilege('voltpilot_app','bezugsgroesse','art','UPDATE')", Boolean.class)).isTrue();
        assertThatThrownBy(() -> db.update("UPDATE bezugsgroesse SET art=null WHERE id=?", eindeutig)).hasMessageContaining("hat Werte und ist nicht mehr änderbar");
        assertThatThrownBy(() -> db.update("UPDATE bezugsgroesse SET art='betriebszeit' WHERE id=?", mehrdeutig)).hasMessageContaining("bezugsgroesse_art_chk");
    }

    @Test
    void referenzunternehmenHatSechsUngeklaerteReihenUndEineGeleseneFlaeche() throws Exception {
        JsonNode ref = new ObjectMapper().readTree(Path.of("../../docs/contracts/v2/uems-referenzunternehmen.json").toFile());
        int offen = 0, flaechen = 0;
        for (JsonNode b : ref.path("bezugsgroessen")) {
            if (b.path("einheit_code").asText().equals("m²")) { flaechen++; continue; }
            String p = b.path("periode_code").isNull() ? null : b.path("periode_code").asText();
            String a = db.queryForObject("SELECT bezugsart_eindeutig(?,?,?,?)", String.class,
                    b.path("wertart").asText(), b.path("einheit_code").asText(), p, b.path("geltung_art").asText());
            if (a == null) offen++;
        }
        assertThat(offen).isEqualTo(6);
        assertThat(flaechen).isEqualTo(1);
    }

    private static UUID alt(String kennzeichen, String wertart, String einheit, String periode) {
        return db.queryForObject("INSERT INTO bezugsgroesse(tenant_id,kennzeichen,name,wertart,einheit,periode_art,geltung_art,unternehmen_id) VALUES (?,?,?, ?,?,?,'unternehmen',?) RETURNING id",
                UUID.class, tenant, kennzeichen, kennzeichen, wertart, einheit, periode, unternehmen);
    }
    private static FluentConfiguration flyway() {
        return Flyway.configure().dataSource(DB.getJdbcUrl(), DB.getUsername(), DB.getPassword())
                .locations("classpath:db/migration").baselineOnMigrate(true).baselineVersion("0")
                .placeholders(Map.of("appDbUser", "voltpilot_app", "appDbPassword", "app-test",
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "admin-test"));
    }
}
