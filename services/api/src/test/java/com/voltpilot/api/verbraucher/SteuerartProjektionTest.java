package com.voltpilot.api.verbraucher;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import org.junit.jupiter.api.Test;

/**
 * Die Inverse §7.1 - ROUNDTRIP je Form (Konzept-Risiko 5: „Projektions-
 * Mehrdeutigkeit; Nr. 9 „Eigene Regel" faengt alles").
 *
 * <p>Jeder Fall baut das Dokument so, wie {@code ConsumerPolicyCompiler} und
 * der Baukasten es heute schreiben, und prueft, dass die Projektion GENAU die
 * Steuerart samt ihren Werten zurueckgibt. Rein, ohne Docker.
 */
class SteuerartProjektionTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static JsonNode doc(String requirements) {
        try {
            return MAPPER.readTree("{\"schema_version\":\"1.0\",\"entity_id\":\"e1\","
                    + "\"requirements\":" + requirements + "}");
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static final String ON = "{\"kind\":\"on_off\",\"value\":true}";

    private static Steuerart p(JsonNode d) {
        return SteuerartProjektion.projiziere(d, false, null);
    }

    // --- Regel 1 + 2 --------------------------------------------------------

    @Test
    void regel1_einOcppLadepunktOhnePolicyFolgtDemAnlagenStandard() {
        Steuerart standard = SteuerartProjektion.anlagenStandard("nur_sonne", null);
        Steuerart out = SteuerartProjektion.projiziere(null, true, standard);
        assertThat(out).isSameAs(standard);
        assertThat(out.quelle()).isEqualTo(SteuerartProjektion.QUELLE_UEBERSCHUSS);
        assertThat(out.herkunft()).isEqualTo(SteuerartProjektion.HERKUNFT_STANDARD);
    }

    @Test
    void regel2_jedeAndereKomponenteOhnePolicyLaeuftWieDasGeraetEsTut() {
        Steuerart out = SteuerartProjektion.projiziere(null, false,
                SteuerartProjektion.anlagenStandard("nur_sonne", null));
        // ⚠ NICHT der Anlagen-Standard: ein Heizstab kennt den Ladepark nicht.
        assertThat(out.quelle()).isEqualTo(SteuerartProjektion.QUELLE_SOFORT);
        assertThat(out.herkunft()).isEqualTo(SteuerartProjektion.HERKUNFT_OHNE);
        assertThat(out.ziel()).isNull();
    }

    @Test
    void einePolicyOhneAktiveAnforderungSagtDasselbeWieKeine() {
        JsonNode d = doc("[{\"id\":\"r1\",\"active\":false,\"kind\":\"reactive\","
                + "\"enforcement\":\"opportunistic\",\"target\":" + ON + ","
                + "\"condition\":{\"signal\":\"site.pv_surplus_kw\",\"operator\":\"gt\",\"value\":2}}]");
        assertThat(p(d).quelle()).isEqualTo(SteuerartProjektion.QUELLE_SOFORT);
        assertThat(p(d).herkunft()).isEqualTo(SteuerartProjektion.HERKUNFT_OHNE);
    }

    // --- Regeln 3-6 (Quellen) ----------------------------------------------

    @Test
    void regel3_fahrzeugVerbundenIstSofortLaden() {
        JsonNode d = doc("[{\"id\":\"r1\",\"kind\":\"reactive\",\"enforcement\":\"must_run\","
                + "\"target\":" + ON + ",\"condition\":{\"signal\":\"consumer.vehicle_connected\","
                + "\"operator\":\"eq\",\"value\":true}}]");
        assertThat(p(d).quelle()).isEqualTo(SteuerartProjektion.QUELLE_SOFORT);
        assertThat(p(d).herkunft()).isEqualTo(SteuerartProjektion.HERKUNFT_POLICY);
    }

    @Test
    void regel4_pvUeberschussTraegtSeineSchwelle() {
        JsonNode d = doc("[{\"id\":\"r1\",\"kind\":\"reactive\",\"enforcement\":\"opportunistic\","
                + "\"target\":{\"kind\":\"kw\",\"value\":11},"
                + "\"condition\":{\"signal\":\"site.pv_surplus_kw\",\"operator\":\"gt\","
                + "\"value\":2.5,\"reset_value\":1.875,\"max_age_s\":120}}]");
        Steuerart s = p(d);
        assertThat(s.quelle()).isEqualTo(SteuerartProjektion.QUELLE_UEBERSCHUSS);
        assertThat(s.schwelleKw()).isEqualByComparingTo("2.5");
    }

    @Test
    void regel4_derZulaessigeBaumIstUeberschussUNDfahrzeugVerbunden() {
        String all = "{\"all\":[{\"signal\":\"consumer.vehicle_connected\",\"operator\":\"eq\","
                + "\"value\":true},{\"signal\":\"site.pv_surplus_kw\",\"operator\":\"gte\","
                + "\"value\":4}]}";
        JsonNode d = doc("[{\"id\":\"r1\",\"kind\":\"reactive\",\"enforcement\":\"opportunistic\","
                + "\"target\":" + ON + ",\"condition\":" + all + "}]");
        Steuerart s = p(d);
        assertThat(s.quelle()).isEqualTo(SteuerartProjektion.QUELLE_UEBERSCHUSS);
        assertThat(s.schwelleKw()).isEqualByComparingTo("4");
    }

    @Test
    void regel5_beidePreisSignaleErgebenGuenstigeStunden() {
        for (String signal : new String[] {"market.import_price_ct_kwh", "market.spot_price_ct_kwh"}) {
            JsonNode d = doc("[{\"id\":\"r1\",\"kind\":\"reactive\","
                    + "\"enforcement\":\"opportunistic\",\"target\":" + ON + ","
                    + "\"condition\":{\"signal\":\"" + signal + "\",\"operator\":\"lt\","
                    + "\"value\":12}}]");
            Steuerart s = p(d);
            assertThat(s.quelle()).as(signal).isEqualTo(SteuerartProjektion.QUELLE_GUENSTIG);
            assertThat(s.preisgrenzeCtKwh()).as(signal).isEqualByComparingTo("12");
        }
    }

    @Test
    void regel6_festesFensterTraegtTageUndZeiten() {
        JsonNode d = doc("[{\"id\":\"r1\",\"kind\":\"fixed_window\",\"enforcement\":\"must_run\","
                + "\"target\":" + ON + ",\"recurrence\":{\"days\":\"weekdays\",\"from\":\"13:00\","
                + "\"to\":\"15:00\"}}]");
        Steuerart s = p(d);
        assertThat(s.quelle()).isEqualTo(SteuerartProjektion.QUELLE_FESTE_ZEITEN);
        assertThat(s.fenster()).isEqualTo(new Steuerart.Fenster("weekdays", "13:00", "15:00"));
    }

    // --- Regeln 7 + 8 (Ziele) ----------------------------------------------

    @Test
    void regel7_eineFristAlleinIstGuenstigPlusZiel() {
        JsonNode d = doc("[{\"id\":\"r1\",\"kind\":\"flexible_task\","
                + "\"enforcement\":\"required_by_deadline\",\"target\":" + ON + ","
                + "\"recurrence\":{\"days\":\"daily\",\"from\":\"00:00\",\"to\":\"06:00\"},"
                + "\"demand\":{\"energy_kwh\":20}}]");
        Steuerart s = p(d);
        assertThat(s.quelle()).isEqualTo(SteuerartProjektion.QUELLE_GUENSTIG);
        // ⚠ Ohne Grenze im Dokument wird keine erfunden.
        assertThat(s.preisgrenzeCtKwh()).isNull();
        assertThat(s.ziel()).isEqualTo(SteuerartProjektion.ZIEL_BIS_UHRZEIT);
        assertThat(s.zielEnergieKwh()).isEqualByComparingTo("20");
        assertThat(s.zielFenster().bis()).isEqualTo("06:00");
    }

    @Test
    void regel8_quellePlusZielInBeliebigerReihenfolge() {
        String quelle = "{\"id\":\"r1\",\"kind\":\"reactive\",\"enforcement\":\"opportunistic\","
                + "\"target\":" + ON + ",\"condition\":{\"signal\":\"site.pv_surplus_kw\","
                + "\"operator\":\"gt\",\"value\":3}}";
        String ziel = "{\"id\":\"r2\",\"kind\":\"flexible_task\","
                + "\"enforcement\":\"required_by_deadline\",\"target\":" + ON + ","
                + "\"recurrence\":{\"days\":\"daily\",\"from\":\"00:00\",\"to\":\"06:00\"},"
                + "\"demand\":{\"energy_kwh\":20}}";
        for (String reqs : new String[] {"[" + quelle + "," + ziel + "]",
                "[" + ziel + "," + quelle + "]"}) {
            Steuerart s = p(doc(reqs));
            assertThat(s.quelle()).as(reqs).isEqualTo(SteuerartProjektion.QUELLE_UEBERSCHUSS);
            assertThat(s.schwelleKw()).as(reqs).isEqualByComparingTo("3");
            assertThat(s.ziel()).as(reqs).isEqualTo(SteuerartProjektion.ZIEL_BIS_UHRZEIT);
            assertThat(s.zielEnergieKwh()).as(reqs).isEqualByComparingTo("20");
        }
    }

    @Test
    void dasLaufzeitZielTraegtMinutenUndAmStueck() {
        JsonNode d = doc("[{\"id\":\"r1\",\"kind\":\"flexible_task\","
                + "\"enforcement\":\"required_by_deadline\",\"target\":" + ON + ","
                + "\"recurrence\":{\"days\":\"daily\",\"from\":\"06:00\",\"to\":\"18:00\"},"
                + "\"demand\":{\"runtime_minutes\":90,\"contiguous\":true}}]");
        Steuerart s = p(d);
        assertThat(s.ziel()).isEqualTo(SteuerartProjektion.ZIEL_LAUFZEIT_BIS);
        assertThat(s.zielLaufzeitMinuten()).isEqualTo(90);
        assertThat(s.zielAmStueck()).isTrue();
        assertThat(s.zielEnergieKwh()).isNull();
    }

    // --- Regel 9: der Auffang -----------------------------------------------

    @Test
    void regel9_faengtJedeMehrdeutigkeit() {
        String ueberschuss = "{\"id\":\"a\",\"kind\":\"reactive\",\"enforcement\":\"opportunistic\","
                + "\"target\":" + ON + ",\"condition\":{\"signal\":\"site.pv_surplus_kw\","
                + "\"operator\":\"gt\",\"value\":3}}";
        String[] faelle = {
            // zwei Quellen
            "[" + ueberschuss + "," + ueberschuss.replace("\"a\"", "\"b\"") + "]",
            // ein ODER-Baum
            "[{\"id\":\"a\",\"kind\":\"reactive\",\"enforcement\":\"opportunistic\",\"target\":"
                    + ON + ",\"condition\":{\"any\":[{\"signal\":\"site.pv_surplus_kw\","
                    + "\"operator\":\"gt\",\"value\":3}]}}]",
            // ein mode-Target
            "[{\"id\":\"a\",\"kind\":\"reactive\",\"enforcement\":\"opportunistic\","
                    + "\"target\":{\"kind\":\"mode\",\"value\":\"eco\"},"
                    + "\"condition\":{\"signal\":\"site.pv_surplus_kw\",\"operator\":\"gt\","
                    + "\"value\":3}}]",
            // ein AUS-Ziel
            "[{\"id\":\"a\",\"kind\":\"reactive\",\"enforcement\":\"opportunistic\","
                    + "\"target\":{\"kind\":\"on_off\",\"value\":false},"
                    + "\"condition\":{\"signal\":\"site.pv_surplus_kw\",\"operator\":\"gt\","
                    + "\"value\":3}}]",
            // die Anforderungs-ART `opportunistic`
            "[{\"id\":\"a\",\"kind\":\"opportunistic\",\"enforcement\":\"opportunistic\","
                    + "\"target\":" + ON + "}]",
            // ein unbekanntes Signal
            "[{\"id\":\"a\",\"kind\":\"reactive\",\"enforcement\":\"opportunistic\",\"target\":"
                    + ON + ",\"condition\":{\"signal\":\"storage.soc_pct\",\"operator\":\"lt\","
                    + "\"value\":20}}]",
            // eine Frist mit ZWEI Bedarfen
            "[{\"id\":\"a\",\"kind\":\"flexible_task\",\"enforcement\":\"required_by_deadline\","
                    + "\"target\":" + ON + ",\"recurrence\":{\"days\":\"daily\",\"from\":\"00:00\","
                    + "\"to\":\"06:00\"},\"demand\":{\"energy_kwh\":20,\"runtime_minutes\":90}}]",
            // ein festes Fenster als WUNSCH (nicht must_run)
            "[{\"id\":\"a\",\"kind\":\"fixed_window\",\"enforcement\":\"opportunistic\","
                    + "\"target\":" + ON + ",\"recurrence\":{\"days\":\"daily\",\"from\":\"13:00\","
                    + "\"to\":\"15:00\"}}]",
        };
        for (String reqs : faelle) {
            Steuerart s = p(doc(reqs));
            assertThat(s.quelle()).as(reqs).isEqualTo(SteuerartProjektion.QUELLE_EIGENE_REGEL);
            assertThat(s.herkunft()).as(reqs).isEqualTo(SteuerartProjektion.HERKUNFT_POLICY);
            assertThat(s.ziel()).as(reqs).isNull();
        }
    }

    @Test
    void auchEinOcppLadepunktMitEigenerPolicyFolgtNichtMehrDemStandard() {
        Steuerart standard = SteuerartProjektion.anlagenStandard("sonne_zuerst",
                new BigDecimal("4.2"));
        JsonNode d = doc("[{\"id\":\"r1\",\"kind\":\"reactive\",\"enforcement\":\"must_run\","
                + "\"target\":" + ON + ",\"condition\":{\"signal\":\"consumer.vehicle_connected\","
                + "\"operator\":\"eq\",\"value\":true}}]");
        Steuerart s = SteuerartProjektion.projiziere(d, true, standard);
        assertThat(s.quelle()).isEqualTo(SteuerartProjektion.QUELLE_SOFORT);
        assertThat(s.herkunft()).isEqualTo(SteuerartProjektion.HERKUNFT_POLICY);
    }

    // --- §7.2: der Anlagen-Standard ----------------------------------------

    @Test
    void derStandardBildetDieDreiWoerterDerBoxAb() {
        Steuerart pausieren = SteuerartProjektion.anlagenStandard("nur_sonne", new BigDecimal("4.2"));
        assertThat(pausieren.quelle()).isEqualTo(SteuerartProjektion.QUELLE_UEBERSCHUSS);
        assertThat(pausieren.ueberschussModus()).isEqualTo(SteuerartProjektion.MODUS_PAUSIEREN);
        // Beim Pausieren gibt es keine Mindestleistung - und sie wird nicht erfunden.
        assertThat(pausieren.mindestleistungKw()).isNull();

        Steuerart halten = SteuerartProjektion.anlagenStandard("sonne_zuerst", new BigDecimal("4.2"));
        assertThat(halten.ueberschussModus()).isEqualTo(SteuerartProjektion.MODUS_MINDESTLEISTUNG);
        assertThat(halten.mindestleistungKw()).isEqualByComparingTo("4.2");

        assertThat(SteuerartProjektion.anlagenStandard("schnell", null).quelle())
                .isEqualTo(SteuerartProjektion.QUELLE_SOFORT);
    }

    @Test
    void ohneGepflegteWahlGiltSchnellLaden_dieKompatibilitaetsZusageDerBox() {
        // ⚠ NICHT „Sonne zuerst": PolicyFast ist der NEUTRALE Wert, mit dem eine
        // nie gefragte Anlage byte-genau wie vorher verteilt.
        for (String p : new String[] {null, "", "  ", "voellig_unbekannt"}) {
            assertThat(SteuerartProjektion.anlagenStandard(p, null).quelle()).as(String.valueOf(p))
                    .isEqualTo(SteuerartProjektion.QUELLE_SOFORT);
        }
    }
}
