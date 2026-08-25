package com.voltpilot.api.consumers;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Der Waechter ueber die EINE Ehrlichkeitsregel des Audit-Vokabulars: <b>jedes Wort, das der
 * Produktionscode schreibt, muss der CHECK der Tabelle auch annehmen.</b>
 *
 * <p>Der Anlass ist ein echter Defekt (Steuerung Stufe 4): {@code V20260845000000} hat den CHECK
 * geweitet, dabei aber die Liste der TABELLEN-Migration {@code V20260812010000} abgeschrieben statt
 * des damals gueltigen Standes {@code V20260821000000} - die drei {@code switch_*}-Woerter der
 * Geraete-Freigabe fielen lautlos heraus. Der Schaden faellt erst dort auf, wo so ein Wort wirklich
 * geschrieben wird, also in einer ganz anderen Testklasse und als nackter HTTP 500.
 *
 * <p>Der Test ist bewusst REIN (kein Docker, keine DB): er liest die zuletzt gesetzte
 * CHECK-Definition aus den Migrationen und vergleicht sie mit den Zeichenketten, die der
 * Produktionscode wirklich einfuegt. Damit faellt er beim Bau um, nicht erst in einem
 * Testcontainers-Lauf.
 */
class ConsumerAuditEventTypesTest {

    private static final Path MIGRATIONS =
            Path.of("src/main/resources/db/migration");
    private static final Path MAIN = Path.of("src/main/java");

    /**
     * Der EINE Schreibpfad ist {@code ConsumerAuditRepository.append(siteId, entityId, eventType, ...)}
     * - das Wort steht dort immer als Literal an DRITTER Stelle. Genau darauf zielt der Ausdruck;
     * ein Aufruf, der es aus einer Variablen zoege, waere fuer diesen Waechter unsichtbar und
     * gehoert deshalb nicht in den Produktionscode.
     */
    private static final Pattern WRITTEN = Pattern.compile(
            "\\.append\\(\\s*[^,()]{1,60},\\s*[^,()]{1,60},\\s*\"([a-z][a-z_]{2,40})\"", Pattern.DOTALL);

    private static final Pattern CHECK_BLOCK = Pattern.compile(
            "consumer_audit_event_event_type_check\\s+CHECK\\s*\\(\\s*event_type\\s+IN\\s*\\((.*?)\\)\\s*\\)",
            Pattern.DOTALL);

    @Test
    @DisplayName("jedes vom Code geschriebene Audit-Wort steht im aktuellen CHECK")
    void everyWrittenEventTypeIsAcceptedByTheCurrentCheck() throws IOException {
        Set<String> allowed = currentlyAllowed();
        Set<String> written = writtenByProductionCode();

        assertThat(written)
                .as("der Produktionscode schreibt ueberhaupt Audit-Ereignisse")
                .isNotEmpty();
        assertThat(allowed)
                .as("jedes Wort, das der Code schreibt, nimmt der CHECK an - "
                        + "eine Weitung schreibt den AKTUELLEN Stand ab, nie den der Tabellen-Migration")
                .containsAll(written);
    }

    @Test
    @DisplayName("die drei switch_*-Woerter der Geraete-Freigabe ueberleben jede spaetere Weitung")
    void theSwitchReleaseVocabularySurvivesEveryLaterWidening() throws IOException {
        assertThat(currentlyAllowed())
                .containsAll(List.of("switch_tested", "switch_released", "switch_revoked"));
    }

    /** Die Woerter der ZULETZT gesetzten CHECK-Definition (Migrationen sortieren nach Version). */
    private static Set<String> currentlyAllowed() throws IOException {
        Optional<String> last;
        try (Stream<Path> files = Files.list(MIGRATIONS)) {
            last = files.filter(p -> p.getFileName().toString().endsWith(".sql"))
                    .sorted(Comparator.comparing(p -> p.getFileName().toString()))
                    .map(ConsumerAuditEventTypesTest::readQuietly)
                    .map(CHECK_BLOCK::matcher)
                    .map(m -> {
                        String found = null;
                        while (m.find()) {
                            found = m.group(1); // die LETZTE Setzung der Datei gewinnt
                        }
                        return Optional.ofNullable(found);
                    })
                    .flatMap(Optional::stream)
                    .reduce((a, b) -> b); // ueber alle Dateien: die spaeteste gewinnt
        }
        assertThat(last).as("eine CHECK-Definition fuer consumer_audit_event ist auffindbar").isPresent();
        return literals(stripComments(last.get()));
    }

    private static Set<String> writtenByProductionCode() throws IOException {
        Set<String> words = new LinkedHashSet<>();
        try (Stream<Path> files = Files.walk(MAIN)) {
            files.filter(p -> p.getFileName().toString().endsWith(".java"))
                    .map(ConsumerAuditEventTypesTest::readQuietly)
                    .forEach(src -> {
                        Matcher m = WRITTEN.matcher(src);
                        while (m.find()) {
                            words.add(m.group(1));
                        }
                    });
        }
        return words;
    }

    /**
     * Das Vokabular, wie es die Migrationen ueber alle Stufen kennen. Es ist bewusst hier
     * aufgeschrieben und nicht abgeleitet: ein neues Wort soll GENAU EINMAL bewusst
     * dazukommen - hier und im CHECK.
     */
    private static final Set<String> KNOWN_VOCABULARY = Set.of(
            "policy_saved", "policy_activated", "policy_deactivated",
            "paused", "resumed", "override_started", "override_stopped", "override_cleared",
            "switch_tested", "switch_released", "switch_revoked",
            "device_override_started", "device_override_cleared",
            "automation_paused", "automation_resumed");

    private static Set<String> literals(String block) {
        Set<String> out = new LinkedHashSet<>();
        Matcher m = Pattern.compile("'([a-z_]+)'").matcher(block);
        while (m.find()) {
            out.add(m.group(1));
        }
        return out;
    }

    private static String stripComments(String sql) {
        return sql.replaceAll("(?m)--.*$", "");
    }

    private static String readQuietly(Path p) {
        try {
            return Files.readString(p);
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }
}
