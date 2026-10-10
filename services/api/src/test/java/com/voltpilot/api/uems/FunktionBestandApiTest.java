package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.tenant.TenantContext;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der UMSTIEG „Bestand → Zustand“ der Funktionen (UEMS AP-01 IP-2) auf der echten Datenbank mit
 * Dev-Saat — der Prüfnachweis des Pakets:
 *
 * <ol>
 *   <li>die Seed-Anlagen und das Referenzunternehmen ergeben {@code aktiv} bzw. „kein Objekt“, genau
 *       nach der IP-1-Regel (A11: AN-1 mit Lastspitzenkappung seit 02.05.2024 → Teilnahme aktiv
 *       „übernommen“, Werk Ahrenberg aktiv; AN-2/Werk Lindach reine Messung → kein Objekt; Messen
 *       → kein Objekt);</li>
 *   <li>Scharfschaltung ohne laufende Betriebsweise → eingerichtet; eine später laufende zweite
 *       Anlage zieht den Standort auf ihren höheren Zustand nach;</li>
 *   <li>{@code site_profile_state} ist BYTE-gleich, und jede andere Tabelle außer {@code funktion} und
 *       {@code funktion_teilnahme} ist zeichengleich — der Lauf schaltet nichts;</li>
 *   <li>der Lauf ist idempotent: ein zweiter schreibt nichts.</li>
 * </ol>
 *
 * <p>Der Start-Läufer ist im Testlauf aus (surefire); der Test ruft {@link FunktionBestandLaeufer#lauf()}
 * selbst, NACH {@link BestandsuebernahmeLaeufer#lauf()} — dieselbe Reihenfolge wie beim Start.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@ActiveProfiles("local")
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class FunktionBestandApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    /** Die Dev-Saat (db/dev/V100, V20260706020000): drei Anlagen bzw. eine. */
    private static final UUID DEMO = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID NORDWIND = UUID.fromString("10000000-0000-0000-0000-000000000001");
    private static final UUID NORDWIND_SITE = UUID.fromString("10000000-0000-0000-0000-000000000002");

    /** Referenzunternehmen 1.1: Betriebsmodell Lastspitzenkappung von AN-1 seit 02.05.2024. */
    private static final Instant LSK_SEIT = OffsetDateTime.parse("2024-05-02T00:00:00+02:00").toInstant();
    /** Nach dem 15.10.2026: alle drei Anlagen des Referenzunternehmens sind zugeordnet. */
    private static final Instant JETZT = Instant.parse("2026-11-02T09:00:00Z");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", () -> APP_USER);
        registry.add("spring.datasource.password", () -> APP_PW);
        registry.add("voltpilot.admin-datasource.url", POSTGRES::getJdbcUrl);
        registry.add("voltpilot.admin-datasource.username", () -> ADMIN_USER);
        registry.add("voltpilot.admin-datasource.password", () -> ADMIN_PW);
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
        registry.add("spring.flyway.placeholders.appDbUser", () -> APP_USER);
        registry.add("spring.flyway.placeholders.appDbPassword", () -> APP_PW);
        registry.add("spring.flyway.placeholders.adminDbUser", () -> ADMIN_USER);
        registry.add("spring.flyway.placeholders.adminDbPassword", () -> ADMIN_PW);
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot");
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot/protocol/openid-connect/certs");
    }

    @Autowired
    BestandsuebernahmeLaeufer standortLaeufer;

    @Autowired
    FunktionBestandLaeufer laeufer;

    @Autowired
    FunktionBestandService dienst;

    @Autowired
    FunktionRepository funktionen;

    @Autowired
    FunktionTeilnahmeRepository teilnahmen;

    @Autowired
    FunktionBestandFakten fakten;

    private static JdbcTemplate root;
    private static Ahrenberg ahrenberg;
    private static Scharf scharf;
    private static Map<String, String> tabellenNachDemUmstieg;

    private record Ahrenberg(UUID tenant, UUID werkAhrenberg, UUID werkLindach, UUID an1, UUID an2, UUID an3) {}

    private record Scharf(UUID tenant, UUID standort, UUID wechselrichter, UUID zweite) {}

    // ---- (1) der Umstieg: A11, reine Messung, eingerichtet — und nichts sonst -----------

    @Test
    @Order(1)
    void a11DieSeedAnlagenErgebenAktivOderKeinObjektUndDerBestandBleibtZeichengleich() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        ahrenberg = ahrenberg();
        scharf = scharf();
        assertThat(standortLaeufer.lauf().fehler()).isZero();
        dienst.uhrStellen(Clock.fixed(JETZT, ZoneOffset.UTC));

        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of("funktion%"));
        String profileVorher = profilstand();
        FunktionBestandLaeufer.Lauf lauf = laeufer.lauf();

        assertThat(lauf.fehler()).isZero();
        assertThat(lauf.funktionenAngelegt()).isEqualTo(2);
        assertThat(lauf.teilnahmenAktiv()).isOne();
        assertThat(lauf.teilnahmenEingerichtet()).isOne();
        // Der Lauf schaltet nichts: site_profile_state byte-gleich, jede andere Tabelle zeichengleich.
        assertThat(profilstand()).isEqualTo(profileVorher);
        assertThat(profileVorher).contains(ahrenberg.an1() + "|lastspitzenkappung|an|");
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of("funktion%"))))
                .isEmpty();

        // A11: Werk Ahrenberg — Steuern & Optimieren aktiv seit 02.05.2024 (übernommen), mit Halle 1.
        als(ahrenberg.tenant(), () -> {
            FunktionRepository.Funktion f = funktionen.laufende(ahrenberg.werkAhrenberg(),
                    FunktionZustandAbleitung.Funktion.STEUERN).orElseThrow();
            assertThat(f.zustand()).isEqualTo(FunktionZustandAbleitung.Zustand.AKTIV);
            assertThat(f.aktivSeit()).isEqualTo(LSK_SEIT);
            assertThat(f.eingerichtetAm()).as("der Bestand kennt kein Einrichtungsdatum").isNull();
            assertThat(f.geaendertVon()).isEqualTo("VoltPilot (Bestandsübernahme)");
            List<FunktionTeilnahmeRepository.Teilnahme> t = teilnahmen.derFunktion(f.id());
            assertThat(t).hasSize(1);
            assertThat(t.get(0).siteId()).isEqualTo(ahrenberg.an1());
            assertThat(t.get(0).zustand()).isEqualTo(FunktionZustandAbleitung.Zustand.AKTIV);
            assertThat(t.get(0).uebernommen()).isTrue();
            assertThat(t.get(0).gestartetAm()).isEqualTo(LSK_SEIT);
            assertThat(t.get(0).angehaltenSeit()).isNull();
            // Halle 2 misst nur → keine Teilnahme; Werk Lindach misst nur → kein Objekt; Messen → kein Objekt.
            assertThat(teilnahmen.laufendeDerAnlage(ahrenberg.an2())).isEmpty();
            assertThat(teilnahmen.laufendeDerAnlage(ahrenberg.an3())).isEmpty();
            assertThat(funktionen.laufende(ahrenberg.werkLindach(), FunktionZustandAbleitung.Funktion.STEUERN))
                    .isEmpty();
            assertThat(funktionen.alle()).extracting(FunktionRepository.Funktion::funktion)
                    .containsExactly(FunktionZustandAbleitung.Funktion.STEUERN);
            // Die Vertragsregel sagt dasselbe über den gelesenen Bestand.
            assertThat(FunktionZustandAbleitung.bestand(fakten.lesen(ahrenberg.tenant(), ahrenberg.an1(),
                    "Werk Ahrenberg – Halle 1"), null).text()).isEqualTo("Gestartet am 02.05.2024 (übernommen)");
            return null;
        });

        // Scharfschaltung ohne laufende Betriebsweise → eingerichtet, ohne Datum.
        als(scharf.tenant(), () -> {
            FunktionRepository.Funktion f = funktionen.laufende(scharf.standort(),
                    FunktionZustandAbleitung.Funktion.STEUERN).orElseThrow();
            assertThat(f.zustand()).isEqualTo(FunktionZustandAbleitung.Zustand.EINGERICHTET);
            assertThat(f.eingerichtetAm()).isNull();
            FunktionTeilnahmeRepository.Teilnahme t = teilnahmen.laufendeDerAnlage(scharf.wechselrichter()).orElseThrow();
            assertThat(t.zustand()).isEqualTo(FunktionZustandAbleitung.Zustand.EINGERICHTET);
            assertThat(t.gestartetAm()).isNull();
            assertThat(t.uebernommen()).isTrue();
            return null;
        });

        // Die Dev-Saat: Hamburg (demo2, ein Standort seit der Standort-Übernahme) steuert nicht —
        // weder gespeichertes Betriebsmodell noch Scharfschaltung, Regel oder Lade-Steuerart →
        // kein Objekt. Die drei demo-Anlagen haben nur Vorschläge, also keinen Geltungsbereich.
        als(NORDWIND, () -> {
            FunktionZustandAbleitung.BestandEingang e = fakten.lesen(NORDWIND, NORDWIND_SITE, "Nordwind Hamburg");
            assertThat(FunktionZustandAbleitung.bestand(e, null).zustand())
                    .isEqualTo(FunktionZustandAbleitung.Zustand.KEIN_OBJEKT);
            assertThat(funktionen.alle()).isEmpty();
            assertThat(teilnahmen.alle()).isEmpty();
            return null;
        });
        assertThat(root.queryForObject("SELECT count(*) FROM standort WHERE tenant_id = ?", Long.class, NORDWIND))
                .isOne();
        assertThat(root.queryForObject("SELECT count(*) FROM funktion WHERE tenant_id IN (?, ?)", Long.class,
                DEMO, NORDWIND)).isZero();
        tabellenNachDemUmstieg = Bestandsschutz.fingerabdruck(root, List.of());
    }

    // ---- (2) idempotent -----------------------------------------------------------------

    @Test
    @Order(2)
    void einZweiterLaufSchreibtNichts() {
        FunktionBestandLaeufer.Lauf lauf = laeufer.lauf();
        assertThat(lauf.fehler()).isZero();
        assertThat(lauf.geaendert()).isFalse();
        assertThat(Bestandsschutz.fingerabdruck(root, List.of())).isEqualTo(tabellenNachDemUmstieg);
    }

    /** Eine Anlage mit Teilnahme wird nie wieder betrachtet — auch wenn sich ihr Bestand ändert. */
    @Test
    @Order(3)
    void eineVorhandeneTeilnahmeBleibtStehen() {
        root.update("INSERT INTO site_charging_config (site_id, tenant_id, surplus_policy) VALUES (?, ?, 'nur_sonne')",
                scharf.wechselrichter(), scharf.tenant());
        FunktionBestandLaeufer.Lauf lauf = laeufer.lauf();
        assertThat(lauf.geaendert()).isFalse();
        assertThat(Bestandsschutz.fingerabdruck(root, List.of("site_charging_config")))
                .isEqualTo(without(tabellenNachDemUmstieg, "site_charging_config"));
    }

    // ---- (3) der Standort trägt immer den höchsten Zustand seiner Anlagen -------------------

    @Test
    @Order(4)
    void eineSpaeterLaufendeAnlageZiehtDenStandortNach() {
        // Eine zweite Anlage am Standort mit „Sonne zuerst“ als Lade-Steuerart: sie läuft (ohne Datum).
        root.update("INSERT INTO site_charging_config (site_id, tenant_id, surplus_policy) VALUES (?, ?, 'sonne_zuerst')",
                scharf.zweite(), scharf.tenant());
        // Werk Lindach (bisher reine Messung) bekommt eine aktive Regel seit dem 01.11.2026, dazu einen Entwurf.
        Instant regelSeit = Instant.parse("2026-11-01T07:30:00Z");
        UUID regel = UUID.randomUUID();
        root.update("INSERT INTO flow_definition (flow_id, flow_version, tenant_id, site_id, name, lifecycle, document, "
                + "activated_at) VALUES (?, 1, ?, ?, 'Kompressor nachts', 'active', '{}'::jsonb, ?)", regel,
                ahrenberg.tenant(), ahrenberg.an3(), Timestamp.from(regelSeit));
        root.update("INSERT INTO flow_definition (flow_id, flow_version, tenant_id, site_id, name, lifecycle, document) "
                + "VALUES (?, 2, ?, ?, 'Kompressor nachts', 'draft', '{}'::jsonb)", regel, ahrenberg.tenant(),
                ahrenberg.an3());
        // Der nächste Start, einen Tag später.
        dienst.uhrStellen(Clock.fixed(JETZT.plusSeconds(86_400), ZoneOffset.UTC));
        FunktionBestandLaeufer.Lauf lauf = laeufer.lauf();
        assertThat(lauf.fehler()).isZero();
        assertThat(lauf.funktionenAngelegt()).isOne();
        assertThat(lauf.funktionenNachgezogen()).isOne();
        assertThat(lauf.teilnahmenAktiv()).isEqualTo(2);
        als(ahrenberg.tenant(), () -> {
            FunktionRepository.Funktion f = funktionen.laufende(ahrenberg.werkLindach(),
                    FunktionZustandAbleitung.Funktion.STEUERN).orElseThrow();
            assertThat(f.zustand()).isEqualTo(FunktionZustandAbleitung.Zustand.AKTIV);
            assertThat(f.aktivSeit()).isEqualTo(regelSeit);
            assertThat(teilnahmen.laufendeDerAnlage(ahrenberg.an3()).orElseThrow().gestartetAm()).isEqualTo(regelSeit);
            // Halle 2 misst weiter nur: der Lauf betrachtet sie erneut und legt wieder nichts an.
            assertThat(teilnahmen.laufendeDerAnlage(ahrenberg.an2())).isEmpty();
            return null;
        });
        als(scharf.tenant(), () -> {
            FunktionRepository.Funktion f = funktionen.laufende(scharf.standort(),
                    FunktionZustandAbleitung.Funktion.STEUERN).orElseThrow();
            assertThat(f.zustand()).isEqualTo(FunktionZustandAbleitung.Zustand.AKTIV);
            assertThat(f.aktivSeit()).as("der Beginn der Lade-Steuerart ist nicht bekannt").isNull();
            assertThat(teilnahmen.derFunktion(f.id())).extracting(FunktionTeilnahmeRepository.Teilnahme::zustand)
                    .containsExactly(FunktionZustandAbleitung.Zustand.EINGERICHTET,
                            FunktionZustandAbleitung.Zustand.AKTIV);
            return null;
        });
        assertThat(laeufer.lauf().geaendert()).isFalse();
    }

    // ===================================================================== Gerüst

    /** Das Referenzunternehmen 1.1: zwei Standorte, drei Anlagen, AN-1 mit Lastspitzenkappung. */
    private static Ahrenberg ahrenberg() {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES ('Kunststoffwerk Ahrenberg GmbH') RETURNING id",
                UUID.class);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, "
                + "'Kunststoffwerk Ahrenberg GmbH', 'Europe/Berlin') RETURNING id", UUID.class, t);
        UUID st1 = standort(t, u, "Werk Ahrenberg", "ST-1");
        UUID st2 = standort(t, u, "Werk Lindach", "ST-2");
        UUID an1 = anlage(t, st1, "Werk Ahrenberg – Halle 1", "2024-03-12T00:00:00+01:00");
        UUID an2 = anlage(t, st1, "Werk Ahrenberg – Halle 2", "2026-10-01T00:00:00+02:00");
        UUID an3 = anlage(t, st2, "Werk Lindach", "2026-10-15T00:00:00+02:00");
        root.update("INSERT INTO site_profile_state (site_id, profile, state, tenant_id, updated_at) "
                + "VALUES (?, 'lastspitzenkappung', 'an', ?, ?)", an1, t, Timestamp.from(LSK_SEIT));
        return new Ahrenberg(t, st1, st2, an1, an2, an3);
    }

    /** Ein Kundenbereich mit scharfgeschaltetem Wechselrichter ohne Speicher und eine zweite Anlage. */
    private static Scharf scharf() {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES ('Scharf ohne Speicher') RETURNING id", UUID.class);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, 'Scharf', "
                + "'Europe/Berlin') RETURNING id", UUID.class, t);
        UUID st = standort(t, u, "Werk Scharf", "ST-1");
        UUID an = anlage(t, st, "Halle Scharf", "2025-01-10T00:00:00+01:00");
        UUID zweite = anlage(t, st, "Halle Laden", "2025-02-10T00:00:00+01:00");
        UUID geraet = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, kind, status) "
                + "VALUES (?, ?, ?, 'inverter', 'claimed') RETURNING id", UUID.class, t, an,
                "VP-SCHARF-" + UUID.randomUUID());
        root.update("INSERT INTO device_control_activation (device_id, activated_by, note) VALUES (?, 'betrieb', "
                + "'Scharfschaltung Prüfstand')", geraet);
        return new Scharf(t, st, an, zweite);
    }

    private static UUID standort(UUID tenant, UUID unternehmen, String name, String kurzzeichen) {
        return root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, tenant, unternehmen,
                name, kurzzeichen);
    }

    private static UUID anlage(UUID tenant, UUID standort, String name, String seit) {
        OffsetDateTime ab = OffsetDateTime.parse(seit);
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) RETURNING id",
                UUID.class, tenant, name, Timestamp.from(ab.toInstant()));
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES (?, ?, ?, ?)",
                tenant, site, standort, ab.toLocalDate());
        return site;
    }

    /** Die Zeilen von site_profile_state als Text, Spalte für Spalte — der Byte-Vergleich. */
    private static String profilstand() {
        return root.queryForObject("SELECT coalesce(string_agg(site_id || '|' || profile || '|' || state || '|' "
                + "|| tenant_id || '|' || updated_at, E'\\n' ORDER BY site_id, profile), 'leer') FROM site_profile_state",
                String.class);
    }

    private static Map<String, String> without(Map<String, String> stand, String tabelle) {
        Map<String, String> aus = new java.util.LinkedHashMap<>(stand);
        aus.remove(tabelle);
        return aus;
    }

    private static <T> T als(UUID tenant, Supplier<T> arbeit) {
        TenantContext.set(tenant);
        try {
            return arbeit.get();
        } finally {
            TenantContext.clear();
        }
    }
}
