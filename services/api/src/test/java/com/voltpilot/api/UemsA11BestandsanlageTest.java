package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.FunktionZustandAbleitung;
import com.voltpilot.api.uems.FunktionZustandAbleitung.BestandEingang;
import com.voltpilot.api.uems.FunktionZustandAbleitung.BestandErgebnis;
import com.voltpilot.api.uems.FunktionZustandAbleitung.Zustand;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * <b>A11 — „Bestandsanlage mit Betriebsmodell an → aktiv, kein Kommando durch den Umstieg"</b>
 * (UEMS AP-01 §7, Paket IP-14) gegen die Demo-Daten des Referenzunternehmens
 * {@code infra/local/seed/ahrenberg.sql}.
 *
 * <p>Der Fall hat ZWEI Hälften, und beide stehen hier:
 *
 * <ol>
 *   <li><b>abgeleitet.</b> AN-1 „Werk Ahrenberg – Halle 1" ist die einzige Bestandsanlage der
 *       Referenz mit laufender Betriebsweise (Betriebsmodell Lastspitzenkappung seit
 *       02.05.2024). Die Vertragsregel {@link FunktionZustandAbleitung#bestand} macht daraus
 *       eine AKTIVE, übernommene Teilnahme seit genau diesem Tag — und der Seed trägt genau
 *       das. AN-2 und AN-3 tragen kein Betriebsmodell: keine Teilnahme, kein Objekt. Der
 *       Standort ST-1 nimmt den höchsten Zustand seiner Anlagen an, ST-2 bleibt ohne Zeile.
 *       „Messen &amp; Auswerten" bekommt beim Umstieg kein Objekt.</li>
 *   <li><b>nichts geschaltet.</b> Der Umstieg ist LESEND. Der Seed schreibt in keine Tabelle,
 *       die ein Kommando, einen Fahrplan, einen Ruhe-Eintrag oder eine Betriebsweise trägt —
 *       {@code site_profile_state}, {@code device_override}, {@code consumer_override},
 *       {@code schedule}, {@code device_command_log} und ihre Geschwister bleiben für diesen
 *       Kundenbereich leer. Ein zweiter Lauf ändert daran nichts.</li>
 * </ol>
 *
 * <p>Geprüft wird gegen eine WEGWERF-Datenbank (Testcontainers), nie gegen den lokalen Stack.
 * Auto-skips ohne Docker ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsA11BestandsanlageTest {

    private static final String TENANT = "20000000-0000-0000-0000-000000000001";
    private static final Path SEED = Path.of("..", "..", "infra", "local", "seed", "ahrenberg.sql");
    private static final Path REFERENZ =
            Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");

    /** Die Tabellen, in denen ein Kommando, ein Fahrplan oder eine Betriebsweise landet. */
    private static final List<String> KOMMANDO_TABELLEN = List.of(
            "site_profile_state", "device_override", "consumer_override", "consumer_profile",
            "schedule", "device_command_log", "device_command_recording", "site_plan_run",
            "entity_plan_slot");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @BeforeAll
    static void migrierenUndSaeen() throws Exception {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration", "classpath:db/dev")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(java.util.Map.of(
                        "appDbUser", "voltpilot_app", "appDbPassword", "voltpilot_app_test_pw",
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "voltpilot_admin_test_pw"))
                .load().migrate();
        String seed = Files.readString(SEED);
        try (Connection c = POSTGRES.createConnection("");
                Statement s = c.createStatement()) {
            s.execute(seed);
            // Zweimal: der Umstieg ist idempotent, und auch der zweite Lauf schaltet nichts.
            s.execute(seed);
        }
    }

    @Test
    void bestandsanlageMitBetriebsmodellAnIstAktivUndUebernommen() throws Exception {
        JsonNode an1 = anlage("AN-1");
        assertThat(an1.path("betriebsmodell").asText()).isEqualTo("Lastspitzenkappung");

        // Die Vertragsregel auf die Bestandsfakten der Referenz - das SOLL dieses Falls.
        Instant seit = OffsetDateTime.parse(an1.path("betriebsmodell_seit").asText()).toInstant();
        BestandErgebnis soll = FunktionZustandAbleitung.bestand(new BestandEingang(
                an1.path("name").asText(), true, seit, false, null, false, null, true), BERLIN);
        assertThat(soll.zustand()).isEqualTo(Zustand.AKTIV);
        assertThat(soll.text()).isEqualTo("Gestartet am 02.05.2024 (übernommen)");

        // Und das IST, was im Seed steht.
        assertThat(texte("SELECT t.zustand || '|' || t.uebernommen"
                + " FROM funktion_teilnahme t JOIN site s ON s.id = t.site_id"
                + " WHERE t.tenant_id = '" + TENANT + "' AND s.name = '" + an1.path("name").asText() + "'"))
                .containsExactly(soll.zustand().code() + "|true");
        assertThat(text("SELECT to_char(t.gestartet_am AT TIME ZONE 'Europe/Berlin', 'DD.MM.YYYY')"
                + " FROM funktion_teilnahme t WHERE t.tenant_id = '" + TENANT + "'"))
                .isEqualTo("02.05.2024");
        assertThat(text("SELECT to_char(f.aktiv_seit AT TIME ZONE 'Europe/Berlin', 'DD.MM.YYYY')"
                + " FROM funktion f WHERE f.tenant_id = '" + TENANT + "' AND f.funktion = 'steuern'"))
                .isEqualTo("02.05.2024");
        assertThat(text("SELECT geaendert_von FROM funktion WHERE tenant_id = '" + TENANT + "'"))
                .isEqualTo("VoltPilot (Bestandsübernahme)");
    }

    @Test
    void ohneBetriebsmodellKeineTeilnahmeUndKeinObjekt() throws Exception {
        for (String kennzeichen : List.of("AN-2", "AN-3")) {
            JsonNode a = anlage(kennzeichen);
            assertThat(a.path("betriebsmodell").isNull()).as(kennzeichen + " ohne Betriebsmodell").isTrue();
            assertThat(FunktionZustandAbleitung.bestand(new BestandEingang(
                    a.path("name").asText(), false, null, false, null, false, null, false), BERLIN).zustand())
                    .as(kennzeichen)
                    .isEqualTo(Zustand.KEIN_OBJEKT);
            assertThat(count("SELECT count(*) FROM funktion_teilnahme t JOIN site s ON s.id = t.site_id"
                    + " WHERE t.tenant_id = '" + TENANT + "' AND s.name = '" + a.path("name").asText() + "'"))
                    .as("keine Teilnahme " + kennzeichen).isZero();
        }
        // Kein Objekt ist keine Zeile: Werk Lindach hat gar keine Funktion, ...
        assertThat(count("SELECT count(*) FROM funktion f JOIN standort s ON s.id = f.standort_id"
                + " WHERE f.tenant_id = '" + TENANT + "' AND s.kurzzeichen = 'ST-2'")).isZero();
        // ... und „Messen & Auswerten" bekommt beim Umstieg nirgends eines.
        assertThat(count("SELECT count(*) FROM funktion WHERE tenant_id = '" + TENANT
                + "' AND funktion = 'messen'")).isZero();
    }

    /**
     * Die zweite Hälfte von A11: der Umstieg ist lesend. Keine Tabelle, die eine Betriebsweise,
     * einen Fahrplan oder ein Kommando trägt, bekommt durch den Seed eine Zeile.
     */
    @Test
    void keinKommandoDurchDenUmstieg() throws Exception {
        for (String tabelle : KOMMANDO_TABELLEN) {
            // Manche dieser Tabellen tragen den Kundenbereich selbst, andere hängen an der
            // Anlage - gefragt wird, was die Tabelle wirklich hat, nicht was sie haben sollte.
            boolean eigeneSpalte = count("SELECT count(*) FROM information_schema.columns"
                    + " WHERE table_name = '" + tabelle + "' AND column_name = 'tenant_id'") > 0;
            String sql = eigeneSpalte
                    ? "SELECT count(*) FROM " + tabelle + " WHERE tenant_id = '" + TENANT + "'"
                    : "SELECT count(*) FROM " + tabelle + " x JOIN site s ON s.id = x.site_id"
                            + " WHERE s.tenant_id = '" + TENANT + "'";
            assertThat(count(sql)).as("kein Kommando in " + tabelle).isZero();
        }
    }

    // -------------------------------------------------------------------------

    private static JsonNode anlage(String kennzeichen) throws Exception {
        JsonNode ref = new ObjectMapper().readTree(REFERENZ.toFile());
        for (JsonNode a : ref.path("anlagen")) {
            if (kennzeichen.equals(a.path("kennzeichen").asText())) {
                return a;
            }
        }
        throw new AssertionError(kennzeichen + " fehlt in der Referenz");
    }

    private static List<String> texte(String sql) throws Exception {
        List<String> werte = new ArrayList<>();
        try (Connection c = POSTGRES.createConnection("");
                Statement s = c.createStatement();
                ResultSet rs = s.executeQuery(sql)) {
            while (rs.next()) {
                werte.add(rs.getString(1));
            }
        }
        return werte;
    }

    private static String text(String sql) throws Exception {
        List<String> werte = texte(sql);
        assertThat(werte).as(sql).hasSize(1);
        return werte.get(0);
    }

    private static long count(String sql) throws Exception {
        try (Connection c = POSTGRES.createConnection("");
                Statement s = c.createStatement();
                ResultSet rs = s.executeQuery(sql)) {
            rs.next();
            return rs.getLong(1);
        }
    }
}
