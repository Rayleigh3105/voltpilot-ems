package com.voltpilot.api.geraetesuche;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.ComponentTemplateDto;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Rein, ohne Docker: der Abgleich eines Fundes mit den Komponenten der Anlage ({@code mqtt-geraetesuche.md} §7) an den
 * Funden der geteilten Vektoren ({@code ergebnis.gueltig}: {@code docker_fertig}, {@code edge_light_fertig}), gelesen
 * über denselben Leser wie der Listener. Eine Adresse allein beweist nie, dass es dasselbe Gerät ist; eine neue Adresse
 * mit derselben Kennung ist ein Vorschlag (DP-7 A).
 */
class GeraetesucheAbgleichTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static GeraetesucheBericht.Ergebnis docker;
    private static GeraetesucheBericht.Ergebnis edgeLight;

    @BeforeAll
    static void lade() throws Exception {
        JsonNode v = JSON.readTree(Files.readString(
                Path.of("..", "..", "docs", "contracts", "v2", "geraetesuche-vectors.json")));
        for (JsonNode c : v.path("ergebnis").path("gueltig")) {
            GeraetesucheBericht.Ergebnis e = GeraetesucheBericht.ergebnis(c.path("topic").asText(),
                    c.path("payload").toString().getBytes(StandardCharsets.UTF_8), JSON);
            if ("docker_fertig".equals(c.path("name").asText())) {
                docker = e;
            } else if ("edge_light_fertig".equals(c.path("name").asText())) {
                edgeLight = e;
            }
        }
        assertThat(docker).isNotNull();
        assertThat(edgeLight).isNotNull();
        assertThat(docker.funde()).hasSize(5);
        assertThat(edgeLight.funde()).hasSize(7);
    }

    private static GeraetesucheBericht.Fund fund(GeraetesucheBericht.Ergebnis e, String schluessel) {
        return e.funde().stream().filter(f -> f.schluessel().equals(schluessel)).findFirst().orElseThrow();
    }

    private static GeraetesucheAbgleich.Komponente komponente(String name, String verbindung, String seriennummer) {
        return GeraetesucheAbgleich.komponente(UUID.randomUUID(), name, verbindung, seriennummer, JSON);
    }

    private static String gruppe(GeraetesucheBericht.Fund f, GeraetesucheAbgleich.Ergebnis a) {
        return GeraetesucheVertrag.gruppe(f.anbindung(), a.abgleich(), f.hindernis());
    }

    @Test
    void ohneKomponentenIstJederFundNeuUndDieGruppeFolgtDerAnbindung() {
        assertThat(GeraetesucheDienst.zaehler(docker.funde(), List.of())).containsExactly(
                Map.entry("braucht_hilfe", 0), Map.entry("bereit", 3), Map.entry("nicht_anbindbar", 0),
                Map.entry("vielleicht", 1), Map.entry("schon_eingerichtet", 0), Map.entry("weitere", 1));
        // Edge Light: der geschützte Shelly braucht Hilfe; Fronius (nur Docker liest ihn), SMA und der Shelly-Zähler
        // (kein Leseweg) sind „erkannt, mit dieser Box noch nicht anbindbar“.
        assertThat(GeraetesucheDienst.zaehler(edgeLight.funde(), List.of())).containsExactly(
                Map.entry("braucht_hilfe", 1), Map.entry("bereit", 2), Map.entry("nicht_anbindbar", 3),
                Map.entry("vielleicht", 0), Map.entry("schon_eingerichtet", 0), Map.entry("weitere", 1));
        for (GeraetesucheBericht.Fund f : edgeLight.funde()) {
            assertThat(GeraetesucheAbgleich.abgleichen(f, List.of()).abgleich()).as(f.schluessel()).isEqualTo("neu");
        }
    }

    @Test
    void dieLoggerSeriennummerAnEinerNeuenAdresseIstEinVorschlagMitDerBekanntenAdresse() {
        GeraetesucheBericht.Fund deye = fund(docker, "solarman:3115580613");
        GeraetesucheAbgleich.Komponente wr = komponente("Wechselrichter Dach",
                "{\"ip\":\"192.168.178.35\",\"port\":8899,\"serial\":\"3115580613\",\"mb_slave_id\":1}", null);

        GeraetesucheAbgleich.Ergebnis a = GeraetesucheAbgleich.abgleichen(deye, List.of(wr));

        assertThat(a.abgleich()).isEqualTo("adresse_geaendert");
        assertThat(a.komponente()).isEqualTo(wr);
        assertThat(a.bekannteAdresse()).isEqualTo("192.168.178.35");
        assertThat(gruppe(deye, a)).isEqualTo("braucht_hilfe");
    }

    @Test
    void dieSeriennummerDesGeraetsAnDerselbenAdresseIstSchonEingerichtet() {
        GeraetesucheBericht.Fund deye = fund(docker, "solarman:3115580613");
        // Die Kennung kommt hier allein aus geraet.seriennummer (Wechselrichter), nicht aus der Verbindung.
        GeraetesucheAbgleich.Komponente wr = komponente("Wechselrichter",
                "{\"ip\":\"192.168.178.34\",\"port\":8899}", " 2409066698 ");

        GeraetesucheAbgleich.Ergebnis a = GeraetesucheAbgleich.abgleichen(deye, List.of(wr));

        assertThat(a.abgleich()).isEqualTo("schon_eingerichtet");
        assertThat(a.bekannteAdresse()).isNull();
        assertThat(gruppe(deye, a)).isEqualTo("schon_eingerichtet");
    }

    @Test
    void eineAdresseAlleinBeweistKeinGeraet() {
        GeraetesucheBericht.Fund shelly = fund(docker, "shelly:192.168.178.50:80");
        GeraetesucheBericht.Fund goe = fund(docker, "goe:204117");
        GeraetesucheAbgleich.Komponente heizstab = komponente("Heizstab", "{\"ip\":\"192.168.178.50\",\"channel\":0}",
                null);
        GeraetesucheAbgleich.Komponente wallbox = komponente("Wallbox Garage", "{\"ip\":\"192.168.178.61\"}",
                "199001");
        List<GeraetesucheAbgleich.Komponente> anlage = List.of(heizstab, wallbox);

        // Der Shelly nennt keine Seriennummer (nur eine MAC, die die Box nie sendet): nicht belegbar.
        GeraetesucheAbgleich.Ergebnis s = GeraetesucheAbgleich.abgleichen(shelly, anlage);
        assertThat(s.abgleich()).isEqualTo("adresse_bekannt_kennung_offen");
        assertThat(s.komponente()).isEqualTo(heizstab);
        assertThat(gruppe(shelly, s)).isEqualTo("schon_eingerichtet");
        // An der Adresse der Wallbox antwortet ein Gerät mit anderer Seriennummer.
        GeraetesucheAbgleich.Ergebnis g = GeraetesucheAbgleich.abgleichen(goe, anlage);
        assertThat(g.abgleich()).isEqualTo("anderes_geraet_an_bekannter_adresse");
        assertThat(g.komponente()).isEqualTo(wallbox);
        assertThat(gruppe(goe, g)).isEqualTo("braucht_hilfe");
    }

    @Test
    void eineKomponenteOhneAdresseMitDerselbenKennungIstSchonEingerichtet() {
        GeraetesucheBericht.Fund goe = fund(docker, "goe:204117");
        GeraetesucheAbgleich.Komponente ocpp = komponente("Wallbox (OCPP)", null, "204117");

        assertThat(GeraetesucheAbgleich.abgleichen(goe, List.of(ocpp)).abgleich()).isEqualTo("schon_eingerichtet");
    }

    @Test
    void zweiUnitIdsHinterDerselbenIpSindZweiZiele() {
        GeraetesucheBericht.Fund ebyte = fund(edgeLight, "ebyte:192.168.2.40:502");
        GeraetesucheAbgleich.Komponente zaehler = komponente("Zähler am Gateway",
                "{\"ip\":\"192.168.2.40\",\"port\":502,\"unit_id\":\"3\"}", null);
        GeraetesucheAbgleich.Komponente modul = komponente("IO-Modul",
                "{\"ip\":\"192.168.2.40\",\"port\":502,\"unit_id\":1}", null);

        assertThat(GeraetesucheAbgleich.abgleichen(ebyte, List.of(zaehler)).abgleich()).isEqualTo("neu");
        assertThat(GeraetesucheAbgleich.abgleichen(ebyte, List.of(zaehler, modul)).komponente()).isEqualTo(modul);
    }

    @Test
    void einRouterIstNieEineKomponente() {
        GeraetesucheBericht.Fund router = fund(docker, "netztechnik:192.168.178.1:80");
        GeraetesucheAbgleich.Komponente amRouter = komponente("Irgendwas", "{\"ip\":\"192.168.178.1\"}", null);

        GeraetesucheAbgleich.Ergebnis a = GeraetesucheAbgleich.abgleichen(router, List.of(amRouter));
        assertThat(a.abgleich()).isEqualTo("neu");
        assertThat(gruppe(router, a)).isEqualTo("weitere");
    }

    @Test
    void dieKennungenEinerKomponenteLesenZahlUndTextGleich() {
        GeraetesucheAbgleich.Komponente zahl = komponente("A", "{\"ip\":\"192.168.178.34\",\"serial\":3115580613}",
                "sn-1");
        GeraetesucheAbgleich.Komponente kaputt = komponente("B", "kein json", null);

        assertThat(zahl.kennungen()).containsExactlyInAnyOrder("3115580613", "SN-1");
        assertThat(zahl.ip()).isEqualTo("192.168.178.34");
        assertThat(kaputt.ip()).isNull();
        assertThat(kaputt.kennungen()).isEmpty();
        assertThat(GeraetesucheAbgleich.kennungen(fund(docker, "solarman:3115580613")))
                .isEqualTo(Set.of("2409066698", "3115580613"));
    }

    @Test
    void dieVorlagenSindDieDerKommunikationDesHerstellersUndDerGemeldetenBauart() {
        List<ComponentTemplateDto> katalog = List.of(
                vorlage("builtin:deye:sun-12k-sg04lp3", "deye", "hybrid_3p", "solarman_v5"),
                vorlage("builtin:deye:sun-8k-g", "deye", "string", "solarman_v5"),
                vorlage("builtin:shelly:shelly_http", "shelly", "shelly_http", "shelly_http"),
                vorlage("builtin:go-e:goe_http_api", "go-e", "goe_http_api", "goe_http_api"));

        assertThat(GeraetesucheAbgleich.vorlagen(fund(docker, "solarman:3115580613"), katalog))
                .containsExactly("builtin:deye:sun-12k-sg04lp3");
        assertThat(GeraetesucheAbgleich.vorlagen(fund(docker, "goe:204117"), katalog))
                .containsExactly("builtin:go-e:goe_http_api");
        assertThat(GeraetesucheAbgleich.vorlagen(fund(docker, "shelly:192.168.178.50:80"), katalog))
                .containsExactly("builtin:shelly:shelly_http");
        // Nicht übernehmbar: keine Vorlage, auch wenn eine passen würde.
        assertThat(GeraetesucheAbgleich.vorlagen(fund(docker, "modbus_offen:192.168.178.70:502"), katalog)).isEmpty();
        assertThat(GeraetesucheAbgleich.vorlagen(fund(edgeLight, "fronius_solar_api:31234567"), katalog)).isEmpty();
        // Eine Bauart, die der Katalog nicht kennt, engt nicht auf nichts ein.
        GeraetesucheBericht.Fund d = fund(docker, "solarman:3115580613");
        GeraetesucheBericht.Fund fremdeBauart = new GeraetesucheBericht.Fund(d.schluessel(), d.erkenner(), d.art(),
                d.hersteller(), d.modell(), d.seriennummer(), d.firmware(), "micro_2p", d.spannung(), d.kanaele(),
                d.erkennung(), d.merkmale(), d.anbindung(), d.hindernis(), d.verbindung(), d.liestBoxSchon());
        assertThat(GeraetesucheAbgleich.vorlagen(fremdeBauart, katalog))
                .containsExactly("builtin:deye:sun-12k-sg04lp3", "builtin:deye:sun-8k-g");
    }

    @Test
    void einDeyeHybridMitGemeldeterSpannungBekommtNurDieModelleDieserSpannung() throws Exception {
        List<ComponentTemplateDto> katalog = builtinKatalog();
        GeraetesucheBericht.Fund hv = fund(docker, "solarman:3115580613");
        assertThat(hv.spannung()).isEqualTo("hv"); // wie der Deye am VoltPilotGATE: Gerätetyp 0x0006

        List<String> hochvolt = GeraetesucheAbgleich.vorlagen(hv, katalog);
        assertThat(hochvolt).hasSize(8).allMatch(r -> r.contains("-sg01hp3") || r.contains("-sg02hp3"));
        List<String> niedervolt = GeraetesucheAbgleich.vorlagen(mitSpannung(hv, "lv"), katalog);
        assertThat(niedervolt).hasSize(5).allMatch(r -> r.contains("-sg04lp3"));
        // Ohne Spannung bleibt die ganze Familie.
        assertThat(GeraetesucheAbgleich.vorlagen(mitSpannung(hv, null), katalog)).hasSize(13)
                .containsAll(hochvolt).containsAll(niedervolt);
    }

    @Test
    void eineSpannungOhnePassendeVorlageEngtNichtAufNichtsEin() {
        List<ComponentTemplateDto> nurNiedervolt = List.of(
                vorlage("builtin:deye:sun-12k-sg04lp3", "deye", "sun-12k-sg04lp3", "hybrid_3p", "solarman_v5"));
        assertThat(GeraetesucheAbgleich.vorlagen(fund(docker, "solarman:3115580613"), nurNiedervolt))
                .containsExactly("builtin:deye:sun-12k-sg04lp3");
    }

    /** Die Spannung, die der Abgleich aus dem Modell liest, ist die, die der Katalog in seiner Notiz nennt. */
    @Test
    void dieSpannungEinerVorlageFolgtIhremTypschluesselWieIhreNotiz() throws Exception {
        JsonNode templates = JSON.readTree(getClass().getResourceAsStream("/componenttemplates/builtin.json"))
                .path("templates");
        int hv = 0;
        int lv = 0;
        for (JsonNode t : templates) {
            String model = t.path("model").asText();
            String note = t.path("note").asText();
            String erwartet = note.contains("Hochvolt-Speicher (HV)") ? "hv"
                    : note.contains("Niedervolt-Speicher (LV)") ? "lv" : null;
            if (erwartet != null) {
                assertThat(GeraetesucheAbgleich.spannung(model)).as(model).isEqualTo(erwartet);
                hv += "hv".equals(erwartet) ? 1 : 0;
                lv += "lv".equals(erwartet) ? 1 : 0;
            } else if ("hybrid_3p".equals(t.path("family").asText())) {
                throw new AssertionError("hybrid_3p ohne Spannung in der Notiz: " + model);
            }
        }
        assertThat(hv).isEqualTo(8);
        assertThat(lv).isEqualTo(5);
        assertThat(GeraetesucheAbgleich.spannung("sun-10k-g03")).isNull();
        assertThat(GeraetesucheAbgleich.spannung(null)).isNull();
    }

    @Test
    void einShellyBekommtDenProduktnamenNurZuEinemBelegtenCode() {
        GeraetesucheBericht.Fund pro3 = fund(docker, "shelly:192.168.178.50:80");
        assertThat(pro3.modell()).isEqualTo("SPSW-003XE16EU");
        assertThat(ShellyModellnamen.name(pro3)).isEqualTo("Shelly Pro 3");
        assertThat(ShellyModellnamen.name(mitModell(pro3, "shem-3"))).isEqualTo("Shelly 3EM"); // Gen1 type
        assertThat(ShellyModellnamen.name(mitModell(pro3, "SPEM-003CEBEU"))).isEqualTo("Shelly Pro 3EM");
        // Unbekannter Code: kein Name, das Portal zeigt den Code.
        assertThat(ShellyModellnamen.name(mitModell(pro3, "SXXX-999ZZ"))).isNull();
        assertThat(ShellyModellnamen.name(mitModell(pro3, null))).isNull();
        // Derselbe Code eines anderen Herstellers ist kein Shelly.
        GeraetesucheBericht.Fund deye = fund(docker, "solarman:3115580613");
        assertThat(ShellyModellnamen.name(mitModell(deye, "SPSW-003XE16EU"))).isNull();
    }

    private static GeraetesucheBericht.Fund mitSpannung(GeraetesucheBericht.Fund d, String spannung) {
        return new GeraetesucheBericht.Fund(d.schluessel(), d.erkenner(), d.art(), d.hersteller(), d.modell(),
                d.seriennummer(), d.firmware(), d.familie(), spannung, d.kanaele(), d.erkennung(), d.merkmale(),
                d.anbindung(), d.hindernis(), d.verbindung(), d.liestBoxSchon());
    }

    private static GeraetesucheBericht.Fund mitModell(GeraetesucheBericht.Fund d, String modell) {
        return new GeraetesucheBericht.Fund(d.schluessel(), d.erkenner(), d.art(), d.hersteller(), modell,
                d.seriennummer(), d.firmware(), d.familie(), d.spannung(), d.kanaele(), d.erkennung(), d.merkmale(),
                d.anbindung(), d.hindernis(), d.verbindung(), d.liestBoxSchon());
    }

    private List<ComponentTemplateDto> builtinKatalog() throws Exception {
        List<ComponentTemplateDto> out = new java.util.ArrayList<>();
        for (JsonNode t : JSON.readTree(getClass().getResourceAsStream("/componenttemplates/builtin.json"))
                .path("templates")) {
            out.add(vorlage(t.path("template_ref").asText(), t.path("brand").asText(), t.path("model").asText(),
                    t.path("family").asText(), t.path("communication").asText()));
        }
        return out;
    }

    private static ComponentTemplateDto vorlage(String ref, String brand, String model, String family,
            String communication) {
        return new ComponentTemplateDto(ref, "builtin", 1, brand, brand, model, model, "[]", "inverter", null, family,
                family, communication, communication, "[]", "[]", "[]", null, 0, null, null, null, null, null);
    }

    private static ComponentTemplateDto vorlage(String ref, String brand, String family, String communication) {
        return new ComponentTemplateDto(ref, "builtin", 1, brand, brand, ref, ref, "[]", "inverter", null, family,
                family, communication, communication, "[]", "[]", "[]", null, 0, null, null, null, null, null);
    }
}
