package com.voltpilot.api.fahrzeuge;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.verbraucher.Steuerart;
import com.voltpilot.api.verbraucher.SteuerartProjektion;
import java.math.BigDecimal;
import org.junit.jupiter.api.Test;

/**
 * Die REGELN eines Fahrzeug-Profils (P7) - rein, ohne Docker.
 */
class FahrzeugSteuerartTest {

    private static final String TAG = "tagref_1f2e3d4c5b6a798877665544";

    /**
     * ⚠ Ein Profil kennt GENAU ZWEI Quellen, und das folgt aus der Maschine:
     * die Quellen-Bahn der Box kann „Sofort" und „Überschuss" ausdrücken, mehr
     * nicht. „Günstige Stunden" ist ein Preisfenster und damit eine Policy -
     * die hängt an einer KOMPONENTE, nicht an einer Karte.
     */
    @Test
    void aProfileKnowsExactlyTheTwoSourcesTheLaneCanExpress() {
        assertThat(FahrzeugSteuerart.QUELLEN).containsExactly(
                SteuerartProjektion.QUELLE_SOFORT, SteuerartProjektion.QUELLE_UEBERSCHUSS);
    }

    /**
     * ⚠ „Günstige Stunden" und „Feste Zeiten" werden BEIM NAMEN abgelehnt, nicht
     * als „ungültig": der Kunde hat die Wörter auf der Ladepunkt-Zeile gesehen,
     * und ein Formular, das den Unterschied nicht erklärt, sieht nach einem
     * Fehler aus statt nach einer Grenze der Maschine.
     */
    @Test
    void aTargetShapedSourceIsRefusedByName() {
        assertThat(FahrzeugSteuerart.pruefe(
                new FahrzeugSteuerart.Wunsch(null, SteuerartProjektion.QUELLE_GUENSTIG, null, null)))
                .containsExactly(FahrzeugSteuerart.GRUND_ZIEL);
        assertThat(FahrzeugSteuerart.pruefe(new FahrzeugSteuerart.Wunsch(null,
                SteuerartProjektion.QUELLE_FESTE_ZEITEN, null, null)))
                .containsExactly(FahrzeugSteuerart.GRUND_ZIEL);
        assertThat(FahrzeugSteuerart.pruefe(
                new FahrzeugSteuerart.Wunsch(null, "phantasie", null, null)))
                .hasSize(1).first().asString().contains("phantasie");
    }

    /** Ein Name allein ist ein gültiger Wunsch: benennen und steuern sind zwei Schritte. */
    @Test
    void namingWithoutSteeringIsAValidWish() {
        FahrzeugSteuerart.Wunsch w = new FahrzeugSteuerart.Wunsch("Dienstwagen", null, null, null);
        assertThat(FahrzeugSteuerart.pruefe(w)).isEmpty();
        assertThat(FahrzeugSteuerart.bahn(w))
                .as("ohne Quelle wird keine Bahn geschrieben - das Fahrzeug folgt seiner Säule")
                .isNull();
    }

    /**
     * Die Abbildung Quelle ⟷ Bahn ist die GETEILTE - dieselbe, die eine Säule
     * fährt. Zwei Kopien wären eine Karte, die anders lädt als ihre Säule.
     */
    @Test
    void theLaneIsTheSameMappingAStationUses() {
        assertThat(FahrzeugSteuerart.bahn(
                new FahrzeugSteuerart.Wunsch(null, SteuerartProjektion.QUELLE_SOFORT, null, null)))
                .isEqualTo(new FahrzeugSteuerart.Bahn(SteuerartProjektion.POLICY_SCHNELL, null));
        // Die Vorgabe eines Überschuss-Wunsches ist die ENGERE: nur Sonnenstrom.
        assertThat(FahrzeugSteuerart.bahn(new FahrzeugSteuerart.Wunsch(null,
                SteuerartProjektion.QUELLE_UEBERSCHUSS, null, BigDecimal.valueOf(4.2))))
                .isEqualTo(new FahrzeugSteuerart.Bahn(SteuerartProjektion.POLICY_NUR_SONNE, null));
        // ⚠ Und der BODEN reist nur mit, wenn er auch gemeint ist - sonst könnte
        // die Box ihn als „sonne_zuerst" missverstehen.
        assertThat(FahrzeugSteuerart.bahn(new FahrzeugSteuerart.Wunsch(null,
                SteuerartProjektion.QUELLE_UEBERSCHUSS, SteuerartProjektion.MODUS_MINDESTLEISTUNG,
                BigDecimal.valueOf(4.2))))
                .isEqualTo(new FahrzeugSteuerart.Bahn(SteuerartProjektion.POLICY_SONNE_ZUERST,
                        BigDecimal.valueOf(4.2)));
    }

    /** Der RUNDLAUF: was gespeichert wurde, liest sich als dieselbe Steuerart. */
    @Test
    void theRoundTripReturnsTheSameSteuerart() {
        for (String modus : new String[] {SteuerartProjektion.MODUS_PAUSIEREN,
                SteuerartProjektion.MODUS_MINDESTLEISTUNG}) {
            FahrzeugSteuerart.Wunsch w = new FahrzeugSteuerart.Wunsch("Privatwagen",
                    SteuerartProjektion.QUELLE_UEBERSCHUSS, modus, BigDecimal.valueOf(4.2));
            FahrzeugSteuerart.Bahn b = FahrzeugSteuerart.bahn(w);
            Steuerart zurueck = FahrzeugSteuerart.steuerart(b.source(), b.minKw());
            assertThat(zurueck.quelle()).isEqualTo(SteuerartProjektion.QUELLE_UEBERSCHUSS);
            assertThat(zurueck.ueberschussModus()).isEqualTo(modus);
        }
        FahrzeugSteuerart.Bahn sofort = FahrzeugSteuerart.bahn(
                new FahrzeugSteuerart.Wunsch(null, SteuerartProjektion.QUELLE_SOFORT, null, null));
        assertThat(FahrzeugSteuerart.steuerart(sofort.source(), null).quelle())
                .isEqualTo(SteuerartProjektion.QUELLE_SOFORT);
    }

    /** Ohne gespeicherte Quelle gibt es KEINE Steuerart - nur eine Sichtung. */
    @Test
    void withoutASourceThereIsNoSteuerart() {
        assertThat(FahrzeugSteuerart.steuerart(null, null)).isNull();
        assertThat(FahrzeugSteuerart.steuerart("  ", null)).isNull();
    }

    /**
     * ⚠ Nur was die BOX gebildet haben kann, ist ein Schlüssel. Ein
     * Klartext-IdTag und der doppelt gehashte Journal-Bezug der Cloud fallen
     * beide durch - der eine, weil er die Box nie verlassen darf, der andere,
     * weil er nie ein Fahrzeug träfe.
     */
    @Test
    void onlyThisBoxesOwnPseudonymIsAKey() {
        assertThat(FahrzeugSteuerart.istPseudonym(TAG)).isTrue();
        for (String bad : new String[] {null, "", "RIG-TAG", "tagref_",
                "tagref_ABCDEF0123456789abcdef", "tagref_1f2e", "tagref_zzzzzzzzzzzz"}) {
            assertThat(FahrzeugSteuerart.istPseudonym(bad)).as("%s", bad).isFalse();
        }
    }

    @Test
    void aNameIsTrimmedAndAnEmptyOneClears() {
        assertThat(FahrzeugSteuerart.name("  Dienstwagen ")).isEqualTo("Dienstwagen");
        assertThat(FahrzeugSteuerart.name("   ")).isNull();
        assertThat(FahrzeugSteuerart.name(null)).isNull();
        assertThat(FahrzeugSteuerart.pruefe(new FahrzeugSteuerart.Wunsch("x".repeat(121),
                null, null, null))).hasSize(1);
    }

    /** Die Kurzform fürs Protokoll nennt NIE den ganzen Bezug. */
    @Test
    void theShortFormNeverCarriesTheWholeReference() {
        assertThat(FahrzeugSteuerart.kurz(TAG)).isEqualTo("1f2e");
        assertThat(TAG).contains(FahrzeugSteuerart.kurz(TAG));
        assertThat(FahrzeugSteuerart.kurz(TAG).length()).isLessThan(TAG.length());
        assertThat(FahrzeugSteuerart.kurz(null)).isEmpty();
    }

    @Test
    void anImplausibleMinimumIsRefused() {
        assertThat(FahrzeugSteuerart.pruefe(new FahrzeugSteuerart.Wunsch(null,
                SteuerartProjektion.QUELLE_UEBERSCHUSS, SteuerartProjektion.MODUS_MINDESTLEISTUNG,
                BigDecimal.valueOf(-1)))).hasSize(1);
        assertThat(FahrzeugSteuerart.pruefe(new FahrzeugSteuerart.Wunsch(null,
                SteuerartProjektion.QUELLE_UEBERSCHUSS, SteuerartProjektion.MODUS_MINDESTLEISTUNG,
                BigDecimal.valueOf(1001)))).hasSize(1);
    }
    /**
     * ⚠ DREI Zustände der Quelle - und der dritte ist der Weg ZURÜCK. Der
     * Dialog bietet „Lädt wie der Ladepunkt" ausdrücklich als Wahl an; ohne
     * ihn müsste der Kunde das ganze Profil entfernen und verlöre dabei den
     * Namen, den er vergeben hat (im Review gefunden, nicht im Test).
     */
    @Test
    void theSourceKeyDecidesWhetherTheLaneIsTouchedAtAll() {
        // Gar nicht genannt = nichts ändern.
        assertThat(FahrzeugSteuerart.setztBahn(
                new FahrzeugSteuerart.Wunsch("Dienstwagen", null, null, null))).isFalse();
        // Ausdrücklich geleert = zurücknehmen. Die Bahn ist dann null, aber sie
        // wird GESCHRIEBEN - genau darin unterscheiden sich die zwei Fälle.
        FahrzeugSteuerart.Wunsch leer =
                new FahrzeugSteuerart.Wunsch("Dienstwagen", "", null, null);
        assertThat(FahrzeugSteuerart.setztBahn(leer)).isTrue();
        assertThat(FahrzeugSteuerart.bahn(leer)).isNull();
        assertThat(FahrzeugSteuerart.pruefe(leer))
                .as("die Rücknahme ist eine gültige Wahl, keine Ablehnung").isEmpty();
        // Ein Wort = setzen.
        assertThat(FahrzeugSteuerart.setztBahn(new FahrzeugSteuerart.Wunsch(null,
                SteuerartProjektion.QUELLE_SOFORT, null, null))).isTrue();
        assertThat(FahrzeugSteuerart.setztBahn(null)).isFalse();
    }
}