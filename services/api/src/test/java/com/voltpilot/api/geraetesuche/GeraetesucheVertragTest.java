package com.voltpilot.api.geraetesuche;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.voltpilot.api.uems.UemsSchemaLaeufer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.function.BiFunction;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Rein, ohne Docker: der Vertrag mqtt-geraetesuche 1.0 aus Sicht der API - Wörter und Grenzen wie in
 * {@code geraetesuche-vectors.json}, jeder Fall gegen die drei Schemas, der Auftrag in der gesendeten Form und das
 * tolerante Lesen von Zwischenstand und Ergebnis (Fallklassen gueltig, ungueltig, fund_ueberlesen, toleriert).
 */
class GeraetesucheVertragTest {

    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final ObjectMapper JSON = new ObjectMapper();
    /** Schreibt die gelesenen Records zurück in die MQTT-Form. */
    private static final ObjectMapper MQTT = JsonMapper.builder().addModule(new JavaTimeModule())
            .propertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE)
            .serializationInclusion(JsonInclude.Include.NON_NULL)
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS).build();
    private static final List<String> KLASSEN = List.of("gueltig", "ungueltig", "fund_ueberlesen", "toleriert");

    private static JsonNode vektoren;
    private static JsonNode schemaAuftrag;
    private static JsonNode schemaStand;
    private static JsonNode schemaErgebnis;

    @BeforeAll
    static void lade() throws Exception {
        vektoren = lies("geraetesuche-vectors.json");
        schemaAuftrag = lies("mqtt-geraetesuche.schema.json");
        schemaStand = lies("mqtt-geraetesuche-stand.schema.json");
        schemaErgebnis = lies("mqtt-geraetesuche-ergebnis.schema.json");
    }

    private static JsonNode lies(String datei) throws Exception {
        return JSON.readTree(Files.readString(V2.resolve(datei)));
    }

    private static List<String> texte(JsonNode n) {
        List<String> out = new ArrayList<>();
        n.forEach(x -> out.add(x.isNull() ? null : x.asText()));
        return out;
    }

    @Test
    void woerterUndGrenzenSindDieDerVektoren() {
        JsonNode g = vektoren.path("grenzen");
        assertThat(g.path("frist_s").asLong()).isEqualTo(GeraetesucheVertrag.FRIST.toSeconds());
        assertThat(g.path("stand_takt_s").asLong()).isEqualTo(GeraetesucheVertrag.STAND_TAKT.toSeconds());
        assertThat(g.path("max_dauer_s").asLong()).isEqualTo(GeraetesucheVertrag.MAX_DAUER.toSeconds());
        assertThat(g.path("max_je_stunde").asInt()).isEqualTo(GeraetesucheVertrag.MAX_JE_STUNDE);
        assertThat(g.path("max_netze").asInt()).isEqualTo(GeraetesucheVertrag.MAX_NETZE);
        assertThat(g.path("max_praefix").asInt()).isEqualTo(GeraetesucheVertrag.MAX_PRAEFIX);
        assertThat(g.path("max_funde").asInt()).isEqualTo(GeraetesucheVertrag.MAX_FUNDE);
        assertThat(g.path("max_merkmale").asInt()).isEqualTo(GeraetesucheVertrag.MAX_MERKMALE);
        assertThat(g.path("keine_antwort_s").asLong()).isEqualTo(GeraetesucheVertrag.KEINE_ANTWORT.toSeconds());
        assertThat(texte(vektoren.path("erkenner"))).isEqualTo(GeraetesucheVertrag.ERKENNER);
        assertThat(texte(vektoren.path("wege").path("namen"))).isEqualTo(GeraetesucheVertrag.WEGE);
        assertThat(texte(vektoren.path("netztechnik_arten"))).isEqualTo(GeraetesucheVertrag.NETZTECHNIK_ARTEN);
        assertThat(texte(vektoren.path("weitere_arten"))).isEqualTo(GeraetesucheVertrag.WEITERE_ARTEN);
        assertThat(vektoren.path("gruende").fieldNames()).toIterable()
                .containsExactlyElementsOf(GeraetesucheVertrag.GRUENDE.keySet());
        GeraetesucheVertrag.GRUENDE.forEach((z, gr) -> assertThat(texte(vektoren.path("gruende").path(z))).isEqualTo(gr));
        JsonNode api = vektoren.path("api");
        assertThat(texte(api.path("gruppen"))).isEqualTo(GeraetesucheVertrag.GRUPPEN);
        assertThat(texte(api.path("abgleich"))).isEqualTo(GeraetesucheVertrag.ABGLEICH);
        assertThat(texte(api.path("zustand"))).isEqualTo(GeraetesucheVertrag.ZUSTAENDE_API);
        assertThat(texte(api.path("fehler_start").path("409"))).isEqualTo(GeraetesucheVertrag.FEHLER_409);
        assertThat(texte(api.path("fehler_start").path("429"))).isEqualTo(GeraetesucheVertrag.FEHLER_429);

        List<GeraetesucheVertrag.KatalogZeile> katalog = new ArrayList<>();
        for (JsonNode z : vektoren.path("erkennungskatalog")) {
            katalog.add(new GeraetesucheVertrag.KatalogZeile(z.path("erkenner").asText(), z.path("art").asText(),
                    z.path("schnitt").asInt(), z.path("communication").textValue(), z.path("docker").textValue(),
                    z.path("edge_light").textValue()));
        }
        assertThat(katalog).isEqualTo(GeraetesucheVertrag.KATALOG);
        for (GeraetesucheVertrag.KatalogZeile z : katalog) {
            assertThat(GeraetesucheVertrag.WEGE).doesNotContain(z.erkenner());
            assertThat(GeraetesucheVertrag.ARTEN).contains(z.art());
            if (z.communication() != null) {
                assertThat(GeraetesucheVertrag.COMMUNICATIONS).contains(z.communication());
            }
        }
        // DP-3 A: Personen-Geräte sind nie eine Art eines Fundes.
        assertThat(GeraetesucheVertrag.ARTEN).doesNotContainAnyElementsOf(GeraetesucheVertrag.WEITERE_ARTEN);
    }

    @Test
    void dieSchemasNennenDieselbenWoerter() {
        JsonNode defs = schemaStand.path("$defs");
        assertThat(texte(schemaAuftrag.at("/$defs/erkenner/enum"))).isEqualTo(GeraetesucheVertrag.ERKENNER);
        assertThat(texte(schemaErgebnis.at("/$defs/erkenner/enum"))).isEqualTo(GeraetesucheVertrag.ERKENNER);
        List<String> fundErkenner = new ArrayList<>(GeraetesucheVertrag.ERKENNER);
        fundErkenner.removeAll(GeraetesucheVertrag.WEGE);
        assertThat(texte(defs.at("/erkenner_fund/enum"))).isEqualTo(fundErkenner);
        assertThat(texte(defs.at("/art/enum"))).isEqualTo(GeraetesucheVertrag.ARTEN);
        assertThat(texte(defs.at("/anbindung/enum"))).isEqualTo(GeraetesucheVertrag.ANBINDUNGEN);
        assertThat(texte(defs.at("/fund/properties/erkennung/enum"))).isEqualTo(GeraetesucheVertrag.ERKENNUNGEN);
        assertThat(texte(defs.at("/fund/properties/hindernis/enum"))).isEqualTo(GeraetesucheVertrag.HINDERNISSE);
        assertThat(texte(defs.at("/verbindung/properties/communication/enum")))
                .isEqualTo(GeraetesucheVertrag.COMMUNICATIONS);
        assertThat(texte(defs.at("/netz/properties/rolle/enum"))).isEqualTo(GeraetesucheVertrag.ROLLEN);
        assertThat(texte(schemaStand.at("/properties/schritt/enum"))).isEqualTo(GeraetesucheVertrag.SCHRITTE);
        assertThat(texte(schemaErgebnis.at("/properties/zustand/enum")))
                .containsExactlyInAnyOrderElementsOf(GeraetesucheVertrag.GRUENDE.keySet());
        List<String> gruende = new ArrayList<>();
        GeraetesucheVertrag.GRUENDE.values().forEach(gruende::addAll);
        assertThat(texte(schemaErgebnis.at("/properties/grund/enum"))).isEqualTo(gruende);
        assertThat(iterable(schemaErgebnis.at("/$defs/weitere/properties")))
                .isEqualTo(GeraetesucheVertrag.WEITERE_ARTEN);
        // Jede Form, die beide Bericht-Schemas tragen, ist EINE Form.
        schemaStand.path("$defs").fieldNames().forEachRemaining(k ->
                assertThat(schemaErgebnis.path("$defs").path(k)).as(k).isEqualTo(schemaStand.path("$defs").path(k)));
    }

    private static List<String> iterable(JsonNode objekt) {
        List<String> out = new ArrayList<>();
        objekt.fieldNames().forEachRemaining(out::add);
        return out;
    }

    @Test
    void jederFallHaeltSichAnDasSchemaWieAngegeben() {
        int geprueft = 0;
        for (String familie : List.of("auftrag", "stand", "ergebnis")) {
            JsonNode schema = switch (familie) {
                case "auftrag" -> schemaAuftrag;
                case "stand" -> schemaStand;
                default -> schemaErgebnis;
            };
            for (String klasse : KLASSEN) {
                for (JsonNode c : vektoren.path(familie).path(klasse)) {
                    List<String> v = UemsSchemaLaeufer.verstoesse(c.path("payload"), schema);
                    boolean lehntAb = !"gueltig".equals(klasse) && c.path("schema_lehnt_ab").asBoolean(false);
                    assertThat(v.isEmpty()).as(familie + "/" + c.path("name").asText() + " " + v).isEqualTo(!lehntAb);
                    geprueft++;
                }
            }
        }
        assertThat(geprueft).isGreaterThan(50);
    }

    @Test
    void derAuftragDerApiIstDieGesendeteForm() {
        for (JsonNode c : vektoren.path("auftrag").path("gueltig")) {
            JsonNode p = c.path("payload");
            UUID t = UUID.fromString(p.path("tenant_id").asText());
            UUID s = UUID.fromString(p.path("site_id").asText());
            UUID d = UUID.fromString(p.path("device_id").asText());
            UUID such = UUID.fromString(p.path("such_id").asText());
            Instant am = Instant.parse(p.path("ausgeloest_am").asText());
            String von = p.path("ausgeloest_von").textValue();
            GeraetesucheAuftrag a = "abbrechen".equals(p.path("aktion").asText())
                    ? GeraetesucheAuftrag.abbrechen(t, s, d, such, am, von)
                    : GeraetesucheAuftrag.starten(t, s, d, such, am,
                            p.has("erkenner") ? texte(p.path("erkenner")) : null, von);
            assertThat(a.json(JSON)).as(c.path("name").asText()).isEqualTo(p);
            assertThat(a.topic()).isEqualTo(c.path("topic").asText());
            assertThat(UemsSchemaLaeufer.verstoesse(a.json(JSON), schemaAuftrag)).isEmpty();
        }
    }

    @Test
    void zwischenstandUndErgebnisLiestDieApiTolerant() throws Exception {
        pruefeLeser("stand", (topic, payload) -> GeraetesucheBericht.stand(topic, payload, JSON));
        pruefeLeser("ergebnis", (topic, payload) -> GeraetesucheBericht.ergebnis(topic, payload, JSON));
    }

    private void pruefeLeser(String familie, BiFunction<String, byte[], Object> leser) throws Exception {
        for (String klasse : KLASSEN) {
            for (JsonNode c : vektoren.path(familie).path(klasse)) {
                String name = familie + "/" + c.path("name").asText();
                Object gelesen = leser.apply(c.path("topic").asText(), JSON.writeValueAsBytes(c.path("payload")));
                if ("ungueltig".equals(klasse)) {
                    assertThat(gelesen).as(name).isNull();
                    continue;
                }
                assertThat(gelesen).as(name).isNotNull();
                ObjectNode erwartet = c.path("payload").deepCopy();
                erwartet.remove("schema_version");
                List<String> ueberlesen = texte(c.path("ueberlesen"));
                if ("fund_ueberlesen".equals(klasse)) {
                    ArrayNode funde = (ArrayNode) erwartet.path("funde");
                    for (int i = ueberlesen.size() - 1; i >= 0; i--) {
                        funde.remove(Integer.parseInt(ueberlesen.get(i)));
                    }
                } else if ("toleriert".equals(klasse)) {
                    ueberlesen.forEach(pfad -> entferne(erwartet, pfad));
                }
                // Was der Leser behält, ist genau die gesendete Form ohne das Überlesene - nicht mehr (keine MAC),
                // nicht weniger.
                assertThat(JSON.readTree(MQTT.writeValueAsString(gelesen))).as(name).isEqualTo(erwartet);
                int gezaehlt = gelesen instanceof GeraetesucheBericht.Stand st ? st.ueberlesen()
                        : ((GeraetesucheBericht.Ergebnis) gelesen).ueberlesen();
                assertThat(gezaehlt).as(name).isEqualTo("fund_ueberlesen".equals(klasse) ? ueberlesen.size() : 0);
            }
        }
    }

    private static final Pattern PFAD = Pattern.compile("([a-z_]+)(?:\\[(\\d+)])?");

    /** Entfernt "netze", "erkenner[1]", "funde[1].mac". */
    private static void entferne(ObjectNode wurzel, String pfad) {
        String[] teile = pfad.split("\\.");
        JsonNode knoten = wurzel;
        for (int i = 0; i < teile.length; i++) {
            Matcher m = PFAD.matcher(teile[i]);
            assertThat(m.matches()).as(pfad).isTrue();
            boolean letzter = i == teile.length - 1;
            if (m.group(2) == null) {
                if (letzter) {
                    ((ObjectNode) knoten).remove(m.group(1));
                } else {
                    knoten = knoten.path(m.group(1));
                }
            } else if (letzter) {
                ((ArrayNode) knoten.path(m.group(1))).remove(Integer.parseInt(m.group(2)));
            } else {
                knoten = knoten.path(m.group(1)).path(Integer.parseInt(m.group(2)));
            }
        }
    }

    @Test
    void hoechstens256Funde() throws Exception {
        JsonNode basis = vektoren.path("ergebnis").path("gueltig").path(0);
        ObjectNode p = basis.path("payload").deepCopy();
        JsonNode vorlage = p.path("funde").path(3);
        ArrayNode funde = p.putArray("funde");
        for (int i = 0; i <= GeraetesucheVertrag.MAX_FUNDE; i++) {
            ObjectNode f = vorlage.deepCopy();
            f.put("schluessel", "modbus_offen:192.168.178.70:" + (1000 + i));
            ((ObjectNode) f.path("verbindung")).put("port", 1000 + i);
            funde.add(f);
        }
        String topic = basis.path("topic").asText();
        assertThat(GeraetesucheBericht.ergebnis(topic, JSON.writeValueAsBytes(p), JSON)).isNull();
        funde.remove(GeraetesucheVertrag.MAX_FUNDE);
        assertThat(GeraetesucheBericht.ergebnis(topic, JSON.writeValueAsBytes(p), JSON).funde())
                .hasSize(GeraetesucheVertrag.MAX_FUNDE);
    }

    @Test
    void dieGruppeFolgtDenFaellen() {
        int n = 0;
        for (JsonNode c : vektoren.path("api").path("gruppe_faelle")) {
            assertThat(GeraetesucheVertrag.gruppe(c.path("anbindung").asText(), c.path("abgleich").asText(),
                    c.path("hindernis").textValue())).as(c.toString()).isEqualTo(c.path("gruppe").asText());
            n++;
        }
        assertThat(n).isGreaterThan(10);
        // Jede Gruppe und jedes Abgleich-Wort kommt in den Fällen vor.
        List<String> gruppen = new ArrayList<>();
        List<String> abgleich = new ArrayList<>();
        vektoren.path("api").path("gruppe_faelle").forEach(c -> {
            gruppen.add(c.path("gruppe").asText());
            abgleich.add(c.path("abgleich").asText());
        });
        assertThat(gruppen).containsAll(GeraetesucheVertrag.GRUPPEN);
        assertThat(abgleich).containsAll(GeraetesucheVertrag.ABGLEICH);
    }
}
