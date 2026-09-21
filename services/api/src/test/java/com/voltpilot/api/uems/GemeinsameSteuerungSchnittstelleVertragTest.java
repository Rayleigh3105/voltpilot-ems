package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Ablehnung;
import com.voltpilot.api.web.dto.GemeinsameSteuerungDto;
import com.voltpilot.api.web.dto.GemeinsameSteuerungEinrichtenDto;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Die Schnittstelle der Gemeinsamen Steuerung (UEMS AP-15 IP-5) sagt in Java ({@link GemeinsameSteuerungDto},
 * {@link GemeinsameSteuerungAbgelehnt}) und in {@code docs/contracts/openapi.yaml} dasselbe, und ihre Wörter sind die
 * des Vokabulars {@link SteuerungsverbundVokabular.Ablehnung}. Rein — ohne Spring, ohne Datenbank. Das Portal kennt
 * die Formen erst mit IP-23/IP-24.
 */
class GemeinsameSteuerungSchnittstelleVertragTest {

    private static final Path OPENAPI = Path.of("..", "..", "docs", "contracts", "openapi.yaml");
    private static final String KUNDE = "/api/v1/sites/{siteId}/gemeinsame-steuerung";
    private static final String ADMIN = "/api/v1/admin/sites/{siteId}/gemeinsame-steuerung";
    private static Map<String, Object> schemas;
    private static Map<String, Object> pfade;
    private static String text;

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void lies() throws Exception {
        text = Files.readString(OPENAPI);
        try (InputStream in = Files.newInputStream(OPENAPI)) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
            pfade = (Map<String, Object>) openapi.get("paths");
        }
    }

    @Test
    void dieFormenSindZeichengleich() {
        Map<String, Class<? extends Record>> formen = new LinkedHashMap<>();
        formen.put("GemeinsameSteuerung", GemeinsameSteuerungDto.Zustand.class);
        formen.put("GemeinsameSteuerungMitglied", GemeinsameSteuerungDto.Mitglied.class);
        formen.put("GemeinsameSteuerungBefund", GemeinsameSteuerungDto.Befund.class);
        formen.put("GemeinsameSteuerungWarnungFuehrung", GemeinsameSteuerungDto.WarnungFuehrung.class);
        formen.put("GemeinsameSteuerungBilanz", GemeinsameSteuerungDto.Bilanz.class);
        formen.put("GemeinsameSteuerungVorbehalt", GemeinsameSteuerungDto.Vorbehalt.class);
        formen.put("GemeinsameSteuerungVorbehaltRichtung", GemeinsameSteuerungDto.VorbehaltRichtung.class);
        formen.put("GemeinsameSteuerungVorbehaltVorschlag", GemeinsameSteuerungDto.VorbehaltVorschlag.class);
        // Einrichten in sechs Fragen (§5.2, Vertrag §6a)
        formen.put("GemeinsameSteuerungEinrichtenAuskunft", GemeinsameSteuerungEinrichtenDto.Einrichten.class);
        formen.put("GemeinsameSteuerungEinrichtenBox", GemeinsameSteuerungEinrichtenDto.Box.class);
        formen.put("GemeinsameSteuerungAuslegung", GemeinsameSteuerungEinrichtenDto.Auslegung.class);
        formen.put("GemeinsameSteuerungErzeuger", GemeinsameSteuerungEinrichtenDto.Erzeuger.class);
        formen.put("GemeinsameSteuerungRueckfallAngabe", GemeinsameSteuerungEinrichtenDto.RueckfallAngabe.class);
        formen.put("GemeinsameSteuerungLuecke", GemeinsameSteuerungEinrichtenDto.Luecke.class);
        formen.put("GemeinsameSteuerungSprungprobe", GemeinsameSteuerungDto.Sprungprobe.class);
        // Betreiber-Blatt (IP-24)
        formen.put("GemeinsameSteuerungBetreiberblatt", GemeinsameSteuerungDto.Betreiberblatt.class);
        formen.put("GemeinsameSteuerungBoxStand", GemeinsameSteuerungDto.BoxStand.class);
        formen.put("GemeinsameSteuerungFaehigkeit", GemeinsameSteuerungDto.Faehigkeit.class);
        formen.put("GemeinsameSteuerungMesspunkt", GemeinsameSteuerungDto.Messpunkt.class);
        formen.put("GemeinsameSteuerungWaechter", GemeinsameSteuerungDto.Waechter.class);
        formen.put("GemeinsameSteuerungPlanStand", GemeinsameSteuerungDto.PlanStand.class);
        formen.put("GemeinsameSteuerungPlanZeile", GemeinsameSteuerungDto.PlanZeile.class);
        formen.put("GemeinsameSteuerungAnteilStand", GemeinsameSteuerungDto.AnteilStand.class);
        formen.put("GemeinsameSteuerungRevision", GemeinsameSteuerungDto.Revision.class);
        formen.put("GemeinsameSteuerungZweischritt", GemeinsameSteuerungDto.Zweischritt.class);
        formen.put("GemeinsameSteuerungSprungprobeProtokoll", GemeinsameSteuerungDto.SprungprobeProtokoll.class);
        formen.put("GemeinsameSteuerungSprungMessung", GemeinsameSteuerungDto.SprungMessung.class);
        formen.forEach((schema, dto) -> {
            List<String> felder = new ArrayList<>();
            Arrays.stream(dto.getRecordComponents()).forEach(c -> felder.add(
                    PropertyNamingStrategies.SnakeCaseStrategy.INSTANCE.translate(c.getName())));
            assertThat(new ArrayList<>(eigenschaften(schema).keySet())).as(schema).containsExactlyElementsOf(felder);
        });
        List<String> wunsch = new ArrayList<>();
        Arrays.stream(GemeinsameSteuerungDto.MitgliedWunsch.class.getRecordComponents()).forEach(c -> wunsch.add(
                PropertyNamingStrategies.SnakeCaseStrategy.INSTANCE.translate(c.getName())));
        assertThat(text).contains("required: [box_id, rolle]");
        assertThat(wunsch).containsExactly("box_id", "rolle", "messpunkt_id", "vorgabe_signal");
        assertThat(text).as("G6: vorgabe_signal wahlfrei im Einrichten-Körper").contains("              vorgabe_signal:");
    }

    @Test
    @SuppressWarnings("unchecked")
    void dieWoerterSindDieDesVokabulars() {
        Map<String, Object> wort = (Map<String, Object>) eigenschaften("GemeinsameSteuerungBefund").get("wort");
        assertThat((List<String>) wort.get("enum")).containsExactlyElementsOf(
                Arrays.stream(Ablehnung.values()).map(Ablehnung::code).toList());
        GemeinsameSteuerungAbgelehnt.UEBERGANG.forEach(code -> assertThat(text).as(code).contains("`" + code + "`"));
        Map<String, Object> bilanz = eigenschaften("GemeinsameSteuerungBilanz");
        assertThat((List<String>) ((Map<String, Object>) bilanz.get("zustand")).get("enum"))
                .containsExactlyElementsOf(VerbundBilanzRegel.ZUSTAENDE);
        assertThat((List<String>) ((Map<String, Object>) bilanz.get("grund")).get("enum")).containsExactlyElementsOf(
                Arrays.stream(VerbundBilanzRegel.Grund.values()).map(VerbundBilanzRegel.Grund::code).toList());
        Map<String, Object> probe = eigenschaften("GemeinsameSteuerungSprungprobe");
        assertThat((List<String>) ((Map<String, Object>) probe.get("urteil")).get("enum"))
                .containsExactlyElementsOf(SprungprobeRegel.URTEILE);
        List<String> gruende = new ArrayList<>(SprungprobeRegel.GRUENDE_NICHT_BESTANDEN);
        gruende.addAll(SprungprobeRegel.GRUENDE_NICHT_AUSWERTBAR);
        gruende.addAll(SprungprobeRegel.GRUENDE_ABGEBROCHEN);
        gruende.add(null);
        assertThat((List<String>) ((Map<String, Object>) probe.get("grund")).get("enum"))
                .containsExactlyElementsOf(gruende);
        Map<String, Object> richtung = eigenschaften("GemeinsameSteuerungVorbehaltRichtung");
        assertThat((List<String>) ((Map<String, Object>) richtung.get("herkunft")).get("enum")).containsExactly(
                GemeinsameSteuerungService.HERKUNFT_ERKLAERT, GemeinsameSteuerungService.HERKUNFT_GEMESSEN);
        List<String> zweischritt = new ArrayList<>(List.of("veroeffentlicht"));
        Arrays.stream(SteuerungsverbundAnteilDienst.Grund.values())
                .forEach(g -> zweischritt.add(g.name().toLowerCase(java.util.Locale.ROOT)));
        assertThat((List<String>) ((Map<String, Object>) richtung.get("zweischritt")).get("enum"))
                .containsExactlyElementsOf(zweischritt);
    }

    @Test
    @SuppressWarnings("unchecked")
    void dieWoerterDerErklaerungSindDieDesDienstes() {
        Map<String, Object> auskunft = eigenschaften("GemeinsameSteuerungEinrichtenAuskunft");
        Map<String, Object> hinweis = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) auskunft
                .get("hinweise")).get("items")).get("properties");
        assertThat((List<String>) ((Map<String, Object>) hinweis.get("wort")).get("enum"))
                .containsExactlyElementsOf(GemeinsameSteuerungErklaerung.HINWEISE);
        assertThat((List<String>) ((Map<String, Object>) eigenschaften("GemeinsameSteuerungLuecke").get("wort"))
                .get("enum")).containsExactlyElementsOf(GemeinsameSteuerungErklaerung.LUECKEN);
        assertThat(text).contains("`" + GemeinsameSteuerungAbgelehnt.ERKLAERUNG_UNVOLLSTAENDIG + "`");
    }

    @Test
    @SuppressWarnings("unchecked")
    void dieRoutenNennenIhreRechte() {
        Map<String, String> recht = Map.of(
                KUNDE + "|put", "funktion.steuern_einrichten",
                KUNDE + "/anhalten|post", "steuerung.starten_beenden",
                KUNDE + "/fortsetzen|post", "steuerung.starten_beenden",
                KUNDE + "/aufloesen|post", "steuerung.starten_beenden",
                ADMIN + "/scharfschalten|post", "plattform.betrieb",
                ADMIN + "/fortsetzen|post", "plattform.betrieb",
                ADMIN + "/mitglieder/{boxId}/bestaetigen|post", "plattform.betrieb",
                ADMIN + "/vorbehalt/freigeben|post", "plattform.betrieb",
                KUNDE + "/komponenten/{komponenteId}/rueckfall|put", "funktion.steuern_einrichten",
                ADMIN + "/sprungprobe|post", "plattform.betrieb");
        recht.forEach((schluessel, kennung) -> {
            String[] t = schluessel.split("\\|");
            Map<String, Object> op = (Map<String, Object>) ((Map<String, Object>) pfade.get(t[0])).get(t[1]);
            assertThat(op).as(schluessel).isNotNull();
            assertThat((String) op.get("description")).as(schluessel).contains("`" + kennung + "`");
            List<String> antworten = new ArrayList<>(List.of("200", "400", "401", "403", "404", "409"));
            if (schluessel.equals(KUNDE + "|put")) {
                antworten.add("422"); // die Erklärung ist unvollständig
            }
            assertThat(((Map<String, Object>) op.get("responses")).keySet()).as(schluessel)
                    .containsExactlyInAnyOrderElementsOf(antworten);
        });
        for (String lesen : List.of(KUNDE + "/einrichten", KUNDE + "/komponenten/{komponenteId}/rueckfall")) {
            Map<String, Object> op = (Map<String, Object>) ((Map<String, Object>) pfade.get(lesen)).get("get");
            assertThat(((Map<String, Object>) op.get("responses")).keySet()).as(lesen)
                    .containsExactlyInAnyOrder("200", "401", "404");
        }
        Map<String, Object> zustand = eigenschaften("GemeinsameSteuerung");
        assertThat((List<String>) ((Map<String, Object>) zustand.get("naechster_schritt")).get("enum"))
                .contains(GemeinsameSteuerungAbgelehnt.VOM_BETREIBER_ANGEHALTEN);
        Map<String, Object> blatt = (Map<String, Object>) ((Map<String, Object>) pfade.get(ADMIN)).get("get");
        assertThat((String) blatt.get("description")).contains("`plattform.betrieb`");
        assertThat(((Map<String, Object>) blatt.get("responses")).keySet()).containsExactlyInAnyOrder("200", "401",
                "403", "404");
        Map<String, Object> lesen = (Map<String, Object>) ((Map<String, Object>) pfade.get(KUNDE)).get("get");
        assertThat(((Map<String, Object>) lesen.get("responses")).keySet()).containsExactlyInAnyOrder("200", "401",
                "404");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> eigenschaften(String schema) {
        Map<String, Object> s = (Map<String, Object>) schemas.get(schema);
        assertThat(s).as(schema).isNotNull();
        return (Map<String, Object>) s.get("properties");
    }
}
