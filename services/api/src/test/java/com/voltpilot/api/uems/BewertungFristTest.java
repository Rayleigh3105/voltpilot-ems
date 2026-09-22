package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import org.junit.jupiter.api.Test;

/** AP-16 S5/S6 (IP-24): die reine Frist-Regel — Datum immer von außen, keine Uhr. */
class BewertungFristTest {

    private static final LocalDate STAND = LocalDate.parse("2026-11-17");

    @Test
    void r10VorAmUndNachDemFristTag() {
        BewertungFrist.Frist vorher = BewertungFrist.ableiten(2, STAND, 12, LocalDate.parse("2027-11-16"), null);
        assertThat(vorher.faelligAm()).isEqualTo("2027-11-17");
        assertThat(vorher.faellig()).isFalse();
        assertThat(vorher.faelligSeitTagen()).isNull();
        assertThat(BewertungFrist.ableiten(2, STAND, 12, LocalDate.parse("2027-11-17"), null).faelligSeitTagen()).isZero();
        BewertungFrist.Frist r10 = BewertungFrist.ableiten(2, STAND, 12, LocalDate.parse("2027-11-18"), null);
        assertThat(r10.faellig()).isTrue();
        assertThat(r10.faelligSeitTagen()).isEqualTo(1);
        assertThat(BewertungFrist.ableiten(2, STAND, 24, LocalDate.parse("2027-11-18"), null).faelligAm())
                .isEqualTo("2028-11-17");
    }

    @Test
    void monatsendeUndSchaltjahrFallenAufDenLetztenTag() {
        assertThat(BewertungFrist.ableiten(1, LocalDate.parse("2027-01-31"), 1, STAND, null).faelligAm())
                .isEqualTo("2027-02-28");
        assertThat(BewertungFrist.ableiten(1, LocalDate.parse("2028-02-29"), 12, STAND, null).faelligAm())
                .isEqualTo("2029-02-28");
    }

    @Test
    void eineAbgeloesteBewertungHatKeineFrist() {
        List<BewertungFrist.BewertungStand> staende = List.of(
                new BewertungFrist.BewertungStand("BR-2026-0001", 2, Instant.parse("2026-11-17T08:30:00Z")),
                new BewertungFrist.BewertungStand("BR-2027-0003", 1, Instant.parse("2027-11-24T09:00:00Z")));
        assertThat(BewertungFrist.abgeloestDurch("BR-2026-0001", staende)).isEqualTo("BR-2027-0003");
        assertThat(BewertungFrist.abgeloestDurch("BR-2027-0003", staende)).isNull();
        assertThat(BewertungFrist.abgeloestDurch("BR-2026-0001", staende.subList(0, 1))).isNull();
        BewertungFrist.Frist f = BewertungFrist.ableiten(2, STAND, 12, LocalDate.parse("2027-11-25"), "BR-2027-0003");
        assertThat(f.faellig()).isFalse();
        assertThat(f.faelligAm()).isNull();
        assertThat(BewertungFrist.ableiten(1, LocalDate.parse("2027-11-24"), 12, LocalDate.parse("2027-11-25"), null)
                .faelligAm()).isEqualTo("2028-11-24");
    }

    @Test
    void verantwortlicheNurDerWesentlichenJePersonEinmal() {
        List<BerichtRepository.EinsatzLage> lage = List.of(
                new BerichtRepository.EinsatzLage("EE-1", true, "MD", 0),
                new BerichtRepository.EinsatzLage("EE-2", true, "PH", 1),
                new BerichtRepository.EinsatzLage("EE-3", true, "IK", 0),
                new BerichtRepository.EinsatzLage("EE-4", false, "IK", 0),
                new BerichtRepository.EinsatzLage("EE-5", true, "PH", 0),
                new BerichtRepository.EinsatzLage("EE-8", true, null, 2));
        assertThat(BewertungFrist.verantwortliche(lage)).containsExactly(
                new BewertungFrist.Verantwortung("MD", List.of("EE-1")),
                new BewertungFrist.Verantwortung("PH", List.of("EE-2", "EE-5")),
                new BewertungFrist.Verantwortung("IK", List.of("EE-3")));
        assertThat(BewertungFrist.ohneVerantwortliche(lage)).containsExactly("EE-8");
    }
}
