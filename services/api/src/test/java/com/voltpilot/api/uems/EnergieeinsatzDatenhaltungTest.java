package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.EnergieeinsatzRepository.Einfluss;
import com.voltpilot.api.uems.EnergieeinsatzRepository.Neu;
import java.nio.file.Path;
import java.sql.SQLException;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.interceptor.TransactionInterceptor;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/** DB-Grenzen und Repository unter der wirklichen App-Rolle; kein Superuser als Kunden-Schreibweg. */
@Testcontainers(disabledWithoutDocker = true)
class EnergieeinsatzDatenhaltungTest {
    private static final String APP = "voltpilot_app", ADMIN = "voltpilot_admin", PW = "ip3_test_pw";
    private static final ProtokollAkteur IK = new ProtokollAkteur("IK", "Ines Kaltenbach", "energiemanager", "kunde");
    private static final List<String> TABELLEN = List.of("energieeinsatz", "energieeinsatz_einflussgroesse",
            "energieeinsatz_aenderung", "energieeinsatz_kennzeichen_seq");
    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");
    private static JdbcTemplate root, app;
    private static EnergieeinsatzRepository repo;
    private UUID tenant, unternehmen, prozess;

    @BeforeAll
    static void start() {
        Flyway.configure().dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration").baselineOnMigrate(true).baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP, "appDbPassword", PW, "adminDbUser", ADMIN, "adminDbPassword", PW))
                .load().migrate();
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        DataSource kundenDs = new TenantAwareDataSource(ds(APP, PW));
        app = new JdbcTemplate(kundenDs);
        ProxyFactory proxy = new ProxyFactory(new EnergieeinsatzRepository(app));
        proxy.setProxyTargetClass(true);
        proxy.addAdvice(new TransactionInterceptor(new DataSourceTransactionManager(kundenDs),
                new AnnotationTransactionAttributeSource()));
        repo = (EnergieeinsatzRepository) proxy.getProxy();
    }

    @BeforeEach
    void welt() {
        tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('Ahrenberg IP-3') RETURNING id", UUID.class);
        unternehmen = root.queryForObject("INSERT INTO unternehmen(tenant_id,name) VALUES (?, 'Ahrenberg') RETURNING id",
                UUID.class, tenant);
        prozess = prozess("P-1");
        benutzer("PH", "Peter Hollerbach");
        benutzer("IK", "Ines Kaltenbach");
        TenantContext.set(tenant);
    }

    @AfterEach
    void clear() {
        TenantContext.clear();
    }

    @Test
    void zweiterLaufenderScheitertInDerDatenbank() {
        UUID erster = anlegen("Strom");
        sqlFehler("23505", () -> anlegen("Strom"));
        assertThat(repo.jeProzess(prozess)).extracting(EnergieeinsatzRepository.Zeile::id).containsExactly(erster);
        assertThat(repo.aenderungen(erster)).hasSize(1);
    }

    @Test
    void nachEndeNeuerEinsatzMitFortlaufendemKennzeichenUndHistorie() {
        UUID erster = anlegen("Strom");
        assertThat(repo.beenden(erster, LocalDate.parse("2026-11-30"), "Nachfolger", IK)).isTrue();
        UUID zweiter = anlegen("Strom");
        assertThat(repo.finde(erster).orElseThrow().kennzeichen()).isEqualTo("EE-1");
        assertThat(repo.finde(zweiter).orElseThrow().kennzeichen()).isEqualTo("EE-2");
        assertThat(repo.jeUnternehmen(unternehmen)).hasSize(2);
        assertThat(repo.beenden(erster, LocalDate.parse("2026-12-31"), "nochmals", IK)).isFalse();
        assertThat(repo.aenderungen(erster)).extracting(EnergieeinsatzRepository.Aenderung::art)
                .containsExactly("angelegt", "beendet");
    }

    @Test
    void traegerGeschlossenAberGasNebenStromErlaubt() {
        anlegen("Strom");
        anlegen("Gas");
        sqlFehler("23514", () -> anlegen("unbekannt"));
        assertThat(repo.jeProzess(prozess)).hasSize(2);
    }

    @Test
    void einflussGenauVerweisOderWortlautUndGeschlossenesArtVokabular() {
        UUID id = anlegen("Strom"), bz = bezugsgroesse("BZ-1");
        sqlFehler("23514", () -> einfluss(id, bz, "beides", "produktion"));
        sqlFehler("23514", () -> einfluss(id, null, null, "produktion"));
        sqlFehler("23514", () -> einfluss(id, null, " ", "produktion"));
        sqlFehler("23514", () -> einfluss(id, null, "Temperatur", "rechnung"));
        repo.einflussgroessenErsetzen(id, List.of(new Einfluss(bz, null, "produktion"),
                new Einfluss(null, "Außentemperatur", "wetter")), IK);
        assertThat(repo.einflussgroessen(id, false)).hasSize(2);
    }

    @Test
    void ersetzenBewahrtVorgaengerUndRolltBeiFehlerAllesZurueck() {
        UUID id = anlegen("Strom");
        repo.einflussgroessenErsetzen(id, List.of(new Einfluss(null, "Schichten", "betriebszeit")), IK);
        sqlFehler("23514", () -> repo.einflussgroessenErsetzen(id, List.of(new Einfluss(null, null, "wetter")), IK));
        assertThat(repo.einflussgroessen(id, false)).extracting(EnergieeinsatzRepository.EinflussZeile::wortlaut)
                .containsExactly("Schichten");
        assertThat(repo.aenderungen(id)).hasSize(2);
        repo.einflussgroessenErsetzen(id, List.of(new Einfluss(null, "Temperatur", "wetter")), IK);
        assertThat(repo.einflussgroessen(id, true)).hasSize(2);
        assertThat(repo.einflussgroessen(id, false)).hasSize(1);
        assertThat(repo.aenderungen(id).getLast().alt()).contains("Schichten");
    }

    @Test
    void fremderMandantSiehtNichtsUndKannNichtsEinschleusen() {
        UUID id = anlegen("Strom"), bz = bezugsgroesse("BZ-1"), altTenant = tenant, altProzess = prozess;
        repo.einflussgroessenErsetzen(id, List.of(new Einfluss(bz, null, "produktion")), IK);
        welt();
        assertThat(repo.finde(id)).isEmpty();
        assertThat(repo.jeProzess(altProzess)).isEmpty();
        assertThat(repo.einflussgroessen(id, true)).isEmpty();
        assertThat(repo.aenderungen(id)).isEmpty();
        for (String t : TABELLEN) assertThat(app.queryForObject("SELECT count(*) FROM " + t, Integer.class)).isZero();
        assertThat(repo.verantwortlichenSetzen(id, "PH", IK)).isFalse();
        sqlFehler("23503", () -> repo.anlegen(new Neu(altProzess, "Gas", "Fremd", null, null, "PH",
                LocalDate.parse("2026-11-04")), IK));
        UUID eigener = anlegen("Strom");
        sqlFehler("23503", () -> einfluss(eigener, bz, null, "produktion"));
        sqlFehler("42501", () -> app.update("INSERT INTO energieeinsatz_kennzeichen_seq(tenant_id,zaehler) VALUES (?,99)", altTenant));
        TenantContext.clear();
        assertThat(repo.finde(eigener)).isEmpty();
    }

    @Test
    void protokollUndIdentitaetSindFuerAppUnveraenderlich() {
        UUID id = anlegen("Strom");
        sqlFehler("42501", () -> app.update("UPDATE energieeinsatz_aenderung SET neu = '{}'::jsonb WHERE einsatz_id = ?", id));
        sqlFehler("42501", () -> app.update("DELETE FROM energieeinsatz_aenderung WHERE einsatz_id = ?", id));
        sqlFehler("42501", () -> app.update("UPDATE energieeinsatz SET traeger = 'Gas' WHERE id = ?", id));
        sqlFehler("42501", () -> app.update("DELETE FROM energieeinsatz WHERE id = ?", id));
        for (String t : TABELLEN) {
            assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = ?::regclass",
                    Boolean.class, t)).isTrue();
            assertThat(root.queryForObject("SELECT has_table_privilege(?, ?, 'DELETE')", Boolean.class, APP, t)).isFalse();
        }
    }

    @Test
    void verantwortlicherBleibtAlsSchnappschussBeiKontoEndeUndWechselStehtImProtokoll() {
        UUID id = anlegen("Strom");
        root.update("UPDATE benutzer SET anzeigename = 'Umbenannt', zustand = 'entfernt' WHERE tenant_id = ? AND sub = 'PH'", tenant);
        root.update("INSERT INTO zugriff_protokoll(tenant_id,aktion,betroffener_sub,betroffener_name,actor_sub,actor_name,actor_art) "
                + "VALUES (?,'entfernen','PH','Peter Hollerbach','IK','Ines Kaltenbach','kunde')", tenant);
        var ende = repo.finde(id).orElseThrow();
        assertThat(ende.verantwortlich().name()).isEqualTo("Peter Hollerbach");
        assertThat(ende.verantwortlichZustand()).isEqualTo("entfernt");
        assertThat(ende.ohneKontoSeit()).isNotNull();
        repo.verantwortlichenSetzen(id, "IK", IK);
        assertThat(repo.finde(id).orElseThrow().verantwortlich().name()).isEqualTo("Ines Kaltenbach");
        assertThat(repo.aenderungen(id).getLast().art()).isEqualTo("verantwortlicher");
        assertThat(repo.aenderungen(id).getLast().alt()).contains("Peter Hollerbach");
    }

    @Test
    void referenzunternehmen16TraegtAlleAchtEinsaetze() throws Exception {
        JsonNode referenz = new ObjectMapper().readTree(Path.of("../../docs/contracts/v2/uems-referenzunternehmen.json").toFile());
        Map<String, UUID> prozesse = new HashMap<>(), bezuege = new HashMap<>();
        prozesse.put("P-1", prozess);
        for (JsonNode person : referenz.path("personen")) {
            String sub = person.path("kuerzel").asText();
            if (person.path("art").asText().equals("benutzer") && !List.of("PH", "IK").contains(sub))
                benutzer(sub, person.path("name").asText());
        }
        for (JsonNode e : referenz.path("energieeinsaetze")) {
            UUID p = prozesse.computeIfAbsent(e.path("prozess").asText(), this::prozess);
            UUID id = repo.anlegen(new Neu(p, e.path("traeger").asText(), e.path("name").asText(), null,
                    e.path("verbraucher").asText(), e.path("verantwortlich").asText(),
                    LocalDate.parse(e.path("gueltig_ab").asText())), IK);
            List<Einfluss> eingang = new java.util.ArrayList<>();
            for (JsonNode g : e.path("einflussgroessen")) {
                UUID b = g.path("bezugsgroesse").isNull() || g.path("bezugsgroesse").isMissingNode() ? null
                        : bezuege.computeIfAbsent(g.path("bezugsgroesse").asText(), this::bezugsgroesse);
                eingang.add(new Einfluss(b, b == null ? g.path("text").asText() : null, g.path("art").asText()));
            }
            repo.einflussgroessenErsetzen(id, eingang, IK);
            assertThat(repo.finde(id).orElseThrow().kennzeichen()).isEqualTo(e.path("kennzeichen").asText());
        }
        assertThat(repo.jeUnternehmen(unternehmen)).hasSize(8);
    }

    @Test
    void offboardingRaeumtNeueTabellenVorBenutzerBezugsgroesseUndProzessAb() {
        UUID id = anlegen("Strom");
        repo.einflussgroessenErsetzen(id, List.of(new Einfluss(bezugsgroesse("BZ-1"), null, "produktion")), IK);
        TenantContext.clear();
        new TenantRepository(new JdbcTemplate(ds(ADMIN, PW))).offboard(tenant);
        for (String t : TABELLEN) assertThat(root.queryForObject("SELECT count(*) FROM " + t + " WHERE tenant_id = ?",
                Integer.class, tenant)).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM tenant WHERE id = ?", Integer.class, tenant)).isZero();
    }

    private UUID anlegen(String traeger) {
        return repo.anlegen(new Neu(prozess, traeger, "Einsatz", null, "Maschinen", "PH", LocalDate.parse("2026-11-04")), IK);
    }

    private void einfluss(UUID id, UUID bz, String wortlaut, String art) {
        app.update("INSERT INTO energieeinsatz_einflussgroesse(tenant_id,einsatz_id,bezugsgroesse_id,wortlaut,art,position) "
                + "VALUES (?,?,?,?,?,0)", tenant, id, bz, wortlaut, art);
    }

    private UUID prozess(String kennzeichen) {
        return root.queryForObject("INSERT INTO prozess(tenant_id,unternehmen_id,kennzeichen,name,gueltig_ab) "
                + "VALUES (?,?,?,?,'2026-01-01') RETURNING id", UUID.class, tenant, unternehmen, kennzeichen, kennzeichen);
    }

    private UUID bezugsgroesse(String kennzeichen) {
        return root.queryForObject("INSERT INTO bezugsgroesse(tenant_id,kennzeichen,name,wertart,einheit,periode_art,geltung_art,unternehmen_id) "
                + "VALUES (?,?,?,'periodenwert','Stück','monat','unternehmen',?) RETURNING id",
                UUID.class, tenant, kennzeichen, kennzeichen, unternehmen);
    }

    private void benutzer(String sub, String name) {
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,?,'benutzer',?,'aktiv')", tenant, sub, name);
    }

    private static void sqlFehler(String state, Runnable aktion) {
        Throwable fehler = catchThrowable(aktion::run);
        assertThat(fehler).isInstanceOf(DataAccessException.class);
        Throwable ursache = ((DataAccessException) fehler).getMostSpecificCause();
        assertThat(ursache).isInstanceOf(SQLException.class);
        assertThat(((SQLException) ursache).getSQLState()).isEqualTo(state);
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl()); ds.setUser(user); ds.setPassword(password);
        return ds;
    }
}
