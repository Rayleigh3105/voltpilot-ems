package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.KennzahlVorlagen.Erwartung;
import com.voltpilot.api.uems.KennzahlVorlagen.Vorlage;
import com.voltpilot.api.web.dto.KennzahlDto;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Der Vorlagen-Katalog der Kennzahlen (UEMS AP-11 IP-10, §4.12, E9 = A) gegen sein Schema, die Wörter seiner
 * Nachbarverträge, die Einheiten-Regel, OpenAPI und den Referenzfall K20. Rein: liest Dateien und ruft Regeln (kein
 * Spring, keine DB). Die Portal-Kopie hält {@code kennzahlVorlagen.sync.test.ts} byte-gleich; die Route und die
 * Vorschau aus einer Vorlage fährt {@code KennzahlApiTest}.
 */
class KennzahlVorlagenTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    // Arbeitsverzeichnis ist services/api; das Repo-Wurzelverzeichnis liegt zwei Ebenen darüber.
    private static final Path CONTRACTS = Path.of("..", "..", "docs", "contracts");
    private static final Path V2 = CONTRACTS.resolve("v2");
    private static final Path KATALOG = Path.of("src", "main", "resources", "kennzahlen", "kennzahl-vorlagen.json");
    private static final Path SCHEMA = V2.resolve("kennzahl-vorlagen.schema.json");

    /** §4.12, in seiner Reihenfolge. */
    private static final List<String> ACHT = List.of("stromeinsatz_je_stueck", "stromeinsatz_je_kg",
            "stromeinsatz_je_betriebsstunde", "stromeinsatz_je_m2", "stromeinsatz_je_mitarbeitenden",
            "anteil_am_netzbezug", "autarkiegrad", "eigenverbrauchsanteil");

    private static final KennzahlVorlagen VORLAGEN = new KennzahlVorlagen(MAPPER);

    static JsonNode lies(Path p) throws Exception {
        return MAPPER.readTree(Files.readString(p));
    }

    @Test
    void derKatalogErfuelltSeinSchema() throws Exception {
        assertThat(UemsSchemaLaeufer.verstoesse(lies(KATALOG), lies(SCHEMA))).isEmpty();
    }

    /** Der Wächter beißt: jede dieser Verletzungen fällt dem Schema auf. */
    @Test
    void dasSchemaBeisst() throws Exception {
        List<Consumer<ObjectNode>> verletzungen = List.of(
                v -> v.remove("hilfesatz"),
                v -> v.put("name_vorschlag", "Stromeinsatz je Stück"),
                v -> v.put("rechenform", "zusammenfassung"),
                v -> v.put("farbe", "blau"),
                v -> ((ArrayNode) v.get("zaehler_erwartung").get("wertarten")).add("Momentanwert"),
                v -> ((ArrayNode) v.get("nenner_erwartung").get("wertarten")).add("stand"),
                v -> ((ObjectNode) v.get("nenner_erwartung")).putArray("bezugsgroesse_arten").add("stueckzahl"));
        for (Consumer<ObjectNode> verletze : verletzungen) {
            ObjectNode datei = (ObjectNode) lies(KATALOG);
            verletze.accept((ObjectNode) datei.get("vorlagen").get(0));
            assertThat(UemsSchemaLaeufer.verstoesse(datei, lies(SCHEMA))).isNotEmpty();
        }
    }

    @Test
    void esSindDieAchtVorlagenAusParagraf412() {
        assertThat(VORLAGEN.alle().stream().map(Vorlage::kennung).toList()).isEqualTo(ACHT);
    }

    /** Die Aufzählungen des Schemas sind die Wörter der Nachbarverträge — keine Kopie läuft still auseinander. */
    @Test
    void dieWoerterDesSchemasSindDieDerNachbarvertraege() throws Exception {
        JsonNode defs = lies(SCHEMA).path("$defs");
        JsonNode messstelle = lies(V2.resolve("messstelle.schema.json")).path("$defs");
        JsonNode bezugsdaten = lies(V2.resolve("bezugsdaten-vectors.json"));
        assertThat(texte(defs.at("/messstelle_erwartung/properties/groesse/enum")))
                .isEqualTo(texte(messstelle.at("/groesseName/enum")));
        assertThat(texte(defs.at("/messstelle_erwartung/properties/richtungen/anyOf/0/items/enum")))
                .isEqualTo(texte(messstelle.at("/richtung/enum")));
        assertThat(texte(defs.at("/messstelle_erwartung/properties/messstelle_arten/items/enum")))
                .isEqualTo(texte(messstelle.at("/art/enum")));
        // U3: jede Wertart außer dem Momentanwert bzw. dem Stand.
        assertThat(texte(defs.at("/messstelle_erwartung/properties/wertarten/items/enum")))
                .isEqualTo(ohne(texte(messstelle.at("/wertart/enum")), "Momentanwert"));
        assertThat(texte(defs.at("/bezugsgroesse_erwartung/properties/wertarten/items/enum")))
                .isEqualTo(ohne(texte(bezugsdaten.at("/vokabulare/wertart")), "stand"));
        List<String> arten = new ArrayList<>();
        bezugsdaten.at("/arten/je_art").fieldNames().forEachRemaining(arten::add);
        assertThat(texte(defs.at("/bezugsgroesse_erwartung/properties/bezugsgroesse_arten/items/enum"))).isEqualTo(arten);
        assertThat(texte(lies(V2.resolve("kennzahl-vectors.json")).at("/vokabulare/rechenform")))
                .containsAll(texte(defs.at("/vorlage/properties/rechenform/enum")));
    }

    /** Größe, Richtung und Wertart stehen im Größen-Katalog; Einheit und Wertart der Bezugsgröße bei jeder ihrer Arten. */
    @Test
    void jedeErwartungPasstZuIhremKatalog() throws Exception {
        JsonNode jeArt = lies(V2.resolve("bezugsdaten-vectors.json")).at("/arten/je_art");
        for (Vorlage v : VORLAGEN.alle()) {
            for (Erwartung e : List.of(v.zaehler(), v.nenner())) {
                String wo = v.kennung() + " · " + e.satz();
                if (KennzahlRegeln.MESSSTELLE.equals(e.art())) {
                    MessstelleRegeln.KatalogEintrag k = katalog(e.groesse());
                    if (e.richtungen() != null) {
                        assertThat(k.richtungen()).as(wo).containsAll(e.richtungen());
                    }
                    assertThat(k.wertarten()).as(wo).containsAll(e.wertarten());
                } else {
                    assertThat(e.art()).as(wo).isEqualTo(KennzahlRegeln.BEZUGSGROESSE);
                    for (String art : e.bezugsgroesseArten()) {
                        JsonNode a = jeArt.path(art);
                        assertThat(texte(a.path("einheiten"))).as(wo + " · " + art).containsAll(e.einheiten());
                        assertThat(e.wertarten()).as(wo + " · " + art).containsOnly(a.path("wertart").asText());
                    }
                }
            }
        }
    }

    /**
     * Jede Vorlage ist mit den Regeln bildbar: die Rechenform ist gebaut, und die Einheiten-Regel U1–U3 nimmt JEDE
     * erwartete Seite an — ein Anteil gibt %, ein Quotient das ungekürzte Paar. Das Komplement gibt es nur beim Anteil.
     */
    @Test
    void jedeVorlageBestehtDieEinheitenRegel() {
        for (Vorlage v : VORLAGEN.alle()) {
            assertThat(KennzahlRegeln.rechenform(v.rechenform()).fehler()).as(v.kennung()).isNull();
            boolean anteil = KennzahlRegeln.ANTEIL.equals(v.rechenform());
            if (!anteil) {
                assertThat(v.komplement()).as(v.kennung() + ": Komplement nur beim Anteil").isFalse();
            }
            for (KennzahlRegeln.EinheitSeite z : seiten(v.zaehler(), "Menge")) {
                for (KennzahlRegeln.EinheitSeite n : seiten(v.nenner(), "Bezug")) {
                    KennzahlRegeln.EinheitUrteil u = KennzahlRegeln.einheit(v.rechenform(), z, n, List.of());
                    String wo = v.kennung() + " · " + z + " · " + n;
                    assertThat(u.fehler()).as(wo + " → " + u.kundensatz()).isNull();
                    if (anteil) {
                        assertThat(u.einheit()).as(wo).isEqualTo(ErgebnisZustand.PROZENT);
                    } else {
                        assertThat(u.einheit()).as(wo).startsWith(katalog(z.groesse()).einheit() + "/");
                    }
                }
            }
        }
    }

    /**
     * K20: die Vorlage „Stromeinsatz je Stück“ steht im Katalog so, wie der Fall sie nennt (vorlage_gefunden), mit
     * der Einheiten-Erwartung der Schritte 2 und 3 — und belegt „Halle 2“ so vor, wie die Vektor-Prüfung es verlangt.
     * Eine Kopie der so angelegten Kennzahl tauscht nur den Geltungsbereich im Namen und beginnt bei Fassung 1.
     */
    @Test
    void k20DieVorlageBelegtVorWieDerFall() throws Exception {
        JsonNode pruefung = null;
        for (JsonNode fall : lies(V2.resolve("kennzahl-vectors.json")).path("cases")) {
            for (JsonNode p : fall.path("pruefungen")) {
                if ("K20".equals(fall.path("id").asText()) && "vorlage".equals(p.path("regel").asText())) {
                    pruefung = p;
                }
            }
        }
        assertThat(pruefung).as("K20 hat eine Prüfung der Regel vorlage").isNotNull();
        JsonNode soll = pruefung.at("/eingang/vorlage");
        Vorlage v = VORLAGEN.vorlage(soll.path("kennung").asText()).orElseThrow();
        assertThat(v.rechenform()).isEqualTo(soll.path("rechenform").asText());
        assertThat(v.nameVorschlag()).isEqualTo(soll.path("name_vorschlag").asText());
        assertThat(v.zweckVorschlag()).isEqualTo(soll.path("zweck_vorschlag").asText());
        // Schritt 2 filtert auf Messstellen mit Wirkenergie · Bezug, Schritt 3 auf Bezugsgrößen in Stück.
        assertThat(v.zaehler().art()).isEqualTo(KennzahlRegeln.MESSSTELLE);
        assertThat(v.zaehler().messstelleArten()).containsExactly("gemessen", "berechnet");
        assertThat(v.zaehler().groesse()).isEqualTo("Wirkenergie");
        assertThat(v.zaehler().richtungen()).containsExactly("Bezug");
        assertThat(v.nenner().art()).isEqualTo(KennzahlRegeln.BEZUGSGROESSE);
        assertThat(v.nenner().bezugsgroesseArten()).containsExactly("gutteile", "produktionsmenge");
        assertThat(v.nenner().einheiten()).containsExactly("Stück");

        String halle = pruefung.at("/eingang/geltung_name").asText();
        KennzahlDto.Anfrage a = KennzahlVorlagen.vorbelegung(v, "gebaeude", "00000000-0000-0000-0000-000000000002", halle);
        JsonNode erwartet = pruefung.path("ergebnis");
        assertThat(a.rechenform()).isEqualTo(erwartet.path("rechenform").asText());
        assertThat(a.name()).isEqualTo(erwartet.path("name").asText());
        assertThat(a.zweck()).isEqualTo(erwartet.path("zweck").asText());
        assertThat(a.kennzeichen()).as("der Server vergibt").isNull();
        assertThat(a.verantwortlichName()).as("der Aufrufer ist verantwortlich").isNull();
        assertThat(a.periodeArt()).isNull();
        assertThat(a.komplement()).as("kein Komplement am Quotienten").isNull();
        assertThat(a.eingaenge()).as("die Eingänge bindet der Kunde").isEmpty();

        KennzahlRegeln.Kopie kopie = KennzahlRegeln.kopie(
                new KennzahlRegeln.Quelle("KZ-0001", a.name(), a.zweck(), a.rechenform(), halle), "Montagehalle Lindach");
        assertThat(kopie.name()).isEqualTo("Stromeinsatz je Stück — Montagehalle Lindach");
        assertThat(kopie.fassungNummer()).isEqualTo(1);
        assertThat(kopie.kennzeichen()).isNull();
        assertThat(kopie.eingaenge()).isEmpty();
    }

    /** Jede Vorlage belegt ohne Platzhalter vor, und jede so angelegte Kennzahl lässt sich für einen anderen Ort kopieren. */
    @Test
    void jedeVorbelegungLaesstSichKopieren() {
        for (Vorlage v : VORLAGEN.alle()) {
            KennzahlDto.Anfrage a = KennzahlVorlagen.vorbelegung(v, "standort", "00000000-0000-0000-0000-000000000001",
                    "Werk Ahrenberg");
            assertThat(a.name()).as(v.kennung()).doesNotContain("{").endsWith(" — Werk Ahrenberg");
            assertThat(a.komplement()).as(v.kennung())
                    .isEqualTo(KennzahlRegeln.ANTEIL.equals(v.rechenform()) ? Boolean.valueOf(v.komplement()) : null);
            KennzahlRegeln.Kopie k = KennzahlRegeln.kopie(
                    new KennzahlRegeln.Quelle("KZ-0001", a.name(), a.zweck(), a.rechenform(), "Werk Ahrenberg"), "Werk Lindach");
            assertThat(k.name()).as(v.kennung()).isEqualTo(v.nameVorschlag().replace(KennzahlVorlagen.PLATZHALTER, "Werk Lindach"));
        }
    }

    /** Die Route antwortet Knoten für Knoten die Datei ohne Entwickler-Felder, und OpenAPI nennt dieselben Felder. */
    @Test
    @SuppressWarnings("unchecked")
    void dieRouteGibtDieDateiUndOpenApiNenntIhreFelder() throws Exception {
        JsonNode datei = lies(KATALOG);
        JsonNode antwort = VORLAGEN.katalog();
        assertThat(felder(antwort)).containsExactly("schema_version", "vorlagen");
        assertThat(antwort.path("vorlagen")).isEqualTo(datei.path("vorlagen"));

        Map<String, Object> openapi;
        try (InputStream in = Files.newInputStream(CONTRACTS.resolve("openapi.yaml"))) {
            openapi = new Yaml().load(in);
        }
        Map<String, Object> pfade = (Map<String, Object>) openapi.get("paths");
        Map<String, Object> schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
        assertThat(((Map<String, Object>) pfade.get("/api/v1/kennzahl-vorlagen")).keySet()).containsExactly("get");
        JsonNode defs = lies(SCHEMA).path("$defs");
        assertThat(eigenschaften(schemas, "KennzahlVorlagen")).containsExactly("schema_version", "vorlagen");
        assertThat(eigenschaften(schemas, "KennzahlVorlage")).isEqualTo(felder(defs.at("/vorlage/properties")));
        assertThat(eigenschaften(schemas, "KennzahlVorlageMessstelle"))
                .isEqualTo(felder(defs.at("/messstelle_erwartung/properties")));
        assertThat(eigenschaften(schemas, "KennzahlVorlageBezugsgroesse"))
                .isEqualTo(felder(defs.at("/bezugsgroesse_erwartung/properties")));
    }

    private static List<KennzahlRegeln.EinheitSeite> seiten(Erwartung e, String objekt) {
        List<KennzahlRegeln.EinheitSeite> aus = new ArrayList<>();
        for (String wertart : e.wertarten()) {
            if (KennzahlRegeln.MESSSTELLE.equals(e.art())) {
                aus.add(new KennzahlRegeln.EinheitSeite(e.art(), objekt, katalog(e.groesse()).einheit(), e.groesse(), wertart));
            } else {
                for (String einheit : e.einheiten()) {
                    aus.add(new KennzahlRegeln.EinheitSeite(e.art(), objekt, einheit, null, wertart));
                }
            }
        }
        assertThat(aus).as(e.satz()).isNotEmpty();
        return aus;
    }

    private static MessstelleRegeln.KatalogEintrag katalog(String groesse) {
        return MessstelleRegeln.GROESSEN_KATALOG.stream().filter(k -> k.groesse().equals(groesse)).findFirst()
                .orElseThrow(() -> new AssertionError("Größe nicht im Katalog: " + groesse));
    }

    @SuppressWarnings("unchecked")
    private static List<String> eigenschaften(Map<String, Object> schemas, String name) {
        Map<String, Object> s = (Map<String, Object>) schemas.get(name);
        assertThat(s).as(name).isNotNull();
        return new ArrayList<>(((Map<String, Object>) s.get("properties")).keySet());
    }

    private static List<String> felder(JsonNode n) {
        List<String> aus = new ArrayList<>();
        n.fieldNames().forEachRemaining(aus::add);
        return aus;
    }

    private static List<String> texte(JsonNode liste) {
        List<String> aus = new ArrayList<>();
        liste.forEach(x -> aus.add(x.asText()));
        return aus;
    }

    private static List<String> ohne(List<String> liste, String wort) {
        return liste.stream().filter(x -> !x.equals(wort)).toList();
    }
}
