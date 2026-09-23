package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * AP-17 IP-15 (A2–A4): der Anstoß an der Bezugsbasis. Pfad 1 über die Naht der Kennzahl-Kaskade
 * ({@link BezugsbasisAnstoss#nachKorrektur}, R7), Pfad 2 über den Struktur-Läufer (R5, Archivierung, Variable). Die
 * Fassungen legt der Test direkt an (Muster {@code UemsBezugsbasisMigrationTest}) — die Freigabe-Route kommt mit IP-8;
 * die Grundlage im kanonischen Format der Referenzdatei 1.8 ({@code bezugsbasen[].fassungen[].grundlage}).
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsBezugsbasisAnstossTest {

    private static final String APP = "voltpilot_app", ADMIN = "voltpilot_admin", PW = "ip15_test_pw";
    private static final ZoneId ZONE = ZoneId.of("Europe/Berlin");
    private static final String BEGRUENDUNG = "Erste Energieleistungskennzahl: ein abgeschlossener Monat — vorläufig.";
    /** R7: BB-0002 Fassung 1 zitiert KZ-0001 Oktober 2026 in Version 1. */
    private static final String GRUNDLAGE_R7 = "[{\"periode\":\"2026-10\",\"zaehler\":{\"objekt\":\"MS-12\",\"wert\":6100,"
            + "\"version\":1},\"nenner\":{\"objekt\":\"BZ-6\",\"wert\":41000,\"fassung\":1},\"kennzahl\":{\"objekt\":"
            + "\"KZ-0001\",\"wert\":0.1488,\"version\":1,\"definition_fassung\":1},\"annahme\":false}]";
    /** R5: BB-0003 Fassung 1 — Nenner die Fläche von G-2 (Stichtag), der statische Faktor „Fläche G-2“. */
    private static final String GRUNDLAGE_R5 = "[{\"periode\":\"2026-10\",\"zaehler\":{\"objekt\":\"MS-10\",\"wert\":36900,"
            + "\"version\":1},\"nenner\":{\"objekt\":\"BZ-4\",\"ort\":\"G-2\",\"wert\":3100,\"stichtag\":\"2026-10-31\"},"
            + "\"kennzahl\":{\"objekt\":\"KZ-0005\",\"wert\":11.9032,\"version\":1,\"definition_fassung\":1},\"annahme\":false}]";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root, app, admin;

    private record Kunde(UUID tenant, UUID unternehmen) {}

    @BeforeAll
    static void migrieren() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        Flyway.configure().dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration").baselineOnMigrate(true).baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP, "appDbPassword", PW, "adminDbUser", ADMIN, "adminDbPassword", PW))
                .load().migrate();
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP, PW)));
        admin = new JdbcTemplate(ds(ADMIN, PW));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // ============================================================ Pfad 1 (A2, R7)

    @Test
    void r7EineKorrekturStoesstFassungEinsAnUndLaesstSieByteGleich() {
        Kunde k = kunde("R7");
        UUID kz1 = kennzahl(k, "KZ-0001");
        UUID kz4 = kennzahl(k, "KZ-0004");
        UUID bb2 = basis(k, kz1);
        UUID fassung1 = fassung(k, bb2, 1, freigegeben(GRUNDLAGE_R7));
        // Ein Entwurf, der denselben Wert zitiert, und eine Basis, die ihn nicht zitiert, bleiben ohne Anstoß.
        UUID entwurf = fassung(k, bb2, 2, entwurf(GRUNDLAGE_R7));
        UUID fremd = fassung(k, basis(k, kz4), 1, freigegeben(GRUNDLAGE_R7.replace("KZ-0001", "KZ-0004")
                .replace("MS-12", "MS-20").replace("BZ-6", "BZ-1")));
        String vorher = zeile(fassung1);

        List<BezugsbasisAnstoss.Gesetzt> erste = pfadEins(BezugsbasisAnstoss.mitSchalter(true),
                korrektur(k, "K-2026-0007", KorrekturKaskade.FREIGEGEBEN), List.of(neu(kz1, "KZ-0001", 2)));

        assertThat(erste).extracting(BezugsbasisAnstoss.Gesetzt::fassungId).containsExactly(fassung1);
        Map<String, Object> a = root.queryForMap("SELECT pfad, art, anlass_kennung, anlass, antwort FROM bezugsbasis_anstoss "
                + "WHERE fassung_id = ?", fassung1);
        assertThat(a).containsEntry("pfad", 1).containsEntry("art", "grundlage_korrigiert")
                .containsEntry("anlass_kennung", "K-2026-0007").containsEntry("antwort", null);
        assertThat((String) a.get("anlass")).isEqualTo("K-2026-0007 (freigegeben): KZ-0001 2026-10 Version 2");
        assertThat(root.queryForMap("SELECT fassung, art, neu->>'art' AS anstoss, actor_art, actor_sub FROM "
                + "bezugsbasis_aenderung WHERE bezugsbasis_id = ?", bb2)).containsEntry("fassung", 1)
                .containsEntry("art", "anstoss_gesetzt").containsEntry("anstoss", "grundlage_korrigiert")
                .containsEntry("actor_art", "voltpilot").containsEntry("actor_sub", null);
        // Byte-gleich: jede Spalte der Fassung, die Grundlage und ihre Prüfsumme.
        assertThat(zeile(fassung1)).isEqualTo(vorher);
        assertThat(root.queryForObject("SELECT pruefsumme = bericht_pruefsumme(?) AND grundlage = ? FROM bezugsbasis_fassung "
                + "WHERE id = ?", Boolean.class, GRUNDLAGE_R7, GRUNDLAGE_R7, fassung1)).isTrue();
        assertThat(anstoesse(entwurf)).isZero();
        assertThat(anstoesse(fremd)).isZero();

        // Dieselbe Korrektur noch einmal (nächster Takt, Nachzug): kein zweiter Anstoß, kein zweites Protokoll.
        assertThat(pfadEins(BezugsbasisAnstoss.mitSchalter(true), korrektur(k, "K-2026-0007", KorrekturKaskade.FREIGEGEBEN),
                List.of(neu(kz1, "KZ-0001", 2)))).isEmpty();
        assertThat(anstoesse(fassung1)).isOne();
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsbasis_aenderung WHERE bezugsbasis_id = ?", Integer.class,
                bb2)).isOne();
        // Ihre Rücknahme ist Version 3 — ein neuer Anlass.
        assertThat(pfadEins(BezugsbasisAnstoss.mitSchalter(true), korrektur(k, "K-2026-0007",
                KorrekturKaskade.ZURUECKGENOMMEN), List.of(neu(kz1, "KZ-0001", 3)))).hasSize(1);
        assertThat(root.queryForList("SELECT anlass_kennung FROM bezugsbasis_anstoss WHERE fassung_id = ? ORDER BY "
                + "created_at, anlass_kennung", String.class, fassung1))
                .containsExactly("K-2026-0007", "K-2026-0007/zurueckgenommen");
        assertThat(zeile(fassung1)).isEqualTo(vorher);
    }

    @Test
    void eineBerichtigungDesZitiertenNennersStoesstNurMitNeuererFassungAn() {
        Kunde k = kunde("Nenner");
        UUID kz1 = kennzahl(k, "KZ-0001");
        UUID bb = basis(k, kz1);
        UUID f1 = fassung(k, bb, 1, freigegeben(GRUNDLAGE_R7));
        UUID bz6 = UUID.randomUUID();
        // Die Fassung zitiert BZ-6 in Fassung 1: dieselbe Fassung stößt nicht an, Fassung 2 schon.
        KorrekturKaskade.Betroffen gleich = bezugsgroesse(k, "BK-2026-0003", bz6, 1);
        assertThat(pfadEins(BezugsbasisAnstoss.mitSchalter(true), gleich, List.of())).isEmpty();
        KorrekturKaskade.Betroffen berichtigt = bezugsgroesse(k, "BK-2026-0003", bz6, 2);
        assertThat(pfadEins(BezugsbasisAnstoss.mitSchalter(true), berichtigt, List.of())).hasSize(1);
        assertThat(root.queryForObject("SELECT anlass FROM bezugsbasis_anstoss WHERE fassung_id = ?", String.class, f1))
                .isEqualTo("BK-2026-0003/Fassung-2 (freigegeben): BZ-6 2026-10 Fassung 2");
        // Dasselbe im Format von BezugsbasisGrundlage (IP-7): Objekt mit perioden[], Eingänge als Liste.
        UUID kz4 = kennzahl(k, "KZ-0004");
        UUID ip7 = fassung(k, basis(k, kz4), 1, freigegeben("{\"perioden\":[{\"periode\":\"2026-10\",\"kennzahl\":"
                + "{\"objekt\":\"KZ-0004\",\"wert\":0.1488,\"version\":1},\"zaehler\":6100,\"nenner\":41000,"
                + "\"eingaenge\":[{\"position\":1,\"rolle\":\"zaehler\",\"objekt\":\"MS-12\",\"version\":1},"
                + "{\"position\":2,\"rolle\":\"nenner\",\"objekt\":\"BZ-6\",\"fassung\":1}]}]}"));
        assertThat(pfadEins(BezugsbasisAnstoss.mitSchalter(true), bezugsgroesse(k, "BK-2026-0004", bz6, 2), List.of()))
                .extracting(BezugsbasisAnstoss.Gesetzt::fassungId).containsExactlyInAnyOrder(f1, ip7);
    }

    @Test
    void schalterAusPfadEinsSchweigtUndHoltNichtsNach() {
        Kunde k = kunde("Schalter 1");
        UUID kz1 = kennzahl(k, "KZ-0001");
        UUID f1 = fassung(k, basis(k, kz1), 1, freigegeben(GRUNDLAGE_R7));
        assertThat(pfadEins(BezugsbasisAnstoss.mitSchalter(false), korrektur(k, "K-2026-0007", KorrekturKaskade.FREIGEGEBEN),
                List.of(neu(kz1, "KZ-0001", 2)))).isEmpty();
        assertThat(anstoesse(f1)).isZero();
    }

    @Test
    void derMandantenzaunHaeltBeidePfade() {
        Kunde a = kunde("Zaun A");
        Kunde b = kunde("Zaun B");
        UUID kzA = kennzahl(a, "KZ-0001");
        UUID kzB = kennzahl(b, "KZ-0001");
        UUID fA = fassung(a, basis(a, kzA), 1, freigegeben(GRUNDLAGE_R7));
        UUID fB = fassung(b, basis(b, kzB), 1, freigegeben(GRUNDLAGE_R7));
        // Gleiches Kennzeichen, gleicher Monat — nur der Kundenbereich der Korrektur wird angestoßen.
        pfadEins(BezugsbasisAnstoss.mitSchalter(true), korrektur(a, "K-2026-0007", KorrekturKaskade.FREIGEGEBEN),
                List.of(neu(kzA, "KZ-0001", 2)));
        assertThat(anstoesse(fA)).isOne();
        assertThat(anstoesse(fB)).isZero();
        // Pfad 2: die Archivierung in A trifft die Basis in B nicht, auch wenn deren Faktor dieselbe Kennung trüge.
        root.update("INSERT INTO kennzahl_aenderung (tenant_id, kennzahl_id, art, gilt_ab, rueckwirkend, actor_sub, actor_name, "
                + "actor_art, created_at) VALUES (?, ?, 'kennzahl_archiviert', ?, false, 'IK', 'Ines', 'kunde', ?)", a.tenant(), kzA,
                ts("2027-02-01T09:00:00Z"), ts("2027-02-01T09:00:00Z"));
        BezugsbasisAnstoss.mitSchalter(true).strukturLauf(admin, Instant.parse("2027-02-01T09:05:00Z"), 200);
        assertThat(root.queryForList("SELECT art FROM bezugsbasis_anstoss WHERE fassung_id = ? ORDER BY art", String.class,
                fA)).containsExactly("grundlage_korrigiert", "nicht_mehr_anwendbar");
        assertThat(anstoesse(fB)).isZero();
        // Die App-Rolle sieht unter A nur die Anstöße von A.
        TenantContext.set(b.tenant());
        assertThat(app.queryForObject("SELECT count(*) FROM bezugsbasis_anstoss", Integer.class)).isZero();
        TenantContext.set(a.tenant());
        assertThat(app.queryForObject("SELECT count(*) FROM bezugsbasis_anstoss", Integer.class)).isEqualTo(2);
    }

    // ============================================================ Pfad 2 (A3, R5)

    @Test
    void r5DieFlaecheDerHalleZweiStoesstBbDreiImStrukturLaeuferAnDerWortlautNicht() {
        Kunde k = kunde("R5");
        UUID kz5 = kennzahl(k, "KZ-0005");
        UUID kz6 = kennzahl(k, "KZ-0006");
        UUID g2 = ort(k, "G-2");
        UUID g3 = ort(k, "G-3");
        UUID bb3 = basis(k, kz5);
        UUID f1 = fassung(k, bb3, 1, freigegeben(GRUNDLAGE_R5));
        String vorher = zeile(f1);
        root.update("INSERT INTO bezugsbasis_faktor (tenant_id, fassung_id, position, art, verweis, wert, einheit, "
                + "wert_gueltig_ab, kopie_am) VALUES (?, ?, 1, 'flaeche', ?, 3100, 'm²', DATE '2026-10-01', DATE '2026-11-12')",
                k.tenant(), f1, g2);
        root.update("INSERT INTO bezugsbasis_faktor (tenant_id, fassung_id, position, art, wortlaut) VALUES (?, ?, 2, "
                + "'wortlaut', 'Zweischichtbetrieb, Halle 2')", k.tenant(), f1);
        // Eine zweite Basis trägt NUR einen Wortlaut-Faktor, der Halle 2 nennt: V3, kein Anstoß.
        UUID nurWortlaut = fassung(k, basis(k, kz6), 1, freigegeben(GRUNDLAGE_R5.replace("KZ-0005", "KZ-0006")));
        root.update("INSERT INTO bezugsbasis_faktor (tenant_id, fassung_id, position, art, wortlaut) VALUES (?, ?, 1, "
                + "'wortlaut', ?)", k.tenant(), nurWortlaut, "Fläche G-2 " + g2);

        long anbau = ortAenderung(k, g2, "flaeche_geaendert", "{\"flaeche_m2\": 3100}",
                "{\"flaeche_m2\": 3400, \"korrektur\": false}", LocalDate.parse("2027-01-01"), true, "2027-01-15T10:00:00Z");
        long umbenannt = ortAenderung(k, g2, "bearbeitet", "{\"name\": \"Halle 2\"}", "{\"name\": \"Halle 2 (Anbau)\"}",
                LocalDate.parse("2027-01-15"), false, "2027-01-15T10:01:00Z");
        long andereHalle = ortAenderung(k, g3, "flaeche_geaendert", "{\"flaeche_m2\": 900}", "{\"flaeche_m2\": 950}",
                LocalDate.parse("2027-01-01"), true, "2027-01-15T10:02:00Z");
        // Vor der Freigabe eingetragen: steckt schon in der Grundlage, kein Kandidat.
        long vorFreigabe = ortAenderung(k, g2, "flaeche_geaendert", "{\"flaeche_m2\": 3000}", "{\"flaeche_m2\": 3100}",
                LocalDate.parse("2026-10-01"), true, "2026-11-01T10:00:00Z");

        // Über den Einhängepunkt im bestehenden Struktur-Läufer (Berichte ohne Naht).
        StrukturAenderungLaeufer laeufer = new StrukturAenderungLaeufer(admin, new BerichteNaht.Keine(), 200);
        laeufer.bezugsbasis(BezugsbasisAnstoss.mitSchalter(true));
        assertThat(laeufer.lauf(Instant.parse("2027-01-15T10:05:00Z")).gescheitert()).isEmpty();

        Map<String, Object> a = root.queryForMap("SELECT pfad, art, anlass_kennung, anlass FROM bezugsbasis_anstoss "
                + "WHERE fassung_id = ?", f1);
        assertThat(a).containsEntry("pfad", 2).containsEntry("art", "struktur_geaendert")
                .containsEntry("anlass_kennung", "ort_aenderung:" + anbau);
        assertThat((String) a.get("anlass")).isEqualTo("ort_aenderung flaeche_geaendert G-2 3100 → 3400 m² ab 2027-01-01 "
                + "(rückwirkend), Struktur-Läufer Pfad 2");
        assertThat(anstoesse(nurWortlaut)).isZero();
        assertThat(zeile(f1)).isEqualTo(vorher);
        assertThat(gelesen("ort_aenderung", anbau)).isEqualTo("struktur_geaendert");
        assertThat(gelesen("ort_aenderung", andereHalle)).isEqualTo("ohne_bezugsbasis");
        assertThat(gelesen("ort_aenderung", umbenannt)).isNull();
        assertThat(gelesen("ort_aenderung", vorFreigabe)).isNull();
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsbasis_aenderung WHERE bezugsbasis_id = ? "
                + "AND art = 'anstoss_gesetzt' AND fassung = 1", Integer.class, bb3)).isOne();
        // Wasserzeichen: der nächste Takt liest nichts mehr.
        assertThat(BezugsbasisAnstoss.mitSchalter(true).strukturLauf(admin, Instant.parse("2027-01-15T10:10:00Z"), 200)
                .gelesen()).isZero();
        assertThat(anstoesse(f1)).isOne();
    }

    @Test
    void archivierungDerKennzahlOderDerVariablenIstNichtMehrAnwendbarEineNeueEinheitVariableGeaendert() {
        Kunde k = kunde("Archiv");
        UUID kz4 = kennzahl(k, "KZ-0004");
        UUID kz1 = kennzahl(k, "KZ-0001");
        UUID bz1 = bezugsgroesse(k, "BZ-1");
        UUID mitVariable = fassung(k, basis(k, kz4), 1, freigegeben(GRUNDLAGE_R7.replace("KZ-0001", "KZ-0004")));
        root.update("INSERT INTO bezugsbasis_variable (tenant_id, fassung_id, position, bezugsgroesse_id, "
                + "bezugsgroesse_fassung) VALUES (?, ?, 1, ?, 1)", k.tenant(), mitVariable, bz1);
        UUID archiviert = fassung(k, basis(k, kz1), 1, freigegeben(GRUNDLAGE_R7));

        long nurName = bezugsgroesseAenderung(k, bz1, "bearbeitet", "{\"name\": \"Menge\"}", "{\"name\": \"Produktionsmenge\"}",
                "2027-02-01T08:00:00Z");
        long einheit = bezugsgroesseAenderung(k, bz1, "bearbeitet", "{\"name\": \"Menge\", \"einheit\": \"kg\"}",
                "{\"name\": \"Menge\", \"einheit\": \"t\"}", "2027-02-01T08:01:00Z");
        long bzArchiv = bezugsgroesseAenderung(k, bz1, "archiviert", null, null, "2027-02-01T08:02:00Z");
        root.update("INSERT INTO kennzahl_aenderung (tenant_id, kennzahl_id, art, gilt_ab, rueckwirkend, actor_sub, actor_name, "
                + "actor_art, created_at) VALUES (?, ?, 'kennzahl_archiviert', ?, false, 'IK', 'Ines', 'kunde', ?)", k.tenant(), kz1,
                ts("2027-02-01T08:03:00Z"), ts("2027-02-01T08:03:00Z"));

        BezugsbasisAnstoss.StrukturLauf l = BezugsbasisAnstoss.mitSchalter(true).strukturLauf(admin,
                Instant.parse("2027-02-01T08:05:00Z"), 200);
        assertThat(l.gescheitert()).isEmpty();
        assertThat(root.queryForList("SELECT art || ' ' || anlass_kennung FROM bezugsbasis_anstoss WHERE fassung_id = ? "
                + "ORDER BY created_at, art", String.class, mitVariable)).containsExactlyInAnyOrder(
                "variable_geaendert bezugsgroesse_aenderung:" + einheit,
                "nicht_mehr_anwendbar bezugsgroesse_aenderung:" + bzArchiv);
        assertThat(gelesen("bezugsgroesse_aenderung", nurName)).isEqualTo("nicht_strukturell");
        assertThat(root.queryForList("SELECT art FROM bezugsbasis_anstoss WHERE fassung_id = ?", String.class, archiviert))
                .containsExactly("nicht_mehr_anwendbar");
    }

    @Test
    void schalterAusPfadZweiSetztNurDasWasserzeichenUndHoltNichtsNach() {
        Kunde k = kunde("Schalter 2");
        UUID kz5 = kennzahl(k, "KZ-0005");
        UUID g2 = ort(k, "G-2");
        UUID f1 = fassung(k, basis(k, kz5), 1, freigegeben(GRUNDLAGE_R5));
        root.update("INSERT INTO bezugsbasis_faktor (tenant_id, fassung_id, position, art, verweis, wert, einheit) "
                + "VALUES (?, ?, 1, 'flaeche', ?, 3100, 'm²')", k.tenant(), f1, g2);
        long anbau = ortAenderung(k, g2, "flaeche_geaendert", "{\"flaeche_m2\": 3100}", "{\"flaeche_m2\": 3400}",
                LocalDate.parse("2027-01-01"), true, "2027-01-15T10:00:00Z");
        BezugsbasisAnstoss.mitSchalter(false).strukturLauf(admin, Instant.parse("2027-01-15T10:05:00Z"), 200);
        assertThat(gelesen("ort_aenderung", anbau)).isEqualTo("abgeschaltet");
        assertThat(anstoesse(f1)).isZero();
        // Wieder an: nichts wird nachgeholt.
        BezugsbasisAnstoss.mitSchalter(true).strukturLauf(admin, Instant.parse("2027-01-15T10:10:00Z"), 200);
        assertThat(anstoesse(f1)).isZero();
    }

    // ============================================================ Helfer

    private static List<BezugsbasisAnstoss.Gesetzt> pfadEins(BezugsbasisAnstoss naht, KorrekturKaskade.Betroffen b,
            List<KennzahlLauf.Neu> neu) {
        return admin.execute((ConnectionCallback<List<BezugsbasisAnstoss.Gesetzt>>) con -> {
            con.setAutoCommit(false);
            try {
                List<BezugsbasisAnstoss.Gesetzt> g = naht.nachKorrektur(con, b, neu);
                con.commit();
                return g;
            } catch (SQLException | RuntimeException e) {
                con.rollback();
                throw e;
            } finally {
                con.setAutoCommit(true);
            }
        });
    }

    private static KorrekturKaskade.Betroffen korrektur(Kunde k, String kennung, String status) {
        return new KorrekturKaskade.Betroffen(k.tenant(), kennung, 1, status, List.of(),
                Instant.parse("2026-10-14T22:00:00Z"), Instant.parse("2026-10-15T22:00:00Z"), ZONE,
                LocalDate.parse("2026-10-15"), LocalDate.parse("2026-10-15"), List.of(), List.of(), 1,
                Instant.parse("2026-11-12T09:05:33Z"), List.of());
    }

    private static KorrekturKaskade.Betroffen bezugsgroesse(Kunde k, String kennung, UUID id, int fassung) {
        return new KorrekturKaskade.Betroffen(k.tenant(), kennung, fassung, KorrekturKaskade.FREIGEGEBEN, List.of(), null,
                null, ZONE, LocalDate.parse("2026-10-01"), LocalDate.parse("2026-10-31"), List.of(), List.of(), 0,
                Instant.parse("2026-11-20T09:00:00Z"), List.of(new KorrekturKaskade.Bezugsgroesse(id, "BZ-6",
                        LocalDate.parse("2026-10-01"), LocalDate.parse("2026-10-31"), fassung, KorrekturKaskade.FREIGEGEBEN)));
    }

    private static KennzahlLauf.Neu neu(UUID kennzahl, String kennzeichen, int version) {
        return new KennzahlLauf.Neu(kennzahl, kennzeichen, "monat", LocalDate.parse("2026-10-01"),
                LocalDate.parse("2026-10-31"), ZONE, version);
    }

    private static Kunde kunde(String name) {
        UUID tenant = root.queryForObject("INSERT INTO tenant(name) VALUES (?) RETURNING id", UUID.class, name);
        UUID unternehmen = root.queryForObject("INSERT INTO unternehmen(tenant_id,name) VALUES (?,?) RETURNING id",
                UUID.class, tenant, name);
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,'IK','benutzer',"
                + "'Ines Kaltenbach','aktiv')", tenant);
        return new Kunde(tenant, unternehmen);
    }

    private static UUID kennzahl(Kunde k, String kennzeichen) {
        return root.queryForObject("INSERT INTO kennzahl(tenant_id,kennzeichen,name,rechenform,geltung_art,unternehmen_id,"
                + "verantwortlich_sub,verantwortlich_name) VALUES (?,?,?,'quotient','unternehmen',?,'IK','Ines Kaltenbach') "
                + "RETURNING id", UUID.class, k.tenant(), kennzeichen, kennzeichen, k.unternehmen());
    }

    private static UUID bezugsgroesse(Kunde k, String kennzeichen) {
        return root.queryForObject("INSERT INTO bezugsgroesse(tenant_id,kennzeichen,name,wertart,einheit,periode_art,"
                + "geltung_art,unternehmen_id) VALUES (?,?,'Produktionsmenge','periodenwert','kg','monat','unternehmen',?) "
                + "RETURNING id", UUID.class, k.tenant(), kennzeichen, k.unternehmen());
    }

    private static UUID ort(Kunde k, String kurzzeichen) {
        return root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) VALUES (?, 'gebaeude', ?, ?, "
                + "'aktiv') RETURNING id", UUID.class, k.tenant(), "Halle " + kurzzeichen, kurzzeichen);
    }

    private static UUID basis(Kunde k, UUID kennzahl) {
        return root.queryForObject("INSERT INTO bezugsbasis(tenant_id,kennzahl_id,verantwortlich_sub,verantwortlich_name,"
                + "verantwortlich_konto,actor_sub,actor_name,actor_rolle,actor_art) VALUES (?,?,'IK','Ines Kaltenbach',"
                + "'benutzer','IK','Ines Kaltenbach','energiemanager','kunde') RETURNING id", UUID.class, k.tenant(), kennzahl);
    }

    /** Eine Fassung: Referenzperiode Oktober 2026, Verhältnis, vorläufig, und die genannten Spalten. */
    private static UUID fassung(Kunde k, UUID basis, int nummer, Map<String, Object> spalten) {
        Map<String, Object> werte = new LinkedHashMap<>();
        werte.put("tenant_id", k.tenant());
        werte.put("bezugsbasis_id", basis);
        werte.put("fassung", nummer);
        werte.put("referenzperiode", "2026-10/2026-10");
        werte.put("methode", "verhaeltnis");
        werte.put("datenlage", "vorlaeufig");
        werte.put("gilt_ab", java.sql.Date.valueOf("2026-11-01"));
        werte.put("actor_sub", "IK");
        werte.put("actor_name", "Ines Kaltenbach");
        werte.put("actor_rolle", "energiemanager");
        werte.put("actor_art", "kunde");
        if (nummer > 1) {
            werte.put("anpassungsgruende", "{grundlage_korrigiert}");
        }
        werte.putAll(spalten);
        String grundlage = (String) werte.get("grundlage");
        werte.put("pruefsumme", root.queryForObject("SELECT bericht_pruefsumme(?)", String.class, grundlage));
        String sql = "INSERT INTO bezugsbasis_fassung(" + String.join(",", werte.keySet()) + ") VALUES ("
                + String.join(",", werte.keySet().stream().map(s -> s.equals("anpassungsgruende") ? "?::text[]" : "?")
                        .toList()) + ") RETURNING id";
        return root.queryForObject(sql, UUID.class, werte.values().toArray());
    }

    private static Map<String, Object> freigegeben(String grundlage) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("grundlage", grundlage);
        m.put("basiswert", 0.1488);
        m.put("freigabe_status", "freigegeben");
        m.put("freigabe_sub", "IK");
        m.put("freigabe_name", "Ines Kaltenbach");
        m.put("freigabe_rolle", "energiemanager");
        m.put("freigabe_art", "kunde");
        m.put("freigabe_am", Timestamp.valueOf("2026-11-12 10:00:00"));
        m.put("freigegeben_am", Timestamp.valueOf("2026-11-12 10:00:00"));
        m.put("begruendung", BEGRUENDUNG);
        return m;
    }

    private static Map<String, Object> entwurf(String grundlage) {
        return new LinkedHashMap<>(Map.of("grundlage", grundlage, "freigabe_status", "entwurf"));
    }

    private static long ortAenderung(Kunde k, UUID ort, String art, String alt, String neu, LocalDate giltAb,
            boolean rueckwirkend, String eingetragen) {
        return root.queryForObject("INSERT INTO ort_aenderung (tenant_id, objekt_art, objekt_id, art, alt, neu, gilt_ab, "
                + "rueckwirkend, actor_sub, actor_name, actor_art, created_at) VALUES (?, 'gebaeude', ?, ?, ?::jsonb, "
                + "?::jsonb, ?, ?, 'JW', 'Jonas Wendlinger', 'kunde', ?) RETURNING id", Long.class, k.tenant(), ort, art, alt,
                neu, java.sql.Date.valueOf(giltAb), rueckwirkend, ts(eingetragen));
    }

    private static long bezugsgroesseAenderung(Kunde k, UUID bezug, String art, String alt, String neu, String eingetragen) {
        return root.queryForObject("INSERT INTO bezugsgroesse_aenderung (tenant_id, bezugsgroesse_id, art, alt, neu, gilt_ab, "
                + "rueckwirkend, actor_sub, actor_name, actor_art, created_at) VALUES (?, ?, ?, ?::jsonb, ?::jsonb, ?, false, "
                + "'IK', 'Ines Kaltenbach', 'kunde', ?) RETURNING id", Long.class, k.tenant(), bezug, art, alt, neu,
                ts(eingetragen), ts(eingetragen));
    }

    private static String zeile(UUID fassung) {
        return root.queryForObject("SELECT to_jsonb(f)::text FROM bezugsbasis_fassung f WHERE id = ?", String.class, fassung);
    }

    private static int anstoesse(UUID fassung) {
        return root.queryForObject("SELECT count(*) FROM bezugsbasis_anstoss WHERE fassung_id = ?", Integer.class, fassung);
    }

    private static String gelesen(String protokoll, long id) {
        return root.queryForList("SELECT urteil FROM bezugsbasis_struktur_gelesen WHERE protokoll = ? AND eintrag_id = ?",
                String.class, protokoll, id).stream().findFirst().orElse(null);
    }

    private static Timestamp ts(String instant) {
        return Timestamp.from(Instant.parse(instant));
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
