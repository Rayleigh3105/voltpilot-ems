package com.voltpilot.api.metrics;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * AP-14 IP-9: der Katalog der UEMS-Läufer gegen den CODE — und die ausgelieferte Verdrahtung des
 * Sammlers.
 *
 * <p><b>Warum es diesen Test gibt.</b> Der Wert des Läufer-Alters steht und fällt mit der
 * VOLLSTÄNDIGKEIT des Katalogs: ein künftiger Läufer, den niemand einträgt, ist unbeobachtet, und
 * niemand merkt es — die Metrik sieht ja aus wie vorher. Darum liest dieser Test die Quelltexte der
 * drei UEMS-Pakete und verlangt für JEDE Klasse mit einem Takt ({@code @Scheduled}) oder einem
 * Start-Lauf ({@code ApplicationReadyEvent}) einen Katalog-Eintrag — und umgekehrt für jeden
 * Eintrag die Klasse.
 *
 * <p>Dazu die zweite stille Falle: ein TIPPFEHLER im Schalternamen eines Eintrags. Der Sammler läse
 * ihn dann als „nicht gesetzt“ und damit als AN, und ein abgeschalteter Läufer erschiene für immer
 * als „lief nie“. Also muss jeder Schalter des Katalogs in der echten {@code application.yml} stehen.
 */
class UemsMetrikenWiringTest {

    /** Die Pakete, in denen UEMS-Läufer leben. */
    private static final List<Path> PAKETE = List.of(
            Path.of("src/main/java/com/voltpilot/api/uems"),
            Path.of("src/main/java/com/voltpilot/api/unterstuetzung"),
            Path.of("src/main/java/com/voltpilot/api/zugriff"),
            // AP-15 IP-3: der Grenzblatt-Anstoß lebt beim Ladepark.
            Path.of("src/main/java/com/voltpilot/api/chargers"));

    /** Jede Bean am gemeinsamen UEMS-Metrikschalter — neue Beans müssen bewusst in diese Klammer. */
    private static final Set<String> METRIK_BEANS = Set.of(
            "GemeinsameSteuerungHerzschlag",
            "GemeinsameSteuerungMetrikSammler",
            "GemeinsameSteuerungUhrMetrik",
            "UemsMetricsCollector",
            "VerbundBilanzMetrik",
            "VorbehaltMetrik");

    /**
     * {@code PlanResultListener} (AP-15 IP-10), {@code VerbundAnteileResultListener} (AP-15 IP-7) und
     * {@code SprungprobeBerichtListener} (AP-15 IP-21) halten mit ihrem Takt nur die Broker-Verbindung, es gibt keinen
     * Lauf, der stehen könnte.
     */
    private static final Set<String> KEIN_LAEUFER = Set.of("PlanResultListener", "VerbundAnteileResultListener",
            "SprungprobeBerichtListener");

    @Test
    void jedeKlasseMitTaktOderStartLaufStehtImKatalogUndUmgekehrt() throws IOException {
        List<String> imCode = PAKETE.stream().flatMap(UemsMetrikenWiringTest::klassenMitLauf)
                .filter(k -> !KEIN_LAEUFER.contains(k)).sorted().toList();
        List<String> imKatalog = UemsLaeuferMelder.KATALOG.stream()
                .map(UemsLaeuferMelder.Eintrag::klasse).sorted().toList();

        assertThat(imCode).as("im Code gefundene Laeufer").isNotEmpty();
        assertThat(imKatalog).as("jeder Laeufer des Codes ist im Katalog - sonst ist er unbeobachtet")
                .containsExactlyElementsOf(imCode);
    }

    @Test
    void jederLabelWertKommtGenauEinmalVor() {
        List<String> label = UemsLaeuferMelder.KATALOG.stream()
                .map(UemsLaeuferMelder.Eintrag::label).toList();

        assertThat(label).doesNotHaveDuplicates();
        // Der Wortlaut, an dem die Regel VoltPilotLueckenMelderSteht haengt.
        assertThat(label).contains("luecken");
        assertThat(UemsLaeuferMelder.BESTANDS_LAEUFER).allMatch(label::contains);
    }

    @Test
    @SuppressWarnings("unchecked")
    void jederSchalterDesKatalogsStehtSoInDerAusgeliefertenApplicationYml() throws IOException {
        Map<String, Object> yml = yaml();

        for (UemsLaeuferMelder.Eintrag e : UemsLaeuferMelder.KATALOG) {
            for (String schalter : e.schalter()) {
                assertThat(at(yml, schalter.split("\\."))).as("%s in application.yml", schalter)
                        .isNotNull();
            }
        }
    }

    /** Die AUSGELIEFERTE Vorgabe des Sammlers ist AN — und der Testlauf schaltet sie aus. */
    @Test
    void derSammlerIstAusgeliefertAnUndImTestlaufAus() throws IOException {
        Map<String, Object> yml = yaml();

        assertThat(at(yml, "voltpilot", "metrics", "uems", "enabled"))
                .isEqualTo("${VOLTPILOT_METRICS_UEMS_ENABLED:true}");
        assertThat(at(yml, "voltpilot", "metrics", "uems", "interval-ms"))
                .as("der billige Minuten-Takt, nicht der taegliche der Speicherklassen")
                .isEqualTo("${VOLTPILOT_METRICS_UEMS_INTERVAL_MS:60000}");

        String pom = Files.readString(Path.of("pom.xml"));
        assertThat(pom).contains(
                "<voltpilot.metrics.uems.enabled>false</voltpilot.metrics.uems.enabled>");
    }

    @Test
    void jedeBeanAmUemsMetrikschalterStehtInDerKlammer() throws IOException {
        Path paket = Path.of("src/main/java/com/voltpilot/api/metrics");
        try (Stream<Path> dateien = Files.list(paket)) {
            List<String> imCode = dateien.filter(p -> p.toString().endsWith(".java"))
                    .filter(p -> enthaelt(p, "@Component")
                            && enthaelt(p, "voltpilot.metrics.uems.enabled"))
                    .map(p -> p.getFileName().toString().replace(".java", ""))
                    .sorted().toList();

            assertThat(imCode).containsExactlyElementsOf(METRIK_BEANS.stream().sorted().toList());
        }
    }

    // ---------------------------------------------------------------------------------------------

    private static Stream<String> klassenMitLauf(Path paket) {
        try (Stream<Path> dateien = Files.list(paket)) {
            return dateien.filter(p -> p.toString().endsWith(".java"))
                    .filter(UemsMetrikenWiringTest::hatLauf)
                    .map(p -> p.getFileName().toString().replace(".java", ""))
                    .toList().stream();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /**
     * Ein Takt oder ein Start-Lauf — und zwar im CODE, nicht im Javadoc: mehrere Läufer erklären die
     * {@code @Scheduled}-Falle in ihrem Kommentar, und ein Kommentar ist kein Lauf.
     */
    private static boolean hatLauf(Path datei) {
        try {
            return Files.readAllLines(datei).stream()
                    .map(String::stripLeading)
                    .anyMatch(z -> !z.startsWith("*") && !z.startsWith("//")
                            && (z.startsWith("@Scheduled(") || z.contains("ApplicationReadyEvent.class")));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static boolean enthaelt(Path datei, String text) {
        try {
            return Files.readString(datei).contains(text);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> yaml() throws IOException {
        try (InputStream in = UemsMetrikenWiringTest.class.getResourceAsStream("/application.yml")) {
            assertThat(in).as("application.yml auf dem Klassenpfad").isNotNull();
            return (Map<String, Object>) new Yaml().loadAll(in).iterator().next();
        }
    }

    @SuppressWarnings("unchecked")
    private static Object at(Map<String, Object> yml, String... pfad) {
        Object knoten = yml;
        for (String schluessel : pfad) {
            if (!(knoten instanceof Map<?, ?> m)) {
                return null;
            }
            knoten = ((Map<String, Object>) m).get(schluessel);
        }
        return knoten;
    }
}
