package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * Quelltext-Probe NW-1 der Bezugsbasis (UEMS AP-17 IP-10): „das Mittel der Monats-Δ wird nirgends gebildet“. Gerechnet
 * wird NUR in den drei Zwillingen der Regel ({@link BezugsbasisRegeln}, {@code bezugsbasis.ts}, {@code bezugsbasis.py});
 * dort ist ein Mittel nur der Schwerpunkt der Monatspaare für die kleinsten Quadrate ({@code xs}, {@code ys}) — nie über
 * Prozentwerte. Ein Zeitraum rechnet Σ gemessen ÷ Σ erwartet (R11: 1,8 %, nicht das Mittel 2,2 %). Dienst, Grundlage
 * und Route teilen nie und mitteln nie (Muster {@code KennzahlLaufQuelltextTest}).
 */
class BezugsbasisQuelltextTest {

    private static final Path QUELLEN = Path.of("src", "main", "java", "com", "voltpilot", "api", "uems");
    private static final Path WURZEL = Path.of("..", "..");

    @Test
    void dienstGrundlageUndRouteTeilenNieUndMittelnNie() throws IOException {
        for (Path datei : List.of(QUELLEN.resolve("BezugsbasisService.java"), QUELLEN.resolve("BezugsbasisGrundlage.java"),
                Path.of("src", "main", "java", "com", "voltpilot", "api", "web", "BezugsbasisController.java"))) {
            String quelle = Files.readString(datei);
            assertThat(quelle).as(datei + ": jede Division steht in BezugsbasisRegeln").doesNotContain(".divide(");
            assertThat(quelle).as(datei + ": kein Mittel").doesNotContain("average").doesNotContain("mittel(")
                    .doesNotContain("Mittel(");
        }
        assertThat(Files.readString(QUELLEN.resolve("BezugsbasisGrundlage.java"))).as("die Grundlage ruft die Regel")
                .contains("BezugsbasisRegeln.basiswert(").contains("BezugsbasisRegeln.modell(");
    }

    @Test
    void dieZwillingeMittelnNurDieMonatspaareUndSummierenDenZeitraum() throws IOException {
        String java = Files.readString(QUELLEN.resolve("BezugsbasisRegeln.java"));
        String ts = Files.readString(WURZEL.resolve("frontend/portal/src/bezugsbasis.ts"));
        String py = Files.readString(WURZEL.resolve("services/optimization/voltpilot_optimization/bezugsbasis.py"));
        assertThat(nurPaare(java)).as("Java: mittel() nur über xs/ys").isTrue();
        assertThat(nurPaare(ts)).as("TS: mittel() nur über xs/ys").isTrue();
        // Python teilt durch n nur für den Schwerpunkt der Paare (sum(xs) / n, sum(ys) / n).
        Matcher geteilt = Pattern.compile("sum\\((\\w+)\\) / n\\b|/ n\\b").matcher(py);
        int schwerpunkte = 0;
        while (geteilt.find()) {
            assertThat(geteilt.group(1)).as("Python: / n nur hinter sum(xs) oder sum(ys)").isIn("xs", "ys");
            schwerpunkte++;
        }
        assertThat(schwerpunkte).isPositive();
        assertThat(py).doesNotContain("mean(").doesNotContain("statistics");
        // R11: der Zeitraum summiert gemessen und erwartet — nie ein Mittel über die Monats-Δ.
        assertThat(rumpf(java, "public static Map<String, Object> zeitraum(")).contains("summe(").doesNotContain("mittel(");
        assertThat(rumpf(ts, "export function zeitraum(")).contains("summe(").doesNotContain("mittel(");
        assertThat(rumpf(py, "def zeitraum(")).contains("sum(").doesNotContain("/ n").doesNotContain("/ len(");
    }

    /** Jeder Aufruf {@code mittel(…)} außer der Definition nimmt {@code xs} oder {@code ys}. */
    private static boolean nurPaare(String quelle) {
        Matcher m = Pattern.compile("(?<![A-Za-z_])mittel\\(([^)]*)\\)").matcher(quelle);
        int aufrufe = 0;
        while (m.find()) {
            String arg = m.group(1).trim();
            if (arg.startsWith("List<Q>") || arg.startsWith("w:") || arg.startsWith("werte")) {
                continue;
            }
            if (!arg.equals("xs") && !arg.equals("ys")) {
                return false;
            }
            aufrufe++;
        }
        return aufrufe > 0;
    }

    /** Der Text ab {@code kopf} bis zur nächsten Funktion auf oberster Ebene. */
    private static String rumpf(String quelle, String kopf) {
        int a = quelle.indexOf(kopf);
        assertThat(a).as(kopf).isGreaterThanOrEqualTo(0);
        Matcher naechste = Pattern.compile("\n(    public static |export |def )").matcher(quelle);
        return naechste.find(a + kopf.length()) ? quelle.substring(a, naechste.start()) : quelle.substring(a);
    }
}
