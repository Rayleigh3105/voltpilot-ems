package com.voltpilot.api.registerwrite;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Optional;
import org.junit.jupiter.api.Test;

/**
 * Das Register-WISSEN der Cloud - rein, ohne Docker, ohne Spring.
 *
 * <p>Was hier festgenagelt wird, ist die Ehrlichkeits-Seite: ein unbekanntes
 * Register bekommt KEINEN erfundenen Namen und KEINE erfundene Einheit, die
 * getippte Schreibweise wird nicht geraten, und die Klasse
 * {@code netz_compliance} erzwingt die Notiz (Captain-Entscheid D5).
 */
class RegisterKnowledgeTest {

    @Test
    void theDeyeExportLimitIsTheNetzComplianceRegisterAndForcesANote() {
        RegisterKnowledge.Known known = RegisterKnowledge.of(0x00e7);

        assertThat(known.clazz()).isEqualTo(RegisterKnowledge.CLASS_NETZ_COMPLIANCE);
        assertThat(known.label()).contains("Einspeisegrenze");
        assertThat(known.noteRequired())
                .as("die Netz-Anmeldung ist der eine Fall, in dem die Notiz Pflicht ist")
                .isTrue();
        // Der Anwendungsfall-Kern: 3300 sind 33,0 kW, 7000 sind 70,0 kW.
        assertThat(known.render(3300)).isEqualTo("3300 (33,0 kW)");
        assertThat(known.scaled(7000)).isEqualTo(70.0);
        assertThat(known.scaleNote(7000)).isEqualTo("Rohwert × 0,01 = 70,0 kW");
    }

    @Test
    void anUnknownRegisterClaimsNothing() {
        RegisterKnowledge.Known known = RegisterKnowledge.of(1234);

        assertThat(known.clazz()).isEqualTo(RegisterKnowledge.CLASS_UNBEKANNT);
        assertThat(known.label()).as("ein erfundener Name waere eine Luege").isNull();
        assertThat(known.noteRequired()).isFalse();
        // Ohne bekannte Skala bleibt der Rohwert der Rohwert - nie eine erfundene
        // Einheit daneben.
        assertThat(known.render(3300)).isEqualTo("3300");
        assertThat(known.scaled(3300)).isNull();
        assertThat(known.scaleNote(3300)).isNull();
    }

    @Test
    void aMissingReadingRendersNothingRatherThanZero() {
        // Eine 0 waere bei einer Einspeisegrenze ein WERT ("gar keine Einspeisung
        // erlaubt"), nie eine Abwesenheit.
        assertThat(RegisterKnowledge.of(0x00e7).render(null)).isNull();
        assertThat(RegisterKnowledge.of(0x00e7).scaled(null)).isNull();
    }

    @Test
    void bothSpellingsOfTheSameAddressAreAccepted() {
        assertThat(RegisterKnowledge.parseAddress("0x00E7")).contains(231);
        assertThat(RegisterKnowledge.parseAddress("0X00e7")).contains(231);
        assertThat(RegisterKnowledge.parseAddress(" 231 ")).contains(231);
        assertThat(RegisterKnowledge.parseAddress("0")).contains(0);
        assertThat(RegisterKnowledge.parseAddress("65535")).contains(65535);
    }

    @Test
    void aBareHexWordIsNeverGuessed() {
        // "E7" koennte 231 oder ein Tippfehler sein - und ein geratenes Register
        // ist genau der Fehler, gegen den die ganze Strecke gebaut ist.
        assertThat(RegisterKnowledge.parseAddress("E7")).isEmpty();
        assertThat(RegisterKnowledge.parseAddress("")).isEmpty();
        assertThat(RegisterKnowledge.parseAddress(null)).isEmpty();
        assertThat(RegisterKnowledge.parseAddress("-1")).isEmpty();
        assertThat(RegisterKnowledge.parseAddress("65536")).isEmpty();
        assertThat(RegisterKnowledge.parseAddress("0x1FFFF")).isEmpty();
    }

    @Test
    void aValueIsAWordAndNothingElse() {
        assertThat(RegisterKnowledge.parseValue("7000")).contains(7000);
        assertThat(RegisterKnowledge.parseValue("0x1B58")).contains(7000);
        assertThat(RegisterKnowledge.parseValue("70,0")).isEmpty();
        assertThat(RegisterKnowledge.parseValue("70.0")).isEmpty();
        assertThat(RegisterKnowledge.parseValue("70000"))
                .as("jenseits von 16 Bit gibt es kein Registerwort").isEqualTo(Optional.empty());
    }

    @Test
    void theConfirmTokenNamesRegisterAndValue() {
        // Er nennt BEIDES, damit eine Bestaetigung aus einem frueheren, anderen
        // Versuch diesen nicht autorisiert.
        assertThat(RegisterKnowledge.confirmToken(0x00e7, 7000)).isEqualTo("0X00E7=7000");
        assertThat(RegisterKnowledge.confirmToken(0x00e7, 3300))
                .isNotEqualTo(RegisterKnowledge.confirmToken(0x00e7, 7000));
        assertThat(RegisterKnowledge.hex(0x00e7)).isEqualTo("0x00e7");
    }
}
