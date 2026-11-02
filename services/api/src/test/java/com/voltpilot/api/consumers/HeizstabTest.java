package com.voltpilot.api.consumers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.entities.EntityTypeCatalog;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.server.ResponseStatusException;

/**
 * Heizstab V1, Paket 3 - die API-Regeln ohne Datenbank: die Ausgangsmenge gegen die GEMEINSAMEN
 * Vektoren der Box (heizstab-stufen-vectors.json), die Anschluss-Regel, die gemeldete Stufe und
 * die angenommene Energie aus den bestätigten Stufen, der Parameterblock samt Freigabe-Tor und
 * die Stufe des Handeingriffs.
 */
class HeizstabTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(JsonNode n) {
        return JSON.convertValue(n, Map.class);
    }

    private static Map<String, Object> pro3(String anschluss) {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("ip", "192.168.178.43");
        c.put("port", 80);
        c.put("channels", List.of(0, 1, 2));
        c.put("output_kw", List.of(2.0, 2.0, 2.0));
        c.put("stages", List.of(1, 2, 3));
        c.put("anschluss", anschluss);
        return c;
    }

    // --- Ausgangsmenge: dieselben Regeln und Sätze wie die Box -----------------

    @Test
    void dieAusgangsmengePrueftDieselbenVektorenWieDieBox() throws Exception {
        JsonNode doc = JSON.readTree(Files.readString(Path.of("../../docs/contracts/v2/heizstab-stufen-vectors.json")));
        int n = 0;
        for (JsonNode v : doc.path("validate")) {
            String erwartet = v.path("error").asText();
            assertThat(HeizstabAusgaenge.fehler(map(v.path("config"))))
                    .as(v.path("name").asText())
                    .isEqualTo(erwartet.isEmpty() ? null : erwartet);
            n++;
        }
        assertThat(n).isGreaterThanOrEqualTo(10);
    }

    @Test
    void dieStufenTragenDieKwDerGroesstenElemente() {
        assertThat(HeizstabAusgaenge.stufen(pro3("stern_mit_n")))
                .extracting(HeizstabAusgaenge.Stufe::ausgaenge, s -> s.kw().doubleValue())
                .containsExactly(org.assertj.core.groups.Tuple.tuple(1, 2.0),
                        org.assertj.core.groups.Tuple.tuple(2, 4.0), org.assertj.core.groups.Tuple.tuple(3, 6.0));
        Map<String, Object> ungleich = pro3("stern_mit_n");
        ungleich.put("output_kw", List.of(2.0, 2.0, 3.0));
        ungleich.put("stages", List.of(1, 3));
        assertThat(HeizstabAusgaenge.stufen(ungleich)).extracting(s -> s.kw().doubleValue())
                .containsExactly(3.0, 7.0);
    }

    @Test
    void dasStufenprofilBestehtDenProfilValidator() {
        var levels = HeizstabGeraet.levelsKw(HeizstabAusgaenge.stufen(pro3("stern_mit_n")));
        assertThat(levels.toString()).isEqualTo("[0,2.000,4.000,6.000]");
        ObjectNode profil = JSON.createObjectNode().put("control_kind", "stepped").put("rated_power_kw", 6.0);
        profil.set("levels_kw", levels);
        assertThat(new ConsumerPolicyValidator(new ConsumerSignalCatalog()).validateControlProfile(profil).stream()
                .filter(ConsumerFinding::isError).toList()).isEmpty();
    }

    @Test
    void mehrereAusgaengeNurBeiSternMitN() {
        assertThat(HeizstabAusgaenge.anschlussFehler(pro3("stern_mit_n"))).isNull();
        assertThat(HeizstabAusgaenge.anschlussFehler(pro3("unbekannt"))).isNull();
        assertThat(HeizstabAusgaenge.anschlussBestaetigt(pro3("unbekannt"))).isFalse();
        assertThat(HeizstabAusgaenge.anschlussFehler(pro3("dreieck"))).contains("dreipoliges Schütz");
        assertThat(HeizstabAusgaenge.anschlussFehler(pro3("ohne_n"))).contains("240 V");
        Map<String, Object> ohne = pro3(null);
        ohne.remove("anschluss");
        assertThat(HeizstabAusgaenge.anschlussFehler(ohne)).isEqualTo(
                "Bitte geben Sie an, wie die Heizelemente angeschlossen sind.");
        Map<String, Object> eins = pro3("dreieck");
        eins.put("channels", List.of(0));
        eins.put("output_kw", List.of(3.0));
        eins.remove("stages");
        assertThat(HeizstabAusgaenge.anschlussFehler(eins)).as("ein Ausgang schaltet nie einzelne Phasen").isNull();
    }

    // --- gemeldete Stufe und angenommene Energie -------------------------------

    private static JsonNode eintrag(String stage) throws Exception {
        return JSON.readTree("{\"state\":\"running_optimized\",\"stage\":" + stage + "}");
    }

    @Test
    void dieStufeWirdGeprueftGelesen() throws Exception {
        HeizstabStufe.Stufe s = HeizstabStufe.stufe(eintrag("{\"commanded\":1,\"commanded_kw\":2.0,\"confirmed\":2,"
                + "\"confirmed_kw\":4.0,\"outputs_on\":[1,2,7],\"mismatch_since\":\"2026-10-31T12:00:00Z\",\"at\":\"x\"}"));
        assertThat(s.befohlen()).isEqualTo(1);
        assertThat(s.bestaetigtKw()).isEqualTo(4.0);
        assertThat(s.ausgaengeAn()).containsExactly(1, 2);
        assertThat(s.abweichungSeit()).isEqualTo("2026-10-31T12:00:00Z");
        assertThat(s.am()).as("keine gültige Zeit = fehlt").isNull();
        assertThat(s.laufKw()).isEqualTo(4.0);
        assertThat(HeizstabStufe.ausJson(s.alsJson())).isEqualTo(s);
        HeizstabStufe.Stufe unbekannt = HeizstabStufe.stufe(eintrag("{\"commanded\":3,\"commanded_kw\":6.0}"));
        assertThat(unbekannt.bestaetigt()).isNull();
        assertThat(unbekannt.laufKw()).as("unbestätigt: die befohlene Stufe").isEqualTo(6.0);
        assertThat(HeizstabStufe.stufe(eintrag("{\"commanded\":9}"))).isNull();
        assertThat(HeizstabStufe.stufe(JSON.readTree("{\"state\":\"waiting\"}"))).isNull();
    }

    @Test
    void derReglerBefundKommtNurMitBekanntemCode() throws Exception {
        String ok = HeizstabStufe.reglerJson(JSON.readTree("{\"heizstab\":{\"stufe\":1,\"ausgaenge\":1,\"kw\":2.0,"
                + "\"code\":\"haltezeit\",\"grund\":\"Haltezeit\",\"verfuegbar_kw\":4.3,\"hoeher_ab\":\"2026-10-31T12:01:30Z\"}}"));
        assertThat(JSON.readTree(ok).path("code").asText()).isEqualTo("haltezeit");
        assertThat(JSON.readTree(ok).path("hoeher_ab").asText()).isEqualTo("2026-10-31T12:01:30Z");
        assertThat(HeizstabStufe.reglerJson(JSON.readTree("{\"heizstab\":{\"stufe\":1,\"code\":\"erfunden\"}}"))).isNull();
    }

    private static HeizstabStufe.Stufe stufe(double kw) {
        return new HeizstabStufe.Stufe(1, kw, 1, kw, List.of(0), null, null);
    }

    @Test
    void eineStundeEinePhaseSindZweiKwhNieSechs() {
        // erster Herzschlag des Tages: 10 min eine Phase
        BigDecimal e1 = HeizstabStufe.energieFortschreiben(null, 600, stufe(2.0));
        assertThat(e1).isEqualByComparingTo("0.333");
        // 50 min später, weiter eine Phase: 1 h = 2 kWh
        BigDecimal e2 = HeizstabStufe.energieFortschreiben(
                new HeizstabStufe.VorigeStufe(stufe(2.0), 600, e1), 3600, stufe(2.0));
        assertThat(e2).isEqualByComparingTo("2.000");
        // Wechsel auf drei Phasen: die Sekunden bis zum Wechsel liefen mit der VORIGEN Stufe
        BigDecimal e3 = HeizstabStufe.energieFortschreiben(
                new HeizstabStufe.VorigeStufe(stufe(2.0), 3600, e2), 3660, stufe(6.0));
        assertThat(e3).isEqualByComparingTo("2.033");
        BigDecimal e4 = HeizstabStufe.energieFortschreiben(
                new HeizstabStufe.VorigeStufe(stufe(6.0), 3660, e3), 4260, stufe(6.0));
        assertThat(e4).isEqualByComparingTo("3.033");
    }

    @Test
    void derTageswechselFolgtDemZaehlerDerBox() {
        BigDecimal neu = HeizstabStufe.energieFortschreiben(
                new HeizstabStufe.VorigeStufe(stufe(2.0), 80_000, new BigDecimal("12.5")), 120, stufe(2.0));
        assertThat(neu).isEqualByComparingTo("0.067");
    }

    @Test
    void ohneLaufzeitOderStufeWirdNichtsErfunden() {
        assertThat(HeizstabStufe.energieFortschreiben(null, 600, null)).as("kein Stufen-Verbraucher").isNull();
        BigDecimal vorher = new BigDecimal("1.5");
        assertThat(HeizstabStufe.energieFortschreiben(
                new HeizstabStufe.VorigeStufe(stufe(2.0), 600, vorher), null, stufe(2.0))).isEqualByComparingTo(vorher);
        HeizstabStufe.Stufe ohneKw = new HeizstabStufe.Stufe(1, null, null, null, List.of(), null, null);
        assertThat(HeizstabStufe.energieFortschreiben(
                new HeizstabStufe.VorigeStufe(ohneKw, 600, vorher), 1200, ohneKw)).isEqualByComparingTo(vorher);
    }

    @Test
    void dasLedgerZaehltDieKwDerBestaetigtenStufe() {
        // Eine Stunde eine von drei Phasen (2 kW), Nennleistung des Stabs 6 kW: angenommen sind
        // 2 kWh - nicht 6 kWh (Nennleistung × Zeit).
        java.time.Instant now = java.time.Instant.parse("2026-10-31T20:00:00Z");
        ConsumerRequirementLedger.Requirement taeglich = new ConsumerRequirementLedger.Requirement("t",
                "flexible_task", "required_by_deadline", java.util.Set.of(java.time.DayOfWeek.values()),
                java.time.LocalTime.MIDNIGHT, java.time.LocalTime.MIDNIGHT, true, 3600, null);
        ConsumerRequirementLedger.Evidence mitStufe = new ConsumerRequirementLedger.Evidence(3600, "running_optimized",
                null, true, ConsumerRequirementLedger.EnergyConfirmation.ASSUMED, null, new BigDecimal("6.0"),
                new BigDecimal("2.000"));
        var row = ConsumerRequirementLedger.evaluate(UUID.randomUUID(), List.of(taeglich), mitStufe, now,
                java.time.ZoneId.of("Europe/Berlin")).get(0);
        assertThat(row.energyConfirmation()).isEqualTo(ConsumerRequirementLedger.EnergyConfirmation.ASSUMED);
        assertThat(row.actualEnergyKwh()).isEqualByComparingTo("2.000");
        ConsumerRequirementLedger.Evidence ohne = new ConsumerRequirementLedger.Evidence(3600, "running_optimized",
                null, true, ConsumerRequirementLedger.EnergyConfirmation.ASSUMED, null, new BigDecimal("6.0"));
        assertThat(ConsumerRequirementLedger.evaluate(UUID.randomUUID(), List.of(taeglich), ohne, now,
                java.time.ZoneId.of("Europe/Berlin")).get(0).actualEnergyKwh())
                .as("ohne Stufe bleibt es Nennleistung × Zeit").isEqualByComparingTo("6.000");
    }

    // --- Parameterblock und Freigabe ---------------------------------------------

    private static JsonNode politik(String... quellen) {
        ObjectNode doc = JSON.createObjectNode();
        var reqs = doc.putArray("requirements");
        for (String q : quellen) {
            reqs.addObject().put("id", q).put("kind", "reactive");
        }
        return doc;
    }

    @Test
    void derBlockKommtNurMitUeberschussUndBestaetigtemAnschluss() {
        ObjectNode b = HeizstabPush.block(pro3("stern_mit_n"), "storage_first", 300, 600, politik("ueberschuss"));
        assertThat(b.toString()).isEqualTo(
                "{\"modus\":\"ueberschuss\",\"vorrang\":\"speicher_zuerst\",\"mindestlauf_s\":300,\"mindestpause_s\":600}");
        assertThat(HeizstabPush.block(pro3("stern_mit_n"), "consumer_first", null, null, politik("ueberschuss"))
                .path("vorrang").asText()).isEqualTo("heizstab_zuerst");
        assertThat(HeizstabPush.block(pro3("unbekannt"), "storage_first", 300, 300, politik("ueberschuss")))
                .as("Weiß ich nicht: keine Automatik").isNull();
        assertThat(HeizstabPush.block(pro3("stern_mit_n"), "storage_first", 300, 300, politik("guenstig")))
                .as("V1 führt nur den Überschuss aus").isNull();
        Map<String, Object> kaputt = pro3("stern_mit_n");
        kaputt.remove("output_kw");
        assertThat(HeizstabPush.block(kaputt, "storage_first", 300, 300, politik("ueberschuss"))).isNull();
    }

    @Test
    void derRegelFlowVerliertNurDieQuelleDerBox() {
        JsonNode ohne = HeizstabPush.ohneBoxRegel(politik("ueberschuss", "guenstig"));
        assertThat(ohne.path("requirements")).hasSize(1);
        assertThat(ohne.path("requirements").get(0).path("id").asText()).isEqualTo("guenstig");
    }

    @Test
    void bisZumKatalogFlipNurDiePruefstandBox() {
        UUID pruefstand = UUID.randomUUID();
        UUID andere = UUID.randomUUID();
        EntityTypeCatalog katalog = new EntityTypeCatalog(JSON);
        assertThat(katalog.find(HeizstabGeraet.TYP).certificationStatus()).isEqualTo("simulator_only");
        HeizstabPush push = new HeizstabPush(mock(JdbcTemplate.class), mock(BoxFaehigkeiten.class), katalog,
                pruefstand + ", kein-uuid");
        assertThat(push.freigegeben(pruefstand)).isTrue();
        assertThat(push.freigegeben(andere)).isFalse();
        assertThat(new HeizstabPush(mock(JdbcTemplate.class), mock(BoxFaehigkeiten.class), katalog, "")
                .freigegeben(pruefstand)).as("ohne Einstellung: keine Box").isFalse();

        EntityTypeCatalog geflippt = mock(EntityTypeCatalog.class);
        when(geflippt.find(HeizstabGeraet.TYP)).thenReturn(new EntityTypeCatalog.EntityType(HeizstabGeraet.TYP,
                "Heizstab", "consumer", true, false, "off", null, null, "certified", null, null));
        assertThat(new HeizstabPush(mock(JdbcTemplate.class), mock(BoxFaehigkeiten.class), geflippt, "")
                .freigegeben(andere)).as("nach dem Flip: jede Box").isTrue();
    }

    @Test
    void eineBoxOhneReglerBekommtKeinenBlock() {
        UUID box = UUID.randomUUID();
        BoxFaehigkeiten f = mock(BoxFaehigkeiten.class);
        when(f.kann(eq(box), any())).thenReturn(false);
        HeizstabPush push = new HeizstabPush(mock(JdbcTemplate.class), f, new EntityTypeCatalog(JSON), box.toString());
        assertThat(push.fuerBox(UUID.randomUUID(), box)).isEmpty();
    }

    // --- Handeingriff mit Stufe ---------------------------------------------------

    @Test
    void derHandeingriffWaehltEineStufeNieEinenWertDazwischen() {
        List<BigDecimal> stufen = List.of(new BigDecimal("2.0"), new BigDecimal("4.0"), new BigDecimal("6.0"));
        assertThat(ConsumerOverrideService.stufeKw(stufen, 1, null)).isEqualByComparingTo("2.0");
        assertThat(ConsumerOverrideService.stufeKw(stufen, null, new BigDecimal("5.9"))).isEqualByComparingTo("4.0");
        assertThat(ConsumerOverrideService.stufeKw(stufen, null, null)).isEqualByComparingTo("6.0");
        assertThatThrownBy(() -> ConsumerOverrideService.stufeKw(stufen, 4, null))
                .isInstanceOf(ResponseStatusException.class).hasMessageContaining("1 bis 3");
        assertThatThrownBy(() -> ConsumerOverrideService.stufeKw(stufen, null, new BigDecimal("1.5")))
                .isInstanceOf(ResponseStatusException.class).hasMessageContaining("kleinste Stufe");
    }
}
