package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Quelltext-Wächter des Rechenlaufs (UEMS AP-11 IP-6, E5): gerechnet wird NUR in {@link KennzahlRegeln}, das selbst
 * keine Funktion für ein Mittel hat ({@code KennzahlVectorsTest}). Lauf, Leser und Vorschau teilen nie und mitteln nie —
 * so kann das ungewichtete Mittel 0,32 (K3) oder 0,2346 (K14) an keiner Stelle neben der Regel entstehen.
 */
class KennzahlLaufQuelltextTest {

    private static final Path QUELLEN = Path.of("src", "main", "java", "com", "voltpilot", "api", "uems");

    @Test
    void lauflLeserUndVorschauTeilenNieUndMittelnNie() throws IOException {
        for (String datei : List.of("KennzahlLauf.java", "KennzahlEingangLeser.java", "KennzahlVorschauService.java")) {
            String quelle = Files.readString(QUELLEN.resolve(datei));
            assertThat(quelle).as(datei + ": jede Division steht in KennzahlRegeln").doesNotContain(".divide(");
            assertThat(quelle).as(datei + ": kein Mittel").doesNotContain("average").doesNotContain("averaging");
            assertThat(quelle).as(datei + ": rechnet mit der Regel").contains("KennzahlRegeln");
        }
        assertThat(Files.readString(QUELLEN.resolve("KennzahlLauf.java"))).as("der Lauf ruft die Regel")
                .contains("KennzahlRegeln.wert(");
    }
}
