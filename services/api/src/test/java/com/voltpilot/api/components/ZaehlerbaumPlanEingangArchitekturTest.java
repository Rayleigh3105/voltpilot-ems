package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * R8 (docs/contracts/v2/zaehlerbaum.md, Bericht §5): der Zählerbaum ist eine Anzeige- und
 * Zuordnungsregel - der Registry-Push zur Box, der Soll-Stand und der Plan-Eingang des Optimierers
 * bleiben MIT und OHNE Baum byte-identisch. Keiner der drei Wege darf {@code haengt_an} je lesen.
 *
 * <p>Dieser Test prüft das strukturell, nicht nur stichprobenartig: keiner der drei Pfade importiert
 * oder benennt den Baum überhaupt (Registry-Push: {@code EntityRegistryService.composePush} und der
 * Go-Soll-Stand unter {@code edge-app/core/internal/entities}; Plan-Eingang: der Python-Optimierer
 * unter {@code services/optimization/voltpilot_optimization} sowie das Java-{@code optimizer}-Paket).
 * Das ist der stärkere Beweis als ein einzelner Vergleichslauf mit/ohne Baum - eine zufällige
 * Übereinstimmung zweier Läufe wäre keiner.
 *
 * <p>Rein: liest nur Quelltext (auch Go und Python - der Baum darf dort ebenso wenig auftauchen).
 */
class ZaehlerbaumPlanEingangArchitekturTest {

    private static final Path API_JAVA = Path.of("src", "main", "java", "com", "voltpilot", "api");
    private static final Path REPO_ROOT = Path.of("..", "..");

    /** Begriffe, die NUR den Zählerbaum selbst benennen - Registry-Push und Plan-Eingang kennen sie nicht. */
    private static final List<String> BAUM_BEGRIFFE = List.of(
            "haengt_an", "haengtAn", "parent_entity_id", "ParentEntityID",
            "ZaehlerbaumService", "KomponenteHaengtAnRepository", "komponente_haengt_an");

    @Test
    void registryPushJavaKenntKeinenBaum() throws IOException {
        assertKeinBaum(API_JAVA.resolve("entities"), p -> p.toString().endsWith(".java"));
    }

    @Test
    void registryPushGoKenntKeinenBaum() throws IOException {
        assertKeinBaum(REPO_ROOT.resolve(Path.of("edge-app", "core", "internal", "entities")),
                p -> p.toString().endsWith(".go"));
    }

    @Test
    void planEingangPythonKenntKeinenBaum() throws IOException {
        assertKeinBaum(REPO_ROOT.resolve(Path.of("services", "optimization", "voltpilot_optimization")),
                p -> p.toString().endsWith(".py"));
    }

    @Test
    void planEingangJavaOptimiererPaketKenntKeinenBaum() throws IOException {
        assertKeinBaum(API_JAVA.resolve("optimizer"), p -> p.toString().endsWith(".java"));
    }

    private void assertKeinBaum(Path verzeichnis, java.util.function.Predicate<Path> passendeDatei)
            throws IOException {
        Set<String> gefunden = new TreeSet<>();
        try (Stream<Path> s = Files.walk(verzeichnis)) {
            for (Path p : s.filter(passendeDatei).sorted().toList()) {
                String quelle = Files.readString(p);
                for (String begriff : BAUM_BEGRIFFE) {
                    if (quelle.contains(begriff)) {
                        gefunden.add(p.getFileName() + ": " + begriff);
                    }
                }
            }
        }
        assertThat(gefunden)
                .as("der Zählerbaum ist Anzeige-/Zuordnungsregel, kein Eingang für Registry-Push oder "
                        + "Plan-Eingang (R8) - ein Treffer hier ist ein Leck, keine Absicht")
                .isEmpty();
    }
}
