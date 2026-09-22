package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.QuelleEinstellungRegeln.Abgeleitet;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Supplier;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.postgresql.util.PSQLException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Migration {@code V20260911280000} (UEMS AP-04 IP-11) gegen eine echte TimescaleDB: die
 * Einstellungs-Fassungen je Quelle, die neue Art {@code einstellung_geaendert} im Protokoll der
 * Messstelle und die Fassung 1 für den Bestand.
 *
 * <p>Der Prüfnachweis: je Bestands-Komponente genau die Fassungen, die ihre heutige Verbindung
 * trägt — nach der Regel des Vertrags, die der Java-Zwilling {@link QuelleEinstellungRegeln}
 * ebenso rechnet (und die SQL-Seite fährt jeden Vektor-Fall der Familien {@code verbindung} und
 * {@code wert}); „gilt seit Beginn" der Speisung; ein erneuter Lauf legt nichts an; KEIN
 * gespeicherter Wert ändert sich (Komponenten, Fassungen, Messreihen, Geräte zeichengleich); der
 * Zaun steht; eine Fassung wird nur verkürzt, nie verlängert oder umgeschrieben; die App-Rolle löscht
 * nie; das Offboarding räumt ab, das Löschen einer Anlage oder Komponente bleibt.
 *
 * <p>Ahrenberg (Referenzdatei) kommt mit K-1 und K-3 in den Bestand: ihre Verbindungen tragen heute
 * KEINE Einstellung — also bekommen sie keine Fassung (das Wandlerverhältnis von GR-2 trägt erst ein
 * Eintrag, A4). Die Fälle mit Einstellungen spielen in einem neutralen Probe-Kundenbereich.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsQuelleEinstellungMigrationTest {

    private static final String DIESE = "20260911280000";
    private static final String DATEI = "V20260911280000__uems_quelle_einstellung.sql";

    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    private static final List<String> TABELLEN = List.of("quelle_einstellung");
    /** Was die Migration nicht anfassen darf — sie schreibt nur daneben. */
    private static final List<String> BESTAND = List.of("measurement_point", "component_definition", "site",
            "device", "geraet", "geraet_komponente", "telemetry_v2_rollup_1d", "messstelle");

    private static final UUID AHRENBERG = UUID.fromString("4e0c0000-0000-0000-0000-000000000001");
    private static final UUID PROBE = UUID.fromString("4e0c0000-0000-0000-0000-000000000002");

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JsonNode referenz;
    private static JsonNode vektoren;
    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static JdbcTemplate admin;

    /** Name → Komponente (Zeilen-Kennung). */
    private static final Map<String, UUID> KOMPONENTEN = new LinkedHashMap<>();
    private static Map<String, Map<String, String>> bestandVorher;
    private static Map<String, Map<String, String>> bestandNachher;
    private static List<Map<String, Object>> fassungenNachDerMigration;

    @BeforeAll
    static void migriereMitBestand() throws IOException {
        referenz = MAPPER.readTree(V2.resolve("uems-referenzunternehmen.json").toFile());
        vektoren = MAPPER.readTree(V2.resolve("quelle-einstellung-vectors.json").toFile());
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));

        flyway().target(letzteFassungVorDieser()).load().migrate();
        saeBestand();
        bestandVorher = schnappschuesse();
        flyway().target(DIESE).load().migrate();
        bestandNachher = schnappschuesse();
        fassungenNachDerMigration = root.queryForList("SELECT q.*, q.wert::text AS wert_text FROM quelle_einstellung q "
                + "ORDER BY q.eingetragen_am, q.id");
        // Was nach dieser Fassung noch liegt, läuft auch — die Tests prüfen den Endstand.
        flyway().load().migrate();

        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ---- Die Fassung 1 -------------------------------------------------------------------

    /**
     * Je Komponente genau die Fassungen, die ihre heutige Verbindung trägt — Kanal, Art und Wert
     * wie {@link QuelleEinstellungRegeln#ausVerbindung}, am Einbau, der sie speist, ab dem Beginn
     * dieser Speisung, bis auf Weiteres, angewendet, aus dem Bestand, von VoltPilot, nie rückwirkend.
     */
    @Test
    void jedeKomponenteBekommtGenauDieFassungenIhrerHeutigenVerbindung() throws IOException {
        int erwartet = 0;
        for (Map.Entry<String, UUID> k : KOMPONENTEN.entrySet()) {
            Map<String, Object> mp = root.queryForMap("SELECT communication, connection_json::text AS c "
                    + "FROM measurement_point WHERE id = ?", k.getValue());
            List<Abgeleitet> soll = QuelleEinstellungRegeln.ausVerbindung((String) mp.get("communication"),
                    mp.get("c") == null ? null : MAPPER.readTree((String) mp.get("c")));
            // Je (Kanal, Art) genau eine Fassung 1 — die Reihenfolge der Zeilen sagt nichts (eine
            // Transaktion, ein Zeitstempel).
            Map<String, Map<String, Object>> ist = new LinkedHashMap<>();
            fassungenNachDerMigration.stream().filter(f -> k.getValue().equals(f.get("entity_id")))
                    .forEach(f -> assertThat(ist.put(f.get("kanal") + "|" + f.get("art"), f)).isNull());
            assertThat(ist).as(k.getKey()).hasSize(soll.size());
            Map<String, Object> speisung = root.queryForMap("SELECT geraet_id, gueltig_ab FROM geraet_komponente "
                    + "WHERE entity_id = ? AND gueltig_bis IS NULL", k.getValue());
            for (int i = 0; i < soll.size(); i++) {
                Map<String, Object> f = ist.get(soll.get(i).kanal() + "|" + soll.get(i).art());
                assertThat(f).as(k.getKey() + " " + soll.get(i).kanal() + " " + soll.get(i).art()).isNotNull();
                assertThat(QuelleEinstellungRegeln.gleicherWert(MAPPER.readTree((String) f.get("wert_text")),
                        soll.get(i).wert())).as(k.getKey() + " #" + i + " " + f.get("wert_text")).isTrue();
                assertThat(f.get("geraet_id")).isEqualTo(speisung.get("geraet_id"));
                assertThat(f.get("gueltig_ab")).isEqualTo(speisung.get("gueltig_ab"));
                assertThat(f.get("gueltig_bis")).isNull();
                assertThat(f.get("anwendung")).isEqualTo("angewendet");
                assertThat(f.get("herkunft")).isEqualTo("bestand");
                assertThat(f.get("rueckwirkend")).isEqualTo(false);
                assertThat(f.get("actor_sub")).isNull();
                assertThat(f.get("actor_art")).isEqualTo("voltpilot");
                assertThat(f.get("actor_name")).isEqualTo("VoltPilot");
                assertThat(f.get("tatsaechlich_ab")).isNull();
            }
            erwartet += soll.size();
        }
        assertThat(fassungenNachDerMigration).hasSize(erwartet);
        // Die Fälle sind da: Deye (×10 als Text, beide Vorzeichen), Deye automatisch, Fronius,
        // Selbstbau mit zwei Kanälen — und Ahrenberg ohne jede Einstellung.
        assertThat(erwartet).isEqualTo(3 + 1 + 1 + 4);
        assertThat(fassungenNachDerMigration).noneMatch(f -> AHRENBERG.equals(f.get("tenant_id")));
    }

    /** Die SQL-Seite rechnet jeden Fall der Familie {@code verbindung} wie der Vertrag. */
    @Test
    void dieSqlAbleitungFaehrtJedenVektorFall() {
        for (JsonNode c : vektoren.at("/cases/verbindung")) {
            JsonNode in = c.get("input");
            List<Map<String, Object>> ist = root.queryForList("SELECT kanal, art, wert::text AS wert FROM "
                    + "uems_einstellungen_aus_verbindung(?, ?::jsonb) ORDER BY reihe",
                    in.get("kommunikation").isNull() ? null : in.get("kommunikation").asText(),
                    in.get("verbindung").isNull() ? null : in.get("verbindung").toString());
            JsonNode soll = c.get("expected");
            assertThat(ist).as(c.get("name").asText()).hasSize(soll.size());
            for (int i = 0; i < ist.size(); i++) {
                assertThat(ist.get(i).get("kanal")).as(c.get("name").asText())
                        .isEqualTo(soll.get(i).get("kanal").isNull() ? null : soll.get(i).get("kanal").asText());
                assertThat(ist.get(i).get("art")).isEqualTo(soll.get(i).get("art").asText());
                assertThat(QuelleEinstellungRegeln.gleicherWert(lies((String) ist.get(i).get("wert")),
                        soll.get(i).get("wert"))).as(c.get("name").asText() + ": " + ist.get(i).get("wert")).isTrue();
            }
        }
    }

    /** Der CHECK der Tabelle urteilt über jeden Fall der Familie {@code wert} wie der Vertrag. */
    @Test
    void derWertCheckFaehrtJedenVektorFall() {
        for (JsonNode c : vektoren.at("/cases/wert")) {
            JsonNode in = c.get("input");
            assertThat(root.queryForObject("SELECT uems_einstellung_wert_gueltig(?, ?::jsonb)", Boolean.class,
                    in.get("art").asText(), in.get("wert").toString()))
                    .as(c.get("name").asText()).isEqualTo(c.at("/expected/gueltig").asBoolean());
        }
    }

    @Test
    void einErneuterLaufLegtNichtsAnUndAendertNichts() throws IOException {
        Map<String, String> vorher = schnappschuss("quelle_einstellung");
        assertThat(root.queryForObject("SELECT uems_einstellungen_ableiten()", Integer.class)).isZero();
        fuehreErneutAus(DATEI);
        assertThat(schnappschuss("quelle_einstellung")).isEqualTo(vorher);
    }

    /**
     * KEIN gespeicherter Wert ändert sich: Komponenten (mit ihren Verbindungen), ihre Fassungen, die
     * Messreihen, die Geräte und Messstellen sind nach der Migration zeichengleich.
     */
    @Test
    void dieBestandstabellenBleibenZeichengleich() {
        for (String t : BESTAND) {
            assertThat(bestandNachher.get(t)).as(t).isEqualTo(bestandVorher.get(t));
        }
        assertThat(bestandVorher.get("measurement_point").get("zeilen")).contains("power_scale");
        assertThat(bestandVorher.get("telemetry_v2_rollup_1d").get("zeilen")).isNotBlank();
    }

    /**
     * Die Regel je Komponente läuft unter der App-Rolle mit deren Zaun: die eigene Komponente
     * bekommt ihre Fassung 1, eine fremde ist unsichtbar (0), und die Schleife über alle Mandanten
     * darf die App-Rolle gar nicht rufen.
     */
    @Test
    void dieRegelJeKomponenteLaeuftUnterDemZaunDesAufrufers() {
        Werkstatt w = new Werkstatt("Werkstatt Regel");
        UUID k = w.komponente("battery-hybrid", "solarman_v5", "{\"ip\":\"10.0.0.2\",\"power_scale\":1}");
        assertThat(als(PROBE, () -> app.queryForObject("SELECT uems_einstellungen_ableiten_fuer(?)",
                Integer.class, k))).isZero();
        assertThat(als(w.tenant, () -> app.queryForObject("SELECT uems_einstellungen_ableiten_fuer(?)",
                Integer.class, k))).isOne();
        assertThat(als(w.tenant, () -> app.queryForObject("SELECT uems_einstellungen_ableiten_fuer(?)",
                Integer.class, k))).isZero();
        abgelehntWegen("42501", "permission denied", () -> alsTue(w.tenant,
                () -> app.queryForObject("SELECT uems_einstellungen_ableiten()", Integer.class)));
    }

    // ---- Der Zaun ------------------------------------------------------------------------

    @Test
    void derZaunStehtAufDerNeuenTabelle() {
        for (String t : TABELLEN) {
            assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                    + "WHERE relname = ?", Boolean.class, t)).as(t).isTrue();
            assertThat(anzahl("SELECT count(*) FROM pg_policies WHERE tablename = ?", t)).as(t).isOne();
            assertThat(app.queryForObject("SELECT count(*) FROM " + t, Long.class)).as(t).isZero();
        }
        assertThat(als(PROBE, () -> app.queryForObject("SELECT count(*) FROM quelle_einstellung", Long.class)))
                .isEqualTo(anzahl("SELECT count(*) FROM quelle_einstellung WHERE tenant_id = ?", PROBE));
        assertThat(als(AHRENBERG, () -> app.queryForObject("SELECT count(*) FROM quelle_einstellung "
                + "WHERE tenant_id <> ?", Long.class, AHRENBERG))).isZero();

        // Eine Fassung für einen fremden Kundenbereich schreibt die App-Rolle nicht …
        Map<String, Object> fremd = root.queryForMap("SELECT geraet_id, entity_id FROM quelle_einstellung "
                + "WHERE tenant_id = ? LIMIT 1", PROBE);
        abgelehntWegen("42501", "row-level security", () -> alsTue(AHRENBERG, () -> app.update(
                "INSERT INTO quelle_einstellung (tenant_id, geraet_id, art, wert, anwendung, herkunft, gueltig_ab, "
                        + "rueckwirkend, actor_sub, actor_name, actor_art) VALUES (?, ?, 'impulswertigkeit', "
                        + "'{\"impulse_je_kwh\":1000}', 'dokumentiert', 'eintrag', ?, false, 's', 'n', 'kunde')",
                PROBE, fremd.get("geraet_id"), ts("2027-01-01T00:00:00Z"))));
        // … und keine an einem fremden Gerät (der zusammengesetzte Fremdschlüssel).
        abgelehnt("23503", "quelle_einstellung_geraet_fk", () -> alsTue(AHRENBERG, () -> app.update(
                "INSERT INTO quelle_einstellung (tenant_id, geraet_id, art, wert, anwendung, herkunft, gueltig_ab, "
                        + "rueckwirkend, actor_sub, actor_name, actor_art) VALUES (?, ?, 'impulswertigkeit', "
                        + "'{\"impulse_je_kwh\":1000}', 'dokumentiert', 'eintrag', ?, false, 's', 'n', 'kunde')",
                AHRENBERG, fremd.get("geraet_id"), ts("2027-01-01T00:00:00Z"))));
    }

    // ---- Die Constraints -----------------------------------------------------------------

    /**
     * Die Datenbank hält die Zeitregeln fest, auch ohne die Schnittstelle: je Quelle und Art nie
     * zwei Fassungen zugleich (berühren ja), auf die Minute, nie leer, ein Kanal nur an einer
     * Komponente, die Form des Werts je Art, „rückwirkend" nie für die Zukunft, und der Bestand ist
     * immer VoltPilot.
     */
    @Test
    void dieChecksLehnenAbStattZuRunden() {
        Werkstatt w = new Werkstatt("Werkstatt Checks");
        UUID k = w.komponente("grid-meter", "modbus_tcp", "{\"ip\":\"10.0.0.3\",\"unit_id\":1}");
        UUID g = laufendesGeraet(k);
        w.fassung(g, null, null, "wandler_strom", "{\"primaer_a\":600,\"sekundaer_a\":5}", "2026-01-01T00:00:00Z",
                "2027-01-15T08:00:00Z");
        // Berühren ist erlaubt …
        w.fassung(g, null, null, "wandler_strom", "{\"primaer_a\":1000,\"sekundaer_a\":5}", "2027-01-15T08:00:00Z",
                null);
        // … überschneiden nie, auch nicht um eine Minute.
        abgelehnt("23P01", "quelle_einstellung_eine_je_zeitpunkt", () -> w.fassung(g, null, null, "wandler_strom",
                "{\"primaer_a\":800,\"sekundaer_a\":5}", "2027-01-15T07:59:00Z", "2027-01-15T08:01:00Z"));
        // Eine andere Art an derselben Quelle, dieselbe Art an einer Komponente: eigene Quellen.
        w.fassung(g, null, null, "impulswertigkeit", "{\"impulse_je_kwh\":1000}", "2027-01-15T08:00:00Z", null);
        w.fassung(g, k, null, "wandler_strom", "{\"primaer_a\":250,\"sekundaer_a\":5}", "2027-01-15T08:00:00Z", null);
        w.fassung(g, k, "power_kw", "wandler_strom", "{\"primaer_a\":250,\"sekundaer_a\":5}", "2027-01-15T08:00:00Z",
                null);

        abgelehnt("23514", "quelle_einstellung_volle_minute", () -> w.fassung(g, null, null, "offset",
                "{\"wert\":1,\"einheit\":\"kW\"}", "2027-01-15T08:00:30Z", null));
        abgelehnt("23514", "quelle_einstellung_nicht_leer", () -> w.fassung(g, null, null, "offset",
                "{\"wert\":1,\"einheit\":\"kW\"}", "2027-01-15T08:00:00Z", "2027-01-15T08:00:00Z"));
        abgelehnt("23514", "quelle_einstellung_kanal_chk", () -> w.fassung(g, null, "power_kw", "offset",
                "{\"wert\":1,\"einheit\":\"kW\"}", "2027-01-15T08:00:00Z", null));
        abgelehnt("23514", "quelle_einstellung_wert_chk", () -> w.fassung(g, null, null, "wandler_strom",
                "{\"primaer_a\":\"600\",\"sekundaer_a\":5}", "2027-02-01T00:00:00Z", null));
        abgelehnt("23514", "quelle_einstellung_art_chk", () -> w.fassung(g, null, null, "phasenlage",
                "{\"grad\":120}", "2027-02-01T00:00:00Z", null));
        abgelehnt("23514", "quelle_einstellung_rueckwirkend_chk", () -> root.update("INSERT INTO quelle_einstellung "
                + "(tenant_id, geraet_id, art, wert, anwendung, herkunft, gueltig_ab, rueckwirkend, actor_sub, "
                + "actor_name, actor_art, eingetragen_am) VALUES (?, ?, 'zaehlerkonstante', '{\"je_kwh\":375}', "
                + "'dokumentiert', 'eintrag', ?, true, 's', 'n', 'kunde', ?)", w.tenant, g,
                ts("2027-03-01T00:00:00Z"), ts("2027-02-01T00:00:00Z")));
        abgelehnt("23514", "quelle_einstellung_bestand_chk", () -> root.update("INSERT INTO quelle_einstellung "
                + "(tenant_id, geraet_id, entity_id, art, wert, anwendung, herkunft, gueltig_ab, rueckwirkend, "
                + "actor_sub, actor_name, actor_art) VALUES (?, ?, ?, 'skalierung', '{\"faktor\":10}', 'angewendet', "
                + "'bestand', ?, false, 'jemand', 'Jemand', 'kunde')", w.tenant, g, k, ts("2027-03-01T00:00:00Z")));
        abgelehnt("23514", "quelle_einstellung_verbindung_chk", () -> root.update("INSERT INTO quelle_einstellung "
                + "(tenant_id, geraet_id, art, wert, anwendung, herkunft, gueltig_ab, rueckwirkend, "
                + "actor_sub, actor_name, actor_art) VALUES (?, ?, 'skalierung', '{\"faktor\":10}', 'angewendet', "
                + "'verbindung', ?, false, 's', 'n', 'kunde')", w.tenant, g, ts("2027-03-01T00:00:00Z")));
        abgelehnt("23514", "quelle_einstellung_tatsaechlich_chk", () -> root.update("INSERT INTO quelle_einstellung "
                + "(tenant_id, geraet_id, art, wert, anwendung, herkunft, gueltig_ab, tatsaechlich_ab, rueckwirkend, "
                + "actor_sub, actor_name, actor_art) VALUES (?, ?, 'zaehlerkonstante', '{\"je_kwh\":375}', "
                + "'dokumentiert', 'eintrag', ?, ?, false, 's', 'n', 'kunde')", w.tenant, g,
                ts("2027-03-01T00:00:00Z"), ts("2027-03-01T00:00:00Z")));
    }

    /**
     * Eine Fassung wird nur verkürzt: außerhalb eines geplanten Wechsels bleibt nur {@code gueltig_bis} änderbar, nie
     * löschen; der Trigger lässt es nur früher werden und schreibt keiner Rolle einen Wert um.
     */
    @Test
    void eineFassungWirdNurVerkuerztNieVerlaengertNieUmgeschriebenNieGeloescht() {
        Werkstatt w = new Werkstatt("Werkstatt Verkürzen");
        UUID k = w.komponente("grid-meter", "modbus_tcp", "{\"ip\":\"10.0.0.4\",\"unit_id\":1}");
        UUID g = laufendesGeraet(k);
        UUID f = w.fassung(g, null, null, "wandler_strom", "{\"primaer_a\":600,\"sekundaer_a\":5}",
                "2026-01-01T00:00:00Z", "2027-02-01T00:00:00Z");

        assertThat(als(w.tenant, () -> app.update("UPDATE quelle_einstellung SET gueltig_bis = ? WHERE id = ?",
                ts("2027-01-15T08:00:00Z"), f))).isOne();
        abgelehnt("23514", "quelle_einstellung_nur_verkuerzen", () -> alsTue(w.tenant, () -> app.update(
                "UPDATE quelle_einstellung SET gueltig_bis = ? WHERE id = ?", ts("2027-03-01T00:00:00Z"), f)));
        abgelehnt("23514", "quelle_einstellung_nur_verkuerzen", () -> alsTue(w.tenant, () -> app.update(
                "UPDATE quelle_einstellung SET gueltig_bis = NULL WHERE id = ?", f)));
        abgelehntWegen("42501", "permission denied", () -> alsTue(w.tenant, () -> app.update(
                "UPDATE quelle_einstellung SET wert = '{\"primaer_a\":700,\"sekundaer_a\":5}' WHERE id = ?", f)));
        abgelehntWegen("42501", "permission denied", () -> alsTue(w.tenant, () -> app.update(
                "DELETE FROM quelle_einstellung WHERE id = ?", f)));
        // Auch eine Rolle mit vollem Recht schreibt keinen Wert um.
        abgelehnt("23514", "quelle_einstellung_unveraenderlich", () -> admin.update(
                "UPDATE quelle_einstellung SET wert = '{\"primaer_a\":700,\"sekundaer_a\":5}' WHERE id = ?", f));
        assertThat(root.queryForObject("SELECT wert::text FROM quelle_einstellung WHERE id = ?", String.class, f))
                .contains("600");
    }

    @Test
    void dieRechteDerAppRolle() {
        assertThat(rechte("quelle_einstellung")).isEqualTo("INSERT,SELECT");
        assertThat(root.queryForList("SELECT column_name FROM information_schema.column_privileges "
                + "WHERE table_name = 'quelle_einstellung' AND grantee = ? AND privilege_type = 'UPDATE'",
                // AP-16 IP-15 (V20260922245000): `klasse` ist eine Messmittel-Angabe an der Wandler-Fassung,
                // keine Wirkung — sie steht außerhalb des Tupels, das quelle_einstellung_nur_verkuerzen festhält.
                String.class, APP_USER)).containsExactlyInAnyOrder("gueltig_ab", "gueltig_bis", "klasse");
    }

    /**
     * Das Protokoll der Messstelle kennt die neue Art {@code einstellung_geaendert} — und alle Arten
     * des Stands davor (V20260911250000) bleiben; ein erfundenes Wort nimmt der CHECK nie an.
     */
    @Test
    void dasProtokollDerMessstelleKenntDieNeueArtUndAlleBisherigen() {
        Werkstatt w = new Werkstatt("Werkstatt Protokoll");
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-0001', 'Probe', 'gemessen', 'Strom', 'Wirkenergie', "
                + "'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, w.tenant);
        alsTue(w.tenant, () -> {
            for (String art : List.of("einstellung_geaendert", "quelle_gebunden", "quelle_beendet", "angelegt",
                    "bearbeitet", "angehalten", "fortgesetzt", "archiviert", "nebengroesse_hinzugefuegt",
                    "nebengroesse_archiviert", "ort_zugeordnet", "ort_korrigiert", "stellung_zugeordnet",
                    "stellung_korrigiert")) {
                assertThat(app.update("INSERT INTO messstelle_aenderung (tenant_id, messstelle_id, art, gilt_ab, "
                        + "rueckwirkend, actor_sub, actor_name, actor_art) VALUES (?, ?, ?, ?, false, 'sub', "
                        + "'Probe', 'kunde')", w.tenant, ms, art, ts("2027-01-15T08:00:00Z"))).as(art).isOne();
            }
            abgelehnt("23514", "messstelle_aenderung_art_chk", () -> app.update("INSERT INTO messstelle_aenderung "
                    + "(tenant_id, messstelle_id, art, gilt_ab, rueckwirkend, actor_sub, actor_name, actor_art) "
                    + "VALUES (?, ?, 'einstellung_verschoben', ?, false, 'sub', 'Probe', 'kunde')", w.tenant, ms,
                    ts("2027-01-15T08:00:00Z")));
        });
    }

    // ---- Löschen und Offboarding ---------------------------------------------------------

    @Test
    void anlageUndKomponenteBleibenLoeschbar() {
        Werkstatt w = new Werkstatt("Werkstatt Löschen");
        UUID k = w.komponente("battery-hybrid", "solarman_v5", "{\"ip\":\"10.0.0.5\",\"invert_batt_sign\":true}");
        UUID k2 = w.komponente("producer", "fronius_solar_api", "{\"ip\":\"10.0.0.6\",\"invert_grid_sign\":false}");
        assertThat(root.queryForObject("SELECT uems_einstellungen_ableiten()", Integer.class)).isEqualTo(2);

        assertThat(als(w.tenant, () -> app.update("DELETE FROM measurement_point WHERE id = ?", k2))).isOne();
        assertThat(anzahl("SELECT count(*) FROM quelle_einstellung WHERE entity_id = ?", k2)).isZero();
        assertThat(anzahl("SELECT count(*) FROM quelle_einstellung WHERE entity_id = ?", k)).isOne();

        assertThat(als(w.tenant, () -> app.update("DELETE FROM site WHERE id = ?", w.site))).isOne();
        assertThat(anzahl("SELECT count(*) FROM quelle_einstellung WHERE tenant_id = ?", w.tenant)).isZero();
    }

    @Test
    void ohneOffboardingVerweigertDieDatenbankUndDasOffboardingRaeumtAusdruecklichAb() {
        Werkstatt w = new Werkstatt("Werkstatt Offboarding");
        w.komponente("battery-hybrid", "solarman_v5", "{\"ip\":\"10.0.0.7\",\"power_scale\":10}");
        assertThat(root.queryForObject("SELECT uems_einstellungen_ableiten()", Integer.class)).isOne();

        abgelehnt("23503", null, () -> root.update("DELETE FROM tenant WHERE id = ?", w.tenant));

        new TenantRepository(admin).offboard(w.tenant);
        assertThat(anzahl("SELECT count(*) FROM tenant WHERE id = ?", w.tenant)).isZero();
        for (String t : TABELLEN) {
            assertThat(anzahl("SELECT count(*) FROM " + t + " WHERE tenant_id = ?", w.tenant)).as(t).isZero();
        }
    }

    // ---- Gerüst: der Bestand ----------------------------------------------------------------

    private static void saeBestand() {
        // Ahrenberg AN-1 mit K-1 (SunSpec) und K-3 (Netzzähler NA-1) — ihre Verbindungen aus DQ-1/DQ-2.
        root.update("INSERT INTO tenant (id, name) VALUES (?, ?)", AHRENBERG, referenz.at("/unternehmen/name").asText());
        JsonNode an1 = element(referenz.get("anlagen"), "AN-1");
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) RETURNING id",
                UUID.class, AHRENBERG, an1.get("name").asText(), OffsetDateTime.parse(an1.get("seit").asText()));
        JsonNode e1 = element(referenz.get("boxen"), "E-1");
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, created_at) VALUES "
                + "(?, ?, ?, ?) RETURNING id", UUID.class, AHRENBERG, site, e1.get("seriennummer").asText(),
                OffsetDateTime.parse(e1.get("in_betrieb_ab").asText()));
        for (String k : List.of("K-1", "K-3")) {
            JsonNode komponente = element(referenz.get("komponenten"), k);
            JsonNode geraet = element(referenz.get("geraete"), komponente.get("geraet").asText());
            JsonNode quelle = element(referenz.get("datenquellen"), geraet.get("datenquelle").asText());
            ObjectNode verbindung = MAPPER.createObjectNode().put("ip", quelle.get("adresse").asText())
                    .put("port", quelle.get("port").asInt()).put("unit_id", geraet.get("modbus_geraete_id").asInt());
            String art = "K-1".equals(k) ? "battery-hybrid" : "grid-meter";
            KOMPONENTEN.put(k, root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                    + "entity_type, device_id, communication, connection_json, created_at) VALUES "
                    + "(?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?) RETURNING id", UUID.class, AHRENBERG, site, art,
                    komponente.get("name").asText(), art, box, "K-1".equals(k) ? "sunspec_tcp" : "modbus_tcp",
                    verbindung.toString(), OffsetDateTime.parse(komponente.get("in_betrieb_ab").asText())));
        }

        // Der neutrale Probe-Bereich mit den Einstellungen, die die Verbindungen heute tragen.
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kundenbereich Probe')", PROBE);
        UUID a = anlage(PROBE, "Probe Deye", "2026-07-01T08:00:00Z");
        UUID pb = box(PROBE, a, "VP-BOX-EINST-0001");
        bestand(PROBE, a, pb, "Deye ×10", "battery-hybrid", "battery-hybrid", "solarman_v5",
                "{\"ip\":\"192.168.178.40\",\"port\":8899,\"serial\":\"2712345678\",\"mb_slave_id\":1,"
                        + "\"power_scale\":\"10\",\"invert_grid_sign\":false,\"invert_batt_sign\":true}",
                "2026-07-20T14:23:17Z");
        bestand(PROBE, a, pb, "Netzzähler komponiert", "grid-meter", "grid-meter", null, null, "2026-07-20T14:23:18Z");
        bestand(PROBE, a, pb, "Selbstbau Wärmepumpe", "modbus-generic", "modbus-generic", "modbus_baukasten",
                "{\"transport\":{\"host\":\"192.168.178.90\",\"port\":502,\"unit_id\":3},\"channels\":["
                        + "{\"slug\":\"wirkleistung\",\"label\":\"Wirkleistung\",\"unit\":\"kW\",\"register\":"
                        + "{\"kind\":\"holding\",\"address\":40083,\"data_type\":\"s16\",\"word_order\":\"big\"},"
                        + "\"scale\":0.001,\"offset\":0,\"min_read_interval_s\":10},"
                        + "{\"slug\":\"temperatur\",\"label\":\"Temperatur\",\"unit\":\"°C\",\"register\":"
                        + "{\"kind\":\"input\",\"address\":30001,\"data_type\":\"s16\",\"word_order\":\"big\"},"
                        + "\"scale\":0.1,\"offset\":-40,\"min_read_interval_s\":60}]}",
                "2026-07-22T09:00:00Z");
        bestand(PROBE, a, null, "Fronius", "pv-generation", "producer", "fronius_solar_api",
                "{\"ip\":\"192.168.178.41\",\"invert_grid_sign\":true}", "2026-07-21T09:00:00Z");
        bestand(PROBE, a, null, "Wallbox", "consumer", "wallbox", "goe_http_api", "{\"ip\":\"192.168.178.70\"}",
                "2026-07-24T09:00:00Z");
        UUID b = anlage(PROBE, "Probe Deye automatisch", "2026-08-01T08:00:00Z");
        bestand(PROBE, b, box(PROBE, b, "VP-BOX-EINST-0002"), "Deye automatisch", "battery-hybrid", "battery-hybrid",
                "solarman_v5",
                "{\"ip\":\"192.168.178.44\",\"port\":8899,\"serial\":\"2712345679\",\"power_scale\":0}",
                "2026-08-01T09:00:00Z");
        for (String tag : List.of("2026-07-20T22:00:00Z", "2026-07-21T22:00:00Z")) {
            root.update("INSERT INTO telemetry_v2_rollup_1d (bucket, tenant_id, site_id, entity_id, channel, "
                    + "avg_value, min_value, max_value, last_value, n_samples) VALUES (?, ?, ?, ?, "
                    + "'battery_power_kw', 5, -3, 9, 4, 96)", ts(tag), PROBE, a, KOMPONENTEN.get("Deye ×10").toString());
        }
    }

    private static UUID anlage(UUID tenant, String name, String seit) {
        return root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) RETURNING id",
                UUID.class, tenant, name, ts(seit));
    }

    private static UUID box(UUID tenant, UUID site, String ref) {
        return root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, tenant, site, ref);
    }

    private static void bestand(UUID tenant, UUID site, UUID box, String name, String rolle, String art,
            String kommunikation, String verbindung, String angelegt) {
        KOMPONENTEN.put(name, root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, communication, connection_json, created_at) VALUES "
                + "(?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?) RETURNING id", UUID.class, tenant, site, rolle, name, art, box,
                kommunikation, verbindung, ts(angelegt)));
    }

    /** Ein eigener Kundenbereich je verändernder Test — er berührt den Bestand nicht. */
    private static final class Werkstatt {
        final UUID tenant;
        final UUID site;
        final UUID box;

        Werkstatt(String name) {
            tenant = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
            site = anlage(tenant, name, "2026-01-01T00:00:00Z");
            box = box(tenant, site, "VP-" + tenant.toString().substring(0, 8));
        }

        /** Eine Komponente — ihr Gerät legt der Anlege-Weg (V20260911240000) zur Commit-Zeit an. */
        UUID komponente(String art, String kommunikation, String verbindung) {
            return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, entity_type, "
                    + "device_id, communication, connection_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?) "
                    + "RETURNING id", UUID.class, tenant, site, "producer".equals(art) ? "pv-generation" : art, art,
                    "battery-hybrid".equals(art) ? box : null, kommunikation, verbindung, ts("2026-01-01T00:00:00Z"));
        }

        UUID fassung(UUID geraet, UUID komponente, String kanal, String art, String wert, String ab, String bis) {
            return root.queryForObject("INSERT INTO quelle_einstellung (tenant_id, geraet_id, entity_id, kanal, art, "
                    + "wert, anwendung, herkunft, gueltig_ab, gueltig_bis, rueckwirkend, actor_sub, actor_name, "
                    + "actor_art) VALUES (?, ?, ?, ?, ?, ?::jsonb, 'dokumentiert', 'eintrag', ?, ?, false, 'sub', "
                    + "'Probe', 'kunde') RETURNING id", UUID.class, tenant, geraet, komponente, kanal, art, wert,
                    ts(ab), bis == null ? null : ts(bis));
        }
    }

    private static UUID laufendesGeraet(UUID komponente) {
        return root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? AND gueltig_bis IS NULL",
                UUID.class, komponente);
    }

    private static String rechte(String tabelle) {
        return root.queryForObject("SELECT coalesce(string_agg(privilege_type, ',' ORDER BY privilege_type), '') "
                + "FROM information_schema.role_table_grants WHERE table_name = ? AND grantee = ?", String.class,
                tabelle, APP_USER);
    }

    private static JsonNode element(JsonNode liste, String kennzeichen) {
        for (JsonNode e : liste) {
            if (kennzeichen.equals(e.path("kennzeichen").asText())) {
                return e;
            }
        }
        throw new AssertionError("nicht in der Referenzdatei: " + kennzeichen);
    }

    private static JsonNode lies(String json) {
        try {
            return MAPPER.readTree(json);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    private static Timestamp ts(String iso) {
        return Timestamp.from(Instant.parse(iso));
    }

    private static long anzahl(String sql, Object... args) {
        return root.queryForObject(sql, Long.class, args);
    }

    // ---- Gerüst: der Schnappschuss einer Tabelle --------------------------------------------

    private static Map<String, Map<String, String>> schnappschuesse() {
        Map<String, Map<String, String>> m = new LinkedHashMap<>();
        for (String t : BESTAND) {
            m.put(t, schnappschuss(t));
        }
        return m;
    }

    /** Spalten, jede Zeile, eigene Constraints, Indexe, Policies, RLS-Schalter, eigene Trigger und Rechte. */
    private static Map<String, String> schnappschuss(String tabelle) {
        Map<String, String> s = new LinkedHashMap<>();
        s.put("spalten", root.queryForObject("SELECT string_agg(format('%s|%s|%s|%s|%s', column_name, "
                + "data_type, is_nullable, column_default, ordinal_position), E'\\n' ORDER BY ordinal_position) "
                + "FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?",
                String.class, tabelle));
        s.put("zeilen", root.queryForObject("SELECT coalesce(string_agg(z, E'\\n' ORDER BY z), '') FROM "
                + "(SELECT to_jsonb(t)::text AS z FROM " + tabelle + " t) AS zeilen", String.class));
        s.put("constraints", root.queryForObject("SELECT coalesce(string_agg(conname || ':' || "
                + "pg_get_constraintdef(oid), E'\\n' ORDER BY conname), '') FROM pg_constraint "
                + "WHERE conrelid = ?::regclass", String.class, tabelle));
        s.put("indexe", root.queryForObject("SELECT coalesce(string_agg(indexdef, E'\\n' ORDER BY indexname), '') "
                + "FROM pg_indexes WHERE schemaname = 'public' AND tablename = ?", String.class, tabelle));
        s.put("policies", root.queryForObject("SELECT coalesce(string_agg(policyname || ':' || "
                + "coalesce(qual, '') || ':' || coalesce(with_check, ''), E'\\n' ORDER BY policyname), '') "
                + "FROM pg_policies WHERE tablename = ?", String.class, tabelle));
        s.put("rls", root.queryForObject("SELECT relrowsecurity || '/' || relforcerowsecurity FROM pg_class "
                + "WHERE oid = ?::regclass", String.class, tabelle));
        s.put("trigger", root.queryForObject("SELECT coalesce(string_agg(tgname, ',' ORDER BY tgname), '') "
                + "FROM pg_trigger WHERE tgrelid = ?::regclass AND NOT tgisinternal", String.class, tabelle));
        s.put("rechte", root.queryForObject("SELECT coalesce(string_agg(grantee || ':' || privilege_type, ',' "
                + "ORDER BY grantee, privilege_type), '') FROM information_schema.role_table_grants "
                + "WHERE table_schema = 'public' AND table_name = ?", String.class, tabelle));
        return s;
    }

    // ---- Gerüst: Zaun und Ablehnungen --------------------------------------------------------

    private static <T> T als(UUID tenant, Supplier<T> arbeit) {
        UUID vorher = TenantContext.get();
        TenantContext.set(tenant);
        try {
            return arbeit.get();
        } finally {
            if (vorher == null) {
                TenantContext.clear();
            } else {
                TenantContext.set(vorher);
            }
        }
    }

    private static void alsTue(UUID tenant, Runnable arbeit) {
        als(tenant, () -> {
            arbeit.run();
            return null;
        });
    }

    private static PSQLException ablehnung(Runnable arbeit) {
        try {
            arbeit.run();
            return null;
        } catch (RuntimeException e) {
            for (Throwable t = e; t != null; t = t.getCause()) {
                if (t instanceof PSQLException p) {
                    return p;
                }
            }
            throw e;
        }
    }

    private static void abgelehnt(String sqlState, String constraint, Runnable arbeit) {
        PSQLException p = ablehnung(arbeit);
        assertThat((Object) p).as("die Datenbank muss ablehnen (" + constraint + ")").isNotNull();
        assertThat(p.getSQLState()).as(p.getMessage()).isEqualTo(sqlState);
        if (constraint != null) {
            assertThat(p.getServerErrorMessage().getConstraint()).as(p.getMessage()).isEqualTo(constraint);
        }
    }

    private static void abgelehntWegen(String sqlState, String nachricht, Runnable arbeit) {
        PSQLException p = ablehnung(arbeit);
        assertThat((Object) p).as("die Datenbank muss ablehnen (" + nachricht + ")").isNotNull();
        assertThat(p.getSQLState()).as(p.getMessage()).isEqualTo(sqlState);
        assertThat(p.getMessage()).contains(nachricht);
    }

    // ---- Gerüst: Flyway ------------------------------------------------------------------

    private static String letzteFassungVorDieser() {
        MigrationVersion diese = MigrationVersion.fromVersion(DIESE);
        return Arrays.stream(flyway().load().info().all())
                .map(MigrationInfo::getVersion)
                .filter(v -> v != null && v.compareTo(diese) < 0)
                .max(Comparator.naturalOrder())
                .orElseThrow()
                .getVersion();
    }

    private static void fuehreErneutAus(String datei) throws IOException {
        String sql;
        try (InputStream in = UemsQuelleEinstellungMigrationTest.class.getResourceAsStream("/db/migration/" + datei)) {
            sql = new String(Objects.requireNonNull(in, datei).readAllBytes(), StandardCharsets.UTF_8);
        }
        root.execute(sql.replace("${appDbUser}", APP_USER).replace("${adminDbUser}", ADMIN_USER));
    }

    private static FluentConfiguration flyway() {
        return Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of(
                        "appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW));
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
