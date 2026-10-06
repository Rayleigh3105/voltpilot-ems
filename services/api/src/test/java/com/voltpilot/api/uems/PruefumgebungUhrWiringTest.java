package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import com.voltpilot.api.zugriff.ZugriffBuehnenUhr;
import java.time.Duration;
import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.context.PropertyPlaceholderAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/**
 * Wer auf der Bühne rechnet (Befund Auswerten a4, Entscheid K1): in der Prüfumgebung - Profil {@code local} UND gesetzte
 * {@code voltpilot.pruefumgebung.buehnen-uhr} - stellt {@link PruefumgebungUhr} auch den {@link KennzahlLauf} auf die
 * Bühne, damit er auf der Uhr seiner Leser rechnet. Ohne eines von beiden gibt es keine Bühne: der Lauf rechnet zu dem
 * Zeitpunkt, den Läufer und Kaskade ihm geben - der echten Uhr, wie in Produktion.
 */
class PruefumgebungUhrWiringTest {
    private static final String BUEHNE = "2029-04-30T08:00:00Z";
    private static final Instant ECHT = Instant.parse("2026-10-06T12:00:00Z");
    /** Als Eigenschaft, nicht per Initialisierer: die Attrappen prüfen ihre Bedingungen schon beim Eintragen. */
    private static final String LOCAL = "spring.profiles.active=local";

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(PropertyPlaceholderAutoConfiguration.class))
            // Der echte Lauf (ohne Datenbank - es geht nur um seine Uhr), die Nachbarn der Bühnen-Uhr als Attrappen.
            .withBean(KennzahlLauf.class, () -> new KennzahlLauf(null, null, null, null, null, true))
            .withBean(EnergiemanagementDokumentService.class, () -> mock(EnergiemanagementDokumentService.class))
            .withBean(InternesAuditService.class, () -> mock(InternesAuditService.class))
            .withBean(FeststellungService.class, () -> mock(FeststellungService.class))
            .withBean(KennzahlService.class, () -> mock(KennzahlService.class))
            .withBean(BerichtService.class, () -> mock(BerichtService.class))
            .withBean(EnergiemanagementVerzeichnisService.class, () -> mock(EnergiemanagementVerzeichnisService.class))
            .withBean(EnergiemanagementWiedervorlageService.class,
                    () -> mock(EnergiemanagementWiedervorlageService.class))
            .withBean(ZugriffBuehnenUhr.class, () -> mock(ZugriffBuehnenUhr.class))
            .withBean(BewertungUmfangService.class, () -> mock(BewertungUmfangService.class))
            .withBean(BewertungKriterienService.class, () -> mock(BewertungKriterienService.class))
            .withUserConfiguration(PruefumgebungUhr.class);

    @Test
    void inDerPruefumgebungRechnetDerKennzahlLaufAufDerBuehne() {
        runner.withPropertyValues(LOCAL, "voltpilot.pruefumgebung.buehnen-uhr=" + BUEHNE).run(ctx -> {
            assertThat(ctx).hasNotFailed().hasSingleBean(PruefumgebungUhr.class);
            Instant gerechnet = ctx.getBean(KennzahlLauf.class).rechenzeit(ECHT);
            // Die Bühne steht beim Anlegen auf ihrem Augenblick und läuft in echter Zeit weiter.
            assertThat(Duration.between(Instant.parse(BUEHNE), gerechnet)).as("die Bühne, nicht der übergebene Zeitpunkt")
                    .isBetween(Duration.ZERO, Duration.ofMinutes(1));
        });
    }

    @Test
    void ohneProfilLocalRechnetDerLaufZurEchtenUhr() {
        // Produktion setzt das Profil nie - auch eine verirrte Eigenschaft stellt dort keine Bühne.
        runner.withPropertyValues("voltpilot.pruefumgebung.buehnen-uhr=" + BUEHNE).run(ctx -> {
            assertThat(ctx).hasNotFailed().doesNotHaveBean(PruefumgebungUhr.class);
            assertThat(ctx.getBean(KennzahlLauf.class).rechenzeit(ECHT)).isEqualTo(ECHT);
        });
    }

    @Test
    void ohneBuehneRechnetDerLaufAuchImProfilLocalZurEchtenUhr() {
        runner.withPropertyValues(LOCAL).run(ctx -> {
            assertThat(ctx).hasNotFailed().doesNotHaveBean(PruefumgebungUhr.class);
            assertThat(ctx.getBean(KennzahlLauf.class).rechenzeit(ECHT)).isEqualTo(ECHT);
        });
    }
}
