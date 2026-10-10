package com.voltpilot.api.zugriff;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * Der Schutz des letzten Kundenadministrators und die Unveränderlichkeit der eigenen Zuweisung sind nur dann
 * Regeln, wenn kein Weg an ihnen vorbeiführt (UEMS AP-03 IP-9, §4.7, A8, W12).
 *
 * <p>Dieser Test hält die Liste der Wege, die eine Zuweisung überhaupt schreiben oder beenden können:
 * <ul>
 *   <li>{@code ZugriffAenderung} — der Prüfpunkt selbst; er fragt {@code RechteAbleitung.zuweisungAendern}.</li>
 *   <li>{@code UnterstuetzungService} (IP-8) — er schreibt AUSSCHLIESSLICH Zeilen der Rolle
 *       {@code unterstuetzer} und liest sie über {@code gewaehrung(griff)}, das nach dieser Rolle filtert. Ein
 *       Kundenadministrator ist über diesen Weg nicht erreichbar; sein eigenes Urteil spricht
 *       {@code RechteAbleitung.gewaehren}, und der Notfall-Zugriff gewährt sich selbst mit Absicht (E8) —
 *       {@code eigene_zuweisung} darf dort gerade NICHT gelten.</li>
 *   <li>{@code ZugriffBestand} (IP-2, E12) — die Bestandsübernahme, die die ERSTEN Zuweisungen anlegt; sie
 *       beendet nie eine und läuft, bevor es jemanden zu schützen gäbe.</li>
 * </ul>
 * BenutzerService legt ausschließlich für den ersten Plattform-Administrator direkt eine Zuweisung an;
 * jede Kundenanlage geht durch ZugriffAenderung.
 * Wer eine weitere Stelle baut, fällt hier auf — und entscheidet dann bewusst, ob sie durch den Prüfpunkt geht.
 *
 * <p>Ebenso geprüft: AUSSERHALB von {@code ZugriffRepository} steht kein eigenes SQL auf der Tabelle
 * {@code zugriff} (das Offboarding eines ganzen Kundenbereichs ausgenommen — dort endet nicht eine Zuweisung,
 * sondern der Kunde).
 *
 * <p>Rein: liest nur Quelltext.
 */
class ZugriffAenderungArchitekturTest {

    private static final Path JAVA = Path.of("src", "main", "java", "com", "voltpilot", "api");

    /** Die Klassen, die {@code ZugriffRepository.zuweisen} oder {@code .beenden} rufen dürfen. */
    private static final Set<String> ERLAUBT = Set.of(
            "ZugriffAenderung.java", "UnterstuetzungService.java", "ZugriffBestand.java",
            "BenutzerService.java");

    @Test
    void nurDerPruefpunktUndDieZweiBegruendetenAusnahmenSchreibenEineZuweisung() throws IOException {
        Set<String> gefunden = new TreeSet<>();
        for (Path p : dateien()) {
            String quelle = Files.readString(p);
            if (p.getFileName().toString().equals("ZugriffRepository.java")) {
                continue;
            }
            // Der EMPFÄNGER zählt, nicht der Methodenname: gesucht wird das Feld, dessen Typ das Repository
            // ist — ein gleichnamiger Aufruf an einem anderen Dienst (etwa ZugriffAenderung.zuweisen) ist keiner.
            Matcher feld = Pattern.compile("ZugriffRepository\\s+(\\w+)\\s*[;,)]").matcher(quelle);
            while (feld.find()) {
                String name = feld.group(1);
                if (quelle.contains(name + ".zuweisen(") || quelle.contains(name + ".beenden(")) {
                    gefunden.add(p.getFileName().toString());
                }
            }
        }
        assertThat(gefunden)
                .as("wer eine Zuweisung anlegt oder beendet, geht durch ZugriffAenderung — oder steht hier "
                        + "mit Grund (siehe Klassen-Javadoc)")
                .isEqualTo(new TreeSet<>(ERLAUBT));
    }

    @Test
    void ausserhalbDesRepositoriesGibtEsKeinEigenesSqlAufZugriff() throws IOException {
        Set<String> gefunden = new TreeSet<>();
        for (Path p : dateien()) {
            String name = p.getFileName().toString();
            if (name.equals("ZugriffRepository.java") || name.equals("TenantRepository.java")) {
                // TenantRepository räumt beim OFFBOARDING den ganzen Kundenbereich ab — dort endet kein
                // einzelner Zugriff, sondern der Kunde; ein letzter Kundenadministrator ist dann gegenstandslos.
                continue;
            }
            String quelle = Files.readString(p);
            for (String anweisung : List.of("UPDATE zugriff ", "DELETE FROM zugriff ", "INSERT INTO zugriff ")) {
                if (quelle.contains(anweisung)) {
                    gefunden.add(name + ": " + anweisung.trim());
                }
            }
        }
        assertThat(gefunden).isEmpty();
    }

    /** Der Prüfpunkt fragt den VERTRAG — er entscheidet nichts selbst. */
    @Test
    void derPruefpunktFragtDenVertrag() throws IOException {
        String quelle = Files.readString(JAVA.resolve("zugriff").resolve("ZugriffAenderung.java"));
        assertThat(quelle).contains("RechteAbleitung.zuweisungAendern(");
        assertThat(quelle).as("die beiden 409 spricht der Vertrag, nicht dieser Dienst")
                .doesNotContain("Grund.LETZTER_KUNDENADMINISTRATOR").doesNotContain("Grund.EIGENE_ZUWEISUNG");
    }

    @Test
    void kontenEntziehenHatNurEinenKeycloakSchreiberNebenOffboardingUndAnlageKompensation() throws IOException {
        Set<String> gefunden = new TreeSet<>();
        for (Path p : dateien()) {
            String quelle = Files.readString(p);
            Matcher feld = Pattern.compile("KeycloakAdminClient\\s+(\\w+)\\s*[;,)]").matcher(quelle);
            while (feld.find()) {
                String name = feld.group(1);
                if (quelle.contains(name + ".setEnabled(") || quelle.contains(name + ".deleteUser(")) {
                    gefunden.add(p.getFileName().toString());
                }
            }
        }
        assertThat(gefunden).containsExactlyInAnyOrder("AdminBenutzerService.java", "AdminController.java", "StartpasswortKonten.java");
        String controller = Files.readString(JAVA.resolve("web/AdminController.java"));
        assertThat(controller).doesNotContain("keycloak.setEnabled(", "keycloak.deleteUser(userId)");
        assertThat(controller.split("keycloak.deleteUser", -1)).hasSize(2); // nur Mandanten-Offboarding
        assertThat(Files.readString(JAVA.resolve("admin/AdminBenutzerService.java")))
                .contains("aenderung.kontoBeenden(", "hasRole('platform-admin')");
    }

    @Test
    void dieOffboardingAusnahmeHatNurDenPlattformDienstAlsAufrufer() throws IOException {
        Set<String> aufrufer = new TreeSet<>();
        for (Path p : dateien()) {
            String quelle = Files.readString(p);
            Matcher feld = Pattern.compile("ZugriffAenderung\\s+(\\w+)\\s*[;,)]").matcher(quelle);
            while (feld.find()) {
                if (quelle.contains(feld.group(1) + ".kundenbereichSperren(")) {
                    aufrufer.add(p.getFileName().toString());
                }
            }
        }
        assertThat(aufrufer).containsExactly("AdminBenutzerService.java");
        String controller = Files.readString(JAVA.resolve("web/AdminController.java"));
        assertThat(controller).contains("adminBenutzer.offboardingSperren(tenantId)",
                "tenants.offboard(tenantId,", "adminBenutzer.offboardingResteSperren(tenantId)");
    }

    private static List<Path> dateien() throws IOException {
        try (Stream<Path> s = Files.walk(JAVA)) {
            return s.filter(p -> p.getFileName().toString().endsWith(".java")).sorted().toList();
        }
    }
}
