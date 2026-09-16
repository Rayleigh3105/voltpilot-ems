package com.voltpilot.api.zugriff;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.RechteAbleitung;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.Kundenbereich;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.RechteAbleitung.Ziel;
import com.voltpilot.api.zugriff.ZugriffContext.Modus;
import com.voltpilot.api.zugriff.ZugriffContext.Zugriff;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * UEMS AP-03, Befund E12: der STICHTAG der Bestandsregel ({@code V20260916060000}).
 *
 * <p>Die Regel „ein Kundenkonto, das in seinem Kundenbereich NIE eine Zuweisung hatte, ist unternehmensweit" steht
 * seit IP-4 in der Anfrage ({@link Zugriff#modus()}), damit eine Störung des Start-Laufs — Not-Aus, Keycloak nicht
 * erreichbar, Lauf abgeschaltet — keinen Kunden aussperrt. Ohne Stichtag wäre aber auch ein im Portal FRISCH
 * ANGELEGTES Konto unternehmensweit (AP-03 IP-13/IP-14). Der Stichtag unterscheidet beide, ohne die Schutzwirkung
 * aufzuheben:
 *
 * <ol>
 *   <li><b>Ein Bestandskonto ohne Zuweisung ist weiterhin unternehmensweit</b> — auch wenn der Bestands-Lauf nicht
 *       lief: ohne Stichtag gilt die Regel unverändert.</li>
 *   <li><b>Ein NEU angelegtes Konto ohne Zuweisung ist es nicht</b> — nach dem Stichtag sieht es auf jeder
 *       gezäunten Tabelle NICHTS, und der Rechte-Vertrag gibt ihm keine einzige Zeile der Matrix.</li>
 *   <li><b>Nur beendete oder nur künftige Zuweisungen bleiben beim engsten Zaun</b> — vor und nach dem Stichtag.</li>
 *   <li><b>Der Bestandsnachweis:</b> ohne Stichtag sieht JEDES Konto auf jeder gezäunten Tabelle genau dieselben
 *       Zeilen wie auf dem Stand VOR dieser Migration; mit Stichtag ändert sich nur das nie zugewiesene Konto.</li>
 * </ol>
 *
 * <p>Gemessen wird die ganze Kette: {@link ZugriffKontextLader} lädt den Zugriff aus der Datenbank, sein
 * {@link Zugriff#modus()} und {@link Zugriff#standortIdsWert()} werden als {@code app.zugriff} und
 * {@code app.standort_ids} gesetzt, und die Policy {@code site_scope} (IP-5) entscheidet über die Zeilen.
 * Testcontainers, Docker nötig (sonst übersprungen).
 */
@Testcontainers(disabledWithoutDocker = true)
class ZugriffStichtagTest {

    private static final String DIESE = "20260916060000";
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final Instant JETZT = Instant.parse("2026-09-16T08:00:00Z");

    private static final String KB = "c6000000-0000-0000-0000-000000000001";
    private static final String ST1 = "c6000000-0000-0000-0001-000000000001";
    private static final String ST2 = "c6000000-0000-0000-0001-000000000002";
    private static final List<String> TABELLEN =
            List.of("site", "standort", "anlage_standort", "ort", "measurement_point", "device");

    /** Bestandskonto: kein einziger Eintrag in {@code zugriff} — die Regel E12 trägt es. */
    private static final String NIE = "sub-stichtag-nie";
    /** Nach dem Stichtag angelegt: Spiegel ja, Zuweisung nein. */
    private static final String NEU = "sub-stichtag-neu";
    private static final String KA = "sub-stichtag-kundenadministrator";
    private static final String ST1_LESER = "sub-stichtag-leser-st1";
    private static final String BEENDET = "sub-stichtag-beendet";
    private static final String KUENFTIG = "sub-stichtag-kuenftig";

    private static final List<String> KONTEN = List.of(NIE, KA, ST1_LESER, BEENDET, KUENFTIG);

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static ZugriffRepository zugriffe;
    private static ZugriffKontextLader lader;

    /** Je Konto die Sicht auf dem Stand VOR dieser Migration (die Regel E12 ohne Stichtag). */
    private static Map<String, Map<String, List<String>>> vorher;

    /** Zeilen in {@code zugriff_bestand} DIREKT nach der Migration - vor jedem Test. */
    private static long zeilenNachDerMigration;

    @BeforeAll
    static void bauenUndMigrieren() throws Exception {
        flyway().target(letzteFassungVorDieser()).load().migrate();
        assertThat(tabelleDa()).as("vorher gibt es die Tabelle nicht").isFalse();
        weltUndKonten();

        DataSource rls = new TenantAwareDataSource(ds(APP_USER, APP_PW));
        JdbcTemplate app = new JdbcTemplate(rls);
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        zugriffe = new ZugriffRepository(app);
        lader = new ZugriffKontextLader(zugriffe, new SimpleMeterRegistry());
        lader.uhrStellen(Clock.fixed(JETZT, ZoneOffset.UTC));

        // „Vorher" ist die Regel dieses Standes: nie eine Zuweisung = unternehmensweit, ohne jeden Stichtag.
        vorher = new LinkedHashMap<>();
        for (String sub : KONTEN) {
            vorher.put(sub, sicht(zugriffOhneStichtagsregel(sub)));
        }
        flyway().load().migrate();
        zeilenNachDerMigration = root.queryForObject("SELECT count(*) FROM zugriff_bestand", Long.class);
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
        ZugriffContext.clear();
    }

    // ---------------------------------------------------------------- die Tabelle selbst

    @Test
    void dieTabelleKommtLeerMitMandantenzaunUndEngenRechten() {
        assertThat(tabelleDa()).isTrue();
        assertThat(zeilenNachDerMigration)
                .as("nach der Migration leer - kein Kundenbereich verliert die Regel durch das Aufspielen").isZero();
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                + "WHERE relname = 'zugriff_bestand'", Boolean.class)).as("ENABLE + FORCE").isTrue();
        assertThat(root.queryForList("SELECT policyname FROM pg_policies WHERE tablename = 'zugriff_bestand'",
                String.class)).containsExactly("zugriff_bestand_tenant_isolation");
        assertThat(rechte(APP_USER)).as("einmal setzen und lesen, nie verschieben").containsExactly("INSERT", "SELECT");
        assertThat(rechte(ADMIN_USER)).as("nur das Offboarding räumt ab").containsExactly("DELETE", "SELECT");
    }

    /** Der Stichtag wird EINMAL geschrieben; ein zweiter Versuch ändert ihn nicht. */
    @Test
    void einStichtagWirdNieVerschoben() {
        String anderer = kundenbereich("Zweiter Kundenbereich");
        TenantContext.set(java.util.UUID.fromString(anderer));
        assertThat(zugriffe.stichtag()).isEmpty();
        assertThat(zugriffe.stichtagSetzen(JETZT, ZugriffBestand.HERKUNFT_LAUF, 3)).isTrue();
        assertThat(zugriffe.stichtagSetzen(JETZT.plusSeconds(3600), ZugriffBestand.HERKUNFT_NEU, 9)).isFalse();
        assertThat(zugriffe.stichtag())
                .contains(new ZugriffRepository.Stichtag(JETZT, ZugriffBestand.HERKUNFT_LAUF, 3));
        TenantContext.clear();
        root.update("DELETE FROM zugriff_bestand WHERE tenant_id = ?::uuid", anderer);
    }

    /**
     * Das Offboarding raeumt die Zeile ab: der Fremdschluessel ist {@code ON DELETE RESTRICT}, also muesste ein
     * Kundenbereich mit Stichtag sonst unloeschbar sein ({@code TenantRepository.deleteById} nennt die Tabelle).
     */
    @Test
    void dasOffboardingRaeumtDenStichtagAbUndDerKundenbereichGehtWeg() throws Exception {
        String weg = kundenbereich("Wird abgemeldet");
        TenantContext.set(java.util.UUID.fromString(weg));
        assertThat(zugriffe.stichtagSetzen(JETZT, ZugriffBestand.HERKUNFT_LAUF, 1)).isTrue();
        TenantContext.clear();

        try (Connection c = ds(ADMIN_USER, ADMIN_PW).getConnection(); Statement s = c.createStatement()) {
            assertThat(s.executeUpdate("DELETE FROM zugriff_bestand WHERE tenant_id = '" + weg + "'"))
                    .as("die BYPASSRLS-Rolle raeumt ab").isEqualTo(1);
            assertThat(s.executeUpdate("DELETE FROM tenant WHERE id = '" + weg + "'")).isEqualTo(1);
        }
    }

    // ---------------------------------------------------------------- die vier Nachweise

    /**
     * 1 + 4: Ohne Stichtag — der Bestands-Lauf ist aus, war nicht erfolgreich oder kam noch nicht dazu — sieht
     * JEDES Konto genau dieselben Zeilen wie vor der Migration. Das nie zugewiesene Konto bleibt unternehmensweit.
     */
    @Test
    void ohneStichtagSiehtJedesKontoDieselbenZeilenWieVorher() {
        ohneStichtag();
        for (String sub : KONTEN) {
            Zugriff z = geladen(sub);
            assertThat(sicht(z)).as("%s sieht unverändert", sub).isEqualTo(vorher.get(sub));
        }
        Zugriff nie = geladen(NIE);
        assertThat(nie.bestandskonto()).as("kein Stichtag: die Bestandsregel trägt das Konto").isTrue();
        assertThat(nie.modus()).isEqualTo(Modus.UNTERNEHMEN);
        assertThat(sicht(nie).get("standort")).as("es sieht beide Standorte").hasSize(2);
    }

    /**
     * 2: Mit Stichtag ist „nie zugewiesen" kein Bestandskonto mehr, sondern ein NEUES Konto — es sieht auf keiner
     * gezäunten Tabelle eine Zeile, und der Rechte-Vertrag gibt ihm keine Aktion der Matrix.
     */
    @Test
    void mitStichtagSiehtEinNeuAngelegtesKontoNichts() {
        mitStichtag();
        // Womit verglichen wird: ein Konto ganz ohne Zuweisung (die untere Schranke, die JEDES angemeldete Konto
        // hat) und dasselbe Konto UNTER der Bestandsregel (Kundenadministrator, unternehmensweit).
        Set<String> ohneJedeZuweisung = erlaubt(new Benutzer(NEU, NEU, RechteAbleitung.Konto.BENUTZER,
                RechteAbleitung.KontoZustand.AKTIV, List.of()));
        Set<String> alsBestandskonto = erlaubt(RechtPruefung.benutzer(new Zugriff(NEU,
                RechteAbleitung.Konto.BENUTZER, java.util.UUID.fromString(KB), ZugriffContext.Zugang.KONTO,
                List.of(), JETZT, true)));
        for (String sub : List.of(NIE, NEU)) {
            Zugriff z = geladen(sub);
            assertThat(z.bestandskonto()).as("%s ist nach dem Stichtag kein Bestandskonto", sub).isFalse();
            assertThat(z.modus()).as(sub).isEqualTo(Modus.STANDORTE);
            assertThat(z.standortIdsWert()).isEqualTo("{}");
            assertThat(sicht(z).values()).as("%s sieht nichts", sub)
                    .allSatisfy(zeilen -> assertThat(zeilen).isEmpty());
            assertThat(RechtPruefung.benutzer(z).zuweisungen()).as("%s hat keine Zuweisung", sub).isEmpty();
            assertThat(erlaubt(RechtPruefung.benutzer(z))).as("%s darf genau so viel wie ein Konto ohne Zuweisung", sub)
                    .isEqualTo(ohneJedeZuweisung);
            assertThat(alsBestandskonto).as("als Bestandskonto duerfte es strikt mehr")
                    .containsAll(ohneJedeZuweisung).hasSizeGreaterThan(ohneJedeZuweisung.size());
            assertThat(akteurRolle(z)).as("%s handelt unter keiner Rolle", sub).isNull();
        }
    }

    /** 4: Mit Stichtag ändert sich AUSSER dem nie zugewiesenen Konto für keines etwas. */
    @Test
    void mitStichtagBleibtJedesZugewieseneKontoUnveraendert() {
        mitStichtag();
        for (String sub : List.of(KA, ST1_LESER, BEENDET, KUENFTIG)) {
            assertThat(sicht(geladen(sub))).as("%s sieht unverändert", sub).isEqualTo(vorher.get(sub));
        }
        assertThat(akteurRolle(geladen(KA))).isEqualTo(Rolle.KUNDENADMINISTRATOR.code());
    }

    /**
     * 3: Ein Konto mit nur beendeten oder nur künftigen Zuweisungen bleibt beim engsten Zaun — das galt schon
     * vorher und muss gelten bleiben, mit Stichtag wie ohne. „Nie gehabt" ist nicht „hat gerade keine".
     */
    @Test
    void nurBeendeteOderNurKuenftigeZuweisungenBleibenBeimEngstenZaun() {
        for (Runnable stand : List.of((Runnable) ZugriffStichtagTest::ohneStichtag, ZugriffStichtagTest::mitStichtag)) {
            stand.run();
            for (String sub : List.of(BEENDET, KUENFTIG)) {
                Zugriff z = geladen(sub);
                assertThat(z.bestandskonto()).as("%s hatte schon eine Zuweisung", sub).isFalse();
                assertThat(z.modus()).as(sub).isEqualTo(Modus.STANDORTE);
                assertThat(sicht(z).values()).as("%s sieht nichts", sub)
                        .allSatisfy(zeilen -> assertThat(zeilen).isEmpty());
            }
        }
    }

    // ---------------------------------------------------------------- Hilfen

    private static void ohneStichtag() {
        root.update("DELETE FROM zugriff_bestand WHERE tenant_id = ?::uuid", KB);
    }

    private static void mitStichtag() {
        root.update("INSERT INTO zugriff_bestand (tenant_id, stichtag, herkunft, konten) "
                + "VALUES (?::uuid, ?, 'bestandslauf', 5) ON CONFLICT (tenant_id) DO NOTHING", KB,
                JETZT.minusSeconds(60).atOffset(ZoneOffset.UTC));
    }

    /** Der Zugriff, wie ihn die Anfrage lädt — mit dem Kundenbereich des Tests im {@link TenantContext}. */
    private static Zugriff geladen(String sub) {
        TenantContext.set(java.util.UUID.fromString(KB));
        try {
            return lader.laden(auth(sub), null).zugriff();
        } finally {
            TenantContext.clear();
        }
    }

    /** Derselbe Zugriff nach der Regel des Standes VOR dieser Migration: nie eine Zuweisung = unternehmensweit. */
    private static Zugriff zugriffOhneStichtagsregel(String sub) {
        TenantContext.set(java.util.UUID.fromString(KB));
        try {
            List<ZugriffRepository.Zeile> wirksam = zugriffe.wirksam(sub, JETZT);
            return new Zugriff(sub, RechteAbleitung.Konto.BENUTZER, java.util.UUID.fromString(KB),
                    ZugriffContext.Zugang.KONTO, wirksam, JETZT,
                    wirksam.isEmpty() && !zugriffe.hatJeEineZuweisung(sub));
        } finally {
            TenantContext.clear();
        }
    }

    /** Je gezäunter Tabelle die Kennungen, die dieser Zugriff mit seinen Sitzungs-Einstellungen sieht. */
    private static Map<String, List<String>> sicht(Zugriff z) {
        Map<String, List<String>> aus = new TreeMap<>();
        try (Connection c = ds(APP_USER, APP_PW).getConnection()) {
            try (PreparedStatement ps = c.prepareStatement("SELECT set_config('app.tenant_id', ?, false), "
                    + "set_config('app.zugriff', ?, false), set_config('app.standort_ids', ?, false)")) {
                ps.setString(1, KB);
                ps.setString(2, z.modus().code());
                ps.setString(3, z.standortIdsWert());
                ps.execute();
            }
            for (String tabelle : TABELLEN) {
                List<String> ids = new ArrayList<>();
                try (Statement s = c.createStatement();
                        ResultSet rs = s.executeQuery("SELECT id::text FROM " + tabelle + " ORDER BY id")) {
                    while (rs.next()) {
                        ids.add(rs.getString(1));
                    }
                }
                aus.put(tabelle, ids);
            }
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
        return aus;
    }

    /** Welche Aktionen der Matrix dieser Aufrufer darf — am Unternehmen oder am Standort ST-1. */
    private static Set<String> erlaubt(Benutzer b) {
        Kundenbereich k = new Kundenbereich("Kundenbereich",
                List.of(new RechteAbleitung.Standort("ST-1", "Werk A")), List.of());
        RechteAbleitung.Matrix m = RechteMatrixDatei.matrix();
        Set<String> aus = new TreeSet<>();
        for (String a : RechteMatrixDatei.aktionen()) {
            if (RechteAbleitung.darf(m, b, k, a, Ziel.unternehmen(), JETZT).darf()) {
                aus.add(a + " @unternehmen");
            }
            if (RechteAbleitung.darf(m, b, k, a, new Ziel("ST-1", null, null), JETZT).darf()) {
                aus.add(a + " @ST-1");
            }
        }
        return aus;
    }

    /** Die Rolle, unter der dieser Zugriff einen Protokolleintrag schreibt — der Weg der echten Anfrage. */
    private static String akteurRolle(Zugriff z) {
        ZugriffContext.set(z);
        SecurityContextHolder.getContext().setAuthentication(auth(z.sub()));
        try {
            return ProtokollAkteur.angemeldetAls(z.sub()).orElseThrow().rolle();
        } finally {
            SecurityContextHolder.clearContext();
            ZugriffContext.clear();
        }
    }

    private static Authentication auth(String sub) {
        Jwt jwt = Jwt.withTokenValue("token").header("alg", "none").subject(sub).claim("sub", sub).build();
        return new TestingAuthenticationToken(jwt, "n", KeycloakRealmRoleConverter.KONTO_BENUTZER);
    }

    private static List<String> rechte(String rolle) {
        return root.queryForList("SELECT DISTINCT privilege_type FROM information_schema.table_privileges "
                + "WHERE table_name = 'zugriff_bestand' AND grantee = ? ORDER BY 1", String.class, rolle);
    }

    private static boolean tabelleDa() {
        JdbcTemplate r = root != null ? root : new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        return Boolean.TRUE.equals(r.queryForObject("SELECT to_regclass('public.zugriff_bestand') IS NOT NULL",
                Boolean.class));
    }

    private static String kundenbereich(String name) {
        return root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id::text", String.class, name);
    }

    // ---------------------------------------------------------------- Aufbau

    private static void weltUndKonten() throws Exception {
        String t = "'" + KB + "'";
        try (Connection c = ds(POSTGRES.getUsername(), POSTGRES.getPassword()).getConnection();
                Statement s = c.createStatement()) {
            s.execute("INSERT INTO tenant (id, name) VALUES (" + t + ", 'Stichtag GmbH')");
            s.execute("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (" + t
                    + ", 'Stichtag GmbH', 'Europe/Berlin')");
            s.execute("INSERT INTO standort (id, tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                    + "SELECT v.id::uuid, u.tenant_id, u.id, v.name, v.kz, 'Europe/Berlin', 'aktiv' FROM unternehmen u, "
                    + "(VALUES ('" + ST1 + "', 'Werk A', 'ST-1'), ('" + ST2 + "', 'Werk B', 'ST-2')) v(id, name, kz) "
                    + "WHERE u.tenant_id = " + t);
            s.execute("INSERT INTO site (id, tenant_id, name) VALUES "
                    + "('c6000000-0000-0000-0002-000000000001', " + t + ", 'Anlage an ST-1'), "
                    + "('c6000000-0000-0000-0002-000000000002', " + t + ", 'Anlage an ST-2')");
            s.execute("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab, gueltig_bis) VALUES "
                    + "(" + t + ", 'c6000000-0000-0000-0002-000000000001', '" + ST1 + "', '2024-01-01', NULL), "
                    + "(" + t + ", 'c6000000-0000-0000-0002-000000000002', '" + ST2 + "', '2024-01-01', NULL)");
            s.execute("INSERT INTO ort (id, tenant_id, art, name, kurzzeichen, zustand) VALUES "
                    + "('c6000000-0000-0000-0003-000000000001', " + t + ", 'gebaeude', 'Halle', 'G-1', 'aktiv'), "
                    + "('c6000000-0000-0000-0003-000000000002', " + t + ", 'gebaeude', 'Lager', 'G-2', 'aktiv')");
            s.execute("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES "
                    + "(" + t + ", 'c6000000-0000-0000-0003-000000000001', '" + ST1 + "', '2024-01-01'), "
                    + "(" + t + ", 'c6000000-0000-0000-0003-000000000002', '" + ST2 + "', '2024-01-01')");
            s.execute("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type) VALUES "
                    + "(" + t + ", 'c6000000-0000-0000-0002-000000000001', 'grid-meter', 'Zähler A', 'grid-meter'), "
                    + "(" + t + ", 'c6000000-0000-0000-0002-000000000002', 'grid-meter', 'Zähler B', 'grid-meter')");
            s.execute("INSERT INTO device (tenant_id, site_id, external_ref) VALUES "
                    + "(" + t + ", 'c6000000-0000-0000-0002-000000000001', 'stichtag-a'), "
                    + "(" + t + ", 'c6000000-0000-0000-0002-000000000002', 'stichtag-b')");

            for (String sub : List.of(NIE, NEU, KA, ST1_LESER, BEENDET, KUENFTIG)) {
                s.execute("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (" + t + ", '"
                        + sub + "', 'benutzer', '" + sub + "', 'aktiv')");
            }
            String zeit = "'Europe/Berlin'";
            s.execute("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, gueltig_ab, zeitzone) VALUES (" + t
                    + ", '" + KA + "', 'kundenadministrator', '2024-01-01T00:00:00Z', " + zeit + ")");
            s.execute("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) VALUES ("
                    + t + ", '" + ST1_LESER + "', 'leser', '" + ST1 + "', '2024-01-01T00:00:00Z', " + zeit + ")");
            // Nur BEENDET: eine Zuweisung, die es gab und die entzogen wurde - der Entzug wirkt sofort.
            s.execute("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, gueltig_ab, zeitzone, beendet_am, "
                    + "beendet_von, beendet_grund) VALUES (" + t + ", '" + BEENDET + "', 'kundenadministrator', "
                    + "'2024-01-01T00:00:00Z', " + zeit + ", '2025-01-01T00:00:00Z', '" + KA + "', 'Rolle entzogen')");
            // Nur KUENFTIG: eine Zuweisung, die erst beginnt - bis dahin der engste Zaun.
            s.execute("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, gueltig_ab, zeitzone) VALUES (" + t
                    + ", '" + KUENFTIG + "', 'kundenadministrator', '2027-01-01T00:00:00Z', " + zeit + ")");
        }
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
