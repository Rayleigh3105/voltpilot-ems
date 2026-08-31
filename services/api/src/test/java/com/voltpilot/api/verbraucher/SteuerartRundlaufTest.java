package com.voltpilot.api.verbraucher;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.consumers.ConsumerFinding;
import com.voltpilot.api.consumers.ConsumerPolicyValidator;
import com.voltpilot.api.consumers.ConsumerSignalCatalog;
import com.voltpilot.api.consumers.SgReady;
import java.math.BigDecimal;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * <b>DER RUNDLAUF</b> - die Abnahme des Schreibpfads (Paket P2, Konzept-Risiko
 * 5: „Roundtrip-Test „Steuerart → Policy → Steuerart" fuer jede Form").
 *
 * <p>Je Steuerart × Typ: aus dem Wunsch wird ein Dokument
 * ({@link SteuerartDokument}), das Dokument geht durch den ECHTEN
 * {@link ConsumerPolicyValidator} (ein Dokument, das er ablehnt, koennte nie
 * aktiviert werden), und die Projektion ({@link SteuerartProjektion}) muss
 * denselben Satz zurueckgeben. Faellt eine der drei Haelften auseinander,
 * faellt dieser Test - genau dafuer sind die zwei Klassen Spiegelformen.
 *
 * <p>Rein: kein Docker, kein Spring, keine DB.
 */
class SteuerartRundlaufTest {

    private final ConsumerPolicyValidator validator =
            new ConsumerPolicyValidator(new ConsumerSignalCatalog());

    private static final String ENTITY = "11111111-1111-1111-1111-111111111111";

    private static SteuerartSatz.Kontext ladepunkt() {
        return new SteuerartSatz.Kontext(VerbraucherService.TYPE_WALLBOX, new BigDecimal("11"),
                new BigDecimal("4.2"), "power_kw", "dynamisch", true, new BigDecimal("12.5"));
    }

    private static SteuerartSatz.Kontext heizstab() {
        return new SteuerartSatz.Kontext("heating-rod", new BigDecimal("3"), null, "relay_state",
                "dynamisch", true, new BigDecimal("12.5"));
    }

    private static SteuerartSatz.Kontext pumpe() {
        return new SteuerartSatz.Kontext("pump", new BigDecimal("0.8"), null, "relay_state",
                "fest", true, null);
    }

    private static SteuerartSatz.Kontext schaltlast() {
        return new SteuerartSatz.Kontext("generic-load", new BigDecimal("2"), null, "relay_state",
                "dynamisch", true, new BigDecimal("9"));
    }

    private static SteuerartSatz.Kontext sgReady() {
        return new SteuerartSatz.Kontext(SgReady.TYPE, null, null, SgReady.CONFIRMATION_CHANNEL,
                "dynamisch", true, new BigDecimal("12.5"));
    }

    /**
     * Der Rundlauf EINER Form: pruefen → schreiben → validieren → projizieren.
     * Er gibt die zurueckgelesene Steuerart heraus, damit der Fall danach ihre
     * WERTE nachrechnen kann.
     */
    private Steuerart rundlauf(SteuerartSatz.Kontext k, SteuerartWunsch w) {
        assertThat(SteuerartSatz.pruefe(k, w)).as("der Wunsch ist zulaessig").isEmpty();
        ObjectNode doc = SteuerartDokument.dokument(ENTITY, "Europe/Berlin", w, k);
        assertThat(doc).as("nur „Sofort\" hat kein Dokument").isNotNull();
        List<ConsumerFinding> fehler = validator.validate(doc).stream()
                .filter(ConsumerFinding::isError).toList();
        assertThat(fehler).as("der ECHTE Validator nimmt es an").isEmpty();
        assertThat(SgReady.findings(k.entityType(), doc).stream()
                .filter(ConsumerFinding::isError).toList())
                .as("und die typ-scharfen Regeln auch").isEmpty();
        return SteuerartProjektion.projiziere(doc, false, null);
    }

    // --- Quellen ------------------------------------------------------------

    @Test
    void ueberschussAmLadepunkt() {
        Steuerart out = rundlauf(ladepunkt(), new SteuerartWunsch(
                SteuerartProjektion.QUELLE_UEBERSCHUSS, new BigDecimal("4.2"), null, null, null,
                null, null, null, null, null, null, null, null));
        assertThat(out.quelle()).isEqualTo(SteuerartProjektion.QUELLE_UEBERSCHUSS);
        assertThat(out.schwelleKw()).isEqualByComparingTo("4.2");
        assertThat(out.ziel()).isNull();
    }

    @Test
    void ueberschussAmHeizstabNimmtDieNennleistungAlsVorgabe() {
        // Ohne Antwort auf die Folgefrage gilt die Vorgabe „= Nennleistung"
        // (§3.2) - und sie muss durch den Rundlauf ueberleben.
        Steuerart out = rundlauf(heizstab(),
                SteuerartWunsch.von(SteuerartProjektion.QUELLE_UEBERSCHUSS));
        assertThat(out.quelle()).isEqualTo(SteuerartProjektion.QUELLE_UEBERSCHUSS);
        assertThat(out.schwelleKw()).isEqualByComparingTo("3");
    }

    @Test
    void guenstigeStundenAmSchaltbarenGeraet() {
        Steuerart out = rundlauf(schaltlast(), new SteuerartWunsch(
                SteuerartProjektion.QUELLE_GUENSTIG, null, new BigDecimal("9.5"), null, null, null,
                null, null, null, null, null, null, null));
        assertThat(out.quelle()).isEqualTo(SteuerartProjektion.QUELLE_GUENSTIG);
        assertThat(out.preisgrenzeCtKwh()).isEqualByComparingTo("9.5");
    }

    @Test
    void festeZeitenAnDerPumpe() {
        Steuerart out = rundlauf(pumpe(), new SteuerartWunsch(
                SteuerartProjektion.QUELLE_FESTE_ZEITEN, null, null, null, null,
                new Steuerart.Fenster("weekdays", "09:00", "11:00"), null, null, null, null, null, null, null));
        assertThat(out.quelle()).isEqualTo(SteuerartProjektion.QUELLE_FESTE_ZEITEN);
        assertThat(out.fenster()).isEqualTo(new Steuerart.Fenster("weekdays", "09:00", "11:00"));
    }

    @Test
    void freigabeBeiUeberschussAnDerSgReadyWaermepumpe() {
        // ⚠ Die SG-Ready-Woerter kennt die Projektion (noch) nicht - sie liest
        // die Freigabe als die Ueberschuss-Quelle, die sie mechanisch IST. Der
        // Rundlauf schliesst sich damit auf der QUELLE, nicht auf dem Wort; das
        // Kundenwort haengt am TYP und wohnt im Portal.
        Steuerart out = rundlauf(sgReady(), new SteuerartWunsch(SgReady.QUELLE_UEBERSCHUSS,
                new BigDecimal("2"), null, 30, 20, null, null, null, null, null, null, null, null));
        assertThat(out.quelle()).isEqualTo(SteuerartProjektion.QUELLE_UEBERSCHUSS);
        assertThat(out.schwelleKw()).isEqualByComparingTo("2");
        assertThat(out.ziel()).as("eine SG-Ready-Pumpe hat nie ein Ziel").isNull();
    }

    @Test
    void freigabeBeiGuenstigemStromAnDerSgReadyWaermepumpe() {
        Steuerart out = rundlauf(sgReady(), new SteuerartWunsch(SgReady.QUELLE_GUENSTIG, null,
                new BigDecimal("14"), null, null, null, null, null, null, null, null, null, null));
        assertThat(out.quelle()).isEqualTo(SteuerartProjektion.QUELLE_GUENSTIG);
        assertThat(out.preisgrenzeCtKwh()).isEqualByComparingTo("14");
    }

    // --- Quelle + Ziel ------------------------------------------------------

    @Test
    void ueberschussMitZielBisUhrzeitAmLadepunkt() {
        Steuerart out = rundlauf(ladepunkt(), new SteuerartWunsch(
                SteuerartProjektion.QUELLE_UEBERSCHUSS, new BigDecimal("4.2"), null, null, null,
                null, SteuerartProjektion.ZIEL_BIS_UHRZEIT,
                new Steuerart.Fenster("daily", null, "06:00"), new BigDecimal("20"), null, null, null, null));
        assertThat(out.quelle()).isEqualTo(SteuerartProjektion.QUELLE_UEBERSCHUSS);
        assertThat(out.schwelleKw()).isEqualByComparingTo("4.2");
        assertThat(out.ziel()).isEqualTo(SteuerartProjektion.ZIEL_BIS_UHRZEIT);
        assertThat(out.zielEnergieKwh()).isEqualByComparingTo("20");
        // ⚠ Der BEGINN kommt vom Server (§3.2 fragt nur die Frist), und er ist
        // die Frist minus 12 h - nachvollziehbar statt geraten.
        assertThat(out.zielFenster()).isEqualTo(new Steuerart.Fenster("daily", "18:00", "06:00"));
    }

    @Test
    void festeZeitenMitLaufzeitZielAmHeizstab() {
        Steuerart out = rundlauf(heizstab(), new SteuerartWunsch(
                SteuerartProjektion.QUELLE_FESTE_ZEITEN, null, null, null, null,
                new Steuerart.Fenster("daily", "22:00", "06:00"),
                SteuerartProjektion.ZIEL_LAUFZEIT_BIS,
                new Steuerart.Fenster("daily", "20:00", "06:00"), null, 90, true, null, null));
        assertThat(out.quelle()).isEqualTo(SteuerartProjektion.QUELLE_FESTE_ZEITEN);
        assertThat(out.fenster()).isEqualTo(new Steuerart.Fenster("daily", "22:00", "06:00"));
        assertThat(out.ziel()).isEqualTo(SteuerartProjektion.ZIEL_LAUFZEIT_BIS);
        assertThat(out.zielLaufzeitMinuten()).isEqualTo(90);
        assertThat(out.zielAmStueck()).isTrue();
        assertThat(out.zielFenster()).isEqualTo(new Steuerart.Fenster("daily", "20:00", "06:00"));
    }

    @Test
    void guenstigMitZielAmLadepunkt() {
        Steuerart out = rundlauf(ladepunkt(), new SteuerartWunsch(
                SteuerartProjektion.QUELLE_GUENSTIG, null, new BigDecimal("11"), null, null, null,
                SteuerartProjektion.ZIEL_BIS_UHRZEIT,
                new Steuerart.Fenster("weekdays", null, "07:30"), new BigDecimal("15"), null,
                null, null, null));
        assertThat(out.quelle()).isEqualTo(SteuerartProjektion.QUELLE_GUENSTIG);
        assertThat(out.preisgrenzeCtKwh()).isEqualByComparingTo("11");
        assertThat(out.zielEnergieKwh()).isEqualByComparingTo("15");
        assertThat(out.zielFenster()).isEqualTo(new Steuerart.Fenster("weekdays", "19:30", "07:30"));
    }

    // --- „Sofort" -----------------------------------------------------------

    @Test
    void sofortHatGarKeinDokumentUndWirdWiederAlsSofortGelesen() {
        // Das Schema verlangt `minItems: 1` („Empty is not a policy"), §3.3 sagt
        // „keine Anforderung" - also nimmt der Schreibpfad die Policy ZURUECK.
        SteuerartWunsch w = SteuerartWunsch.von(SteuerartProjektion.QUELLE_SOFORT);
        assertThat(SteuerartSatz.pruefe(ladepunkt(), w)).isEmpty();
        assertThat(SteuerartDokument.dokument(ENTITY, "Europe/Berlin", w, ladepunkt())).isNull();
        assertThat(SteuerartProjektion.projiziere(null, false, null).quelle())
                .isEqualTo(SteuerartProjektion.QUELLE_SOFORT);
    }

    // --- Die Form auf dem Draht ---------------------------------------------

    @Test
    void dasLokaleSignalTraegtHystereseUndFrischeDasCloudSignalNie() {
        ObjectNode ueberschuss = SteuerartDokument.dokument(ENTITY, "Europe/Berlin",
                new SteuerartWunsch(SteuerartProjektion.QUELLE_UEBERSCHUSS, new BigDecimal("4"),
                        null, null, null, null, null, null, null, null, null, null, null),
                heizstab());
        var c = ueberschuss.path("requirements").get(0).path("condition");
        assertThat(c.path("reset_value").decimalValue()).isEqualByComparingTo("3.000");
        assertThat(c.path("max_age_s").asInt()).isEqualTo(SteuerartDokument.MAX_AGE_S);

        ObjectNode guenstig = SteuerartDokument.dokument(ENTITY, "Europe/Berlin",
                new SteuerartWunsch(SteuerartProjektion.QUELLE_GUENSTIG, null, new BigDecimal("9"),
                        null, null, null, null, null, null, null, null, null, null),
                heizstab());
        var cc = guenstig.path("requirements").get(0).path("condition");
        assertThat(cc.has("reset_value")).as("ein Cloud-Signal traegt KEINE Hysterese").isFalse();
        assertThat(cc.has("max_age_s")).isFalse();
    }

    @Test
    void einLadepunktBekommtEineLeistungEineSchaltlastEinEin() {
        ObjectNode lp = SteuerartDokument.dokument(ENTITY, null,
                SteuerartWunsch.von(SteuerartProjektion.QUELLE_UEBERSCHUSS), ladepunkt());
        var t = lp.path("requirements").get(0).path("target");
        assertThat(t.path("kind").asText()).isEqualTo("kw");
        assertThat(t.path("value").decimalValue()).isEqualByComparingTo("11");

        ObjectNode last = SteuerartDokument.dokument(ENTITY, null,
                SteuerartWunsch.von(SteuerartProjektion.QUELLE_UEBERSCHUSS), schaltlast());
        var t2 = last.path("requirements").get(0).path("target");
        assertThat(t2.path("kind").asText()).isEqualTo("on_off");
        assertThat(t2.path("value").asBoolean()).isTrue();
    }

    @Test
    void dasDokumentTraegtWederNetzPolitikNochRangNochSpeicherEntladung() {
        // §3.3 woertlich: das sind PROFIL-Felder, die die Rangliste projiziert
        // (P4) - ein Requirement-Override waere eine zweite Wahrheit.
        ObjectNode doc = SteuerartDokument.dokument(ENTITY, "Europe/Berlin",
                new SteuerartWunsch(SteuerartProjektion.QUELLE_FESTE_ZEITEN, null, null, null, null,
                        new Steuerart.Fenster("daily", "13:00", "15:00"), null, null, null, null,
                        null, null, null),
                schaltlast());
        var r = doc.path("requirements").get(0);
        assertThat(r.has("grid_energy_policy")).isFalse();
        assertThat(r.has("allow_storage_discharge")).isFalse();
        assertThat(r.has("service_rank")).isFalse();
        assertThat(r.path("enforcement").asText()).isEqualTo("must_run");
    }

    @Test
    void dasZielFensterKannNieDieLaengeNullHaben() {
        // Der Validator lehnt ein Fenster mit gleichem Anfang und Ende ab; die
        // 12-Stunden-Regel kann es per Konstruktion nicht erzeugen.
        for (String bis : List.of("00:00", "06:00", "12:00", "18:00", "23:45")) {
            assertThat(SteuerartDokument.minusStunden(bis, SteuerartSatz.ZIEL_FENSTER_STUNDEN))
                    .isNotEqualTo(bis);
        }
        assertThat(SteuerartDokument.minusStunden("06:00", 12)).isEqualTo("18:00");
        assertThat(SteuerartDokument.minusStunden("02:15", 12)).isEqualTo("14:15");
    }
}
