package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * Der Flag-Nachweis der energetischen Bewertung (UEMS AP-16 IP-27, R11 Schritt 4, §6.6): {@code
 * voltpilot.uems.bewertung.enabled} (Vorgabe AN) schaltet NUR die Kaskaden-Naht ({@link BerichtKaskade}) und den
 * Struktur-Läufer ({@link StrukturAenderungLaeufer}). Keine Route, kein Dienst und keine Bean-Bedingung liest ihn — darum
 * antworten die Routen mit Flag aus gleich. Ein reiner Quelltext-Wächter ohne Datenbank; das Verhalten beider Stellen
 * prüfen {@code UemsBewertungBestandsschutzTest} (Bestand) und {@code UemsStrukturAenderungTest} (echte Bewertung).
 */
class UemsBewertungFlagArchitekturTest {

    private static final String FLAG = "voltpilot.uems.bewertung.enabled";
    private static final Path MAIN = Path.of("src", "main", "java");

    @Test
    void dasFlagLesenNurDieNahtUndDerLaeufer() throws IOException {
        assertThat(quellen().filter(p -> text(p).contains(FLAG)).map(p -> p.getFileName().toString()).sorted().toList())
                .as("wer %s liest", FLAG)
                .containsExactly("BerichtKaskade.java", "StrukturAenderungLaeufer.java");
        for (String datei : List.of("BerichtKaskade.java", "StrukturAenderungLaeufer.java")) {
            String text = text(MAIN.resolve("com/voltpilot/api/uems").resolve(datei));
            assertThat(text).as(datei + ": ein Feld mit Vorgabe AN, keine Bean-Bedingung")
                    .contains("@Value(\"${" + FLAG + ":true}\")")
                    .doesNotContain("prefix = \"voltpilot.uems.bewertung\"");
        }
    }

    @Test
    void keineRouteUndKeinPortalKenntDasFlag() throws IOException {
        assertThat(quellen().filter(p -> p.toString().contains("/web/"))
                .filter(p -> text(p).contains("uems.bewertung") || text(p).contains("bewertungEnabled")).toList())
                .as("Controller und DTOs").isEmpty();
        try (Stream<Path> portal = Files.walk(Path.of("..", "..", "frontend", "portal", "src"))) {
            assertThat(portal.filter(p -> p.toString().endsWith(".ts") || p.toString().endsWith(".tsx")).filter(p -> text(p).contains("BEWERTUNG_ENABLED")
                    || text(p).contains("bewertung.enabled")).toList()).as("das Portal hat keinen Schalter").isEmpty();
        }
    }

    @Test
    void dieVorgabeIstAnUndDerTestlaufSetztNichts() throws IOException {
        assertThat(text(Path.of("src", "main", "resources", "application.yml")))
                .contains("enabled: ${VOLTPILOT_UEMS_BEWERTUNG_ENABLED:true}");
        assertThat(text(Path.of("pom.xml"))).as("surefire lässt die Vorgabe stehen").doesNotContain(FLAG);
    }

    private static Stream<Path> quellen() throws IOException {
        return Files.walk(MAIN).filter(p -> p.toString().endsWith(".java")).toList().stream();
    }

    private static String text(Path p) {
        try {
            return Files.readString(p);
        } catch (IOException e) {
            throw new IllegalStateException(p.toString(), e);
        }
    }
}
