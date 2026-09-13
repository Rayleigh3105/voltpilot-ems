package com.voltpilot.api.uems;

import static com.voltpilot.api.uems.VerbrauchVectorsTest.VECTORS;
import static com.voltpilot.api.uems.VerbrauchVectorsTest.V2;
import static com.voltpilot.api.uems.VerbrauchVectorsTest.dezimal;
import static com.voltpilot.api.uems.VerbrauchVectorsTest.ereignisse;
import static com.voltpilot.api.uems.VerbrauchVectorsTest.kontext;
import static com.voltpilot.api.uems.VerbrauchVectorsTest.lies;
import static com.voltpilot.api.uems.VerbrauchVectorsTest.rohwerte;
import static com.voltpilot.api.uems.VerbrauchVectorsTest.zahl;
import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.uems.VerbrauchRegeln.Anteil;
import com.voltpilot.api.uems.VerbrauchRegeln.Ergebnis;
import com.voltpilot.api.uems.VerbrauchRegeln.Ersatzwert;
import com.voltpilot.api.uems.VerbrauchRegeln.LueckenZuwachs;
import com.voltpilot.api.uems.VerbrauchRegeln.Profilwert;
import com.voltpilot.api.uems.VerbrauchRegeln.Rohwert;
import com.voltpilot.api.uems.VerbrauchRegeln.Version;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
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

/**
 * Der Java-Zwilling der ERSATZWERT-METHODEN (UEMS AP-08 IP-13, E7) gegen den Block {@code ersatzwerte} der
 * EINEN Vektor-Datei {@code docs/contracts/v2/verbrauch-vectors.json} — PER PFAD, dieselbe Datei wie der
 * Python-Zwilling ({@code tests/test_verbrauch.py}). Abnahme: F11 (Version 2) und F21 (Widerruf und
 * Ersatz, Version 3) grün, dazu jede Methode und jede benannte Ablehnung.
 *
 * <p>Wie in {@link VerbrauchVectorsTest} liest der Test nur die FORM der Datei: eine Lücke nennt ein
 * Ersatzwert mit {@code {von, bis}}, und ihr Zuwachs kommt aus den Rohwerten der Reihe — so wie der Lauf ihn
 * aus der {@code data_gap}-Meldung nimmt, nie abgetippt. Rein; läuft immer.
 */
class VerbrauchErsatzwertVectorsTest {

    private static final String F11 = "f11-begr-ndeter-ersatzwert";
    private static final String F21 = "f21-widerruf-und-ersatz-durch-eine-bessere-methode";

    @Test
    void dieMethodenUndAblehnungenSindDieDesVertrags() throws Exception {
        JsonNode datei = lies(VECTORS);
        assertThat(datei.path("regeln").path("ersatzwert_stellen").asInt()).isEqualTo(VerbrauchRegeln.ERSATZWERT_STELLEN);
        List<String> ablehnungen = new ArrayList<>();
        datei.path("regeln").path("ersatzwert_ablehnungen").forEach(a -> ablehnungen.add(a.asText()));
        assertThat(ablehnungen).isEqualTo(VerbrauchRegeln.ERSATZWERT_ABLEHNUNGEN);

        Map<String, String> namen = new LinkedHashMap<>();
        List<String> verteilen = new ArrayList<>();
        List<String> uebernehmen = new ArrayList<>();
        for (JsonNode m : lies(V2.resolve("events-vocabulary-vectors.json")).path("vokabular").path("ersatzwert_methode")) {
            namen.put(m.path("code").asText(), m.path("name").asText());
            if ("gemessen".equals(m.path("zuwachs").asText())) {
                verteilen.add(m.path("code").asText());
            }
            if ("keiner".equals(m.path("zuwachs").asText())
                    && List.of("vorperiode", "vergleichsquelle").contains(m.path("bezug").asText())) {
                uebernehmen.add(m.path("code").asText());
            }
        }
        assertThat(new ArrayList<>(ErgebnisZustand.ERSATZWERT_METHODE_NAME.entrySet()))
                .isEqualTo(new ArrayList<>(namen.entrySet()));
        assertThat(new ArrayList<>(namen.keySet())).isEqualTo(EreignisVokabular.ERSATZWERT_METHODE);
        assertThat(verteilen).isEqualTo(VerbrauchRegeln.VERTEILEN);
        assertThat(uebernehmen).isEqualTo(VerbrauchRegeln.UEBERNEHMEN);
    }

    @Test
    void f11UndF21UndJedeMethodeUndAblehnungSindVertreten() throws Exception {
        Set<String> faelle = new LinkedHashSet<>();
        Set<String> methoden = new LinkedHashSet<>();
        Set<String> gruende = new LinkedHashSet<>();
        for (JsonNode e : lies(VECTORS).path("ersatzwerte")) {
            faelle.add(e.path("fall").asText());
            if (e.path("abgelehnt").isEmpty()) {
                e.path("ersatzwerte").forEach(ew -> methoden.add(ew.path("methode").asText()));
            }
            e.path("abgelehnt").forEach(g -> gruende.add(g.asText()));
        }
        assertThat(faelle).contains(F11, F21);
        assertThat(methoden).containsExactlyInAnyOrderElementsOf(ErgebnisZustand.ERSATZWERT_METHODE_NAME.keySet());
        assertThat(gruende).containsExactlyInAnyOrderElementsOf(VerbrauchRegeln.ERSATZWERT_ABLEHNUNGEN);
    }

    @TestFactory
    List<DynamicTest> ersatzwertVektoren() throws Exception {
        JsonNode datei = lies(VECTORS);
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode eintrag : datei.path("ersatzwerte")) {
            JsonNode reihe = reiheDesFalls(datei, eintrag.path("fall").asText());
            for (JsonNode erwartung : eintrag.path("expected")) {
                String name = eintrag.path("name").asText() + " :: " + erwartung.path("name").asText();
                tests.add(DynamicTest.dynamicTest(name, () -> pruefe(reihe, eintrag, erwartung)));
            }
        }
        assertThat(tests).as("Erwartungen mit Ersatzwerten").hasSizeGreaterThanOrEqualTo(20);
        return tests;
    }

    private static void pruefe(JsonNode reihe, JsonNode eintrag, JsonNode erwartung) {
        String why = eintrag.path("why").asText();
        Version ist = version(reihe, eintrag, erwartung, ersatzwerte(reihe, eintrag, null));
        Ergebnis e = ist.ergebnis();
        zahl(why + " · menge", erwartung.path("menge"), e.menge());
        assertThat(e.zustand()).as(why + " · zustand").isEqualTo(erwartung.path("zustand").asText());
        assertThat(e.erhalten()).as(why + " · erhalten").isEqualTo(erwartung.path("erhalten").asInt());
        assertThat(e.erwartet()).as(why + " · erwartet").isEqualTo(erwartung.path("erwartet").asInt());
        JsonNode abdeckung = erwartung.path("abdeckung_prozent");
        assertThat(e.abdeckungProzent()).as(why + " · abdeckung").isEqualTo(abdeckung.isNull() ? null : abdeckung.asInt());
        List<String> kennzeichen = new ArrayList<>();
        erwartung.path("kennzeichen").forEach(k -> kennzeichen.add(k.asText()));
        assertThat(e.kennzeichen()).as(why + " · kennzeichen").isEqualTo(kennzeichen);
        Map<String, String> abgelehnt = new LinkedHashMap<>();
        eintrag.path("abgelehnt").fields().forEachRemaining(p -> abgelehnt.put(p.getKey(), p.getValue().asText()));
        assertThat(ist.abgelehnt()).as(why + " · abgelehnt").isEqualTo(abgelehnt);
    }

    @TestFactory
    List<DynamicTest> dieVerteilungDerDatei() throws Exception {
        JsonNode datei = lies(VECTORS);
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode eintrag : datei.path("ersatzwerte")) {
            JsonNode reihe = reiheDesFalls(datei, eintrag.path("fall").asText());
            for (JsonNode soll : eintrag.path("verteilung")) {
                tests.add(DynamicTest.dynamicTest(eintrag.path("name").asText(), () -> {
                    Ersatzwert ew = ersatzwerte(reihe, eintrag, soll.path("kennung").asText()).get(0);
                    List<Anteil> anteile = VerbrauchRegeln.ersatzwertAnteile(ew, reihe.path("wertart").asText(),
                            reihe.path("einheit").asText());
                    assertThat(anteile).hasSize(soll.path("anzahl").asInt());
                    BigDecimal summe = anteile.stream().map(Anteil::menge).reduce(BigDecimal.ZERO, BigDecimal::add);
                    // Die Invariante: EXAKT der gemessene Zuwachs, keine Toleranz.
                    assertThat(summe).usingComparator(BigDecimal::compareTo).isEqualTo(ew.luecke().zuwachs());
                    zahl("summe", soll.path("summe"), summe);
                    zahl("erster", soll.path("erster"), anteile.get(0).menge());
                    zahl("letzter", soll.path("letzter"), anteile.get(anteile.size() - 1).menge());
                    ZoneId zone = ZoneId.of(reihe.path("zeitzone").asText());
                    Map<String, BigDecimal> jeTag = new LinkedHashMap<>();
                    for (Anteil a : anteile) {
                        jeTag.merge(a.beginn().atZone(zone).toLocalDate().toString(), a.menge(), BigDecimal::add);
                    }
                    assertThat(jeTag.keySet()).containsExactlyElementsOf(iterable(soll.path("je_tag").fieldNames()));
                    jeTag.forEach((tag, menge) -> zahl("je_tag " + tag, soll.path("je_tag").path(tag), menge));
                }));
            }
        }
        assertThat(tests).as("Verteilungen").hasSizeGreaterThanOrEqualTo(3);
        return tests;
    }

    /** F21: nur zurückgenommene Ersatzwerte → jede Periode ist Zeichen für Zeichen Version 1. */
    @Test
    void einZurueckgenommenerErsatzwertHinterlaesstKeineSpurInDenZahlen() throws Exception {
        JsonNode datei = lies(VECTORS);
        int geprueft = 0;
        for (JsonNode eintrag : datei.path("ersatzwerte")) {
            Set<String> status = new LinkedHashSet<>();
            eintrag.path("status").forEach(s -> status.add(s.asText()));
            if (!status.equals(Set.of("zurueckgenommen"))) {
                continue;
            }
            JsonNode reihe = reiheDesFalls(datei, eintrag.path("fall").asText());
            for (JsonNode erwartung : eintrag.path("expected")) {
                Version mit = version(reihe, eintrag, erwartung, ersatzwerte(reihe, eintrag, null));
                Version ohne = version(reihe, eintrag, erwartung, List.of());
                assertThat(mit).isEqualTo(ohne);
                geprueft++;
            }
        }
        assertThat(geprueft).isGreaterThanOrEqualTo(3);
    }

    /** F21: Version 3 mit Methode c ist dieselbe Zahl, ob Version 2 (Methode a) je bestand oder nicht. */
    @Test
    void dieBessereMethodeRechnetVomBestandAus() throws Exception {
        JsonNode datei = lies(VECTORS);
        JsonNode reihe = reiheDesFalls(datei, F21);
        int geprueft = 0;
        for (JsonNode eintrag : datei.path("ersatzwerte")) {
            if (!"zurueckgenommen".equals(eintrag.path("status").path("EW-2026-0003").asText())
                    || !"wirksam".equals(eintrag.path("status").path("EW-2026-0005").asText())) {
                continue;
            }
            for (JsonNode erwartung : eintrag.path("expected")) {
                Version mitWiderruf = version(reihe, eintrag, erwartung, ersatzwerte(reihe, eintrag, null));
                Version nurC = version(reihe, eintrag, erwartung, ersatzwerte(reihe, eintrag, "EW-2026-0005"));
                assertThat(mitWiderruf).isEqualTo(nurC);
                geprueft++;
            }
        }
        assertThat(geprueft).isGreaterThanOrEqualTo(3);
    }

    // ------------------------------------------------------------------------------ Lesen der Datei

    private static Version version(JsonNode reihe, JsonNode eintrag, JsonNode erwartung, List<Ersatzwert> ersatzwerte) {
        return VerbrauchRegeln.version(kontext(reihe), reihe.path("wertart").asText(), rohwerte(reihe),
                VerbrauchRegeln.zeit(erwartung.path("von").asText()), VerbrauchRegeln.zeit(erwartung.path("bis").asText()),
                Duration.ofSeconds(reihe.path("kadenz_s").asLong()), ereignisse(reihe.path("ereignisse")),
                dezimal(reihe.path("faktor"), BigDecimal.ONE), dezimal(reihe.path("wertebereich_modul"), null),
                dezimal(reihe.path("hoechstzuwachs_je_kadenz"), null), reihe.path("integrieren").asBoolean(false),
                ersatzwerte);
    }

    private static JsonNode reiheDesFalls(JsonNode datei, String fall) {
        for (JsonNode c : datei.path("cases")) {
            if (c.path("name").asText().equals(fall)) {
                return c.path("input").path("reihe");
            }
        }
        throw new AssertionError("kein Fall " + fall);
    }

    /**
     * Die Ersatzwerte eines Eintrags mit ihrem Status ({@code nur} = nur diese Kennung). Die Lücke kommt aus den
     * Rohwerten: der Wert vor der ersten fehlenden Messzeit und sein direkter Nachfolger an der Messzeit danach.
     */
    private static List<Ersatzwert> ersatzwerte(JsonNode reihe, JsonNode eintrag, String nur) {
        Duration kadenz = Duration.ofSeconds(reihe.path("kadenz_s").asLong());
        List<Rohwert> gut = rohwerte(reihe).stream().filter(Rohwert::gut).toList();
        List<Ersatzwert> out = new ArrayList<>();
        for (JsonNode e : eintrag.path("ersatzwerte")) {
            String kennung = e.path("kennung").asText();
            if (nur != null && !nur.equals(kennung)) {
                continue;
            }
            LueckenZuwachs luecke = null;
            Instant lueckeVon = null;
            if (e.has("luecke")) {
                lueckeVon = VerbrauchRegeln.zeit(e.path("luecke").path("von").asText());
                Instant nach = VerbrauchRegeln.zeit(e.path("luecke").path("bis").asText());
                Rohwert vorher = null;
                Rohwert nachher = null;
                for (Rohwert w : gut) {
                    if (w.zeit().isBefore(lueckeVon)) {
                        vorher = w;
                    } else if (vorher != null && nachher == null) {
                        nachher = w;
                    }
                }
                if (vorher != null && nachher != null && nachher.zeit().equals(nach)
                        && vorher.zeit().plus(kadenz).equals(lueckeVon)) {
                    luecke = VerbrauchRegeln.lueckenZuwachs(vorher, nachher, ereignisse(reihe.path("ereignisse")),
                            kadenz, dezimal(reihe.path("faktor"), BigDecimal.ONE));
                }
            }
            List<Profilwert> profil = null;
            if (e.has("profil")) {
                profil = new ArrayList<>();
                for (JsonNode a : e.path("profil")) {
                    int n = VerbrauchRegeln.viertelstunden(VerbrauchRegeln.zeit(a.path("von").asText()),
                            VerbrauchRegeln.zeit(a.path("bis").asText())).size();
                    for (int i = 0; i < n; i++) {
                        profil.add(a.path("fehlt").asBoolean(false) ? null
                                : new Profilwert(dezimal(a.path("je_viertelstunde"), null), VerbrauchRegeln.VOLLSTAENDIG));
                    }
                }
            }
            out.add(new Ersatzwert(kennung, e.path("methode").asText(),
                    VerbrauchRegeln.zeit(e.path("von").asText()), VerbrauchRegeln.zeit(e.path("bis").asText()),
                    eintrag.path("status").path(kennung).asText(), luecke, lueckeVon, profil,
                    text(e, "profil_einheit"), dezimal(e.path("betrag"), null), text(e, "einheit"),
                    e.has("zeitpunkt") ? VerbrauchRegeln.zeit(e.path("zeitpunkt").asText()) : null,
                    dezimal(e.path("endstand"), null), dezimal(e.path("anfangsstand"), null)));
        }
        return out;
    }

    private static String text(JsonNode n, String feld) {
        return n.hasNonNull(feld) ? n.path(feld).asText() : null;
    }

    private static <T> List<T> iterable(java.util.Iterator<T> it) {
        List<T> out = new ArrayList<>();
        it.forEachRemaining(out::add);
        return out;
    }
}
