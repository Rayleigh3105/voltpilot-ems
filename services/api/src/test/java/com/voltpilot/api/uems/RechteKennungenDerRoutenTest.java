package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Die Rechte-Kennungen, die die UEMS-Routen im Kommentar nennen, stehen in der Rechte-Matrix
 * {@code docs/contracts/v2/rechte-matrix.json} — bis AP-03 die Durchsetzung bringt (IP-6/IP-7,
 * {@code @Recht("…")}), ist der Kommentar die EINE Stelle, an der eine Route ihr Recht nennt, und
 * dieser Test hält ihn ehrlich.
 *
 * <p>Welche Controller: jeder unter {@code web/}, dessen Klassen-Javadoc „UEMS“ nennt — eine neue
 * UEMS-Route ist damit ohne Pflege dabei; die heute bekannten stehen in {@code MINDESTENS}, damit
 * ein kaputter Sucher auffällt.
 *
 * <p>Je Controller: jede Route ({@code @Get/Post/Put/Patch/DeleteMapping}) trägt direkt darüber einen
 * Kommentar mit „Recht“, der eine Kennung nennt ({@code {@code bereich.taetigkeit}} oder
 * {@code `bereich.taetigkeit`}) oder ausdrücklich „keine eigene Kennung“ sagt; und JEDE Kennung in
 * einem Rechte-Kommentar steht in der Matrix. Ein bloßes „wie oben“ zählt nicht: schiebt sich eine
 * Route dazwischen, erbt die Lese-Route still das Schreibrecht (so geschehen, als der
 * Kurzzeichen-Vorschlag vor {@code GET /standorte/{id}} kam). Eine neue UEMS-Route ohne
 * Rechte-Kommentar oder mit einer erfundenen Kennung fällt hier auf.
 *
 * <p>Rein; liest nur Quelltext und die Matrix-Datei (kein Spring, keine DB).
 */
class RechteKennungenDerRoutenTest {

    // Arbeitsverzeichnis ist services/api; das Repo-Wurzelverzeichnis liegt zwei Ebenen darüber.
    private static final Path MATRIX = Path.of("..", "..", "docs", "contracts", "v2", "rechte-matrix.json");
    private static final Path WEB = Path.of("src", "main", "java", "com", "voltpilot", "api", "web");

    /**
     * Die UEMS-Controller von heute: Messstellen, Messkanäle, Geräte und ihre Einstellungen (AP-04),
     * das Änderungsprotokoll (AP-04 IP-21), Datenquellen (AP-06), Standorte, Unternehmen, Gebäude
     * und Bereiche (AP-02) — und seit AP-07 IP-14 der LESEPFAD der Messdatenstrecke (Verlauf,
     * Herkunft, Export) auf {@code DeviceMeasurementSelectionController}.
     */
    private static final List<String> MINDESTENS = List.of("MessstelleController", "KomponenteMesskanalController",
            "GeraetController", "GeraetEinstellungController", "GeraetWechselController",
            "DatenquelleController", "StandortController", "UnternehmenController", "OrtController",
            "MessstelleVorschlagController", "AenderungsprotokollController",
            "DeviceMeasurementSelectionController", "BezugsgroesseController",
            "KostenstelleProzessController", "MessstelleWerteController", "VerteilungController");

    private static final Pattern KLASSE = Pattern.compile("(?m)^public (?:final )?class ");
    private static final Pattern JAVADOC_BEGINN = Pattern.compile("(?m)^/\\*\\*");

    private static final Pattern ROUTE = Pattern.compile("^\\s*@(Get|Post|Put|Patch|Delete)Mapping\\b");
    private static final Pattern KENNUNG =
            Pattern.compile("(?:\\{@code\\s+|`)([a-z][a-z_]*\\.[a-z][a-z_]*)(?:}|`)");

    /** Ein Kommentar (Javadoc-Block oder zusammenhängende {@code //}-Zeilen) und die Route darunter. */
    private record Kommentar(String text, String route) {
        boolean rechte() {
            return text.contains("Recht");
        }

        List<String> kennungen() {
            List<String> out = new ArrayList<>();
            Matcher m = KENNUNG.matcher(text);
            while (m.find()) {
                out.add(m.group(1));
            }
            return out;
        }
    }

    private static Set<String> matrixKennungen() throws Exception {
        JsonNode m = new ObjectMapper().readTree(Files.readString(MATRIX));
        Set<String> out = new TreeSet<>();
        m.path("aktionen").forEach(a -> out.add(a.path("kennung").asText()));
        return out;
    }

    /** Liest die Kommentare einer Datei; {@code route} ist die Mapping-Zeile direkt darunter oder null. */
    private static List<Kommentar> kommentare(Path datei) throws Exception {
        List<String> zeilen = Files.readAllLines(datei);
        List<Kommentar> out = new ArrayList<>();
        int i = 0;
        while (i < zeilen.size()) {
            String z = zeilen.get(i).strip();
            StringBuilder text = new StringBuilder();
            if (z.startsWith("/**") || z.startsWith("/*")) {
                while (true) {
                    text.append(zeilen.get(i)).append('\n');
                    if (zeilen.get(i).contains("*/")) {
                        break;
                    }
                    i++;
                }
                i++;
            } else if (z.startsWith("//")) {
                while (i < zeilen.size() && zeilen.get(i).strip().startsWith("//")) {
                    text.append(zeilen.get(i)).append('\n');
                    i++;
                }
            } else {
                i++;
                continue;
            }
            String route = i < zeilen.size() && ROUTE.matcher(zeilen.get(i)).find() ? zeilen.get(i).strip() : null;
            out.add(new Kommentar(text.toString(), route));
        }
        return out;
    }

    /** Jeder Controller unter {@code web/}, dessen Klassen-Javadoc „UEMS“ nennt. */
    private static List<String> uemsController() throws Exception {
        List<String> out = new ArrayList<>();
        try (var dateien = Files.list(WEB)) {
            List<Path> controller = dateien
                    .filter(x -> x.getFileName().toString().endsWith("Controller.java")).sorted().toList();
            for (Path p : controller) {
                String s = Files.readString(p);
                Matcher klasse = KLASSE.matcher(s);
                if (!klasse.find()) {
                    continue;
                }
                Matcher doc = JAVADOC_BEGINN.matcher(s.substring(0, klasse.start()));
                int beginn = -1;
                while (doc.find()) {
                    beginn = doc.start();
                }
                if (beginn >= 0 && s.substring(beginn, klasse.start()).contains("UEMS")) {
                    out.add(p.getFileName().toString().replace(".java", ""));
                }
            }
        }
        return out;
    }

    @Test
    void derSucherFindetDieUemsController() throws Exception {
        assertThat(uemsController()).containsAll(MINDESTENS).doesNotContain("SiteController", "OverviewController");
    }

    private static int routen(Path datei) throws Exception {
        return (int) Files.readAllLines(datei).stream().filter(l -> ROUTE.matcher(l).find()).count();
    }

    @TestFactory
    List<DynamicTest> jedeRouteNenntIhrRechtUndJedeKennungStehtInDerMatrix() throws Exception {
        Set<String> matrix = matrixKennungen();
        List<DynamicTest> tests = new ArrayList<>();
        for (String name : uemsController()) {
            Path datei = WEB.resolve(name + ".java");
            tests.add(DynamicTest.dynamicTest(name, () -> {
                List<Kommentar> alle = kommentare(datei);
                Set<String> genannt = new LinkedHashSet<>();
                for (Kommentar k : alle) {
                    if (k.rechte()) {
                        genannt.addAll(k.kennungen());
                    }
                }
                assertThat(genannt).as("%s nennt keine Kennung — liest der Test noch die Kommentare?", name)
                        .isNotEmpty();
                assertThat(matrix).as("%s: Kennung im Rechte-Kommentar, die nicht in rechte-matrix.json steht", name)
                        .containsAll(genannt);

                List<Kommentar> anRouten = alle.stream().filter(k -> k.route() != null).toList();
                assertThat(anRouten).as("%s: jede Route trägt direkt darüber einen Kommentar", name)
                        .hasSize(routen(datei));
                for (Kommentar k : anRouten) {
                    assertThat(k.rechte()).as("%s %s: der Kommentar nennt kein Recht", name, k.route()).isTrue();
                    boolean benannt = !k.kennungen().isEmpty() || k.text().contains("keine eigene Kennung");
                    assertThat(benannt)
                            .as("%s %s: eine Kennung oder ausdrücklich „keine eigene Kennung“", name, k.route())
                            .isTrue();
                }
            }));
        }
        return tests;
    }

    /** Der Leser selbst: er findet beide Schreibweisen und nichts, was keine Kennung ist. */
    @Test
    void derLeserFindetBeideSchreibweisen() {
        Kommentar k = new Kommentar(
                "/** Recht: {@code messstelle.ansehen}; bis dahin `aenderungsprotokoll.lesen`, nie"
                        + " {@code /api/v1/sites/**}, {@code rechte-matrix.json} oder {@code X-Tenant-Id}. */",
                "@GetMapping");
        assertThat(k.kennungen()).containsExactly("messstelle.ansehen", "aenderungsprotokoll.lesen");
    }
}
