package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.io.IOException;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
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
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * UEMS AP-11 IP-4: die Kennzahl-Tabellen ({@code V20260915003000}) gegen den Vertrag
 * {@code docs/contracts/v2/kennzahl-vectors.json} — Testcontainers, Docker nötig (sonst übersprungen).
 *
 * <ul>
 *   <li><b>Vokabulare zeilengleich:</b> {@code kennzahl_vokabular()} ist Zeile für Zeile der Vertrag, jeder
 *       Vokabular-CHECK fragt nur sie, jeder Vokabular-Block ist entschieden (gespeichert oder nicht), die Wörter
 *       ohne Block kommen aus den Vektoren.</li>
 *   <li><b>Werte append-only:</b> UPDATE und DELETE auf {@code kennzahl_wert} und {@code kennzahl_wert_eingang}
 *       scheitern für jede Rolle — auch die Verwaltungsrolle MIT Recht und den Eigentümer; jede Regel
 *       {@code wert} der Vektoren steht so in der Tabelle, die Versionsfolge (Q7/V3) hält.</li>
 *   <li><b>Exklusion der Fassungen:</b> nie zwei an einem Tag, nur verkürzt, zeilengleich zur Formel-Fassung.</li>
 *   <li><b>Eingang:</b> genau ein Verweis, nie die eigene Kennzahl.</li>
 *   <li>Mandantenzaun, Rechte, Kennzeichen-Verlauf, Offboarding, Referenzunternehmen, Bestandsschutz — und die
 *       Migration auf frischer Datenbank wie als spät ankommende (out-of-order).</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsKennzahlMigrationTest {

    private static final String DIESE = "20260915003000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts", "v2", "kennzahl-vectors.json");
    private static final Path REFERENZ = Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");
    private static final Path MIGRATIONEN = Path.of("src", "main", "resources", "db", "migration");
    /**
     * Migrationen, die auf den Kennzahl-Tabellen AUFBAUEN (AP-11 IP-5: Löschen ohne Wert) — ohne diese Migration gibt
     * es ihre Tabellen nicht; in der späten Ankunft kommen sie darum mit ihr, nicht vor ihr.
     */
    private static final List<String> BAUEN_DARAUF_AUF = List.of("20260915020000",
            "20260924071500", // AP-17 IP-6: die Bezugsbasis verweist auf ihre Kennzahl.
            "20260924200500", // AP-17 IP-15: Anstoß-Wort und Wasserzeichen auf den Tabellen von IP-6.
            "20260924211800", // AP-17 IP-21b: der Leistungsvergleich verweist auf seine Kennzahl.
            "20260924214500", // AP-17 IP-23: weitet den CHECK des Wasserzeichens aus IP-15.
            "20260924223000", // AP-18 IP-5: das Energieziel verweist auf seine Kennzahl.
            "20260924233000", // AP-18 IP-9: die Messgrundlage der Maßnahme verweist auf ihre Kennzahl.
            "20260924235130", // AP-18 IP-14: Vermerk und Abweichung verweisen auf ihre Kennzahl.
            "20260925040000", // AP-19 IP-17: tauscht den Herkunft-CHECK der Maßnahme.
            "20260925093000"); // AP-19 IP-23: eine Folge der Managementbewertung nennt ein Energieziel.
    private static final List<String> TABELLEN = List.of("kennzahl", "kennzahl_kennzeichen_verlauf", "kennzahl_fassung",
            "kennzahl_eingang", "kennzahl_wert", "kennzahl_wert_eingang", "kennzahl_aenderung");

    /** Die Vokabular-Blöcke des Vertrags, die diese Tabellen speichern — in der Reihenfolge der Funktion. */
    private static final List<String> LISTEN = List.of("rechenform", "eingang_art", "eingang_rolle", "periode_art",
            "geltung_art", "zustand", "richtung_unsicherheit", "grund_ohne_zahl", "protokoll");

    /**
     * Die Blöcke, die Wörter von Antworten und Rechten sind — keine Spalte. {@code eingang_art_anfrage} nennt zusätzlich
     * {@code bezugsflaeche}: so heißt die Bezugsfläche eines Orts in einer ANFRAGE; gespeichert wird daraus eine
     * Bezugsgröße, also ein Wort aus {@code eingang_art} (siehe {@code uems-flaeche-als-nenner.md}).
     */
    private static final List<String> NICHT_GESPEICHERT = List.of("rechenform_vorgesehen", "eingang_art_anfrage",
            "fehler", "sichtbarkeit", "ereignisse_reserviert", "rechte");

    /** Jede Spalte, die ein Vertragswort trägt: Tabelle, Spalte, CHECK, Vokabular. */
    private static final List<List<String>> VOKABULAR_CHECKS = List.of(
            List.of("kennzahl", "rechenform", "kennzahl_rechenform_chk", "rechenform"),
            List.of("kennzahl", "geltung_art", "kennzahl_geltung_art_chk", "geltung_art"),
            List.of("kennzahl_fassung", "rechenform", "kennzahl_fassung_rechenform_chk", "rechenform"),
            List.of("kennzahl_eingang", "rechenform", "kennzahl_eingang_rechenform_chk", "rechenform"),
            List.of("kennzahl_eingang", "rolle", "kennzahl_eingang_rolle_chk", "eingang_rolle"),
            List.of("kennzahl_eingang", "art", "kennzahl_eingang_art_chk", "eingang_art"),
            List.of("kennzahl_wert", "periode_art", "kennzahl_wert_periode_art_chk", "periode_art"),
            List.of("kennzahl_wert", "menge_zustand", "kennzahl_wert_menge_zustand_chk", "zustand"),
            List.of("kennzahl_wert", "richtung", "kennzahl_wert_richtung_chk", "richtung_unsicherheit"),
            List.of("kennzahl_wert", "grund", "kennzahl_wert_grund_chk", "grund_ohne_zahl"),
            List.of("kennzahl_wert_eingang", "rolle", "kennzahl_wert_eingang_rolle_chk", "eingang_rolle"),
            List.of("kennzahl_wert_eingang", "art", "kennzahl_wert_eingang_art_chk", "eingang_art"),
            List.of("kennzahl_wert_eingang", "menge_zustand", "kennzahl_wert_eingang_menge_zustand_chk", "zustand"),
            List.of("kennzahl_aenderung", "art", "kennzahl_aenderung_art_chk", "protokoll"));

    private static final LocalDate OKTOBER = LocalDate.of(2026, 10, 1);
    private static final OffsetDateTime GERECHNET = OffsetDateTime.parse("2026-11-01T00:20:00+01:00");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static JdbcTemplate admin;
    private static JsonNode vertrag;
    private static Map<String, String> fingerVorher;
    private static Map<String, String> fingerNachMigration;

    private record Kunde(UUID tenant, UUID unternehmen, UUID standort, UUID gebaeude, UUID bereich, UUID messstelle,
            UUID prozess, UUID kostenstelle, UUID bezugsgroesse) {
    }

    /** Eine Kennzahl mit ihrer ersten Fassung. */
    private record Kz(UUID id, UUID fassung, String rechenform) {
    }

    @BeforeAll
    static void bestandUndMigration() throws IOException {
        vertrag = new ObjectMapper().readTree(VEKTOREN.toFile());
        root = new JdbcTemplate(ds(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway(POSTGRES.getJdbcUrl()).target(letzteFassungVorDieser()).load().migrate();
        kunde("Kunststoffwerk Ahrenberg GmbH");
        kunde("Kundenbereich B");
        fingerVorher = Bestandsschutz.fingerabdruck(root, List.of());

        flyway(POSTGRES.getJdbcUrl()).target(DIESE).load().migrate();
        fingerNachMigration = Bestandsschutz.fingerabdruck(root, List.of());
        flyway(POSTGRES.getJdbcUrl()).load().migrate();

        app = new JdbcTemplate(new TenantAwareDataSource(ds(POSTGRES.getJdbcUrl(), APP_USER, APP_PW)));
        admin = new JdbcTemplate(ds(POSTGRES.getJdbcUrl(), ADMIN_USER, ADMIN_PW));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ============================================================ Vokabulare zeilengleich

    @Test
    void dieVokabulareDerDatenbankSindZeileFuerZeileDieDesVertrags() {
        List<String> ausDemVertrag = new ArrayList<>();
        for (String liste : LISTEN) {
            int nr = 0;
            for (JsonNode wort : vertrag.path("vokabulare").path(liste)) {
                ausDemVertrag.add(zeile(liste, ++nr, wort.asText()));
            }
        }
        List<String> ausDerDatenbank = root.queryForList("SELECT format('(%L, %s, %L)', v.vokabular, v.nr, v.wort) "
                + "FROM kennzahl_vokabular() WITH ORDINALITY AS v(vokabular, nr, wort, stelle) ORDER BY v.stelle",
                String.class);

        assertThat(ausDemVertrag).as("der Vertrag hat Vokabulare — sonst bewiese Gleichheit nichts").hasSizeGreaterThan(30);
        assertThat(ausDerDatenbank)
                .as("kennzahl_vokabular() weicht von %s ab. Eine NEUE Migration ersetzt die Funktion mit diesem "
                        + "VALUES-Block (CREATE OR REPLACE FUNCTION, kein CHECK wird angefasst):%n%s",
                        VEKTOREN, String.join(",\n", ausDemVertrag))
                .containsExactlyElementsOf(ausDemVertrag);

        Set<String> bloecke = new LinkedHashSet<>();
        vertrag.path("vokabulare").fieldNames().forEachRemaining(bloecke::add);
        Set<String> entschieden = new LinkedHashSet<>(LISTEN);
        entschieden.addAll(NICHT_GESPEICHERT);
        assertThat(bloecke).as("jeder Vokabular-Block des Vertrags ist entschieden: gespeichert (LISTEN) oder "
                + "ausdrücklich keine Spalte (NICHT_GESPEICHERT)").containsExactlyInAnyOrderElementsOf(entschieden);
    }

    @Test
    void jederVokabularCheckFragtDieEineStelleUndTraegtKeineEigeneListe() {
        for (List<String> c : VOKABULAR_CHECKS) {
            assertThat(definition(c.get(0), c.get(2))).as(c.get(2))
                    .contains("kennzahl_wort('" + c.get(3) + "'::text, " + c.get(1) + ")")
                    .doesNotContain(" IN (").doesNotContain("ANY");
        }
        // Keine Spalte mit einem Vertragswort ohne ihren CHECK. (`kennzahl_aenderung.grund` ist Freitext wie an
        // bezugsgroesse_aenderung — kein Wort von `grund_ohne_zahl`.)
        assertThat(root.queryForList("SELECT table_name || '.' || column_name FROM information_schema.columns "
                + "WHERE table_schema = 'public' AND table_name = ANY (?::text[]) AND column_name IN ('rechenform', "
                + "'geltung_art', 'rolle', 'art', 'periode_art', 'menge_zustand', 'richtung', 'grund') "
                + "AND (table_name, column_name) <> ('kennzahl_aenderung', 'grund')", String.class,
                "{" + String.join(",", TABELLEN) + "}"))
                .containsExactlyInAnyOrderElementsOf(VOKABULAR_CHECKS.stream().map(c -> c.get(0) + "." + c.get(1)).toList());
    }

    @Test
    void dieWoerterOhneVokabularBlockKommenAusDenVektorenUndVorgesehenesIstNichtSpeicherbar() {
        Set<String> anlassArten = new TreeSet<>();
        for (JsonNode anlass : vertrag.path("cases").findValues("anlass")) {
            if (anlass.isObject()) {
                anlassArten.add(anlass.path("art").asText());
            }
        }
        assertThat(anlassArten).as("die Vektoren kennen Anlässe").isNotEmpty();
        assertThat(woerter(definition("kennzahl_wert", "kennzahl_wert_anlass_art_chk")))
                .as("anlass_art spricht genau die Wörter von anlass.art der Regel wert").isEqualTo(anlassArten);
        // `produkt` ist vorgesehen, nicht gebaut (rechenform_unbekannt): keine Spalte nimmt es an.
        for (JsonNode wort : vertrag.path("vokabulare").path("rechenform_vorgesehen")) {
            assertThat(root.queryForObject("SELECT kennzahl_wort('rechenform', ?)", Boolean.class, wort.asText()))
                    .as(wort.asText()).isFalse();
        }
    }

    @Test
    void jedesWortDesVertragsIstSpeicherbarUndEinFremdesNie() {
        Kunde k = kunde("Wörter");
        int nr = 100;
        for (String form : liste("rechenform")) {
            kennzahl(k, "KZ-0" + nr++, form, "standort");
        }
        for (String art : liste("geltung_art")) {
            kennzahlZeile(k, "KZ-0" + nr++, "quotient", art);
        }
        abgelehnt("kennzahl_rechenform_chk", () -> kennzahlZeile(k, "KZ-0901", "produkt", "standort"));
        abgelehnt("kennzahl_rechenform_chk", () -> kennzahlZeile(k, "KZ-0902", "mittel", "standort"));
        abgelehnt("kennzahl_geltung_art_chk", () -> kennzahlZeile(k, "KZ-0903", "quotient", "filiale"));
        // G1: genau das Objekt der Art.
        abgelehnt("kennzahl_geltung_objekt_chk", () -> alsTue(k.tenant(), () -> app.update("INSERT INTO kennzahl "
                + "(tenant_id, kennzeichen, name, rechenform, geltung_art, standort_id, verantwortlich_name) VALUES "
                + "(?, 'KZ-0904', 'Falsch gebunden', 'quotient', 'gebaeude', ?, 'Ines Krüger')", k.tenant(), k.standort())));

        Kz quotient = kennzahl(k, "KZ-0" + nr++, "quotient", "gebaeude");
        Kz anteil = kennzahl(k, "KZ-0" + nr++, "anteil", "standort");
        Kz zusammen = kennzahl(k, "KZ-0" + nr++, "zusammenfassung", "unternehmen");
        eingang(k, quotient, 0, "zaehler", "messstelle", k.messstelle());
        eingang(k, quotient, 1, "nenner", "bezugsgroesse", k.bezugsgroesse());
        eingang(k, anteil, 0, "zaehler", "messstelle", k.messstelle());
        eingang(k, anteil, 1, "nenner", "messstelle", k.messstelle());
        eingang(k, zusammen, 0, "paar", "kennzahl", quotient.id());
        abgelehnt("kennzahl_eingang_rolle_chk", () -> eingang(k, zusammen, 1, "teil", "kennzahl", anteil.id()));
        abgelehnt("kennzahl_eingang_art_chk", () -> eingang(k, zusammen, 1, "paar", "konstante", k.messstelle()));

        int monat = 0;
        for (String zustand : liste("zustand")) {
            LocalDate p = monat(monat++);
            Map<String, Object> z = wertZeile(k, quotient, p, 1, "vorlaeufig");
            wert(switch (zustand) {
                case "keine Werte" -> wertZeile(k, quotient, p, null, null);
                case "unvollständig" -> mit(z, "menge_zustand", zustand, "richtung", "untergrenze");
                default -> mit(z, "menge_zustand", zustand);
            });
        }
        for (String richtung : liste("richtung_unsicherheit")) {
            wert(mit(wertZeile(k, quotient, monat(monat++), 1, "vorlaeufig"), "menge_zustand", "unvollständig",
                    "richtung", richtung));
        }
        for (String grund : liste("grund_ohne_zahl")) {
            wert(mit(wertZeile(k, quotient, monat(monat++), null, null), "grund", grund));
        }
        LocalDate frei = monat(monat);
        abgelehnt("kennzahl_wert_menge_zustand_chk", () -> wert(mit(wertZeile(k, quotient, frei, 1, "vorlaeufig"),
                "menge_zustand", "teilweise")));
        abgelehnt("kennzahl_wert_richtung_chk", () -> wert(mit(wertZeile(k, quotient, frei, 1, "vorlaeufig"),
                "menge_zustand", "unvollständig", "richtung", "aufwaerts")));
        abgelehnt("kennzahl_wert_grund_chk", () -> wert(mit(wertZeile(k, quotient, frei, null, null),
                "grund", "division_durch_null")));
        abgelehnt("kennzahl_wert_periode_art_chk", () -> wert(mit(wertZeile(k, quotient, frei, 1, "vorlaeufig"),
                "periode_art", "quartal")));

        // Das Protokoll spricht die drei Wörter des Vertrags — die Wörter der Konzept-Tabelle §6.1 nicht.
        for (String art : liste("protokoll")) {
            protokoll(k, quotient.id(), art);
        }
        abgelehnt("kennzahl_aenderung_art_chk", () -> protokoll(k, quotient.id(), "angelegt"));
        abgelehnt("kennzahl_aenderung_art_chk", () -> protokoll(k, quotient.id(), "wiederhergestellt"));
    }

    // ============================================================ Werte: Vektoren, Versionen, append-only

    /** Jede Regel {@code wert} der Vektoren — mit ihrem früheren Wert — steht genau so in der Tabelle. */
    @Test
    void dieErgebnisseDerRegelWertStehenSoInDerTabelle() {
        Kunde k = kunde("Vektoren");
        Kz kz = kennzahl(k, "KZ-0004", "quotient", "prozess");
        int n = 0;
        for (JsonNode fall : vertrag.path("cases")) {
            for (JsonNode p : fall.path("pruefungen")) {
                if (!"wert".equals(p.path("regel").asText())) {
                    continue;
                }
                String name = fall.path("id").asText() + " " + p.path("name").asText();
                LocalDate periode = monat(n++);
                JsonNode r = p.path("ergebnis");
                Integer version = r.path("version").isNumber() ? r.path("version").asInt() : null;
                String zustand = switch (r.path("fassung").asText("")) {
                    case "vorläufig" -> "vorlaeufig";
                    case "endgültig" -> "endgueltig";
                    default -> null;
                };
                boolean mitAnlass = version != null && version >= 2;
                Map<String, Object> zeile = mit(wertZeile(k, kz, periode, version, zustand),
                        "wert", dezimal(r.path("wert")), "zaehler", dezimal(r.path("zaehler")),
                        "nenner", dezimal(r.path("nenner")), "menge_zustand", r.path("zustand").asText(),
                        "richtung", text(r.path("richtung")), "grund", text(r.path("grund")),
                        "abdeckung_prozent", dezimal(r.path("abdeckung_prozent")),
                        "kennzeichen", r.path("kennzeichen").isArray() ? r.path("kennzeichen").toString() : "[]",
                        "anlass_art", mitAnlass ? p.path("eingang").path("anlass").path("art").asText() : null,
                        "anlass_kennung", mitAnlass ? "Anlass " + fall.path("id").asText() : null);

                JsonNode bisher = p.path("eingang").path("bisher");
                if (bisher.isObject()) {
                    boolean endgueltig = bisher.path("endgueltig").asBoolean();
                    OffsetDateTime frueher = GERECHNET.minusDays(1);
                    wert(mit(wertZeile(k, kz, periode, bisher.path("version").asInt(), endgueltig ? "endgueltig" : "vorlaeufig"),
                            "berechnet_am", frueher, "endgueltig_ab", endgueltig ? frueher : null));
                    // Die falsche Folge: endgültig bleibt nie dieselbe Version, vorläufig bekommt keine neue.
                    int falsch = endgueltig ? bisher.path("version").asInt() : bisher.path("version").asInt() + 1;
                    abgelehnt("kennzahl_wert_version_folgt", () -> wert(mit(zeile, "version", falsch,
                            "anlass_art", falsch >= 2 ? "eingang" : null, "anlass_kennung", falsch >= 2 ? "falsch" : null)));
                }
                try {
                    wert(zeile);
                } catch (RuntimeException e) {
                    throw new AssertionError(name + ": " + e.getMessage(), e);
                }
            }
        }
        assertThat(n).as("die Vektoren haben Regeln wert").isGreaterThan(25);
    }

    @Test
    void einKennzahlWertWirdVonKeinerRolleGeaendertOderGeloescht() {
        Kunde k = kunde("Append-only");
        Kz kz = kennzahl(k, "KZ-0001", "quotient", "gebaeude");
        UUID v1 = wert(wertZeile(k, kz, OKTOBER, 1, "endgueltig"));
        dazu(admin, "kennzahl_wert_eingang", wertEingangZeile(k, kz, v1, 0, "zaehler", "messstelle", k.messstelle()));

        for (String tabelle : List.of("kennzahl_wert", "kennzahl_wert_eingang")) {
            String schluessel = tabelle.equals("kennzahl_wert") ? "id" : "wert_id";
            for (String sql : List.of("UPDATE " + tabelle + " SET kennzeichen = '[]'::jsonb WHERE " + schluessel + " = ?",
                    "DELETE FROM " + tabelle + " WHERE " + schluessel + " = ?")) {
                // Die Anwendung und die Verwaltungsrolle haben das Recht nicht …
                verweigert(() -> alsTue(k.tenant(), () -> app.update(sql, v1)));
                verweigert(() -> admin.update(sql, v1));
                // … aber der Schutz ist der TRIGGER: die Verwaltungsrolle MIT Recht und der Eigentümer scheitern auch.
                abgelehnt(tabelle + "_append_only", () -> zurueckgerollt(root, () -> {
                    root.execute("GRANT UPDATE, DELETE ON " + tabelle + " TO " + ADMIN_USER);
                    root.execute("SET LOCAL ROLE " + ADMIN_USER);
                    root.update(sql, v1);
                }));
                abgelehnt(tabelle + "_append_only", () -> root.update(sql, v1));
            }
            assertThat(root.queryForObject("SELECT has_table_privilege(?, ?, 'DELETE')", Boolean.class, ADMIN_USER,
                    tabelle)).as("das GRANT der Probe ist zurückgerollt: " + tabelle).isFalse();
        }
        assertThat(zahl("kennzahl_wert", k.tenant())).isEqualTo(1L);
        assertThat(zahl("kennzahl_wert_eingang", k.tenant())).isEqualTo(1L);

        // Der eine Ausgang: nur die Verwaltungsrolle ruft ihn, und er schließt sich im selben Aufruf wieder.
        verweigert(() -> alsTue(k.tenant(), () -> app.queryForObject(
                "SELECT uems_kennzahlwerte_des_kundenbereichs_entfernen(?)", Long.class, k.tenant())));
        zurueckgerollt(root, () -> {
            root.execute("SET LOCAL ROLE " + ADMIN_USER);
            assertThat(root.queryForObject("SELECT uems_kennzahlwerte_des_kundenbereichs_entfernen(?)", Long.class,
                    k.tenant())).isEqualTo(2L);
            assertThat(root.queryForObject("SELECT current_setting('uems.kennzahlwerte_entfernen', true)", String.class))
                    .as("die Kennzeichnung ist nach dem Aufruf zurückgenommen").isEmpty();
        });
        assertThat(zahl("kennzahl_wert", k.tenant())).as("zurückgerollt").isEqualTo(1L);

        // Q7/V3: die Versionsfolge je Periode.
        LocalDate nov = OKTOBER.plusMonths(1);
        wert(wertZeile(k, kz, nov, null, null)); // K8: ohne Zahl noch keine Version
        abgelehnt("kennzahl_wert_version_folgt", () -> wert(mit(wertZeile(k, kz, nov, 1, "vorlaeufig"),
                "berechnet_am", GERECHNET.plusMinutes(10), "wert", null, "menge_zustand", "keine Werte",
                "grund", "nenner_fehlt")));
        abgelehnt("kennzahl_wert_ohne_version_chk", () -> wert(mit(wertZeile(k, kz, nov, null, null),
                "berechnet_am", GERECHNET.plusMinutes(5), "menge_zustand", "vollständig", "grund", null,
                "wert", new BigDecimal("0.15"), "nenner", new BigDecimal("41000"))));
        abgelehnt("kennzahl_wert_version_folgt", () -> wert(mit(wertZeile(k, kz, nov, 2, "vorlaeufig"),
                "berechnet_am", GERECHNET.plusHours(1), "anlass_art", "eingang", "anlass_kennung", "K-2026-0007")));
        wert(mit(wertZeile(k, kz, nov, 1, "vorlaeufig"), "berechnet_am", GERECHNET.plusHours(1)));
        // Nach einer Zahl ist auch „ohne Zahl" eine Version (K19).
        abgelehnt("kennzahl_wert_version_folgt", () -> wert(mit(wertZeile(k, kz, nov, null, null),
                "berechnet_am", GERECHNET.plusHours(2))));
        // Vorläufig: keine neue Version, sondern nachziehen (V3) — nie vor der neuesten Zeile.
        abgelehnt("kennzahl_wert_version_folgt", () -> wert(mit(wertZeile(k, kz, nov, 2, "vorlaeufig"),
                "berechnet_am", GERECHNET.plusHours(2), "anlass_art", "eingang", "anlass_kennung", "K-2026-0007")));
        wert(mit(wertZeile(k, kz, nov, 1, "vorlaeufig"), "berechnet_am", GERECHNET.plusHours(2),
                "wert", new BigDecimal("0.1473")));
        abgelehnt("kennzahl_wert_version_folgt", () -> wert(mit(wertZeile(k, kz, nov, 1, "vorlaeufig"),
                "berechnet_am", GERECHNET.plusMinutes(90))));
        wert(mit(wertZeile(k, kz, nov, 1, "endgueltig"), "berechnet_am", GERECHNET.plusHours(3),
                "endgueltig_ab", GERECHNET.plusHours(3)));
        // Endgültig: nur Version n + 1, und die mit Anlass (K7).
        abgelehnt("kennzahl_wert_version_folgt", () -> wert(mit(wertZeile(k, kz, nov, 1, "endgueltig"),
                "berechnet_am", GERECHNET.plusHours(4), "endgueltig_ab", GERECHNET.plusHours(4))));
        abgelehnt("kennzahl_wert_anlass_chk", () -> wert(mit(wertZeile(k, kz, nov, 2, "endgueltig"),
                "berechnet_am", GERECHNET.plusHours(4), "endgueltig_ab", GERECHNET.plusHours(4))));
        wert(mit(wertZeile(k, kz, nov, 2, "endgueltig"), "berechnet_am", GERECHNET.plusHours(4),
                "endgueltig_ab", GERECHNET.plusHours(4), "anlass_art", "eingang",
                "anlass_kennung", "K-2026-0007 (freigegeben 12.11.2026)"));
        assertThat(root.queryForList("SELECT coalesce(version::text, '-') || ':' || coalesce(zustand, '-') "
                + "FROM kennzahl_wert WHERE kennzahl_id = ? AND periode_von = ? ORDER BY berechnet_am", String.class,
                kz.id(), nov))
                .as("nichts überschrieben: jede Neubildung ist eine Zeile")
                .containsExactly("-:-", "1:vorlaeufig", "1:vorlaeufig", "1:endgueltig", "2:endgueltig");
    }

    // ============================================================ Fassungen

    @Test
    void dieFassungenSchliessenSichTageweiseAusUndWerdenNurVerkuerzt() {
        Kunde k = kunde("Fassungen");
        Kz kz = kennzahl(k, "KZ-0004", "quotient", "prozess"); // K17: Fassung 1 gilt seit Beginn
        Map<String, Object> zwei = mit(fassungZeile(k, kz.id(), 2, "quotient", "kWh/kg"),
                "gueltig_ab", LocalDate.parse("2027-03-01"), "rueckwirkend", true,
                "begruendung", "Zähler MS-24 misst Spritzguss einschließlich Kühlung");
        abgelehnt("kennzahl_fassung_keine_ueberlappung", () -> als(k.tenant(), () -> neu(app, "kennzahl_fassung", zwei)));
        alsTue(k.tenant(), () -> app.update("UPDATE kennzahl_fassung SET gueltig_bis = '2027-02-28' WHERE id = ?",
                kz.fassung()));
        UUID f2 = als(k.tenant(), () -> neu(app, "kennzahl_fassung", zwei));
        abgelehnt("kennzahl_fassung_keine_ueberlappung", () -> als(k.tenant(), () -> neu(app, "kennzahl_fassung",
                mit(zwei, "nummer", 3, "gueltig_ab", LocalDate.parse("2027-02-15")))));

        // Nur verkürzt, nie verlängert, nie umgeschrieben — auch nicht vom Eigentümer.
        abgelehnt("kennzahl_fassung_nur_verkuerzen", () -> alsTue(k.tenant(), () -> app.update(
                "UPDATE kennzahl_fassung SET gueltig_bis = '2027-03-15' WHERE id = ?", kz.fassung())));
        abgelehnt("kennzahl_fassung_unveraenderlich", () -> root.update(
                "UPDATE kennzahl_fassung SET einheit = 'kWh/t' WHERE id = ?", kz.fassung()));
        abgelehnt("kennzahl_fassung_unveraenderlich", () -> root.update(
                "UPDATE kennzahl_fassung SET gueltig_ab = '2027-03-02' WHERE id = ?", f2));
        verweigert(() -> alsTue(k.tenant(), () -> app.update("UPDATE kennzahl_fassung SET faktor = 2 WHERE id = ?", f2)));
        verweigert(() -> alsTue(k.tenant(), () -> app.update("DELETE FROM kennzahl_fassung WHERE id = ?", f2)));

        // Eine aufgehobene Fassung belegt keinen Tag mehr — und bleibt aufgehoben.
        alsTue(k.tenant(), () -> app.update("UPDATE kennzahl_fassung SET aufgehoben_am = now() WHERE id = ?", f2));
        als(k.tenant(), () -> neu(app, "kennzahl_fassung", mit(zwei, "nummer", 3)));
        abgelehnt("kennzahl_fassung_aufgehoben", () -> root.update(
                "UPDATE kennzahl_fassung SET aufgehoben_am = NULL WHERE id = ?", f2));

        // Nur Fassung 1 ohne ersten Tag; Anlage und Kopie sind Fassung 1; kein Bestand.
        LocalDate spaeter = LocalDate.parse("2028-01-01");
        abgelehnt("kennzahl_fassung_ab_chk", () -> als(k.tenant(), () -> neu(app, "kennzahl_fassung",
                mit(zwei, "nummer", 4, "gueltig_ab", null))));
        abgelehnt("kennzahl_fassung_herkunft_nummer_chk", () -> als(k.tenant(), () -> neu(app, "kennzahl_fassung",
                mit(zwei, "nummer", 4, "gueltig_ab", spaeter, "herkunft", "kopie"))));
        abgelehnt("kennzahl_fassung_herkunft_chk", () -> als(k.tenant(), () -> neu(app, "kennzahl_fassung",
                mit(zwei, "nummer", 4, "gueltig_ab", spaeter, "herkunft", "bestand"))));
        // Komplement nur am Anteil, Faktor > 0 nur am Quotienten, Prozent genau am Anteil (U1).
        abgelehnt("kennzahl_fassung_komplement_chk", () -> als(k.tenant(), () -> neu(app, "kennzahl_fassung",
                mit(zwei, "nummer", 4, "gueltig_ab", spaeter, "komplement", true))));
        abgelehnt("kennzahl_fassung_faktor_chk", () -> als(k.tenant(), () -> neu(app, "kennzahl_fassung",
                mit(zwei, "nummer", 4, "gueltig_ab", spaeter, "faktor", BigDecimal.ZERO))));
        abgelehnt("kennzahl_fassung_einheit_chk", () -> als(k.tenant(), () -> neu(app, "kennzahl_fassung",
                mit(zwei, "nummer", 4, "gueltig_ab", spaeter, "einheit", "%"))));
        Kz anteil = kennzahl(k, "KZ-0006", "anteil", "standort");
        Map<String, Object> anteilZwei = mit(fassungZeile(k, anteil.id(), 2, "anteil", "%"), "gueltig_ab", spaeter);
        abgelehnt("kennzahl_fassung_einheit_chk", () -> als(k.tenant(), () -> neu(app, "kennzahl_fassung",
                mit(anteilZwei, "einheit", "kWh/kWh"))));
        abgelehnt("kennzahl_fassung_faktor_chk", () -> als(k.tenant(), () -> neu(app, "kennzahl_fassung",
                mit(anteilZwei, "faktor", new BigDecimal("1000")))));

        // V4: die Rechenform der Fassung ist die der Kennzahl und nach der ersten Fassung fest; der Geltungsbereich ebenso.
        Kz fest = kennzahl(k, "KZ-0007", "quotient", "gebaeude");
        alsTue(k.tenant(), () -> app.update("UPDATE kennzahl_fassung SET gueltig_bis = '2026-12-31' WHERE id = ?",
                fest.fassung()));
        abgelehnt("kennzahl_fassung_kennzahl_fk", () -> als(k.tenant(), () -> neu(app, "kennzahl_fassung",
                mit(fassungZeile(k, fest.id(), 2, "anteil", "%"), "gueltig_ab", LocalDate.parse("2027-01-01")))));
        abgelehnt("kennzahl_fassung_kennzahl_fk", () -> alsTue(k.tenant(), () -> app.update(
                "UPDATE kennzahl SET rechenform = 'anteil' WHERE id = ?", fest.id())));
        abgelehnt("kennzahl_geltung_nach_erster_fassung", () -> alsTue(k.tenant(), () -> app.update(
                "UPDATE kennzahl SET geltung_art = 'standort', ort_id = NULL, standort_id = ? WHERE id = ?",
                k.standort(), fest.id())));
        // Name, Verantwortlicher und Zweck ändern sich ohne Fassung; vor der ersten Fassung ist alles offen.
        alsTue(k.tenant(), () -> app.update("UPDATE kennzahl SET name = 'Stromeinsatz Montage je Stück', "
                + "verantwortlich_sub = 'sub-jonas', verantwortlich_name = 'Jonas Albers', zweck = 'Vergleich der Linien' "
                + "WHERE id = ?", fest.id()));
        UUID entwurf = kennzahlZeile(k, "KZ-0008", "quotient", "gebaeude");
        alsTue(k.tenant(), () -> app.update("UPDATE kennzahl SET rechenform = 'anteil', geltung_art = 'standort', "
                + "ort_id = NULL, standort_id = ? WHERE id = ?", k.standort(), entwurf));
    }

    @Test
    void dieFassungIstZeilengleichZurFormelFassung() {
        assertThat(spalten("kennzahl_fassung", Set.of("kennzahl_id", "rechenform", "komplement", "faktor", "einheit")))
                .as("kennzahl_fassung ist zeilengleich zu messstelle_formel_fassung (§6.1, E7). Hat die Formel-Fassung "
                        + "eine Spalte bekommen, gehört sie additiv auch hierher — oder ist formel-eigen und wird hier benannt.")
                .containsExactlyElementsOf(spalten("messstelle_formel_fassung",
                        Set.of("messstelle_id", "formel_typ", "rest_hauptzaehler_id")));
        assertThat(spalten("kennzahl_fassung", Set.of()))
                .containsSequence("id:uuid", "tenant_id:uuid", "kennzahl_id:uuid", "nummer:integer", "rechenform:text")
                .endsWith("komplement:boolean", "faktor:numeric", "einheit:text");
    }

    // ============================================================ Eingänge

    @Test
    void einEingangHatGenauEinenVerweisUndNieDieEigeneKennzahl() {
        Kunde k = kunde("Eingänge");
        Kz a = kennzahl(k, "KZ-0011", "quotient", "gebaeude");
        Kz b = kennzahl(k, "KZ-0012", "quotient", "gebaeude");
        Kz z = kennzahl(k, "KZ-0013", "zusammenfassung", "unternehmen");
        eingang(k, a, 0, "zaehler", "messstelle", k.messstelle());
        eingang(k, a, 1, "nenner", "bezugsgroesse", k.bezugsgroesse());

        Map<String, Object> ohne = mit(eingangZeile(k, b, 0, "zaehler", "messstelle", null));
        abgelehnt("kennzahl_eingang_genau_ein_verweis_chk", () -> alsTue(k.tenant(), () -> neu(app, "kennzahl_eingang", ohne)));
        abgelehnt("kennzahl_eingang_genau_ein_verweis_chk", () -> alsTue(k.tenant(), () -> neu(app, "kennzahl_eingang",
                mit(ohne, "messstelle_id", k.messstelle(), "bezugsgroesse_id", k.bezugsgroesse()))));
        abgelehnt("kennzahl_eingang_genau_ein_verweis_chk", () -> alsTue(k.tenant(), () -> neu(app, "kennzahl_eingang",
                mit(ohne, "art", "bezugsgroesse", "messstelle_id", k.messstelle()))));
        // K16: der Selbstverweis — die Raute über eine andere Kennzahl ist erlaubt (der Kreis ist die Regel des Schreibwegs).
        abgelehnt("kennzahl_eingang_kein_selbstverweis_chk", () -> eingang(k, b, 0, "zaehler", "kennzahl", b.id()));
        eingang(k, b, 0, "zaehler", "kennzahl", a.id());
        // Zähler und Nenner höchstens einmal; ein Paar nur in der Zusammenfassung und nur an einer Kennzahl.
        abgelehnt("uq_kennzahl_eingang_rolle", () -> eingang(k, a, 2, "zaehler", "messstelle", k.messstelle()));
        abgelehnt("kennzahl_eingang_rolle_je_rechenform_chk", () -> eingang(k, a, 2, "paar", "kennzahl", b.id()));
        eingang(k, z, 0, "paar", "kennzahl", a.id());
        eingang(k, z, 1, "paar", "kennzahl", b.id());
        abgelehnt("uq_kennzahl_eingang_paar", () -> eingang(k, z, 2, "paar", "kennzahl", a.id()));
        abgelehnt("kennzahl_eingang_rolle_je_rechenform_chk", () -> eingang(k, z, 2, "zaehler", "messstelle", k.messstelle()));
        abgelehnt("kennzahl_eingang_rolle_je_rechenform_chk", () -> eingang(k, z, 2, "paar", "messstelle", k.messstelle()));
        // Ein Eingang hängt an der Fassung SEINER Kennzahl, mit deren Rechenform.
        Kz c = kennzahl(k, "KZ-0014", "quotient", "gebaeude");
        abgelehnt("kennzahl_eingang_fassung_fk", () -> alsTue(k.tenant(), () -> neu(app, "kennzahl_eingang",
                mit(eingangZeile(k, b, 0, "zaehler", "messstelle", k.messstelle()), "fassung_id", c.fassung()))));
        abgelehnt("kennzahl_eingang_fassung_fk", () -> alsTue(k.tenant(), () -> neu(app, "kennzahl_eingang",
                mit(eingangZeile(k, c, 0, "paar", "kennzahl", a.id()), "rechenform", "zusammenfassung"))));
        // Historie ihrer Fassung.
        verweigert(() -> alsTue(k.tenant(), () -> app.update("UPDATE kennzahl_eingang SET position = 5 WHERE kennzahl_id = ?", a.id())));
        verweigert(() -> alsTue(k.tenant(), () -> app.update("DELETE FROM kennzahl_eingang WHERE kennzahl_id = ?", a.id())));

        // Der Eingangs-Wert eines Werts ebenso: genau ein Verweis, nie die eigene Kennzahl.
        UUID w = wert(wertZeile(k, b, OKTOBER, 1, "endgueltig"));
        abgelehnt("kennzahl_wert_eingang_kein_selbstverweis_chk", () -> dazu(admin, "kennzahl_wert_eingang",
                wertEingangZeile(k, b, w, 0, "zaehler", "kennzahl", b.id())));
        abgelehnt("kennzahl_wert_eingang_genau_ein_verweis_chk", () -> dazu(admin, "kennzahl_wert_eingang",
                mit(wertEingangZeile(k, b, w, 0, "zaehler", "messstelle", k.messstelle()), "bezugsgroesse_id", k.bezugsgroesse())));
        abgelehnt("kennzahl_wert_eingang_paar_chk", () -> dazu(admin, "kennzahl_wert_eingang",
                mit(wertEingangZeile(k, b, w, 0, "zaehler", "messstelle", k.messstelle()), "zaehler", 6100)));
        dazu(admin, "kennzahl_wert_eingang", wertEingangZeile(k, b, w, 0, "zaehler", "kennzahl", a.id()));
    }

    // ============================================================ Zaun, Rechte, Kennzeichen

    @Test
    void derMandantenzaunHaeltGegenEinenFremdenKundenbereich() {
        Kunde k = kunde("Zaun");
        Kunde fremd = kunde("Fremd");
        vollstaendig(k);
        Kz fremde = kennzahl(fremd, "KZ-0001", "quotient", "standort");
        for (String tabelle : TABELLEN) {
            assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname = ?",
                    Boolean.class, tabelle)).as(tabelle + " ENABLE + FORCE").isTrue();
            assertThat(als(k.tenant(), () -> app.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?",
                    Long.class, k.tenant()))).as(tabelle + " im eigenen Zaun").isPositive();
            assertThat(als(fremd.tenant(), () -> app.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?",
                    Long.class, k.tenant()))).as(tabelle + " aus dem fremden Zaun").isZero();
            assertThat(app.queryForObject("SELECT count(*) FROM " + tabelle, Long.class)).as(tabelle + " ohne Zaun").isZero();
        }
        // Schreiben in einen fremden Kundenbereich scheitert am WITH CHECK …
        verweigert(() -> alsTue(fremd.tenant(), () -> app.update("INSERT INTO kennzahl (tenant_id, kennzeichen, name, "
                + "rechenform, geltung_art, standort_id, verantwortlich_name) VALUES (?, 'KZ-0099', 'Fremd', 'quotient', "
                + "'standort', ?, 'Ines Krüger')", k.tenant(), k.standort())));
        // … ein Verweis über den Zaun am Fremdschlüssel (der Mandant reist mit).
        abgelehnt("kennzahl_standort_fk", () -> alsTue(k.tenant(), () -> app.update("INSERT INTO kennzahl (tenant_id, "
                + "kennzeichen, name, rechenform, geltung_art, standort_id, verantwortlich_name) VALUES (?, 'KZ-0098', "
                + "'Fremder Standort', 'quotient', 'standort', ?, 'Ines Krüger')", k.tenant(), fremd.standort())));
        Kz eigene = kennzahl(k, "KZ-0097", "quotient", "standort");
        abgelehnt("kennzahl_eingang_messstelle_fk", () -> eingang(k, eigene, 0, "zaehler", "messstelle", fremd.messstelle()));
        abgelehnt("kennzahl_eingang_bezugsgroesse_fk", () -> eingang(k, eigene, 1, "nenner", "bezugsgroesse", fremd.bezugsgroesse()));
        abgelehnt("kennzahl_eingang_kennzahl_fk", () -> eingang(k, eigene, 0, "zaehler", "kennzahl", fremde.id()));
    }

    @Test
    void dieRechteSindBeschnitten() {
        assertThat(rechte(APP_USER, "kennzahl")).isEqualTo("SI");
        assertThat(rechte(APP_USER, "kennzahl_kennzeichen_verlauf")).isEqualTo("S");
        assertThat(rechte(APP_USER, "kennzahl_fassung")).isEqualTo("SI");
        assertThat(rechte(APP_USER, "kennzahl_eingang")).isEqualTo("SI");
        assertThat(rechte(APP_USER, "kennzahl_wert")).isEqualTo("S");
        assertThat(rechte(APP_USER, "kennzahl_wert_eingang")).isEqualTo("S");
        assertThat(rechte(APP_USER, "kennzahl_aenderung")).isEqualTo("SI");
        for (String spalte : List.of("kennzeichen", "name", "rechenform", "geltung_art", "ort_id", "verantwortlich_sub",
                "verantwortlich_name", "zweck", "archiviert_am")) {
            assertThat(spalte(APP_USER, "kennzahl", spalte, "UPDATE")).as("kennzahl." + spalte).isTrue();
        }
        for (String spalte : List.of("id", "tenant_id", "angelegt_am")) {
            assertThat(spalte(APP_USER, "kennzahl", spalte, "UPDATE")).as("kennzahl." + spalte).isFalse();
        }
        assertThat(spalte(APP_USER, "kennzahl_fassung", "gueltig_bis", "UPDATE")).isTrue();
        assertThat(spalte(APP_USER, "kennzahl_fassung", "aufgehoben_am", "UPDATE")).isTrue();
        for (String spalte : List.of("gueltig_ab", "rechenform", "komplement", "faktor", "einheit", "begruendung")) {
            assertThat(spalte(APP_USER, "kennzahl_fassung", spalte, "UPDATE")).as("kennzahl_fassung." + spalte).isFalse();
        }
        // Die Verwaltungsrolle: lesen, Werte anhängen, Definition im Offboarding löschen — Werte nie löschen.
        for (String tabelle : List.of("kennzahl", "kennzahl_kennzeichen_verlauf", "kennzahl_fassung", "kennzahl_eingang",
                "kennzahl_aenderung")) {
            assertThat(rechte(ADMIN_USER, tabelle)).as(tabelle).isEqualTo("SD");
        }
        assertThat(rechte(ADMIN_USER, "kennzahl_wert")).isEqualTo("S");
        assertThat(rechte(ADMIN_USER, "kennzahl_wert_eingang")).isEqualTo("SI");
        assertThat(spalte(ADMIN_USER, "kennzahl_wert", "wert", "INSERT")).isTrue();
        assertThat(spalte(ADMIN_USER, "kennzahl_wert", "created_at", "INSERT")).as("die Rechenzeit setzt die DB").isFalse();
        for (String rolle : List.of(APP_USER, ADMIN_USER)) {
            assertThat(root.queryForObject("SELECT has_sequence_privilege(?, 'kennzahl_aenderung_id_seq', 'USAGE')",
                    Boolean.class, rolle)).as(rolle).isTrue();
        }
        assertThat(funktion(ADMIN_USER, "uems_kennzahlwerte_des_kundenbereichs_entfernen(uuid)")).isTrue();
        assertThat(funktion(APP_USER, "uems_kennzahlwerte_des_kundenbereichs_entfernen(uuid)")).isFalse();
        assertThat(funktion(APP_USER, "kennzahl_kennzeichen_belegen()")).isFalse();
    }

    @Test
    void einEinmalVergebenesKennzeichenBleibtBelegtUndDasProtokollBleibt() {
        Kunde k = kunde("Kennzeichen");
        UUID kz = kennzahlZeile(k, "KZ-0001", "quotient", "gebaeude");
        alsTue(k.tenant(), () -> app.update("UPDATE kennzahl SET kennzeichen = 'KZ-0101' WHERE id = ?", kz));
        assertThat(root.queryForList("SELECT kennzeichen FROM kennzahl_kennzeichen_verlauf WHERE kennzahl_id = ? "
                + "ORDER BY kennzeichen", String.class, kz)).containsExactly("KZ-0001", "KZ-0101");
        abgelehnt("kennzahl_kennzeichen_belegt", () -> kennzahlZeile(k, "KZ-0001", "quotient", "gebaeude"));
        // Zum EIGENEN früheren Kennzeichen darf sie zurück.
        alsTue(k.tenant(), () -> app.update("UPDATE kennzahl SET kennzeichen = 'KZ-0001' WHERE id = ?", kz));
        protokoll(k, kz, "kennzahl_geaendert");
        abgelehntMitMeldung("audit rows are append-only",
                () -> root.update("UPDATE kennzahl_kennzeichen_verlauf SET belegt_am = now() WHERE kennzahl_id = ?", kz));
        abgelehntMitMeldung("audit rows are append-only",
                () -> root.update("UPDATE kennzahl_aenderung SET grund = 'x' WHERE kennzahl_id = ?", kz));
    }

    // ============================================================ Löschwege und Offboarding

    @Test
    void einOrtMitKennzahlTraegtHistorieUndBleibt() {
        Kunde k = kunde("Ort mit Kennzahl");
        kennzahlZeile(k, "KZ-0001", "quotient", "bereich");
        PSQLException p = psql(() -> alsTue(k.tenant(), () -> app.queryForObject("SELECT uems_ort_loeschen(?)",
                Boolean.class, k.bereich())), "23503");
        assertThat(p.getSQLState()).as(p.getMessage()).isEqualTo("23503");
        assertThat(p.getServerErrorMessage().getConstraint()).isEqualTo("kennzahl_ort_fk");
        assertThat(root.queryForObject("SELECT count(*) FROM ort WHERE id = ?", Long.class, k.bereich())).isEqualTo(1L);
    }

    @Test
    void dasOffboardingRaeumtAlleSiebenTabellenAb() {
        Kunde k = kunde("Offboarding");
        vollstaendig(k);
        Kunde bleibt = kunde("Bleibt");
        vollstaendig(bleibt);
        Map<String, Long> vorher = new LinkedHashMap<>();
        Map<String, Long> andere = new LinkedHashMap<>();
        for (String tabelle : TABELLEN) {
            vorher.put(tabelle, zahl(tabelle, k.tenant()));
            andere.put(tabelle, root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id <> ?",
                    Long.class, k.tenant()));
        }
        assertThat(vorher).as("jede Tabelle hat Zeilen des Kundenbereichs").allSatisfy((t, n) -> assertThat(n).isPositive());

        new TenantRepository(new JdbcTemplate(ds(POSTGRES.getJdbcUrl(), ADMIN_USER, ADMIN_PW))).offboard(k.tenant());

        for (String tabelle : TABELLEN) {
            assertThat(zahl(tabelle, k.tenant())).as(tabelle).isZero();
            assertThat(root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id <> ?", Long.class,
                    k.tenant())).as("andere Kundenbereiche bleiben: " + tabelle).isEqualTo(andere.get(tabelle));
        }
        for (String tabelle : List.of("bezugsgroesse", "prozess", "kostenstelle", "messstelle", "ort", "standort",
                "unternehmen")) {
            assertThat(zahl(tabelle, k.tenant())).as(tabelle).isZero();
        }
        assertThat(root.queryForObject("SELECT count(*) FROM tenant WHERE id = ?", Long.class, k.tenant())).isZero();
    }

    // ============================================================ Referenzunternehmen, Bestand, out-of-order

    @Test
    void dieKennzahlenDesReferenzunternehmensPassenInDieTabellen() throws IOException {
        JsonNode referenz = new ObjectMapper().readTree(REFERENZ.toFile());
        assertThat(referenz.path("kennzahlen")).hasSize(5);
        Kunde k = kunde("Kunststoffwerk Ahrenberg (Referenz)");
        Map<String, Kz> nachKennzeichen = new LinkedHashMap<>();
        for (JsonNode z : referenz.path("kennzahlen")) {
            String form = z.path("rechenform").asText();
            String art = z.path("geltung_art").asText();
            UUID id = als(k.tenant(), () -> app.queryForObject("INSERT INTO kennzahl (tenant_id, kennzeichen, name, "
                    + "rechenform, geltung_art, " + geltungsSpalte(art) + ", verantwortlich_name, zweck) "
                    + "VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id", UUID.class, k.tenant(), z.path("kennzeichen").asText(),
                    z.path("name").asText(), form, art, geltungsObjekt(k, art), z.path("verantwortlich").asText(),
                    text(z.path("zweck"))));
            UUID fassung = als(k.tenant(), () -> neu(app, "kennzahl_fassung",
                    fassungZeile(k, id, 1, form, z.path("einheit").asText())));
            Kz kz = new Kz(id, fassung, form);
            nachKennzeichen.put(z.path("kennzeichen").asText(), kz);
            if (z.path("paare").isArray()) {
                int position = 0;
                for (JsonNode paar : z.path("paare")) {
                    eingang(k, kz, position++, "paar", "kennzahl", nachKennzeichen.get(paar.asText()).id());
                }
            } else {
                eingang(k, kz, 0, "zaehler", "messstelle", k.messstelle());
                eingang(k, kz, 1, "nenner", "bezugsgroesse", k.bezugsgroesse());
            }
        }
        assertThat(zahl("kennzahl", k.tenant())).isEqualTo(5L);
        assertThat(zahl("kennzahl_eingang", k.tenant())).as("vier Quotienten mit zwei Eingängen, KZ-0003 mit zwei Paaren")
                .isEqualTo(10L);
    }

    @Test
    void dieMigrationLegtNurDanebenUndLaesstDenBestandZeichengleich() {
        assertThat(fingerVorher).hasSizeGreaterThan(100).doesNotContainKeys(TABELLEN.toArray(String[]::new));
        assertThat(fingerVorher.get("standort")).as("es gibt Bestand").isNotEqualTo(Bestandsschutz.LEER);
        assertThat(fingerVorher.get("bezugsgroesse")).as("es gibt Bestand").isNotEqualTo(Bestandsschutz.LEER);
        assertThat(Bestandsschutz.abweichungen(fingerVorher, fingerNachMigration)).isEmpty();
        for (String tabelle : TABELLEN) {
            assertThat(fingerNachMigration).as(tabelle).containsEntry(tabelle, Bestandsschutz.LEER);
        }
    }

    /** Der Vergleich beißt noch: eine geänderte Bestandszeile fällt auf. */
    @Test
    void derBestandsvergleichFaengtEineGeaenderteZeile() {
        Bestandsschutz.mutationsprobe(root, List.of(), "unternehmen", "UPDATE unternehmen SET name = name || ' (Probe)'");
    }

    /**
     * Out-of-order: eine Datenbank, auf der ALLE anderen Migrationen schon liegen (außer denen, die auf ihr aufbauen —
     * {@link #BAUEN_DARAUF_AUF}), bekommt diese als späte Ankunft —
     * und hat danach dieselben Tabellen, Constraints und Vokabulare wie die frische Datenbank in Versionsreihenfolge.
     */
    @Test
    void dieMigrationTraegtAuchAlsSpaeteAnkunft() throws IOException {
        root.execute("CREATE DATABASE voltpilot_spaet");
        Path ohneDiese = Files.createTempDirectory("migrationen-ohne-kennzahl");
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
        for (String sql : List.of(
                "SELECT format('(%L, %s, %L)', vokabular, nr, wort) FROM kennzahl_vokabular()",
                "SELECT table_name || '.' || column_name || ':' || data_type FROM information_schema.columns "
                        + "WHERE table_schema = 'public' AND table_name LIKE 'kennzahl%' ORDER BY table_name, ordinal_position",
                "SELECT conrelid::regclass::text || '.' || conname || ' ' || pg_get_constraintdef(oid) FROM pg_constraint "
                        + "WHERE conrelid::regclass::text LIKE 'kennzahl%' ORDER BY 1",
                "SELECT tablename || ' ' || indexname || ' ' || indexdef FROM pg_indexes WHERE tablename LIKE 'kennzahl%' "
                        + "ORDER BY 1")) {
            assertThat(db.queryForList(sql, String.class)).as(sql).isNotEmpty()
                    .isEqualTo(root.queryForList(sql, String.class));
        }
    }

    // ===================================================================== Gerüst

    private static String zeile(String vokabular, int nr, String wort) {
        return "('" + vokabular + "', " + nr + ", '" + wort + "')";
    }

    private static List<String> liste(String vokabular) {
        List<String> woerter = new ArrayList<>();
        vertrag.path("vokabulare").path(vokabular).forEach(w -> woerter.add(w.asText()));
        assertThat(woerter).as(vokabular).isNotEmpty();
        return woerter;
    }

    private static String definition(String tabelle, String constraint) {
        return root.queryForObject("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = ? "
                + "AND conrelid = ?::regclass", String.class, constraint, tabelle);
    }

    private static Set<String> woerter(String definition) {
        Set<String> gefunden = new TreeSet<>();
        Matcher m = Pattern.compile("'([^']+)'::text").matcher(definition);
        while (m.find()) {
            gefunden.add(m.group(1));
        }
        return gefunden;
    }

    private static List<String> spalten(String tabelle, Set<String> ohne) {
        return root.queryForList("SELECT column_name || ':' || data_type FROM information_schema.columns "
                + "WHERE table_schema = 'public' AND table_name = ? ORDER BY ordinal_position", String.class, tabelle)
                .stream().filter(s -> !ohne.contains(s.substring(0, s.indexOf(':')))).toList();
    }

    private static LocalDate monat(int n) {
        return LocalDate.of(2026, 1, 1).plusMonths(n);
    }

    private static BigDecimal dezimal(JsonNode wert) {
        return wert.isNull() || wert.isMissingNode() ? null : new BigDecimal(wert.asText());
    }

    private static String text(JsonNode wert) {
        return wert.isNull() || wert.isMissingNode() ? null : wert.asText();
    }

    /** Ein Kundenbereich mit Unternehmen, Standort, Gebäude, Bereich, Messstelle, Prozess, Kostenstelle, Bezugsgröße. */
    private static Kunde kunde(String name) {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, name);
        UUID st = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u);
        UUID g = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) "
                + "VALUES (?, 'gebaeude', 'Halle 2', 'G-2', 'aktiv') RETURNING id", UUID.class, t);
        UUID be = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) "
                + "VALUES (?, 'bereich', 'Halle 1 Nord', 'B-1', 'aktiv') RETURNING id", UUID.class, t);
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-12', 'Montage Linie M1', 'gemessen', 'Strom', "
                + "'Wirkenergie', 'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, t);
        UUID p = root.queryForObject("INSERT INTO prozess (tenant_id, unternehmen_id, kennzeichen, name, gueltig_ab) "
                + "VALUES (?, ?, 'P-1', 'Spritzguss', '2026-01-01') RETURNING id", UUID.class, t, u);
        UUID ks = root.queryForObject("INSERT INTO kostenstelle (tenant_id, unternehmen_id, kennzeichen, name, gueltig_ab) "
                + "VALUES (?, ?, '4100', 'Montage', '2026-01-01') RETURNING id", UUID.class, t, u);
        UUID bz = root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, "
                + "periode_art, geltung_art, ort_id) VALUES (?, 'BZ-6', 'Gutteile Montage Halle 2', 'periodenwert', "
                + "'Stück', 'monat', 'gebaeude', ?) RETURNING id", UUID.class, t, g);
        return new Kunde(t, u, st, g, be, ms, p, ks, bz);
    }

    private static String geltungsSpalte(String art) {
        return switch (art) {
            case "unternehmen" -> "unternehmen_id";
            case "gebaeude", "bereich" -> "ort_id";
            case "prozess" -> "prozess_id";
            case "kostenstelle" -> "kostenstelle_id";
            case "messstelle" -> "messstelle_id";
            default -> "standort_id";
        };
    }

    private static UUID geltungsObjekt(Kunde k, String art) {
        return switch (art) {
            case "unternehmen" -> k.unternehmen();
            case "gebaeude" -> k.gebaeude();
            case "bereich" -> k.bereich();
            case "prozess" -> k.prozess();
            case "kostenstelle" -> k.kostenstelle();
            case "messstelle" -> k.messstelle();
            default -> k.standort();
        };
    }

    /** Eine Kennzahl ohne Fassung — geschrieben wie der Schreibweg (App-Rolle im Zaun). */
    private static UUID kennzahlZeile(Kunde k, String kennzeichen, String rechenform, String geltungArt) {
        return als(k.tenant(), () -> app.queryForObject("INSERT INTO kennzahl (tenant_id, kennzeichen, name, rechenform, "
                + "geltung_art, " + geltungsSpalte(geltungArt) + ", verantwortlich_sub, verantwortlich_name, zweck) "
                + "VALUES (?, ?, ?, ?, ?, ?, 'sub-ines', 'Ines Krüger', 'Spezifischer Stromeinsatz') RETURNING id",
                UUID.class, k.tenant(), kennzeichen, "Kennzahl " + kennzeichen, rechenform, geltungArt,
                geltungsObjekt(k, geltungArt)));
    }

    /** Kennzahl + Fassung 1 „gilt seit Beginn". */
    private static Kz kennzahl(Kunde k, String kennzeichen, String rechenform, String geltungArt) {
        UUID id = kennzahlZeile(k, kennzeichen, rechenform, geltungArt);
        String einheit = "anteil".equals(rechenform) ? "%" : "kWh/Stück";
        UUID fassung = als(k.tenant(), () -> neu(app, "kennzahl_fassung", fassungZeile(k, id, 1, rechenform, einheit)));
        return new Kz(id, fassung, rechenform);
    }

    private static Map<String, Object> fassungZeile(Kunde k, UUID kennzahl, int nummer, String rechenform, String einheit) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("tenant_id", k.tenant());
        m.put("kennzahl_id", kennzahl);
        m.put("nummer", nummer);
        m.put("rechenform", rechenform);
        m.put("herkunft", nummer == 1 ? "anlage" : "eintrag");
        m.put("actor_sub", "sub-ines");
        m.put("actor_name", "Ines Krüger");
        m.put("actor_rolle", "energiemanager");
        m.put("actor_art", "kunde");
        m.put("einheit", einheit);
        return m;
    }

    private static Map<String, Object> eingangZeile(Kunde k, Kz kz, int position, String rolle, String art, UUID objekt) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("tenant_id", k.tenant());
        m.put("kennzahl_id", kz.id());
        m.put("fassung_id", kz.fassung());
        m.put("rechenform", kz.rechenform());
        m.put("position", position);
        m.put("rolle", rolle);
        m.put("art", art);
        m.put(verweis(art), objekt);
        return m;
    }

    private static String verweis(String art) {
        return switch (art) {
            case "bezugsgroesse" -> "bezugsgroesse_id";
            case "kennzahl" -> "eingang_kennzahl_id";
            default -> "messstelle_id";
        };
    }

    private static UUID eingang(Kunde k, Kz kz, int position, String rolle, String art, UUID objekt) {
        return als(k.tenant(), () -> neu(app, "kennzahl_eingang", eingangZeile(k, kz, position, rolle, art, objekt)));
    }

    /** Ein Wert der Form von K1 (Monat, vollständig) — ohne Version ohne Zahl mit Grund. */
    private static Map<String, Object> wertZeile(Kunde k, Kz kz, LocalDate monat, Integer version, String zustand) {
        boolean zahl = version != null;
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("tenant_id", k.tenant());
        m.put("kennzahl_id", kz.id());
        m.put("periode_art", "monat");
        m.put("periode_von", monat);
        m.put("periode_bis", monat.plusMonths(1).minusDays(1));
        m.put("zeitzone", "Europe/Berlin");
        m.put("version", version);
        m.put("wert", zahl ? new BigDecimal("0.1488") : null);
        m.put("zaehler", new BigDecimal("6100"));
        m.put("nenner", zahl ? new BigDecimal("41000") : null);
        m.put("menge_zustand", zahl ? "vollständig" : "keine Werte");
        m.put("kennzeichen", zahl ? "[\"berechnet (Kennzahl)\"]" : "[]");
        m.put("abdeckung_prozent", new BigDecimal("100"));
        m.put("richtung", null);
        m.put("grund", zahl ? null : "nenner_fehlt");
        m.put("zustand", zustand);
        m.put("endgueltig_ab", "endgueltig".equals(zustand) ? GERECHNET : null);
        m.put("definition_fassung_id", kz.fassung());
        m.put("berechnet_am", GERECHNET);
        m.put("anlass_art", null);
        m.put("anlass_kennung", null);
        return m;
    }

    /** Werte hängt der Rechenlauf an — die Verwaltungsrolle. */
    private static UUID wert(Map<String, Object> spalten) {
        return neu(admin, "kennzahl_wert", spalten);
    }

    private static Map<String, Object> wertEingangZeile(Kunde k, Kz kz, UUID wert, int position, String rolle, String art,
            UUID objekt) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("tenant_id", k.tenant());
        m.put("wert_id", wert);
        m.put("kennzahl_id", kz.id());
        m.put("position", position);
        m.put("rolle", rolle);
        m.put("art", art);
        m.put("objekt", switch (art) {
            case "bezugsgroesse" -> "BZ-6";
            case "kennzahl" -> "KZ-0001";
            default -> "MS-12";
        });
        m.put(verweis(art), objekt);
        m.put("wert", new BigDecimal("6100"));
        m.put("einheit", "kWh");
        m.put("menge_zustand", "vollständig");
        m.put("abdeckung_prozent", new BigDecimal("100"));
        m.put("version", "bezugsgroesse".equals(art) ? null : 1);
        m.put("fassung", "bezugsgroesse".equals(art) ? 1 : null);
        m.put("kennzeichen", "[]");
        return m;
    }

    private static void protokoll(Kunde k, UUID kennzahl, String art) {
        alsTue(k.tenant(), () -> app.update("INSERT INTO kennzahl_aenderung (tenant_id, kennzahl_id, art, gilt_ab, "
                + "rueckwirkend, actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, ?, ?, now(), false, "
                + "'sub-ines', 'Ines Krüger', 'energiemanager', 'kunde')", k.tenant(), kennzahl, art));
    }

    /** Je Tabelle mindestens eine Zeile: Quotient mit Eingängen, Zusammenfassung, Werte, Umbenennung, Protokoll. */
    private static void vollstaendig(Kunde k) {
        Kz kz = kennzahl(k, "KZ-0001", "quotient", "gebaeude");
        eingang(k, kz, 0, "zaehler", "messstelle", k.messstelle());
        eingang(k, kz, 1, "nenner", "bezugsgroesse", k.bezugsgroesse());
        Kz zusammen = kennzahl(k, "KZ-0003", "zusammenfassung", "unternehmen");
        eingang(k, zusammen, 0, "paar", "kennzahl", kz.id());
        alsTue(k.tenant(), () -> app.update("UPDATE kennzahl SET kennzeichen = 'KZ-0101' WHERE id = ?", kz.id()));
        UUID w = wert(wertZeile(k, kz, OKTOBER, 1, "endgueltig"));
        dazu(admin, "kennzahl_wert_eingang", wertEingangZeile(k, kz, w, 0, "zaehler", "messstelle", k.messstelle()));
        dazu(admin, "kennzahl_wert_eingang", wertEingangZeile(k, kz, w, 1, "nenner", "bezugsgroesse", k.bezugsgroesse()));
        UUID wz = wert(wertZeile(k, zusammen, OKTOBER, 1, "endgueltig"));
        dazu(admin, "kennzahl_wert_eingang", mit(wertEingangZeile(k, zusammen, wz, 0, "paar", "kennzahl", kz.id()),
                "zaehler", new BigDecimal("6100"), "nenner", new BigDecimal("41000"), "einheit", "kWh/Stück"));
        protokoll(k, kz.id(), "kennzahl_fassung_eingetragen");
    }

    private static Map<String, Object> mit(Map<String, Object> basis, Object... paare) {
        Map<String, Object> m = new LinkedHashMap<>(basis);
        for (int i = 0; i < paare.length; i += 2) {
            m.put((String) paare[i], paare[i + 1]);
        }
        return m;
    }

    private static UUID neu(JdbcTemplate db, String tabelle, Map<String, Object> spalten) {
        return db.queryForObject(insert(tabelle, spalten) + " RETURNING id", UUID.class, spalten.values().toArray());
    }

    private static void dazu(JdbcTemplate db, String tabelle, Map<String, Object> spalten) {
        db.update(insert(tabelle, spalten), spalten.values().toArray());
    }

    private static String insert(String tabelle, Map<String, Object> spalten) {
        return "INSERT INTO " + tabelle + " (" + String.join(", ", spalten.keySet()) + ") VALUES ("
                + spalten.keySet().stream()
                        .map(s -> s.equals("kennzeichen") && tabelle.startsWith("kennzahl_wert") ? "?::jsonb" : "?")
                        .collect(Collectors.joining(", "))
                + ")";
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

    private static boolean funktion(String rolle, String signatur) {
        return Boolean.TRUE.equals(root.queryForObject("SELECT has_function_privilege(?, ?, 'EXECUTE')", Boolean.class,
                rolle, signatur));
    }

    private static void zurueckgerollt(JdbcTemplate db, Runnable arbeit) {
        new TransactionTemplate(new DataSourceTransactionManager(db.getDataSource())).executeWithoutResult(status -> {
            status.setRollbackOnly();
            arbeit.run();
        });
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

    private static void abgelehntMitMeldung(String meldung, Runnable arbeit) {
        PSQLException p = psql(arbeit, meldung);
        assertThat(p.getMessage()).contains(meldung);
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
