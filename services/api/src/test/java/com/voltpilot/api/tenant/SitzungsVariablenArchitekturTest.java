package com.voltpilot.api.tenant;

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
 * Die gebundene Verbindung einer Anfrage ({@link AnfrageVerbindung}) merkt sich, welche Sitzungs-Variablen auf ihr
 * stehen, und setzt sie nur neu, wenn sich Mandant oder Zugriff ändern. Das stimmt nur, solange außer
 * {@link TenantAwareDataSource} niemand {@code app.*} für die SITZUNG setzt: ein {@code set_config(…, true)} endet mit
 * seiner Transaktion und stellt den Sitzungswert wieder her (Teilansicht, Selbstauskunft), ein
 * {@code set_config(…, false)}, {@code SET app.…}, {@code RESET} oder {@code DISCARD} irgendwo anders bliebe dagegen auf
 * der Verbindung stehen, ohne dass die Bindung es wüsste.
 *
 * <p>Darum: in {@code src/main/java} schreibt nur {@code TenantAwareDataSource} {@code app.*} sitzungsweit; jede andere
 * Fundstelle muss transaktionslokal sein.
 */
class SitzungsVariablenArchitekturTest {

    private static final Path QUELLEN = Path.of("src/main/java");
    private static final String EIGNER = "TenantAwareDataSource.java";
    private static final Pattern SET_CONFIG = Pattern.compile("set_config\\(\\s*'app\\.[a-z_]+'\\s*,[^,]+,\\s*(\\w+)\\s*\\)",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern IRGENDEIN_SET_CONFIG = Pattern.compile("set_config\\s*\\(", Pattern.CASE_INSENSITIVE);
    private static final Pattern SITZUNG_SETZEN = Pattern.compile(
            "\"[^\"]*\\b(SET\\s+(SESSION\\s+)?app\\.|RESET\\s+(app\\.|ALL\\b)|DISCARD\\s+ALL\\b)",
            Pattern.CASE_INSENSITIVE);

    @Test
    void nurTenantAwareDataSourceSetztAppVariablenFuerDieSitzung() throws IOException {
        List<String> verstoesse = new ArrayList<>();
        int transaktionslokal = 0;
        try (Stream<Path> dateien = Files.walk(QUELLEN)) {
            for (Path datei : dateien.filter(p -> p.toString().endsWith(".java")).toList()) {
                if (datei.getFileName().toString().equals(EIGNER)) {
                    continue;
                }
                List<String> zeilen = Files.readAllLines(datei);
                for (int i = 0; i < zeilen.size(); i++) {
                    String zeile = zeilen.get(i);
                    String ort = QUELLEN.relativize(datei) + ":" + (i + 1);
                    if (zeile.trim().startsWith("*") || zeile.trim().startsWith("//")) {
                        continue;
                    }
                    int aufrufe = zaehle(IRGENDEIN_SET_CONFIG.matcher(zeile));
                    Matcher m = SET_CONFIG.matcher(zeile);
                    int lokal = 0;
                    while (m.find()) {
                        if ("true".equalsIgnoreCase(m.group(1))) {
                            lokal++;
                        } else {
                            verstoesse.add(ort + " sitzungsweit: " + zeile.trim());
                        }
                    }
                    if (aufrufe > lokal && verstoesse.stream().noneMatch(v -> v.startsWith(ort + " "))) {
                        verstoesse.add(ort + " nicht als transaktionslokal erkennbar: " + zeile.trim());
                    }
                    transaktionslokal += lokal;
                    if (SITZUNG_SETZEN.matcher(zeile).find()) {
                        verstoesse.add(ort + " setzt die Sitzung zurück oder um: " + zeile.trim());
                    }
                }
            }
        }
        assertThat(verstoesse).isEmpty();
        assertThat(transaktionslokal).as("die bekannten transaktionslokalen Aufrufer (Geltungsbereich) wurden gefunden")
                .isPositive();
    }

    private static int zaehle(Matcher m) {
        int n = 0;
        while (m.find()) {
            n++;
        }
        return n;
    }
}
