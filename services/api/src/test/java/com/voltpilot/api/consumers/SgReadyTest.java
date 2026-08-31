package com.voltpilot.api.consumers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.math.BigDecimal;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Die reinen Regeln der SG-Ready-Wärmepumpe (Paket P8) - ohne Docker, ohne
 * Spring, ohne Uhr. Sie halten die eine Aussage fest, an der alles hängt: wir
 * schalten eine FREIGABE, kein Gerät - also gibt es kein Ziel, keine kW und
 * keine Energie-Behauptung.
 */
class SgReadyTest {

    private static final ObjectMapper M = new ObjectMapper();
    private static final ConsumerPolicyValidator VALIDATOR =
            new ConsumerPolicyValidator(new ConsumerSignalCatalog());

    @Test
    void derTypIstDerEineTypMitOptionalerNennleistungUndEigenemNachweiskanal() {
        assertThat(SgReady.is("heat-pump-sgready")).isTrue();
        assertThat(SgReady.is("heating-rod")).isFalse();
        assertThat(SgReady.is(null)).isFalse();

        assertThat(SgReady.ratedPowerOptional(SgReady.TYPE)).isTrue();
        assertThat(SgReady.ratedPowerOptional("heating-rod")).isFalse();
        assertThat(SgReady.ratedPowerOptional("pump")).isFalse();

        assertThat(SgReady.confirmationChannel(SgReady.TYPE)).isEqualTo("freigabe");
        // ⚠ null heißt "die allgemeine Ableitung gilt" - nie ein zweiter Kanal.
        assertThat(SgReady.confirmationChannel("heating-rod")).isNull();
    }

    @Test
    void derNachweisKanalIstEineEIGENED3StufeUndNiemalsAngenommeneEnergie() {
        assertThat(ConsumerRequirementLedgerWriter.levelFor("freigabe"))
                .isEqualTo(ConsumerRequirementLedger.EnergyConfirmation.FREIGABE);
        // Der Kontrast: der bare Relais-Kanal bleibt ASSUMED (Nennleistung × Zeit).
        assertThat(ConsumerRequirementLedgerWriter.levelFor("relay_state"))
                .isEqualTo(ConsumerRequirementLedger.EnergyConfirmation.ASSUMED);
        // Sie IST ein Rücklesewert (die Freigabe ist belegt), nur eben keiner
        // über Energie - deshalb hasReadback, aber nie eine kWh.
        assertThat(ConsumerRequirementLedger.EnergyConfirmation.FREIGABE.hasReadback()).isTrue();
        assertThat(ConsumerRequirementLedger.EnergyConfirmation.NONE.hasReadback()).isFalse();
    }

    @Test
    void dieFreigabeErzeugtNIEEineEnergieZahlAuchNichtMitGepflegterNennleistung() {
        // Dieselbe Laufzeit, dieselbe Nennleistung - nur die Stufe unterscheidet:
        // ASSUMED rechnet 6 kW × 1 h = 6 kWh, FREIGABE behauptet gar nichts.
        ConsumerRequirementLedger.Requirement r = new ConsumerRequirementLedger.Requirement(
                "r1", "fixed_window", "must_run",
                java.util.EnumSet.allOf(java.time.DayOfWeek.class),
                java.time.LocalTime.of(0, 0), java.time.LocalTime.of(23, 59), false, 600, null);
        java.time.Instant now = java.time.Instant.parse("2026-08-31T10:00:00Z");
        var assumed = ConsumerRequirementLedger.evaluate(java.util.UUID.randomUUID(), List.of(r),
                new ConsumerRequirementLedger.Evidence(3600, "running_optimized", null, true,
                        ConsumerRequirementLedger.EnergyConfirmation.ASSUMED, null,
                        new BigDecimal("6")),
                now, ConsumerRequirementLedgerWriter.ZONE);
        assertThat(assumed.get(0).actualEnergyKwh()).isEqualByComparingTo("6.000");

        var freigabe = ConsumerRequirementLedger.evaluate(java.util.UUID.randomUUID(), List.of(r),
                new ConsumerRequirementLedger.Evidence(3600, "running_optimized", null, true,
                        ConsumerRequirementLedger.EnergyConfirmation.FREIGABE, null,
                        new BigDecimal("6")),
                now, ConsumerRequirementLedgerWriter.ZONE);
        assertThat(freigabe.get(0).actualEnergyKwh()).isNull();
        // Ohne Energie-Zahl bleibt auch das gespeicherte Niveau leer - das Wort
        // "freigabe" erreicht die energy_confirmation-Spalte deshalb nie.
        assertThat(freigabe.get(0).energyConfirmation()).isNull();
        // Die LAUFZEIT ist trotzdem belegt: die Freigabe stand, das ist erfüllt.
        assertThat(freigabe.get(0).actualRuntimeSeconds()).isEqualTo(3600);
    }

    // --- Vorlage (§3.3) ------------------------------------------------------

    @Test
    void dieUeberschussVorlageIstEinReaktiverWunschMitHystereseUndFrischeFenster() {
        ObjectNode doc = SgReady.policyDocument("wp-01", "Europe/Berlin",
                SgReady.Steuerart.ueberschuss());
        assertThat(doc.path("entity_id").asText()).isEqualTo("wp-01");
        JsonNode req = doc.path("requirements").get(0);
        assertThat(req.path("kind").asText()).isEqualTo("reactive");
        assertThat(req.path("enforcement").asText()).isEqualTo("opportunistic");
        assertThat(req.path("target").path("kind").asText()).isEqualTo("on_off");
        assertThat(req.path("target").path("value").asBoolean()).isTrue();
        assertThat(req.path("condition").path("signal").asText()).isEqualTo("site.pv_surplus_kw");
        assertThat(req.path("condition").path("operator").asText()).isEqualTo("gt");
        assertThat(req.path("condition").path("value").decimalValue())
                .isEqualByComparingTo("2");
        // ⚠ Ein LOKALES Signal MUSS eine Hysterese tragen (eine ziehende Wolke
        // darf die Pumpe nicht im Takt schalten) - 0,75 × Schwelle.
        assertThat(req.path("condition").path("reset_value").decimalValue())
                .isEqualByComparingTo("1.5");
        assertThat(req.path("condition").path("max_age_s").asInt()).isEqualTo(120);
        assertThat(VALIDATOR.validate(doc)).isEmpty();
    }

    @Test
    void dieGuenstigVorlageTraegtKEINEHystereseWeilDasSignalAusDerWolkeKommt() {
        ObjectNode doc = SgReady.policyDocument("wp-01", "Europe/Berlin",
                SgReady.Steuerart.guenstig());
        JsonNode cond = doc.path("requirements").get(0).path("condition");
        assertThat(cond.path("signal").asText()).isEqualTo("market.import_price_ct_kwh");
        assertThat(cond.path("operator").asText()).isEqualTo("lt");
        assertThat(cond.has("reset_value")).isFalse();
        assertThat(cond.has("max_age_s")).isFalse();
        // Der generische Validator würde eine Hysterese hier ablehnen
        // (cloud_signal_hysteresis) - die Vorlage kann ihn also nicht reißen.
        assertThat(VALIDATOR.validate(doc)).isEmpty();
    }

    @Test
    void dieFolgefragenNehmenIhreVorgabenUndRechnenMinutenInSekunden() {
        SgReady.Steuerart vorgabe = SgReady.Steuerart.ueberschuss();
        assertThat(vorgabe.mindestfreigabeSekunden()).isEqualTo(30 * 60);
        assertThat(vorgabe.sperrzeitSekunden()).isEqualTo(20 * 60);

        SgReady.Steuerart eigen = new SgReady.Steuerart(SgReady.QUELLE_UEBERSCHUSS,
                new BigDecimal("4"), null, 45, 5);
        assertThat(eigen.mindestfreigabeSekunden()).isEqualTo(45 * 60);
        assertThat(eigen.sperrzeitSekunden()).isEqualTo(5 * 60);
        JsonNode cond = SgReady.policyDocument("wp-01", null, eigen)
                .path("requirements").get(0).path("condition");
        assertThat(cond.path("value").decimalValue()).isEqualByComparingTo("4");
        assertThat(cond.path("reset_value").decimalValue()).isEqualByComparingTo("3");
    }

    @Test
    void eineUnbekannteQuelleWirdABGELEHNTStattStillZuEinerAnderenZuWerden() {
        assertThatThrownBy(() -> SgReady.policyDocument("wp-01", null,
                new SgReady.Steuerart("bis_uhrzeit", null, null, null, null)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> SgReady.policyDocument("wp-01", null, null))
                .isInstanceOf(IllegalArgumentException.class);
    }

    // --- Validierung (§3.1) --------------------------------------------------

    @Test
    void einFristZielWirdFuerDiesenTypAbgelehnt() throws Exception {
        JsonNode doc = M.readTree("""
                {"schema_version":"1.0","entity_id":"wp-01","requirements":[
                  {"id":"bis-sechs","kind":"flexible_task","enforcement":"required_by_deadline",
                   "recurrence":{"days":"daily","from":"22:00","to":"06:00"},
                   "demand":{"runtime_minutes":120},
                   "target":{"kind":"on_off","value":true}}]}""");
        List<ConsumerFinding> f = SgReady.findings(SgReady.TYPE, doc);
        assertThat(f).hasSize(1);
        assertThat(f.get(0).rule()).isEqualTo("sgready_kein_ziel");
        assertThat(f.get(0).isError()).isTrue();
        assertThat(f.get(0).message()).contains("kein Ziel");
        // ⚠ Für JEDEN anderen Typ ist dasselbe Dokument in Ordnung - die Regel
        // ist additiv, ein Bestandsverbraucher ändert dadurch kein Byte.
        assertThat(SgReady.findings("heating-rod", doc)).isEmpty();
        assertThat(SgReady.findings(null, doc)).isEmpty();

        // ⚠ JEDE der drei Kennzeichen trägt für sich - sonst könnte eine davon
        // wegfallen, ohne dass ein Test es merkt.
        for (String einzeln : List.of(
                // kind allein
                """
                {"schema_version":"1.0","entity_id":"wp-01","requirements":[
                  {"id":"a","kind":"flexible_task","enforcement":"opportunistic",
                   "target":{"kind":"on_off","value":true}}]}""",
                // enforcement allein
                """
                {"schema_version":"1.0","entity_id":"wp-01","requirements":[
                  {"id":"b","kind":"fixed_window","enforcement":"required_by_deadline",
                   "recurrence":{"days":"daily","from":"22:00","to":"06:00"},
                   "target":{"kind":"on_off","value":true}}]}""",
                // demand allein
                """
                {"schema_version":"1.0","entity_id":"wp-01","requirements":[
                  {"id":"c","kind":"reactive","enforcement":"opportunistic",
                   "condition":{"signal":"site.pv_surplus_kw","operator":"gt","value":2,
                                "reset_value":1.5,"max_age_s":120},
                   "demand":{"runtime_minutes":60},
                   "target":{"kind":"on_off","value":true}}]}""")) {
            JsonNode d = M.readTree(einzeln);
            assertThat(SgReady.findings(SgReady.TYPE, d))
                    .as(einzeln)
                    .extracting(ConsumerFinding::rule).containsExactly("sgready_kein_ziel");
        }
        // Und der generische Validator hat daran nichts auszusetzen: die
        // Ablehnung ist eine TYP-Aussage, keine Dokument-Aussage.
        assertThat(VALIDATOR.validate(doc).stream().filter(ConsumerFinding::isError)).isEmpty();
    }

    @Test
    void einKwZielWirdAbgelehntWeilEinFreigabeKontaktKeineLeistungKennt() throws Exception {
        JsonNode doc = M.readTree("""
                {"schema_version":"1.0","entity_id":"wp-01","requirements":[
                  {"id":"ueberschuss","kind":"reactive","enforcement":"opportunistic",
                   "condition":{"signal":"site.pv_surplus_kw","operator":"gt","value":2,
                                "reset_value":1.5,"max_age_s":120},
                   "target":{"kind":"kw","value":3}}]}""");
        List<ConsumerFinding> f = SgReady.findings(SgReady.TYPE, doc);
        assertThat(f).hasSize(1);
        assertThat(f.get(0).rule()).isEqualTo("sgready_nur_freigabe");
        assertThat(SgReady.findings("heating-rod", doc)).isEmpty();
    }

    @Test
    void dieEigeneVorlageBestehtDieEigeneValidierung() {
        for (SgReady.Steuerart s : List.of(SgReady.Steuerart.ueberschuss(),
                SgReady.Steuerart.guenstig())) {
            ObjectNode doc = SgReady.policyDocument("wp-01", "Europe/Berlin", s);
            assertThat(SgReady.findings(SgReady.TYPE, doc)).isEmpty();
            assertThat(VALIDATOR.validate(doc)).isEmpty();
        }
    }
}
