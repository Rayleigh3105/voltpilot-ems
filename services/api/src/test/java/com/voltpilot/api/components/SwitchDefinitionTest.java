package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.DisplayNameGeneration;
import org.junit.jupiter.api.DisplayNameGenerator;
import org.junit.jupiter.api.Test;

/**
 * Die reinen Regeln der Geräte-Freigabe (Einheitsmodell Stufe 4). Docker-frei -
 * jede Regel, die ein Schalten verhindern kann, ist ohne einen Container
 * prüfbar (das {@code SelfBuildDefinition}-Muster).
 */
@DisplayNameGeneration(DisplayNameGenerator.ReplaceUnderscores.class)
class SwitchDefinitionTest {

    private static SwitchDefinition.Switch onOff() {
        return new SwitchDefinition.Switch("on_off", "coil", 3, null, 1, 0,
                null, null, null, null, null, null, 3, null, null);
    }

    private static SwitchDefinition.Switch setpoint() {
        return new SwitchDefinition.Switch("setpoint", "holding", 100, null, null, null,
                1.0, 10.0, 0.0, 0.001, 0.0, "kW", 100, null, null);
    }

    @Test
    void the_two_switch_kinds_normalise_with_the_function_code_the_device_really_needs() {
        SwitchDefinition.Result coil = SwitchDefinition.validate(onOff());
        assertThat(coil.ok()).isTrue();
        // Eine Spule wird mit FC5 geschrieben - abgeleitet, nicht geraten.
        assertThat(coil.value().writeFc()).isEqualTo(SwitchDefinition.FC_COIL);

        SwitchDefinition.Result reg = SwitchDefinition.validate(setpoint());
        assertThat(reg.ok()).isTrue();
        // ⚠ Ein Register bekommt FC16, NICHT FC6: ein Einzelregister-Schreiben
        // wird auf mehreren realen Geräten angenommen und nicht übernommen.
        assertThat(reg.value().writeFc()).isEqualTo(SwitchDefinition.FC_MULTIPLE);
    }

    @Test
    void a_setpoint_never_leaves_its_clamp_whatever_is_asked_for() {
        SwitchDefinition.NormalizedSwitch s = SwitchDefinition.validate(setpoint()).value();
        assertThat(s.rawFor(5.0)).isEqualTo(5000);
        assertThat(s.rawFor(99.0)).isEqualTo(10000);
        assertThat(s.rawFor(-99.0)).isEqualTo(1000);
        // Der Sicherheitswert liegt bewusst UNTER dem Betriebsminimum und wird
        // deshalb NICHT in das Band geklemmt - sonst wäre „aus" ein „lauf
        // langsam weiter".
        assertThat(s.safeRaw()).isZero();
    }

    @Test
    void a_test_value_outside_the_clamp_is_refused_and_never_silently_clamped() {
        SwitchDefinition.NormalizedSwitch s = SwitchDefinition.validate(setpoint()).value();
        assertThat(SwitchDefinition.testValueError(s, 5.0)).isNull();
        // Wer 30 eintippt und stillschweigend 10 bekäme, hätte einen ANDEREN
        // Test gefahren als den, den er danach bestätigt.
        assertThat(SwitchDefinition.testValueError(s, 30.0))
                .contains("zwischen 1 und 10").contains("kW");
        assertThat(SwitchDefinition.testValueError(s, null)).isNotNull();
        // Ein/Aus kennt keinen Testwert - die Konstante steht fest.
        assertThat(SwitchDefinition.testValueError(SwitchDefinition.validate(onOff()).value(), null))
                .isNull();
        assertThat(SwitchDefinition.testRaw(SwitchDefinition.validate(onOff()).value(), null))
                .isEqualTo(1);
        assertThat(SwitchDefinition.testRaw(s, 3.0)).isEqualTo(3000);
    }

    @Test
    void every_refusal_names_its_reason_in_plain_german() {
        record Case(String name, SwitchDefinition.Switch input, String contains) {
        }
        List<Case> cases = List.of(
                new Case("no kind", new SwitchDefinition.Switch(null, "coil", 3, null, 1, 0,
                        null, null, null, null, null, null, null, null, null),
                        "ein- und ausgeschaltet"),
                new Case("unknown register kind", new SwitchDefinition.Switch("on_off", "input", 3,
                        null, 1, 0, null, null, null, null, null, null, null, null, null),
                        "Relais-Spule"),
                new Case("address out of range", new SwitchDefinition.Switch("on_off", "coil",
                        70000, null, 1, 0, null, null, null, null, null, null, null, null, null),
                        "0 und 65535"),
                new Case("coil with FC16", new SwitchDefinition.Switch("on_off", "coil", 3, 16,
                        1, 0, null, null, null, null, null, null, null, null, null),
                        "Funktionscode 5"),
                new Case("register with FC5", new SwitchDefinition.Switch("on_off", "holding", 3, 5,
                        1, 0, null, null, null, null, null, null, null, null, null),
                        "Funktionscode 16"),
                new Case("coil value is not a bit", new SwitchDefinition.Switch("on_off", "coil", 3,
                        null, 300, 0, null, null, null, null, null, null, null, null, null),
                        "nur 0 und 1"),
                new Case("on equals off", new SwitchDefinition.Switch("on_off", "coil", 3, null,
                        1, 1, null, null, null, null, null, null, null, null, null),
                        "nie wieder ausschalten"),
                new Case("setpoint on a coil", new SwitchDefinition.Switch("setpoint", "coil", 3,
                        null, null, null, 1.0, 10.0, 0.0, 0.001, 0.0, "kW", null, null, null),
                        "braucht ein Register"),
                new Case("setpoint without a clamp", new SwitchDefinition.Switch("setpoint",
                        "holding", 100, null, null, null, null, null, 0.0, 0.001, 0.0, "kW",
                        null, null, null), "kleinsten und den größten"),
                new Case("inverted clamp", new SwitchDefinition.Switch("setpoint", "holding", 100,
                        null, null, null, 10.0, 1.0, 0.0, 0.001, 0.0, "kW", null, null, null),
                        "unter dem größten"),
                new Case("no safe value", new SwitchDefinition.Switch("setpoint", "holding", 100,
                        null, null, null, 1.0, 10.0, null, 0.001, 0.0, "kW", null, null, null),
                        "Sicherheitswert"),
                new Case("scale zero", new SwitchDefinition.Switch("setpoint", "holding", 100,
                        null, null, null, 1.0, 10.0, 0.0, 0.0, 0.0, "kW", null, null, null),
                        "ungleich 0"),
                new Case("no unit", new SwitchDefinition.Switch("setpoint", "holding", 100,
                        null, null, null, 1.0, 10.0, 0.0, 0.001, 0.0, " ", null, null, null),
                        "Einheit"),
                // Der Fall, den ein Kunde mit einem Handbuch wirklich baut: die
                // Skalierung passt nicht zu den Grenzen, und der größte Sollwert
                // ließe sich gar nicht in ein 16-Bit-Register schreiben.
                new Case("clamp does not fit a register", new SwitchDefinition.Switch("setpoint",
                        "holding", 100, null, null, null, 1.0, 100.0, 0.0, 0.001, 0.0, "kW",
                        null, null, null), "was ein Register darstellen kann"),
                new Case("readback out of range", new SwitchDefinition.Switch("on_off", "coil", 3,
                        null, 1, 0, null, null, null, null, null, null, 70000, null, null),
                        "Rücklese-Registers"),
                new Case("watchdog out of range", new SwitchDefinition.Switch("on_off", "coil", 3,
                        null, 1, 0, null, null, null, null, null, null, null, 70000, null),
                        "Watchdog-Registers"));
        for (Case c : cases) {
            SwitchDefinition.Result r = SwitchDefinition.validate(c.input());
            assertThat(r.ok()).as(c.name()).isFalse();
            assertThat(r.value()).as(c.name()).isNull();
            assertThat(String.join(" ", r.errors())).as(c.name()).contains(c.contains());
        }
    }

    @Test
    void the_rated_power_is_mandatory_because_it_IS_the_clamp() {
        // Ohne Nennleistung gäbe es kein max_consumption_kw und damit keine
        // Verbraucher-Klemme vor dem Executor.
        assertThat(SwitchDefinition.validateConsumer(
                new SwitchDefinition.Consumer(null, null, null, null, null)))
                .anySatisfy(e -> assertThat(e).contains("Nennleistung"));
        assertThat(SwitchDefinition.validateConsumer(
                new SwitchDefinition.Consumer(0.0, null, null, null, null))).isNotEmpty();
        assertThat(SwitchDefinition.validateConsumer(
                new SwitchDefinition.Consumer(3.5, 600, 900, 4, "power_kw"))).isEmpty();
        // Die Zyklen-Zeiten sind optional - eine fehlende Achse ist inaktiv,
        // nie eine erfundene Schonung.
        assertThat(SwitchDefinition.validateConsumer(
                new SwitchDefinition.Consumer(3.5, null, null, null, null))).isEmpty();
        assertThat(SwitchDefinition.validateConsumer(
                new SwitchDefinition.Consumer(3.5, -1, null, null, null)))
                .anySatisfy(e -> assertThat(e).contains("Mindestlaufzeit"));
        assertThat(SwitchDefinition.validateConsumer(
                new SwitchDefinition.Consumer(3.5, null, null, 0, null)))
                .anySatisfy(e -> assertThat(e).contains("Starts"));
    }

    @Test
    void a_release_needs_BOTH_a_passed_test_and_the_confirmed_effect() {
        // Der Test beweist, dass das Register erreichbar ist; die Bestätigung
        // beweist, dass das RICHTIGE Gerät reagiert hat. Eines allein reicht
        // für keine der beiden Aussagen.
        assertThat(SwitchDefinition.requireRelease(false, false)).contains("Schalt-Test");
        assertThat(SwitchDefinition.requireRelease(false, true)).contains("Schalt-Test");
        assertThat(SwitchDefinition.requireRelease(true, false)).contains("Wirkung am Gerät");
        assertThat(SwitchDefinition.requireRelease(true, true)).isNull();
    }

    @Test
    void the_deadman_note_names_the_honest_gap_and_the_revoke_names_its_consequences() {
        // Ein generisches Modbus-Gerät hat KEINEN eingebauten Totmann; wer das
        // nicht sagt, verspricht eine Sicherheit, die es nicht gibt.
        assertThat(SwitchDefinition.DEADMAN_NOTE)
                .contains("Fällt die VoltPilot-Box aus")
                .contains("letzten Zustand")
                .contains("eigene Sicherheitsabschaltung");
        assertThat(SwitchDefinition.revokeConsequences())
                .anySatisfy(c -> assertThat(c).contains("Regeln für dieses Gerät stoppen"))
                .anySatisfy(c -> assertThat(c).contains("Messwerte"))
                .hasSize(4);
    }
}
