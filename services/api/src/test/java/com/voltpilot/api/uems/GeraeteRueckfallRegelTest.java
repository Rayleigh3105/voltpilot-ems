package com.voltpilot.api.uems;

import static com.voltpilot.api.uems.BilanzVectorsTest.bd;
import static com.voltpilot.api.uems.BilanzVectorsTest.lies;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.uems.GeraeteRueckfallRegel.Angabe;
import com.voltpilot.api.uems.GeraeteRueckfallRegel.Herkunft;
import com.voltpilot.api.uems.GeraeteRueckfallRegel.Rueckfall;
import com.voltpilot.api.uems.SteuerungsverbundAnteile.Auslegung;
import com.voltpilot.api.uems.SteuerungsverbundAnteile.Mitglied;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.AuslegungUrteil;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.GeraeteRueckfall;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Rolle;
import java.math.BigDecimal;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

/**
 * Der Geräte-Rückfall je Komponente (UEMS AP-15 IP-6, G3, E2 = A): die Regel allein, der Katalog-Eintrag je Familie
 * und die Auslegung von Ahrenberg R1 — die Rückfälle je Komponente aus {@code uems-referenzunternehmen.json} 1.5
 * ({@code geraete_rueckfaelle}), über die Regel je Box summiert und durch {@link SteuerungsverbundAnteile#anteile}
 * gerechnet, ergeben genau die Auslegung von V-1. Rein, kein Docker.
 */
class GeraeteRueckfallRegelTest {

    private static final Path REFERENZ = Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");
    private static final MeasurementCatalog KATALOG = new MeasurementCatalog(new ObjectMapper());

    /** Die Boxen von V-1 und was sie steuern ({@code boxen[].steuert}, Freitext — der Test prüft die Kennzeichen). */
    private static final Map<String, List<String>> STEUERT = Map.of(
            "E-1", List.of("K-1", "K-2"),
            "E-4", List.of("K-12", "K-13.1", "K-13.2", "K-13.3", "K-13.4", "K-13.5", "K-13.6"));

    // ================================================================ die Regel

    @Test
    void ohneJedeAngabeZaehltDieNennleistung() {
        Rueckfall r = GeraeteRueckfallRegel.rueckfall(Grenzart.EINSPEISUNG, null, null, kw("60"));
        assertThat(r.rueckfall()).isEqualTo(GeraeteRueckfall.UNBEKANNT);
        assertThat(r.kw()).isEqualByComparingTo("60");
        assertThat(r.herkunft()).isEqualTo(Herkunft.OHNE_ANGABE);
    }

    @Test
    void nurFaelltAufWertMitZahlZaehltWenigerAlsDieNennleistung() {
        assertThat(amGeraet(GeraeteRueckfall.FAELLT_AUF_WERT, "40", 60, "100").kw()).isEqualByComparingTo("40");
        assertThat(amGeraet(GeraeteRueckfall.LAEUFT_FREI, null, null, "60").kw()).isEqualByComparingTo("60");
        assertThat(amGeraet(GeraeteRueckfall.UNBEKANNT, null, null, "60").kw()).isEqualByComparingTo("60");
        // der letzte Wert kann alles bis zur Nennleistung gewesen sein (R4: K-1 hält 83 kW)
        assertThat(amGeraet(GeraeteRueckfall.HAELT_LETZTEN_WERT, null, 60, "100").kw()).isEqualByComparingTo("100");
        // mehr, als das Gerät kann, zählt nicht
        assertThat(amGeraet(GeraeteRueckfall.FAELLT_AUF_WERT, "130", 60, "100").kw()).isEqualByComparingTo("100");
        assertThat(amGeraet(GeraeteRueckfall.FAELLT_AUF_WERT, "0", 60, "100").kw()).isEqualByComparingTo("0");
    }

    @Test
    void derAmGeraetHinterlegteWertGehtDemKatalogVor() {
        Angabe katalog = new Angabe(GeraeteRueckfall.LAEUFT_FREI, null, null);
        Angabe geraet = new Angabe(GeraeteRueckfall.FAELLT_AUF_WERT, kw("4.1"), 60);
        Rueckfall r = GeraeteRueckfallRegel.rueckfall(Grenzart.BEZUG, geraet, katalog, kw("22"));
        assertThat(r.kw()).isEqualByComparingTo("4.1");
        assertThat(r.herkunft()).isEqualTo(Herkunft.AM_GERAET);
        assertThat(r.nachS()).isEqualTo(60);
        Rueckfall k = GeraeteRueckfallRegel.rueckfall(Grenzart.BEZUG, null, katalog, kw("22"));
        assertThat(k.herkunft()).isEqualTo(Herkunft.KATALOG);
        assertThat(k.kw()).isEqualByComparingTo("22");
        // „fällt auf einen am Gerät einstellbaren Wert“ ohne Zahl: der Wert ist nicht bekannt
        Rueckfall ohneZahl = GeraeteRueckfallRegel.rueckfall(Grenzart.BEZUG, null,
                new Angabe(GeraeteRueckfall.FAELLT_AUF_WERT, null, null), kw("22"));
        assertThat(ohneZahl.kw()).isEqualByComparingTo("22");
    }

    @Test
    void eingabefehlerSindKeinUrteil() {
        assertThatThrownBy(() -> new Angabe(GeraeteRueckfall.LAEUFT_FREI, kw("10"), null))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Angabe(GeraeteRueckfall.FAELLT_AUF_WERT, kw("-1"), null))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> GeraeteRueckfallRegel.rueckfall(Grenzart.NETZBETREIBER_VORGABE, null, null, kw("1")))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> GeraeteRueckfallRegel.rueckfall(Grenzart.BEZUG, null, null, null))
                .isInstanceOf(IllegalArgumentException.class);
    }

    // ================================================================ der Katalog

    @Test
    void derKatalogKenntNurSteuerbareFamilienUndSagtHeuteUeberallUnbekannt() {
        assertThat(KATALOG.steuerbareFamilien()).containsExactlyInAnyOrder("goe.api_v2", "hybrid_1p", "hybrid_3p",
                "kostal_plenticore", "ocpp.1_6", "shelly.gen1", "shelly.gen2plus", "sunspec.model_123",
                "sunspec.model_124");
        assertThat(KATALOG.rueckfallOhneBox("ocpp.1_6", "bezug").rueckfall()).isEqualTo("unbekannt");
        assertThat(KATALOG.rueckfallOhneBox("ocpp.1_6", "einspeisung")).as("keine Angabe").isNull();
        assertThat(KATALOG.rueckfallOhneBox("fronius_solar_api", "einspeisung")).as("nicht gesteuert").isNull();

        GeraeteRueckfallDienst dienst = new GeraeteRueckfallDienst(null, KATALOG, null);
        // Registry-Familie → Katalog-Familien: SunSpec spannt jedes Modell auf; alle sagen dasselbe
        Angabe sunspec = dienst.katalogEintrag("sunspec", Grenzart.EINSPEISUNG);
        assertThat(sunspec).isEqualTo(new Angabe(GeraeteRueckfall.UNBEKANNT, null, null));
        assertThat(dienst.katalogEintrag("ocpp16", Grenzart.BEZUG).rueckfall()).isEqualTo(GeraeteRueckfall.UNBEKANNT);
        // Bestand: eine Familie ohne Eintrag und eine Komponente ohne Familie — keine Angabe, wie heute
        assertThat(dienst.katalogEintrag("fronius_solar_api", Grenzart.EINSPEISUNG)).isNull();
        assertThat(dienst.katalogEintrag(null, Grenzart.EINSPEISUNG)).isNull();
    }

    // ================================================================ R1: die Auslegung von V-1

    @Test
    void r1DieRueckfaelleDerReferenzErgebenDieAuslegungVonV1() throws Exception {
        JsonNode ref = lies(REFERENZ);
        pruefeSteuert(ref);
        Map<String, JsonNode> amGeraet = jeKomponente(ref);
        JsonNode auslegung = ref.at("/gemeinsame_steuerungen/0/auslegung");

        Auslegung einspeisung = rechne(ref, Grenzart.EINSPEISUNG, BigDecimal.ZERO, k -> angabe(amGeraet.get(k)));
        pruefe(einspeisung, auslegung.get("einspeisung"));
        Auslegung bezug = rechne(ref, Grenzart.BEZUG, bd(auslegung.at("/bezug/vorbehalt_grundlast_kw")),
                k -> angabe(amGeraet.get(k)));
        pruefe(bezug, auslegung.get("bezug"));
        assertThat(bezug.summeRueckfallKw()).as("K-13.x je 4,1 kW").isEqualByComparingTo("24.6");
    }

    @Test
    void r1UnbekanntZaehltMitNennleistungUndAendertDieAuslegungNicht() throws Exception {
        JsonNode ref = lies(REFERENZ);
        Map<String, JsonNode> amGeraet = jeKomponente(ref);
        JsonNode auslegung = ref.at("/gemeinsame_steuerungen/0/auslegung");
        // K-12 „läuft frei“ steht in der Referenz; ohne jede Angabe (unbekannt, Katalog SunSpec 123) zählt dieselbe
        // Nennleistung 60 kW — die Auslegung bleibt 40/60
        Auslegung ohneK12 = rechne(ref, Grenzart.EINSPEISUNG, BigDecimal.ZERO,
                k -> k.equals("K-12") ? null : angabe(amGeraet.get(k)));
        pruefe(ohneK12, auslegung.get("einspeisung"));
        assertThat(ohneK12.summeRueckfallKw()).isEqualByComparingTo("100");
    }

    @Test
    void r1OhneDieVorgabewerteDerSaeulenPasstDieBezugsseiteNicht() throws Exception {
        JsonNode ref = lies(REFERENZ);
        Map<String, JsonNode> amGeraet = jeKomponente(ref);
        JsonNode auslegung = ref.at("/gemeinsame_steuerungen/0/auslegung");
        // die sechs Säulen ohne hinterlegten Vorgabewert: unbekannt → 6 × 22 = 132 kW > verteilbar 77 kW (E2 = A)
        Auslegung bezug = rechne(ref, Grenzart.BEZUG, bd(auslegung.at("/bezug/vorbehalt_grundlast_kw")),
                k -> k.startsWith("K-13.") ? null : angabe(amGeraet.get(k)));
        assertThat(bezug.urteil()).isEqualTo(AuslegungUrteil.AUSLEGUNG_PASST_NICHT);
        assertThat(bezug.summeRueckfallKw()).isEqualByComparingTo("132");
        assertThat(bezug.ablehnung()).isNotNull();
    }

    // ================================================================ Hilfen

    /** Σ je Box über die Komponenten dieser Richtung: Nennleistung und Rückfall aus der Regel. */
    private static Auslegung rechne(JsonNode ref, Grenzart richtung, BigDecimal vorbehalt,
            Function<String, Angabe> amGeraet) {
        Map<String, JsonNode> geraete = jeKomponente(ref);
        List<Mitglied> mitglieder = new ArrayList<>();
        for (JsonNode m : ref.at("/gemeinsame_steuerungen/0/mitglieder")) {
            String box = m.get("box").asText();
            if (!STEUERT.containsKey(box)) {
                continue; // E-4′ ist die Nachfolgerin, nicht gleichzeitig Mitglied
            }
            BigDecimal nenn = BigDecimal.ZERO;
            BigDecimal rueckfall = BigDecimal.ZERO;
            for (String k : STEUERT.get(box)) {
                JsonNode g = geraete.get(k);
                if (!g.get("richtung").asText().equals(richtung.code())) {
                    continue;
                }
                BigDecimal n = bd(g.get("nenn_kw"));
                nenn = nenn.add(n);
                rueckfall = rueckfall.add(GeraeteRueckfallRegel.rueckfall(richtung, amGeraet.apply(k), null, n).kw());
            }
            mitglieder.add(new Mitglied(box, Rolle.valueOf(m.get("rolle").asText().toUpperCase()), nenn, rueckfall));
        }
        BigDecimal grenze = bd(ref.at("/netzanschluss_grenzen/0/"
                + (richtung == Grenzart.EINSPEISUNG ? "einspeisegrenze_kw" : "bezugsgrenze_kw")));
        return SteuerungsverbundAnteile.anteile(grenze, vorbehalt, mitglieder);
    }

    private static void pruefe(Auslegung a, JsonNode erwartet) {
        assertThat(a.urteil().code()).isEqualTo(erwartet.get("urteil").asText());
        assertThat(a.verteilbarKw()).isEqualByComparingTo(bd(erwartet.get("verteilbar_kw")));
        assertThat(a.summeRueckfallKw()).isEqualByComparingTo(bd(erwartet.get("summe_rueckfall_kw")));
        assertThat(a.ungenutztKw()).isEqualByComparingTo(bd(erwartet.get("ungenutzt_kw")));
        Map<String, BigDecimal> anteile = new LinkedHashMap<>();
        erwartet.get("anteile").fields().forEachRemaining(e -> anteile.put(e.getKey(), bd(e.getValue())));
        assertThat(a.anteile()).hasSameSizeAs(anteile);
        anteile.forEach((box, kw) -> assertThat(a.anteile().get(box)).as(box).isEqualByComparingTo(kw));
    }

    /** Die Referenz sagt im Freitext, was jede Box steuert — die Zuordnung oben muss dazu passen. */
    private static void pruefeSteuert(JsonNode ref) {
        for (JsonNode b : ref.get("boxen")) {
            List<String> komponenten = STEUERT.get(b.get("kennzeichen").asText());
            if (komponenten != null) {
                String steuert = b.get("steuert").asText();
                assertThat(steuert).contains(komponenten.get(0));
            }
        }
        assertThat(jeKomponente(ref).keySet()).containsExactlyInAnyOrderElementsOf(
                STEUERT.values().stream().flatMap(List::stream).toList());
    }

    private static Map<String, JsonNode> jeKomponente(JsonNode ref) {
        Map<String, JsonNode> m = new LinkedHashMap<>();
        ref.get("geraete_rueckfaelle").forEach(g -> m.put(g.get("komponente").asText(), g));
        return m;
    }

    /** Eine Zeile von {@code geraete_rueckfaelle} als Angabe am Gerät; `laeuft_frei` trägt keine Zahl. */
    private static Angabe angabe(JsonNode g) {
        GeraeteRueckfall wort = GeraeteRueckfall.valueOf(g.get("rueckfall").asText().toUpperCase());
        BigDecimal kw = wort == GeraeteRueckfall.FAELLT_AUF_WERT ? bd(g.get("rueckfall_kw")) : null;
        Integer nach = wort == GeraeteRueckfall.LAEUFT_FREI ? null : g.get("nach_s").asInt();
        return new Angabe(wort, kw, nach);
    }

    private static Rueckfall amGeraet(GeraeteRueckfall wort, String kw, Integer nachS, String nenn) {
        return GeraeteRueckfallRegel.rueckfall(Grenzart.EINSPEISUNG,
                new Angabe(wort, kw == null ? null : kw(kw), nachS), null, kw(nenn));
    }

    private static BigDecimal kw(String s) {
        return new BigDecimal(s);
    }
}
