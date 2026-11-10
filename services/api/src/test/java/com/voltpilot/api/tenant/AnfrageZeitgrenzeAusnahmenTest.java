package com.voltpilot.api.tenant;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/**
 * Wartung Datenbank-Zeitgrenze (vp-db-zeitgrenze, Steer-Nachweis Punkt 2): die drei synchronen
 * HTTP-Schreibwege, deren Dauer bei einer groß gewachsenen Anlage realistisch an die
 * 30-s-Anfrage-Zeitgrenze kommt (volle Historie löschen/neu aufbauen bzw. je Zeile mehrere
 * Abfragen), rufen {@link AnfrageZeitgrenze#ausnahme()} VOR dem teuren Aufruf - sonst würde ein
 * künftiger Umbau, der die Reihenfolge vertauscht oder den Aufruf entfernt, die Ausnahme lautlos
 * wieder einkassieren. Begründung je Weg steht als Kommentar an der jeweiligen Stelle; dieser Test
 * hält nur die REIHENFOLGE fest, keine Kopie der Begründung.
 */
class AnfrageZeitgrenzeAusnahmenTest {

    private static final Path WURZEL = Path.of("src/main/java/com/voltpilot/api");

    private record Weg(String datei, String ausnahmeVor) {}

    private static final Weg[] WEGE = {
            new Weg("web/DeviceController.java", "purge.purge("),
            new Weg("web/SiteController.java", "series.deleteForSite("),
            new Weg("web/BezugsdatenImportController.java", "uebernahme.uebernehmen("),
    };

    @Test
    void jederWegRuftDieAusnahmeVorDemTeurenAufrufAuf() throws IOException {
        for (Weg weg : WEGE) {
            String quelle = Files.readString(WURZEL.resolve(weg.datei()), StandardCharsets.UTF_8);
            int ausnahme = quelle.indexOf("AnfrageZeitgrenze.ausnahme();");
            int teurerAufruf = quelle.indexOf(weg.ausnahmeVor());
            assertThat(ausnahme).as("%s: AnfrageZeitgrenze.ausnahme() fehlt", weg.datei()).isGreaterThan(-1);
            assertThat(teurerAufruf).as("%s: Beleg-Aufruf '%s' fehlt", weg.datei(), weg.ausnahmeVor())
                    .isGreaterThan(-1);
            assertThat(ausnahme).as("%s: ausnahme() muss VOR '%s' stehen", weg.datei(), weg.ausnahmeVor())
                    .isLessThan(teurerAufruf);
        }
    }
}
