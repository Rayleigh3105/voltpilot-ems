package com.voltpilot.api.registerwrite;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Die Adressierungs-Regel, rein und ohne Container (Produktionsvorfall
 * 20.08.2026).
 *
 * <p><b>⚠ ANTI-KOINZIDENZ-REGEL: keine zwei Kennungen in diesem Test sind
 * gleich, und keine ist die „naheliegende".</b> Der Defekt, um den es hier geht,
 * ist eine VERWECHSLUNG von Kennungen - ein Aufbau, in dem die richtige und die
 * falsche Antwort zusammenfallen (eine Anlage mit genau einem Gerät, ein
 * Stellvertreter, der jede Adresse zurückechot), kann ihn per Konstruktion nicht
 * sehen. Genau daran lag es, dass die Blindstelle so lange bestand.
 */
class RegisterWriteGatewayTest {

    /** Die Box: sie meldet sich, also hört ein Core auf ihrem Pfad zu. */
    private static final UUID BOX = UUID.fromString("15cb7cd3-b7fd-4bf0-a571-180baaa1c3ff");
    /** Eine zweite Geräte-Zeile derselben Anlage, die sich NIE gemeldet hat. */
    private static final UUID STUMM = UUID.fromString("2a7e9f11-0c34-4d58-9b62-7e1f0a3c55d0");
    /** Eine Kennung, die gar keine Geräte-Zeile ist. */
    private static final UUID FREMD = UUID.fromString("3b8f0022-1d45-4e69-ac73-8f2b1b4d66e1");

    private static final Instant NOW = Instant.parse("2026-08-20T12:00:00Z");

    private static List<RegisterWriteGateway.Device> herzogau() {
        return List.of(
                new RegisterWriteGateway.Device(BOX, "Deye SUN-30K", NOW.minusSeconds(12)),
                new RegisterWriteGateway.Device(STUMM, "VP-ALT-0001", null));
    }

    @Test
    @DisplayName("das Topic folgt dem gewählten ZIEL, nicht der Angabe des Aufrufers")
    void theTopicFollowsTheTargetNotTheClaim() {
        // Das Ziel ist eine Komponente, die die BOX meldet - der Aufrufer nennt
        // aber die zweite Zeile. Ein NICHT-retainter Auftrag dort wäre spurlos
        // weg, also gewinnt die meldende Box.
        RegisterWriteGateway.Choice c =
                RegisterWriteGateway.choose(herzogau(), BOX, STUMM, NOW);

        assertThat(c.ok()).isTrue();
        assertThat(c.device().id()).isEqualTo(BOX);
        assertThat(c.origin()).isEqualTo(RegisterWriteGateway.Origin.TARGET);
        assertThat(c.overruled()).as("die Überstimmung ist ein Hinweis, kein Nebenbei")
                .isTrue();
    }

    @Test
    @DisplayName("stimmen Ziel und Angabe überein, wird nichts überstimmt")
    void anAgreeingRequestIsNotOverruled() {
        RegisterWriteGateway.Choice c = RegisterWriteGateway.choose(herzogau(), BOX, BOX, NOW);
        assertThat(c.device().id()).isEqualTo(BOX);
        assertThat(c.overruled()).isFalse();
    }

    @Test
    @DisplayName("eine nie gemeldete Zeile wird BENANNT, nie abgewiesen - und die richtige genannt")
    void aDeviceThatNeverReportedIsNamedNotRefused() {
        RegisterWriteGateway.Choice c = RegisterWriteGateway.choose(herzogau(), null, STUMM, NOW);

        assertThat(c.ok()).as("der Auftrag geht trotzdem hinaus - Stille ist kein Beweis")
                .isTrue();
        assertThat(c.device().id()).isEqualTo(STUMM);
        assertThat(c.note()).contains("noch nie bei VoltPilot gemeldet")
                .contains("Deye SUN-30K");
    }

    @Test
    @DisplayName("auf einer Anlage mit EINEM Gerät gibt es nichts zu verwechseln")
    void aSingleDevicePlantNeverGetsTheSuspicion() {
        // Eine frisch eingerichtete Box ohne Wechselrichter sendet keine
        // Telemetrie und hört trotzdem zu - hier darf NICHTS behauptet werden.
        List<RegisterWriteGateway.Device> fresh = List.of(
                new RegisterWriteGateway.Device(BOX, "Neue Box", null));

        RegisterWriteGateway.Choice c = RegisterWriteGateway.choose(fresh, null, BOX, NOW);

        assertThat(c.ok()).isTrue();
        assertThat(c.note()).isNull();
    }

    @Test
    @DisplayName("eine Box, die GERADE schweigt, bekommt keinen Verdacht angehängt")
    void aTemporarilySilentBoxStillGetsTheOrder() {
        List<RegisterWriteGateway.Device> devices = List.of(
                new RegisterWriteGateway.Device(BOX, "Deye SUN-30K", NOW.minusSeconds(3600)));

        RegisterWriteGateway.Choice c = RegisterWriteGateway.choose(devices, null, BOX, NOW);

        assertThat(c.ok()).isTrue();
        assertThat(c.device().id()).isEqualTo(BOX);
        assertThat(c.note()).isNull();
    }

    @Test
    @DisplayName("ohne Angabe entscheidet die EINZIGE Zeile, mehrere werden beim Namen genannt")
    void withoutARequestTheOnlyDeviceDecidesAndSeveralAreNamed() {
        List<RegisterWriteGateway.Device> one = List.of(
                new RegisterWriteGateway.Device(BOX, "Deye SUN-30K", NOW.minusSeconds(5)));
        RegisterWriteGateway.Choice only = RegisterWriteGateway.choose(one, null, null, NOW);
        assertThat(only.device().id()).isEqualTo(BOX);
        assertThat(only.origin()).isEqualTo(RegisterWriteGateway.Origin.ONLY);

        RegisterWriteGateway.Choice several =
                RegisterWriteGateway.choose(herzogau(), null, null, NOW);
        assertThat(several.ok()).isFalse();
        assertThat(several.refusal()).contains("mehrere Geräte");
    }

    @Test
    @DisplayName("eine fremde Kennung bleibt „nicht gefunden\", eine Anlage ohne Gerät sagt das")
    void aForeignIdIsNotFoundAndAPlantWithoutADeviceSaysSo() {
        RegisterWriteGateway.Choice foreign =
                RegisterWriteGateway.choose(herzogau(), null, FREMD, NOW);
        assertThat(foreign.ok()).isFalse();
        assertThat(foreign.refusal()).isEqualTo("Gerät nicht gefunden.");

        RegisterWriteGateway.Choice none = RegisterWriteGateway.choose(List.of(), null, BOX, NOW);
        assertThat(none.ok()).isFalse();
        assertThat(none.refusal()).contains("noch kein verbundenes Gerät");
    }

    @Test
    @DisplayName("ein nicht verfügbares Ziel-Gerät wird benannt abgelehnt, nie durch die Anfrage ersetzt")
    void anOwnerOutsideThePlantIsRefused() {
        // Kann nur aus einer widersprüchlichen Ableitung kommen; sie darf den
        // Auftrag nie auf eine fremde Anlage schicken.
        RegisterWriteGateway.Choice c = RegisterWriteGateway.choose(herzogau(), FREMD, BOX, NOW);
        assertThat(c.ok()).isFalse();
        assertThat(c.refusal()).contains("zuständige Box");
    }
}
