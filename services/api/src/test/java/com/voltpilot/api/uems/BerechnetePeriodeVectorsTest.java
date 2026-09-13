package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Der Periodenwert einer berechneten Messstelle (UEMS AP-10 IP-10) gegen die Vektoren F1–F7 der EINEN
 * Bilanz-Vektor-Datei ({@code docs/contracts/v2/bilanz-vectors.json}): jede {@code rest}- und {@code summe}-Prüfung
 * geht durch {@link BerechnetePeriode#rechne} — dieselbe Stelle, die der Lauf vor dem Schreiben fragt — und ergibt
 * Menge, Zustand, Abdeckung und Kennzeichen des Vektors. Dazu die Fortpflanzung vorläufig/endgültig und die
 * Abhängigkeitsordnung samt benannter Ablehnung eines Formel-Kreises.
 *
 * <p>Rein; läuft immer (kein Docker, keine DB, keine Uhr). Die Speicherklasse selbst beweist
 * {@code UemsBerechnetePeriodenwerteTest}.
 */
class BerechnetePeriodeVectorsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path VECTORS = Path.of("..", "..", "docs", "contracts", "v2", "bilanz-vectors.json");
    private static final Instant ENDE = Instant.parse("2026-11-01T00:00:00Z");
    /** Lange nach der Frist (Ende + 7 Tage) — jeder endgültige Eingang macht das Ergebnis endgültig. */
    private static final Instant SPAETER = Instant.parse("2027-06-01T00:00:00Z");

    private record Fall(String id, String name, String typ, JsonNode eingang, JsonNode ergebnis) {}

    private static List<Fall> faelle() throws Exception {
        JsonNode v = MAPPER.readTree(Files.readString(VECTORS));
        List<Fall> out = new ArrayList<>();
        for (JsonNode c : v.path("cases")) {
            String id = c.path("id").asText();
            if (!List.of("F1", "F2", "F3", "F4", "F5", "F6", "F7").contains(id)) {
                continue;
            }
            for (JsonNode p : c.path("pruefungen")) {
                String regel = p.path("regel").asText();
                if ("rest".equals(regel) || "summe".equals(regel)) {
                    out.add(new Fall(id, p.path("name").asText(), "rest".equals(regel) ? MessstelleFormelRegeln.REST
                            : MessstelleFormelRegeln.GEWICHTETE_SUMME, p.path("eingang"), p.path("ergebnis")));
                }
            }
        }
        return out;
    }

    private static List<BerechnetePeriode.Eingang> eingaenge(JsonNode eingang, String fassung) {
        List<BerechnetePeriode.Eingang> out = new ArrayList<>();
        for (JsonNode e : eingang.path("eingaenge")) {
            List<String> kennzeichen = new ArrayList<>();
            e.path("kennzeichen").forEach(k -> kennzeichen.add(k.asText()));
            out.add(new BerechnetePeriode.Eingang(e.path("messstelle").asText(), text(e.path("rolle")),
                    text(e.path("anteil")), e.has("vorzeichen") ? e.path("vorzeichen").asText() : null,
                    e.has("faktor") ? new BigDecimal(e.path("faktor").asText()) : BigDecimal.ONE,
                    e.path("menge").isNull() ? null : new BigDecimal(e.path("menge").asText()),
                    e.path("zustand").asText(), e.path("abdeckung_prozent").isNull() ? null
                            : e.path("abdeckung_prozent").asInt(),
                    e.path("version").isMissingNode() ? 1 : e.path("version").asInt(), kennzeichen, fassung, null));
        }
        return out;
    }

    private static String text(JsonNode n) {
        return n.isMissingNode() || n.isNull() ? null : n.asText();
    }

    private static List<String> vermerke(JsonNode eingang) {
        List<String> out = new ArrayList<>();
        eingang.path("vermerke").forEach(v -> out.add(v.asText()));
        return out;
    }

    private static String ebene(JsonNode eingang) {
        return eingang.path("zahl_ebene").asText();
    }

    @Test
    void f1BisF7AlsPeriodenwerteErgebenMengeZustandAbdeckungUndKennzeichenDesVektors() throws Exception {
        List<Fall> faelle = faelle();
        assertThat(faelle).extracting(Fall::id).contains("F1", "F2", "F3", "F4", "F5", "F6", "F7");
        for (Fall f : faelle) {
            BerechnetePeriode.Urteil u = BerechnetePeriode.rechne(f.typ(), "kWh", ebene(f.eingang()),
                    eingaenge(f.eingang(), ViertelstundeRegeln.ENDGUELTIG), ENDE, SPAETER, vermerke(f.eingang()));
            assertThat(u.grund()).as(f.id() + " " + f.name()).isNull();
            BerechnetePeriode.Ergebnis e = u.ergebnis();
            JsonNode soll = f.ergebnis();
            if (soll.path("menge").isNull()) {
                assertThat(e.menge()).as(f.id() + " " + f.name() + ": keine Werte ist nie 0").isNull();
            } else {
                assertThat(e.menge()).as(f.id() + " " + f.name())
                        .isEqualByComparingTo(new BigDecimal(soll.path("menge").asText()));
            }
            assertThat(e.mengeZustand()).as(f.id() + " " + f.name()).isEqualTo(soll.path("zustand").asText());
            assertThat(e.abdeckungProzent()).as(f.id() + " " + f.name())
                    .isEqualTo(soll.path("abdeckung_prozent").isNull() ? null : soll.path("abdeckung_prozent").asInt());
            List<String> kennzeichen = new ArrayList<>();
            soll.path("kennzeichen").forEach(k -> kennzeichen.add(k.asText()));
            assertThat(e.kennzeichen()).as(f.id() + " " + f.name()).containsExactlyElementsOf(kennzeichen);
            assertThat(e.zustand()).as(f.id() + ": alle Eingänge endgültig, Frist vorbei")
                    .isEqualTo(ViertelstundeRegeln.ENDGUELTIG);
            assertThat(e.endgueltigAb()).isEqualTo(ENDE.plus(ViertelstundeRegeln.FRIST));
        }
    }

    /** §4.5 über die vorhandene Regel: EIN vorläufiger Eingang macht das Ergebnis vorläufig — an derselben Zahl. */
    @Test
    void einVorlaeufigerEingangMachtDasErgebnisVorlaeufig() throws Exception {
        Fall f1 = faelle().stream().filter(f -> "F1".equals(f.id())).findFirst().orElseThrow();
        List<BerechnetePeriode.Eingang> alle = eingaenge(f1.eingang(), ViertelstundeRegeln.ENDGUELTIG);
        List<BerechnetePeriode.Eingang> einer = new ArrayList<>(alle);
        BerechnetePeriode.Eingang ms17 = einer.get(1);
        einer.set(1, new BerechnetePeriode.Eingang(ms17.messstelle(), ms17.rolle(), ms17.anteil(), ms17.vorzeichen(),
                ms17.faktor(), ms17.menge(), ms17.zustand(), ms17.abdeckungProzent(), ms17.version(),
                ms17.kennzeichen(), ViertelstundeRegeln.VORLAEUFIG, null));

        BerechnetePeriode.Ergebnis endgueltig = BerechnetePeriode.rechne(f1.typ(), "kWh", "tag", alle, ENDE, SPAETER,
                List.of()).ergebnis();
        BerechnetePeriode.Ergebnis vorlaeufig = BerechnetePeriode.rechne(f1.typ(), "kWh", "tag", einer, ENDE, SPAETER,
                List.of()).ergebnis();
        assertThat(endgueltig.zustand()).isEqualTo(ViertelstundeRegeln.ENDGUELTIG);
        assertThat(vorlaeufig.zustand()).isEqualTo(ViertelstundeRegeln.VORLAEUFIG);
        assertThat(vorlaeufig.menge()).isEqualByComparingTo("10");
        assertThat(vorlaeufig.eingaengeEndgueltig()).isEqualTo(2);
        // Die Frist gehört der Periode: vor Ende + 7 Tagen ist auch ein Ergebnis aus endgültigen Eingängen vorläufig.
        assertThat(BerechnetePeriode.rechne(f1.typ(), "kWh", "tag", alle, ENDE, ENDE.plusSeconds(3600), List.of())
                .ergebnis().zustand()).isEqualTo(ViertelstundeRegeln.VORLAEUFIG);
    }

    /** Eine Periode, an der kein Eingang etwas hat, bekommt wie eine Lücke keine Zeile — nie „0“. */
    @Test
    void ohneEinenVorhandenenEingangEntstehtKeineZeile() {
        List<BerechnetePeriode.Eingang> leer = List.of(
                new BerechnetePeriode.Eingang("MS-16", "zufluss", "gesamt", null, null, null, null, null, null,
                        List.of(), null, null),
                new BerechnetePeriode.Eingang("MS-17", "zugeordnet", "positiv", null, null, null, null, null, null,
                        List.of(), null, BerechnetePeriodenLauf.ANTEIL_NICHT_GESPEICHERT));
        BerechnetePeriode.Urteil u = BerechnetePeriode.rechne(MessstelleFormelRegeln.REST, "kWh", "tag", leer, ENDE,
                SPAETER, List.of());
        assertThat(u.ergebnis()).isNull();
        assertThat(u.grund()).isEqualTo(BerechnetePeriode.KEINE_EINGAENGE);

        // Liegen unter einem Eingang schon Rohwerte (noch nicht gebildet), entsteht eine VORLÄUFIGE Zeile.
        List<BerechnetePeriode.Eingang> roh = List.of(new BerechnetePeriode.Eingang("MS-16", "zufluss", "gesamt",
                null, null, null, null, null, null, List.of(), null, BerechnetePeriode.NOCH_NICHT_GEBILDET));
        BerechnetePeriode.Ergebnis e = BerechnetePeriode.rechne(MessstelleFormelRegeln.REST, "kWh", "tag", roh, ENDE,
                SPAETER, List.of()).ergebnis();
        assertThat(e.menge()).isNull();
        assertThat(e.mengeZustand()).isEqualTo(BilanzAbleitung.KEINE_WERTE);
        assertThat(e.zustand()).isEqualTo(ViertelstundeRegeln.VORLAEUFIG);
    }

    /**
     * Die Abhängigkeitsordnung kommt aus den Kanten, nicht aus dem Kennzeichen: MS-20 liest MS-22, also rechnet
     * MS-22 zuerst, obwohl MS-20 alphabetisch vorn steht.
     */
    @Test
    void dieReihenfolgeFolgtDenEingaengenNichtDemKennzeichen() {
        Map<String, List<String>> lesen = new LinkedHashMap<>();
        lesen.put("MS-19", List.of("MS-01", "MS-10"));
        lesen.put("MS-20", List.of("MS-06", "MS-22"));
        lesen.put("MS-21", List.of("MS-20"));
        lesen.put("MS-22", List.of("MS-16", "MS-17"));
        BerechnetePeriode.Reihenfolge r = BerechnetePeriode.reihenfolge(lesen);
        assertThat(r.abgelehnt()).isEmpty();
        assertThat(r.ordnung()).containsExactly("MS-19", "MS-22", "MS-20", "MS-21");
    }

    /** Ein Kreis wird benannt abgelehnt — mit seiner Kette — und wer an ihm hängt, auch; der Rest rechnet. */
    @Test
    void einFormelKreisWirdBenanntAbgelehntStattEndlosGerechnet() {
        Map<String, List<String>> lesen = new LinkedHashMap<>();
        lesen.put("MS-30", List.of("MS-31"));
        lesen.put("MS-31", List.of("MS-32"));
        lesen.put("MS-32", List.of("MS-30"));
        lesen.put("MS-33", List.of("MS-31", "MS-10"));
        lesen.put("MS-34", List.of("MS-10"));
        BerechnetePeriode.Reihenfolge r = BerechnetePeriode.reihenfolge(lesen);
        assertThat(r.ordnung()).containsExactly("MS-34");
        assertThat(r.abgelehnt()).extracting(BerechnetePeriode.Abgelehnt::messstelle)
                .containsExactly("MS-30", "MS-31", "MS-32", "MS-33");
        assertThat(r.abgelehnt().get(0).grund()).isEqualTo(BerechnetePeriode.FORMEL_KREIS);
        assertThat(r.abgelehnt().get(0).kette()).containsExactly("MS-30", "MS-31", "MS-32", "MS-30");
        assertThat(r.abgelehnt().get(3).grund()).isEqualTo(BerechnetePeriode.HAENGT_AN_KREIS);
        assertThat(r.abgelehnt().get(3).kette()).containsExactly("MS-33", "MS-31", "MS-32", "MS-30", "MS-31");
        // Die Selbstreferenz ist der kleinste Kreis.
        assertThat(BerechnetePeriode.reihenfolge(Map.of("MS-40", List.of("MS-40"))).abgelehnt())
                .extracting(BerechnetePeriode.Abgelehnt::kette).containsExactly(List.of("MS-40", "MS-40"));
    }
}
