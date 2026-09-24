package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * UEMS AP-19 IP-12 — die Rolle „Einsicht“ (RE3, RE5, E8 = A) an der Matrix-Datei, rein, ohne Datenbank.
 *
 * <ol>
 *   <li><b>Bestand byte-gleich (NW-5):</b> jede Bestandsrolle darf genau, was sie vorher durfte — die sieben Spalten
 *       jeder Zeile ergeben denselben Fingerabdruck wie {@code origin/uems} vor IP-12. Eine neue Zeile (wie die
 *       {@code energiemanagement.*} von IP-5, hier schon enthalten) zieht den Fingerabdruck mit ihrem eigenen Paket nach; IP-12 ändert
 *       keine Zelle der sieben Spalten.</li>
 *   <li><b>Die Spalte:</b> U genau an den lesenden Zeilen (R6), E genau an den Zeilen, die jede Rolle mit E tragen,
 *       sonst − — auch an den Exporten ({@code export.*}), am Zugriffsprotokoll und an jeder Freigabe.</li>
 *   <li><b>Die Rolle:</b> unternehmensweit, zuweisbar, eine Spalte aus dem Nachtrag AP-19 §4.11 hinter den sieben der
 *       Konzept-Tabelle; sie steht nicht in {@link RechteAbleitung#ROLLE_NOETIG_REIHENFOLGE}.</li>
 * </ol>
 */
class RolleEinsichtBestandTest {

    private static final Path MATRIX = Path.of("..", "..", "docs", "contracts", "v2", "rechte-matrix.json");

    /** Die sieben Spalten vor IP-12, in der Reihenfolge der Konzept-Tabelle. */
    private static final List<String> BESTAND = List.of("kundenadministrator", "energiemanager", "bearbeiter",
            "bedienberechtigt", "leser", "unterstuetzer", "voltpilot_betrieb");

    /**
     * SHA-256 der Zeilen {@code kennung;KA;EM;BE;BD;LE;US;VB\n} aller Aktionen in der Folge der Datei, gemessen an
     * {@code origin/uems} vor IP-12, mit den drei {@code energiemanagement.*} von IP-5 (81 Aktionen, 25.09.2026).
     */
    private static final String BESTAND_SHA256 = "3b4bf6d65ac84c94edb54c557e3ce27af360b2d60d4bef8536644b1884edff19";

    /** R6 „lesen“ — die Zeilen, an denen Einsicht U trägt (energiemanagement.ansehen seit IP-5). */
    private static final Set<String> LESEND = Set.of("aenderungsprotokoll.lesen", "messwerte.ansehen",
            "messstelle.ansehen", "ereignisse.ansehen", "datenquelle.ansehen", "energieeinsatz.ansehen",
            "bezugsbasis.ansehen", "verbesserung.ansehen", "energiemanagement.ansehen", "bericht.standort_abrufen",
            "bericht.unternehmen_abrufen", "bewertung.ansehen");

    @Test
    void jedeBestandsrolleDarfGenauWasSieVorherDurfte() throws Exception {
        StringBuilder zeilen = new StringBuilder();
        for (JsonNode a : matrix().path("aktionen")) {
            List<String> z = new ArrayList<>(List.of(a.path("kennung").asText()));
            BESTAND.forEach(r -> z.add(a.path("zellen").path(r).asText()));
            zeilen.append(String.join(";", z)).append('\n');
        }
        String ist = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(zeilen.toString().getBytes(StandardCharsets.UTF_8)));
        assertThat(ist).as("die sieben Bestandsspalten:%n%s", zeilen).isEqualTo(BESTAND_SHA256);
    }

    @Test
    void einsichtTraegtUGenauAnDenLesendenZeilenEAmEigenenKontoSonstNichts() throws Exception {
        List<String> u = new ArrayList<>();
        for (JsonNode a : matrix().path("aktionen")) {
            String kennung = a.path("kennung").asText();
            String zelle = a.path("zellen").path("einsicht").asText();
            boolean eigenesKonto = BESTAND.stream().allMatch(r -> "E".equals(a.path("zellen").path(r).asText()));
            if (eigenesKonto) {
                assertThat(zelle).as(kennung).isEqualTo("E");
            } else if (LESEND.contains(kennung)) {
                assertThat(zelle).as(kennung).isEqualTo("U");
                u.add(kennung);
            } else {
                assertThat(zelle).as(kennung).isEqualTo("-");
            }
        }
        assertThat(u).as("die zwölf lesenden Zeilen der R6-Liste").hasSize(12)
                .doesNotContain("export.standort", "export.unternehmen", "zugriffsprotokoll.lesen",
                        "bericht.unternehmen", "bewertung.abrufen");
    }

    @Test
    void dieRolleIstUnternehmensweitZuweisbarUndEineSpalteAusDemNachtrag() throws Exception {
        JsonNode rollen = matrix().path("rollen");
        JsonNode einsicht = rollen.get(rollen.size() - 1);
        assertThat(einsicht.path("kennung").asText()).isEqualTo("einsicht");
        assertThat(einsicht.path("kundenwort").asText()).isEqualTo(Rolle.EINSICHT.kundenwort()).isEqualTo("Einsicht");
        assertThat(einsicht.path("geltungsbereich").asText()).isEqualTo("unternehmen");
        assertThat(einsicht.path("zuweisbar").asBoolean()).isTrue();
        assertThat(einsicht.path("nachtrag").asText()).isEqualTo("AP-19 §4.11");
        for (int i = 0; i < BESTAND.size(); i++) {
            assertThat(rollen.get(i).path("kennung").asText()).isEqualTo(BESTAND.get(i));
            assertThat(rollen.get(i).has("nachtrag")).isFalse();
        }
        assertThat(Rolle.EINSICHT.jeStandort()).isFalse();
        assertThat(RechteAbleitung.ROLLE_NOETIG_REIHENFOLGE).doesNotContain(Rolle.EINSICHT);
    }

    private static JsonNode matrix() throws Exception {
        return new ObjectMapper().readTree(Files.readString(MATRIX));
    }
}
