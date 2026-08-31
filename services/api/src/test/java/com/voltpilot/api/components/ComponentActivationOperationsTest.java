package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Derselbe Waechter wie {@code ConsumerAuditEventTypesTest}, fuer das zweite
 * Wort-Vokabular mit einem CHECK dahinter: <b>jede Operation, die der
 * Produktionscode in die Aktivierungs-Outbox schreibt, muss ihr CHECK auch
 * annehmen.</b>
 *
 * <p>Die Fehlerklasse ist belegt und teuer: sie faellt erst dort auf, wo das
 * Wort wirklich geschrieben wird - hier waere das jedes Anlegen einer
 * Komponente, als nackter HTTP 500 in einer ganz anderen Testklasse. Rein,
 * ohne Docker: der Lauf faellt beim Bau um, nicht erst mit Testcontainers.
 */
class ComponentActivationOperationsTest {

    private static final Path MIGRATIONS = Path.of("src/main/resources/db/migration");
    private static final Path MAIN = Path.of("src/main/java");

    /**
     * Der EINE Schreibpfad ist
     * {@code ComponentActivationOutboxService.enqueue(tenant, site, entity, revision, operation)}
     * - das Wort steht dort immer als LETZTES Argument und immer als Literal.
     * Gesucht wird deshalb der ganze Aufruf bis zum Semikolon (die Argumente
     * davor koennen selbst Klammern tragen, etwa {@code TenantContext.get()})
     * und daraus die letzte Zeichenkette.
     */
    private static final Pattern WRITTEN =
            Pattern.compile("\\.enqueue\\(([^;]{1,400}?)\\)\\s*;", Pattern.DOTALL);

    private static final Pattern CHECK_BLOCK = Pattern.compile(
            "CHECK\\s*\\(\\s*operation\\s+IN\\s*\\((.*?)\\)\\s*\\)", Pattern.DOTALL);

    @Test
    @DisplayName("jede vom Code geschriebene Outbox-Operation steht im aktuellen CHECK")
    void everyWrittenOperationIsAcceptedByTheCurrentCheck() throws IOException {
        Set<String> allowed = currentlyAllowed();
        Set<String> written = writtenByProductionCode();

        assertThat(written)
                .as("der Produktionscode reiht ueberhaupt Aktivierungen ein")
                .isNotEmpty();
        assertThat(allowed)
                .as("eine Weitung schreibt den AKTUELLEN Stand ab, nie den der Tabellen-Migration")
                .containsAll(written);
    }

    @Test
    @DisplayName("Anlegen, Bearbeiten und Rollback gehen alle drei ueber die Outbox")
    void allThreeWritingPathsUseTheOutbox() throws IOException {
        assertThat(writtenByProductionCode())
                .contains("component_create", "component_edit", "component_rollback");
    }

    private static Set<String> currentlyAllowed() throws IOException {
        Optional<String> last;
        try (Stream<Path> files = Files.list(MIGRATIONS)) {
            last = files.filter(p -> p.getFileName().toString().endsWith(".sql"))
                    .sorted(Comparator.comparing(p -> p.getFileName().toString()))
                    .map(ComponentActivationOperationsTest::readQuietly)
                    .map(sql -> {
                        Matcher m = CHECK_BLOCK.matcher(stripComments(sql));
                        String found = null;
                        while (m.find()) {
                            found = m.group(1); // die LETZTE Setzung der Datei gewinnt
                        }
                        return Optional.ofNullable(found);
                    })
                    .flatMap(Optional::stream)
                    .reduce((a, b) -> b); // ueber alle Dateien: die spaeteste gewinnt
        }
        assertThat(last).as("eine CHECK-Definition fuer `operation` ist auffindbar").isPresent();
        Set<String> out = new LinkedHashSet<>();
        Matcher m = Pattern.compile("'([a-z_]+)'").matcher(last.get());
        while (m.find()) {
            out.add(m.group(1));
        }
        return out;
    }

    private static Set<String> writtenByProductionCode() throws IOException {
        Set<String> words = new LinkedHashSet<>();
        try (Stream<Path> files = Files.walk(MAIN)) {
            files.filter(p -> p.getFileName().toString().endsWith(".java"))
                    .map(ComponentActivationOperationsTest::readQuietly)
                    .forEach(src -> {
                        Matcher m = WRITTEN.matcher(src);
                        while (m.find()) {
                            Matcher last = Pattern.compile("\"([a-z][a-z_]{2,40})\"")
                                    .matcher(m.group(1));
                            String word = null;
                            while (last.find()) {
                                word = last.group(1);
                            }
                            if (word != null) {
                                words.add(word);
                            }
                        }
                    });
        }
        return words;
    }

    private static String stripComments(String sql) {
        return sql.replaceAll("(?m)--.*$", "");
    }

    private static String readQuietly(Path p) {
        try {
            return Files.readString(p);
        } catch (IOException e) {
            throw new IllegalStateException(p.toString(), e);
        }
    }
}
