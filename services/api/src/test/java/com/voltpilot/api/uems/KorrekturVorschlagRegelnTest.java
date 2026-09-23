package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.KorrekturVorschlagRegeln.Bestehend;
import com.voltpilot.api.uems.KorrekturVorschlagRegeln.Periode;
import com.voltpilot.api.uems.KorrekturVorschlagRegeln.Stand;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Die reinen Regeln des Korrektur-Vorschlags (UEMS AP-08 IP-14) gegen ihren Vertrag
 * {@code docs/contracts/v2/korrektur-vorschlag-vectors.json}: jedes Muster und jeder Satz der vorbelegten
 * Begründung, die Form der Vorschau und die Doppelvorschlag-Sperre über den fachlichen Schlüssel.
 */
class KorrekturVorschlagRegelnTest {

    static final Path VECTORS = VerbrauchVectorsTest.V2.resolve("korrektur-vorschlag-vectors.json");
    private static final ObjectMapper JSON = new ObjectMapper();

    private static final Instant F10_VON = Instant.parse("2026-11-03T13:00:00Z");
    private static final Instant F10_BIS = Instant.parse("2026-11-03T16:45:00Z");

    private static JsonNode vertrag() throws Exception {
        return JSON.readTree(Files.readString(VECTORS));
    }

    // =============================================================================== Die Begründung

    @Test
    void dieMusterSindDieDesVertrags() throws Exception {
        Map<String, String> imVertrag = new LinkedHashMap<>();
        vertrag().path("begruendung").fields().forEachRemaining(f -> imVertrag.put(f.getKey(), f.getValue().asText()));
        assertThat(KorrekturVorschlagRegeln.BEGRUENDUNG).isEqualTo(imVertrag);
        List<String> ablehnungen = new ArrayList<>();
        vertrag().path("ablehnungen").forEach(a -> ablehnungen.add(a.asText()));
        assertThat(KorrekturVorschlagRegeln.ABLEHNUNGEN).isEqualTo(ablehnungen);
        assertThat(KorrekturVorschlagRegeln.NOTIZ_ERLEDIGT).isEqualTo(vertrag().path("erkennung_notiz").path("erledigt").asText());
        assertThat(KorrekturVorschlagRegeln.NOTIZ_VERWORFEN)
                .isEqualTo(vertrag().path("erkennung_notiz").path("verworfen").asText());
        assertThat(KorrekturVorschlagRegeln.notizErledigt("K-2026-0007"))
                .isEqualTo("Aufgenommen in den Korrektur-Vorschlag K-2026-0007.");
    }

    @Test
    void jederSatzDesVertragsZeichenFuerZeichen() throws Exception {
        JsonNode v = vertrag();
        ZoneId zone = ZoneId.of(v.path("zeitzone").asText());
        int gesprochen = 0;
        for (JsonNode c : v.path("cases")) {
            JsonNode e = c.path("eingabe");
            String satz = switch (c.path("art").asText()) {
                case KorrekturVorschlagRegeln.NACHLIEFERUNG -> KorrekturVorschlagRegeln.nachlieferung(zeit(e, "von"),
                        zeit(e, "bis"), e.path("anzahl").asInt(), zeit(e, "eingang"), zeit(e, "frist"), zone);
                case KorrekturVorschlagRegeln.ABLESESTAENDE -> KorrekturVorschlagRegeln.ablesestaende(
                        zeit(e, "zeitpunkt"), zeit(e, "eingang"), zeit(e, "frist"), zone);
                case KorrekturVorschlagRegeln.UMKLASSIFIZIERUNG -> KorrekturVorschlagRegeln.umklassifizierung(
                        e.path("richtung").asText(), zeit(e, "zeitpunkt"),
                        e.path("modul").isNull() ? null : new BigDecimal(e.path("modul").asText()), zone);
                case KorrekturVorschlagRegeln.MENGE_NACHGETRAGEN -> KorrekturVorschlagRegeln.mengeNachgetragen(
                        java.time.LocalDate.parse(e.path("tag").asText()), zeit(e, "frist"), zone);
                default -> throw new AssertionError("unbekannte Art " + c.path("art"));
            };
            assertThat(satz).as(c.path("name").asText()).isEqualTo(c.path("satz").asText());
            gesprochen++;
        }
        assertThat(gesprochen).isEqualTo(8);
    }

    /** Eine Begründung passt in die Spalte (10–500 Zeichen, {@code messreihe_korrektur_text_gueltig}). */
    @Test
    void jedeBegruendungPasstInDieSpalte() {
        String laengste = KorrekturVorschlagRegeln.nachlieferung(Instant.parse("2026-10-24T22:00:00Z"),
                Instant.parse("2027-01-24T23:00:00Z"), Integer.MAX_VALUE, Instant.parse("2027-01-31T23:59:00Z"),
                Instant.parse("2026-11-01T01:15:00Z"), ZoneId.of("America/St_Johns"));
        assertThat(laengste.length()).isBetween(10, 500);
    }

    @Test
    void eineUnbekannteRichtungIstKeinSatz() {
        assertThatThrownBy(() -> KorrekturVorschlagRegeln.umklassifizierung("als_neustart", F10_VON, null,
                ZoneId.of("Europe/Berlin"))).isInstanceOf(IllegalArgumentException.class);
    }

    // ================================================================================= Die Vorschau

    /** E14: eine Lücke, die gefüllt wird, ÄNDERT etwas — „keine Werte“ wird eine Zahl. */
    @Test
    void eineGefuellteLueckeIstEineAenderung() {
        Periode luecke = new Periode(F10_VON, Stand.keineWerte(), stand(null, "24.0", "vollständig", 15));
        assertThat(luecke.aendert()).isTrue();
        assertThat(KorrekturVorschlagRegeln.aendertEtwas(List.of(luecke))).isTrue();
        JsonNode j = KorrekturVorschlagRegeln.vorschau(List.of(luecke)).get(0);
        assertThat(j.path("periode").asText()).isEqualTo("viertelstunde");
        assertThat(j.path("bis").asText()).isEqualTo("2026-11-03T13:15:00Z");
        assertThat(j.path("alt").path("version").isNull()).isTrue();
        assertThat(j.path("alt").path("menge").isNull()).as("unbekannt ist keine Null").isTrue();
        assertThat(j.path("alt").path("menge_zustand").asText()).isEqualTo("keine Werte");
        assertThat(j.path("neu").path("menge").asText()).isEqualTo("24.0");
    }

    /** Dieselbe Aussage an anderer Stelle (Version) und dieselbe Zahl in anderer Schreibweise ändern nichts. */
    @Test
    void dieselbeAussageIstKeineAenderung() {
        Periode gleich = new Periode(F10_VON, stand(1, "24.000", "vollständig", 15), stand(null, "24.0", "vollständig", 15));
        assertThat(gleich.aendert()).isFalse();
        assertThat(KorrekturVorschlagRegeln.aendertEtwas(List.of(gleich))).isFalse();
        // Nur der Verlauf wird voller (F10, Tag: „Menge unverändert, Verlauf 100 %“) — auch das ist eine Änderung.
        assertThat(new Periode(F10_VON, stand(1, "24.0", "vollständig", 1), stand(null, "24.0", "vollständig", 15))
                .aendert()).isTrue();
    }

    @Test
    void aufeinanderfolgendeViertelstundenSindEinZeitraum() {
        List<Instant> f10 = new ArrayList<>();
        for (Instant t = F10_VON; t.isBefore(F10_BIS); t = t.plusSeconds(900)) {
            f10.add(t);
        }
        f10.add(Instant.parse("2026-11-03T20:00:00Z"));
        List<List<Instant>> gruppen = KorrekturVorschlagRegeln.zusammenhaengend(f10.reversed());
        assertThat(gruppen).hasSize(2);
        assertThat(gruppen.get(0)).hasSize(15).startsWith(F10_VON);
        assertThat(gruppen.get(1)).containsExactly(Instant.parse("2026-11-03T20:00:00Z"));
    }

    @Test
    void einBruchAufDerGrenzeBeruehrtAuchDieViertelstundeDavor() {
        assertThat(KorrekturVorschlagRegeln.viertelstundenUm(Instant.parse("2027-01-15T08:12:00Z")))
                .containsExactly(Instant.parse("2027-01-15T08:00:00Z"));
        assertThat(KorrekturVorschlagRegeln.viertelstundenUm(Instant.parse("2027-01-15T08:15:00Z")))
                .containsExactly(Instant.parse("2027-01-15T08:00:00Z"), Instant.parse("2027-01-15T08:15:00Z"));
    }

    // ================================================================================== Die Sperre

    @Test
    void einOffenerVorschlagSperrtJedenUeberschneidendenZeitraum() {
        JsonNode vorschau = vorschau("24.0");
        Bestehend offen = new Bestehend("K-2026-0007", F10_VON, F10_BIS, "vorschlag", vorschau("99.0"));
        assertThat(KorrekturVorschlagRegeln.sperre(List.of(offen), F10_VON, F10_BIS, vorschau))
                .isEqualTo(new KorrekturVorschlagRegeln.Sperre("liegt_schon_vor", "K-2026-0007"));
        assertThat(KorrekturVorschlagRegeln.sperre(List.of(offen), F10_BIS.minusSeconds(900), F10_BIS.plusSeconds(900),
                vorschau).grund()).isEqualTo("liegt_schon_vor");
        // Direkt daneben ist ein anderer Zeitraum.
        assertThat(KorrekturVorschlagRegeln.sperre(List.of(offen), F10_BIS, F10_BIS.plusSeconds(900), vorschau)).isNull();
    }

    @Test
    void einEntschiedenerSperrtNurDieselbenNeuenWerteImSelbenZeitraum() {
        Bestehend abgelehnt = new Bestehend("K-2026-0007", F10_VON, F10_BIS, "abgelehnt", vorschau("24.0"));
        assertThat(KorrekturVorschlagRegeln.sperre(List.of(abgelehnt), F10_VON, F10_BIS, vorschau("24.0")))
                .isEqualTo(new KorrekturVorschlagRegeln.Sperre("schon_entschieden", "K-2026-0007"));
        // Eine neue Tatsache (andere neue Werte) darf wieder vorgeschlagen werden …
        assertThat(KorrekturVorschlagRegeln.sperre(List.of(abgelehnt), F10_VON, F10_BIS, vorschau("25.6"))).isNull();
        // … ein anderer Zeitraum auch.
        assertThat(KorrekturVorschlagRegeln.sperre(List.of(abgelehnt), F10_VON, F10_BIS.plusSeconds(900),
                vorschau("24.0"))).isNull();
        // Das Alte zählt nicht: nach einer Freigabe ist alt eine andere Version, die neuen Werte bleiben dieselben.
        JsonNode mitAnderemAlt = vorschau("24.0");
        ((ObjectNode) mitAnderemAlt.get(0).path("alt")).put("version", 2);
        assertThat(KorrekturVorschlagRegeln.sperre(List.of(abgelehnt), F10_VON, F10_BIS, mitAnderemAlt).grund())
                .isEqualTo("schon_entschieden");
    }

    // ================================================================================== Gerüst

    private static Instant zeit(JsonNode e, String feld) {
        return Instant.parse(e.path(feld).asText());
    }

    private static Stand stand(Integer version, String menge, String zustand, int erhalten) {
        return new Stand(version, new BigDecimal(menge), zustand, List.of(), erhalten, 15, erhalten * 100 / 15, null,
                null);
    }

    private static JsonNode vorschau(String neu) {
        return KorrekturVorschlagRegeln.vorschau(List.of(new Periode(F10_VON, Stand.keineWerte(),
                stand(null, neu, "vollständig", 15))));
    }
}
