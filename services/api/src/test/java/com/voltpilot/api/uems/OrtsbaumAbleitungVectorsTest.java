package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.SerializerProvider;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.databind.module.SimpleModule;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.ser.std.StdSerializer;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Anlage;
import com.voltpilot.api.uems.OrtsbaumAbleitung.EintragAntrag;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Intervall;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Messstelle;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Ort;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Ortsbaum;
import com.voltpilot.api.uems.OrtsbaumAbleitung.RueckwirkungEingang;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Vorgang;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Zeitraum;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Function;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Der Vertrag des Java-Zwillings: {@link OrtsbaumAbleitung} zieht aus JEDEM Fall
 * der EINEN geteilten Vektor-Datei ({@code docs/contracts/v2/ortsbaum-vectors.json})
 * dasselbe Ergebnis wie der TS-Zwilling ({@code frontend/portal/src/uemsOrtsbaum.test.ts}
 * fährt dieselbe Datei).
 *
 * <p>Die Ergebnisse sind Records mit camelCase-Komponenten; Jackson schreibt sie
 * mit {@code SNAKE_CASE} und Enums als Kleinbuchstaben — also genau in der
 * Schreibweise der Datei — und {@link #gleich} vergleicht Baum gegen Baum. Ein
 * Schlüssel, den der Vertrag für eine Zeile NICHT nennt (die Standort-Summe an
 * einem Gebäude), muss im Ergebnis null sein.
 *
 * <p>Rein; läuft immer (kein Docker, keine DB, keine Uhr).
 */
class OrtsbaumAbleitungVectorsTest {

    // Arbeitsverzeichnis ist services/api; das Repo-Wurzelverzeichnis liegt zwei Ebenen darüber.
    private static final Path VECTORS =
            Path.of("..", "..", "docs", "contracts", "v2", "ortsbaum-vectors.json");
    private static final Path SCHEMA =
            Path.of("..", "..", "docs", "contracts", "v2", "ortsbaum.schema.json");

    @SuppressWarnings({"rawtypes", "unchecked"})
    private static final ObjectMapper MAPPER = JsonMapper.builder()
            .addModule(new JavaTimeModule())
            .addModule(new SimpleModule().addSerializer(Enum.class, new StdSerializer<Enum>(Enum.class) {
                @Override
                public void serialize(Enum value, JsonGenerator gen, SerializerProvider provider)
                        throws IOException {
                    gen.writeString(value.name().toLowerCase(Locale.ROOT));
                }
            }))
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
            .enable(MapperFeature.ACCEPT_CASE_INSENSITIVE_ENUMS)
            .propertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE)
            .build();

    private static JsonNode vectors;

    private static JsonNode vectors() throws IOException {
        if (vectors == null) {
            vectors = MAPPER.readTree(Files.readString(VECTORS));
        }
        return vectors;
    }

    // ------------------------------------------------------------------ Hilfen

    private static LocalDate tag(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : LocalDate.parse(n.asText());
    }

    private static String text(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : n.asText();
    }

    /** Jedes Objekt der Überlagerung ERSETZT das mit demselben Kennzeichen oder kommt neu dazu. */
    private static <T> List<T> liste(JsonNode basis, JsonNode ueber, Class<T> typ) throws IOException {
        Map<String, JsonNode> zeilen = new LinkedHashMap<>();
        for (JsonNode n : basis) {
            zeilen.put(n.path("kennzeichen").asText(), n);
        }
        for (JsonNode n : ueber == null ? MAPPER.createArrayNode() : ueber) {
            zeilen.put(n.path("kennzeichen").asText(), n);
        }
        List<T> out = new ArrayList<>();
        for (JsonNode n : zeilen.values()) {
            out.add(MAPPER.treeToValue(n, typ));
        }
        return out;
    }

    private static Ortsbaum baum(JsonNode in) throws IOException {
        JsonNode s = vectors().path("szenarien").path(in.path("szenario").asText());
        assertThat(s.isMissingNode()).as("Szenario %s", in.path("szenario").asText()).isFalse();
        JsonNode u = in.path("ueberlagerung");
        return new Ortsbaum(
                ZoneId.of(vectors().path("zeitzone").asText()),
                liste(s.path("orte"), u.get("orte"), Ort.class),
                liste(s.path("anlagen"), u.get("anlagen"), Anlage.class),
                liste(s.path("messstellen"), u.get("messstellen"), Messstelle.class));
    }

    private static EintragAntrag antrag(JsonNode in) {
        return new EintragAntrag(
                in.path("objekt").asText(),
                Vorgang.valueOf(in.path("vorgang").asText().toUpperCase(Locale.ROOT)),
                tag(in.get("ab")),
                in.path("eltern").asText(),
                tag(in.get("heute")));
    }

    /** Erwartung gegen Ergebnis, Knoten für Knoten — Zahlen nach Wert, nicht nach Typ. */
    private static void gleich(JsonNode erwartet, JsonNode ist, String pfad) {
        boolean istLeer = ist == null || ist.isNull() || ist.isMissingNode();
        if (erwartet.isNull()) {
            assertThat(istLeer).as("%s: erwartet null, ist %s", pfad, ist).isTrue();
        } else if (erwartet.isObject()) {
            assertThat(!istLeer && ist.isObject()).as("%s: erwartet ein Objekt, ist %s", pfad, ist).isTrue();
            for (Iterator<String> it = erwartet.fieldNames(); it.hasNext(); ) {
                String k = it.next();
                gleich(erwartet.get(k), ist.get(k), pfad + "." + k);
            }
            for (Iterator<String> it = ist.fieldNames(); it.hasNext(); ) {
                String k = it.next();
                if (!erwartet.has(k)) {
                    assertThat(ist.get(k).isNull())
                            .as("%s.%s steht nicht im Vertrag und muss null sein, ist %s", pfad, k, ist.get(k))
                            .isTrue();
                }
            }
        } else if (erwartet.isArray()) {
            assertThat(!istLeer && ist.isArray()).as("%s: erwartet eine Liste, ist %s", pfad, ist).isTrue();
            assertThat(ist.size()).as("%s: Länge (ist %s)", pfad, ist).isEqualTo(erwartet.size());
            for (int k = 0; k < erwartet.size(); k++) {
                gleich(erwartet.get(k), ist.get(k), pfad + "[" + k + "]");
            }
        } else if (erwartet.isNumber()) {
            assertThat(!istLeer && ist.isNumber()).as("%s: erwartet %s, ist %s", pfad, erwartet, ist).isTrue();
            assertThat(ist.decimalValue()).as(pfad).isEqualByComparingTo(erwartet.decimalValue());
        } else {
            assertThat(ist).as(pfad).isEqualTo(erwartet);
        }
    }

    private static Object mitTeilen(List<?> teile) {
        return Map.of("teile", teile);
    }

    /** Je Familie/Ableitung der Aufruf — derselbe Schnitt wie im TS-Test. */
    private interface Laeufer {
        Object lauf(JsonNode in) throws IOException;
    }

    private static final Map<String, Laeufer> LAEUFER = new LinkedHashMap<>();

    static {
        LAEUFER.put("stand_am/baum", in -> OrtsbaumAbleitung.standAm(baum(in), tag(in.get("stichtag"))));
        LAEUFER.put("ueberlappung/liste", in -> {
            List<Intervall> iv = new ArrayList<>();
            for (JsonNode n : in.path("intervalle")) {
                iv.add(MAPPER.treeToValue(n, Intervall.class));
            }
            return OrtsbaumAbleitung.pruefeIntervalle(iv);
        });
        LAEUFER.put("ueberlappung/eintrag", in -> OrtsbaumAbleitung.eintrag(baum(in), antrag(in)));
        LAEUFER.put("rueckwirkend/kennzeichen", in -> {
            JsonNode z = in.get("zeitraum");
            return OrtsbaumAbleitung.rueckwirkung(new RueckwirkungEingang(
                    OffsetDateTime.parse(in.path("eingetragen_um").asText()),
                    tag(in.get("gilt_ab")),
                    tag(in.get("gilt_bis")),
                    ZoneId.of(in.path("zeitzone").asText()),
                    z == null || z.isNull() ? null : new Zeitraum(tag(z.get("von")), tag(z.get("bis")))));
        });
        LAEUFER.put("messstelle_standort/am_tag", in ->
                OrtsbaumAbleitung.verortung(baum(in), in.path("messstelle").asText(), tag(in.get("tag"))));
        LAEUFER.put("verschieben/folgen", in -> OrtsbaumAbleitung.verschiebenFolgen(baum(in), antrag(in)));
        LAEUFER.put("archiv/archivieren", in ->
                OrtsbaumAbleitung.archivieren(baum(in), in.path("objekt").asText(), tag(in.get("tag"))));
        LAEUFER.put("archiv/wiederherstellen", in -> OrtsbaumAbleitung.wiederherstellen(
                baum(in), in.path("objekt").asText(), tag(in.get("tag")), text(in.get("neuer_name"))));
        LAEUFER.put("archiv/loeschen", in -> OrtsbaumAbleitung.loeschen(baum(in), in.path("objekt").asText()));
        LAEUFER.put("zeitraum_teilung/teile", in -> mitTeilen(OrtsbaumAbleitung.teile(
                baum(in), in.path("objekt").asText(), tag(in.get("von")), tag(in.get("bis")))));
        LAEUFER.put("flaeche/am_tag", in ->
                OrtsbaumAbleitung.flaecheAm(baum(in), in.path("objekt").asText(), tag(in.get("tag"))));
        LAEUFER.put("flaeche/zeitraum", in -> mitTeilen(OrtsbaumAbleitung.flaecheZeitraum(
                baum(in), in.path("objekt").asText(), tag(in.get("von")), tag(in.get("bis")))));
    }

    // ------------------------------------------------------ die Vektor-Fälle

    @TestFactory
    List<DynamicTest> vektorFaelle() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : vectors().path("cases")) {
            String schluessel = c.path("familie").asText() + "/" + c.path("ableitung").asText();
            Laeufer l = LAEUFER.get(schluessel);
            tests.add(DynamicTest.dynamicTest(schluessel + " · " + c.path("name").asText(), () -> {
                assertThat(l).as("Läufer für %s", schluessel).isNotNull();
                JsonNode ist = MAPPER.valueToTree(l.lauf(c.path("input")));
                gleich(c.path("expected"), ist, c.path("name").asText());
            }));
        }
        return tests;
    }

    /** Jede Familie hat Fälle — keine fällt still heraus. */
    @Test
    void jederLaeuferHatFaelle() throws Exception {
        for (String schluessel : LAEUFER.keySet()) {
            int n = 0;
            for (JsonNode c : vectors().path("cases")) {
                if (schluessel.equals(c.path("familie").asText() + "/" + c.path("ableitung").asText())) {
                    n++;
                }
            }
            assertThat(n).as("Fälle für %s", schluessel).isPositive();
        }
    }

    @Test
    void dieRegelKonstantenSindDieselben() throws Exception {
        JsonNode root = vectors();
        assertThat(root.path("zeitzone").asText()).isEqualTo(OrtsbaumAbleitung.VORGABE_ZEITZONE.getId());
        assertThat(root.path("regeln").path("unternehmen_kennzeichen").asText())
                .isEqualTo(OrtsbaumAbleitung.UNTERNEHMEN);
        assertThat(root.path("regeln").path("bis_ist_letzter_tag").asBoolean()).isTrue();
        Map<String, List<String>> ausDemCode = new LinkedHashMap<>();
        OrtsbaumAbleitung.ERLAUBTE_ELTERN.forEach(
                (art, eltern) -> ausDemCode.put(art.code(), eltern.stream().map(e -> e.code()).toList()));
        Map<String, List<String>> ausDerDatei = new LinkedHashMap<>();
        root.path("erlaubte_eltern").fields().forEachRemaining(e -> {
            List<String> l = new ArrayList<>();
            e.getValue().forEach(n -> l.add(n.asText()));
            ausDerDatei.put(e.getKey(), l);
        });
        assertThat(ausDerDatei).isEqualTo(ausDemCode);
    }

    private static List<String> codes(Enum<?>[] werte, Function<Enum<?>, Boolean> mit) {
        List<String> out = new ArrayList<>();
        for (Enum<?> w : werte) {
            if (mit.apply(w)) {
                out.add(w.name().toLowerCase(Locale.ROOT));
            }
        }
        return out;
    }

    private static List<String> ausDatei(String feld) throws IOException {
        List<String> out = new ArrayList<>();
        vectors().path(feld).forEach(n -> out.add(n.asText()));
        return out;
    }

    /** Das geschlossene Vokabular ist wirklich geschlossen — und die Reihenfolge IST die Regel. */
    @Test
    void dasVokabularIstDasselbe() throws Exception {
        Function<Enum<?>, Boolean> alle = w -> true;
        assertThat(ausDatei("arten_ort")).isEqualTo(codes(OrtsbaumAbleitung.OrtArt.values(), alle));
        assertThat(ausDatei("zustaende_zuordnung"))
                .isEqualTo(codes(OrtsbaumAbleitung.ZuordnungZustand.values(), alle));
        assertThat(ausDatei("gruende_liste")).isEqualTo(codes(OrtsbaumAbleitung.ListenGrund.values(), alle));
        assertThat(ausDatei("gruende_eintrag")).isEqualTo(codes(OrtsbaumAbleitung.EintragGrund.values(), alle));
        assertThat(ausDatei("arten_rueckwirkung"))
                .isEqualTo(codes(OrtsbaumAbleitung.Rueckwirkung.values(), alle));
        assertThat(ausDatei("gruende_nicht_gezeigt")).isEqualTo(codes(
                OrtsbaumAbleitung.Bestand.values(), w -> w != OrtsbaumAbleitung.Bestand.VORHANDEN));
        assertThat(ausDatei("gruende_verortung"))
                .isEqualTo(codes(OrtsbaumAbleitung.VerortungGrund.values(), alle));
        assertThat(ausDatei("gruende_archivieren"))
                .isEqualTo(codes(OrtsbaumAbleitung.ArchivGrundArt.values(), alle));
        assertThat(ausDatei("gruende_wiederherstellen"))
                .isEqualTo(codes(OrtsbaumAbleitung.WiederherstellGrund.values(), alle));
        assertThat(ausDatei("gruende_loeschen")).isEqualTo(codes(OrtsbaumAbleitung.LoeschGrund.values(), alle));
        assertThat(ausDatei("flaeche_quellen")).isEqualTo(codes(OrtsbaumAbleitung.FlaecheQuelle.values(), alle));
        assertThat(ausDatei("objekt_zustaende"))
                .isEqualTo(codes(OrtsbaumAbleitung.ObjektZustand.values(), alle));
    }

    /**
     * Je Familie/Ableitung die Schema-Teile für Eingang und Ergebnis: der geteilte
     * {@link UemsSchemaLaeufer} kennt kein {@code if/then}, also wählt der Test den
     * Teil selbst — dieselbe Zuordnung, die das Schema in {@code fall.allOf} trifft.
     */
    private static final Map<String, List<String>> SCHEMA_TEILE = Map.ofEntries(
            Map.entry("stand_am/baum", List.of("standAmEingang", "standAmErgebnis")),
            Map.entry("ueberlappung/liste", List.of("listeEingang", "listeErgebnis")),
            Map.entry("ueberlappung/eintrag", List.of("eintragEingang", "eintragErgebnis")),
            Map.entry("rueckwirkend/kennzeichen", List.of("rueckwirkendEingang", "rueckwirkendErgebnis")),
            Map.entry("messstelle_standort/am_tag", List.of("verortungEingang", "verortungErgebnis")),
            Map.entry("verschieben/folgen", List.of("eintragEingang", "folgenErgebnis")),
            Map.entry("archiv/archivieren", List.of("archivierenEingang", "archivierenErgebnis")),
            Map.entry("archiv/wiederherstellen", List.of("wiederherstellenEingang", "wiederherstellenErgebnis")),
            Map.entry("archiv/loeschen", List.of("loeschenEingang", "loeschenErgebnis")),
            Map.entry("zeitraum_teilung/teile", List.of("zeitraumEingang", "teileErgebnis")),
            Map.entry("flaeche/am_tag", List.of("flaecheAmTagEingang", "flaecheAmTagErgebnis")),
            Map.entry("flaeche/zeitraum", List.of("zeitraumEingang", "flaecheZeitraumErgebnis")));

    /** Die Datei hält ihr Schema — die Wurzel und jeder Fall mit seinem Eingang und Ergebnis. */
    @Test
    void dieDateiHaeltIhrSchema() throws Exception {
        JsonNode schema = MAPPER.readTree(Files.readString(SCHEMA));
        List<String> fehler = new ArrayList<>(UemsSchemaLaeufer.verstoesse(vectors(), schema));
        for (JsonNode c : vectors().path("cases")) {
            String schluessel = c.path("familie").asText() + "/" + c.path("ableitung").asText();
            List<String> teile = SCHEMA_TEILE.get(schluessel);
            assertThat(teile).as("Schema-Teile für %s", schluessel).isNotNull();
            String pfad = "$.cases[" + c.path("name").asText() + "]";
            UemsSchemaLaeufer laeufer = new UemsSchemaLaeufer(schema, fehler);
            laeufer.pruefe(c.path("input"), schema.path("$defs").path(teile.get(0)), pfad + ".input");
            laeufer.pruefe(c.path("expected"), schema.path("$defs").path(teile.get(1)), pfad + ".expected");
        }
        assertThat(fehler).isEmpty();
    }

    /** Jeder Fall trägt einen Grund, warum er in der Datei steht; Namen sind eindeutig. */
    @Test
    void jederFallSagtWarumErDaIst() throws Exception {
        List<String> namen = new ArrayList<>();
        for (JsonNode c : vectors().path("cases")) {
            assertThat(c.path("why").asText()).as("why für %s", c.path("name").asText()).isNotBlank();
            namen.add(c.path("name").asText());
        }
        assertThat(namen).doesNotHaveDuplicates();
    }

    /**
     * A10 über {@link OrtsbaumAbleitung#nameBelegt} — die Prüfung, die {@code wiederherstellen}
     * benutzt (Fälle {@code a10-name-inzwischen-vergeben}, {@code namensvergleich-…}), jetzt
     * auch für Anlegen und Umbenennen (IP-4/IP-5): „Halle 1" ist an Werk Lindach frei und an
     * Werk Ahrenberg belegt (G-1), ohne Groß-/Kleinschreibung und Randleerzeichen; ein Ort
     * kollidiert nie mit sich selbst. Der TS-Zwilling prüft dasselbe.
     */
    @Test
    void a10DieNamensregelBeimAnlegenUndUmbenennen() throws Exception {
        Ortsbaum b = baum(MAPPER.createObjectNode().put("szenario", "ahrenberg-vor-dem-umzug"));
        LocalDate tag = LocalDate.parse("2026-10-20");
        Ort g1 = OrtsbaumAbleitung.nameBelegt(b, OrtsbaumAbleitung.OrtArt.GEBAEUDE, "ST-1", "  halle 1 ", tag, null)
                .orElseThrow();
        assertThat(g1.kennzeichen()).isEqualTo("G-1");
        assertThat(OrtsbaumAbleitung.nameBelegtSatz(g1)).isEqualTo("Diesen Namen gibt es hier schon: Halle 1 "
                + "(G-1). Wählen Sie einen anderen Namen — oder öffnen Sie Halle 1.");
        assertThat(OrtsbaumAbleitung.nameBelegt(b, OrtsbaumAbleitung.OrtArt.GEBAEUDE, "ST-2", "Halle 1", tag, null))
                .isEmpty();
        assertThat(OrtsbaumAbleitung.nameBelegt(b, OrtsbaumAbleitung.OrtArt.GEBAEUDE, "ST-1", "Halle 1", tag, "G-1"))
                .isEmpty();
        assertThat(OrtsbaumAbleitung.nameBelegt(b, OrtsbaumAbleitung.OrtArt.STANDORT, null, "WERK LINDACH", tag,
                null)).map(Ort::kennzeichen).contains("ST-2");
        // Werk Ahrenberg Nord gibt es erst ab 20.02.2027 — vorher belegt es seinen Namen nicht.
        assertThat(OrtsbaumAbleitung.nameBelegt(b, OrtsbaumAbleitung.OrtArt.STANDORT, null, "Werk Ahrenberg Nord",
                tag, null)).isEmpty();
    }

    /** Die Beispieldaten halten die eigene Regel: jedes Szenario ist in sich überlappungsfrei. */
    @Test
    void jedesSzenarioIstUeberlappungsfrei() throws Exception {
        for (Iterator<Map.Entry<String, JsonNode>> it = vectors().path("szenarien").fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> s = it.next();
            ObjectNode in = MAPPER.createObjectNode().put("szenario", s.getKey());
            Ortsbaum b = baum(in);
            Map<String, List<Intervall>> listen = new LinkedHashMap<>();
            b.orte().forEach(o -> listen.put(o.kennzeichen(), o.intervalle()));
            b.anlagen().forEach(a -> listen.put(a.kennzeichen(), a.zuordnungen()));
            b.messstellen().forEach(m -> listen.put(m.kennzeichen(), m.zuordnungen()));
            listen.forEach((kz, l) -> assertThat(OrtsbaumAbleitung.pruefeIntervalle(l).gueltig())
                    .as("%s · %s", s.getKey(), kz)
                    .isTrue());
        }
    }
}
