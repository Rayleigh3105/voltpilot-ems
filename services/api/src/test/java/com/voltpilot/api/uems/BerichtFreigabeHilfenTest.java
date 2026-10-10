package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Was {@link BerichtService} aus dem Abzug und der Uhr liest, bevor es {@link BerichtRegeln} fragt — rein, gegen B1 Nr. 1 und
 * B5 aus {@code bericht-vectors.json}.
 */
class BerichtFreigabeHilfenTest {

    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final BerichtRegeln.Zeitraum OKTOBER = BerichtRegeln.zeitraum("monat", "2026-10", BERLIN);

    private static JsonNode nummerEins() throws Exception {
        String text = Files.readString(Path.of("..", "..", "docs", "contracts", "v2", "bericht-vectors.json"));
        return BerichtService.baum(text).path("abzuege").path("BR-2026-0001/1");
    }

    private static Instant t(String s) {
        return OffsetDateTime.parse(s).toInstant();
    }

    /** B5: zwischen Datenstand 10.11. 08:55 und Freigabe 09:02 läuft keine Frist ab — die Freigabe ist nicht veraltet. */
    @Test
    void b5ZwischenDatenstandUndFreigabeLaeuftKeineFristAb() {
        assertThat(BerichtService.fristen(OKTOBER, BERLIN, t("2026-11-10T08:55:00+01:00"), t("2026-11-10T09:02:00+01:00")))
                .isEmpty();
    }

    /** Ein Entwurf vom 05.11. ist am 08.11. 00:00 veraltet, ohne dass eine Zeile sich änderte (der 31.10. wird endgültig). */
    @Test
    void dasEndgueltigAbDesLetztenTagsMachtEinenFruehenEntwurfVeraltet() {
        List<BerichtRegeln.Aenderung> f = BerichtService.fristen(OKTOBER, BERLIN, t("2026-11-05T09:00:00+01:00"),
                t("2026-11-10T08:55:00+01:00"));
        assertThat(f).extracting(BerichtRegeln.Aenderung::art).containsOnly(BerichtRegeln.ENDGUELTIG_AB);
        assertThat(f).extracting(BerichtRegeln.Aenderung::zeitpunkt).last().isEqualTo(OKTOBER.freigabeAb())
                .isEqualTo(t("2026-11-08T00:00:00+01:00"));
        assertThat(f).extracting(BerichtRegeln.Aenderung::zeitpunkt).first().isEqualTo(t("2026-11-06T00:00:00+01:00"));
    }

    /** Ein Entwurf aus dem laufenden Monat ist nach dessen Ende veraltet — „Zeitraum läuft“ gilt nicht mehr. */
    @Test
    void dasEndeDesZeitraumsMachtEinenEntwurfAusDemLaufendenMonatVeraltet() {
        List<BerichtRegeln.Aenderung> f = BerichtService.fristen(OKTOBER, BERLIN, t("2026-10-20T10:00:00+02:00"),
                t("2026-11-01T00:00:00+01:00"));
        assertThat(f).extracting(BerichtRegeln.Aenderung::art).contains(BerichtService.ZEITRAUM_ZU_ENDE);
    }

    /** F1 liest jeden Wert und jede Kennzahl des Abzugs mit Fassung und „endgültig ab“; D2 jede Berechnungszeit. */
    @Test
    void freigabeWerteUndZeitenKommenAusWertenUndKennzahlenDesAbzugs() throws Exception {
        JsonNode abzug = nummerEins();
        int werte = abzug.path("werte").size();
        int kennzahlen = abzug.path("kennzahlen").size();
        List<BerichtRegeln.FreigabeWert> f = BerichtService.freigabeWerte(abzug);
        assertThat(f).hasSize(werte + kennzahlen);
        assertThat(f.get(0).quelle()).isEqualTo(abzug.path("werte").get(0).path("quelle").asText());
        assertThat(f.get(0).name()).isEqualTo(abzug.path("werte").get(0).path("name_zum_datenstand").asText());
        assertThat(f).allMatch(w -> !KennzahlRegeln.VORLAEUFIG.equals(w.fassung()));
        // Seit Vertrag 1.2 trägt auch eine KENNZAHL ihr „endgültig ab“ — F1 wiegt sie mit, nicht nur die Werte.
        // Vorher sah die Freigabe eine Kennzahl, die noch vorläufig gewesen wäre, gar nicht.
        assertThat(BerichtService.zeiten(abzug, "endgueltig_ab")).hasSize(werte + kennzahlen)
                .containsOnly(t("2026-11-08T00:00:00+01:00"));
        Instant datenstand = t(abzug.path("kopf").path("datenstand").asText());
        assertThat(BerichtRegeln.d2(datenstand, BerichtService.zeiten(abzug, "berechnet_am"),
                BerichtService.zeiten(abzug, "endgueltig_ab"), true)).isEmpty();
    }
}
