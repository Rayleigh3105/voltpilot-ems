package com.voltpilot.api.ruhezeit;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.ueberwachung.UeberwachungRepository;
import com.voltpilot.api.versand.VersandRepository;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Alerting Scheibe 3 (Konzept §6.4 "Ruhezeiten und Stummschalten"): {@link RuhezeitPruefungImpl}
 * gegen echte Zeilen - Ruhezeit der Person, Ruhezeit der Regel (das SPÄTERE Ende gilt), die
 * Durchbruch-Logik für Dringend über Push (Entscheid 8A, Schalter "Dringendes trotzdem melden"),
 * Stummschaltung (endgültig) und der Mandanten-/Standort-Zaun auf {@code ruhezeit_person}/
 * {@code stummschaltung}.
 */
@Testcontainers(disabledWithoutDocker = true)
class RuhezeitScheibe3IT {

    private static final String APP = "voltpilot_app";
    private static final String ADMIN = "voltpilot_admin";
    private static final String PW = "ruhezeit_it_pw";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static JdbcTemplate app;
    private static JdbcTemplate adminJdbc;
    private static RuhezeitRepository ruhezeitRepo;
    private static UeberwachungRepository ueberwachungRepo;
    private static VersandRepository versandRepo;
    private static RuhezeitPruefungImpl pruefung;

    @BeforeAll
    static void migrate() {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP, "appDbPassword", PW, "adminDbUser", ADMIN,
                        "adminDbPassword", PW))
                .load()
                .migrate();
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP, PW)));
        adminJdbc = new JdbcTemplate(ds(ADMIN, PW));
        ruhezeitRepo = new RuhezeitRepository(app, adminJdbc);
        ueberwachungRepo = new UeberwachungRepository(app);
        versandRepo = new VersandRepository(app, adminJdbc);
        pruefung = new RuhezeitPruefungImpl(ueberwachungRepo, ruhezeitRepo, versandRepo);
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    private record Welt(UUID tenant, UUID standort, UUID anlage) {}

    private static Welt welt(String name) {
        UUID tenant = UUID.randomUUID();
        UUID unternehmen = UUID.randomUUID();
        UUID standort = UUID.randomUUID();
        UUID anlage = UUID.randomUUID();
        adminJdbc.update("INSERT INTO tenant (id, name) VALUES (?, ?)", tenant, name);
        adminJdbc.update("INSERT INTO unternehmen (id, tenant_id, name) VALUES (?, ?, ?)", unternehmen, tenant, name);
        adminJdbc.update("INSERT INTO standort (id, tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv')", standort, tenant,
                unternehmen);
        adminJdbc.update("INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, 'Halle 1', 'DE-LU')",
                anlage, tenant);
        return new Welt(tenant, standort, anlage);
    }

    private static UUID regelAnlegen(Welt w, String schwere, JsonFenster ruhezeit) {
        UUID regel = UUID.randomUUID();
        app.update("INSERT INTO ueberwachung (id, tenant_id, standort_id, wertart, bezug, bedingung, schwere, "
                + "empfaenger, herkunft, angelegt_von, ruhezeit) VALUES (?, ?, ?, 'anlage.netz.leistung', "
                + "jsonb_build_object('anlage', ?::text), '{\"art\":\"ueber\",\"schwelle\":120}'::jsonb, ?, "
                + "'[{\"person\":\"sub-jonas\"}]'::jsonb, 'eigen', 'sub-jonas', ?::jsonb)",
                regel, w.tenant(), w.standort(), w.anlage(), schwere, ruhezeit == null ? null : ruhezeit.json());
        return regel;
    }

    private static UUID alarmAnlegen(Welt w, UUID regel, String schwere, String zustand, String gesehenVon,
            Instant ausgeloestAm) {
        UUID alarm = UUID.randomUUID();
        app.update("INSERT INTO alarm (id, tenant_id, standort_id, kennzeichen, ueberwachung_id, fassung, "
                + "bezug_kennung, wertart, schwere, ausgeloest_am, zustand, gesehen_von, gesehen_am) "
                + "VALUES (?, ?, ?, ?, ?, 1, ?, 'anlage.netz.leistung', ?, ?, ?, ?, ?)",
                alarm, w.tenant(), w.standort(), "AL-TEST-" + alarm.toString().substring(0, 8), regel,
                "anlage:" + w.anlage(), schwere, Timestamp.from(ausgeloestAm), zustand, gesehenVon,
                gesehenVon == null ? null : Timestamp.from(ausgeloestAm));
        return alarm;
    }

    private record JsonFenster(String json) {
        static JsonFenster werktagsGanzeNacht() {
            return new JsonFenster("{\"werktags\":{\"von\":\"00:00\",\"bis\":\"23:59\"}}");
        }
    }

    // =========================================================== Ruhezeit der Person

    @Test
    void aktiveRuhezeitDerPersonVerschiebtWarnungAufsEnde() {
        Welt w = welt("Ruhezeit Person");
        TenantContext.set(w.tenant());
        try {
            ruhezeitRepo.setzen("sub-jonas", "{\"werktags\":{\"von\":\"00:00\",\"bis\":\"23:59\"}}", "Europe/Berlin",
                    true);
            UUID regel = regelAnlegen(w, "warnung", null);
            Instant jetzt = Instant.now();
            UUID alarm = alarmAnlegen(w, regel, "warnung", "aktiv", null, jetzt);

            Instant wann = pruefung.wannSenden(alarm, "sub-jonas", "email", "ausgeloest", jetzt);
            assertThat(wann).isAfter(jetzt);
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void ohneRuhezeitWirdAmTagSofortGesendet() {
        Welt w = welt("Keine Ruhezeit");
        TenantContext.set(w.tenant());
        try {
            UUID regel = regelAnlegen(w, "warnung", null);
            // Dienstag 14 Uhr Europe/Berlin: außerhalb der Vorgabe (B4, werktags 22-7) UND des
            // Wochenendes - ein fester Zeitpunkt statt Instant.now(), sonst wäre dieser Test seit B4
            // nachts/am Wochenende flaky.
            Instant jetzt = Instant.parse("2026-10-20T12:00:00Z");
            UUID alarm = alarmAnlegen(w, regel, "warnung", "aktiv", null, jetzt);

            Instant wann = pruefung.wannSenden(alarm, "sub-jonas", "email", "ausgeloest", jetzt);
            assertThat(wann).isEqualTo(jetzt);
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void ohneEigeneRuhezeitGiltTrotzdemDieNaechtlicheVorgabe() {
        // B4: ohne eine je gespeicherte Zeile in `ruhezeit_person` galt beim Versand bisher GAR
        // keine Ruhezeit der Person - obwohl die Fläche längst die Vorgabe "werktags 22 bis 7 Uhr, am
        // Wochenende ganz" zeigt. Was angezeigt wird, muss auch gelten.
        Welt w = welt("Vorgabe ohne eigene Zeile");
        TenantContext.set(w.tenant());
        try {
            UUID regel = regelAnlegen(w, "warnung", null);
            // Dienstag 23 Uhr Europe/Berlin: innerhalb der Vorgabe (werktags 22-7).
            Instant jetzt = Instant.parse("2026-10-20T21:00:00Z");
            UUID alarm = alarmAnlegen(w, regel, "warnung", "aktiv", null, jetzt);

            Instant wann = pruefung.wannSenden(alarm, "sub-jonas", "email", "ausgeloest", jetzt);
            assertThat(wann).isAfter(jetzt);
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void regelRuhezeitGiltAuchOhnePersonenRuhezeitUndDasSpaetereEndeGewinnt() {
        Welt w = welt("Ruhezeit Regel");
        TenantContext.set(w.tenant());
        try {
            UUID regel = regelAnlegen(w, "warnung", JsonFenster.werktagsGanzeNacht());
            Instant jetzt = Instant.now();
            UUID alarm = alarmAnlegen(w, regel, "warnung", "aktiv", null, jetzt);

            Instant wann = pruefung.wannSenden(alarm, "sub-jonas", "email", "ausgeloest", jetzt);
            assertThat(wann).isAfter(jetzt);
        } finally {
            TenantContext.clear();
        }
    }

    // =========================================================== Entscheid 4A: Dringend durchbricht auf JEDEM Weg

    @Test
    void dringendDurchbrichtRuhezeitAufJedemWegWennSchalterAn() {
        Welt w = welt("Dringend durchbricht");
        TenantContext.set(w.tenant());
        try {
            ruhezeitRepo.setzen("sub-jonas", "{\"werktags\":{\"von\":\"00:00\",\"bis\":\"23:59\"}}", "Europe/Berlin",
                    true);
            UUID regel = regelAnlegen(w, "dringend", null);
            Instant jetzt = Instant.now();
            UUID alarm = alarmAnlegen(w, regel, "dringend", "aktiv", null, jetzt);

            // Entscheid 4A: der Schalter gilt gleich fuer JEDEN Weg, nicht nur Push.
            assertThat(pruefung.wannSenden(alarm, "sub-jonas", "webpush", "ausgeloest", jetzt)).isEqualTo(jetzt);
            assertThat(pruefung.wannSenden(alarm, "sub-jonas", "email", "ausgeloest", jetzt)).isEqualTo(jetzt);
            assertThat(pruefung.wannSenden(alarm, "sub-jonas", "webhook", "ausgeloest", jetzt)).isEqualTo(jetzt);
            assertThat(pruefung.wannSenden(alarm, "sub-jonas", "telegram", "ausgeloest", jetzt)).isEqualTo(jetzt);
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void dringendWirdAufJedemWegGehaltenWennSchalterAus() {
        Welt w = welt("Dringend Schalter aus");
        TenantContext.set(w.tenant());
        try {
            ruhezeitRepo.setzen("sub-jonas", "{\"werktags\":{\"von\":\"00:00\",\"bis\":\"23:59\"}}", "Europe/Berlin",
                    false);
            UUID regel = regelAnlegen(w, "dringend", null);
            Instant jetzt = Instant.now();
            UUID alarm = alarmAnlegen(w, regel, "dringend", "aktiv", null, jetzt);

            // B5-Regression: vor der Behebung durchbrachen E-Mail/Webhook/Telegram die Ruhezeit
            // IMMER, unabhaengig vom Schalter - nur Push hielt sich daran.
            assertThat(pruefung.wannSenden(alarm, "sub-jonas", "webpush", "ausgeloest", jetzt)).isAfter(jetzt);
            assertThat(pruefung.wannSenden(alarm, "sub-jonas", "email", "ausgeloest", jetzt)).isAfter(jetzt);
            assertThat(pruefung.wannSenden(alarm, "sub-jonas", "webhook", "ausgeloest", jetzt)).isAfter(jetzt);
            assertThat(pruefung.wannSenden(alarm, "sub-jonas", "telegram", "ausgeloest", jetzt)).isAfter(jetzt);
        } finally {
            TenantContext.clear();
        }
    }

    // =========================================================== 3B: erledigt/gesehen unterdrückt endgültig

    @Test
    void einErledigterAlarmBekommtKeineVerspaeteteMeldungMehr() {
        Welt w = welt("Erledigt waehrend Ruhezeit");
        TenantContext.set(w.tenant());
        try {
            UUID regel = regelAnlegen(w, "warnung", null);
            Instant jetzt = Instant.now();
            UUID alarm = alarmAnlegen(w, regel, "warnung", "erledigt", null, jetzt);

            assertThat(pruefung.wannSenden(alarm, "sub-jonas", "email", "ausgeloest", jetzt)).isEqualTo(Instant.MAX);
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void erinnerungEndetBeiGesehen() {
        Welt w = welt("Erinnerung endet bei Gesehen");
        TenantContext.set(w.tenant());
        try {
            UUID regel = regelAnlegen(w, "dringend", null);
            Instant jetzt = Instant.now();
            UUID alarm = alarmAnlegen(w, regel, "dringend", "aktiv", "sub-jonas", jetzt);

            assertThat(pruefung.wannSenden(alarm, "sub-jonas", "webpush", "erinnerung", jetzt))
                    .isEqualTo(Instant.MAX);
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void zusammenfassungWirdNieDurchRuhezeitGehalten() {
        Welt w = welt("Zusammenfassung nie gehalten");
        TenantContext.set(w.tenant());
        try {
            ruhezeitRepo.setzen("sub-jonas", "{\"werktags\":{\"von\":\"00:00\",\"bis\":\"23:59\"}}", "Europe/Berlin",
                    true);
            Instant jetzt = Instant.now();
            assertThat(pruefung.wannSenden(UUID.randomUUID(), "sub-jonas", "email", "zusammenfassung", jetzt))
                    .isEqualTo(jetzt);
        } finally {
            TenantContext.clear();
        }
    }

    // =========================================================== B7: "Wieder normal" haelt wie die Ausloesung

    @Test
    void wiederNormalHaeltWieDieAusloesungSelbst() {
        // B7: vor der Behebung kam "Wieder normal" um 4 Uhr fuer eine Warnung, die die Ruhezeit
        // noch bis 7 Uhr zurueckhielt - eine Entwarnung fuer etwas, das nie ankam. Ohne eine
        // unterdrueckte Ausloesungs-Zeile (hier: noch keine Zeile ueberhaupt, der haeufige Fall -
        // der Zusteller reiht die Ausloesung erst beim naechsten Alarm-Ereignis ein) haelt die
        // Entwarnung genauso wie die Ausloesung selbst gehalten haette.
        Welt w = welt("Wieder normal haelt");
        TenantContext.set(w.tenant());
        try {
            ruhezeitRepo.setzen("sub-jonas", "{\"werktags\":{\"von\":\"00:00\",\"bis\":\"23:59\"}}", "Europe/Berlin",
                    true);
            UUID regel = regelAnlegen(w, "warnung", null);
            Instant jetzt = Instant.now();
            UUID alarm = alarmAnlegen(w, regel, "warnung", "erledigt", null, jetzt);

            Instant wann = pruefung.wannSenden(alarm, "sub-jonas", "email", "wieder_normal", jetzt);
            assertThat(wann).isAfter(jetzt);
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void wiederNormalEntfaelltWennDieAusloesungEndgueltigUnterdrueicktWurde() {
        // B7: entfaellt genau dann, wenn die Ausloesung fuer diesen Empfaenger/Weg selbst nie
        // ankommt (keine Sicht oder Stummschaltung) - keine Entwarnung fuer einen Alarm, den die
        // Person nie als aktiv sah.
        Welt w = welt("Wieder normal entfaellt");
        TenantContext.set(w.tenant());
        try {
            UUID regel = regelAnlegen(w, "warnung", null);
            Instant jetzt = Instant.now();
            UUID alarm = alarmAnlegen(w, regel, "warnung", "erledigt", null, jetzt);
            app.update("INSERT INTO benachrichtigung (tenant_id, quelle, quelle_id, empfaenger_sub, weg, anlass, "
                            + "nr, betreff, inhalt, naechster_versuch, zustand) "
                            + "VALUES (?, 'alarm', ?, 'sub-jonas', 'email', 'ausgeloest', 0, 'x', 'x', ?, "
                            + "'unterdrueckt')",
                    w.tenant(), alarm, Timestamp.from(jetzt));

            assertThat(pruefung.wannSenden(alarm, "sub-jonas", "email", "wieder_normal", jetzt))
                    .isEqualTo(Instant.MAX);
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void wiederNormalGehtSofortWennDieAusloesungAnkam() {
        Welt w = welt("Wieder normal sofort");
        TenantContext.set(w.tenant());
        try {
            UUID regel = regelAnlegen(w, "warnung", null);
            // Dienstag 14 Uhr Europe/Berlin: ausserhalb jeder Ruhezeit (siehe ohneRuhezeitWirdAmTagSofortGesendet).
            Instant jetzt = Instant.parse("2026-10-20T12:00:00Z");
            UUID alarm = alarmAnlegen(w, regel, "warnung", "erledigt", null, jetzt);
            app.update("INSERT INTO benachrichtigung (tenant_id, quelle, quelle_id, empfaenger_sub, weg, anlass, "
                            + "nr, betreff, inhalt, naechster_versuch, zustand) "
                            + "VALUES (?, 'alarm', ?, 'sub-jonas', 'email', 'ausgeloest', 0, 'x', 'x', ?, 'gesendet')",
                    w.tenant(), alarm, Timestamp.from(jetzt));

            assertThat(pruefung.wannSenden(alarm, "sub-jonas", "email", "wieder_normal", jetzt)).isEqualTo(jetzt);
        } finally {
            TenantContext.clear();
        }
    }

    // =========================================================== Stummschaltung (§6.4, endgültig)

    @Test
    void stummschaltungEinerRegelUnterdrueicktEndgueltig() {
        Welt w = welt("Stumm Regel");
        TenantContext.set(w.tenant());
        try {
            UUID regel = regelAnlegen(w, "warnung", null);
            Instant jetzt = Instant.now();
            UUID alarm = alarmAnlegen(w, regel, "warnung", "aktiv", null, jetzt);
            ruhezeitRepo.anlegen("{\"regel\":\"" + regel + "\"}", w.standort(), jetzt.minusSeconds(60),
                    jetzt.plusSeconds(3600), "Wartung", "sub-ines");

            assertThat(pruefung.wannSenden(alarm, "sub-jonas", "email", "ausgeloest", jetzt)).isEqualTo(Instant.MAX);
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void stummschaltungDerAnlageTrifftAuchIhreRegeln() {
        Welt w = welt("Stumm Anlage");
        TenantContext.set(w.tenant());
        try {
            UUID regel = regelAnlegen(w, "warnung", null);
            Instant jetzt = Instant.now();
            UUID alarm = alarmAnlegen(w, regel, "warnung", "aktiv", null, jetzt);
            ruhezeitRepo.anlegen("{\"anlage\":\"" + w.anlage() + "\"}", w.standort(), jetzt.minusSeconds(60),
                    jetzt.plusSeconds(3600), "Wartung", "sub-ines");

            assertThat(pruefung.wannSenden(alarm, "sub-jonas", "email", "ausgeloest", jetzt)).isEqualTo(Instant.MAX);
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void stummschaltungBrauchtEinEndeInDerZukunft() {
        Welt w = welt("Stumm ohne Ende");
        TenantContext.set(w.tenant());
        try {
            org.junit.jupiter.api.function.Executable ohneZukunft = () -> ruhezeitRepo.anlegen(
                    "{\"standort\":\"" + w.standort() + "\"}", w.standort(), Instant.now(),
                    Instant.now().minusSeconds(1), "Grund", "sub-ines");
            org.junit.jupiter.api.Assertions.assertThrows(Exception.class, ohneZukunft);
        } finally {
            TenantContext.clear();
        }
    }

    // =========================================================== Mandanten-/Standort-Zaun

    @Test
    void ruhezeitPersonUndStummschaltungSindMandantenGetrennt() {
        Welt w1 = welt("Zaun A");
        Welt w2 = welt("Zaun B");
        TenantContext.set(w1.tenant());
        try {
            ruhezeitRepo.setzen("sub-geteilt", "{\"werktags\":{\"von\":\"22:00\",\"bis\":\"07:00\"}}",
                    "Europe/Berlin", true);
        } finally {
            TenantContext.clear();
        }
        TenantContext.set(w2.tenant());
        try {
            assertThat(ruhezeitRepo.eigene("sub-geteilt")).isEmpty();
        } finally {
            TenantContext.clear();
        }
        // Für den Zusteller (BYPASSRLS-Pfad) bleibt der Mandant trotzdem der entscheidende Schlüssel.
        assertThat(ruhezeitRepo.fuerVersand(w1.tenant(), "sub-geteilt")).isPresent();
        assertThat(ruhezeitRepo.fuerVersand(w2.tenant(), "sub-geteilt")).isEmpty();
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
