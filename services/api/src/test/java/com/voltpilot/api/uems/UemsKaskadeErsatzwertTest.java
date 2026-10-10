package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.EreignisVokabular.Urheber;
import com.voltpilot.api.uems.MessreiheErsatzwertRepository.Anlage;
import com.voltpilot.api.uems.VerbrauchRegeln.Rohwert;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * F21 an der Kaskade (AP-08 IP-17, Testcontainers): ein Ersatzwert zieht wie eine Korrektur bis zum Jahr durch, und sein
 * Widerruf lässt jede Stufe wieder zu ihren Teilen passen. Die Zahlen der Tage kommen aus {@code verbrauch-vectors.json}
 * (Block {@code ersatzwerte}, F11/F21) — gerechnet von der Regel, nicht hier.
 *
 * <p>Die Zeitachse (MS-10 Halle 2, Box-Tausch 03.11. 14:00 → 04.11. 09:30): Version 1 aller Stufen → Lücke mit Zuwachs
 * 1 872,0 kWh → EW-a gleichmäßig verteilt (F11) → Kaskade → EW-a zurückgenommen → Kaskade → EW-c nach dem Profil des
 * Netzbetreiber-Lastgangs (F21) → Kaskade → ein eingegebener Wert (e) an einer zweiten Reihe, für den der Vertrag über
 * einer gröberen Periode keine Regel hat.
 */
@Testcontainers(disabledWithoutDocker = true)
class UemsKaskadeErsatzwertTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String KANAL = "deye.hybrid_1p.meter.generator-energy";

    private static final UUID KB = UUID.fromString("4e0e0000-0000-0000-0000-000000000023");

    private static final Instant F11_LUECKE_VON = Instant.parse("2026-11-03T13:01:00Z");
    private static final Instant F11_LUECKE_BIS = Instant.parse("2026-11-04T08:30:00Z");
    private static final Instant F11_EW_VON = Instant.parse("2026-11-03T13:00:00Z");
    private static final BigDecimal F11_ZUWACHS = new BigDecimal("1872.0");
    private static final Instant Z2_LUECKE_BIS = Instant.parse("2026-11-10T10:00:00Z");
    private static final Instant JETZT = Instant.parse("2026-11-12T00:00:00Z");
    private static final LocalDate DRITTER = LocalDate.of(2026, 11, 3);
    private static final LocalDate VIERTER = LocalDate.of(2026, 11, 4);
    private static final LocalDate NOVEMBER = LocalDate.of(2026, 11, 1);
    private static final ProtokollAkteur INES = new ProtokollAkteur("kc-ines-kaltenbach", "Ines Kaltenbach",
            "energiemanager", "kunde");
    private static final String BEGRUENDUNG = "Box-Tausch nach Defekt; Energiekarte hat weitergezählt";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static final Map<String, UUID> IDS = new LinkedHashMap<>();

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static MessreiheErsatzwertRepository ersatzwerte;

    private static String ewA;
    private static String ewC;
    private static String ewE;
    private static Map<String, Object> dritterV1;
    private static Map<String, Object> monatV1;
    private static Map<String, Map<String, Object>> nachA = new LinkedHashMap<>();
    private static Map<String, Map<String, Object>> nachWiderruf = new LinkedHashMap<>();
    private static Map<String, Map<String, Object>> nachC = new LinkedHashMap<>();
    private static KorrekturKaskade.Lauf laufA;
    private static KorrekturKaskade.Lauf laufE;
    private static List<String> viertelstundeA;
    private static Map<String,Object> monatE, jahrE, monatRuecknahme, jahrRuecknahme;
    private static List<Map<String,Object>> dStufen;
    private static long qVorMonat, qNachMonat;
    private static String ewD, ewMonat, ewF, ewG;
    private static Map<String,Object> mitProfilen;

    @BeforeAll
    static void bauenUndFahren() throws Exception {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        flyway().load().migrate();
        stammdaten();
        rohwerte();
        JdbcTemplate admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        MeasurementCatalog katalog = new MeasurementCatalog(JSON);
        SpaetankunftMelder melder = new SpaetankunftMelder();
        ViertelstundeVerdichter verdichter = new ViertelstundeVerdichter(admin, katalog, melder, 500, 40, 200_000);
        TagVerdichter tage = new TagVerdichter(admin, katalog, 200, 40, 20_000, 200_000);
        // Diese Welt hat keine berechnete Messstelle: der Hook antwortet leer.
        BerechnetePeriodenLauf berechnete = mock(BerechnetePeriodenLauf.class);
        when(berechnete.zoneDesKundenbereichs(any())).thenReturn(BERLIN);
        EndgueltigkeitLaeufer laeufer = new EndgueltigkeitLaeufer(new EndgueltigkeitLauf(admin, 2000, 200), tage,
                new PeriodeVerdichter(admin, katalog, 50, 40, 2000), berechnete,
                new KorrekturVorschlagLauf(admin, verdichter, melder, 200));
        ersatzwerte = new MessreiheErsatzwertRepository(app);
        ErsatzwertLauf lauf = new ErsatzwertLauf(admin, katalog, verdichter, 200);
        KorrekturKaskade kaskade = new KorrekturKaskade(admin, katalog, verdichter, lauf, berechnete,
                new KennzahlenNaht.Keine(), new BerichteNaht.Keine(), 50);

        // ---- Version 1 aller Stufen ---------------------------------------------------------------------------
        for (int i = 0; i < 200; i++) {
            ViertelstundeVerdichter.Lauf l = verdichter.lauf(JETZT);
            if (l.rueckrechnungFertig()
                    && root.queryForObject("SELECT count(*) FROM messreihe_viertelstunde_arbeit", Integer.class) == 0) {
                break;
            }
        }
        tage.rueckrechnenGanz(JETZT, 200);
        laeufer.takt(JETZT);
        dritterV1 = tag("ZW", DRITTER);
        monatV1 = monat("ZW", NOVEMBER);

        luecke("ZW", F11_LUECKE_VON, F11_LUECKE_BIS, "418200.0", "420072.0", F11_ZUWACHS);
        luecke("Z2", Instant.parse("2026-11-10T09:01:00Z"), Z2_LUECKE_BIS, "1060", "1120", new BigDecimal("60"));

        // ---- F11: EW-a gleichmäßig verteilt --------------------------------------------------------------------
        ewA = erfassen(verteilen("gleichmaessig_verteilen"));
        lauf.lauf(JETZT);
        laufA = kaskade.lauf(JETZT);
        stufen(nachA);
        viertelstundeA = saetze(root.queryForObject("SELECT kennzeichen::text FROM messreihe_viertelstunde_version "
                + "WHERE entity_id = ? AND intervall_beginn = ? AND version = 2", String.class, IDS.get("ZW"),
                Timestamp.from(Instant.parse("2026-11-03T19:00:00Z"))));

        // ---- F21: der Widerruf allein ---------------------------------------------------------------------------
        zuruecknehmen(ewA, "Profil aus Netzbetreiber-Lastgang verfügbar");
        lauf.lauf(JETZT);
        kaskade.lauf(JETZT);
        stufen(nachWiderruf);

        // ---- F21: EW-c nach dem Profil der Vergleichsquelle ---------------------------------------------------
        Anlage c = verteilen("profil_vergleichsquelle");
        ewC = erfassen(new Anlage(c.methode(), c.entityId(), c.messkanal(), c.messstelleId(), c.von(), c.bis(),
                c.zeitpunkt(), c.begruendung(), c.beleg(), c.lueckeEreignisId(), c.zuwachs(), c.standVor(), c.standNach(),
                c.einheit(), c.vorperiodeVon(), IDS.get("Q-VQ"), c.endstand(), c.anfangsstand(), c.betrag()));
        lauf.lauf(JETZT);
        kaskade.lauf(JETZT);
        stufen(nachC);

        // ---- e über einer gröberen Periode: keine Regel im Vertrag ---------------------------------------------
        ewE = erfassen(new Anlage("wert_eingeben", IDS.get("Z2"), KANAL, null, Instant.parse("2026-11-10T11:30:00Z"),
                Instant.parse("2026-11-10T11:45:00Z"), null, "Netzrechnung November 2026 nennt die Menge",
                "Netzrechnung 2026-11, Lastgang-Anlage", null, null, null, null, "kWh", null, null, null, null,
                new BigDecimal("20.0")));
        lauf.lauf(JETZT);
        laufE = kaskade.lauf(JETZT);

        // Ein Monatsbetrag ohne Profil: keine Viertelstunde ändert sich, der ganze Monat und das Jahr schon.
        qVorMonat = zahl("SELECT count(*) FROM messreihe_viertelstunde_version WHERE entity_id = ?",IDS.get("Z2"));
        ewMonat = erfassen(new Anlage("wert_eingeben",IDS.get("Z2"),KANAL,null,
                Instant.parse("2026-09-30T22:00:00Z"),Instant.parse("2026-10-31T23:00:00Z"),null,
                "Netzrechnung Oktober ohne Lastgang übernommen", "Netzrechnung Oktober",null,null,null,null,
                "kWh",null,null,null,null,new BigDecimal("2304")));
        lauf.lauf(JETZT);
        assertThat(kaskade.lauf(JETZT).abgelehnt()).isEmpty();
        qNachMonat = zahl("SELECT count(*) FROM messreihe_viertelstunde_version WHERE entity_id = ?",IDS.get("Z2"));
        monatE = neueste("Z2","monat",LocalDate.of(2026,10,1));
        jahrE = neueste("Z2","jahr",LocalDate.of(2026,1,1));
        zuruecknehmen(ewMonat,"Beleg durch freigegebene Abrechnung ersetzt");
        lauf.lauf(JETZT);
        assertThat(kaskade.lauf(JETZT).abgelehnt()).isEmpty();
        monatRuecknahme = neueste("Z2","monat",LocalDate.of(2026,10,1));
        jahrRuecknahme = neueste("Z2","jahr",LocalDate.of(2026,1,1));

        ewD = erfassen(new Anlage("ablesestand_nachtragen",IDS.get("D"),KANAL,null,
                Instant.parse("2026-11-10T08:00:00Z"),Instant.parse("2026-11-10T08:15:00Z"),
                Instant.parse("2026-11-10T08:12:00Z"),"Ableseprotokoll von Elektro Brunner nachgetragen",null,
                null,null,null,null,"kWh",null,null,new BigDecimal("6184.90"),BigDecimal.ZERO,null));
        lauf.lauf(JETZT);
        assertThat(kaskade.lauf(JETZT).abgelehnt()).isEmpty();
        dStufen = List.of(neueste("D","tag",LocalDate.of(2026,11,10)),neueste("D","monat",NOVEMBER),
                neueste("D","jahr",LocalDate.of(2026,1,1)));

        ewF = erfassen(new Anlage("vorperiode_uebernehmen",IDS.get("Z2"),KANAL,null,
                Instant.parse("2026-11-10T10:15:00Z"),Instant.parse("2026-11-10T10:30:00Z"),null,
                "Vorperiode aus vollständiger Viertelstunde übernommen",null,null,null,null,null,null,
                Instant.parse("2026-11-10T08:00:00Z"),null,null,null,null));
        ewG = erfassen(new Anlage("vergleichsquelle_uebernehmen",IDS.get("Z2"),KANAL,null,
                Instant.parse("2026-11-10T11:00:00Z"),Instant.parse("2026-11-10T11:15:00Z"),null,
                "Bestätigte Vergleichsquelle mit vollständigen Werten übernommen",null,null,null,null,null,null,
                null,IDS.get("Q-Z2"),null,null,null));
        lauf.lauf(JETZT);
        assertThat(kaskade.lauf(JETZT).abgelehnt()).isEmpty();
        mitProfilen = neueste("Z2","jahr",LocalDate.of(2026,1,1));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    /** F11 — Version 2 an Tag, Monat und Jahr, die Tage mit Menge, Zustand, Abdeckung und Kennzeichen des Vertrags. */
    @Test
    void f11DerErsatzwertZiehtAlsVersionZweiBisZumJahrDurch() throws Exception {
        assertThat(laufA.abgelehnt()).isEmpty();
        pruefeTag(nachA.get("tag3"), erwartung("F11 · EW-2026-0003", "Tag 03.11.2026 (Version 2)"), "EW-2026-0003", ewA, 2);
        pruefeTag(nachA.get("tag4"), erwartung("F11 · EW-2026-0003", "Tag 04.11.2026 (Version 2)"), "EW-2026-0003", ewA, 2);
        Map<String, Object> monat = nachA.get("monat");
        assertThat(n(monat.get("version"))).isEqualTo(2);
        assertThat(monat.get("menge_zustand")).isEqualTo("mit Ersatzwert");
        assertThat((BigDecimal) monat.get("menge")).as("der Monat enthält die Lücke ganz: seine Menge trug den Zuwachs schon")
                .isEqualByComparingTo((BigDecimal) monatV1.get("menge"));
        assertThat(saetze(monat.get("kennzeichen"))).noneMatch(k -> k.startsWith("Lücke "))
                .contains(ErgebnisZustand.ersatzwert("gleichmaessig_verteilen", ewA)).last()
                .isEqualTo("korrigiert (Version 2)");
        assertThat(n(nachA.get("jahr").get("version"))).isEqualTo(2);
        assertThat(nachA.get("jahr").get("menge_zustand")).isEqualTo("mit Ersatzwert");
        assertThat(array(nachA.get("tag3").get("ersatzwerte"))).containsExactly(ewA);
        assertThat(zahl("SELECT count(*) FROM messreihe_kaskade_wirkung WHERE anlass_kennung = ? AND ergebnis = 'gebildet'",
                ewA)).isEqualTo(1);
    }

    /** Die Viertelstunde des Ersatzwert-Laufs sagt seit IP-17 ebenfalls, dass sie eine Version ist. */
    @Test
    void dieViertelstundeDesErsatzwertLaufsTraegtDasKennzeichen() {
        assertThat(viertelstundeA).containsExactly(ErgebnisZustand.ersatzwert("gleichmaessig_verteilen", ewA),
                "korrigiert (Version 2)");
    }

    /**
     * F21 — der Widerruf allein: Version 3 an jeder Stufe mit den Zahlen von Version 1 (Vertrag „nur Widerruf“); kein
     * Ersatzwert wirkt mehr, keine Stufe nennt EW-a.
     */
    @Test
    void f21NachDemWiderrufPasstJedeStufeWiederZuIhrenTeilen() throws Exception {
        Map<String, Object> tag3 = nachWiderruf.get("tag3");
        pruefeTag(tag3, erwartung("F21 · Widerruf von EW-2026-0003", "Tag 03.11.2026 (Version 3, nur Widerruf)"),
                "EW-2026-0003", ewA, 3);
        assertThat((BigDecimal) tag3.get("menge")).isEqualByComparingTo((BigDecimal) dritterV1.get("menge"));
        assertThat(saetze(tag3.get("kennzeichen")).subList(0, saetze(tag3.get("kennzeichen")).size() - 1))
                .isEqualTo(saetze(dritterV1.get("kennzeichen")));
        for (String stufe : List.of("tag3", "tag4", "monat", "jahr")) {
            assertThat(n(nachWiderruf.get(stufe).get("version"))).as(stufe).isEqualTo(3);
            assertThat(array(nachWiderruf.get(stufe).get("ersatzwerte"))).as(stufe).isEmpty();
        }
        assertThat((BigDecimal) nachWiderruf.get("monat").get("menge"))
                .isEqualByComparingTo((BigDecimal) monatV1.get("menge"));
        assertThat(nachWiderruf.get("monat").get("menge_zustand")).isEqualTo(monatV1.get("menge_zustand"));
    }

    /** F21 — die bessere Methode: Tage 2 354,4 und 2 253,6 kWh „mit Ersatzwert“ (Vertrag), als nächste Version. */
    @Test
    void f21DieBessereMethodeIstDieNaechsteVersionMitDenZahlenDesVertrags() throws Exception {
        pruefeTag(nachC.get("tag3"), erwartung("F21 · Widerruf und EW-2026-0005", "Tag 03.11.2026 (Version 3)"),
                "EW-2026-0005", ewC, 4);
        pruefeTag(nachC.get("tag4"), erwartung("F21 · Widerruf und EW-2026-0005", "Tag 04.11.2026 (Version 3)"),
                "EW-2026-0005", ewC, 4);
        assertThat(array(nachC.get("monat").get("ersatzwerte"))).containsExactly(ewC);
        assertThat(n(nachC.get("jahr").get("version"))).isEqualTo(4);
    }

    /** E7/E9: die eingegebene Viertelstunde ersetzt ihren Beitrag, sie wird nicht doppelt addiert. */
    @Test
    void einEingegebenerWertZiehtBisZumJahrDurch() {
        assertThat(laufE.abgelehnt()).isEmpty();
        assertThat(root.queryForObject("SELECT ergebnis FROM messreihe_kaskade_wirkung WHERE anlass_kennung = ?",
                String.class, ewE)).isEqualTo(KorrekturKaskade.GEBILDET);
        for (String ebene : List.of("tag", "monat", "jahr")) {
            BigDecimal menge = root.queryForObject("SELECT menge FROM messreihe_periode_version WHERE entity_id = ? "
                    + "AND ebene = ? AND version = 2 AND tag = ?", BigDecimal.class, IDS.get("Z2"), ebene,
                    switch(ebene) { case "tag" -> LocalDate.of(2026,11,10); case "monat" -> NOVEMBER;
                        default -> LocalDate.of(2026,1,1); });
            assertThat(menge).as(ebene + ": 240 gemessen − 15 ersetzt + 20 eingegeben").isEqualByComparingTo("245");
        }
    }

    @Test
    void monatsbetragBleibtUnverteiltUndIstAlsNeueVersionWiderrufbar() {
        assertThat(qNachMonat).isEqualTo(qVorMonat);
        assertThat((BigDecimal)monatE.get("menge")).isEqualByComparingTo("2304");
        assertThat((BigDecimal)jahrE.get("menge")).isEqualByComparingTo("2549");
        assertThat(monatRuecknahme.get("menge")).isNull();
        assertThat((BigDecimal)jahrRuecknahme.get("menge")).isEqualByComparingTo("245");
        assertThat(n(monatRuecknahme.get("version"))).isEqualTo(3);
        assertThat(array(monatRuecknahme.get("ersatzwerte"))).doesNotContain(ewMonat);
    }

    @Test
    void f12AblesestandErhoehtJedeGroebereStufeUm053() {
        for (Map<String,Object> v : dStufen) {
            assertThat((BigDecimal)v.get("menge")).isEqualByComparingTo("14.81");
            assertThat(array(v.get("ersatzwerte"))).containsExactly(ewD);
            assertThat(saetze(v.get("kennzeichen"))).noneMatch(k -> k.startsWith("Rücksetzung "))
                    .contains("Gerätegrenze 09:12 mit Ableseständen");
        }
    }

    @Test
    void beideProfilMethodenErsetzenDenBeitragOhneIhnDoppeltZuZaehlen() {
        assertThat((BigDecimal)mitProfilen.get("menge")).isEqualByComparingTo("245");
        assertThat(array(mitProfilen.get("ersatzwerte"))).contains(ewE,ewF,ewG);
    }

    private static Map<String,Object> neueste(String reihe,String ebene,LocalDate tag) {
        return root.queryForMap("SELECT * FROM messreihe_periode_version WHERE entity_id = ? AND ebene = ? AND tag = ? "
                + "ORDER BY version DESC LIMIT 1",IDS.get(reihe),ebene,tag);
    }

    // =========================================================================== Hilfen

    private static void pruefeTag(Map<String, Object> ist, JsonNode soll, String vertragsKennung, String kennung,
            int version) {
        assertThat(n(ist.get("version"))).isEqualTo(version);
        assertThat((BigDecimal) ist.get("menge")).isEqualByComparingTo(soll.path("menge").decimalValue());
        assertThat(ist.get("menge_zustand")).isEqualTo(soll.path("zustand").asText());
        assertThat(n(ist.get("erhalten"))).isEqualTo(soll.path("erhalten").asInt());
        assertThat(n(ist.get("erwartet"))).isEqualTo(soll.path("erwartet").asInt());
        assertThat(n(ist.get("abdeckung_prozent"))).isEqualTo(soll.path("abdeckung_prozent").asInt());
        List<String> kz = new ArrayList<>();
        soll.path("kennzeichen").forEach(k -> kz.add(k.asText().replace(vertragsKennung, kennung)));
        kz.add(ErgebnisZustand.korrigiert(version));
        assertThat(saetze(ist.get("kennzeichen"))).containsExactlyElementsOf(kz);
    }

    private static void stufen(Map<String, Map<String, Object>> aus) {
        aus.put("tag3", neueste("tag", DRITTER));
        aus.put("tag4", neueste("tag", VIERTER));
        aus.put("monat", neueste("monat", NOVEMBER));
        aus.put("jahr", neueste("jahr", LocalDate.of(2026, 1, 1)));
    }

    private static Map<String, Object> neueste(String ebene, LocalDate tag) {
        return root.queryForMap("SELECT * FROM messreihe_periode_version WHERE entity_id = ? AND ebene = ? AND tag = ? "
                + "ORDER BY version DESC LIMIT 1", IDS.get("ZW"), ebene, tag);
    }

    private static Map<String, Object> tag(String reihe, LocalDate tag) {
        return root.queryForMap("SELECT * FROM messreihe_tag WHERE entity_id = ? AND tag = ?", IDS.get(reihe), tag);
    }

    private static Map<String, Object> monat(String reihe, LocalDate tag) {
        return root.queryForMap("SELECT * FROM messreihe_periode WHERE entity_id = ? AND art = 'monat' AND tag = ?",
                IDS.get(reihe), tag);
    }

    private static JsonNode erwartung(String eintrag, String name) throws Exception {
        for (JsonNode e : VerbrauchVectorsTest.lies(VerbrauchVectorsTest.VECTORS).path("ersatzwerte")) {
            if (!e.path("name").asText().startsWith(eintrag)) {
                continue;
            }
            for (JsonNode x : e.path("expected")) {
                if (name.equals(x.path("name").asText())) {
                    return x;
                }
            }
        }
        throw new AssertionError("keine Erwartung " + name + " in " + eintrag);
    }

    private static void stammdaten() {
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH')", KB);
        UUID u = uuid("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, 'Ahrenberg', 'Europe/Berlin') "
                + "RETURNING id", KB);
        UUID st = uuid("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", KB, u);
        UUID an = uuid("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-2') RETURNING id", KB);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, DATE '2024-01-01')", KB, an, st);
        IDS.put("AN", an);
        reihe("ZW", 60);
        reihe("VQ", 900);
        reihe("Z2", 60);
        reihe("D", 60);
        UUID ms = uuid("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, einheit, "
                + "wertart) VALUES (?, 'MS-10', 'Halle 2', 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', "
                + "'Zählerstand') RETURNING id", KB);
        bindung(ms, "ZW", "fuehrend", null);
        IDS.put("Q-VQ", bindung(ms, "VQ", "vergleich", "Abrechnungszähler"));
        IDS.put("Q-Z2", bindung(ms, "Z2", "vergleich", "Abrechnungszähler"));
    }

    private static void reihe(String name, int kadenz) {
        UUID box = uuid("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, 'claimed') "
                + "RETURNING id", KB, IDS.get("AN"), "VP-BOX-KE-" + name);
        UUID entity = uuid("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, device_id, "
                + "communication, connection_json, created_at) VALUES (?, ?, 'grid-meter', ?, 'grid-meter', ?, "
                + "'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, '2024-03-12T00:00:00Z') RETURNING id",
                KB, IDS.get("AN"), name, box);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, ?, 1, "
                + "'2024-03-12T00:00:00Z', '2026.09.11.1', 'test', 'pending_edge', 'live_power', 'fifteen_minute')",
                KB, IDS.get("AN"), box, entity, KANAL, kadenz);
        IDS.put(name, entity);
        IDS.put("BOX:" + name, box);
    }

    private static UUID bindung(UUID messstelle, String reihe, String rolle, String zweck) {
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", UUID.class, IDS.get(reihe));
        return root.queryForObject("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, "
                + "entity_id, geraet_id, kanal, kanal_wertart, herleitung, rolle, zweck, gueltig_ab, rueckwirkend, "
                + "eingetragen_am, actor_sub, actor_name, actor_art) VALUES (?, ?, 'Wirkenergie', 'Bezug', ?, ?, ?, "
                + "'counter', 'zaehlerstand', ?, ?, '2024-03-12T00:00:00Z', true, now(), 'sub', 'Probe', 'kunde') "
                + "RETURNING id", UUID.class, KB, messstelle, IDS.get(reihe), geraet, KANAL, rolle, zweck);
    }

    private static void rohwerte() throws Exception {
        for (JsonNode fall : VerbrauchVectorsTest.lies(VerbrauchVectorsTest.VECTORS).path("cases")) {
            if (fall.path("name").asText().startsWith("f6-")) {
                // Die F12-Rechnung bleibt exakt; nur das Datum liegt in der Uhr dieses Testlaufs.
                var ursprung = Instant.parse("2027-01-15T08:00:00Z");
                var ziel = Instant.parse("2026-11-10T08:00:00Z");
                long versatz = java.time.Duration.between(ursprung,ziel).getSeconds();
                saeen("D",VerbrauchVectorsTest.rohwerte(fall.path("input").path("reihe")).stream()
                        .map(w -> new Rohwert(w.zeit().plusSeconds(versatz),w.wert())).toList());
            }
            if (fall.path("name").asText().startsWith("f11-")) {
                saeen("ZW", VerbrauchVectorsTest.rohwerte(fall.path("input").path("reihe")));
            }
        }
        // Die Vergleichsquelle (15 min): der Lastgang des Netzbetreibers über die Lücke (F21).
        List<Rohwert> vq = new ArrayList<>();
        BigDecimal lastgang = new BigDecimal("50000.0");
        List<Instant> q = VerbrauchRegeln.viertelstunden(F11_EW_VON, F11_LUECKE_BIS);
        for (int i = 0; i < q.size(); i++) {
            vq.add(new Rohwert(q.get(i), lastgang));
            lastgang = lastgang.add(new BigDecimal(i < 40 ? "25.26" : i < 76 ? "22.6" : "24.0"));
        }
        vq.add(new Rohwert(F11_LUECKE_BIS, lastgang));
        saeen("VQ", vq);
        // Die zweite Reihe: 1 kWh je Minute ab 08:00 UTC, Lücke (09:00, 10:00).
        List<Rohwert> werte = new ArrayList<>();
        long i = 0;
        for (Instant t = Instant.parse("2026-11-10T08:00:00Z"); !t.isAfter(Instant.parse("2026-11-10T12:00:00Z"));
                t = t.plusSeconds(60), i++) {
            if (t.isAfter(Instant.parse("2026-11-10T09:00:00Z")) && t.isBefore(Z2_LUECKE_BIS)) {
                continue;
            }
            werte.add(new Rohwert(t, BigDecimal.valueOf(1000 + i)));
        }
        saeen("Z2", werte);
    }

    private static final String ROH_SQL =
            "INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, point_key, "
                    + "raw_numeric, quality, catalog_version, edge_sequence, aggregation_kind, entity_id, "
                    + "applied_revision, value_kind, role, delivery, delay_s) VALUES (?, ?, ?, ?, ?, ?, ?, 'good', "
                    + "'2026.09.11.1', ?, 'counter', ?, 3, 'counter', 'fuehrend', 'direkt', 2) ON CONFLICT DO NOTHING";

    private static void saeen(String reihe, List<Rohwert> werte) {
        List<Object[]> stapel = new ArrayList<>();
        for (Rohwert r : werte) {
            stapel.add(new Object[] {Timestamp.from(r.zeit()), Timestamp.from(r.zeit().plusSeconds(2)), KB, IDS.get("AN"),
                    IDS.get("BOX:" + reihe), KANAL, r.wert(), r.zeit().getEpochSecond(), IDS.get(reihe)});
        }
        root.batchUpdate(ROH_SQL, stapel);
    }

    private static void luecke(String reihe, Instant von, Instant bis, String vor, String nach, BigDecimal zuwachs) {
        UUID id = UUID.randomUUID();
        ObjectNode e = JSON.createObjectNode()
                .put("ereignis_id", id.toString()).put("art", "data_gap")
                .put("von", von.toString()).put("bis", bis.toString()).put("box", IDS.get("BOX:" + reihe).toString())
                .put("komponente", IDS.get(reihe).toString()).put("messkanal", KANAL).put("erkannt_aus", "kadenz")
                .put("zuwachs", zuwachs).put("einheit", "kWh").put("stand_vor", new BigDecimal(vor))
                .put("stand_nach", new BigDecimal(nach));
        MessreiheEreignisRepository.Ergebnis r = als(() ->
                new MessreiheEreignisRepository(app).anhaengen(KB, null, Urheber.CLOUD, e, null, null));
        assertThat(r.ausgang()).as("Lücke angehängt: " + r).isEqualTo(MessreiheEreignisRepository.Ausgang.ANGEHAENGT);
        IDS.put("LUECKE:" + reihe, id);
    }

    private static Anlage verteilen(String methode) {
        return new Anlage(methode, IDS.get("ZW"), KANAL, null, F11_EW_VON, F11_LUECKE_BIS, null, BEGRUENDUNG, null,
                IDS.get("LUECKE:ZW"), F11_ZUWACHS, new BigDecimal("418200.0"), new BigDecimal("420072.0"), "kWh", null,
                null, null, null, null);
    }

    private static String erfassen(Anlage a) {
        return als(() -> new TransactionTemplate(new DataSourceTransactionManager(app.getDataSource()))
                .execute(s -> ersatzwerte.erfassen(KB, a, INES, BERLIN))).kennung();
    }

    private static void zuruecknehmen(String kennung, String grund) {
        als(() -> new TransactionTemplate(new DataSourceTransactionManager(app.getDataSource()))
                .execute(s -> ersatzwerte.zuruecknehmen(KB, kennung, grund, INES)));
    }

    private static List<String> saetze(Object json) {
        List<String> aus = new ArrayList<>();
        try {
            JSON.readTree(String.valueOf(json)).forEach(k -> aus.add(k.asText()));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
        return aus;
    }

    private static List<String> array(Object a) {
        try {
            return List.of((String[]) ((java.sql.Array) a).getArray());
        } catch (java.sql.SQLException e) {
            throw new IllegalStateException(e);
        }
    }

    private static int n(Object zahl) {
        return ((Number) zahl).intValue();
    }

    private static int zahl(String sql, Object... args) {
        return root.queryForObject(sql, Integer.class, args);
    }

    private static UUID uuid(String sql, Object... args) {
        return root.queryForObject(sql, UUID.class, args);
    }

    private static <T> T als(Supplier<T> arbeit) {
        TenantContext.set(KB);
        try {
            return arbeit.get();
        } finally {
            TenantContext.clear();
        }
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
