package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.StandortLesemodell.Anlage;
import com.voltpilot.api.uems.StandortLesemodell.StandortAmStichtag;
import com.voltpilot.api.uems.StandortLesemodell.StandortBezug;
import com.voltpilot.api.uems.StandortLesemodell.StandorteAmStichtag;
import com.voltpilot.api.uems.StandortLesemodell.UnternehmenSicht;
import com.voltpilot.api.uems.StandortLesemodell.Zeilen;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Predicate;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Das Standort-Lesemodell (UEMS AP-02 IP-3 ★) gegen den Ortsbaum-Vertrag — ohne
 * Datenbank: die Szenarien der Vektor-Datei werden zu den ZEILEN, wie die
 * Repositories sie liefern (Standort mit {@code created_at}/{@code archiviert_am}
 * statt Intervall, Gebäude/Bereiche mit Zuordnungs-Zeilen, Flächen, Anlagen), und
 * die Antwort muss für JEDEN „Stand am"-Fall genau das sagen, was die Datei für
 * die Standorte erwartet. Die Werte des Unternehmens und der Adressen kommen aus
 * dem Referenzunternehmen ({@code uems-referenzunternehmen.json}).
 *
 * <p>Die HTTP-Hälfte (404, RLS, additive Felder, Unternehmen beim Anlegen)
 * beweist {@code StandortLesemodellApiTest}.
 */
class StandortLesemodellTest {

    private static final Path VEKTOREN =
            Path.of("..", "..", "docs", "contracts", "v2", "ortsbaum-vectors.json");
    private static final Path REFERENZ =
            Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");

    private static JsonNode vektoren;
    private static JsonNode referenz;

    // ------------------------------------------------------ gegen die Vektor-Datei

    @TestFactory
    Stream<DynamicTest> jederStandAmFallDerVektorDateiGiltFuerDieStandorte() throws IOException {
        return StreamSupport.stream(vektoren().path("cases").spliterator(), false)
                .filter(c -> "stand_am".equals(c.path("familie").asText())
                        && "baum".equals(c.path("ableitung").asText()))
                .map(c -> DynamicTest.dynamicTest(c.path("name").asText(), () -> pruefeFall(c)));
    }

    private static void pruefeFall(JsonNode fall) throws IOException {
        JsonNode szenario = szenario(fall.path("input").path("szenario").asText());
        LocalDate stichtag = LocalDate.parse(fall.path("input").path("stichtag").asText());
        JsonNode erwartet = fall.path("expected");
        StandorteAmStichtag r = StandortLesemodell.standorte(zeilen(szenario, Map.of()), stichtag);

        Map<String, String> art = new LinkedHashMap<>();
        szenario.path("orte").forEach(o -> art.put(o.path("kennzeichen").asText(),
                o.path("art").asText()));
        Map<String, JsonNode> orte = new LinkedHashMap<>();
        erwartet.path("orte").forEach(o -> orte.put(o.path("kennzeichen").asText(), o));

        List<String> vorhanden = orte.keySet().stream()
                .filter(k -> "standort".equals(art.get(k))).toList();
        assertThat(r.standorte()).extracting(StandortAmStichtag::kurzzeichen)
                .containsExactlyElementsOf(vorhanden);
        for (StandortAmStichtag st : r.standorte()) {
            JsonNode o = orte.get(st.kurzzeichen());
            assertThat(st.bestand()).isEqualTo("vorhanden");
            assertThat(st.bestandText()).isNull();
            assertThat(st.flaecheM2()).as("Fläche %s", st.kurzzeichen())
                    .isEqualTo(o.path("flaeche_m2").isNull() ? null : o.path("flaeche_m2").asInt());
            assertThat(st.flaecheQuelle()).as("Quelle %s", st.kurzzeichen())
                    .isEqualTo(o.path("flaeche_quelle").isNull()
                            ? null : o.path("flaeche_quelle").asText());
            assertThat(st.gebaeudeZahl()).as("Gebäude %s", st.kurzzeichen()).isEqualTo(
                    zaehle(orte, k -> "gebaeude".equals(art.get(k)), st.kurzzeichen()));
            assertThat(st.bereichZahl()).as("Bereiche %s", st.kurzzeichen()).isEqualTo(
                    zaehle(orte, k -> "bereich".equals(art.get(k)), st.kurzzeichen()));
            assertThat(st.anlagen()).extracting(a -> kennzeichenDerAnlage(szenario, a.name()))
                    .as("Anlagen %s", st.kurzzeichen())
                    .containsExactlyElementsOf(anlagenAm(erwartet, st.kurzzeichen()));
            assertThat(st.anlagenZahl()).isEqualTo(st.anlagen().size());
        }

        List<JsonNode> nicht = StreamSupport.stream(erwartet.path("nicht_gezeigt").spliterator(), false)
                .filter(n -> "standort".equals(art.get(n.path("kennzeichen").asText())))
                .toList();
        assertThat(r.nichtGezeigt()).extracting(StandortAmStichtag::kurzzeichen)
                .containsExactlyElementsOf(nicht.stream().map(n -> n.path("kennzeichen").asText())
                        .toList());
        for (int i = 0; i < nicht.size(); i++) {
            StandortAmStichtag st = r.nichtGezeigt().get(i);
            assertThat(st.bestand()).isEqualTo(nicht.get(i).path("grund").asText());
            assertThat(st.bestandText()).isEqualTo(nicht.get(i).path("text").asText());
            // Einen Standort, den es an dem Tag nicht gab, gibt es auch ohne Zahlen.
            assertThat(st.anlagen()).isEmpty();
            assertThat(st.anlagenZahl()).isNull();
            assertThat(st.gebaeudeZahl()).isNull();
            assertThat(st.flaecheM2()).isNull();
        }

        List<String> offen = anlagenAm(erwartet, null);
        if (offen.isEmpty()) {
            assertThat(r.nochNichtZugeordnet()).isNull();
        } else {
            assertThat(r.nochNichtZugeordnet().anlagenZahl()).isEqualTo(offen.size());
            assertThat(r.nochNichtZugeordnet().anlagen())
                    .extracting(a -> kennzeichenDerAnlage(szenario, a.name()))
                    .containsExactlyElementsOf(offen);
        }
    }

    // ------------------------------------------------------------ A12 lesbar

    @Test
    void a12StandAmDreiStichtage() throws IOException {
        Zeilen z = zeilen(szenario("ahrenberg"), Map.of());

        // 15.02.2027: Halle 2 (mit ihren drei Bereichen) unter Werk Ahrenberg, beide
        // Anlagen dort; Werk Ahrenberg Nord gab es noch nicht.
        StandorteAmStichtag feb = StandortLesemodell.standorte(z, LocalDate.of(2027, 2, 15));
        StandortAmStichtag werk = eintrag(feb.standorte(), "ST-1");
        assertThat(werk.gebaeudeZahl()).isEqualTo(3);
        assertThat(werk.bereichZahl()).isEqualTo(5);
        assertThat(werk.anlagen()).extracting(StandortLesemodell.ZugeordneteAnlage::name)
                .containsExactly("Werk Ahrenberg – Halle 1", "Werk Ahrenberg – Halle 2");
        assertThat(werk.anlagen().get(1).gueltigBis()).isEqualTo(LocalDate.of(2027, 2, 28));
        assertThat(eintrag(feb.nichtGezeigt(), "ST-3").bestandText())
                .isEqualTo("Am 15.02.2027 gab es Werk Ahrenberg Nord im Portal noch nicht.");

        // 15.03.2027: Halle 2 und ihre Anlage unter Werk Ahrenberg Nord.
        StandorteAmStichtag mrz = StandortLesemodell.standorte(z, LocalDate.of(2027, 3, 15));
        assertThat(eintrag(mrz.standorte(), "ST-1").gebaeudeZahl()).isEqualTo(2);
        StandortAmStichtag nord = eintrag(mrz.standorte(), "ST-3");
        assertThat(nord.gebaeudeZahl()).isEqualTo(1);
        assertThat(nord.bereichZahl()).isEqualTo(3);
        assertThat(nord.flaecheM2()).isEqualTo(3400);
        assertThat(nord.flaecheQuelle()).isEqualTo("aus_gebaeuden_summiert");
        assertThat(nord.anlagen()).singleElement().satisfies(a -> {
            assertThat(a.name()).isEqualTo("Werk Ahrenberg – Halle 2");
            assertThat(a.gueltigAb()).isEqualTo(LocalDate.of(2027, 3, 1));
            assertThat(a.gueltigBis()).isNull();
        });

        // 15.09.2026 (Neukunden-Weg): es gab noch keinen Standort; alle drei Anlagen
        // sind „noch nicht zugeordnet" — eine leere Liste, kein 0-Objekt.
        StandorteAmStichtag sep = StandortLesemodell.standorte(z, LocalDate.of(2026, 9, 15));
        assertThat(sep.standorte()).isEmpty();
        assertThat(eintrag(sep.nichtGezeigt(), "ST-1").bestandText())
                .isEqualTo("Am 15.09.2026 gab es Werk Ahrenberg im Portal noch nicht.");
        assertThat(sep.nochNichtZugeordnet().anlagenZahl()).isEqualTo(3);
    }

    // -------------------------------------------------- Bestand des Standorts

    @Test
    void bestandsuebernahmeDerStandortBestehtSeitDerAnlageNichtErstSeitDemAnlegen()
            throws IOException {
        // Die Bestandsübernahme (IP-9) legt Werk Ahrenberg am 01.10.2026 an und ordnet
        // die Bestandsanlage ab ihrem eigenen Beginn (12.03.2024) zu. Dann besteht der
        // Standort ab dem 12.03.2024 — sonst hinge die Anlage an einem Standort, den es
        // nicht gibt (Vektor-Fall a5-bestand-standort-besteht-seit-der-anlage).
        Zeilen z = zeilen(szenario("ahrenberg-bestand"), Map.of("ST-1", LocalDate.of(2026, 10, 1)));
        StandorteAmStichtag r = StandortLesemodell.standorte(z, LocalDate.of(2026, 9, 15));

        StandortAmStichtag werk = eintrag(r.standorte(), "ST-1");
        assertThat(werk.anlagen()).singleElement().satisfies(a -> {
            assertThat(a.name()).isEqualTo("Werk Ahrenberg – Halle 1");
            assertThat(a.gueltigAb()).isEqualTo(LocalDate.of(2024, 3, 12));
        });
        // Ohne Gebäude (die kamen am 01.10.2026) und vor der eigenen Fläche: null, nie 0.
        assertThat(werk.gebaeudeZahl()).isZero();
        assertThat(werk.flaecheM2()).isNull();
        assertThat(werk.flaecheQuelle()).isNull();
        // Vor dem 12.03.2024 gab es ihn nicht.
        assertThat(StandortLesemodell.standort(z, id("ST-1"), LocalDate.of(2024, 3, 11))
                .orElseThrow().bestand()).isEqualTo("gab_es_noch_nicht");
    }

    @Test
    void einArchivierterStandortEndetAmVortagUndSagtWarum() throws IOException {
        Zeilen z = zeilen(szenario("ahrenberg-lindach-archiviert"), Map.of());
        // Szenario: Werk Lindach bis 31.03.2027 → archiviert am 01.04.2027.
        StandortAmStichtag bis = StandortLesemodell.standort(z, id("ST-2"), LocalDate.of(2027, 3, 31))
                .orElseThrow();
        assertThat(bis.bestand()).isEqualTo("vorhanden");
        assertThat(bis.zustand()).isEqualTo("archiviert");

        StandorteAmStichtag danach = StandortLesemodell.standorte(z, LocalDate.of(2027, 4, 15));
        StandortAmStichtag lindach = eintrag(danach.nichtGezeigt(), "ST-2");
        assertThat(lindach.bestand()).isEqualTo("archiviert");
        assertThat(lindach.bestandText()).isEqualTo("Am 15.04.2027 war Werk Lindach archiviert.");
        // Archivierte zählen im Unternehmen nicht als Standort.
        assertThat(StandortLesemodell.unternehmen(z, LocalDate.of(2027, 4, 15)).standortZahl())
                .isEqualTo(2);
    }

    @Test
    void a16DerTagBeginntInDerZeitzoneDesStandorts() throws IOException {
        // „Werk Wels" (A16) in Österreich: Europe/Vienna, während das Unternehmen bei
        // Europe/Berlin bleibt. Angelegt 30.04.2027 22:30 UTC = 01.05.2027 00:30 in
        // Wien: der Standort besteht ab dem 01.05. — nicht ab dem UTC-Tag.
        Zeilen basis = zeilen(szenario("ahrenberg"), Map.of());
        List<StandortRepository.Standort> standorte = new ArrayList<>(basis.standorte());
        standorte.add(new StandortRepository.Standort(id("ST-4"), id("U"), "Werk Wels", "ST-4",
                null, null, null, "AT", "Europe/Vienna", null, null, null, null, "entwurf", null,
                Instant.parse("2027-04-30T22:30:00Z")));
        Zeilen z = new Zeilen(basis.unternehmen(), standorte, basis.orte(), basis.ortZuordnungen(),
                basis.anlageZuordnungen(), basis.flaechen(), basis.anlagen());

        assertThat(StandortLesemodell.standort(z, id("ST-4"), LocalDate.of(2027, 4, 30))
                .orElseThrow().bestandText())
                .isEqualTo("Am 30.04.2027 gab es Werk Wels im Portal noch nicht.");
        StandortAmStichtag wels = StandortLesemodell.standort(z, id("ST-4"), LocalDate.of(2027, 5, 1))
                .orElseThrow();
        assertThat(wels.bestand()).isEqualTo("vorhanden");
        assertThat(wels.zeitzone()).isEqualTo("Europe/Vienna");
        assertThat(StandortLesemodell.unternehmen(z, LocalDate.of(2027, 5, 1)).zeitzone())
                .isEqualTo("Europe/Berlin");
        // Der Entwurf sagt, was fehlt (E10) — das Land allein ist keine Adresse.
        assertThat(wels.zustand()).isEqualTo("entwurf");
        assertThat(wels.esFehlt()).containsExactly(StandortLesemodell.ES_FEHLT_ADRESSE);
        assertThat(wels.adresse().land()).isEqualTo("AT");
        // Ein eingerichteter Standort vermisst nichts.
        assertThat(eintrag(StandortLesemodell.standorte(z, LocalDate.of(2027, 5, 1)).standorte(),
                "ST-1").esFehlt()).isEmpty();
    }

    // ------------------------------------------------- Gruppe und Leerzustand

    @Test
    void a15DieGruppeNochNichtZugeordnetGibtEsNurSolangeEtwasFehlt() throws IOException {
        Zeilen z = zeilen(szenario("ahrenberg"), Map.of());
        // Vorher (Bestand ohne Standort-Zuordnung): zwei Anlagen in der Gruppe.
        Zeilen vorher = new Zeilen(z.unternehmen(), List.of(), List.of(), List.of(), List.of(),
                List.of(), z.anlagen().subList(0, 2));
        StandorteAmStichtag v = StandortLesemodell.standorte(vorher, LocalDate.of(2027, 3, 15));
        assertThat(v.standorte()).isEmpty();
        assertThat(v.nichtGezeigt()).isEmpty();
        assertThat(v.nochNichtZugeordnet().anlagenZahl()).isEqualTo(2);
        assertThat(v.nochNichtZugeordnet().anlagen())
                .extracting(StandortLesemodell.NichtZugeordneteAnlage::name)
                .containsExactly("Werk Ahrenberg – Halle 1", "Werk Ahrenberg – Halle 2");
        assertThat(StandortLesemodell.unternehmen(vorher, LocalDate.of(2027, 3, 15))
                .nochNichtZugeordnetZahl()).isEqualTo(2);

        // Nachher: alles zugeordnet — keine Gruppe, kein „0 nicht zugeordnet".
        StandorteAmStichtag n = StandortLesemodell.standorte(z, LocalDate.of(2027, 3, 15));
        assertThat(n.nochNichtZugeordnet()).isNull();
        UnternehmenSicht u = StandortLesemodell.unternehmen(z, LocalDate.of(2027, 3, 15));
        assertThat(u.standortZahl()).isEqualTo(3);
        assertThat(u.anlagenZahl()).isEqualTo(3);
        assertThat(u.nochNichtZugeordnetZahl()).isZero();
    }

    @Test
    void einKundenbereichOhneAllesIstLeerNieEinNullObjekt() {
        Zeilen leer = new Zeilen(null, List.of(), List.of(), List.of(), List.of(), List.of(),
                List.of());
        StandorteAmStichtag r = StandortLesemodell.standorte(leer, LocalDate.of(2027, 3, 15));
        assertThat(r.standorte()).isEmpty();
        assertThat(r.nichtGezeigt()).isEmpty();
        assertThat(r.nochNichtZugeordnet()).isNull();
        assertThat(StandortLesemodell.standort(leer, id("ST-1"), LocalDate.of(2027, 3, 15)))
                .isEmpty();
        // Ohne Unternehmen-Zeile: der benannte Zustand, nie erfundene Stammdaten.
        UnternehmenSicht u = StandortLesemodell.unternehmen(leer, LocalDate.of(2027, 3, 15));
        assertThat(u.zustand()).isEqualTo(StandortLesemodell.UNTERNEHMEN_NICHT_ANGELEGT);
        assertThat(u.name()).isNull();
        assertThat(u.zeitzone()).isNull();
        assertThat(u.standortZahl()).isZero();
        assertThat(u.anlagenZahl()).isZero();
    }

    @Test
    void derStandortJeAnlageFolgtDemTag() throws IOException {
        Zeilen z = zeilen(szenario("ahrenberg"), Map.of());
        Map<UUID, StandortBezug> mrz = StandortLesemodell.bezugJeAnlage(z, LocalDate.of(2027, 3, 15));
        assertThat(mrz.get(id("AN-2")))
                .isEqualTo(new StandortBezug(id("ST-3"), "Werk Ahrenberg Nord", "ST-3",
                        LocalDate.of(2027, 3, 1)));
        assertThat(mrz.get(id("AN-1")).gueltigAb()).isEqualTo(LocalDate.of(2026, 10, 1));
        assertThat(StandortLesemodell.bezugJeAnlage(z, LocalDate.of(2027, 2, 15)).get(id("AN-2"))
                .kurzzeichen()).isEqualTo("ST-1");
        // Vor jeder Zuordnung fehlt die Anlage — das Feld wird null, nie geraten.
        assertThat(StandortLesemodell.bezugJeAnlage(z, LocalDate.of(2026, 9, 15))).isEmpty();
    }

    // ------------------------------------------------------------------ Hilfen

    private static int zaehle(Map<String, JsonNode> orte, Predicate<String> art, String standort) {
        return (int) orte.values().stream()
                .filter(o -> art.test(o.path("kennzeichen").asText())
                        && standort.equals(o.path("standort").asText(null)))
                .count();
    }

    /** Die Anlagen (Kennzeichen), die laut Datei am Standort hängen; {@code null} = nirgends. */
    private static List<String> anlagenAm(JsonNode erwartet, String standort) {
        List<String> out = new ArrayList<>();
        for (JsonNode a : erwartet.path("anlagen")) {
            if (Objects.equals(standort, a.path("standort").isNull()
                    ? null : a.path("standort").asText())) {
                out.add(a.path("kennzeichen").asText());
            }
        }
        return out;
    }

    private static String kennzeichenDerAnlage(JsonNode szenario, String name) {
        for (JsonNode a : szenario.path("anlagen")) {
            if (a.path("name").asText().equals(name)) {
                return a.path("kennzeichen").asText();
            }
        }
        throw new AssertionError("keine Anlage " + name);
    }

    private static StandortAmStichtag eintrag(List<StandortAmStichtag> liste, String kurzzeichen) {
        return liste.stream().filter(s -> s.kurzzeichen().equals(kurzzeichen)).findFirst()
                .orElseThrow(() -> new AssertionError("kein " + kurzzeichen + " in " + liste));
    }

    /** Eine feste ID je Kennzeichen — der Baum des Lesemodells kennt nur IDs. */
    private static UUID id(String kennzeichen) {
        return UUID.nameUUIDFromBytes(("ahrenberg:" + kennzeichen).getBytes());
    }

    private static LocalDate tag(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : LocalDate.parse(n.asText());
    }

    private static Instant mitternacht(LocalDate tag) {
        return tag.atStartOfDay(BERLIN).toInstant();
    }

    /**
     * Ein Szenario als die Zeilen der Repositories. Ein Standort hat kein
     * Intervall, sondern {@code created_at} (Beginn 00:00, außer {@code angelegt}
     * überschreibt den Tag) und {@code archiviert_am} (am Tag nach dem Ende).
     */
    private static Zeilen zeilen(JsonNode s, Map<String, LocalDate> angelegt) throws IOException {
        JsonNode ref = referenz();
        JsonNode u = ref.path("unternehmen");
        UnternehmenRepository.Unternehmen unternehmen = new UnternehmenRepository.Unternehmen(
                id("U"), u.path("name").asText(), u.path("kurzname").asText(),
                u.path("zeitzone").asText());
        Map<String, JsonNode> adressen = new LinkedHashMap<>();
        ref.path("standorte").forEach(x -> adressen.put(x.path("kennzeichen").asText(),
                x.path("adresse")));

        List<StandortRepository.Standort> standorte = new ArrayList<>();
        List<OrtRepository.Ort> orte = new ArrayList<>();
        List<OrtZuordnungRepository.Zuordnung> ortZuordnungen = new ArrayList<>();
        List<FlaecheRepository.Flaeche> flaechen = new ArrayList<>();
        Map<String, String> art = new LinkedHashMap<>();
        s.path("orte").forEach(o -> art.put(o.path("kennzeichen").asText(), o.path("art").asText()));

        for (JsonNode o : s.path("orte")) {
            String kz = o.path("kennzeichen").asText();
            UUID ortId = id(kz);
            boolean istStandort = "standort".equals(o.path("art").asText());
            for (JsonNode f : o.path("flaechen")) {
                flaechen.add(new FlaecheRepository.Flaeche(UUID.randomUUID(),
                        istStandort ? ortId : null, istStandort ? null : ortId,
                        f.path("m2").asInt(), tag(f.path("ab")), tag(f.path("bis")), null));
            }
            if (istStandort) {
                JsonNode iv = o.path("intervalle").get(0);
                LocalDate ende = tag(iv.path("bis"));
                JsonNode a = adressen.get(kz);
                standorte.add(new StandortRepository.Standort(ortId, id("U"),
                        o.path("name").asText(), kz,
                        a == null ? null : a.path("strasse").asText(null),
                        a == null ? null : a.path("plz").asText(null),
                        a == null ? null : a.path("ort").asText(null),
                        a == null ? null : a.path("land").asText(null),
                        o.path("zeitzone").asText(), null, null, null, null,
                        ende == null ? "aktiv" : "archiviert",
                        ende == null ? null : mitternacht(ende.plusDays(1)),
                        mitternacht(angelegt.getOrDefault(kz, tag(iv.path("ab"))))));
                continue;
            }
            orte.add(new OrtRepository.Ort(ortId, o.path("art").asText(), o.path("name").asText(),
                    kz, null, null, null, "aktiv", null));
            for (JsonNode iv : o.path("intervalle")) {
                String eltern = iv.path("eltern").asText();
                boolean anStandort = "standort".equals(art.get(eltern));
                ortZuordnungen.add(new OrtZuordnungRepository.Zuordnung(UUID.randomUUID(), ortId,
                        anStandort ? id(eltern) : null, anStandort ? null : id(eltern),
                        tag(iv.path("ab")), tag(iv.path("bis")), null));
            }
        }

        List<Anlage> anlagen = new ArrayList<>();
        List<AnlageStandortRepository.Zuordnung> anlageZuordnungen = new ArrayList<>();
        for (JsonNode a : s.path("anlagen")) {
            UUID siteId = id(a.path("kennzeichen").asText());
            anlagen.add(new Anlage(siteId, a.path("name").asText()));
            for (JsonNode iv : a.path("zuordnungen")) {
                anlageZuordnungen.add(new AnlageStandortRepository.Zuordnung(UUID.randomUUID(),
                        siteId, id(iv.path("eltern").asText()), tag(iv.path("ab")),
                        tag(iv.path("bis")), null));
            }
        }
        return new Zeilen(unternehmen, standorte, orte, ortZuordnungen, anlageZuordnungen,
                flaechen, anlagen);
    }

    private static JsonNode szenario(String name) throws IOException {
        JsonNode s = vektoren().path("szenarien").path(name);
        assertThat(s.isMissingNode()).as("Szenario %s", name).isFalse();
        return s;
    }

    private static synchronized JsonNode vektoren() throws IOException {
        if (vektoren == null) {
            vektoren = MAPPER.readTree(Files.readString(VEKTOREN));
        }
        return vektoren;
    }

    private static synchronized JsonNode referenz() throws IOException {
        if (referenz == null) {
            referenz = MAPPER.readTree(Files.readString(REFERENZ));
        }
        return referenz;
    }
}
