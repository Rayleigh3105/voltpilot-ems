package com.voltpilot.api.uems;

import static com.voltpilot.api.uems.BilanzVectorsTest.bd;
import static com.voltpilot.api.uems.BilanzVectorsTest.lies;
import static com.voltpilot.api.uems.BilanzVectorsTest.str;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.uems.SteuerungsverbundAnteile.Auslegung;
import com.voltpilot.api.uems.SteuerungsverbundAnteile.Dokument;
import com.voltpilot.api.uems.SteuerungsverbundAnteile.Identitaet;
import com.voltpilot.api.uems.SteuerungsverbundAnteile.Mitglied;
import com.voltpilot.api.uems.SteuerungsverbundAnteile.Pruefung;
import com.voltpilot.api.uems.SteuerungsverbundAnteile.Stand;
import com.voltpilot.api.uems.SteuerungsverbundAnteile.Uebergang;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Ablehnung;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.AuslegungUrteil;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.DokumentAblehnung;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.DokumentUrteil;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.GeraeteRueckfall;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Rolle;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Stufe;
import java.math.BigDecimal;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.EnumMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

/**
 * Der Java-Zwilling der Anteile (UEMS AP-15 IP-2, NW-1) gegen {@code docs/contracts/v2/verbund-anteil-vectors.json} —
 * dieselbe Datei fährt die Python-Referenz ({@code services/optimization/tests/test_steuerungsverbund_referenz.py}).
 * Jeder Zeiger in {@code quelle} wird gegen {@code uems-referenzunternehmen.json} 1.5 geprüft. Rein, kein Docker.
 */
class SteuerungsverbundAnteilVectorsTest {

    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final Path VECTORS = V2.resolve("verbund-anteil-vectors.json");
    private static final Path REFERENZ = V2.resolve("uems-referenzunternehmen.json");

    @Test
    void vokabulareSindGeschlossenUndGleich() throws Exception {
        JsonNode v = lies(VECTORS).get("vokabulare");
        assertThat(codes(Rolle.values(), Rolle::code)).isEqualTo(texte(v.get("rolle")));
        assertThat(codes(Grenzart.values(), Grenzart::code)).isEqualTo(texte(v.get("grenzart")));
        assertThat(codes(GeraeteRueckfall.values(), GeraeteRueckfall::code)).isEqualTo(texte(v.get("geraete_rueckfall")));
        assertThat(codes(AuslegungUrteil.values(), AuslegungUrteil::code)).isEqualTo(texte(v.get("auslegung_urteil")));
        assertThat(codes(Ablehnung.values(), Ablehnung::code)).isEqualTo(texte(v.get("ablehnung")));
        assertThat(codes(DokumentUrteil.values(), DokumentUrteil::code)).isEqualTo(texte(v.get("dokument_urteil")));
        assertThat(codes(DokumentAblehnung.values(), DokumentAblehnung::code)).isEqualTo(texte(v.get("dokument_ablehnung")));
        List<String> stufen = new ArrayList<>();
        for (JsonNode s : v.get("stufe")) {
            stufen.add(str(s.get("stufe")) + "/" + s.get("code").asText());
        }
        assertThat(codes(Stufe.values(), s -> s.stufe() + "/" + s.code())).isEqualTo(stufen);

        // E1 = A: die Zuteilung auf Zeit ist nicht gebaut — kein Zwilling kennt ihr Wort
        for (JsonNode s : lies(VECTORS).at("/nicht_gebaut/stufe")) {
            assertThat(codes(Stufe.values(), Stufe::code)).doesNotContain(s.get("code").asText());
        }
        // die Wörter der Referenzwelt kommen aus dem Vokabular
        JsonNode ref = lies(REFERENZ);
        for (JsonNode g : ref.get("geraete_rueckfaelle")) {
            assertThat(codes(GeraeteRueckfall.values(), GeraeteRueckfall::code)).contains(g.get("rueckfall").asText());
        }
        for (JsonNode g : ref.get("gemeinsame_steuerungen")) {
            g.get("mitglieder").forEach(m -> assertThat(codes(Rolle.values(), Rolle::code)).contains(m.get("rolle").asText()));
            g.get("stufen").forEach(s -> assertThat(codes(Stufe.values(), Stufe::code)).contains(s.get("code").asText()));
        }
    }

    @Test
    void jederAnteilsfallGiltImJavaZwilling() throws Exception {
        JsonNode faelle = lies(VECTORS).get("anteile");
        assertThat(faelle.size()).isGreaterThanOrEqualTo(15);
        for (JsonNode f : faelle) {
            String fall = f.get("name").asText();
            assertThat(Grenzart.valueOf(f.get("richtung").asText().toUpperCase())).as(fall).isIn(SteuerungsverbundAnteile.RICHTUNGEN);
            pruefeQuelle(f);
            JsonNode e = f.get("erwartet");
            if (e.path("fehler").asBoolean(false)) {
                assertThatThrownBy(() -> rechne(f)).as(fall).isInstanceOf(IllegalArgumentException.class);
                continue;
            }
            Auslegung a = rechne(f);
            assertThat(a.urteil().code()).as(fall + " / Urteil").isEqualTo(e.get("urteil").asText());
            assertThat(a.ablehnung() == null ? null : a.ablehnung().code()).as(fall + " / Ablehnung").isEqualTo(str(e.get("ablehnung")));
            assertGleich(fall + " / verteilbar", a.verteilbarKw(), bd(e.get("verteilbar_kw")));
            assertGleich(fall + " / Summe Rückfall", a.summeRueckfallKw(), bd(e.get("summe_rueckfall_kw")));
            assertGleich(fall + " / ungenutzt", a.ungenutztKw(), bd(e.get("ungenutzt_kw")));
            assertTabelle(fall + " / Anteile", a.anteile(), e.get("anteile"));
            // die Summe der Anteile überschreitet nie das Verteilbare (G2)
            if (!a.anteile().isEmpty()) {
                assertThat(summe(a.anteile())).as(fall + " / Summe ≤ verteilbar").isLessThanOrEqualTo(a.verteilbarKw());
            }
        }
    }

    @Test
    void abrundenNieAufrundenIstEinEigenerVektor() throws Exception {
        JsonNode f = null;
        for (JsonNode x : lies(VECTORS).get("anteile")) {
            if (x.get("name").asText().startsWith("Abrunden, nie Aufrunden")) {
                f = x;
            }
        }
        assertThat(f).isNotNull();
        Auslegung a = rechne(f);
        BigDecimal aufgerundet = summe(tabelle(f.at("/aufgerundet_waere/anteile")));
        assertGleich("aufgerundet", aufgerundet, bd(f.at("/aufgerundet_waere/summe_kw")));
        assertThat(aufgerundet).isGreaterThan(a.verteilbarKw());
        assertThat(summe(a.anteile())).isLessThanOrEqualTo(a.verteilbarKw());
        assertThat(a.ungenutztKw()).isPositive();
    }

    @Test
    void jederUebergangsstandGiltImJavaZwilling() throws Exception {
        JsonNode faelle = lies(VECTORS).get("uebergangsstand");
        assertThat(faelle.size()).isGreaterThanOrEqualTo(5);
        for (JsonNode f : faelle) {
            String fall = f.get("name").asText();
            pruefeQuelle(f);
            Map<String, BigDecimal> alt = tabelle(f.at("/alt/anteile"));
            Map<String, BigDecimal> neu = tabelle(f.at("/neu/anteile"));
            Uebergang u = SteuerungsverbundAnteile.uebergangsstand(alt, neu);
            JsonNode e = f.get("erwartet");
            assertTabelle(fall + " / Übergang", u.uebergang(), e.get("uebergang"));
            assertThat(u.verengteBoxen()).as(fall + " / verengt").isEqualTo(texte(e.get("verengte_boxen")));
            assertThat(u.zweiterSchritt()).as(fall + " / zweiter Schritt").isEqualTo(e.get("zweiter_schritt").asBoolean());
            assertGleich(fall + " / Summe alt", summe(alt), bd(e.get("summe_alt_kw")));
            assertGleich(fall + " / Summe neu", summe(neu), bd(e.get("summe_neu_kw")));
            assertGleich(fall + " / Summe Übergang", summe(u.uebergang()), bd(e.get("summe_uebergang_kw")));
            BigDecimal vAlt = bd(f.at("/alt/verteilbar_kw"));
            BigDecimal vNeu = bd(f.at("/neu/verteilbar_kw"));
            assertThat(summe(alt)).as(fall).isLessThanOrEqualTo(vAlt);
            assertThat(summe(neu)).as(fall).isLessThanOrEqualTo(vNeu);
            // der Übergang passt unter BEIDE Stände
            assertThat(summe(u.uebergang())).as(fall + " / Übergang ≤ verteilbar").isLessThanOrEqualTo(vAlt.min(vNeu));
        }
    }

    @Test
    void jedeDokumentPruefungGiltImJavaZwilling() throws Exception {
        JsonNode faelle = lies(VECTORS).get("dokument_pruefen");
        assertThat(faelle.size()).isGreaterThanOrEqualTo(15);
        for (JsonNode f : faelle) {
            String fall = f.get("name").asText();
            JsonNode i = f.get("identitaet");
            JsonNode s = f.get("stand");
            JsonNode d = f.get("dokument");
            Map<Grenzart, BigDecimal> verteilbar = new EnumMap<>(Grenzart.class);
            Map<Grenzart, Map<String, BigDecimal>> anteile = new EnumMap<>(Grenzart.class);
            for (Grenzart r : SteuerungsverbundAnteile.RICHTUNGEN) {
                verteilbar.put(r, bd(d.at("/verteilbar/" + r.code() + "_kw")));
                if (d.at("/anteile/" + r.code()).isObject()) {
                    anteile.put(r, tabelle(d.at("/anteile/" + r.code())));
                }
            }
            Pruefung p = SteuerungsverbundAnteile.dokumentPruefen(
                    new Identitaet(i.get("mandant").asText(), i.get("anlage").asText(), i.get("box").asText()),
                    s.isNull() ? null : new Stand(s.get("epoche").asLong(), s.get("revision").asLong()),
                    new Dokument(d.get("mandant").asText(), d.get("anlage").asText(), d.get("epoche").asLong(),
                            d.get("revision").asLong(), verteilbar, anteile));
            assertThat(p.urteil().code()).as(fall + " / Urteil").isEqualTo(f.at("/erwartet/urteil").asText());
            assertThat(p.grund() == null ? null : p.grund().code()).as(fall + " / Grund").isEqualTo(str(f.at("/erwartet/grund")));
        }
    }

    // ------------------------------------------------------------------------------------------------------------

    private static Auslegung rechne(JsonNode f) {
        List<Mitglied> mitglieder = new ArrayList<>();
        for (JsonNode m : f.get("mitglieder")) {
            mitglieder.add(new Mitglied(m.get("box").asText(), Rolle.valueOf(m.get("rolle").asText().toUpperCase()),
                    bd(m.get("nenn_kw")), bd(m.get("rueckfall_kw"))));
        }
        return SteuerungsverbundAnteile.anteile(bd(f.get("grenze_kw")), bd(f.get("vorbehalt_kw")), mitglieder);
    }

    /** Jede Zahl mit Zeiger steht so in der Referenzdatei 1.5 — nichts ist abgetippt. */
    private static void pruefeQuelle(JsonNode f) throws Exception {
        JsonNode quelle = f.get("quelle");
        if (quelle == null) {
            return;
        }
        JsonNode ref = lies(REFERENZ);
        String fall = f.get("name").asText();
        for (var eintrag : quelle.properties()) {
            String pfad = eintrag.getKey();
            String zeiger = eintrag.getValue().asText();
            if (pfad.equals("geraete_rueckfaelle")) {
                for (String feld : List.of("nenn_kw", "rueckfall_kw")) {
                    BigDecimal ausReferenz = BigDecimal.ZERO;
                    for (JsonNode g : ref.get("geraete_rueckfaelle")) {
                        if (g.get("richtung").asText().equals(zeiger)) {
                            ausReferenz = ausReferenz.add(bd(g.get(feld)));
                        }
                    }
                    BigDecimal imVektor = BigDecimal.ZERO;
                    for (JsonNode m : f.get("mitglieder")) {
                        imVektor = imVektor.add(bd(m.get(feld)));
                    }
                    assertGleich(fall + " / Σ " + feld + " aus Geräte-Rückfällen", imVektor, ausReferenz);
                }
                continue;
            }
            JsonNode wert = f.at("/" + pfad.replace('.', '/'));
            JsonNode ziel = ref.at(zeiger);
            assertThat(ziel.isMissingNode()).as(fall + " / Zeiger " + zeiger).isFalse();
            if (pfad.equals("erwartet")) { // das ganze Urteil: jeder Schlüssel des Vektors (außer ablehnung) gleich in der Referenz
                for (var feld : wert.properties()) {
                    if (!feld.getKey().equals("ablehnung")) {
                        assertThat(gleich(feld.getValue(), ziel.path(feld.getKey()))).as(fall + " / " + feld.getKey()).isTrue();
                    }
                }
            } else {
                assertThat(gleich(wert, ziel)).as(fall + " / " + pfad + " = " + zeiger).isTrue();
            }
        }
    }

    private static boolean gleich(JsonNode a, JsonNode b) {
        if (a.isObject() && b.isObject()) {
            Set<String> ka = new HashSet<>();
            a.fieldNames().forEachRemaining(ka::add);
            Set<String> kb = new HashSet<>();
            b.fieldNames().forEachRemaining(kb::add);
            return ka.equals(kb) && ka.stream().allMatch(k -> gleich(a.get(k), b.get(k)));
        }
        if (a.isNumber() && b.isNumber()) {
            return bd(a).compareTo(bd(b)) == 0;
        }
        return a.equals(b);
    }

    private static Map<String, BigDecimal> tabelle(JsonNode n) {
        Map<String, BigDecimal> t = new LinkedHashMap<>();
        n.properties().forEach(x -> t.put(x.getKey(), bd(x.getValue())));
        return t;
    }

    private static void assertTabelle(String fall, Map<String, BigDecimal> ist, JsonNode soll) {
        assertThat(ist.keySet()).as(fall + " / Boxen").isEqualTo(tabelle(soll).keySet());
        tabelle(soll).forEach((b, kw) -> assertGleich(fall + " / " + b, ist.get(b), kw));
    }

    private static BigDecimal summe(Map<String, BigDecimal> t) {
        return t.values().stream().reduce(BigDecimal.ZERO, BigDecimal::add);
    }

    private static void assertGleich(String fall, BigDecimal ist, BigDecimal soll) {
        if (soll == null) {
            assertThat(ist).as(fall).isNull();
        } else {
            assertThat(ist).as(fall).isNotNull();
            assertThat(ist.compareTo(soll)).as(fall + ": " + ist + " ≠ " + soll).isZero();
        }
    }

    private static List<String> texte(JsonNode n) {
        List<String> l = new ArrayList<>();
        n.forEach(x -> l.add(x.asText()));
        return l;
    }

    private static <E> List<String> codes(E[] werte, Function<E, String> code) {
        return Arrays.stream(werte).map(code).toList();
    }
}
