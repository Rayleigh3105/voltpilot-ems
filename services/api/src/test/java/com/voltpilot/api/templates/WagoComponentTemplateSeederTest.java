package com.voltpilot.api.templates;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.CannotGetJdbcConnectionException;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * <b>Ein Start-Hörer darf den Start der api nicht verhindern.</b> Eine Ausnahme aus einem
 * {@code ApplicationReadyEvent}-Hörer wird von {@code SpringApplication.run} gefangen, an
 * {@code handleRunFailure} gegeben und dann geworfen - {@code main} endet mit Fehler, der Pod
 * startet neu. Der WAGO-Seeder schreibt nur einen Vorlagen-Eintrag, den der nächste Start ohnehin
 * nachholt; eine kurz nicht erreichbare Rolle {@code voltpilot_admin} (Sperre, Timeout,
 * Passwortwechsel) darf davon nicht die ganze api mitnehmen.
 *
 * <p>Sichtbar wurde das an {@code UemsBerichtNachDenFristenTest}, dessen Kontext seit PR 949 nicht
 * mehr lud ({@code password authentication failed for user "voltpilot_admin"}). Die fünf anderen
 * Start-Läufer fangen und protokollieren seit je; dieser Test hält den WAGO-Seeder auf derselben
 * Bauart fest.
 */
class WagoComponentTemplateSeederTest {

    @Test
    void derStartHoererTraegtEinenFehlschlagStattIhnZuWerfen() {
        JdbcTemplate admin = mock(JdbcTemplate.class);
        when(admin.update(anyString(), any(Object[].class)))
                .thenThrow(new CannotGetJdbcConnectionException(
                        "FATAL: password authentication failed for user \"voltpilot_admin\""));

        assertThatCode(() -> new WagoComponentTemplateSeeder(admin).seed()).doesNotThrowAnyException();
    }

    /**
     * Die Gegenprobe hält die Wache ehrlich: der Schreibvorgang selbst wirft weiterhin, die Wache
     * sitzt also am Hörer und verdeckt keinen stillen Nichts-Tun-Pfad.
     */
    @Test
    void derSchreibvorgangSelbstMeldetDenFehlerWeiterhin() {
        JdbcTemplate admin = mock(JdbcTemplate.class);
        when(admin.update(anyString(), any(Object[].class)))
                .thenThrow(new CannotGetJdbcConnectionException("keine Verbindung"));

        assertThatThrownBy(() -> new WagoComponentTemplateSeeder(admin).schreibe())
                .isInstanceOf(CannotGetJdbcConnectionException.class);
    }

    /** Im Normalfall schreibt der Hörer genau einmal, mit der Vorlagen-Kennung als beiden Parametern. */
    @Test
    void imNormalfallSchreibtDerHoererDieVorlage() {
        JdbcTemplate admin = mock(JdbcTemplate.class);
        when(admin.update(anyString(), any(Object[].class))).thenReturn(1);

        new WagoComponentTemplateSeeder(admin).seed();

        verify(admin).update(anyString(), any(Object[].class));
        assertThat(WagoComponentTemplateSeeder.REF).isEqualTo("certified:wago:pm494_pm495_registerbild_v1");
    }
}
