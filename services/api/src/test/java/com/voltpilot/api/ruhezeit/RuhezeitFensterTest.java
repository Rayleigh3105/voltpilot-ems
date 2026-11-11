package com.voltpilot.api.ruhezeit;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.Optional;
import org.junit.jupiter.api.Test;

/** Reine Zeitrechnung (Alerting Scheibe 3, §6.4) - keine Datenbank, keine Uhr außer der übergebenen. */
class RuhezeitFensterTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");

    private static JsonNode fenster(String json) {
        try {
            return JSON.readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static Instant berlin(int jahr, int monat, int tag, int stunde, int minute) {
        return ZonedDateTime.of(jahr, monat, tag, stunde, minute, 0, 0, BERLIN).toInstant();
    }

    @Test
    void werktagsNachtsIstRuhezeitAktivUndEndetMorgens() {
        JsonNode f = fenster("{\"werktags\":{\"von\":\"22:00\",\"bis\":\"07:00\"}}");
        // Montag, 23:30 - mitten in der Nacht-Ruhezeit, die um 22 Uhr begann.
        Instant jetzt = berlin(2026, 10, 19, 23, 30); // ein Montag
        Optional<Instant> ende = RuhezeitFenster.endeFallsAktiv(f, BERLIN, jetzt);
        assertThat(ende).contains(berlin(2026, 10, 20, 7, 0));
    }

    @Test
    void werktagsFruehMorgensNochInDerVorNaechtlichenRuhezeit() {
        JsonNode f = fenster("{\"werktags\":{\"von\":\"22:00\",\"bis\":\"07:00\"}}");
        // Dienstag 03:00 - das Fenster begann Montag 22 Uhr, endet Dienstag 07 Uhr.
        Instant jetzt = berlin(2026, 10, 20, 3, 0);
        Optional<Instant> ende = RuhezeitFenster.endeFallsAktiv(f, BERLIN, jetzt);
        assertThat(ende).contains(berlin(2026, 10, 20, 7, 0));
    }

    @Test
    void werktagsMittagsKeineRuhezeit() {
        JsonNode f = fenster("{\"werktags\":{\"von\":\"22:00\",\"bis\":\"07:00\"}}");
        Instant jetzt = berlin(2026, 10, 20, 12, 0);
        assertThat(RuhezeitFenster.endeFallsAktiv(f, BERLIN, jetzt)).isEmpty();
    }

    @Test
    void wochenendeGanzDecktSamstagUndSonntagAlsEinFensterAb() {
        JsonNode f = fenster("{\"werktags\":{\"von\":\"22:00\",\"bis\":\"07:00\"},\"wochenende\":\"ganz\"}");
        // Samstag 10 Uhr.
        Instant samstag = berlin(2026, 10, 24, 10, 0);
        // B6: "ganz" reicht bis zum Ende der werktäglichen Morgen-Ruhe am Montag (hier 07:00),
        // nicht nur bis Montag 00:00 - sonst klafft eine Lücke Montag 0 bis 7 Uhr.
        assertThat(RuhezeitFenster.endeFallsAktiv(f, BERLIN, samstag)).contains(berlin(2026, 10, 26, 7, 0));
        // Sonntag 23 Uhr - immer noch dasselbe (am Samstag begonnene) Fenster.
        Instant sonntag = berlin(2026, 10, 25, 23, 0);
        assertThat(RuhezeitFenster.endeFallsAktiv(f, BERLIN, sonntag)).contains(berlin(2026, 10, 26, 7, 0));
    }

    @Test
    void wochenendeOhneWerktagsAngabeEndetMontagMitternacht() {
        // Ohne eine werktägliche Morgen-Ruhe gibt es nichts, bis zu dem "ganz" verlängern könnte.
        JsonNode f = fenster("{\"wochenende\":\"ganz\"}");
        Instant samstag = berlin(2026, 10, 24, 10, 0);
        assertThat(RuhezeitFenster.endeFallsAktiv(f, BERLIN, samstag)).contains(berlin(2026, 10, 26, 0, 0));
    }

    @Test
    void montagFruehMorgensIstDankVerlaengerungNichtMehrLueckenhaft() {
        // B6-Regression: Montag 03:00 lag früher in keinem Fenster (Lücke zwischen dem bis
        // Montag 00:00 reichenden Wochenend-Fenster und der erst um 22:00 beginnenden Nachtruhe).
        JsonNode f = fenster("{\"werktags\":{\"von\":\"22:00\",\"bis\":\"07:00\"},\"wochenende\":\"ganz\"}");
        Instant montagFrueh = berlin(2026, 10, 26, 3, 0);
        assertThat(RuhezeitFenster.endeFallsAktiv(f, BERLIN, montagFrueh)).contains(berlin(2026, 10, 26, 7, 0));
    }

    @Test
    void freitagAbendGehtUeberInDasWochenendfenster() {
        // Freitagabend 22 Uhr beginnt die werktägliche Nachtruhe; Samstag 00:00 übernimmt "ganz".
        JsonNode f = fenster("{\"werktags\":{\"von\":\"22:00\",\"bis\":\"07:00\"},\"wochenende\":\"ganz\"}");
        Instant freitagNacht = berlin(2026, 10, 23, 23, 0); // Freitag
        assertThat(RuhezeitFenster.endeFallsAktiv(f, BERLIN, freitagNacht)).contains(berlin(2026, 10, 24, 7, 0));
        Instant samstagFrueh = berlin(2026, 10, 24, 7, 30);
        assertThat(RuhezeitFenster.endeFallsAktiv(f, BERLIN, samstagFrueh)).contains(berlin(2026, 10, 26, 7, 0));
    }

    @Test
    void ohneWochenendeAngabeIstSamstagRuhig() {
        JsonNode f = fenster("{\"werktags\":{\"von\":\"22:00\",\"bis\":\"07:00\"}}");
        Instant samstagMittag = berlin(2026, 10, 24, 14, 0);
        assertThat(RuhezeitFenster.endeFallsAktiv(f, BERLIN, samstagMittag)).isEmpty();
    }

    @Test
    void leeresFensterIstNieAktiv() {
        assertThat(RuhezeitFenster.endeFallsAktiv(fenster("{}"), BERLIN, Instant.now())).isEmpty();
        assertThat(RuhezeitFenster.endeFallsAktiv(null, BERLIN, Instant.now())).isEmpty();
    }

    @Test
    void regelFensterOhneUeberspannungAnEinemWerktag() {
        // Eigene Festlegung: dieselbe Form, hier als Beispiel einer Regel-Ruhezeit außerhalb 6-18 Uhr.
        JsonNode f = fenster("{\"werktags\":{\"von\":\"18:00\",\"bis\":\"06:00\"}}");
        Instant mittwochAbend = berlin(2026, 10, 21, 19, 0);
        assertThat(RuhezeitFenster.endeFallsAktiv(f, BERLIN, mittwochAbend))
                .contains(berlin(2026, 10, 22, 6, 0));
        Instant mittwochMittag = berlin(2026, 10, 21, 12, 0);
        assertThat(RuhezeitFenster.endeFallsAktiv(f, BERLIN, mittwochMittag)).isEmpty();
    }

    @Test
    void grenzeDesFenstersIstEinschliesslichStartUndAusschliesslichEnde() {
        JsonNode f = fenster("{\"werktags\":{\"von\":\"22:00\",\"bis\":\"23:00\"}}");
        Instant start = berlin(2026, 10, 19, 22, 0);
        Instant ende = berlin(2026, 10, 19, 23, 0);
        assertThat(RuhezeitFenster.endeFallsAktiv(f, BERLIN, start)).isPresent();
        assertThat(RuhezeitFenster.endeFallsAktiv(f, BERLIN, ende)).isEmpty();
    }
}
