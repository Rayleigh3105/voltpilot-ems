package com.voltpilot.api.erzeuger;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.erzeuger.AnlagensteuerungRepository.Jungster;
import com.voltpilot.api.web.dto.AnlagensteuerungDto;
import java.math.BigDecimal;
import java.time.Instant;
import org.junit.jupiter.api.Test;

/** Rein, ohne Docker: der Netzbetreiber-Hinweis und die Lesart eines jüngsten Werts (UEMS EZ-6). */
class AnlagensteuerungRegelnTest {

    private static final Instant JETZT = Instant.parse("2026-10-21T12:00:00Z");

    @Test
    void einAbweichenderNetzbetreiberWirdGemeldetNurDieSchreibweiseNicht() {
        assertThat(AnlagensteuerungService.hinweise(null, "N-ERGIE Netz GmbH")).isEmpty();
        assertThat(AnlagensteuerungService.hinweise("N-ERGIE Netz GmbH", " n-ergie  netz gmbh ")).isEmpty();
        assertThat(AnlagensteuerungService.hinweise("N-ERGIE Netz GmbH", "Bayernwerk Netz GmbH")).singleElement()
                .satisfies(h -> {
                    assertThat(h.art()).isEqualTo("netzbetreiber_abweichung");
                    assertThat(h.bild()).isEqualTo("N-ERGIE Netz GmbH");
                    assertThat(h.eintrag()).isEqualTo("Bayernwerk Netz GmbH");
                    assertThat(h.text()).contains("Nichts wurde überschrieben");
                });
        assertThat(AnlagensteuerungService.hinweise("N-ERGIE Netz GmbH", null)).singleElement()
                .extracting(AnlagensteuerungDto.Hinweis::art).isEqualTo("netzbetreiber_nicht_eingetragen");
    }

    @Test
    void ohneWertKeineDatenUndAlterOderSchlechteQualitaetIstVeraltet() {
        AnlagensteuerungDto.Wert nichts = AnlagensteuerungService.wert(
                new Jungster("erzeuger.a.p_nvp_w", null, null, null), JETZT);
        assertThat(nichts.wert()).isNull();
        assertThat(nichts.zustand()).isEqualTo("keine_daten");

        AnlagensteuerungDto.Wert frisch = AnlagensteuerungService.wert(new Jungster("erzeuger.a.p_nvp_w",
                JETZT.minusSeconds(AnlagensteuerungService.AKTUELL_BIS_S), new BigDecimal("-500"), "good"), JETZT);
        assertThat(frisch.zustand()).isEqualTo("aktuell");
        AnlagensteuerungDto.Wert alt = AnlagensteuerungService.wert(new Jungster("erzeuger.a.p_nvp_w",
                JETZT.minusSeconds(AnlagensteuerungService.AKTUELL_BIS_S + 1), new BigDecimal("-500"), "good"), JETZT);
        assertThat(alt.zustand()).isEqualTo("veraltet");
        assertThat(alt.wert()).as("der Wert bleibt, nur nicht als aktuell").isEqualByComparingTo("-500");
        AnlagensteuerungDto.Wert stale = AnlagensteuerungService.wert(new Jungster("erzeuger.a.p_nvp_w", JETZT,
                new BigDecimal("-500"), "stale"), JETZT);
        assertThat(stale.zustand()).isEqualTo("veraltet");

        AnlagensteuerungDto.Wert motor = AnlagensteuerungService.wert(new Jungster("erzeuger.te[2].t_art", JETZT,
                new BigDecimal("2"), "good"), JETZT);
        assertThat(motor.teNr()).isEqualTo(2);
        assertThat(motor.wort()).isEqualTo("bhkw_motor");
        assertThat(motor.text()).isEqualTo("BHKW-Motor");
        assertThat(motor.bits()).isNull();
    }
}
