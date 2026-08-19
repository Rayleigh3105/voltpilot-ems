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

    /**
     * Das ECHTE Verzeichnis aus der Ressource - kein Doppel. Wer den
     * Deye-Erstbestand ändert, sieht es hier.
     */
    private final RegisterKnowledge knowledge =
            new RegisterKnowledge(new com.fasterxml.jackson.databind.ObjectMapper());

    private static final String DEYE_3P = "hybrid_3p";

    @Test
    void theDeyeExportLimitIsTheNetzComplianceRegisterAndForcesANote() {
        RegisterKnowledge.Known known = knowledge.of(DEYE_3P, 0x00e7);

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
        RegisterKnowledge.Known known = knowledge.of(DEYE_3P, 1234);

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
        assertThat(knowledge.of(DEYE_3P, 0x00e7).render(null)).isNull();
        assertThat(knowledge.of(DEYE_3P, 0x00e7).scaled(null)).isNull();
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

    /**
     * ⚠ DIE FAMILIE IST TEIL DES SCHLÜSSELS, und das ist der Grund, warum das
     * Verzeichnis seit Stufe 2 Daten sind: dieselbe Zahl ist auf einer anderen
     * Baureihe ein anderes Register mit anderer Skala.
     */
    @Test
    void theSameAddressMeansDifferentThingsOnDifferentFamilies() {
        // Auf hybrid_3p ist 0x00E7 die eigenständige Einspeisegrenze - mit Namen
        // und Umrechnung.
        assertThat(knowledge.of(DEYE_3P, 0x00e7).label()).contains("Einspeisegrenze");
        assertThat(knowledge.of(DEYE_3P, 0x00e7).scaled(3300)).isEqualTo(33.0);
        // ... auf hybrid_1p gibt es dieses Register NICHT: die vorsichtige
        // Warnung bleibt (die Adresse ist anderswo netz-relevant), der NAME und
        // die Umrechnung fallen weg - genau die Asymmetrie, die eine falsche
        // kW-Zahl verhindert.
        RegisterKnowledge.Known elsewhere = knowledge.of("hybrid_1p", 0x00e7);
        assertThat(elsewhere.label()).isNull();
        assertThat(elsewhere.scaled(3300)).isNull();
        // Dort IST die Einspeisegrenze "Max Sell Power" (0x00F5) - mit ANDERER
        // Skala (1 statt 10), und sie erzwingt ebenfalls die Notiz.
        RegisterKnowledge.Known onePhase = knowledge.of("hybrid_1p", 0x00f5);
        assertThat(onePhase.clazz()).isEqualTo(RegisterKnowledge.CLASS_NETZ_COMPLIANCE);
        assertThat(onePhase.noteRequired()).isTrue();
        assertThat(onePhase.render(7000)).isEqualTo("7000 (7,0 kW)");
        // Und sie NENNT, dass unsere eigene Steuerung dort schreibt - der Grund,
        // aus dem die Box sie ablehnt, solange die Steuerung läuft.
        assertThat(onePhase.note()).contains("Batteriesteuerung");
    }

    /**
     * ⚠ OHNE FAMILIE BEKOMMT KEIN REGISTER EINEN NAMEN. Eine freie LAN-Adresse
     * ist ein Gerät, das nie jemand eingerichtet hat; ihm eine Deye-Bedeutung
     * anzuheften wäre die gefährlichste Auskunft dieses ganzen Pfades.
     */
    @Test
    void withoutAFamilyNoRegisterGetsAName() {
        for (String family : new String[] {null, "", "  ", "erfunden"}) {
            // 0x008D ist auf hybrid_3p bekannt - ohne Familie aber schlicht nicht.
            RegisterKnowledge.Known known = knowledge.of(family, 0x008d);
            assertThat(known.clazz())
                    .as("Familie %s", family)
                    .isEqualTo(RegisterKnowledge.CLASS_UNBEKANNT);
            assertThat(known.label()).isNull();
            assertThat(known.noteRequired()).isFalse();
        }
    }

    /**
     * ⚠ DIE WARNUNG VERALLGEMEINERT, DER NAME NICHT. Ohne gemeldete Familie
     * behält eine Adresse, die IRGENDWO zur Netz-Anmeldung gehört, ihre Klasse
     * (und damit die Notiz-Pflicht) - eine Regel, die sich auf älteren Boxen
     * still selbst abschaltete, wäre keine. Name und Skala reisen NICHT mit.
     */
    @Test
    void aComplianceAddressKeepsItsWarningEvenWithoutAFamily() {
        RegisterKnowledge.Known known = knowledge.of(null, 0x00e7);

        assertThat(known.clazz()).isEqualTo(RegisterKnowledge.CLASS_NETZ_COMPLIANCE);
        assertThat(known.noteRequired()).isTrue();
        assertThat(known.label()).as("kein erfundener Name").isNull();
        assertThat(known.scaled(7000)).as("keine erfundene Umrechnung").isNull();
        assertThat(known.render(3300)).isEqualTo("3300");
        assertThat(known.note()).contains("nicht bekannt");
    }

    /**
     * Das Verzeichnis ist eine RESSOURCE, kein Code - und der Erstbestand ist
     * der belegte Deye-Bestand aus dem Repo.
     */
    @Test
    void theCatalogIsDataAndCarriesTheDeyeFirstStock() {
        assertThat(knowledge.catalog())
                .extracting(RegisterKnowledge.FamilyView::family)
                .contains("hybrid_3p", "hybrid_1p");
        RegisterKnowledge.FamilyView threePhase = knowledge.catalog().stream()
                .filter(f -> DEYE_3P.equals(f.family())).findFirst().orElseThrow();
        assertThat(threePhase.brand()).isEqualTo("deye");
        assertThat(threePhase.registers()).isNotEmpty();
        assertThat(threePhase.registers())
                .allSatisfy(r -> {
                    assertThat(r.label()).as("jede Zeile traegt einen Klartext-Namen").isNotBlank();
                    assertThat(r.addressHex()).startsWith("0x");
                    assertThat(r.clazz()).isIn(RegisterKnowledge.CLASS_BEKANNT,
                            RegisterKnowledge.CLASS_NETZ_COMPLIANCE);
                });
        // ⚠ Eine Skala kommt NUR mit ihrer Einheit - ein nackter Faktor waere
        // eine Zahl, die niemand einordnen kann.
        assertThat(threePhase.registers())
                .allSatisfy(r -> assertThat(r.scale() == null).isEqualTo(r.unit() == null));
    }
}
