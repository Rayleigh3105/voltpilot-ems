package com.voltpilot.api.kundenbereich;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** RF-08: beendet am 30.06.2029, Frist 90 Tage → gelöscht frühestens am 28.09.2029 — beim Abruf gerechnet. Rein. */
class KundenbereichEndeTest {

    private static final KundenbereichEnde AHRENBERG = new KundenbereichEnde(UUID.randomUUID(),
            Instant.parse("2029-06-30T09:00:00Z"), 90, "Voss");

    @Test
    void dieFristZaehltKalendertageInDeutschland() {
        assertThat(AHRENBERG.beendetAmTag()).isEqualTo(LocalDate.of(2029, 6, 30));
        assertThat(AHRENBERG.loeschungFruehestens()).isEqualTo(LocalDate.of(2029, 9, 28));
        // 23:30 UTC ist in Berlin schon der nächste Tag — der Kalendertag des Vertrags zählt, nicht der UTC-Tag.
        KundenbereichEnde spaet = new KundenbereichEnde(UUID.randomUUID(), Instant.parse("2029-06-30T22:30:00Z"), 90, "V");
        assertThat(spaet.beendetAmTag()).isEqualTo(LocalDate.of(2029, 7, 1));
    }

    @Test
    void dieSaetzeNennenNurWasEsGibt() {
        assertThat(AHRENBERG.text()).isEqualTo("Ihr Vertrag ist am 30.06.2029 beendet. Ihre Daten können Sie nur noch "
                + "lesen; gelöscht werden sie frühestens am 28.09.2029.");
        assertThat(AHRENBERG.textNurKundenadministrator()).isEqualTo("Ihr Vertrag ist am 30.06.2029 beendet. Nur Ihr "
                + "Kundenadministrator kann die Daten bis zur Löschung noch lesen.");
        // Den Gesamtabzug (IP-17) nennt nur der Satz an den Kundenadministrator — nur er kann ihn laden (§5.8, RF-08).
        assertThat(AHRENBERG.textKundenadministrator()).isEqualTo("Ihr Vertrag ist am 30.06.2029 beendet. Ihre Daten "
                + "können Sie nur noch lesen; gelöscht werden sie frühestens am 28.09.2029. Bis dahin können Sie den "
                + "Gesamtabzug laden.");
        assertThat(AHRENBERG.text()).doesNotContain("Gesamtabzug");
        assertThat(AHRENBERG.textNurKundenadministrator()).doesNotContain("Gesamtabzug");
        assertThat(AHRENBERG.koerper("x")).containsEntry("code", "kundenbereich_beendet")
                .containsEntry("loeschung_fruehestens", "2029-09-28");
    }
}
