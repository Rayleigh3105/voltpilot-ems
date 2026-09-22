package com.voltpilot.api.uems;

import static com.voltpilot.api.uems.BilanzVectorsTest.bd;
import static com.voltpilot.api.uems.BilanzVectorsTest.lies;
import static com.voltpilot.api.uems.BilanzVectorsTest.str;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.uems.SteuerungsverbundRegeln.Befund;
import com.voltpilot.api.uems.SteuerungsverbundRegeln.Datenquelle;
import com.voltpilot.api.uems.SteuerungsverbundRegeln.Leistung;
import com.voltpilot.api.uems.SteuerungsverbundRegeln.Mitglied;
import com.voltpilot.api.uems.SteuerungsverbundRegeln.Richtung;
import com.voltpilot.api.uems.SteuerungsverbundRegeln.Urteil;
import com.voltpilot.api.uems.SteuerungsverbundRegeln.Verbund;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Ablehnung;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Rolle;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Stufe;
import java.nio.file.Path;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Die Regeln des Verbund-Objekts (UEMS AP-15 IP-4) gegen {@code docs/contracts/v2/steuerungsverbund-objekt-vectors.json}.
 * Jede Kennung der Referenzwelt, die ein Vektor nennt, muss dort so stehen (Heimat der Box, Anlage der Datenquelle,
 * Mitglieder von V-1 am Stichtag) — ändert eine spätere Fassung der Referenzdatei sie, wird dieser Test rot.
 */
class SteuerungsverbundRegelnVectorsTest {

    private static final Path VECTORS = Path.of("../../docs/contracts/v2/steuerungsverbund-objekt-vectors.json");
    private static final Path REFERENZ = Path.of("../../docs/contracts/v2/uems-referenzunternehmen.json");

    @Test
    void verbundPruefen() throws Exception {
        JsonNode faelle = lies(VECTORS).get("verbund_pruefen");
        assertThat(faelle.size()).isGreaterThanOrEqualTo(18);
        for (JsonNode f : faelle) {
            String fall = f.get("name").asText();
            Verbund v = verbund(f.get("verbund"));
            List<Datenquelle> q = quellen(f.get("quellen"));
            Map<Grenzart, Richtung> a = auslegung(f.get("auslegung"));
            if (f.path("fehler").asBoolean(false)) {
                assertThatThrownBy(() -> SteuerungsverbundRegeln.pruefen(v, q, a)).as(fall)
                        .isInstanceOf(IllegalArgumentException.class);
                continue;
            }
            Urteil u = SteuerungsverbundRegeln.pruefen(v, q, a);
            List<Map<String, String>> erwartet = new ArrayList<>();
            for (JsonNode b : f.get("erwartet").get("befunde")) {
                Map<String, String> m = new LinkedHashMap<>();
                m.put("ablehnung", b.get("ablehnung").asText());
                m.put("box", str(b.get("box")));
                m.put("richtung", str(b.get("richtung")));
                erwartet.add(m);
            }
            assertThat(befunde(u)).as(fall).isEqualTo(erwartet);
            assertThat(u.zulaessig()).as(fall).isEqualTo(erwartet.isEmpty());
            assertThat(u.ablehnung() == null ? null : u.ablehnung().code()).as(fall)
                    .isEqualTo(erwartet.isEmpty() ? null : erwartet.get(0).get("ablehnung"));
        }
    }

    @Test
    void lesenMachtKeinMitglied() throws Exception {
        for (JsonNode f : lies(VECTORS).get("mitglied")) {
            Verbund v = verbund(f.get("verbund"));
            f.get("erwartet").fields().forEachRemaining(e -> assertThat(SteuerungsverbundRegeln.istMitglied(v, e.getKey()))
                    .as(f.get("name").asText() + " / " + e.getKey()).isEqualTo(e.getValue().asBoolean()));
        }
    }

    /**
     * T6 Rückrichtung (IP-8, R21 Schritt 3): Netzzähler, Messpunkt und Steuerquelle eines Mitglieds wechseln in einer
     * scharfen Gemeinsamen Steuerung nur als Änderung; jede andere Quelle, jede Stufe davor und jede Anlage ohne
     * Gemeinsame Steuerung bleiben beim Zuständigkeitswechsel. Heimat, Anlage und Steuerquelle stehen so in der
     * Referenzdatei 1.5.
     */
    @Test
    void zustaendigkeitWechseltInScharferSteuerungNurAlsAenderung() throws Exception {
        JsonNode ref = lies(REFERENZ);
        Map<String, String> heimat = new HashMap<>();
        ref.get("boxen").forEach(b -> heimat.put(b.get("kennzeichen").asText(), b.get("heimat_anlage").asText()));
        Map<String, JsonNode> quelleDerReferenz = new HashMap<>();
        ref.get("datenquellen").forEach(q -> quelleDerReferenz.put(q.get("kennzeichen").asText(), q));

        List<Boolean> gesehen = new ArrayList<>();
        for (JsonNode f : lies(VECTORS).get("zustaendigkeitswechsel")) {
            String fall = f.get("name").asText();
            Verbund v = f.get("verbund").isNull() ? null : verbund(f.get("verbund"));
            JsonNode dq = f.get("datenquelle");
            JsonNode inReferenz = quelleDerReferenz.get(dq.get("kennung").asText());
            assertThat(dq.get("anlage").asText()).as(fall).isEqualTo(inReferenz.get("anlage").asText());
            assertThat(dq.get("steuerquelle").asBoolean()).as(fall).isEqualTo(inReferenz.get("steuerquelle").asBoolean());
            assertThat(heimat).as(fall).containsKey(dq.get("gelesen_von").asText());
            if (v != null) {
                v.mitglieder().forEach(m -> assertThat(m.heimat()).as(fall).isEqualTo(heimat.get(m.box())));
            }
            boolean erwartet = f.get("erwartet").get("nur_als_aenderung").asBoolean();
            assertThat(SteuerungsverbundRegeln.wechseltNurAlsAenderung(stufe(str(f.get("stufe"))), v,
                    new Datenquelle(dq.get("kennung").asText(), dq.get("anlage").asText(),
                            dq.get("gelesen_von").asText()),
                    dq.get("steuerquelle").asBoolean())).as(fall).isEqualTo(erwartet);
            gesehen.add(erwartet);
        }
        assertThat(gesehen).as("beide Urteile belegt").contains(true, false);
    }

    /** Die Urteile sind Wörter des IP-2-Vokabulars; kein Vektor nennt ein Wort, das es dort nicht gibt. */
    @Test
    void urteileKommenAusDemAblehnungsVokabular() throws Exception {
        List<String> woerter = new ArrayList<>();
        lies(Path.of("../../docs/contracts/v2/verbund-anteil-vectors.json")).get("vokabulare").get("ablehnung")
                .forEach(w -> woerter.add(w.asText()));
        List<String> genutzt = new ArrayList<>();
        for (JsonNode f : lies(VECTORS).get("verbund_pruefen")) {
            f.path("erwartet").path("befunde").forEach(b -> genutzt.add(b.get("ablehnung").asText()));
        }
        assertThat(woerter).containsAll(genutzt);
        assertThat(genutzt).contains(Ablehnung.BOX_NICHT_IN_ANLAGE.code(), Ablehnung.KEIN_NETZANSCHLUSS.code(),
                Ablehnung.AUSLEGUNG_PASST_NICHT.code(), Ablehnung.FUEHRENDE_BOX_MISST_NICHT.code(),
                Ablehnung.MITSTEUERNDE_BOX_MISST_NICHT.code());
    }

    /** Heimat, Anlage der Datenquellen und die Mitglieder von V-1 am Stichtag stehen so in der Referenzdatei 1.5. */
    @Test
    void kennungenStehenSoInDerReferenzwelt() throws Exception {
        JsonNode ref = lies(REFERENZ);
        // 1.6 (AP-16 IP-1, PR 1082) ergänzt nur die energetische Bewertung; V-1 und seine Kennungen stehen wie in 1.5
        assertThat(ref.get("version").asText()).isIn("1.5", "1.6");
        Map<String, String> heimat = new HashMap<>();
        ref.get("boxen").forEach(b -> heimat.put(b.get("kennzeichen").asText(), b.get("heimat_anlage").asText()));
        Map<String, String> anlageDerQuelle = new HashMap<>();
        ref.get("datenquellen").forEach(q -> anlageDerQuelle.put(q.get("kennzeichen").asText(), q.get("anlage").asText()));

        List<JsonNode> alle = new ArrayList<>();
        lies(VECTORS).get("verbund_pruefen").forEach(alle::add);
        lies(VECTORS).get("mitglied").forEach(alle::add);
        for (JsonNode f : alle) {
            String fall = f.get("name").asText();
            for (JsonNode m : f.get("verbund").get("mitglieder")) {
                if (heimat.containsKey(m.get("box").asText())) {
                    assertThat(m.get("heimat").asText()).as(fall + " / " + m.get("box")).isEqualTo(heimat.get(m.get("box").asText()));
                }
            }
            for (JsonNode q : f.get("quellen")) {
                if (anlageDerQuelle.containsKey(q.get("kennung").asText())) {
                    assertThat(q.get("anlage").asText()).as(fall + " / " + q.get("kennung"))
                            .isEqualTo(anlageDerQuelle.get(q.get("kennung").asText()));
                }
            }
            if (f.path("quelle").has("verbund")) {
                JsonNode vRef = ref.at(f.get("quelle").get("verbund").asText());
                OffsetDateTime stichtag = OffsetDateTime.parse(f.get("stichtag").asText());
                List<String> erwartet = new ArrayList<>();
                for (JsonNode m : vRef.get("mitglieder")) {
                    boolean ab = !OffsetDateTime.parse(m.get("gueltig_ab").asText()).isAfter(stichtag);
                    boolean bis = m.get("gueltig_bis").isNull()
                            || OffsetDateTime.parse(m.get("gueltig_bis").asText()).isAfter(stichtag);
                    if (ab && bis) {
                        erwartet.add(m.get("box").asText() + "/" + m.get("rolle").asText() + "/" + m.get("messpunkt").asText());
                    }
                }
                List<String> vektor = new ArrayList<>();
                f.get("verbund").get("mitglieder").forEach(m -> vektor.add(
                        m.get("box").asText() + "/" + m.get("rolle").asText() + "/" + m.get("messpunkt").asText()));
                assertThat(vektor).as(fall).isEqualTo(erwartet);
                assertThat(f.get("verbund").get("anlage").asText()).isEqualTo(vRef.get("anlage").asText());
                assertThat(f.get("verbund").get("netzanschluesse").get(0).asText()).isEqualTo(vRef.get("netzanschluss").asText());
            }
        }
    }

    static Verbund verbund(JsonNode v) {
        List<String> na = new ArrayList<>();
        v.get("netzanschluesse").forEach(n -> na.add(n.asText()));
        List<Mitglied> m = new ArrayList<>();
        v.get("mitglieder").forEach(x -> m.add(new Mitglied(x.get("box").asText(), x.get("heimat").asText(),
                rolle(x.get("rolle").asText()), str(x.get("messpunkt")))));
        return new Verbund(v.get("anlage").asText(), na, m);
    }

    private static List<Datenquelle> quellen(JsonNode q) {
        List<Datenquelle> l = new ArrayList<>();
        q.forEach(x -> l.add(new Datenquelle(x.get("kennung").asText(), x.get("anlage").asText(), str(x.get("gelesen_von")))));
        return l;
    }

    private static Map<Grenzart, Richtung> auslegung(JsonNode a) {
        Map<Grenzart, Richtung> m = new EnumMap<>(Grenzart.class);
        if (a == null) {
            return m;
        }
        for (Grenzart g : SteuerungsverbundAnteile.RICHTUNGEN) {
            JsonNode r = a.get(g.code());
            if (r == null) {
                continue;
            }
            Map<String, Leistung> jeBox = new LinkedHashMap<>();
            r.get("je_box").fields().forEachRemaining(e -> jeBox.put(e.getKey(),
                    new Leistung(bd(e.getValue().get("nenn_kw")), bd(e.getValue().get("rueckfall_kw")))));
            m.put(g, new Richtung(bd(r.get("grenze_kw")), bd(r.get("vorbehalt_kw")), jeBox));
        }
        return m;
    }

    private static List<Map<String, String>> befunde(Urteil u) {
        List<Map<String, String>> l = new ArrayList<>();
        for (Befund b : u.befunde()) {
            Map<String, String> m = new LinkedHashMap<>();
            m.put("ablehnung", b.ablehnung().code());
            m.put("box", b.box());
            m.put("richtung", b.richtung() == null ? null : b.richtung().code());
            l.add(m);
        }
        return l;
    }

    private static Stufe stufe(String code) {
        if (code == null) {
            return null;
        }
        for (Stufe st : Stufe.values()) {
            if (st.code().equals(code)) {
                return st;
            }
        }
        throw new IllegalArgumentException(code);
    }

    private static Rolle rolle(String code) {
        for (Rolle r : Rolle.values()) {
            if (r.code().equals(code)) {
                return r;
            }
        }
        throw new IllegalArgumentException(code);
    }
}
