package com.voltpilot.api.kundenbereich;

import static java.util.Map.entry;
import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * Die Läufer der API aus dem CODE (UEMS AP-20, Folgepaket zu IP-16, E10 = A „alles gesperrt"): jede Klasse mit einem
 * Takt ({@code @Scheduled}) oder einem Start-Lauf ({@code ApplicationReadyEvent}) lässt beendete Kundenbereiche aus —
 * in sich selbst oder in den Klassen, an die sie übergibt ({@link #SPERRE_IN}) —, oder sie steht mit Grund in
 * {@link #OHNE_SPERRE}. Ein neuer Läufer muss sich entscheiden; beide Listen sind genau (jeder Eintrag trifft einen
 * Läufer des Codes).
 *
 * <p>„Lässt aus" heißt im Quelltext: die Klasse fragt {@link BeendeteKundenbereiche} — {@code beendete.beendet(…)} in
 * ihrer Schleife je Kundenbereich oder {@code beendete.sqlFeld()} im SQL ihrer Warteschlange.
 */
class LaeuferBeendetArchitekturTest {

    private static final Path QUELLE = Path.of("src/main/java/com/voltpilot/api");

    /** Läufer, deren Sperre in den Klassen sitzt, an die sie den Lauf übergeben. */
    static final Map<String, List<String>> SPERRE_IN = Map.ofEntries(
            entry("EndgueltigkeitLaeufer", List.of("EndgueltigkeitLauf", "TagVerdichter", "PeriodeVerdichter",
                    "AblesungLueckenLauf", "BerechnetePeriodenLauf", "KanalbindungLauf", "KennzahlLauf",
                    "KorrekturVorschlagLauf")),
            entry("ErsatzwertLaeufer", List.of("ErsatzwertLauf")),
            entry("KorrekturKaskadeLaeufer", List.of("KorrekturKaskade")),
            entry("LueckenLaeufer", List.of("LueckenMelder")),
            entry("StrukturAenderungLaeufer", List.of("StrukturAenderungLaeufer", "BezugsbasisAnstoss")),
            entry("ViertelstundeLaeufer", List.of("ViertelstundeVerdichter")),
            entry("WetterArchivLaeufer", List.of("WetterArchivAbruf")),
            entry("RolloutWatcher", List.of("RolloutService")));

    /** Läufer ohne Sperre — mit dem Grund, warum sie auch für einen beendeten Kundenbereich laufen dürfen. */
    static final Map<String, String> OHNE_SPERRE = Map.ofEntries(
            entry("ConsumerMetricsCollector", "liest nur: Kennzahlen des Betriebs"),
            entry("DbHealthMetricsCollector", "liest nur: Kennzahlen des Betriebs"),
            entry("DbStorageMetricsCollector", "liest nur: Kennzahlen des Betriebs"),
            entry("FleetMetricsCollector", "liest nur: Kennzahlen des Betriebs"),
            entry("GemeinsameSteuerungMetrikSammler", "liest nur: Kennzahlen des Betriebs"),
            entry("UemsMetricsCollector", "liest nur: Kennzahlen des Betriebs"),
            entry("VerbundBilanzMetrik", "liest nur: Kennzahlen des Betriebs"),
            entry("VorbehaltMetrik", "liest nur: Kennzahlen des Betriebs"),
            entry("MeasurementConfigStatusListener", "der Takt verbindet nur den MQTT-Client; der Eingang ist ein"
                    + " Rueckmeldeweg"),
            entry("PlanResultListener", "der Takt verbindet nur den MQTT-Client; der Eingang ist ein Rueckmeldeweg"),
            entry("SprungprobeBerichtListener", "der Takt verbindet nur den MQTT-Client; der Eingang ist ein"
                    + " Rueckmeldeweg"),
            entry("VerbundAnteileResultListener", "der Takt verbindet nur den MQTT-Client; der Eingang ist ein"
                    + " Rueckmeldeweg"),
            entry("PlanZustellungAufbewahrungLaeufer", "Aufbewahrung: löscht Zustellungen nach ihrer eigenen Frist,"
                    + " für jeden Kundenbereich gleich — keine neue Zeile"),
            entry("ZeilentextAufbewahrungLaeufer", "Aufbewahrung: leert Importzeilen-Texte nach ihrer Frist, für jeden"
                    + " Kundenbereich gleich — keine neue Zeile"),
            entry("OcppActionService", "schließt abgelaufene OCPP-Aufträge ab und räumt nach Frist (SQL-Funktion);"
                    + " spricht keine Box an"),
            entry("ControlCertificationService", "Schutz: das Freigaberegister geht an jede Box — eine Verkleinerung"
                    + " muss auch eine Box eines beendeten Bereichs erreichen"),
            entry("ComponentTemplateSeeder", "Plattform-Katalog, kein Kundenbereich"),
            entry("WagoComponentTemplateSeeder", "Plattform-Katalog, kein Kundenbereich"));

    @Test
    void jederLaeuferLaesstBeendeteKundenbereicheAusOderNenntSeinenGrund() {
        Map<String, Path> laeufer = laeuferImCode();
        assertThat(laeufer).as("die Läufer im Code").isNotEmpty();

        Map<String, Path> klassen = alleKlassen();
        for (String name : laeufer.keySet()) {
            if (OHNE_SPERRE.containsKey(name)) {
                continue;
            }
            for (String ziel : SPERRE_IN.getOrDefault(name, List.of(name))) {
                assertThat(klassen).as("%s übergibt an %s", name, ziel).containsKey(ziel);
                assertThat(fragt(klassen.get(ziel)))
                        .as("%s (Läufer %s) lässt beendete Kundenbereiche aus: beendete.beendet(…) oder"
                                + " beendete.sqlFeld() — oder Grund in OHNE_SPERRE", ziel, name)
                        .isTrue();
            }
        }
    }

    @Test
    void beideListenSindGenau() {
        Map<String, Path> laeufer = laeuferImCode();
        assertThat(laeufer.keySet()).as("jede Ausnahme trifft einen Läufer").containsAll(OHNE_SPERRE.keySet());
        assertThat(laeufer.keySet()).as("jede Übergabe gehört einem Läufer").containsAll(SPERRE_IN.keySet());
        assertThat(OHNE_SPERRE.keySet()).as("ein Läufer steht nie in beiden").doesNotContainAnyElementsOf(
                SPERRE_IN.keySet());
    }

    /** Klassenname → Datei aller Läufer: ein Takt oder Start-Lauf im CODE, nicht im Javadoc. */
    static Map<String, Path> laeuferImCode() {
        Map<String, Path> aus = new TreeMap<>();
        alleKlassen().forEach((name, datei) -> {
            if (hatLauf(datei)) {
                aus.put(name, datei);
            }
        });
        return aus;
    }

    private static Map<String, Path> alleKlassen() {
        try (Stream<Path> dateien = Files.walk(QUELLE)) {
            Map<String, Path> aus = new TreeMap<>();
            dateien.filter(p -> p.toString().endsWith(".java"))
                    .forEach(p -> aus.put(p.getFileName().toString().replace(".java", ""), p));
            return aus;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static boolean hatLauf(Path datei) {
        return zeilen(datei).stream().map(String::stripLeading)
                .anyMatch(z -> !z.startsWith("*") && !z.startsWith("//")
                        && (z.startsWith("@Scheduled(") || z.contains("ApplicationReadyEvent.class")));
    }

    private static boolean fragt(Path datei) {
        return zeilen(datei).stream().map(String::stripLeading)
                .anyMatch(z -> !z.startsWith("*") && !z.startsWith("//")
                        && (z.contains("beendete.beendet(") || z.contains("beendete.sqlFeld()")));
    }

    private static List<String> zeilen(Path datei) {
        try {
            return Files.readAllLines(datei);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
