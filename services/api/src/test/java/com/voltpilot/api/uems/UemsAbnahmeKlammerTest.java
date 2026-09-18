package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * AP-07 IP-21 — die Klammer über die 16 Abnahmefälle der Messdatenstrecke.
 *
 * <p>Die meisten Fälle haben ihr eigenes Paket mitgebracht; IP-21 baut sie nicht ein zweites
 * Mal, sondern hält fest, WO jeder Fall bewiesen wird. Diese Zuordnung steht als Tabelle in
 * {@code docs/agents/root/uems-abnahme-messdatenstrecke.md} — und eine Tabelle, die niemand
 * prüft, ist nach drei Paketen falsch. Dieser Lauf liest sie und verlangt von jeder Zeile,
 * dass Klasse UND Methode heute wirklich existieren.
 *
 * <p>Ohne Container, ohne Datenbank: geprüft wird der Baum, nicht die Laufzeit. Dass die
 * genannten Methoden grün sind, prüfen sie selbst.
 */
class UemsAbnahmeKlammerTest {

    private static final Path KLAMMER =
            Path.of("../../docs/agents/root/uems-abnahme-messdatenstrecke.md");
    private static final Path[] TESTBAEUME = {
        Path.of("../../services/api/src/test/java"),
        Path.of("../../services/ingest/src/test/java"),
        Path.of("../../services/timescale-writer/src/test/java"),
    };

    /** {@code `Klasse#methode`} in einer Backtick-Zelle. */
    private static final Pattern NACHWEIS =
            Pattern.compile("`([A-Z][A-Za-z0-9]*)#([a-zA-Z][A-Za-z0-9_]*)`");

    @Test
    void jederDerSechzehnFaelleStehtGenauEinmalInDerTabelle() throws IOException {
        Map<String, String> zeilen = tabelle();
        List<String> erwartet = new ArrayList<>();
        for (int i = 1; i <= 16; i++) {
            erwartet.add("A" + i);
        }
        assertThat(zeilen.keySet())
                .as("die Klammer nennt A1…A16, keinen mehr und keinen weniger")
                .containsExactlyElementsOf(erwartet);
    }

    @Test
    void jedeZeileNenntMindestensEinenNachweis() throws IOException {
        tabelle().forEach((fall, zelle) -> assertThat(NACHWEIS.matcher(zelle).find())
                .as(fall + ": die Nachweis-Zelle nennt keine `Klasse#methode`")
                .isTrue());
    }

    /**
     * Der eigentliche Wächter: jede genannte Klasse liegt im Baum, und jede genannte Methode
     * steht in ihr. Eine umbenannte Testmethode macht diesen Lauf rot — nicht die Abnahme
     * still unbelegt.
     */
    @Test
    void jederNachweisZeigtAufEineKlasseUndEineMethodeDieEsGibt() throws IOException {
        Map<String, List<Path>> klassen = testklassen();
        List<String> fehlend = new ArrayList<>();
        int geprueft = 0;

        for (Map.Entry<String, String> zeile : tabelle().entrySet()) {
            Matcher m = NACHWEIS.matcher(zeile.getValue());
            while (m.find()) {
                geprueft++;
                String klasse = m.group(1);
                String methode = m.group(2);
                List<Path> dateien = klassen.get(klasse);
                if (dateien == null) {
                    fehlend.add(zeile.getKey() + ": Klasse " + klasse + " gibt es nicht");
                    continue;
                }
                // Gleiche einfache Namen gibt es (K8sReadinessConfigTest steht in zwei
                // Diensten). Mehrdeutig ist erst der NACHWEIS, wenn die genannte Klasse in
                // mehreren Bäumen liegt — dann sagt die Zelle nicht, welche gemeint ist.
                if (dateien.size() > 1) {
                    fehlend.add(zeile.getKey() + ": " + klasse + " gibt es " + dateien.size()
                            + "-mal — der Nachweis ist mehrdeutig");
                    continue;
                }
                String quelle = Files.readString(dateien.get(0), StandardCharsets.UTF_8);
                if (!quelle.contains(" " + methode + "(")) {
                    fehlend.add(zeile.getKey() + ": " + klasse + " hat keine Methode " + methode);
                }
            }
        }

        assertThat(geprueft).as("die Klammer nennt Nachweise").isGreaterThanOrEqualTo(16);
        assertThat(fehlend)
                .as("die Klammer zeigt auf Tests, die es nicht mehr gibt — Tabelle nachziehen")
                .isEmpty();
    }

    /**
     * Die drei Nachweise, die IP-21 selbst mitbringt, müssen in der Klammer stehen — sonst
     * wäre das Paket gebaut und nicht genannt.
     */
    @Test
    void dieDreiNeuenNachweiseStehenInDerKlammer() throws IOException {
        String ganze = Files.readString(KLAMMER, StandardCharsets.UTF_8);
        assertThat(ganze).contains("UemsStreckeAbnahmeTest");
        assertThat(ganze).contains("UemsRohdatenablaufAbnahmeTest");
        assertThat(ganze).contains("tools/edge-simulator/abnahme/ap07-szenarien.json");
    }

    // ---------------------------------------------------------------- Werkzeug

    /** Fall → Inhalt der Nachweis-Spalte, in der Reihenfolge der Tabelle. */
    private static Map<String, String> tabelle() throws IOException {
        Map<String, String> zeilen = new LinkedHashMap<>();
        Pattern zeile = Pattern.compile("^\\|\\s*(A\\d{1,2})\\s*\\|([^|]*)\\|(.*)\\|\\s*$");
        for (String s : Files.readAllLines(KLAMMER, StandardCharsets.UTF_8)) {
            Matcher m = zeile.matcher(s);
            if (m.matches()) {
                zeilen.put(m.group(1), m.group(3));
            }
        }
        assertThat(zeilen).as("die Klammer-Tabelle wurde gefunden").isNotEmpty();
        return zeilen;
    }

    /** Einfacher Klassenname → alle Dateien dieses Namens, über die drei Test-Bäume. */
    private static Map<String, List<Path>> testklassen() throws IOException {
        Map<String, List<Path>> gefunden = new LinkedHashMap<>();
        for (Path baum : TESTBAEUME) {
            if (!Files.isDirectory(baum)) {
                continue;
            }
            try (Stream<Path> alle = Files.walk(baum)) {
                for (Path p : alle.filter(p -> p.getFileName().toString().endsWith(".java"))
                        .toList()) {
                    String name = p.getFileName().toString().replace(".java", "");
                    gefunden.computeIfAbsent(name, k -> new ArrayList<>()).add(p);
                }
            }
        }
        assertThat(gefunden).as("die Test-Bäume liegen, wo die Klammer sie sucht").isNotEmpty();
        return gefunden;
    }
}
