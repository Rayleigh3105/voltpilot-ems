package com.voltpilot.api.interventions;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.voltpilot.api.interventions.Handeingriff.Abgelehnt;
import com.voltpilot.api.interventions.Handeingriff.Anfrage;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalTime;
import java.time.ZoneId;
import org.junit.jupiter.api.Test;

/**
 * Die REINEN Regeln des Handeingriffs (Steuerung Stufe 4, Captain-Entscheid
 * S1 = A) - ohne DB, ohne Spring, ohne Uhr: jede Funktion nimmt ihr {@code now}.
 */
class HandeingriffTest {

    private static final Instant NOW = Instant.parse("2026-08-25T14:00:00Z");
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");

    // ---- S1 = A: die Kommandos existieren beide schon ------------------------

    @Test
    void haltenIstSollwertNull() {
        // „Ladestand halten" = der Speicher lädt und entlädt nicht. Das ist der
        // GANZE Trick des Entscheids: kein neues Kommando, kein SoC-Boden.
        assertThat(Handeingriff.sollwert(Handeingriff.HALTEN, null, new BigDecimal("10")))
                .isEqualByComparingTo(BigDecimal.ZERO);
        // Auch ein mitgeschickter Wert ändert daran nichts - halten ist halten.
        assertThat(Handeingriff.sollwert(Handeingriff.HALTEN, new BigDecimal("7"),
                new BigDecimal("10"))).isEqualByComparingTo(BigDecimal.ZERO);
    }

    @Test
    void ladenNimmtDieVolleLadeleistungUndKapptDarueber() {
        assertThat(Handeingriff.sollwert(Handeingriff.LADEN, null, new BigDecimal("11")))
                .isEqualByComparingTo(new BigDecimal("11"));
        assertThat(Handeingriff.sollwert(Handeingriff.LADEN, new BigDecimal("4"),
                new BigDecimal("11"))).isEqualByComparingTo(new BigDecimal("4"));
        // Über der Nennleistung würde das Gerät ohnehin klemmen - die Vorschau
        // stünde dann falsch, also kappen wir hier.
        assertThat(Handeingriff.sollwert(Handeingriff.LADEN, new BigDecimal("40"),
                new BigDecimal("11"))).isEqualByComparingTo(new BigDecimal("11"));
    }

    @Test
    void einNegativerWertWirdABGELEHNTStattGeklemmt() {
        // Es gibt keinen „jetzt entladen"-Eingriff. Aus einer Zahl mit falschem
        // Vorzeichen eine andere Handlung zu machen wäre geraten.
        assertThatThrownBy(() -> Handeingriff.sollwert(Handeingriff.LADEN,
                new BigDecimal("-3"), new BigDecimal("11")))
                .isInstanceOf(Abgelehnt.class)
                .hasMessageContaining("Ladestand halten");
    }

    @Test
    void ohneHinterlegteLadeleistungWirdKeineErfunden() {
        assertThatThrownBy(() -> Handeingriff.sollwert(Handeingriff.LADEN, null, null))
                .isInstanceOf(Abgelehnt.class)
                .hasMessageContaining("Ladeleistung");
        assertThatThrownBy(() -> Handeingriff.sollwert(Handeingriff.LADEN, null, BigDecimal.ZERO))
                .isInstanceOf(Abgelehnt.class);
    }

    // ---- die Dauer ist PFLICHT ----------------------------------------------

    @Test
    void ohneDauerUndOhneEndzeitGibtEsKeinenEingriff() {
        assertThatThrownBy(() -> Handeingriff.ende(
                new Anfrage(Handeingriff.HALTEN, null, null, null), NOW))
                .isInstanceOf(Abgelehnt.class)
                .hasMessageContaining("läuft nie unbegrenzt");
        assertThatThrownBy(() -> Handeingriff.ende(null, NOW)).isInstanceOf(Abgelehnt.class);
    }

    @Test
    void eineDauerUndEineEndzeitFuehrenZumSelbenErgebnis() {
        Instant ausDauer = Handeingriff.ende(
                new Anfrage(Handeingriff.HALTEN, 120, null, null), NOW);
        Instant ausEnde = Handeingriff.ende(
                new Anfrage(Handeingriff.HALTEN, null, NOW.plus(Duration.ofHours(2)), null), NOW);
        assertThat(ausDauer).isEqualTo(ausEnde).isEqualTo(NOW.plus(Duration.ofHours(2)));
    }

    @Test
    void zuKurzZuLangUndInDerVergangenheitWerdenBenanntAbgelehnt() {
        assertThatThrownBy(() -> Handeingriff.ende(
                new Anfrage(Handeingriff.HALTEN, 5, null, null), NOW))
                .isInstanceOf(Abgelehnt.class).hasMessageContaining("mindestens");
        assertThatThrownBy(() -> Handeingriff.ende(
                new Anfrage(Handeingriff.HALTEN, 60 * 30, null, null), NOW))
                .isInstanceOf(Abgelehnt.class).hasMessageContaining("höchstens");
        assertThatThrownBy(() -> Handeingriff.ende(
                new Anfrage(Handeingriff.HALTEN, null, NOW.minusSeconds(1), null), NOW))
                .isInstanceOf(Abgelehnt.class).hasMessageContaining("Zukunft");
    }

    @Test
    void bisMorgenFruehRechnetInDerZoneDerAnlage() {
        // 25.08. 14:00 UTC = 16:00 Berlin -> „bis morgen 06:00" ist der 26.08.
        // um 06:00 Berlin = 04:00 UTC (Sommerzeit).
        assertThat(Handeingriff.bisMorgenFrueh(NOW, BERLIN, LocalTime.of(6, 0)))
                .isEqualTo(Instant.parse("2026-08-26T04:00:00Z"));
        // Und über die Winterzeit-Grenze ohne Sonderfall: 06:00 Berlin = 05:00 UTC.
        Instant winter = Instant.parse("2026-12-01T14:00:00Z");
        assertThat(Handeingriff.bisMorgenFrueh(winter, BERLIN, LocalTime.of(6, 0)))
                .isEqualTo(Instant.parse("2026-12-02T05:00:00Z"));
    }

    // ---- B6: die 4-h-Kappe des Arbiters wird NIE gedehnt ---------------------

    @Test
    void derGesendeteTtlBleibtUnterDerArbiterKappe() {
        // 12 h Eingriff -> der EINE Wunsch trägt 4 h, der Rest kommt über die
        // Erneuerung. D-5 bleibt unangetastet.
        Instant lang = NOW.plus(Duration.ofHours(12));
        assertThat(Handeingriff.ttlSekunden(lang, NOW))
                .isEqualTo((int) Handeingriff.TTL_KAPPE.getSeconds());
        // Kürzer als die Kappe: die echte Restdauer.
        assertThat(Handeingriff.ttlSekunden(NOW.plus(Duration.ofMinutes(90)), NOW))
                .isEqualTo(90 * 60);
        // Nie 0 oder negativ - ein Wunsch ohne TTL wäre ein unsterblicher Wunsch.
        assertThat(Handeingriff.ttlSekunden(NOW.minusSeconds(5), NOW)).isEqualTo(1);
    }

    @Test
    void erneuertWirdVorDemVerfallUndNiemalsNachDemEnde() {
        Instant ende = NOW.plus(Duration.ofHours(12));
        // Noch nie ausgesendet -> sofort.
        assertThat(Handeingriff.brauchtErneuerung(null, ende, NOW)).isTrue();
        // Gerade ausgesendet -> nein.
        assertThat(Handeingriff.brauchtErneuerung(NOW.minus(Duration.ofMinutes(5)), ende, NOW))
                .isFalse();
        // Älter als die Auffrischungs-Frist -> ja, und zwar DEUTLICH vor den 4 h,
        // damit ein verlorener Takt den Wunsch nicht verfallen lässt.
        assertThat(Handeingriff.brauchtErneuerung(NOW.minus(Duration.ofHours(3).plusMinutes(1)),
                ende, NOW)).isTrue();
        assertThat(Handeingriff.ERNEUERN_NACH).isLessThan(Handeingriff.TTL_KAPPE);
        // ⚠ Ein ABGELAUFENER Eingriff wird NIE erneuert: die Frist steht in der
        // Zeile, und ist sie vorbei, verfällt der Wunsch auf dem Gerät von selbst.
        assertThat(Handeingriff.brauchtErneuerung(null, NOW.minusSeconds(1), NOW)).isFalse();
    }

    // ---- Vokabular -----------------------------------------------------------

    @Test
    void nurDieDreiWoerterSindBekanntUndNurZweiBetreffenDenSpeicher() {
        assertThat(Handeingriff.bekannt(Handeingriff.HALTEN)).isTrue();
        assertThat(Handeingriff.bekannt(Handeingriff.LADEN)).isTrue();
        assertThat(Handeingriff.bekannt(Handeingriff.PAUSE)).isTrue();
        assertThat(Handeingriff.bekannt("entladen")).isFalse();
        assertThat(Handeingriff.bekannt(null)).isFalse();

        assertThat(Handeingriff.istSpeicher(Handeingriff.HALTEN)).isTrue();
        assertThat(Handeingriff.istSpeicher(Handeingriff.LADEN)).isTrue();
        assertThat(Handeingriff.istSpeicher(Handeingriff.PAUSE)).isFalse();
    }
}
