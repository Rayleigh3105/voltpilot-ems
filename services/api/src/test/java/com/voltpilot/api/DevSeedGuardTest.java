package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Regression guard for the production outage where the api crash-looped on a VM
 * running {@code SPRING_PROFILES_ACTIVE=local}: the dev fleet/earnings seeds
 * (V20260706020000 / V20260706030000) referenced the demo tenant
 * {@code 00000000-...-0001} unconditionally, and on a DB where that tenant row
 * is absent (offboarded, or never seeded) the site insert violated
 * {@code site_tenant_id_fkey} (SQLSTATE 23503) and Flyway aborted startup.
 *
 * <p>Reproduces that exact state - dev migration chain applied through
 * V20260706010000, demo tenant then deleted - and asserts the later dev seeds
 * now migrate cleanly as no-ops while an untouched tenant keeps its data.
 * The happy path (fresh DB gets the full demo fleet) stays covered by
 * {@link RlsIsolationTest} and {@code PortalApiTest}.
 *
 * <p>Seit AP-00 IP-7 / AP-02 IP-16 wacht dieselbe Klasse auch über die
 * Demo-Daten des Referenzunternehmens „Kunststoffwerk Ahrenberg GmbH"
 * ({@code infra/local/seed/ahrenberg.sql}): sie laufen gegen dieselbe, dann
 * vollständig migrierte Wegwerf-Datenbank — ohne den lokalen Stack des
 * Entwicklers anzufassen. Die Reihenfolge ist Absicht: der Bestandsfall oben
 * braucht eine NOCH NICHT vollständig migrierte Datenbank und lässt sie
 * vollständig migriert zurück, was der Ahrenberg-Fall genau braucht.
 *
 * <p>Auto-skips where Docker is unavailable ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class DevSeedGuardTest {

    private static final String DEMO_TENANT = "00000000-0000-0000-0000-000000000001";
    /** Der dritte Kundenbereich; dieselbe Kennung trägt das Realm-Attribut des Logins `ahrenberg`. */
    private static final String AHRENBERG_TENANT = "20000000-0000-0000-0000-000000000001";
    private static final Path SEED = Path.of("..", "..", "infra", "local", "seed", "ahrenberg.sql");
    private static final Path REFERENZ =
            Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Test
    @Order(1)
    void devSeedsNoOpCleanlyWhenTheDemoTenantIsAbsent() throws Exception {
        // 1. Apply everything up to (and including) V20260706010000 - V100 has
        //    seeded the demo tenants at this point, the fleet seed is pending.
        flyway().target("20260706010000").load().migrate();

        // 2. The VM's state: the demo tenant row is gone (site/device/asset
        //    cascade with it) before the fleet seed ever ran.
        try (Connection c = POSTGRES.createConnection("");
                Statement s = c.createStatement()) {
            s.execute("DELETE FROM tenant WHERE id = '" + DEMO_TENANT + "'");
        }

        // 3. The rest of the chain (fleet seed, earnings seed, later core
        //    migrations) must apply cleanly - this exact call failed with
        //    SQLSTATE 23503 on site_tenant_id_fkey before the guards.
        flyway().load().migrate();

        // 4. The guarded seeds no-oped: no fleet rows for the absent tenant
        //    (rollup rows from V100's Berlin telemetry pre-date the delete and
        //    stay - hypertables have no FK - so scope to the seeded site ids),
        //    no dev-seed prices, while tenant B's V100 data is untouched.
        String fleetSites = "('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000022')";
        assertThat(count("SELECT count(*) FROM site WHERE tenant_id = '" + DEMO_TENANT + "'")).isZero();
        assertThat(count("SELECT count(*) FROM telemetry_rollup_15m WHERE site_id IN " + fleetSites)).isZero();
        assertThat(count("SELECT count(*) FROM schedule WHERE site_id IN " + fleetSites)).isZero();
        assertThat(count("SELECT count(*) FROM day_ahead_prices WHERE source = 'dev-seed'")).isZero();
        assertThat(count("SELECT count(*) FROM site WHERE name = 'Nordwind Hamburg'")).isEqualTo(1L);
    }

    /**
     * AP-00 IP-7 + AP-02 IP-16: der Ahrenberg-Seed läuft gegen eine vollständig
     * migrierte Datenbank ein, ist idempotent, trifft NICHTS außerhalb seines
     * Kundenbereichs — und stimmt Zeile für Zeile mit der Referenzdatei überein.
     *
     * <p>Der Stichtag ist {@code unternehmen.momentaufnahme} der Referenz
     * (20.10.2026 10:15): an ihm sind genau die Boxen in Betrieb, die der Seed
     * schreibt. Die zeitgültigen Tabellen tragen dagegen den ganzen Verlauf,
     * auch den künftigen (Flächenänderung G-2 zum 01.01.2027).
     */
    @Test
    @Order(2)
    void ahrenbergSeedIstIdempotentUndSchreibtDieReferenzAb() throws Exception {
        JsonNode ref = new ObjectMapper().readTree(REFERENZ.toFile());
        String seed = Files.readString(SEED);

        // 1. Was außerhalb von Ahrenberg steht, darf der Seed nicht anfassen.
        String fremd = fingerabdruckOhneAhrenberg();

        // 2. Zweimal einspielen: der zweite Lauf scheitert nicht und ändert nichts.
        assertThatCode(() -> ausfuehren(seed)).doesNotThrowAnyException();
        String nachDemErsten = fingerabdruckAhrenberg();
        assertThatCode(() -> ausfuehren(seed)).doesNotThrowAnyException();
        assertThat(fingerabdruckAhrenberg()).isEqualTo(nachDemErsten);
        assertThat(fingerabdruckOhneAhrenberg()).isEqualTo(fremd);

        // 3. Die Zählungen und Kennzeichen sind die der Referenz.
        assertThat(texte("SELECT kurzzeichen FROM standort WHERE tenant_id = '" + AHRENBERG_TENANT
                + "' ORDER BY kurzzeichen")).isEqualTo(kennzeichen(ref.path("standorte")));
        assertThat(texte("SELECT kurzzeichen FROM ort WHERE tenant_id = '" + AHRENBERG_TENANT
                + "' AND art = 'gebaeude' ORDER BY kurzzeichen")).isEqualTo(kennzeichen(ref.path("gebaeude")));
        assertThat(texte("SELECT kurzzeichen FROM ort WHERE tenant_id = '" + AHRENBERG_TENANT
                + "' AND art = 'bereich' ORDER BY kurzzeichen")).isEqualTo(kennzeichen(ref.path("bereiche")));
        assertThat(texte("SELECT name FROM site WHERE tenant_id = '" + AHRENBERG_TENANT
                + "' ORDER BY name")).isEqualTo(sortiert(ref.path("anlagen"), "name"));
        assertThat(count("SELECT count(*) FROM unternehmen WHERE tenant_id = '" + AHRENBERG_TENANT + "'"))
                .isEqualTo(1L);

        // Die Boxen: genau die, die am Stichtag der Referenz in Betrieb sind.
        assertThat(texte("SELECT external_ref FROM device WHERE tenant_id = '" + AHRENBERG_TENANT
                + "' ORDER BY external_ref")).isEqualTo(boxenAmStichtag(ref));

        // 4. Jede Fläche und jede Zuordnung: Wert, „gültig ab" und „gültig bis".
        for (JsonNode st : ref.path("standorte")) {
            assertThat(flaechen("standort_id", st.path("kennzeichen").asText()))
                    .as("Bezugsflächen " + st.path("kennzeichen").asText())
                    .isEqualTo(sollFlaechen(st));
        }
        for (JsonNode g : ref.path("gebaeude")) {
            assertThat(flaechen("ort_id", g.path("kennzeichen").asText()))
                    .as("Bezugsflächen " + g.path("kennzeichen").asText())
                    .isEqualTo(sollFlaechen(g));
        }
        for (JsonNode z : ref.path("zuordnungen")) {
            String art = z.path("art").asText();
            String von = z.path("von").asText();
            if ("ort_eltern".equals(art) && !von.startsWith("ST-")) {
                assertThat(text("SELECT coalesce(e.kurzzeichen, s.kurzzeichen) || ' ab ' || zu.gueltig_ab"
                        + " FROM ort_zuordnung zu JOIN ort o ON o.id = zu.ort_id"
                        + " LEFT JOIN ort e ON e.id = zu.eltern_ort_id"
                        + " LEFT JOIN standort s ON s.id = zu.eltern_standort_id"
                        + " WHERE zu.tenant_id = '" + AHRENBERG_TENANT + "' AND o.kurzzeichen = '" + von + "'"))
                        .as("Ortsbaum " + von)
                        .isEqualTo(z.path("nach").asText() + " ab " + z.path("gueltig_ab").asText());
            } else if ("anlage_standort".equals(art)) {
                String anlage = anlagenname(ref, von);
                assertThat(text("SELECT s.kurzzeichen || ' ab ' || a.gueltig_ab FROM anlage_standort a"
                        + " JOIN site si ON si.id = a.site_id JOIN standort s ON s.id = a.standort_id"
                        + " WHERE a.tenant_id = '" + AHRENBERG_TENANT + "' AND si.name = '" + anlage + "'"))
                        .as("Anlage " + von)
                        .isEqualTo(z.path("nach").asText() + " ab " + z.path("gueltig_ab").asText());
            }
        }

        // 5. Werk Lindach hat AUSDRÜCKLICH keine eigene Bezugsfläche (Referenz ST-2):
        //    die 2 600 m² entstehen erst im Leseweg als Summe der Gebäude.
        assertThat(count("SELECT count(*) FROM flaeche_gueltigkeit f JOIN standort s ON s.id = f.standort_id"
                + " WHERE s.kurzzeichen = 'ST-2' AND f.tenant_id = '" + AHRENBERG_TENANT + "'")).isZero();

        // 6. AP-03 IP-16 — die Personen: genau die SIEBEN der Referenz, mit ihrer Rolle.
        //    Die Zelle nennt acht Logins; Sabine Rauch streicht die Referenz ausdrücklich
        //    zusammen mit ST-3 (`_herkunft.bewusst_ausgelassen`), und der Seed folgt der Quelle.
        assertThat(ref.path("personen")).as("die Referenz führt sieben Personen").hasSize(7);
        assertThat(texte("SELECT anzeigename FROM benutzer WHERE tenant_id = '" + AHRENBERG_TENANT
                + "' ORDER BY anzeigename")).isEqualTo(sortiert(ref.path("personen"), "name"));
        assertThat(texte("SELECT anzeigename FROM benutzer WHERE tenant_id = '" + AHRENBERG_TENANT
                + "' AND anzeigename LIKE 'Sabine%'")).isEmpty();

        // Kontoart je Person: Benutzer des Kundenbereichs, Partner, Plattform (`personen[].art`).
        for (JsonNode person : ref.path("personen")) {
            String name = person.path("name").asText();
            assertThat(text("SELECT konto FROM benutzer WHERE tenant_id = '" + AHRENBERG_TENANT
                    + "' AND anzeigename = '" + name + "'"))
                    .as("Kontoart " + name)
                    .isEqualTo(sollKonto(person));
            assertThat(zuweisungen(name)).as("Zuweisungen " + name).isEqualTo(sollZuweisungen(ref, person));
        }

        // Am Stichtag ist KEINE der beiden Unterstützungen schon wirksam, und beide haben ein
        // Ende — das ist der Beleg für „Zuweisung in der Zukunft" und „beendete Unterstützung",
        // den sonst Sabine geliefert hätte.
        String stichtag = ref.path("unternehmen").path("momentaufnahme").asText();
        assertThat(count("SELECT count(*) FROM zugriff WHERE tenant_id = '" + AHRENBERG_TENANT
                + "' AND rolle = 'unterstuetzer' AND gueltig_ab > TIMESTAMPTZ '" + stichtag + "'"))
                .as("beide Unterstützungen liegen hinter dem Stichtag").isEqualTo(2L);
        assertThat(count("SELECT count(*) FROM zugriff WHERE tenant_id = '" + AHRENBERG_TENANT
                + "' AND rolle = 'unterstuetzer' AND endet_am IS NULL"))
                .as("eine Unterstützung ohne Ende gibt es nicht").isZero();

        // Die VoltPilot-Unterstützung wurde angefragt und am selben Tag gewährt; der
        // Installateur wird gewährt, nie gefragt — also genau EINE Anfrage.
        assertThat(count("SELECT count(*) FROM unterstuetzung_anfrage WHERE tenant_id = '"
                + AHRENBERG_TENANT + "'")).isEqualTo(1L);
        assertThat(text("SELECT to_char(gueltig_ab AT TIME ZONE zeitzone, 'DD.MM.YYYY')"
                + " || ' / ' || to_char(entschieden_am AT TIME ZONE zeitzone, 'DD.MM.YYYY')"
                + " FROM unterstuetzung_anfrage WHERE tenant_id = '" + AHRENBERG_TENANT + "'"))
                .as("angefragt und am selben Tag entschieden").isEqualTo("21.10.2026 / 21.10.2026");

        // 7. AP-01 IP-14 — die Funktionszustände: nur „Steuern & Optimieren" an ST-1 ist ein
        //    Objekt. AN-1 trägt als einzige Anlage der Referenz ein Betriebsmodell.
        assertThat(texte("SELECT s.kurzzeichen || ' ' || f.funktion || ' = ' || f.zustand"
                + " FROM funktion f JOIN standort s ON s.id = f.standort_id"
                + " WHERE f.tenant_id = '" + AHRENBERG_TENANT + "' ORDER BY 1"))
                .containsExactly("ST-1 steuern = aktiv");
        assertThat(texte("SELECT si.name || ' = ' || t.zustand || ' seit '"
                + " || to_char(t.gestartet_am AT TIME ZONE 'Europe/Berlin', 'DD.MM.YYYY')"
                + " || (CASE WHEN t.uebernommen THEN ' (übernommen)' ELSE '' END)"
                + " FROM funktion_teilnahme t JOIN site si ON si.id = t.site_id"
                + " WHERE t.tenant_id = '" + AHRENBERG_TENANT + "' ORDER BY 1"))
                .containsExactly(anlagenname(ref, "AN-1") + " = aktiv seit 02.05.2024 (übernommen)");
        // Der Tag stammt aus der Referenz, nicht aus diesem Test.
        assertThat(ref.path("anlagen").get(0).path("betriebsmodell_seit").asText())
                .startsWith("2024-05-02");

        // 8. Rechte-Zaun: für einen anderen Kundenbereich ist Ahrenberg unsichtbar.
        try (Connection app = DriverManager.getConnection(POSTGRES.getJdbcUrl(), APP_USER, APP_PW);
                Statement s2 = app.createStatement()) {
            s2.execute("SET app.tenant_id = '10000000-0000-0000-0000-000000000001'");
            for (String tabelle : List.of("standort", "ort", "ort_zuordnung", "flaeche_gueltigkeit",
                    "anlage_standort", "unternehmen", "site", "device",
                    "benutzer", "zugriff", "unterstuetzung_anfrage", "unterstuetzung_anfrage_standort",
                    "funktion", "funktion_teilnahme")) {
                try (ResultSet rs = s2.executeQuery("SELECT count(*) FROM " + tabelle
                        + " WHERE tenant_id = '" + AHRENBERG_TENANT + "'")) {
                    rs.next();
                    assertThat(rs.getLong(1)).as("RLS " + tabelle).isZero();
                }
            }
        }
    }

    /**
     * <b>Die Rechte-Probe je Rolle</b> (AP-03 IP-16, Auftrag des Pakets) — als TATSACHE, ohne
     * etwas daran zu ändern: Was sieht jede der sieben Personen des Seeds, wenn der Zaun
     * {@code site_scope} (IP-5) aus ihren wirksamen Zuweisungen gestellt wird?
     *
     * <p>Gestellt wird genau das, was {@code ZugriffKontextLader} je Anfrage stellt:
     * {@code app.zugriff} ({@code unternehmen} oder {@code standort}) und
     * {@code app.standort_ids}. Gezählt wird unter der Laufzeitrolle {@code voltpilot_app},
     * nicht als Superuser — sonst liefe die Policy gar nicht.
     *
     * <p>Gemessen wird an ZWEI Zeitpunkten, weil die beiden Unterstützungen hinter dem
     * Stichtag liegen: am Stichtag der Referenz (20.10.2026 10:15) und am 01.12.2026, wo
     * Brunner wirksam und Voss abgelaufen ist. Der Unterschied IST der Befund.
     */
    @Test
    @Order(4)
    void rechteProbeJeRolleGegenDenSeed() throws Exception {
        assertThat(probe("2026-10-20 10:15:00+02")).containsExactly(
                "Claudia Berger | leser | ST-1, ST-2 | 2 Standorte",
                "Ines Kaltenbach | energiemanager | unternehmensweit | 2 Standorte",
                "Jonas Wendlinger | kundenadministrator | unternehmensweit | 2 Standorte",
                "Lena Voss | - | keine Zuweisung | 0 Standorte",
                "Murat Demirci | bedienberechtigt | ST-1 | 1 Standort",
                "Peter Hollerbach | bearbeiter | ST-2 | 1 Standort",
                "Thomas Brunner | - | keine Zuweisung | 0 Standorte");

        assertThat(probe("2026-12-01 12:00:00+01")).containsExactly(
                "Claudia Berger | leser | ST-1, ST-2 | 2 Standorte",
                "Ines Kaltenbach | energiemanager | unternehmensweit | 2 Standorte",
                "Jonas Wendlinger | kundenadministrator | unternehmensweit | 2 Standorte",
                "Lena Voss | - | keine Zuweisung | 0 Standorte",
                "Murat Demirci | bedienberechtigt | ST-1 | 1 Standort",
                "Peter Hollerbach | bearbeiter | ST-2 | 1 Standort",
                "Thomas Brunner | unterstuetzer | ST-1 | 1 Standort");

        // Und die zweite Frage des Auftrags — „wer darf die Benutzerliste?" — beantwortet die
        // Rechte-Matrix, nicht diese Datenbank: `benutzer.verwalten` hat NUR der
        // Kundenadministrator (U), jede andere Rolle „-". Hier nur festgehalten, nicht geändert.
        JsonNode matrix = new ObjectMapper().readTree(
                Path.of("..", "..", "docs", "contracts", "v2", "rechte-matrix.json").toFile());
        JsonNode zellen = null;
        for (JsonNode a : matrix.path("aktionen")) {
            if ("benutzer.verwalten".equals(a.path("kennung").asText())) {
                zellen = a.path("zellen");
            }
        }
        assertThat(zellen).as("`benutzer.verwalten` steht in der Matrix").isNotNull();
        assertThat(zellen.path("kundenadministrator").asText()).isEqualTo("U");
        for (String rolle : List.of("energiemanager", "bearbeiter", "bedienberechtigt", "leser",
                "unterstuetzer")) {
            assertThat(zellen.path(rolle).asText()).as("benutzer.verwalten " + rolle).isEqualTo("-");
        }
    }

    /** „Name | Rolle | Geltungsbereich | was der Zaun durchlässt" je Person, zum Zeitpunkt. */
    private List<String> probe(String zeitpunkt) throws Exception {
        List<String> zeilen = new ArrayList<>();
        try (Connection app = DriverManager.getConnection(POSTGRES.getJdbcUrl(), APP_USER, APP_PW);
                Statement s = app.createStatement()) {
            s.execute("SET app.tenant_id = '" + AHRENBERG_TENANT + "'");
            for (String sub : texte("SELECT sub FROM benutzer WHERE tenant_id = '" + AHRENBERG_TENANT
                    + "' ORDER BY anzeigename")) {
                String name = text("SELECT anzeigename FROM benutzer WHERE tenant_id = '"
                        + AHRENBERG_TENANT + "' AND sub = '" + sub + "'");
                // Die wirksamen Zuweisungen zum Zeitpunkt - dieselbe Bedingung wie `zugriff_zeitraum`.
                String wirksam = " FROM zugriff WHERE tenant_id = '" + AHRENBERG_TENANT + "'"
                        + " AND benutzer_sub = '" + sub + "' AND beendet_am IS NULL"
                        + " AND gueltig_ab <= TIMESTAMPTZ '" + zeitpunkt + "'"
                        + " AND (endet_am IS NULL OR endet_am > TIMESTAMPTZ '" + zeitpunkt + "')";
                List<String> rollen = texte("SELECT DISTINCT rolle" + wirksam + " ORDER BY 1");
                boolean unternehmensweit =
                        count("SELECT count(*)" + wirksam + " AND standort_id IS NULL") > 0;
                List<String> ids = texte("SELECT standort_id::text" + wirksam
                        + " AND standort_id IS NOT NULL ORDER BY 1");

                s.execute("SET app.zugriff = '" + (unternehmensweit ? "unternehmen" : "standort") + "'");
                s.execute("SET app.standort_ids = '{" + String.join(",", ids) + "}'");
                List<String> kurz = new ArrayList<>();
                try (ResultSet rs = s.executeQuery(
                        "SELECT kurzzeichen FROM standort ORDER BY kurzzeichen")) {
                    while (rs.next()) {
                        kurz.add(rs.getString(1));
                    }
                }
                long anlagen;
                try (ResultSet rs = s.executeQuery("SELECT count(*) FROM site")) {
                    rs.next();
                    anlagen = rs.getLong(1);
                }
                // Rechte hängen am Standort, Daten am Stichtag (A16): eine Anlage ist für eine
                // standortbeschränkte Person nur sichtbar, solange sie HEUTE — echtes Heute, nicht
                // der Zeitpunkt der Probe — an ihrem Standort hängt. Deshalb steht die Zahl nicht
                // in der Tabelle, sondern wird gegen `anlage_standort` gerechnet.
                long erwartet = unternehmensweit
                        ? count("SELECT count(*) FROM site WHERE tenant_id = '" + AHRENBERG_TENANT + "'")
                        : ids.isEmpty() ? 0L
                                : count("SELECT count(DISTINCT a.site_id) FROM anlage_standort a"
                                        + " WHERE a.tenant_id = '" + AHRENBERG_TENANT + "'"
                                        + " AND a.standort_id IN ('" + String.join("','", ids) + "')"
                                        + " AND a.gueltig_ab <= current_date"
                                        + " AND (a.gueltig_bis IS NULL OR a.gueltig_bis >= current_date)");
                assertThat(anlagen).as("Anlagen für " + name + " am " + zeitpunkt).isEqualTo(erwartet);

                String bereich = unternehmensweit ? "unternehmensweit"
                        : rollen.isEmpty() ? "keine Zuweisung" : String.join(", ", kurz);
                zeilen.add(name + " | " + (rollen.isEmpty() ? "-" : String.join("+", rollen))
                        + " | " + bereich + " | " + kurz.size()
                        + (kurz.size() == 1 ? " Standort" : " Standorte"));
            }
        }
        return zeilen;
    }

    /**
     * Der Seed ist BEWUSST keine Flyway-Migration: unter {@code db/dev} läge er in jedem
     * Testlauf unter den Testklassen mit {@code @ActiveProfiles("local")} und änderte still
     * deren Ausgangslage — der Bestandsschutz verlangt das Gegenteil. Unter
     * {@code infra/local/timescale} liefe er vor Flyway, wo es die UEMS-Tabellen noch nicht gibt.
     */
    @Test
    @Order(3)
    void derAhrenbergSeedIstKeineMigrationUndKeinInitSkript() {
        assertThat(SEED).exists();
        assertThat(Path.of("services", "api", "src", "main", "resources", "db", "dev",
                "ahrenberg.sql")).doesNotExist();
        assertThat(Path.of("..", "..", "infra", "local", "timescale", "ahrenberg.sql")).doesNotExist();
    }

    // -------------------------------------------------------------------------

    private void ausfuehren(String sql) throws Exception {
        try (Connection c = POSTGRES.createConnection("");
                Statement s = c.createStatement()) {
            s.execute(sql);
        }
    }

    /** Alle Ahrenberg-Zeilen der berührten Tabellen als EIN Text — der Vergleich für „ändert nichts". */
    private String fingerabdruckAhrenberg() throws Exception {
        return abdruck("=");
    }

    private String fingerabdruckOhneAhrenberg() throws Exception {
        return abdruck("<>");
    }

    /** `tenant` trägt den Kundenbereich in `id`, jede andere Tabelle in `tenant_id`. */
    private String abdruck(String vergleich) throws Exception {
        StringBuilder sb = new StringBuilder();
        for (String tabelle : List.of("tenant", "unternehmen", "standort", "ort", "ort_zuordnung",
                "flaeche_gueltigkeit", "anlage_standort", "site", "device", "ort_kurzzeichen",
                "benutzer", "zugriff", "unterstuetzung_anfrage", "funktion", "funktion_teilnahme")) {
            String spalte = "tenant".equals(tabelle) ? "id" : "tenant_id";
            sb.append(tabelle).append('=')
                    .append(text("SELECT coalesce(string_agg(t.z, '|' ORDER BY t.z), '-') FROM ("
                            + "SELECT x::text AS z FROM " + tabelle + " x WHERE x." + spalte + " " + vergleich
                            + " '" + AHRENBERG_TENANT + "') t"))
                    .append('\n');
        }
        return sb.toString();
    }

    private List<String> kennzeichen(JsonNode liste) {
        return sortiert(liste, "kennzeichen");
    }

    private List<String> sortiert(JsonNode liste, String feld) {
        Set<String> s = new LinkedHashSet<>();
        liste.forEach(n -> s.add(n.path(feld).asText()));
        return s.stream().sorted().toList();
    }

    /** Die Boxen, die am Stichtag der Referenz in Betrieb sind — E-2′ kommt erst am 04.11.2026. */
    private List<String> boxenAmStichtag(JsonNode ref) {
        OffsetDateTime stichtag = OffsetDateTime.parse(ref.path("unternehmen").path("momentaufnahme").asText());
        List<String> refs = new ArrayList<>();
        for (JsonNode b : ref.path("boxen")) {
            OffsetDateTime ab = OffsetDateTime.parse(b.path("in_betrieb_ab").asText());
            JsonNode aus = b.path("ausgebaut_am");
            boolean nochDa = aus.isNull() || aus.isMissingNode()
                    || OffsetDateTime.parse(aus.asText()).isAfter(stichtag);
            if (!ab.isAfter(stichtag) && nochDa) {
                refs.add(b.path("seriennummer").asText());
            }
        }
        return refs.stream().sorted().toList();
    }

    private String anlagenname(JsonNode ref, String kennzeichen) {
        for (JsonNode a : ref.path("anlagen")) {
            if (kennzeichen.equals(a.path("kennzeichen").asText())) {
                return a.path("name").asText();
            }
        }
        throw new AssertionError(kennzeichen + " fehlt in der Referenz");
    }

    /** „m2 ab … bis …" je Objekt, in der Reihenfolge von „gültig ab". */
    private List<String> flaechen(String spalte, String kurzzeichen) throws Exception {
        String tabelle = "standort_id".equals(spalte) ? "standort" : "ort";
        return texte("SELECT f.m2 || ' ab ' || f.gueltig_ab || ' bis ' || coalesce(f.gueltig_bis::text, 'offen')"
                + " FROM flaeche_gueltigkeit f JOIN " + tabelle + " o ON o.id = f." + spalte
                + " WHERE f.tenant_id = '" + AHRENBERG_TENANT + "' AND o.kurzzeichen = '" + kurzzeichen + "'"
                + " ORDER BY f.gueltig_ab");
    }

    private List<String> sollFlaechen(JsonNode objekt) {
        List<String> soll = new ArrayList<>();
        for (JsonNode f : objekt.path("bezugsflaechen")) {
            JsonNode bis = f.path("gueltig_bis");
            soll.add(f.path("flaeche_m2").asInt() + " ab " + LocalDate.parse(f.path("gueltig_ab").asText())
                    + " bis " + (bis.isNull() || bis.isMissingNode() ? "offen" : bis.asText()));
        }
        return soll;
    }

    /** `personen[].art` der Referenz → das Wort des Vokabulars `konto`. */
    private String sollKonto(JsonNode person) {
        String art = person.path("art").asText();
        if ("benutzer".equals(art)) {
            return "benutzer";
        }
        // Ein Unterstützer ist Partner ODER Plattform — die Organisation sagt, welcher.
        return "VoltPilot".equals(person.path("unterstuetzung").path("organisation").asText())
                ? "plattform" : "partner";
    }

    /** „rolle @ ST-x ab TT.MM.JJJJ bis TT.MM.JJJJ" je Zuweisung, aufsteigend. */
    private List<String> zuweisungen(String name) throws Exception {
        return texte("SELECT z.rolle || ' @ ' || coalesce(s.kurzzeichen, '-')"
                + " || ' ab ' || to_char(z.gueltig_ab AT TIME ZONE z.zeitzone, 'DD.MM.YYYY')"
                + " || ' bis ' || coalesce(to_char(z.gueltig_bis, 'DD.MM.YYYY'), 'offen')"
                + " FROM zugriff z LEFT JOIN standort s ON s.id = z.standort_id"
                + " JOIN benutzer b ON b.tenant_id = z.tenant_id AND b.sub = z.benutzer_sub"
                + " WHERE z.tenant_id = '" + AHRENBERG_TENANT + "' AND b.anzeigename = '" + name + "'"
                + " ORDER BY 1");
    }

    /**
     * Dieselbe Zeile aus der Referenz gerechnet: Rolle klein geschrieben, je Standort eine
     * Zeile (unternehmensweit „-"), „seit" als Tag in der Zeitzone des Standorts, „gültig bis"
     * nur bei einer Unterstützung.
     */
    private List<String> sollZuweisungen(JsonNode ref, JsonNode person) {
        String rolle = person.path("rolle").asText().toLowerCase(java.util.Locale.ROOT)
                .replace("ü", "ue").replace("ä", "ae").replace("ö", "oe");
        String ab = OffsetDateTime.parse(person.path("seit").asText())
                .atZoneSameInstant(java.time.ZoneId.of("Europe/Berlin"))
                .format(java.time.format.DateTimeFormatter.ofPattern("dd.MM.yyyy"));
        JsonNode bis = person.path("gueltig_bis");
        String ende = bis.isNull() || bis.isMissingNode() ? "offen"
                : LocalDate.parse(bis.asText())
                        .format(java.time.format.DateTimeFormatter.ofPattern("dd.MM.yyyy"));
        List<String> orte = new ArrayList<>();
        if ("unternehmen".equals(person.path("geltungsbereich_art").asText())) {
            orte.add("-");
        } else {
            person.path("standorte").forEach(n -> orte.add(n.asText()));
            assertThat(orte).as("Standorte " + person.path("name").asText()).isNotEmpty();
            // Die Referenz nennt sie als ST-x; genau diese Standorte kennt der Seed.
            assertThat(kennzeichen(ref.path("standorte"))).containsAll(orte);
        }
        return orte.stream().sorted().map(o -> rolle + " @ " + o + " ab " + ab + " bis " + ende).toList();
    }

    private List<String> texte(String sql) throws Exception {
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

    private String text(String sql) throws Exception {
        List<String> werte = texte(sql);
        assertThat(werte).as(sql).hasSize(1);
        return werte.get(0);
    }

    private FluentConfiguration flyway() {
        return Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration", "classpath:db/dev")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(java.util.Map.of(
                        "appDbUser", "voltpilot_app", "appDbPassword", "voltpilot_app_test_pw",
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "voltpilot_admin_test_pw"));
    }

    private long count(String sql) throws Exception {
        try (Connection c = POSTGRES.createConnection("");
                Statement s = c.createStatement();
                ResultSet rs = s.executeQuery(sql)) {
            rs.next();
            return rs.getLong(1);
        }
    }
}
