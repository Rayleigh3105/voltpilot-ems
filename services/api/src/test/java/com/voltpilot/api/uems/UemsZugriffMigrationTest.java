package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.RechteAbleitung.Zuweisung;
import com.voltpilot.api.zugriff.ZugriffRepository;
import com.voltpilot.api.zugriff.ZugriffRepository.NeueZuweisung;
import com.voltpilot.api.zugriff.ZugriffRepository.Zeile;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.flywaydb.core.api.output.MigrateResult;
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
 * UEMS AP-03 IP-2: das Rechte-Fundament ({@code V20260915030000}: {@code benutzer}, {@code zugriff},
 * {@code zugriff_protokoll}) gegen den Rechte-Vertrag aus IP-1 — {@code docs/contracts/v2/rechte-vectors.json}
 * und {@code rechte-matrix.json}. Testcontainers, Docker nötig (sonst übersprungen).
 *
 * <ul>
 *   <li><b>Vokabulare und Rollen zeilengleich:</b> {@code zugriff_vokabular()} ist Zeile für Zeile der Vertrag,
 *       {@code zugriff_rolle()} Zeile für Zeile die Matrix; jeder Block ist gespeichert oder ausdrücklich keine
 *       Spalte; jeder CHECK fragt die eine Stelle, jedes Literal einer Regel ist ein Vertragswort.</li>
 *   <li><b>Zeitgültigkeit wie der Vertrag:</b> JEDE Zuweisung der Vektoren steht als Zeile in der Tabelle, und
 *       „wirksam zu t" der Datenbank ist an jedem Stichtag und jeder Grenze dasselbe wie
 *       {@link Zuweisung#wirksam} — Enddatum einschließlich, Notfall als Zeitpunkt, Beenden halboffen.</li>
 *   <li>Geltungsbereich je Rolle, einmal beenden und nie umschreiben, Überlappungsverbot je (Benutzer, Rolle,
 *       Standort), Mandantenzaun, beschnittene Rechte, Offboarding, Bestandsschutz, späte Ankunft.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsZugriffMigrationTest {

    private static final String DIESE = "20260915030000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts", "v2", "rechte-vectors.json");
    private static final Path MATRIX = Path.of("..", "..", "docs", "contracts", "v2", "rechte-matrix.json");
    private static final Path MIGRATIONEN = Path.of("src", "main", "resources", "db", "migration");
    private static final List<String> TABELLEN = List.of("benutzer", "zugriff", "zugriff_protokoll");

    /**
     * Migrationen, die auf diesen Tabellen AUFBAUEN (AP-03 IP-8: die Unterstützung mit Fremdschlüsseln auf
     * {@code zugriff}, zwei Protokollwörtern und dem geschärften {@code zugriff_protokoll_zugriff_chk}) — ohne
     * diese Migration gibt es ihre Tabellen nicht; in der späten Ankunft kommen sie darum MIT ihr, nicht vor ihr.
     * IP-14 erweitert dasselbe Vokabular und folgt deshalb ebenfalls nach der Grundlage.
     */
    private static final List<String> BAUEN_DARAUF_AUF = List.of("20260916070000", "20260916190000",
            "20260922210000", // AP-16 IP-3: Verantwortlicher verweist auf benutzer(tenant_id, sub).
            "20260922220000", // AP-16 IP-5: Umfang mit Standort- und Ausschlussverweisen.
            "20260922230000", // AP-16 IP-8: erweitert bewertung_aenderung aus IP-5.
            "20260922237000", // AP-16 IP-11: Einstufung verweist auf Energieeinsatz und Benutzerrollen.
            "20260922246000", // AP-16 IP-19: Messbedarf baut auf dem Energieeinsatz aus IP-3 auf.
            "20260923234500", // AP-16 P1: Ort und Größe am Messbedarf aus IP-19 strukturiert.
            "20260924071500", // AP-17 IP-6: Verantwortlicher der Bezugsbasis verweist auf benutzer(tenant_id, sub).
            "20260924223000", // AP-18 IP-5: Verantwortlicher des Energieziels verweist auf benutzer(tenant_id, sub).
            "20260924233000", // AP-18 IP-9: Verantwortlicher der Maßnahme verweist auf benutzer(tenant_id, sub).
            "20260924235130", // AP-18 IP-14: Verantwortlicher der Abweichung verweist auf benutzer(tenant_id, sub).
            "20260925013500", // AP-19 IP-5: Person im Energiemanagement verweist wahlfrei auf benutzer(tenant_id, sub).
            "20260925030000"); // AP-19 IP-12: ersetzt zugriff_rolle() durch die Vereinigung mit einsicht.

    /** Die Vokabular-Blöcke des Vertrags, die diese Tabellen speichern — in der Reihenfolge der Funktion. */
    private static final List<String> LISTEN = List.of("konto", "konto_zustand", "art", "umfang", "aenderung");

    /** Die Blöcke, die Wörter von Ableitungen sind — keine Spalte. */
    private static final List<String> NICHT_GESPEICHERT =
            List.of("ocpp_stufe", "unterstuetzung_zustand", "rolle_noetig_reihenfolge");

    /** Jede Spalte, die ein Vertragswort trägt: Tabelle, Spalte, CHECK, Vokabular. */
    private static final List<List<String>> VOKABULAR_CHECKS = List.of(
            List.of("benutzer", "konto", "benutzer_konto_chk", "konto"),
            List.of("benutzer", "zustand", "benutzer_zustand_chk", "konto_zustand"),
            List.of("zugriff", "art", "zugriff_art_chk", "art"),
            List.of("zugriff", "umfang", "zugriff_umfang_chk", "umfang"),
            List.of("zugriff_protokoll", "aktion", "zugriff_protokoll_aktion_chk", "aenderung"),
            List.of("zugriff_protokoll", "art", "zugriff_protokoll_art_chk", "art"),
            List.of("zugriff_protokoll", "umfang", "zugriff_protokoll_umfang_chk", "umfang"));

    /** Jede Spalte, die eine Rolle der Matrix trägt: Tabelle, Spalte, CHECK. */
    private static final List<List<String>> ROLLEN_CHECKS = List.of(
            List.of("zugriff", "rolle", "zugriff_rolle_chk"),
            List.of("zugriff_protokoll", "rolle", "zugriff_protokoll_rolle_chk"),
            List.of("zugriff_protokoll", "actor_rolle", "zugriff_protokoll_actor_rolle_chk"));

    /** Das Akteur-Vokabular von AP-03 (wie kennzahl_aenderung) — kein Block des Rechte-Vertrags. */
    private static final List<String> AKTEUR_ARTEN = List.of("kunde", "unterstuetzung", "voltpilot", "notfall");

    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final OffsetDateTime AB = OffsetDateTime.parse("2026-10-15T00:00:00+02:00");
    private static final ProtokollAkteur JONAS = ProtokollAkteur.fuer("sub-jonas", "Jonas Wendlinger", false);

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static ZugriffRepository zugriffe;
    private static JsonNode vertrag;
    private static JsonNode matrix;
    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;

    private record Kunde(UUID tenant, UUID unternehmen, UUID standort, UUID standort2) {
    }

    @BeforeAll
    static void bestandUndMigration() throws IOException {
        vertrag = new ObjectMapper().readTree(VEKTOREN.toFile());
        matrix = new ObjectMapper().readTree(MATRIX.toFile());
        root = new JdbcTemplate(ds(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway(POSTGRES.getJdbcUrl()).target(letzteFassungVorDieser()).load().migrate();
        kunde("Kunststoffwerk Ahrenberg GmbH");
        kunde("Kundenbereich B");
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of());

        flyway(POSTGRES.getJdbcUrl()).target(DIESE).load().migrate();
        fingerNachMigration = Bestandsschutz.fingerabdruck(root, List.of());
        flyway(POSTGRES.getJdbcUrl()).load().migrate();

        app = new JdbcTemplate(new TenantAwareDataSource(ds(POSTGRES.getJdbcUrl(), APP_USER, APP_PW)));
        zugriffe = new ZugriffRepository(app);
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ============================================================ Vokabulare und Rollen zeilengleich

    @Test
    void dieVokabulareDerDatenbankSindZeileFuerZeileDieDesVertrags() {
        List<String> ausDemVertrag = new ArrayList<>();
        for (String liste : LISTEN) {
            int nr = 1;
            for (JsonNode wort : vertrag.path("vokabular").path(liste)) {
                ausDemVertrag.add(zeile(liste, nr++, wort.asText()));
            }
        }
        List<String> ausDerDatenbank = root.queryForList("SELECT format('(%L, %s, %L)', v.vokabular, v.nr, v.wort) "
                + "FROM zugriff_vokabular() WITH ORDINALITY AS v(vokabular, nr, wort, stelle) ORDER BY v.stelle",
                String.class);
        assertThat(ausDerDatenbank)
                .as("zugriff_vokabular() weicht von %s ab. Eine NEUE Migration ersetzt die Funktion mit diesem "
                        + "VALUES-Block (CREATE OR REPLACE FUNCTION, kein CHECK wird angefasst):%n%s", VEKTOREN,
                        String.join(",\n", ausDemVertrag))
                .isEqualTo(ausDemVertrag);

        Set<String> bloecke = new TreeSet<>();
        vertrag.path("vokabular").fieldNames().forEachRemaining(bloecke::add);
        Set<String> entschieden = new TreeSet<>(LISTEN);
        entschieden.addAll(NICHT_GESPEICHERT);
        assertThat(bloecke).as("jeder Vokabular-Block ist gespeichert oder ausdrücklich keine Spalte")
                .isEqualTo(entschieden);
        assertThat(LISTEN).doesNotContainAnyElementsOf(NICHT_GESPEICHERT);
    }

    @Test
    void dieRollenDerDatenbankSindZeileFuerZeileDieDerMatrixUndDesJavaZwillings() {
        List<String> ausDerMatrix = new ArrayList<>();
        int nr = 1;
        for (JsonNode r : matrix.path("rollen")) {
            ausDerMatrix.add(String.format("(%d, '%s', '%s', %s)", nr++, r.path("kennung").asText(),
                    r.path("geltungsbereich").asText(), r.path("zuweisbar").asBoolean()));
        }
        assertThat(root.queryForList("SELECT format('(%s, %L, %L, %s)', r.nr, r.rolle, r.geltungsbereich, r.zuweisbar::text) "
                + "FROM zugriff_rolle() WITH ORDINALITY AS r(nr, rolle, geltungsbereich, zuweisbar, stelle) "
                + "ORDER BY r.stelle", String.class))
                .as("zugriff_rolle() weicht von %s ab:%n%s", MATRIX, String.join(",\n", ausDerMatrix))
                .isEqualTo(ausDerMatrix);
        assertThat(root.queryForList("SELECT r.rolle FROM zugriff_rolle() WITH ORDINALITY AS r(nr, rolle, g, z, stelle) "
                + "ORDER BY r.stelle", String.class))
                .isEqualTo(Arrays.stream(Rolle.values()).map(Rolle::code).toList());
    }

    @Test
    void jederVokabularCheckFragtDieEineStelleUndJedesLiteralIstEinVertragswort() {
        for (List<String> c : VOKABULAR_CHECKS) {
            assertThat(definition(c.get(0), c.get(2))).as(c.toString())
                    .contains("zugriff_wort('" + c.get(3) + "'::text, " + c.get(1) + ")")
                    .doesNotContain(" IN (").doesNotContain("ANY (ARRAY[");
        }
        for (List<String> c : ROLLEN_CHECKS) {
            assertThat(definition(c.get(0), c.get(2))).as(c.toString())
                    .contains("zugriff_rolle_geltung(" + c.get(1) + ")")
                    .doesNotContain(" IN (").doesNotContain("ANY (ARRAY[");
        }
        Set<String> vertragswoerter = new TreeSet<>(AKTEUR_ARTEN);
        vertrag.path("vokabular").fieldNames().forEachRemaining(vertragswoerter::add);
        vertrag.path("vokabular").forEach(liste -> liste.forEach(w -> vertragswoerter.add(w.asText())));
        matrix.path("rollen").forEach(r -> {
            vertragswoerter.add(r.path("kennung").asText());
            vertragswoerter.add(r.path("geltungsbereich").asText());
        });
        Set<String> literale = new TreeSet<>();
        Pattern wort = Pattern.compile("'([a-z_]+)'::text");
        for (String def : root.queryForList("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE contype = 'c' "
                + "AND conrelid::regclass::text IN ('benutzer', 'zugriff', 'zugriff_protokoll')", String.class)) {
            Matcher m = wort.matcher(def);
            while (m.find()) {
                literale.add(m.group(1));
            }
        }
        assertThat(literale).contains("notfall", "zuweisen", "entziehen", "unternehmen", "standort_befristet",
                "plattform", "angelegt");
        assertThat(vertragswoerter).as("jedes Literal einer Regel ist ein Wort des Vertrags").containsAll(literale);
    }

    @Test
    void jedesWortDesVertragsIstSpeicherbarUndEinFremdesNie() {
        Kunde k = kunde("Woerter");
        String spiegel = "INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, ?, ?, ?)";
        for (JsonNode konto : vertrag.path("vokabular").path("konto")) {
            root.update(spiegel, k.tenant(), "konto-" + konto.asText(), konto.asText(), "Konto", "aktiv");
        }
        for (JsonNode zustand : vertrag.path("vokabular").path("konto_zustand")) {
            root.update(spiegel, k.tenant(), "zustand-" + zustand.asText(), "benutzer", "Konto", zustand.asText());
        }
        abgelehnt("benutzer_konto_chk", () -> root.update(spiegel, k.tenant(), "f1", "operator", "Konto", "aktiv"));
        abgelehnt("benutzer_zustand_chk", () -> root.update(spiegel, k.tenant(), "f2", "benutzer", "Konto", "deaktiviert"));

        benutzer(k, "sub-w");
        UUID eine = null;
        for (JsonNode r : matrix.path("rollen")) {
            String rolle = r.path("kennung").asText();
            switch (r.path("geltungsbereich").asText()) {
                case "unternehmen" -> eine = neu(root, "zugriff", zugriffZeile(k, "sub-w", rolle, null));
                case "standort" -> neu(root, "zugriff", zugriffZeile(k, "sub-w", rolle, k.standort()));
                case "standort_befristet" -> {
                    for (JsonNode art : vertrag.path("vokabular").path("art")) {
                        for (JsonNode umfang : vertrag.path("vokabular").path("umfang")) {
                            String sub = "sub-" + art.asText() + "-" + umfang.asText();
                            benutzer(k, sub);
                            neu(root, "zugriff", "notfall".equals(art.asText())
                                    ? notfall(k, sub, k.standort(), umfang.asText())
                                    : unterstuetzung(k, sub, k.standort(), art.asText(), umfang.asText(),
                                            LocalDate.of(2026, 11, 13)));
                        }
                    }
                }
                case "plattform" -> abgelehnt("zugriff_rolle_chk",
                        () -> neu(root, "zugriff", zugriffZeile(k, "sub-w", rolle, k.standort())));
                default -> throw new AssertionError("unbekannter Geltungsbereich " + r);
            }
        }
        // Ein Wort, das keine Rolle ist, hat keinen Geltungsbereich — die erste Regel, die es fragt, lehnt ab.
        abgelehnt("zugriff_geltungsbereich_chk", () -> neu(root, "zugriff", zugriffZeile(k, "sub-w", "operator", null)));
        abgelehnt("zugriff_art_chk", () -> neu(root, "zugriff",
                unterstuetzung(k, "sub-w", k.standort2(), "partner", "ansehen", LocalDate.of(2026, 11, 13))));
        abgelehnt("zugriff_umfang_chk", () -> neu(root, "zugriff",
                unterstuetzung(k, "sub-w", k.standort2(), "installateur", "bedienen", LocalDate.of(2026, 11, 13))));

        String protokoll = "INSERT INTO zugriff_protokoll (tenant_id, aktion, betroffener_sub, betroffener_name, "
                + "zugriff_id, rolle, art, umfang, actor_sub, actor_name, actor_rolle, actor_art) "
                + "VALUES (?, ?, 'sub-w', 'Wer', ?, ?, ?, ?, 'sub-jonas', 'Jonas Wendlinger', ?, 'kunde')";
        for (JsonNode aktion : vertrag.path("vokabular").path("aenderung")) {
            root.update(protokoll, k.tenant(), aktion.asText(), eine, "kundenadministrator", null, null,
                    "kundenadministrator");
        }
        for (JsonNode art : vertrag.path("vokabular").path("art")) {
            for (JsonNode umfang : vertrag.path("vokabular").path("umfang")) {
                root.update(protokoll, k.tenant(), "sperren", null, "unterstuetzer", art.asText(), umfang.asText(),
                        "kundenadministrator");
            }
        }
        for (JsonNode r : matrix.path("rollen")) {
            root.update(protokoll, k.tenant(), "sperren", null, null, null, null, r.path("kennung").asText());
        }
        abgelehnt("zugriff_protokoll_aktion_chk",
                () -> root.update(protokoll, k.tenant(), "gewaehren", null, null, null, null, null));
        abgelehnt("zugriff_protokoll_art_chk",
                () -> root.update(protokoll, k.tenant(), "sperren", null, null, "partner", null, null));
        abgelehnt("zugriff_protokoll_umfang_chk",
                () -> root.update(protokoll, k.tenant(), "sperren", null, null, null, "bedienen", null));
        abgelehnt("zugriff_protokoll_rolle_chk",
                () -> root.update(protokoll, k.tenant(), "sperren", null, "voltpilot_betrieb", null, null, null));
        abgelehnt("zugriff_protokoll_actor_rolle_chk",
                () -> root.update(protokoll, k.tenant(), "sperren", null, null, null, null, "operator"));
        abgelehnt("zugriff_protokoll_zugriff_chk",
                () -> root.update(protokoll, k.tenant(), "zuweisen", null, "leser", null, null, null));
    }

    // ============================================================ Geltungsbereich und Ende

    @Test
    void derGeltungsbereichFolgtDerRolle() {
        Kunde k = kunde("Geltung");
        benutzer(k, "sub-g");
        LocalDate bis = LocalDate.of(2026, 11, 13);
        // Unternehmensweit trägt keinen Standort, je Standort genau einen — auch der Unterstützer.
        abgelehnt("zugriff_geltungsbereich_chk",
                () -> neu(root, "zugriff", zugriffZeile(k, "sub-g", "kundenadministrator", k.standort())));
        abgelehnt("zugriff_geltungsbereich_chk", () -> neu(root, "zugriff", zugriffZeile(k, "sub-g", "leser", null)));
        abgelehnt("zugriff_geltungsbereich_chk",
                () -> neu(root, "zugriff", unterstuetzung(k, "sub-g", null, "installateur", "ansehen", bis)));
        // Die Unterstützung und nur sie trägt Art, Umfang und ein Ende.
        abgelehnt("zugriff_unterstuetzung_chk",
                () -> neu(root, "zugriff", zugriffZeile(k, "sub-g", "unterstuetzer", k.standort())));
        abgelehnt("zugriff_unterstuetzung_chk", () -> neu(root, "zugriff",
                mit(zugriffZeile(k, "sub-g", "leser", k.standort()), "art", "installateur", "umfang", "ansehen")));
        abgelehnt("zugriff_unterstuetzung_chk", () -> neu(root, "zugriff",
                mit(unterstuetzung(k, "sub-g", k.standort(), "installateur", "ansehen", bis), "umfang", null)));
        abgelehnt("zugriff_unterstuetzung_chk", () -> neu(root, "zugriff",
                mit(zugriffZeile(k, "sub-g", "unterstuetzer", k.standort()), "art", "installateur", "umfang", "ansehen")));
        // Die Plattform-Rolle ist keine Zuweisung (E8).
        abgelehnt("zugriff_rolle_chk",
                () -> neu(root, "zugriff", zugriffZeile(k, "sub-g", "voltpilot_betrieb", k.standort())));
        // Was passt, passt.
        neu(root, "zugriff", zugriffZeile(k, "sub-g", "kundenadministrator", null));
        neu(root, "zugriff", zugriffZeile(k, "sub-g", "leser", k.standort()));
        neu(root, "zugriff", unterstuetzung(k, "sub-g", k.standort(), "installateur", "ansehen", bis));
    }

    @Test
    void dasEndeIstEineTatsacheEnddatumEinschliesslichNurDerNotfallTraegtAlleinDenZeitpunkt() {
        Kunde k = kunde("Ende");
        for (String sub : List.of("sub-e1", "sub-e2", "sub-e3", "sub-e4", "sub-e5", "sub-e6")) {
            benutzer(k, sub);
        }
        // „bis 25.10.2026" (Umstellung auf Winterzeit) endet am 26.10.2026 um 00:00 +01:00 — wie bisZeitpunkt.
        LocalDate bis = LocalDate.of(2026, 10, 25);
        assertThat(RechteAbleitung.bisZeitpunkt(bis.toString()))
                .isEqualTo(OffsetDateTime.parse("2026-10-26T00:00:00+01:00").toInstant());
        neu(root, "zugriff", unterstuetzung(k, "sub-e1", k.standort(), "installateur", "einrichten", bis));
        // Das Enddatum mit einem anderen Zeitpunkt (Tagesbeginn statt Folgetag) ist zweierlei.
        abgelehnt("zugriff_ende_chk", () -> neu(root, "zugriff", mit(
                unterstuetzung(k, "sub-e2", k.standort(), "installateur", "einrichten", bis),
                "endet_am", OffsetDateTime.parse("2026-10-25T00:00:00+02:00"))));
        abgelehnt("zugriff_ende_chk", () -> neu(root, "zugriff", mit(
                unterstuetzung(k, "sub-e2", k.standort(), "installateur", "einrichten", bis), "endet_am", null)));
        // Der Notfall trägt allein den Zeitpunkt — nie ein Enddatum.
        neu(root, "zugriff", notfall(k, "sub-e3", k.standort(), "einrichten_und_bedienen"));
        abgelehnt("zugriff_ende_chk", () -> neu(root, "zugriff",
                mit(notfall(k, "sub-e4", k.standort(), "ansehen"), "gueltig_bis", LocalDate.of(2026, 10, 16))));
        // Jede andere Zuweisung trägt keinen Zeitpunkt ohne Enddatum.
        abgelehnt("zugriff_ende_chk", () -> neu(root, "zugriff",
                mit(zugriffZeile(k, "sub-e5", "leser", k.standort()), "endet_am", AB.plusDays(30))));
        // Ein Ende liegt nach dem Beginn.
        abgelehnt("zugriff_ende_chk", () -> neu(root, "zugriff",
                mit(unterstuetzung(k, "sub-e6", k.standort(), "voltpilot", "ansehen", LocalDate.of(2026, 10, 1)))));
        // Ein befristeter Leser: das Enddatum gilt einschließlich (der Vertrag kennt es für jede Zuweisung).
        neu(root, "zugriff", mit(zugriffZeile(k, "sub-e5", "leser", k.standort()), "gueltig_bis", bis,
                "endet_am", utc(RechteAbleitung.bisZeitpunkt(bis.toString()))));
    }

    /**
     * Die Zeitgültigkeit, gegen den Vertrag gespielt: JEDE Zuweisung jedes Falls der Vektoren (Kundenadministrator
     * bis Notfall, künftige, beendete, abgelaufene) wird über die App-Rolle eingetragen — eine Zeile je Standort —
     * und an ihrem Stichtag sowie an jeder Grenze (Beginn, Ende, Beenden, je eine Sekunde davor) gefragt. Die
     * Datenbank ({@code zugriff_zeitraum}, gelesen über {@link ZugriffRepository#wirksam}) sagt dasselbe wie
     * {@link Zuweisung#wirksam}, und die gelesene Zeile ist wieder die Zuweisung des Vertrags.
     */
    @Test
    void dieZeitgueltigkeitSagtFuerJedeZuweisungDesVertragsDasselbeWieDerJavaZwilling() {
        Kunde k = kunde("Vertragszeit");
        Map<String, UUID> standorte = new HashMap<>(Map.of("ST-1", k.standort(), "ST-2", k.standort2()));
        int traeger = 0;
        int zeilen = 0;
        int pruefungen = 0;
        Set<String> formen = new TreeSet<>();
        for (JsonNode fall : vertrag.path("cases")) {
            JsonNode input = fall.path("input");
            Instant jetzt = input.hasNonNull("jetzt") ? OffsetDateTime.parse(input.path("jetzt").asText()).toInstant() : null;
            for (JsonNode person : zuweisungsTraeger(input, new ArrayList<>())) {
                String sub = "v" + (traeger++) + "-" + fall.path("name").asText();
                benutzer(k, sub);
                Map<UUID, Zuweisung> soll = new LinkedHashMap<>();
                Set<Instant> zeitpunkte = new TreeSet<>();
                if (jetzt != null) {
                    zeitpunkte.add(jetzt);
                }
                for (JsonNode z : person.path("zuweisungen")) {
                    Zuweisung v = zuweisung(z);
                    Instant ende = RechteAbleitung.bisZeitpunkt(v.gueltigBis());
                    formen.add(v.gueltigBis() == null ? "offen" : v.gueltigBis().length() == 10 ? "enddatum" : "zeitpunkt");
                    for (Instant grenze : Arrays.asList(v.gueltigAb(), ende, v.beendetAm())) {
                        if (grenze != null) {
                            zeitpunkte.add(grenze);
                            zeitpunkte.add(grenze.minusSeconds(1));
                        }
                    }
                    List<String> orte = v.standorte() == null ? Collections.singletonList(null) : v.standorte();
                    for (String kz : orte) {
                        Map<String, Object> spalten = zugriffZeile(k, sub, v.rolle().code(),
                                kz == null ? null : standorte.computeIfAbsent(kz, x -> standort(k, x)));
                        spalten.putAll(mit(Map.of(), "art", code(v.art()), "umfang", code(v.umfang()),
                                "gueltig_ab", utc(v.gueltigAb()),
                                "gueltig_bis", v.gueltigBis() != null && v.gueltigBis().length() == 10
                                        ? LocalDate.parse(v.gueltigBis()) : null,
                                "endet_am", utc(ende), "beendet_am", utc(v.beendetAm()),
                                "beendet_von", v.beendetAm() == null ? null : "sub-jonas"));
                        UUID id = als(k.tenant(), () -> neu(app, "zugriff", spalten));
                        soll.put(id, new Zuweisung(v.rolle(), kz == null ? null : List.of(kz), v.umfang(), v.art(),
                                v.gueltigAb(), v.gueltigBis(), v.beendetAm()));
                        zeilen++;
                    }
                }
                String name = fall.path("name").asText();
                pruefungen += als(k.tenant(), () -> {
                    Map<UUID, Zeile> gelesen = zugriffe.zuweisungen(sub).stream()
                            .collect(Collectors.toMap(Zeile::id, z -> z));
                    assertThat(gelesen.keySet()).as(name).isEqualTo(soll.keySet());
                    for (Map.Entry<UUID, Zuweisung> e : soll.entrySet()) {
                        Zuweisung aus = gelesen.get(e.getKey()).alsZuweisung();
                        Zuweisung v = e.getValue();
                        assertThat(List.of(aus.rolle(), String.valueOf(aus.standorte()), String.valueOf(aus.umfang()),
                                String.valueOf(aus.art()), aus.gueltigAb(), String.valueOf(aus.beendetAm()),
                                String.valueOf(RechteAbleitung.bisZeitpunkt(aus.gueltigBis()))))
                                .as(name).isEqualTo(List.of(v.rolle(), String.valueOf(v.standorte()),
                                        String.valueOf(v.umfang()), String.valueOf(v.art()), v.gueltigAb(),
                                        String.valueOf(v.beendetAm()),
                                        String.valueOf(RechteAbleitung.bisZeitpunkt(v.gueltigBis()))));
                    }
                    for (Instant t : zeitpunkte) {
                        Set<UUID> datenbank = zugriffe.wirksam(sub, t).stream().map(Zeile::id)
                                .collect(Collectors.toSet());
                        Set<UUID> java = soll.entrySet().stream().filter(e -> e.getValue().wirksam(t))
                                .map(Map.Entry::getKey).collect(Collectors.toSet());
                        assertThat(datenbank).as("%s zu %s", name, t).isEqualTo(java);
                    }
                    return zeitpunkte.size();
                });
            }
        }
        assertThat(traeger).as("Personen mit Zuweisungen in den Vektoren").isGreaterThan(100);
        assertThat(zeilen).isGreaterThan(traeger);
        assertThat(pruefungen).isGreaterThan(500);
        assertThat(formen).contains("offen", "enddatum", "zeitpunkt");
    }

    // ============================================================ Beenden, nie umschreiben, Überlappung

    @Test
    void einZugriffWirdEinmalBeendetNieUmgeschriebenUndDanachNeuAngelegt() {
        Kunde k = kunde("Beenden");
        benutzer(k, "sub-murat");
        benutzer(k, "sub-sabine");
        Instant ab = AB.toInstant();
        UUID erster = als(k.tenant(), () -> zugriffe.zuweisen(new NeueZuweisung("sub-murat", Rolle.BEDIENBERECHTIGT,
                k.standort(), null, null, ab, null, null, BERLIN, "sub-jonas"), "Murat Demirci", JONAS, null));
        Instant beendet = OffsetDateTime.parse("2026-11-14T09:02:00+01:00").toInstant();
        assertThat(als(k.tenant(), () -> zugriffe.beenden(erster, beendet, JONAS, "Aufgabe gewechselt"))).isTrue();
        assertThat(als(k.tenant(), () -> zugriffe.beenden(erster, beendet.plusSeconds(60), JONAS, null)))
                .as("nur einmal").isFalse();
        alsTue(k.tenant(), () -> {
            assertThat(zugriffe.wirksam("sub-murat", beendet.minusSeconds(1))).extracting(Zeile::id)
                    .containsExactly(erster);
            assertThat(zugriffe.wirksam("sub-murat", beendet)).as("halboffen: ab dem Beenden nicht mehr").isEmpty();
            Zeile z = zugriffe.zuweisungen("sub-murat").get(0);
            assertThat(List.of(z.beendetAm(), z.beendetVon(), z.beendetGrund()))
                    .isEqualTo(List.of(beendet, "sub-jonas", "Aufgabe gewechselt"));
        });
        List<Map<String, Object>> protokoll = root.queryForList("SELECT aktion, grund, actor_name, actor_art, zugriff_id, "
                + "rolle, betroffener_name FROM zugriff_protokoll WHERE tenant_id = ? ORDER BY id", k.tenant());
        assertThat(protokoll).extracting(p -> p.get("aktion")).containsExactly("zuweisen", "entziehen");
        assertThat(protokoll.get(1)).containsEntry("grund", "Aufgabe gewechselt")
                .containsEntry("actor_name", "Jonas Wendlinger").containsEntry("actor_art", "kunde")
                .containsEntry("zugriff_id", erster).containsEntry("rolle", "bedienberechtigt")
                .containsEntry("betroffener_name", "sub-murat");

        // Beendet bleibt beendet — auch der Superuser schreibt es nicht um.
        abgelehnt("zugriff_einmal_beendet",
                () -> root.update("UPDATE zugriff SET beendet_grund = 'anders' WHERE id = ?", erster));
        // Neu ab dem Beenden: [ab, beendet) und [beendet, …) berühren sich nur.
        UUID zweiter = als(k.tenant(), () -> zugriffe.zuweisen(new NeueZuweisung("sub-murat", Rolle.BEDIENBERECHTIGT,
                k.standort(), null, null, beendet, null, null, BERLIN, "sub-jonas"), "Murat Demirci", JONAS, null));
        // Eine laufende Zuweisung: jede andere Änderung als das Beenden scheitert — für jede Rolle.
        abgelehnt("zugriff_nur_beenden", () -> root.update("UPDATE zugriff SET rolle = 'leser' WHERE id = ?", zweiter));
        abgelehnt("zugriff_nur_beenden", () -> root.update("UPDATE zugriff SET gueltig_ab = gueltig_ab - interval '1 day', "
                + "beendet_am = now(), beendet_von = 'sub-jonas' WHERE id = ?", zweiter));
        abgelehnt("zugriff_nur_beenden",
                () -> root.update("UPDATE zugriff SET beendet_grund = 'nur ein Grund' WHERE id = ?", zweiter));
        verweigert(() -> alsTue(k.tenant(), () -> app.update("UPDATE zugriff SET rolle = 'leser' WHERE id = ?", zweiter)));
        verweigert(() -> alsTue(k.tenant(), () -> app.update("DELETE FROM zugriff WHERE id = ?", zweiter)));
        // Beenden braucht eine Person; ein Grund ist freiwillig, aber nie leer.
        abgelehnt("zugriff_beendet_chk", () -> alsTue(k.tenant(),
                () -> app.update("UPDATE zugriff SET beendet_am = now() WHERE id = ?", zweiter)));
        abgelehnt("zugriff_beendet_chk", () -> alsTue(k.tenant(), () -> app.update(
                "UPDATE zugriff SET beendet_am = now(), beendet_von = 'sub-jonas', beendet_grund = '  ' WHERE id = ?",
                zweiter)));

        // Sabine ab 01.03.2027 (künftig) — vor dem Beginn beendet, wirkte sie nie und steht keiner neuen im Weg.
        Instant maerz = OffsetDateTime.parse("2027-03-01T00:00:00+01:00").toInstant();
        UUID kuenftig = als(k.tenant(), () -> zugriffe.zuweisen(new NeueZuweisung("sub-sabine", Rolle.LESER,
                k.standort2(), null, null, maerz, null, null, BERLIN, "sub-jonas"), "Sabine Rauch", JONAS, null));
        assertThat(als(k.tenant(), () -> zugriffe.beenden(kuenftig, beendet, JONAS, null))).isTrue();
        assertThat(als(k.tenant(), () -> zugriffe.wirksam("sub-sabine", maerz))).isEmpty();
        als(k.tenant(), () -> zugriffe.zuweisen(new NeueZuweisung("sub-sabine", Rolle.LESER, k.standort2(), null, null,
                maerz, null, null, BERLIN, "sub-jonas"), "Sabine Rauch", JONAS, null));
    }

    @Test
    void dasUeberlappungsverbotGiltJeBenutzerRolleUndStandort() {
        Kunde k = kunde("Ueberlappung");
        benutzer(k, "sub-o");
        benutzer(k, "sub-p");
        neu(root, "zugriff", zugriffZeile(k, "sub-o", "kundenadministrator", null));
        abgelehnt("zugriff_keine_ueberlappung", () -> neu(root, "zugriff",
                mit(zugriffZeile(k, "sub-o", "kundenadministrator", null), "gueltig_ab", AB.plusMonths(2))));
        // Eine andere Rolle, ein anderer Benutzer: frei.
        neu(root, "zugriff", zugriffZeile(k, "sub-o", "energiemanager", null));
        neu(root, "zugriff", zugriffZeile(k, "sub-p", "kundenadministrator", null));
        // Dieselbe Rolle an zwei Standorten: frei; zweimal am selben: nicht.
        neu(root, "zugriff", zugriffZeile(k, "sub-o", "leser", k.standort()));
        neu(root, "zugriff", zugriffZeile(k, "sub-o", "leser", k.standort2()));
        abgelehnt("zugriff_keine_ueberlappung",
                () -> neu(root, "zugriff", zugriffZeile(k, "sub-o", "leser", k.standort())));
        // „bis 15.12.2026" endet am 16.12. um 00:00 — die nächste Unterstützung beginnt dort, nicht davor.
        neu(root, "zugriff", unterstuetzung(k, "sub-p", k.standort(), "installateur", "einrichten_und_bedienen",
                LocalDate.of(2026, 12, 15)));
        OffsetDateTime folgetag = OffsetDateTime.parse("2026-12-16T00:00:00+01:00");
        neu(root, "zugriff", mit(unterstuetzung(k, "sub-p", k.standort(), "installateur", "einrichten_und_bedienen",
                LocalDate.of(2027, 1, 14)), "gueltig_ab", folgetag));
        abgelehnt("zugriff_keine_ueberlappung", () -> neu(root, "zugriff", mit(unterstuetzung(k, "sub-p", k.standort(),
                "voltpilot", "ansehen", LocalDate.of(2026, 12, 20)), "gueltig_ab", folgetag.minusMinutes(1))));
    }

    // ============================================================ Zaun, Rechte, Offboarding

    @Test
    void derMandantenzaunHaeltGegenEinenFremdenKundenbereich() {
        Kunde k = kunde("Zaun");
        Kunde fremd = kunde("Fremd");
        benutzer(k, "sub-zaun");
        benutzer(fremd, "sub-fremd");
        alsTue(k.tenant(), () -> zugriffe.zuweisen(NeueZuweisung.unternehmensweit("sub-zaun", Rolle.KUNDENADMINISTRATOR,
                AB.toInstant(), BERLIN, null), "Zaun", ProtokollAkteur.bestandsuebernahme(), "Bestandsübernahme"));
        for (String tabelle : TABELLEN) {
            assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname = ?",
                    Boolean.class, tabelle)).as(tabelle + " ENABLE + FORCE").isTrue();
            assertThat(als(k.tenant(), () -> app.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?",
                    Long.class, k.tenant()))).as(tabelle + " im eigenen Zaun").isPositive();
            assertThat(als(fremd.tenant(), () -> app.queryForObject("SELECT count(*) FROM " + tabelle
                    + " WHERE tenant_id = ?", Long.class, k.tenant()))).as(tabelle + " aus dem fremden Zaun").isZero();
            assertThat(app.queryForObject("SELECT count(*) FROM " + tabelle, Long.class)).as(tabelle + " ohne Zaun")
                    .isZero();
        }
        assertThat(als(fremd.tenant(), () -> zugriffe.zuweisungen("sub-zaun"))).isEmpty();
        // Schreiben in einen fremden Kundenbereich scheitert am WITH CHECK …
        verweigert(() -> alsTue(fremd.tenant(), () -> app.update("INSERT INTO benutzer (tenant_id, sub, konto, "
                + "anzeigename, zustand) VALUES (?, 'sub-x', 'benutzer', 'X', 'aktiv')", k.tenant())));
        verweigert(() -> alsTue(fremd.tenant(), () -> neu(app, "zugriff", zugriffZeile(k, "sub-zaun", "leser",
                k.standort()))));
        // … ein Verweis über den Zaun am Fremdschlüssel (der Mandant reist mit).
        abgelehnt("zugriff_standort_fk", () -> alsTue(k.tenant(), () -> neu(app, "zugriff",
                zugriffZeile(k, "sub-zaun", "leser", fremd.standort()))));
        abgelehnt("zugriff_benutzer_fk", () -> alsTue(k.tenant(), () -> neu(app, "zugriff",
                zugriffZeile(k, "sub-fremd", "leser", k.standort()))));
    }

    @Test
    void dieRechteSindBeschnitten() {
        assertThat(rechte(APP_USER, "benutzer")).isEqualTo("SI");
        assertThat(rechte(APP_USER, "zugriff")).isEqualTo("SI");
        assertThat(rechte(APP_USER, "zugriff_protokoll")).isEqualTo("SI");
        for (String spalte : List.of("anzeigename", "email", "zustand", "angenommen_am", "zuletzt_angemeldet")) {
            assertThat(spalte(APP_USER, "benutzer", spalte, "UPDATE")).as("benutzer." + spalte).isTrue();
        }
        for (String spalte : List.of("tenant_id", "sub", "konto", "eingeladen_am", "eingeladen_von", "created_at")) {
            assertThat(spalte(APP_USER, "benutzer", spalte, "UPDATE")).as("benutzer." + spalte).isFalse();
        }
        for (String spalte : List.of("beendet_am", "beendet_von", "beendet_grund")) {
            assertThat(spalte(APP_USER, "zugriff", spalte, "UPDATE")).as("zugriff." + spalte).isTrue();
        }
        for (String spalte : List.of("id", "tenant_id", "benutzer_sub", "rolle", "standort_id", "art", "umfang",
                "gueltig_ab", "gueltig_bis", "endet_am", "zeitzone", "gewaehrt_von", "created_at")) {
            assertThat(spalte(APP_USER, "zugriff", spalte, "UPDATE")).as("zugriff." + spalte).isFalse();
        }
        for (String spalte : List.of("aktion", "grund", "actor_name", "created_at")) {
            assertThat(spalte(APP_USER, "zugriff_protokoll", spalte, "UPDATE")).as("zugriff_protokoll." + spalte)
                    .isFalse();
        }
        for (String tabelle : TABELLEN) {
            assertThat(rechte(ADMIN_USER, tabelle)).as("die Verwaltungsrolle räumt nur ab: " + tabelle).isEqualTo("SD");
        }
        assertThat(root.queryForObject("SELECT has_sequence_privilege(?, 'zugriff_protokoll_id_seq', 'USAGE')",
                Boolean.class, APP_USER)).isTrue();
    }

    @Test
    void dasOffboardingRaeumtAlleDreiTabellenAb() {
        Kunde k = kunde("Offboarding");
        Kunde bleibt = kunde("Bleibt");
        for (Kunde kunde : List.of(k, bleibt)) {
            benutzer(kunde, "sub-off");
            alsTue(kunde.tenant(), () -> {
                UUID z = zugriffe.zuweisen(new NeueZuweisung("sub-off", Rolle.LESER, kunde.standort(), null, null,
                        AB.toInstant(), null, null, BERLIN, "sub-jonas"), "Off", JONAS, null);
                zugriffe.beenden(z, AB.plusDays(3).toInstant(), JONAS, "Probe");
            });
        }
        Map<String, Long> andere = new LinkedHashMap<>();
        for (String tabelle : TABELLEN) {
            assertThat(zahl(tabelle, k.tenant())).as(tabelle).isPositive();
            andere.put(tabelle, root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id <> ?",
                    Long.class, k.tenant()));
        }

        new TenantRepository(new JdbcTemplate(ds(POSTGRES.getJdbcUrl(), ADMIN_USER, ADMIN_PW))).offboard(k.tenant());

        for (String tabelle : TABELLEN) {
            assertThat(zahl(tabelle, k.tenant())).as(tabelle).isZero();
            assertThat(root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id <> ?", Long.class,
                    k.tenant())).as("andere Kundenbereiche bleiben: " + tabelle).isEqualTo(andere.get(tabelle));
        }
        for (String tabelle : List.of("standort", "unternehmen")) {
            assertThat(zahl(tabelle, k.tenant())).as(tabelle).isZero();
        }
        assertThat(root.queryForObject("SELECT count(*) FROM tenant WHERE id = ?", Long.class, k.tenant())).isZero();
    }

    // ============================================================ Bestand, out-of-order

    @Test
    void dieMigrationLegtNurDanebenUndLaesstDenBestandZeichengleich() {
        assertThat(fingerVorher).hasSizeGreaterThan(100).doesNotContainKeys(TABELLEN.toArray(String[]::new));
        assertThat(fingerVorher.get("standort")).as("es gibt Bestand").isNotEqualTo(Bestandsschutz.LEER);
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
        for (String tabelle : TABELLEN) {
            assertThat(fingerNachMigration).as(tabelle + " ist nach der Migration leer (den Bestand schreibt der "
                    + "Start-Lauf)").containsEntry(tabelle, Bestandsschutz.LEER);
        }
    }

    /** Der Vergleich beißt noch: eine geänderte Bestandszeile fällt auf. */
    @Test
    void derBestandsvergleichFaengtEineGeaenderteZeile() {
        Bestandsschutz.mutationsprobe(root, List.of(), "unternehmen", "UPDATE unternehmen SET name = name || ' (Probe)'");
    }

    /**
     * Out-of-order: eine Datenbank, auf der ALLE anderen Migrationen schon liegen (außer denen, die auf ihr
     * aufbauen — {@link #BAUEN_DARAUF_AUF}), bekommt diese als späte Ankunft — und hat danach dieselben Tabellen,
     * Constraints, Funktionen und Vokabulare wie die frische Datenbank in Versionsreihenfolge.
     */
    @Test
    void dieMigrationTraegtAuchAlsSpaeteAnkunft() throws IOException {
        root.execute("CREATE DATABASE voltpilot_spaet");
        Path ohneDiese = Files.createTempDirectory("migrationen-ohne-zugriff");
        try (var dateien = Files.list(MIGRATIONEN)) {
            for (Path datei : dateien.toList()) {
                String name = datei.getFileName().toString();
                if (!name.startsWith("V" + DIESE + "__")
                        && BAUEN_DARAUF_AUF.stream().noneMatch(v -> name.startsWith("V" + v + "__"))) {
                    Files.copy(datei, ohneDiese.resolve(datei.getFileName()));
                }
            }
        }
        String url = POSTGRES.getJdbcUrl().replaceFirst("/voltpilot(?=\\?|$)", "/voltpilot_spaet");
        flyway(url).locations("filesystem:" + ohneDiese.toAbsolutePath()).load().migrate();
        MigrateResult spaet = flyway(url).outOfOrder(true).load().migrate();
        List<String> spaeteAnkunft = new ArrayList<>(List.of(DIESE));
        spaeteAnkunft.addAll(BAUEN_DARAUF_AUF);
        assertThat(spaet.migrations).extracting(m -> m.version).containsExactlyElementsOf(spaeteAnkunft);

        JdbcTemplate db = new JdbcTemplate(ds(url, POSTGRES.getUsername(), POSTGRES.getPassword()));
        String tabellen = "('benutzer', 'zugriff', 'zugriff_protokoll')";
        for (String sql : List.of(
                "SELECT format('(%L, %s, %L)', vokabular, nr, wort) FROM zugriff_vokabular()",
                "SELECT format('(%s, %L, %L, %s)', nr, rolle, geltungsbereich, zuweisbar) FROM zugriff_rolle()",
                "SELECT table_name || '.' || column_name || ':' || data_type FROM information_schema.columns "
                        + "WHERE table_schema = 'public' AND table_name IN " + tabellen
                        + " ORDER BY table_name, ordinal_position",
                "SELECT conrelid::regclass::text || '.' || conname || ' ' || pg_get_constraintdef(oid) FROM pg_constraint "
                        + "WHERE conrelid::regclass::text IN " + tabellen + " ORDER BY 1",
                "SELECT tablename || ' ' || indexname || ' ' || indexdef FROM pg_indexes WHERE tablename IN " + tabellen
                        + " ORDER BY 1",
                "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text IN " + tabellen
                        + " ORDER BY 1",
                "SELECT polname || ' ' || pg_get_expr(polqual, polrelid) FROM pg_policy "
                        + "WHERE polrelid::regclass::text IN " + tabellen + " ORDER BY 1")) {
            assertThat(db.queryForList(sql, String.class)).as(sql).isNotEmpty()
                    .isEqualTo(root.queryForList(sql, String.class));
        }
    }

    // ============================================================ Hilfen

    private static String zeile(String vokabular, int nr, String wort) {
        return String.format("('%s', %d, '%s')", vokabular, nr, wort);
    }

    private static String definition(String tabelle, String constraint) {
        return root.queryForObject("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = ?::regclass "
                + "AND conname = ?", String.class, tabelle, constraint);
    }

    private static List<JsonNode> zuweisungsTraeger(JsonNode knoten, List<JsonNode> gefunden) {
        if (knoten.isObject()) {
            if (knoten.path("zuweisungen").isArray()) {
                gefunden.add(knoten);
            }
            knoten.forEach(kind -> zuweisungsTraeger(kind, gefunden));
        } else if (knoten.isArray()) {
            knoten.forEach(kind -> zuweisungsTraeger(kind, gefunden));
        }
        return gefunden;
    }

    private static Zuweisung zuweisung(JsonNode z) {
        List<String> standorte = null;
        if (z.path("standorte").isArray()) {
            standorte = new ArrayList<>();
            for (JsonNode s : z.path("standorte")) {
                standorte.add(s.asText());
            }
        }
        return new Zuweisung(Rolle.vonCode(z.path("rolle").asText()), standorte,
                z.hasNonNull("umfang") ? RechteAbleitung.Umfang.vonCode(z.path("umfang").asText()) : null,
                z.hasNonNull("art") ? RechteAbleitung.Art.vonCode(z.path("art").asText()) : null,
                OffsetDateTime.parse(z.path("gueltig_ab").asText()).toInstant(),
                z.hasNonNull("gueltig_bis") ? z.path("gueltig_bis").asText() : null,
                z.hasNonNull("beendet_am") ? OffsetDateTime.parse(z.path("beendet_am").asText()).toInstant() : null);
    }

    private static Kunde kunde(String name) {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, name);
        UUID st = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u);
        UUID st2 = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Lindach', 'ST-2', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u);
        return new Kunde(t, u, st, st2);
    }

    private static UUID standort(Kunde k, String kurzzeichen) {
        return root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, k.tenant(),
                k.unternehmen(), "Standort " + kurzzeichen, kurzzeichen);
    }

    private static void benutzer(Kunde k, String sub) {
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', ?, "
                + "'aktiv')", k.tenant(), sub, sub);
    }

    private static Map<String, Object> zugriffZeile(Kunde k, String sub, String rolle, UUID standort) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("tenant_id", k.tenant());
        m.put("benutzer_sub", sub);
        m.put("rolle", rolle);
        m.put("standort_id", standort);
        m.put("gueltig_ab", AB);
        m.put("zeitzone", "Europe/Berlin");
        return m;
    }

    private static Map<String, Object> unterstuetzung(Kunde k, String sub, UUID standort, String art, String umfang,
            LocalDate bis) {
        return mit(zugriffZeile(k, sub, "unterstuetzer", standort), "art", art, "umfang", umfang, "gueltig_bis", bis,
                "endet_am", utc(RechteAbleitung.bisZeitpunkt(bis.toString())));
    }

    /** Notfall-Zugriff: genau 24 h als Zeitpunkt-Zeitraum, ohne Enddatum. */
    private static Map<String, Object> notfall(Kunde k, String sub, UUID standort, String umfang) {
        return mit(zugriffZeile(k, sub, "unterstuetzer", standort), "art", "notfall", "umfang", umfang,
                "endet_am", AB.plusHours(24));
    }

    private static Map<String, Object> mit(Map<String, Object> basis, Object... paare) {
        Map<String, Object> m = new LinkedHashMap<>(basis);
        for (int i = 0; i < paare.length; i += 2) {
            m.put((String) paare[i], paare[i + 1]);
        }
        return m;
    }

    private static UUID neu(JdbcTemplate db, String tabelle, Map<String, Object> spalten) {
        String sql = "INSERT INTO " + tabelle + " (" + String.join(", ", spalten.keySet()) + ") VALUES ("
                + String.join(", ", Collections.nCopies(spalten.size(), "?")) + ") RETURNING id";
        return db.queryForObject(sql, UUID.class, spalten.values().toArray());
    }

    private static OffsetDateTime utc(Instant t) {
        return t == null ? null : t.atOffset(ZoneOffset.UTC);
    }

    private static String code(RechteAbleitung.Code c) {
        return c == null ? null : c.code();
    }

    private static long zahl(String tabelle, UUID tenant) {
        return root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?", Long.class, tenant);
    }

    private static String rechte(String rolle, String tabelle) {
        StringBuilder s = new StringBuilder();
        for (String[] r : new String[][] {{"S", "SELECT"}, {"I", "INSERT"}, {"U", "UPDATE"}, {"D", "DELETE"},
                {"T", "TRUNCATE"}}) {
            if (Boolean.TRUE.equals(root.queryForObject("SELECT has_table_privilege(?, ?, ?)", Boolean.class, rolle,
                    tabelle, r[1]))) {
                s.append(r[0]);
            }
        }
        return s.toString();
    }

    private static boolean spalte(String rolle, String tabelle, String spalte, String recht) {
        return Boolean.TRUE.equals(root.queryForObject("SELECT has_column_privilege(?, ?, ?, ?)", Boolean.class,
                rolle, tabelle, spalte, recht));
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

    private static PSQLException psql(Runnable arbeit, String erwartet) {
        Throwable t = null;
        try {
            arbeit.run();
        } catch (Throwable e) {
            t = e;
        }
        assertThat(t).as("die Datenbank muss ablehnen (" + erwartet + ")").isNotNull();
        PSQLException p = null;
        for (Throwable c = t; c != null; c = c.getCause()) {
            if (c instanceof PSQLException pe) {
                p = pe;
            }
        }
        assertThat((Object) p).as("eine PSQLException: " + t).isNotNull();
        return p;
    }

    private static void abgelehnt(String constraint, Runnable arbeit) {
        PSQLException p = psql(arbeit, constraint);
        assertThat(p.getServerErrorMessage().getConstraint()).as(p.getMessage()).isEqualTo(constraint);
    }

    private static void verweigert(Runnable arbeit) {
        PSQLException p = psql(arbeit, "42501");
        assertThat(p.getSQLState()).as(p.getMessage()).isEqualTo("42501");
    }

    private static String letzteFassungVorDieser() {
        MigrationVersion diese = MigrationVersion.fromVersion(DIESE);
        return Arrays.stream(flyway(POSTGRES.getJdbcUrl()).load().info().all())
                .map(MigrationInfo::getVersion)
                .filter(v -> v != null && v.compareTo(diese) < 0)
                .max(Comparator.naturalOrder())
                .orElseThrow()
                .getVersion();
    }

    private static FluentConfiguration flyway(String url) {
        return Flyway.configure()
                .dataSource(url, POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW));
    }

    private static DataSource ds(String url, String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(url);
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
