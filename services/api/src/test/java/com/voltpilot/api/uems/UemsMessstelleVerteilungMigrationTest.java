package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.EreignisVokabular.Urheber;
import java.io.IOException;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Migration {@code V20260913230000} (UEMS AP-10 IP-8): die Verteilung einer Messstelle auf Kostenstellen.
 *
 * <ul>
 *   <li>Bestandsschutz über den gemeinsamen Vergleich ({@link Bestandsschutz});</li>
 *   <li>100 % je Tag ZUR COMMIT-ZEIT: der Wechsel 70/30 → 60/40 mit zwei Zielen geht in EINER Transaktion
 *       durch — und scheitert mit derselben Anweisungsfolge, sobald die Prüfung sofort läuft; 90 % scheitern
 *       beim Commit, und nichts bleibt stehen; ohne Zeile ist „nicht verteilt“ erlaubt;</li>
 *   <li>ein Anteil gilt nie länger als seine Kostenstelle — über das vorhandene Trigger-Paar aus AP-10 IP-7,
 *       von BEIDEN Seiten, gegen JEDEN Anteil des Referenzunternehmens;</li>
 *   <li>Anteil nie still gerundet, Überlappung je Ziel, Ereignis-Art und Protokoll-Art;</li>
 *   <li>Zaun, Rechte (beenden statt löschen), erneutes Ausführen und Offboarding.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsMessstelleVerteilungMigrationTest {

    private static final String DIESE = "20260913230000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final Path REFERENZ = Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");
    private static final LocalDate OKT_1 = LocalDate.of(2026, 10, 1);
    private static final LocalDate JAN_14 = LocalDate.of(2027, 1, 14);
    private static final LocalDate JAN_15 = LocalDate.of(2027, 1, 15);
    private static final String HUNDERT = "messstelle_verteilung_hundert_prozent";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static JsonNode referenz;
    private static Kunde a;
    private static Kunde b;
    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;

    private record Kunde(UUID tenant, UUID unternehmen, UUID messstelle) {
    }

    @BeforeAll
    static void bestandUndMigration() throws IOException {
        referenz = new ObjectMapper().readTree(REFERENZ.toFile());
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().target(letzteFassungVorDieser()).load().migrate();
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        a = kunde("Kunststoffwerk Ahrenberg GmbH");
        b = kunde("Kundenbereich B");
        // Der Bestand der Tabellen, die diese Migration anfasst: eine Kostenstelle (bekommt eine zweite
        // Zuordnungs-Tabelle), ein Protokolleintrag (Art-CHECK) und ein Ereignis (Vokabular + Art-CHECK).
        kostenstelle(root, a, "4100", OKT_1, null);
        root.update("INSERT INTO messstelle_aenderung (tenant_id, messstelle_id, art, gilt_ab, rueckwirkend, "
                + "actor_name, actor_art) VALUES (?, ?, 'prozesse_zugeordnet', now(), false, 'VoltPilot', 'voltpilot')",
                a.tenant(), a.messstelle());
        ObjectNode korrektur = new ObjectMapper().createObjectNode();
        korrektur.put("ereignis_id", UUID.randomUUID().toString());
        korrektur.put("art", "correction");
        korrektur.put("von", "2026-11-03T13:00:00Z");
        korrektur.put("bis", "2026-11-03T16:45:00Z");
        korrektur.put("komponente", "K-8.1");
        korrektur.put("messkanal", "Wirkenergie Bezug");
        korrektur.put("korrektur", "K-2026-0007");
        korrektur.put("korrektur_art", "nachlieferung_nach_endgueltigkeit");
        korrektur.put("status", "vorschlag");
        assertThat(als(a.tenant(), () -> new MessreiheEreignisRepository(app).anhaengen(a.tenant(), null,
                Urheber.CLOUD, korrektur, null, null)).ausgang()).isEqualTo(MessreiheEreignisRepository.Ausgang.ANGEHAENGT);
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of());

        flyway().target(DIESE).load().migrate();
        fingerNachMigration = Bestandsschutz.fingerabdruck(root, List.of());
        flyway().load().migrate();
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ================================================================== Bestandsschutz

    @Test
    void dieMigrationLaesstDenBestandZeichengleich() {
        for (String tabelle : List.of("kostenstelle", "messstelle_aenderung", "messreihe_ereignis", "messstelle")) {
            assertThat(fingerVorher.get(tabelle)).as("es gibt Bestand in " + tabelle).isNotEqualTo(Bestandsschutz.LEER);
        }
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
        assertThat(fingerVorher).as("neu: messstelle_verteilung").doesNotContainKey("messstelle_verteilung");
        assertThat(fingerNachMigration.get("messstelle_verteilung")).as("kommt leer").isEqualTo(Bestandsschutz.LEER);
    }

    @Test
    void derBestandsvergleichBeisst() {
        Bestandsschutz.mutationsprobe(root, List.of(), "kostenstelle", "UPDATE kostenstelle SET name = name || '!'");
    }

    // ============================================================ 100 % je Tag zur Commit-Zeit

    /**
     * Der Satz mit zwei Zielen: 70/30 ab 01.10.2026, dann 60/40 ab 15.01.2027 (F13). Zwischen den Anweisungen ist
     * der Stand nie 100 % — nach dem Beenden der ersten alten Zeile gälten ab dem 15.01. nur 30 %, nach der ersten
     * neuen 90 %. In EINER Transaktion ergibt er am Ende genau 100 % an jedem Tag, und die Datenbank nimmt ihn an.
     */
    @Test
    void einSatzMitZweiZielenGehtInEinerTransaktionDurch() {
        Kunde k = kunde("Zwei Ziele");
        UUID k4100 = kostenstelle(root, k, "4100", OKT_1, null);
        UUID k4200 = kostenstelle(root, k, "4200", OKT_1, null);
        in(k, () -> {
            anteil(app, k, k4100, "70", OKT_1, null);
            anteil(app, k, k4200, "30", OKT_1, null);
        });
        in(k, () -> {
            app.update("UPDATE messstelle_verteilung SET gueltig_bis = ? WHERE kostenstelle_id = ?", JAN_14, k4100);
            app.update("UPDATE messstelle_verteilung SET gueltig_bis = ? WHERE kostenstelle_id = ?", JAN_14, k4200);
            anteil(app, k, k4100, "60", JAN_15, null);
            anteil(app, k, k4200, "40", JAN_15, null);
        });
        assertThat(summen(k)).containsExactly("2026-10-01=100", "2027-01-15=100");
    }

    /** Dieselbe Anweisungsfolge mit SOFORTIGER Prüfung scheitert gleich an der ersten — darum die Commit-Zeit. */
    @Test
    void ohneCommitZeitScheitertDerselbeSatzMittendrin() {
        Kunde k = kunde("Sofort");
        UUID k4100 = kostenstelle(root, k, "4100", OKT_1, null);
        UUID k4200 = kostenstelle(root, k, "4200", OKT_1, null);
        in(k, () -> {
            anteil(app, k, k4100, "70", OKT_1, null);
            anteil(app, k, k4200, "30", OKT_1, null);
        });
        PSQLException p = psql(() -> in(k, () -> {
            app.execute("SET CONSTRAINTS " + HUNDERT + " IMMEDIATE");
            app.update("UPDATE messstelle_verteilung SET gueltig_bis = ? WHERE kostenstelle_id = ?", JAN_14, k4100);
            app.update("UPDATE messstelle_verteilung SET gueltig_bis = ? WHERE kostenstelle_id = ?", JAN_14, k4200);
            anteil(app, k, k4100, "60", JAN_15, null);
            anteil(app, k, k4200, "40", JAN_15, null);
        }));
        assertThat(p.getServerErrorMessage().getConstraint()).isEqualTo(HUNDERT);
        assertThat(p.getMessage()).as("die erste Anweisung: ab 15.01. blieben 30 %").contains("2027-01-15").contains("30");
        assertThat(summen(k)).as("zurückgerollt").containsExactly("2026-10-01=100");
        assertThat(root.queryForObject("SELECT condeferrable AND condeferred FROM pg_constraint WHERE conname = ?",
                Boolean.class, HUNDERT)).as("DEFERRABLE INITIALLY DEFERRED").isTrue();
    }

    /** F10: 90 % sind ein Fehler, kein Näherungswert — beim Commit abgelehnt, nichts bleibt stehen. */
    @Test
    void neunzigProzentScheiternBeimCommitUndNichtsBleibt() {
        Kunde k = kunde("Neunzig");
        UUID k4100 = kostenstelle(root, k, "4100", OKT_1, null);
        UUID k4200 = kostenstelle(root, k, "4200", OKT_1, null);
        PSQLException p = psql(() -> in(k, () -> {
            anteil(app, k, k4100, "60", OKT_1, null);
            anteil(app, k, k4200, "30", OKT_1, null);
        }));
        assertThat(p.getServerErrorMessage().getConstraint()).isEqualTo(HUNDERT);
        assertThat(p.getMessage()).contains("2026-10-01").contains("90");
        assertThat(root.queryForObject("SELECT count(*) FROM messstelle_verteilung WHERE tenant_id = ?", Long.class,
                k.tenant())).isZero();
        // 110 % ebenso — nie still normiert.
        assertThat(psql(() -> in(k, () -> {
            anteil(app, k, k4100, "70", OKT_1, null);
            anteil(app, k, k4200, "40", OKT_1, null);
        })).getServerErrorMessage().getConstraint()).isEqualTo(HUNDERT);
    }

    /** Ohne Zeile ist die Messstelle „nicht verteilt“ — erlaubt; eine aufgehobene Zeile zählt nicht. */
    @Test
    void ohneZeileIstNichtVerteiltUndEineAufgehobeneZaehltNicht() {
        Kunde k = kunde("Nicht verteilt");
        UUID k4100 = kostenstelle(root, k, "4100", OKT_1, null);
        UUID k4200 = kostenstelle(root, k, "4200", OKT_1, null);
        in(k, () -> {
            anteil(app, k, k4100, "70", OKT_1, null);
            anteil(app, k, k4200, "30", OKT_1, null);
        });
        // Ab 01.02.2027 nicht verteilt: beide enden am 31.01., keine neue Zeile.
        in(k, () -> app.update("UPDATE messstelle_verteilung SET gueltig_bis = ? WHERE tenant_id = ?",
                LocalDate.of(2027, 1, 31), k.tenant()));
        assertThat(summen(k)).containsExactly("2026-10-01=100");
        // Korrektur am selben Tag: 70/30 aufheben, 65/35 ab demselben Tag.
        in(k, () -> {
            app.update("UPDATE messstelle_verteilung SET aufgehoben_am = now() WHERE tenant_id = ?", k.tenant());
            anteil(app, k, k4100, "65", OKT_1, null);
            anteil(app, k, k4200, "35", OKT_1, null);
        });
        assertThat(summen(k)).containsExactly("2026-10-01=100");
        // Nur EINE Zeile aufheben ließe 35 % stehen — abgelehnt.
        assertThat(psql(() -> in(k, () -> app.update("UPDATE messstelle_verteilung SET aufgehoben_am = now() "
                + "WHERE kostenstelle_id = ? AND aufgehoben_am IS NULL", k4100))).getServerErrorMessage().getConstraint())
                .isEqualTo(HUNDERT);
    }

    // ============================================ Ein Anteil gilt nie länger als seine Kostenstelle

    /**
     * JEDER Anteil des Referenzunternehmens steht so in {@code messstelle_verteilung} — in einer Transaktion, die
     * beide Trigger besteht (100 % je Tag, im Ziel). Die Hälfte der Kostenstelle kommt aus AP-10 IP-7 und findet
     * die Tabelle von selbst: 4100 früher beenden ist abgelehnt, und die 409-Liste nennt die Anteile.
     */
    @Test
    void einAnteilGiltNieLaengerAlsSeineKostenstelleVonBeidenSeiten() {
        Kunde k = kunde("Referenz");
        Map<String, UUID> ks = new LinkedHashMap<>();
        for (JsonNode kst : referenz.path("kostenstellen")) {
            ks.put(kst.path("kennzeichen").asText(), kostenstelle(root, k, kst.path("kennzeichen").asText(),
                    LocalDate.parse(kst.path("gueltig_ab").asText()), tag(kst.path("gueltig_bis"))));
        }
        int[] anteile = {0};
        in(k, () -> {
            for (JsonNode m : referenz.path("messstellen")) {
                if (m.path("kostenstellen_anteile").isEmpty()) {
                    continue;
                }
                UUID ms = m.path("kennzeichen").asText().equals("MS-07") ? k.messstelle()
                        : messstelle(k, m.path("kennzeichen").asText());
                for (JsonNode an : m.path("kostenstellen_anteile")) {
                    app.update("INSERT INTO messstelle_verteilung (tenant_id, messstelle_id, kostenstelle_id, "
                            + "anteil_prozent, gueltig_ab, gueltig_bis) VALUES (?, ?, ?, ?, ?, ?)", k.tenant(), ms,
                            ks.get(an.path("kostenstelle").asText()), new BigDecimal(an.path("anteil_prozent").asText()),
                            LocalDate.parse(an.path("gueltig_ab").asText()), tag(an.path("gueltig_bis")));
                    anteile[0]++;
                }
            }
        });
        assertThat(anteile[0]).as("die Anteile des Referenzunternehmens").isGreaterThan(15);

        UUID ms03 = messstelle(k, "MS-99");
        LocalDate ende9000 = LocalDate.of(2026, 12, 31);
        String zielTrigger = "messstelle_verteilung_kostenstelle_besteht";
        // Vor 1.2 galten die Anteile auf 9000 offen — genau das lehnt die Datenbank ab (sofort, BEFORE-Trigger).
        assertThat(psql(() -> in(k, () -> app.update("INSERT INTO messstelle_verteilung (tenant_id, messstelle_id, "
                + "kostenstelle_id, anteil_prozent, gueltig_ab) VALUES (?, ?, ?, 100, ?)", k.tenant(), ms03, ks.get("9000"),
                OKT_1))).getServerErrorMessage().getConstraint()).isEqualTo(zielTrigger);
        // Die Nachfolger 9010/9020 bestehen erst ab 2027 — kein Anteil davor.
        assertThat(psql(() -> in(k, () -> app.update("INSERT INTO messstelle_verteilung (tenant_id, messstelle_id, "
                + "kostenstelle_id, anteil_prozent, gueltig_ab) VALUES (?, ?, ?, 100, ?)", k.tenant(), ms03, ks.get("9010"),
                ende9000))).getServerErrorMessage().getConstraint()).isEqualTo(zielTrigger);
        // Ein Anteil verlängern, dessen Kostenstelle endet — abgelehnt.
        assertThat(psql(() -> in(k, () -> app.update("UPDATE messstelle_verteilung SET gueltig_bis = NULL WHERE "
                + "tenant_id = ? AND kostenstelle_id = ?", k.tenant(), ks.get("9000")))).getServerErrorMessage()
                .getConstraint()).isEqualTo(zielTrigger);

        // Die Seite der Kostenstelle: 4100 früher beenden, während MS-06/07/08/11/20 dort offen gelten — abgelehnt.
        UUID k4100 = ks.get("4100");
        assertThat(psql(() -> root.update("UPDATE kostenstelle SET gueltig_bis = ? WHERE id = ?", ende9000, k4100))
                .getServerErrorMessage().getConstraint()).isEqualTo("kostenstelle_zuordnung_besteht");
        assertThat(root.queryForList("SELECT tabelle FROM uems_zuordnungen_ausserhalb('kostenstelle', ?, ?, ?, ?)",
                String.class, k.tenant(), k4100, OKT_1, ende9000))
                .as("MS-06, MS-07 (70 %), MS-08, MS-11, MS-20").hasSize(5).containsOnly("messstelle_verteilung");
        // 9000 endet schon am 31.12.2026 und seine Anteile mit ihm: ein unverändertes Ende geht.
        root.update("UPDATE kostenstelle SET gueltig_bis = ? WHERE id = ?", ende9000, ks.get("9000"));
    }

    // ============================================================ Anteil, Überlappung, Vokabulare

    @Test
    void einAnteilWirdNieStillGerundetUndEinZielGiltAnEinemTagEinmal() {
        Kunde k = kunde("Anteil");
        UUID k4100 = kostenstelle(root, k, "4100", OKT_1, null);
        for (String falsch : List.of("33.33", "0", "-10", "100.5")) {
            assertThat(psql(() -> in(k, () -> anteil(app, k, k4100, falsch, OKT_1, null))).getServerErrorMessage()
                    .getConstraint()).as(falsch).isEqualTo("messstelle_verteilung_anteil_chk");
        }
        in(k, () -> anteil(app, k, k4100, "100.0", OKT_1, null));
        assertThat(psql(() -> in(k, () -> anteil(app, k, k4100, "100", LocalDate.of(2026, 11, 1), null)))
                .getServerErrorMessage().getConstraint()).isEqualTo("messstelle_verteilung_keine_ueberlappung");
        assertThat(psql(() -> in(k, () -> app.update("UPDATE messstelle_verteilung SET gueltig_bis = ? WHERE tenant_id = ?",
                OKT_1.minusDays(1), k.tenant()))).getServerErrorMessage().getConstraint())
                .isEqualTo("messstelle_verteilung_bis_nicht_vor_ab");
    }

    @Test
    void dasEreignisVokabularUndDasProtokollKennenDieVerteilung() {
        assertThat(root.queryForList("SELECT art FROM messreihe_ereignis_vokabular()", String.class))
                .endsWith("verteilung_geaendert")
                .containsExactlyElementsOf(Arrays.stream(EreignisVokabular.Art.values())
                        .map(EreignisVokabular.Art::code).toList());
        Map<String, Object> v = root.queryForMap("SELECT array_to_string(urheber, ',') AS u, zeitform AS z, "
                + "array_to_string(bezug_pflicht, ',') AS bp, array_to_string(bezug_erlaubt, ',') AS be, "
                + "array_to_string(pflicht, ',') AS p FROM messreihe_ereignis_vokabular() WHERE art = 'verteilung_geaendert'");
        assertThat(v).containsEntry("u", "kunde").containsEntry("z", "zeitpunkt").containsEntry("bp", "messstelle")
                .containsEntry("be", "").containsEntry("p", "eingetragen_am");

        ObjectNode e = new ObjectMapper().createObjectNode();
        e.put("ereignis_id", UUID.randomUUID().toString());
        e.put("art", "verteilung_geaendert");
        e.put("zeitpunkt", "2027-01-14T23:00:00Z");
        e.put("messstelle", "MS-07");
        e.put("eingetragen_am", "2027-01-20T09:12:00Z");
        assertThat(als(a.tenant(), () -> new MessreiheEreignisRepository(app).anhaengen(a.tenant(), null, Urheber.KUNDE,
                e, null, null)).ausgang()).isEqualTo(MessreiheEreignisRepository.Ausgang.ANGEHAENGT);
        assertThat(root.queryForObject("SELECT messstelle_id FROM messreihe_ereignis WHERE ereignis_id = ?", UUID.class,
                UUID.fromString(e.get("ereignis_id").asText()))).as("MS-07 aufgelöst").isEqualTo(a.messstelle());

        alsTue(a.tenant(), () -> app.update("INSERT INTO messstelle_aenderung (tenant_id, messstelle_id, art, gilt_ab, "
                + "rueckwirkend, actor_name, actor_art) VALUES (?, ?, 'verteilung_geaendert', now(), false, 'VoltPilot', "
                + "'voltpilot')", a.tenant(), a.messstelle()));
    }

    // ============================================================ Zaun, Rechte, Wiederholung, Offboarding

    @Test
    void derZaunStehtUndBeendetWirdStattGeloescht() {
        Kunde k = kunde("Zaun");
        UUID k4100 = kostenstelle(root, k, "4100", OKT_1, null);
        in(k, () -> anteil(app, k, k4100, "100", OKT_1, null));
        String t = "messstelle_verteilung";
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname = ?",
                Boolean.class, t)).as("ENABLE + FORCE").isTrue();
        assertThat(root.queryForObject("SELECT count(*) FROM pg_policies WHERE tablename = ? AND qual IS NOT NULL "
                + "AND with_check IS NOT NULL", Long.class, t)).as("USING und WITH CHECK").isOne();
        assertThat(app.queryForObject("SELECT count(*) FROM " + t, Long.class)).as("ohne Mandant").isZero();
        assertThat(als(b.tenant(), () -> app.queryForObject("SELECT count(*) FROM " + t + " WHERE tenant_id = ?",
                Long.class, k.tenant()))).as("B sieht den Kundenbereich nicht").isZero();
        for (String recht : List.of("SELECT", "INSERT", "DELETE", "TRUNCATE")) {
            assertThat(root.queryForObject("SELECT has_table_privilege(?, ?, ?)", Boolean.class, APP_USER, t, recht))
                    .as(recht).isEqualTo(recht.equals("SELECT") || recht.equals("INSERT"));
        }
        assertThat(root.queryForObject("SELECT has_table_privilege(?, ?, 'DELETE') AND NOT has_table_privilege(?, ?, "
                + "'INSERT')", Boolean.class, ADMIN_USER, t, ADMIN_USER, t)).as("Offboarding").isTrue();
        assertThat(root.queryForList("SELECT column_name FROM information_schema.columns c WHERE table_name = ? "
                + "AND has_column_privilege(?, c.table_name, c.column_name, 'UPDATE') ORDER BY column_name",
                String.class, t, APP_USER)).containsExactly("aufgehoben_am", "gueltig_bis");
        assertThat(psql(() -> alsTue(k.tenant(), () -> app.update("DELETE FROM messstelle_verteilung WHERE tenant_id = ?",
                k.tenant()))).getSQLState()).isEqualTo("42501");
        // B schreibt nicht in den Kundenbereich von A, und nicht auf A's Kostenstelle.
        assertThat(psql(() -> in(b, () -> anteil(app, k, k4100, "100", OKT_1, null))).getSQLState()).isEqualTo("42501");
        assertThat(psql(() -> in(b, () -> app.update("INSERT INTO messstelle_verteilung (tenant_id, messstelle_id, "
                + "kostenstelle_id, anteil_prozent, gueltig_ab) VALUES (?, ?, ?, 100, ?)", b.tenant(), b.messstelle(),
                k4100, OKT_1))).getSQLState()).isEqualTo("23503");
    }

    /** {@code out-of-order: true}: dieselbe Datei ein zweites Mal auf dem neuesten Stand ändert nichts. */
    @Test
    void dieMigrationLaeuftAuchEinZweitesMal() throws Exception {
        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());
        String sql = Files.readString(Path.of("src", "main", "resources", "db", "migration",
                "V" + DIESE + "__uems_messstelle_verteilung.sql"))
                .replace("${appDbUser}", APP_USER).replace("${adminDbUser}", ADMIN_USER);
        root.execute(sql);
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of()))).isEmpty();
        // Nur die Tabellen bis zu dieser Migration zählen: spätere Pakete hängen denselben Trigger an ihre
        // eigenen Zuordnungen (AP-10 IP-6 an `anlage_netzanschluss`).
        assertThat(root.queryForObject("SELECT count(*) FROM pg_trigger WHERE tgfoid = "
                + "'uems_zuordnung_im_ziel()'::regprocedure AND NOT tgisinternal AND tgrelid IN "
                + "('messstelle_prozess'::regclass, 'prozess'::regclass, 'messstelle_verteilung'::regclass)", Long.class))
                .as("messstelle_prozess, prozess.eltern_id und jetzt messstelle_verteilung").isEqualTo(3);
        assertThat(root.queryForObject("SELECT count(*) FROM pg_trigger WHERE tgname = ?", Long.class, HUNDERT)).isOne();
    }

    @Test
    void dasOffboardingRaeumtDieAnteileAb() {
        Kunde k = kunde("Offboarding");
        UUID k9000 = kostenstelle(root, k, "9000", OKT_1, LocalDate.of(2026, 12, 31));
        in(k, () -> anteil(app, k, k9000, "100", OKT_1, LocalDate.of(2026, 12, 31)));
        new TenantRepository(new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW))).offboard(k.tenant());
        for (String tabelle : List.of("messstelle_verteilung", "kostenstelle", "messstelle", "unternehmen", "tenant")) {
            String spalte = tabelle.equals("tenant") ? "id" : "tenant_id";
            assertThat(root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE " + spalte + " = ?",
                    Integer.class, k.tenant())).as(tabelle).isZero();
        }
    }

    // ===================================================================== Gerüst

    private static Kunde kunde(String name) {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, name);
        Kunde k = new Kunde(t, u, null);
        return new Kunde(t, u, messstelle(k, "MS-07"));
    }

    private static UUID messstelle(Kunde k, String kennzeichen) {
        return root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', "
                + "'Zählerstand') RETURNING id", UUID.class, k.tenant(), kennzeichen, "Messstelle " + kennzeichen);
    }

    private static UUID kostenstelle(JdbcTemplate db, Kunde k, String kennzeichen, LocalDate ab, LocalDate bis) {
        return db.queryForObject("INSERT INTO kostenstelle (tenant_id, unternehmen_id, kennzeichen, name, gueltig_ab, "
                + "gueltig_bis) VALUES (?, ?, ?, ?, ?, ?) RETURNING id", UUID.class, k.tenant(), k.unternehmen(),
                kennzeichen, "Kostenstelle " + kennzeichen, ab, bis);
    }

    private static void anteil(JdbcTemplate db, Kunde k, UUID kostenstelle, String prozent, LocalDate ab, LocalDate bis) {
        db.update("INSERT INTO messstelle_verteilung (tenant_id, messstelle_id, kostenstelle_id, anteil_prozent, "
                + "gueltig_ab, gueltig_bis) VALUES (?, ?, ?, ?, ?, ?)", k.tenant(), k.messstelle(), kostenstelle,
                new BigDecimal(prozent), ab, bis);
    }

    /** Die Summe je Beginn der wirksamen Zeilen der Messstelle von {@code k}: „Tag=Summe“. */
    private static List<String> summen(Kunde k) {
        return root.queryForList("SELECT gueltig_ab || '=' || sum(anteil_prozent)::int FROM messstelle_verteilung "
                + "WHERE tenant_id = ? AND messstelle_id = ? AND aufgehoben_am IS NULL GROUP BY gueltig_ab ORDER BY gueltig_ab",
                String.class, k.tenant(), k.messstelle());
    }

    /** EINE Transaktion als App-Rolle im Kundenbereich von {@code k} — der Commit prüft die 100 %. */
    private static void in(Kunde k, Runnable arbeit) {
        alsTue(k.tenant(), () -> new TransactionTemplate(new DataSourceTransactionManager(app.getDataSource()))
                .executeWithoutResult(s -> arbeit.run()));
    }

    private static LocalDate tag(JsonNode wert) {
        return wert == null || wert.isNull() ? null : LocalDate.parse(wert.asText());
    }

    private static <T> T als(UUID tenant, Supplier<T> arbeit) {
        TenantContext.set(tenant);
        try {
            return arbeit.get();
        } finally {
            TenantContext.clear();
        }
    }

    private static void alsTue(UUID tenant, Runnable arbeit) {
        als(tenant, () -> {
            arbeit.run();
            return null;
        });
    }

    private static PSQLException psql(Runnable arbeit) {
        Throwable t = null;
        try {
            arbeit.run();
        } catch (Throwable e) {
            t = e;
        }
        assertThat(t).as("die Datenbank muss ablehnen").isNotNull();
        PSQLException p = null;
        for (Throwable c = t; c != null; c = c.getCause()) {
            if (c instanceof PSQLException pe) {
                p = pe;
            }
        }
        assertThat((Object) p).as("eine PSQLException: " + t.getMessage()).isNotNull();
        return p;
    }

    private static String letzteFassungVorDieser() {
        MigrationVersion diese = MigrationVersion.fromVersion(DIESE);
        return Arrays.stream(flyway().load().info().all())
                .map(MigrationInfo::getVersion)
                .filter(v -> v != null && v.compareTo(diese) < 0)
                .max(Comparator.naturalOrder())
                .orElseThrow()
                .getVersion();
    }

    private static FluentConfiguration flyway() {
        return Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP_USER, "appDbPassword", APP_PW,
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
