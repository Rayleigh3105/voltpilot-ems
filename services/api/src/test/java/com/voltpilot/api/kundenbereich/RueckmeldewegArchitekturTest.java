package com.voltpilot.api.kundenbereich;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * Die MQTT-Rückmeldewege der API aus dem CODE (UEMS AP-20, Folgepaket zu IP-16, E10 = A „alles gesperrt"): jede
 * Klasse, die bei einem Paho-Client abonniert ({@code .subscribe(}), ist ein {@link Rueckmeldeweg}, und die erste
 * Anweisung ihres {@code handle(String topic, …)} fragt {@code kundenbereichBeendet(topic)}. Ein neuer Weg, der das
 * vergisst, schriebe weiter in beendete Kundenbereiche — hier fällt er auf, ohne Datenbank.
 *
 * <p>Keine Liste von Hand: die Wege kommen aus den Quelltexten, und die Menge muss GENAU die Menge der Unterklassen
 * von {@link Rueckmeldeweg} sein.
 */
public class RueckmeldewegArchitekturTest {

    private static final Path QUELLE = Path.of("src/main/java");
    private static final Pattern HANDLE = Pattern.compile("(?:public |protected |private )?(?:void|boolean) "
            + "handle\\(String topic, byte\\[] \\w+(?:, Instant \\w+)?\\) \\{\\s*\\n\\s*(.*)");

    /** Die abonnierenden Klassen, gelesen aus {@code src/main/java} (voll qualifizierte Namen, sortiert). */
    public static List<String> wegeImCode() {
        try (Stream<Path> dateien = Files.walk(QUELLE)) {
            return dateien.filter(p -> p.toString().endsWith(".java"))
                    .filter(RueckmeldewegArchitekturTest::abonniert)
                    .map(p -> QUELLE.relativize(p).toString().replace(".java", "").replace('/', '.'))
                    .sorted().toList();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @Test
    void jedeAbonnierendeKlasseIstEinRueckmeldewegUndUmgekehrt() throws Exception {
        List<String> wege = wegeImCode();
        assertThat(wege).as("die Rückmeldewege im Code").isNotEmpty();
        for (String weg : wege) {
            assertThat(Rueckmeldeweg.class.isAssignableFrom(Class.forName(weg)))
                    .as("%s abonniert bei einem Paho-Client und ist ein Rueckmeldeweg", weg).isTrue();
        }
        try (Stream<Path> dateien = Files.walk(QUELLE)) {
            List<String> unterklassen = dateien.filter(p -> p.toString().endsWith(".java"))
                    .filter(p -> enthaelt(p, " extends Rueckmeldeweg "))
                    .map(p -> QUELLE.relativize(p).toString().replace(".java", "").replace('/', '.'))
                    .sorted().toList();
            assertThat(unterklassen).as("jeder Rueckmeldeweg abonniert auch").containsExactlyElementsOf(wege);
        }
    }

    @Test
    void dieErsteAnweisungJedesEingangsFragtNachDemBeendetenKundenbereich() throws IOException {
        for (String weg : wegeImCode()) {
            String text = Files.readString(QUELLE.resolve(weg.replace('.', '/') + ".java"));
            Matcher m = HANDLE.matcher(text);
            assertThat(m.find()).as("%s hat genau einen Eingang handle(String topic, …)", weg).isTrue();
            assertThat(m.group(1)).as("%s: erste Anweisung im Eingang", weg)
                    .startsWith("if (kundenbereichBeendet(topic)) return");
            assertThat(m.find()).as("%s: nur ein Eingang", weg).isFalse();
        }
    }

    private static boolean enthaelt(Path datei, String text) {
        try {
            return Files.readString(datei).contains(text);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static boolean abonniert(Path datei) {
        try {
            return Files.readAllLines(datei).stream().map(String::strip)
                    .anyMatch(z -> !z.startsWith("*") && !z.startsWith("//") && z.contains(".subscribe("))
                    && Files.readString(datei).contains("org.eclipse.paho");
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
