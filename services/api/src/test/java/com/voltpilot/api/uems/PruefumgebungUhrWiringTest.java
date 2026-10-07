package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.voltpilot.api.zugriff.ZugriffBuehnenUhr;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.context.PropertyPlaceholderAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Wer auf der Bühne rechnet (Befund Auswerten a4, Entscheid K1): in der Prüfumgebung - Profil {@code local} UND gesetzte
 * {@code voltpilot.pruefumgebung.buehnen-uhr} - stellt {@link PruefumgebungUhr} auch den {@link KennzahlLauf} und die
 * Bericht-Naht der Kaskade ({@link BerichtKaskade}) auf die Bühne, damit sie auf der Uhr ihrer Leser rechnen; die Bühne
 * beginnt nie vor dem jüngsten Kennzahlwert. Ohne eines von beiden gibt es keine Bühne: beide rechnen zu dem Zeitpunkt,
 * den Läufer und Kaskade ihnen geben - der echten Uhr, wie in Produktion.
 */
class PruefumgebungUhrWiringTest {
    private static final String BUEHNE = "2029-04-30T08:00:00Z";
    private static final Instant ECHT = Instant.parse("2026-10-06T12:00:00Z");
    /** Als Eigenschaft, nicht per Initialisierer: die Attrappen prüfen ihre Bedingungen schon beim Eintragen. */
    private static final String LOCAL = "spring.profiles.active=local";

    private final ApplicationContextRunner runner = runner(null);

    /** Der Kontext; {@code juengster} = der jüngste Kennzahlwert in der Datenbank ({@code null}: keiner). */
    private static ApplicationContextRunner runner(Instant juengster) {
        return new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(PropertyPlaceholderAutoConfiguration.class))
            .withBean("adminJdbcTemplate", JdbcTemplate.class, () -> {
                JdbcTemplate jdbc = mock(JdbcTemplate.class);
                when(jdbc.queryForObject(anyString(), eq(Timestamp.class)))
                        .thenReturn(juengster == null ? null : Timestamp.from(juengster));
                return jdbc;
            })
            // Der Testlauf schaltet die Berichte aus (surefire); die Bericht-Naht gehört hier dazu.
            .withPropertyValues(BerichtKaskade.SCHALTER + "=true")
            .withBean(BerichtKaskade.class, () -> new BerichtKaskade(null))
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
            // Konzept Nachweisen n1, Befund 3: auch die Aufgaben-Route nennt „heute“ auf der Bühne.
            .withBean(EnergiemanagementPersonenService.class, () -> mock(EnergiemanagementPersonenService.class))
            .withUserConfiguration(PruefumgebungUhr.class);
    }

    @Test
    void inDerPruefumgebungRechnetDerKennzahlLaufAufDerBuehne() {
        runner.withPropertyValues(LOCAL, "voltpilot.pruefumgebung.buehnen-uhr=" + BUEHNE).run(ctx -> {
            assertThat(ctx).hasNotFailed().hasSingleBean(PruefumgebungUhr.class);
            // Die Bühne steht beim Anlegen auf ihrem Augenblick und läuft in echter Zeit weiter.
            for (Instant gerechnet : List.of(ctx.getBean(KennzahlLauf.class).rechenzeit(ECHT),
                    ctx.getBean(BerichtKaskade.class).rechenzeit(ECHT))) {
                assertThat(Duration.between(Instant.parse(BUEHNE), gerechnet))
                        .as("die Bühne, nicht der übergebene Zeitpunkt").isBetween(Duration.ZERO, Duration.ofMinutes(1));
            }
        });
    }

    @Test
    void einNeustartBeginntDieBuehneNachDemJuengstenKennzahlwert() {
        // Ein früherer Start hat bis zwei Tage nach dem Augenblick gerechnet: die Bühne beginnt eine Sekunde danach.
        Instant juengster = Instant.parse(BUEHNE).plus(Duration.ofDays(2)).plusMillis(400);
        runner(juengster).withPropertyValues(LOCAL, "voltpilot.pruefumgebung.buehnen-uhr=" + BUEHNE).run(ctx -> {
            assertThat(ctx).hasNotFailed();
            Instant gerechnet = ctx.getBean(KennzahlLauf.class).rechenzeit(ECHT);
            assertThat(Duration.between(Instant.parse(BUEHNE).plus(Duration.ofDays(2)).plusSeconds(1), gerechnet))
                    .as("nie vor dem jüngsten Kennzahlwert").isBetween(Duration.ZERO, Duration.ofMinutes(1));
        });
    }

    @Test
    void ohneProfilLocalRechnetDerLaufZurEchtenUhr() {
        // Produktion setzt das Profil nie - auch eine verirrte Eigenschaft stellt dort keine Bühne.
        runner.withPropertyValues("voltpilot.pruefumgebung.buehnen-uhr=" + BUEHNE).run(ctx -> {
            assertThat(ctx).hasNotFailed().doesNotHaveBean(PruefumgebungUhr.class);
            assertThat(ctx.getBean(KennzahlLauf.class).rechenzeit(ECHT)).isEqualTo(ECHT);
            assertThat(ctx.getBean(BerichtKaskade.class).rechenzeit(ECHT)).isEqualTo(ECHT);
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
