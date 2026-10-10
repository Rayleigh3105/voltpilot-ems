package com.voltpilot.api.uems;

import static com.voltpilot.api.uems.BilanzVectorsTest.herkunftEingang;
import static com.voltpilot.api.uems.BilanzVectorsTest.lies;
import static com.voltpilot.api.uems.BilanzVectorsTest.str;
import static com.voltpilot.api.uems.BilanzVectorsTest.texte;
import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;
import org.springframework.http.converter.json.Jackson2ObjectMapperBuilder;

/**
 * Die Herkunft in den ROUTEN (UEMS AP-10 IP-12): jeder Herkunfts-Satz der §7-Fälle ist byte-gleich zum Vektor — Inhalt
 * UND Form —, und die Ableitung aus gespeicherten Zeilen ({@link BilanzwertHerkunft#ausGespeichert}) ergibt genau
 * diese Sätze. Vektoren: {@code bilanzwert-herkunft-vectors.json} (Ableitung, {@code zuordnung}) und die Prüfungen
 * {@code herkunft} in {@code bilanz-vectors.json} / {@code verteilung-vectors.json} (die Sätze). Rein — ohne Spring-
 * Kontext, ohne Datenbank; serialisiert wird mit dem Jackson-Stand, den Spring Boot den Routen gibt.
 */
class BilanzwertHerkunftVectorsTest {

    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final Path VECTORS = V2.resolve("bilanzwert-herkunft-vectors.json");
    private static final Path SCHEMA = V2.resolve("bilanzwert-herkunft.schema.json");
    /** Wie die Routen: der Builder, aus dem Spring Boot seinen ObjectMapper baut. */
    private static final ObjectMapper ROUTE = Jackson2ObjectMapperBuilder.json().build();
    private static final Set<String> REGELN =
            Set.of("betrag", "schluessel", "periode_ende", "ausloeser", "verteilung_der_periode", "aus_gespeichert");

    /** Jede Prüfung {@code herkunft} beider Satz-Dateien mit (datei, fall, prüfung). */
    private record SatzPruefung(String datei, String fall, String name, JsonNode pruefung) {}

    private static List<SatzPruefung> saetze() throws Exception {
        List<SatzPruefung> raus = new ArrayList<>();
        for (JsonNode datei : lies(VECTORS).path("saetze_aus")) {
            for (JsonNode c : lies(V2.resolve(datei.asText())).path("cases")) {
                for (JsonNode p : c.path("pruefungen")) {
                    if ("herkunft".equals(p.path("regel").asText())) {
                        raus.add(new SatzPruefung(datei.asText(), c.path("id").asText(), p.path("name").asText(), p));
                    }
                }
            }
        }
        return raus;
    }

    /** Die Route liefert {@code {satz, fehlt}} — so wird verglichen, Zeichen für Zeichen. */
    private static String alsRoute(BilanzwertHerkunft.Urteil u) throws Exception {
        return ROUTE.writeValueAsString(BilanzwertHerkunft.umschlag(u));
    }

    private static String alsVektor(JsonNode satz, JsonNode fehlt) throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("satz", satz);
        m.put("fehlt", fehlt);
        return ROUTE.writeValueAsString(m);
    }

    // ---------------------------------------------------------------------------------- die Sätze aus §7

    /** Jeder Herkunfts-Satz, wie ihn der Java-Zwilling baut, verlässt die Route byte-gleich zum Vektor. */
    @TestFactory
    List<DynamicTest> jederSatzIstByteGleichZumVektor() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (SatzPruefung s : saetze()) {
            tests.add(DynamicTest.dynamicTest(s.datei() + " · " + s.fall() + " · " + s.name(), () -> {
                JsonNode soll = s.pruefung().path("ergebnis");
                BilanzwertHerkunft.Urteil ist = BilanzwertHerkunft.herkunft(herkunftEingang(s.pruefung().path("eingang")));
                assertThat(alsRoute(ist)).isEqualTo(alsVektor(soll.path("satz"), soll.path("fehlt")));
            }));
        }
        return tests;
    }

    /** Die Form der Routen gilt für jeden Satz: das Ende aus der Periode, jeder Betrag in EINER Schreibweise. */
    @TestFactory
    List<DynamicTest> jederSatzTraegtDieFormDerRouten() throws Exception {
        ZoneId zone = ZoneId.of(lies(VECTORS).path("zeitzone").asText());
        List<DynamicTest> tests = new ArrayList<>();
        for (SatzPruefung s : saetze()) {
            JsonNode satz = s.pruefung().path("ergebnis").path("satz");
            if (satz.isNull()) {
                continue;
            }
            tests.add(DynamicTest.dynamicTest(s.datei() + " · " + s.fall() + " · " + s.name(), () -> {
                assertThat(satz.path("periode_ende").asText()).as("periode_ende").isEqualTo(BilanzwertHerkunft
                        .periodeEnde(satz.path("periode").path("art").asText(),
                                satz.path("periode").path("schluessel").asText(), zone));
                List<JsonNode> betraege = new ArrayList<>(List.of(satz.path("menge")));
                satz.path("eingaenge").forEach(e -> betraege.add(e.path("menge")));
                if (!satz.path("verteilung").isNull()) {
                    betraege.add(satz.path("verteilung").path("anteil_prozent"));
                }
                for (JsonNode b : betraege) {
                    if (!b.isNull()) {
                        assertThat(b.asText()).as("Betrag").isEqualTo(BilanzwertHerkunft.betrag(new BigDecimal(b.asText())));
                    }
                }
            }));
        }
        return tests;
    }

    /**
     * JEDER Herkunfts-Satz der beiden Dateien hat einen Weg in eine Route — oder einen benannten Grund, warum heute
     * keine ihn liefern kann. Ein neuer Fall ohne Zuordnung macht diesen Test rot.
     */
    @Test
    void jederSatzIstEinemWegZugeordnet() throws Exception {
        JsonNode v = lies(VECTORS);
        Set<String> referenziert = new LinkedHashSet<>();
        for (JsonNode c : v.path("cases")) {
            if (c.has("satz_aus")) {
                referenziert.add(schluessel(c.path("satz_aus")));
            }
        }
        Set<String> saetze = new LinkedHashSet<>();
        for (SatzPruefung s : saetze()) {
            if (!s.pruefung().path("ergebnis").path("satz").isNull()) {
                saetze.add(s.datei() + " · " + s.fall() + " · " + s.name());
            }
        }
        Set<String> zugeordnet = new LinkedHashSet<>();
        for (JsonNode z : v.path("zuordnung")) {
            String k = schluessel(z);
            zugeordnet.add(k);
            switch (z.path("weg").asText()) {
                case "aus_gespeichert" -> assertThat(referenziert).as(k + " · von einem Fall abgeleitet").contains(k);
                case "kostenstelle", "nicht_ueber_route" ->
                        assertThat(str(z.path("grund"))).as(k + " · Grund").isNotBlank();
                default -> throw new AssertionError(k + " · unbekannter Weg " + z.path("weg"));
            }
        }
        assertThat(zugeordnet).containsExactlyInAnyOrderElementsOf(saetze);
        assertThat(saetze).containsAll(referenziert);
    }

    private static String schluessel(JsonNode n) {
        return n.path("datei").asText() + " · " + n.path("fall").asText() + " · " + n.path("pruefung").asText();
    }

    // ---------------------------------------------------------------------------------- die Regeln der Routen

    @TestFactory
    List<DynamicTest> dieRegelnDerRouten() throws Exception {
        JsonNode v = lies(VECTORS);
        JsonNode schema = lies(SCHEMA);
        Map<String, JsonNode> saetze = new LinkedHashMap<>();
        for (SatzPruefung s : saetze()) {
            saetze.put(s.datei() + " · " + s.fall() + " · " + s.name(), s.pruefung().path("ergebnis").path("satz"));
        }
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : v.path("cases")) {
            String regel = c.path("regel").asText();
            assertThat(REGELN).as("Regel " + regel).contains(regel);
            JsonNode ein = c.path("eingang");
            JsonNode soll = c.path("ergebnis");
            tests.add(DynamicTest.dynamicTest(regel + " · " + c.path("name").asText(), () -> {
                switch (regel) {
                    case "betrag" -> assertThat(BilanzwertHerkunft.betrag(ein.isNull() ? null : new BigDecimal(ein.asText())))
                            .isEqualTo(str(soll));
                    case "schluessel" -> assertThat(BilanzwertHerkunft.schluessel(ein.path("periode_art").asText(),
                            Instant.parse(ein.path("beginn").asText()), zone(v))).isEqualTo(soll.asText());
                    case "periode_ende" -> assertThat(BilanzwertHerkunft.periodeEnde(ein.path("periode_art").asText(),
                            ein.path("schluessel").asText(), zone(v))).isEqualTo(soll.asText());
                    case "ausloeser" -> assertThat(BilanzwertHerkunft.ausloeser(str(ein.path("anlass")),
                            texte(ein.path("messstellen")), ein.path("schluessel").asText(), ein.path("version").asInt()))
                            .isEqualTo(str(soll));
                    case "verteilung_der_periode" -> {
                        BilanzwertHerkunft.Verteilungsbezug ist = BilanzwertHerkunft.verteilungDerPeriode(
                                zeilen(ein.path("zeilen")), LocalDate.parse(ein.path("von").asText()),
                                LocalDate.parse(ein.path("bis").asText()));
                        if (soll.isNull()) {
                            assertThat(ist).isNull();
                        } else {
                            assertThat(ist).isEqualTo(new BilanzwertHerkunft.Verteilungsbezug(soll.path("fassung").asInt(),
                                    soll.path("ziel").asText(), soll.path("anteil_prozent").asText()));
                        }
                    }
                    case "aus_gespeichert" -> {
                        BilanzwertHerkunft.Urteil ist = BilanzwertHerkunft.ausGespeichert(gespeichert(ein));
                        JsonNode satz = "satz_aus".equals(soll.path("satz").asText())
                                ? saetze.get(schluessel(c.path("satz_aus"))) : soll.path("satz");
                        assertThat(satz).as("Satz, auf den der Fall verweist").isNotNull();
                        assertThat(alsRoute(ist)).isEqualTo(alsVektor(satz, soll.path("fehlt")));
                        if (ist.satz() != null) {
                            assertThat(UemsSchemaLaeufer.verstoesse(ROUTE.valueToTree(ist.satz()), schema)).isEmpty();
                        }
                    }
                    default -> throw new AssertionError(regel);
                }
            }));
        }
        return tests;
    }

    private static ZoneId zone(JsonNode v) {
        return ZoneId.of(v.path("zeitzone").asText());
    }

    private static List<BilanzwertHerkunft.VerteilungZeile> zeilen(JsonNode n) {
        List<BilanzwertHerkunft.VerteilungZeile> raus = new ArrayList<>();
        n.forEach(z -> raus.add(new BilanzwertHerkunft.VerteilungZeile(z.path("ziel").asText(),
                new BigDecimal(z.path("anteil_prozent").asText()), z.path("fassung").asInt(),
                LocalDate.parse(z.path("gueltig_ab").asText()),
                z.path("gueltig_bis").isNull() ? null : LocalDate.parse(z.path("gueltig_bis").asText()))));
        return raus;
    }

    private static BilanzwertHerkunft.Gespeichert gespeichert(JsonNode ein) {
        List<BilanzwertHerkunft.GespeicherterEingang> eingaenge = new ArrayList<>();
        for (JsonNode e : ein.path("eingaenge")) {
            eingaenge.add(new BilanzwertHerkunft.GespeicherterEingang(str(e.path("messstelle")), str(e.path("rolle")),
                    str(e.path("anteil")), e.path("menge").isNull() ? null : new BigDecimal(e.path("menge").asText()),
                    str(e.path("zustand")), e.path("abdeckung_prozent").isNull() ? null : e.path("abdeckung_prozent").asInt(),
                    e.path("version").isNull() ? null : e.path("version").asInt(), texte(e.path("kennzeichen"))));
        }
        JsonNode erg = ein.path("ergebnis");
        return new BilanzwertHerkunft.Gespeichert(str(ein.path("messstelle")), ein.path("periode_art").asText(),
                Instant.parse(ein.path("beginn").asText()), ZoneId.of(ein.path("zeitzone").asText()),
                str(ein.path("formel_typ")), ein.path("formel_fassung").isNull() ? null : ein.path("formel_fassung").asInt(),
                ein.path("berechnet_am").isNull() ? null : Instant.parse(ein.path("berechnet_am").asText()),
                ein.path("version").asInt(), str(ein.path("anlass")), zeilen(ein.path("verteilungen")), eingaenge,
                new BilanzwertHerkunft.Ergebnis(
                        erg.path("menge").isNull() ? null
                                : BilanzwertHerkunft.betrag(new BigDecimal(erg.path("menge").asText())),
                        str(erg.path("zustand")),
                        erg.path("abdeckung_prozent").isNull() ? null : erg.path("abdeckung_prozent").asInt(),
                        texte(erg.path("kennzeichen"))));
    }
}
