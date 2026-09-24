package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * Der Flag-Nachweis der Bezugsbasis (UEMS AP-17 IP-25, NW-5, R10, §6.6, W14): {@code voltpilot.uems.bezugsbasis.enabled}
 * (Vorgabe AN) schaltet NUR die Anstoß-Nähte ({@link BezugsbasisAnstoss} — Pfad 1 in der Kaskade, Pfad 2 im
 * Struktur-Läufer), {@code voltpilot.uems.wetter-archiv.enabled} NUR den Takt des Wetter-Archivs
 * ({@link WetterArchivLaeufer}, dazu der Melder, der seinen Zustand „aus“ meldet). Keine Route, kein DTO und kein
 * Portal liest einen der beiden — darum antworten die Routen mit Schalter aus gleich. Und die Not-Aus-Tabelle des
 * Rollout-Drehbuchs (§12) nennt jeden {@code VOLTPILOT_UEMS_*_ENABLED}-Schalter der Anwendung, in derselben Reihenfolge
 * (Diff-Beweis wie Befund B3 der Generalprobe).
 *
 * <p>Ein reiner Quelltext-Wächter ohne Datenbank; das Verhalten prüfen {@code UemsBezugsbasisBestandsschutzTest}
 * (Bestand), {@code UemsBezugsbasisAnstossTest} (echte Fassung, Wasserzeichen {@code abgeschaltet}) und
 * {@code WetterArchivWiringTest} (Takt aus).
 */
class UemsBezugsbasisFlagArchitekturTest {

    private static final String BEZUGSBASIS = "voltpilot.uems.bezugsbasis.enabled";
    private static final String WETTER = "voltpilot.uems.wetter-archiv.enabled";
    private static final Path MAIN = Path.of("src", "main", "java");
    private static final Path YML = Path.of("src", "main", "resources", "application.yml");
    private static final Path DREHBUCH = Path.of("..", "..", "docs", "rollout", "uems-erste-freigabe.md");
    private static final Pattern SCHALTER = Pattern.compile("VOLTPILOT_UEMS_[A-Z_]+_ENABLED");

    @Test
    void derBezugsbasisSchalterLiestNurDieAnstossNaht() throws IOException {
        assertThat(leser(BEZUGSBASIS)).as("wer %s nennt", BEZUGSBASIS).containsExactly("BezugsbasisAnstoss.java");
        String text = text(MAIN.resolve("com/voltpilot/api/uems/BezugsbasisAnstoss.java"));
        assertThat(text).as("ein Feld mit Vorgabe AN, keine Bean-Bedingung")
                .contains("@Value(\"${\" + SCHALTER + \":true}\")")
                .doesNotContain("@ConditionalOnProperty");
        assertThat(BezugsbasisAnstoss.SCHALTER).isEqualTo(BEZUGSBASIS);
        assertThat(quellen().filter(p -> text(p).contains("BezugsbasisAnstoss.SCHALTER")).toList())
                .as("niemand liest den Schalter über die Konstante").isEmpty();
    }

    @Test
    void derWetterSchalterLiestNurDenTaktUndDenMelder() throws IOException {
        assertThat(leser(WETTER)).as("wer %s nennt", WETTER)
                .containsExactly("UemsLaeuferMelder.java", "WetterArchivLaeufer.java");
        assertThat(text(MAIN.resolve("com/voltpilot/api/uems/WetterArchivLaeufer.java")))
                .as("die Bean-Bedingung sitzt am Takt, nicht am Abruf oder am Wetterbezug")
                .contains("@ConditionalOnProperty(name = \"" + WETTER + "\", havingValue = \"true\", matchIfMissing = true)");
    }

    @Test
    void keineRouteUndKeinPortalKenntDieSchalter() throws IOException {
        assertThat(quellen().filter(p -> p.toString().contains("/web/")).filter(p -> {
            String t = text(p);
            return t.contains("uems.bezugsbasis") || t.contains("wetter-archiv") || t.contains("eingeschaltet");
        }).toList()).as("Controller und DTOs").isEmpty();
        try (Stream<Path> portal = Files.walk(Path.of("..", "..", "frontend", "portal", "src"))) {
            assertThat(portal.filter(p -> p.toString().endsWith(".ts") || p.toString().endsWith(".tsx")).filter(p -> {
                String t = text(p);
                return t.contains("BEZUGSBASIS_ENABLED") || t.contains("bezugsbasis.enabled")
                        || t.contains("WETTER_ARCHIV_ENABLED") || t.contains("wetter-archiv.enabled");
            }).toList()).as("das Portal hat keinen Schalter").isEmpty();
        }
    }

    @Test
    void dieVorgabenSindAnUndDerTestlaufSchaltetNurDenWetterTaktAus() throws IOException {
        assertThat(text(YML)).contains("enabled: ${VOLTPILOT_UEMS_BEZUGSBASIS_ENABLED:true}")
                .contains("enabled: ${VOLTPILOT_UEMS_WETTER_ARCHIV_ENABLED:true}");
        String pom = text(Path.of("pom.xml"));
        assertThat(pom).as("surefire lässt die Anstoß-Naht an").doesNotContain(BEZUGSBASIS);
        assertThat(pom).as("surefire hält den Takt an, wie jeden Läufer")
                .contains("<" + WETTER + ">false</" + WETTER + ">");
    }

    /** §12 des Drehbuchs = {@code application.yml}: dieselben Schalter, dieselbe Reihenfolge, jeder genau einmal. */
    @Test
    void dieNotAusTabelleNenntJedenSchalterDerAnwendung() throws IOException {
        List<String> anwendung = alle(SCHALTER.matcher(text(YML)));
        String drehbuch = text(DREHBUCH);
        int von = drehbuch.indexOf("## 12. Anhang: Not-Aus je Läufer");
        int bis = drehbuch.indexOf("\n## 13.", von);
        assertThat(von).as("§12 steht im Drehbuch").isNotNegative();
        List<String> tabelle = new ArrayList<>();
        for (String zeile : drehbuch.substring(von, bis).split("\n")) {
            Matcher m = Pattern.compile("^\\| `(VOLTPILOT_UEMS_[A-Z_]+_ENABLED)`").matcher(zeile);
            if (m.find()) {
                tabelle.add(m.group(1));
            }
        }
        assertThat(anwendung).as("jeder Schalter einmal in application.yml").doesNotHaveDuplicates()
                .contains("VOLTPILOT_UEMS_BEZUGSBASIS_ENABLED", "VOLTPILOT_UEMS_WETTER_ARCHIV_ENABLED",
                        "VOLTPILOT_UEMS_BEWERTUNG_ENABLED");
        assertThat(tabelle).as("§12 in der Reihenfolge von application.yml").containsExactlyElementsOf(anwendung);
        assertThat(drehbuch.substring(von, bis)).as("die Zahl im Text")
                .contains("alle **" + anwendung.size() + "** `VOLTPILOT_UEMS_*_ENABLED`-Schalter");
    }

    private static List<String> leser(String schalter) throws IOException {
        return quellen().filter(p -> text(p).contains(schalter)).map(p -> p.getFileName().toString()).sorted().toList();
    }

    private static List<String> alle(Matcher m) {
        List<String> aus = new ArrayList<>();
        while (m.find()) {
            aus.add(m.group());
        }
        return aus;
    }

    private static Stream<Path> quellen() throws IOException {
        try (Stream<Path> s = Files.walk(MAIN)) {
            return s.filter(p -> p.toString().endsWith(".java")).toList().stream();
        }
    }

    private static String text(Path p) {
        try {
            return Files.readString(p);
        } catch (IOException e) {
            throw new IllegalStateException(p.toString(), e);
        }
    }
}
