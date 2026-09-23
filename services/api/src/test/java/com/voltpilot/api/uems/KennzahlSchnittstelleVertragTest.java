package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.uems.KennzahlAbgelehnt.Ablehnung;
import com.voltpilot.api.web.dto.KennzahlDto;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Die Kennzahl-Schnittstelle (UEMS AP-11 IP-5) sagt an drei Stellen dasselbe: im Vertrag
 * ({@code kennzahl-vectors.json → schnittstelle}, {@code vokabulare}, {@code rechte}), in Java
 * ({@link KennzahlAbgelehnt}, {@link KennzahlRechte}, {@link KennzahlDto}) und in {@code docs/contracts/openapi.yaml};
 * dazu stehen die drei Rechte-Zeilen Zelle für Zelle wie in {@code rechte-matrix.json}. Rein — ohne Spring, ohne
 * Datenbank.
 */
class KennzahlSchnittstelleVertragTest {

    private static final Path CONTRACTS = Path.of("..", "..", "docs", "contracts");
    private static Map<String, Object> schemas;
    private static Map<String, Object> pfade;
    private static JsonNode vertrag;
    private static JsonNode matrix;

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void lies() throws Exception {
        try (InputStream in = Files.newInputStream(CONTRACTS.resolve("openapi.yaml"))) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
            pfade = (Map<String, Object>) openapi.get("paths");
        }
        ObjectMapper m = new ObjectMapper();
        vertrag = m.readTree(CONTRACTS.resolve("v2").resolve("kennzahl-vectors.json").toFile());
        matrix = m.readTree(CONTRACTS.resolve("v2").resolve("rechte-matrix.json").toFile());
    }

    /** Der geschlossene Satz: Vertrag = Java = OpenAPI — Code, Status, Herkunft des Satzes, Satz und Fakten. */
    @Test
    void derSatzDerAblehnungenIstUeberallDerselbe() {
        JsonNode ablehnungen = vertrag.path("schnittstelle").path("ablehnungen");
        List<String> imVertrag = ablehnungen.findValuesAsText("code");
        assertThat(KennzahlAbgelehnt.CODES).containsExactlyElementsOf(imVertrag);
        assertThat(liste(eigenschaft("KennzahlFehler", "code"), "enum")).containsExactlyElementsOf(imVertrag);
        for (JsonNode a : ablehnungen) {
            Ablehnung java = Ablehnung.vonCode(a.path("code").asText());
            assertThat(java.status()).as(java.code()).isEqualTo(a.path("status").asInt());
            assertThat(java.quelle()).as(java.code()).isEqualTo(a.path("quelle").asText());
            assertThat(java.satz()).as(java.code()).isEqualTo(a.path("satz").isNull() ? null : a.path("satz").asText());
            assertThat(java.fakten()).as(java.code()).containsExactlyElementsOf(texte(a.path("fakten")));
            // Nur die Schnittstelle spricht einen eigenen Satz; Regel und Rechte-Ableitung sprechen ihren.
            assertThat(java.satz() != null).as(java.code())
                    .isEqualTo(KennzahlAbgelehnt.QUELLE_SCHNITTSTELLE.equals(java.quelle()));
        }
    }

    /** Jeder Fehler-Code der Regeln ist eine Ablehnung — die Regel-Codes mit 422 und dem Satz der Regel. */
    @Test
    void jederFehlerDerRegelnIstEineAblehnung() {
        List<String> fehler = texte(vertrag.path("vokabulare").path("fehler"));
        assertThat(fehler).containsExactlyElementsOf(KennzahlRegeln.FEHLER);
        assertThat(KennzahlAbgelehnt.CODES).containsAll(fehler);
        for (String code : fehler) {
            Ablehnung a = Ablehnung.vonCode(code);
            if (!KennzahlRegeln.ANFRAGE_UNGUELTIG.equals(code)) {
                assertThat(a.status()).as(code).isEqualTo(422);
                assertThat(a.quelle()).as(code).isEqualTo(KennzahlAbgelehnt.QUELLE_REGEL);
            }
        }
        assertThat(Ablehnung.RECHT_FEHLT.quelle()).isEqualTo(KennzahlAbgelehnt.QUELLE_RECHTE);
    }

    /** Die Fakten einer Ablehnung stehen als Eigenschaften der Fehler-Form — in der Reihenfolge des Vertrags. */
    @Test
    void dieFaktenStehenInDerFehlerForm() {
        Set<String> erwartet = new LinkedHashSet<>(List.of("code", "message"));
        vertrag.path("schnittstelle").path("ablehnungen").forEach(a -> erwartet.addAll(texte(a.path("fakten"))));
        assertThat(eigenschaften("KennzahlFehler")).containsExactlyElementsOf(erwartet);
    }

    /** Die Wörter der Formen sind die Vokabulare und Kennungen des Vertrags. */
    @Test
    void dieWoerterSindDieDesVertrags() {
        JsonNode vok = vertrag.path("vokabulare");
        assertThat(liste(eigenschaft("KennzahlAnfrage", "geltung_art"), "enum")).containsExactlyElementsOf(texte(vok.path("geltung_art")));
        assertThat(liste(eigenschaft("KennzahlAnfrage", "periode_art"), "enum")).containsExactlyElementsOf(texte(vok.path("periode_art")));
        assertThat(liste(eigenschaft("KennzahlEingang", "rolle"), "enum")).containsExactlyElementsOf(texte(vok.path("eingang_rolle")));
        // Die ANFRAGE darf die Bezugsfläche eines Orts nennen; was gespeichert und geantwortet wird, ist eine Bezugsgröße.
        assertThat(liste(eigenschaft("KennzahlEingang", "art"), "enum"))
                .containsExactlyElementsOf(texte(vok.path("eingang_art_anfrage")));
        assertThat(liste(eigenschaft("KennzahlEingangAntwort", "art"), "enum"))
                .containsExactlyElementsOf(texte(vok.path("eingang_art")));
        assertThat(liste(eigenschaft("Kennzahl", "rechenform"), "enum")).containsExactlyElementsOf(texte(vok.path("rechenform")));
        assertThat(liste(eigenschaft("Kennzahl", "geltung_art"), "enum")).containsExactlyElementsOf(texte(vok.path("geltung_art")));
        assertThat(liste(eigenschaft("Kennzahl", "kennung"), "enum"))
                .containsExactlyInAnyOrder(KennzahlRechte.STANDORT_DEFINIEREN, KennzahlRechte.UNTERNEHMEN_DEFINIEREN);
        assertThat(texte(vertrag.path("rechte").path("kennung")))
                .containsExactlyInAnyOrder(KennzahlRechte.STANDORT_DEFINIEREN, KennzahlRechte.UNTERNEHMEN_DEFINIEREN);
        assertThat(vertrag.path("rechte").path("ansehen").asText()).isEqualTo(KennzahlRechte.ANSEHEN);
    }

    /**
     * Die Werte (IP-7) sprechen die Wörter des Vertrags: Periode, Zustand, Richtung und die Gründe ohne Zahl — dazu
     * genau die zwei Gründe des Lesers, die auch der Messstellen-Wert kennt; die Anlass-Arten der Tabelle; die Vorgänge
     * der Messstellen-Entscheidung plus die Berechnung.
     */
    @Test
    void dieWoerterDerWerteSindDieDesVertrags() {
        JsonNode vok = vertrag.path("vokabulare");
        assertThat(liste(eigenschaft("KennzahlWerte", "periode"), "enum")).containsExactlyElementsOf(texte(vok.path("periode_art")));
        assertThat(texte(vok.path("periode_art"))).containsExactlyElementsOf(KennzahlRegeln.PERIODEN);
        assertThat(liste(eigenschaft("KennzahlWert", "zustand"), "enum")).containsExactlyElementsOf(texte(vok.path("zustand")));
        assertThat(liste(eigenschaft("KennzahlWert", "richtung"), "enum"))
                .containsExactlyElementsOf(texte(vok.path("richtung_unsicherheit")));
        List<String> gruende = new ArrayList<>(texte(vok.path("grund_ohne_zahl")));
        gruende.addAll(KennzahlWerteService.GRUENDE_DES_LESERS);
        assertThat(liste(eigenschaft("KennzahlWert", "grund"), "enum")).containsExactlyElementsOf(gruende);
        assertThat(liste(eigenschaft("MessstelleWerteWert", "grund"), "enum"))
                .containsAll(KennzahlWerteService.GRUENDE_DES_LESERS);
        assertThat(liste(eigenschaft("KennzahlWertAnlass", "art"), "enum"))
                .containsExactlyElementsOf(KennzahlWerteService.ANLASS_ARTEN);
        assertThat(liste(eigenschaft("KennzahlWertEntscheidung", "vorgang"), "enum"))
                .containsExactlyElementsOf(KennzahlWerteService.VORGAENGE);
        assertThat(liste(eigenschaft("MessstelleWerteEntscheidung", "vorgang"), "enum"))
                .containsExactlyElementsOf(KennzahlWerteService.VORGAENGE.subList(0, 2));
    }

    /** Jede Form der Antwort und der Anfrage hat in OpenAPI genau die Felder des DTO (snake_case, Reihenfolge). */
    @Test
    void dieFormenSindZeichengleich() {
        Map<String, Class<? extends Record>> formen = Map.ofEntries(
                Map.entry("KennzahlEingang", KennzahlDto.Eingang.class),
                Map.entry("KennzahlAnfrage", KennzahlDto.Anfrage.class),
                Map.entry("KennzahlStammdatenAnfrage", KennzahlDto.StammdatenAnfrage.class),
                Map.entry("KennzahlFassungAnfrage", KennzahlDto.FassungAnfrage.class),
                Map.entry("KennzahlPerson", KennzahlDto.Person.class),
                Map.entry("KennzahlEingangAntwort", KennzahlDto.EingangAntwort.class),
                Map.entry("KennzahlFassung", KennzahlDto.Fassung.class),
                Map.entry("Kennzahl", KennzahlDto.Kennzahl.class),
                Map.entry("KennzahlBezugsbasis", KennzahlDto.Bezugsbasis.class),
                Map.entry("KennzahlListe", KennzahlDto.Liste.class),
                Map.entry("KennzahlZugriffHinweis", KennzahlDto.ZugriffHinweis.class),
                Map.entry("KennzahlPaare", KennzahlDto.Paare.class),
                Map.entry("KennzahlPaarGruppe", KennzahlDto.PaarGruppe.class),
                Map.entry("KennzahlFassungen", KennzahlDto.Fassungen.class),
                Map.entry("KennzahlBerechnung", KennzahlDto.Berechnung.class),
                Map.entry("KennzahlBefund", KennzahlDto.Befund.class),
                Map.entry("KennzahlVorschauPeriode", KennzahlDto.VorschauPeriode.class),
                Map.entry("KennzahlVorschau", KennzahlDto.Vorschau.class),
                Map.entry("KennzahlWerteKennzahl", KennzahlDto.WerteKennzahl.class),
                Map.entry("KennzahlWerte", KennzahlDto.Werte.class),
                Map.entry("KennzahlGeteiltesRegister", KennzahlDto.GeteiltesRegister.class),
                Map.entry("KennzahlWert", KennzahlDto.Wert.class),
                Map.entry("KennzahlWerteHistorie", KennzahlDto.Historie.class),
                Map.entry("KennzahlWertVersion", KennzahlDto.Version.class),
                Map.entry("KennzahlWertAnlass", KennzahlDto.Anlass.class),
                Map.entry("KennzahlWertEntscheidung", KennzahlDto.Entscheidung.class));
        formen.forEach((schema, dto) -> {
            List<String> felder = new ArrayList<>();
            Arrays.stream(dto.getRecordComponents()).forEach(c -> felder.add(
                    PropertyNamingStrategies.SnakeCaseStrategy.INSTANCE.translate(c.getName())));
            assertThat(eigenschaften(schema)).as(schema).containsExactlyElementsOf(felder);
        });
    }

    /** Die Routen des Pakets — und keine weitere Methode. */
    @Test
    @SuppressWarnings("unchecked")
    void dieRoutenStehenInOpenApi() {
        Map<String, List<String>> erwartet = Map.ofEntries(
                Map.entry("/api/v1/kennzahlen", List.of("get", "post")),
                Map.entry("/api/v1/kennzahlen/vorschau", List.of("post")),
                Map.entry("/api/v1/kennzahlen/paare", List.of("parameters", "get")),
                Map.entry("/api/v1/kennzahlen/{id}", List.of("parameters", "get", "put", "delete")),
                Map.entry("/api/v1/kennzahlen/{id}/archivieren", List.of("parameters", "post")),
                Map.entry("/api/v1/kennzahlen/{id}/fassungen", List.of("parameters", "get", "post")),
                Map.entry("/api/v1/kennzahlen/{id}/berechnung", List.of("parameters", "get")),
                Map.entry("/api/v1/kennzahlen/{id}/werte", List.of("parameters", "get")),
                Map.entry("/api/v1/kennzahlen/{id}/werte/versionen", List.of("parameters", "get")),
                Map.entry("/api/v1/kennzahlen/{id}/variablen-vorschlag", List.of("parameters", "get")),
                Map.entry("/api/v1/kennzahlen/{id}/faktoren-vorschlag", List.of("parameters", "get")));
        erwartet.forEach((pfad, methoden) -> assertThat(((Map<String, Object>) pfade.get(pfad)).keySet()).as(pfad)
                .containsExactlyInAnyOrderElementsOf(methoden));
        // Die Bezugsbasis an der Kennzahl (AP-17 IP-7) hält BezugsbasisGrundlageTest fest.
        assertThat(pfade.keySet().stream().filter(p -> p.startsWith("/api/v1/kennzahlen"))
                .filter(p -> !p.contains("/bezugsbasen")).toList())
                .containsExactlyInAnyOrderElementsOf(erwartet.keySet());
    }

    /** Die drei Zeilen von {@link KennzahlRechte#MATRIX} sind die der Rechte-Matrix, Zelle für Zelle. */
    @Test
    void dieRechteZeilenSindDieDerMatrix() {
        List<String> gesehen = new ArrayList<>();
        for (JsonNode aktion : matrix.path("aktionen")) {
            String kennung = aktion.path("kennung").asText();
            RechteAbleitung.Aktion java = KennzahlRechte.MATRIX.aktionen().get(kennung);
            if (java == null) {
                continue;
            }
            gesehen.add(kennung);
            aktion.path("zellen").fields().forEachRemaining(z -> assertThat(java.zellen()
                    .get(RechteAbleitung.Rolle.vonCode(z.getKey()))).as(kennung + " " + z.getKey())
                    .isEqualTo(RechteAbleitung.Zelle.vonCode(z.getValue().asText())));
        }
        assertThat(gesehen).containsExactlyInAnyOrder(KennzahlRechte.STANDORT_DEFINIEREN,
                KennzahlRechte.UNTERNEHMEN_DEFINIEREN, KennzahlRechte.ANSEHEN);
    }

    @SuppressWarnings("unchecked")
    private static List<String> eigenschaften(String schema) {
        Map<String, Object> s = (Map<String, Object>) schemas.get(schema);
        assertThat(s).as(schema).isNotNull();
        return new ArrayList<>(((Map<String, Object>) s.get("properties")).keySet());
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> eigenschaft(String schema, String feld) {
        Map<String, Object> s = (Map<String, Object>) schemas.get(schema);
        assertThat(s).as(schema).isNotNull();
        return (Map<String, Object>) ((Map<String, Object>) s.get("properties")).get(feld);
    }

    @SuppressWarnings("unchecked")
    private static List<String> liste(Map<String, Object> knoten, String... pfad) {
        Object o = knoten;
        for (String schritt : pfad) {
            o = ((Map<String, Object>) o).get(schritt);
        }
        return ((List<Object>) o).stream().map(String::valueOf).toList();
    }

    private static List<String> texte(JsonNode array) {
        List<String> aus = new ArrayList<>();
        array.forEach(x -> aus.add(x.asText()));
        return aus;
    }
}
