package com.voltpilot.api.erzeuger;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.erzeuger.AnlagensteuerungRepository.Wechselzeile;
import com.voltpilot.api.web.dto.ErzeugerJetztDto;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Rein, ohne Docker: {@code GET …/erzeuger/jetzt} (UEMS EZ-23) sagt in Java ({@link ErzeugerJetztDto}),
 * {@code docs/contracts/openapi.yaml} und im Portal ({@code ErzeugerJetzt} in {@code api.ts}) dasselbe, camelCase in
 * allen dreien — {@code request()} wandelt nichts um. Die Punktnamen der Route sind genau die, die das Cockpit liest
 * ({@code ERZEUGER_PUNKT}/{@code einheitPunkt} in {@code erzeuger.ts}, die Fixtures {@code erzeugerFixtures.ts}), und
 * jeder zeigt auf ein Feld des Katalogs. Dazu die Tageswechsel: Mitternacht, Wechsel, Lücke.
 */
class ErzeugerJetztVertragTest {

    private static final Path PORTAL = Path.of("..", "..", "frontend", "portal", "src");
    private static final Path OPENAPI = Path.of("..", "..", "docs", "contracts", "openapi.yaml");

    private static Map<String, Object> schemas;
    private static Map<String, Object> pfade;
    static String apiTs;
    private static String erzeugerTs;
    private static String fixtures;

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void lade() throws IOException {
        try (InputStream in = Files.newInputStream(OPENAPI)) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
            pfade = (Map<String, Object>) openapi.get("paths");
        }
        apiTs = Files.readString(PORTAL.resolve("api.ts"));
        erzeugerTs = Files.readString(PORTAL.resolve("erzeuger.ts"));
        fixtures = Files.readString(PORTAL.resolve(Path.of("test", "erzeugerFixtures.ts")));
    }

    // ------------------------------------------------------------------ Form

    @Test
    void dieFormIstInJavaOpenApiUndPortalDieselbe() {
        for (Object[] paar : new Object[][] {
                {"ErzeugerJetzt", ErzeugerJetztDto.Jetzt.class},
                {"ErzeugerJetztSteuerung", ErzeugerJetztDto.Steuerung.class},
                {"ErzeugerJetztEinheit", ErzeugerJetztDto.Einheit.class},
                {"ErzeugerJetztWert", ErzeugerJetztDto.Wert.class},
                {"ErzeugerJetztWechsel", ErzeugerJetztDto.Wechsel.class}}) {
            List<String> dto = felder((Class<?>) paar[1]);
            Map<String, Object> schema = schema((String) paar[0]);
            assertThat(map(schema, "properties").keySet()).as((String) paar[0]).containsExactlyElementsOf(dto);
            assertThat(liste(schema, "required")).as((String) paar[0]).containsExactlyElementsOf(dto);
        }
        assertThat(interfaceFelder("ErzeugerJetzt")).containsExactlyElementsOf(felder(ErzeugerJetztDto.Jetzt.class));
        assertThat(interfaceFelder("ErzeugerWert")).containsExactlyElementsOf(felder(ErzeugerJetztDto.Wert.class));
        assertThat(interfaceFelder("ErzeugerWechsel")).containsExactlyElementsOf(felder(ErzeugerJetztDto.Wechsel.class));
        // steuerung und einheiten stehen im Portal inline.
        assertThat(inlineFelder("steuerung")).containsExactlyElementsOf(felder(ErzeugerJetztDto.Steuerung.class));
        assertThat(inlineFelder("einheiten")).containsExactlyElementsOf(felder(ErzeugerJetztDto.Einheit.class));

        Matcher q = Pattern.compile("export type ErzeugerQualitaet = ([^;]+);").matcher(apiTs);
        assertThat(q.find()).isTrue();
        assertThat(liste(map(schema("ErzeugerJetztWert"), "properties"), "qualitaet", "enum"))
                .containsExactlyElementsOf(woerter(q.group(1)));
        assertThat(liste(map(schema("ErzeugerJetztEinheit"), "properties"), "art", "enum")).containsExactly("pv", "bhkw");

        assertThat(pfade).containsKey("/api/v1/sites/{siteId}/erzeuger/jetzt");
        assertThat(String.valueOf(pfade.get("/api/v1/sites/{siteId}/erzeuger/jetzt"))).contains("204", "messwerte.ansehen");
        assertThat(apiTs).contains("request<ErzeugerJetzt | undefined>(`/api/v1/sites/${siteId}/erzeuger/jetzt`)");
    }

    // ---------------------------------------------------------------- Namen

    @Test
    void dieRouteNenntGenauDiePunkteDieDasCockpitLiest() {
        Matcher block = Pattern.compile("export const ERZEUGER_PUNKT = \\{\\n(.*?)\\n\\} as const;", Pattern.DOTALL)
                .matcher(erzeugerTs);
        assertThat(block.find()).as("ERZEUGER_PUNKT in erzeuger.ts").isTrue();
        List<String> portal = new ArrayList<>();
        Matcher wert = Pattern.compile("'(erzeuger\\.[a-z_.]+)'").matcher(block.group(1));
        while (wert.find()) {
            portal.add(wert.group(1));
        }
        assertThat(ErzeugerJetztService.PUNKTE.keySet()).containsExactlyElementsOf(portal);

        Matcher feld = Pattern.compile("export type EinheitFeld = ([^;]+);").matcher(erzeugerTs);
        assertThat(feld.find()).isTrue();
        assertThat(ErzeugerJetztService.EINHEIT_FELDER.keySet()).containsExactlyElementsOf(woerter(feld.group(1)));
        assertThat(erzeugerTs).as("der Name je Einheit, den punkte() baut")
                .contains("return `erzeuger.te${teNr}.${feld}`;");
        assertThat(ErzeugerJetztService.punkte(2)).containsEntry("erzeuger.te2.p_ist_w", "erzeuger.te[2].t_p_ist_w");
    }

    @Test
    void jederPunktnameZeigtAufGenauEinFeldDesKatalogs() {
        Map<String, String> alle = ErzeugerJetztService.punkte(ErzeugerRegisterbild.MAX_EINHEITEN);
        assertThat(alle.values()).doesNotHaveDuplicates()
                .allSatisfy(k -> assertThat(ErzeugerRegisterbild.feld(k)).as(k).isPresent())
                .isSubsetOf(ErzeugerRegisterbild.punkte(ErzeugerRegisterbild.MAX_EINHEITEN));
        // Die Einheit des Portals ist die des Katalogs: W, %, kW, s.
        assertThat(ErzeugerRegisterbild.feld(alle.get("erzeuger.anlage.p_nvp_w")).orElseThrow().einheit()).isEqualTo("W");
        assertThat(ErzeugerRegisterbild.feld(alle.get("erzeuger.nb.p_vorgabe_prozent")).orElseThrow().einheit())
                .isEqualTo("%");
        assertThat(ErzeugerRegisterbild.feld(alle.get("erzeuger.anlage.p_installiert_kw")).orElseThrow().einheit())
                .isEqualTo("kW");
        assertThat(ErzeugerRegisterbild.feld(alle.get("erzeuger.dv.seit_s")).orElseThrow().einheit()).isEqualTo("s");
        assertThat(ErzeugerRegisterbild.feld(alle.get("erzeuger.te3.nenn_kw")).orElseThrow().einheit()).isEqualTo("kW");
    }

    @Test
    void jederPunktDerPortalFixturesKommtAusDerRoute() {
        Map<String, String> konstanten = new java.util.HashMap<>();
        Matcher k = Pattern.compile("(?m)^  ([a-zA-Z]+): '(erzeuger\\.[a-z_.]+)',$").matcher(erzeugerTs);
        while (k.find()) {
            konstanten.put(k.group(1), k.group(2));
        }
        Set<String> gesetzt = new LinkedHashSet<>();
        Matcher p = Pattern.compile("setze\\(P\\.([a-zA-Z]+),").matcher(fixtures);
        while (p.find()) {
            gesetzt.add(konstanten.get(p.group(1)));
        }
        assertThat(gesetzt).hasSizeGreaterThan(15).doesNotContainNull()
                .isSubsetOf(ErzeugerJetztService.PUNKTE.keySet());
        Set<String> einheit = new LinkedHashSet<>();
        Matcher e = Pattern.compile("setze\\(einheitPunkt\\(n, '([a-z_]+)'\\)").matcher(fixtures);
        while (e.find()) {
            einheit.add(e.group(1));
        }
        assertThat(einheit).containsExactlyInAnyOrderElementsOf(ErzeugerJetztService.EINHEIT_FELDER.keySet());
        Set<String> wechsel = new LinkedHashSet<>();
        Matcher w = Pattern.compile("\\[P\\.([a-zA-Z]+)\\]: \\[\\{ ab: mitternacht").matcher(fixtures);
        while (w.find()) {
            wechsel.add(konstanten.get(w.group(1)));
        }
        assertThat(wechsel).containsExactlyInAnyOrderElementsOf(ErzeugerJetztService.WECHSEL);
    }

    // ------------------------------------------------------------ Tageswechsel

    private static final Instant MITTERNACHT = Instant.parse("2026-10-22T22:00:00Z");
    private static final Instant JETZT = MITTERNACHT.plusSeconds(10 * 3600);

    @Test
    void ohneLesungIstMitternachtUnbekanntUndSonstNichts() {
        assertThat(ErzeugerJetztService.heute(List.of(), MITTERNACHT, JETZT))
                .containsExactly(new ErzeugerJetztDto.Wechsel(zeit(MITTERNACHT), null));
    }

    @Test
    void derWertUmMitternachtKommtAusDerLetztenLesungDavorUndJederWechselZaehlt() {
        // 23:59:30 → 3, 02:00 → 1, 05:00 → 3, Lesungen bis jetzt.
        List<Wechselzeile> z = List.of(
                zeile(MITTERNACHT.minusSeconds(30), 3, null, false),
                zeile(MITTERNACHT.plusSeconds(7200), 1, MITTERNACHT.plusSeconds(7140), false),
                zeile(MITTERNACHT.plusSeconds(18000), 3, MITTERNACHT.plusSeconds(17940), false),
                zeile(JETZT.minusSeconds(5), 3, JETZT.minusSeconds(65), true));
        assertThat(ErzeugerJetztService.heute(z, MITTERNACHT, JETZT)).containsExactly(
                wechsel(MITTERNACHT, 3), wechsel(MITTERNACHT.plusSeconds(7200), 1),
                wechsel(MITTERNACHT.plusSeconds(18000), 3));
    }

    @Test
    void ersteLesungErstAmVormittagLaesstMitternachtUnbekannt() {
        // Gore am 23.10.2026: die Steuerung liefert erst ab 10:40.
        Instant ab = MITTERNACHT.plusSeconds(10 * 3600 + 40 * 60);
        Instant jetzt = ab.plusSeconds(600);
        List<Wechselzeile> z = List.of(zeile(ab, 1, null, false), zeile(jetzt.minusSeconds(10), 1, jetzt.minusSeconds(70), true));
        assertThat(ErzeugerJetztService.heute(z, MITTERNACHT, jetzt))
                .containsExactly(new ErzeugerJetztDto.Wechsel(zeit(MITTERNACHT), null), wechsel(ab, 1));
    }

    @Test
    void eineLueckeMachtDenWertUnbekanntBisZurNaechstenLesung() {
        Instant stumm = MITTERNACHT.plusSeconds(3 * 3600);
        Instant wieder = MITTERNACHT.plusSeconds(5 * 3600);
        List<Wechselzeile> z = List.of(
                zeile(MITTERNACHT.minusSeconds(30), 7, null, false),
                zeile(wieder, 7, stumm, false),
                zeile(JETZT.minusSeconds(600), 7, JETZT.minusSeconds(660), true));
        assertThat(ErzeugerJetztService.heute(z, MITTERNACHT, JETZT)).containsExactly(
                wechsel(MITTERNACHT, 7),
                new ErzeugerJetztDto.Wechsel(zeit(stumm.plusSeconds(AnlagensteuerungService.AKTUELL_BIS_S)), null),
                wechsel(wieder, 7),
                new ErzeugerJetztDto.Wechsel(zeit(JETZT.minusSeconds(600).plusSeconds(
                        AnlagensteuerungService.AKTUELL_BIS_S)), null));
    }

    @Test
    void eineLetzteLesungKurzVorMitternachtGiltNurBisZurLuecke() {
        // Gelesen 110 s vor Mitternacht, danach Schweigen: um Mitternacht gilt sie noch, 120 s nach ihr nicht mehr.
        List<Wechselzeile> z = List.of(zeile(MITTERNACHT.minusSeconds(110), 1, null, true));
        assertThat(ErzeugerJetztService.heute(z, MITTERNACHT, JETZT)).containsExactly(
                wechsel(MITTERNACHT, 1),
                new ErzeugerJetztDto.Wechsel(zeit(MITTERNACHT.plusSeconds(10)), null));
    }

    // ------------------------------------------------------------------ Gerüst

    private static Wechselzeile zeile(Instant zeit, long wert, Instant vorher, boolean letzte) {
        return new Wechselzeile("erzeuger.nb.n_bits", zeit, BigDecimal.valueOf(wert), vorher, letzte);
    }

    private static ErzeugerJetztDto.Wechsel wechsel(Instant ab, long wert) {
        return new ErzeugerJetztDto.Wechsel(zeit(ab), BigDecimal.valueOf(wert));
    }

    private static java.time.OffsetDateTime zeit(Instant t) {
        return t.atOffset(java.time.ZoneOffset.UTC);
    }

    static List<String> felder(Class<?> record) {
        return Arrays.stream(record.getRecordComponents()).map(c -> c.getName()).toList();
    }

    /** Die Feldnamen eines {@code export interface X { … }} in api.ts (Kommentarzeilen zählen nicht). */
    static List<String> interfaceFelder(String name) {
        Matcher kopf = Pattern.compile("export interface " + name + " \\{\\n").matcher(apiTs);
        assertThat(kopf.find()).as("interface " + name + " in api.ts").isTrue();
        int ende = apiTs.indexOf("\n}\n", kopf.end());
        List<String> out = new ArrayList<>();
        Matcher feld = Pattern.compile("(?m)^  ([a-zA-Z]+\\??):").matcher(apiTs.substring(kopf.end(), ende));
        while (feld.find()) {
            out.add(feld.group(1));
        }
        return out;
    }

    /** Die Felder eines inline getippten Felds von {@code ErzeugerJetzt} ({@code steuerung: { … }}). */
    static List<String> inlineFelder(String feld) {
        Matcher kopf = Pattern.compile("export interface ErzeugerJetzt \\{\\n").matcher(apiTs);
        assertThat(kopf.find()).isTrue();
        Matcher inline = Pattern.compile("(?m)^  " + feld + ": \\{ ([^}]+) \\}").matcher(apiTs);
        assertThat(inline.find(kopf.end())).as(feld + " inline in ErzeugerJetzt").isTrue();
        List<String> out = new ArrayList<>();
        Matcher name = Pattern.compile("([a-zA-Z]+): ").matcher(inline.group(1));
        while (name.find()) {
            out.add(name.group(1));
        }
        return out;
    }

    private static List<String> woerter(String union) {
        List<String> out = new ArrayList<>();
        Matcher m = Pattern.compile("'([a-z_]+)'").matcher(union);
        while (m.find()) {
            out.add(m.group(1));
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> schema(String name) {
        Map<String, Object> schema = (Map<String, Object>) schemas.get(name);
        assertThat(schema).as(name).isNotNull();
        return schema;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Map<String, Object> m, String key) {
        return (Map<String, Object>) m.get(key);
    }

    @SuppressWarnings("unchecked")
    private static List<String> liste(Map<String, Object> m, String... pfad) {
        Object o = m;
        for (String p : pfad) {
            o = ((Map<String, Object>) o).get(p);
        }
        return ((List<Object>) o).stream().map(String::valueOf).toList();
    }
}
