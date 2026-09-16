package com.voltpilot.api.uems;

import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.lang.Nullable;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Der TAKT der Endgültigkeit und der Tageswerte (UEMS AP-07 IP-13): einmal je Stunde erst
 * {@link EndgueltigkeitLauf#umschalten}, dann {@link TagVerdichter#lauf}, dann
 * {@link PeriodeVerdichter#lauf} (Monat und Jahr, AP-08 IP-5), dann {@link BerechnetePeriodenLauf#lauf} (die
 * berechneten Messstellen, AP-10 IP-10), dann {@link KennzahlLauf#lauf} (die Kennzahlen, AP-11 IP-6), zuletzt
 * {@link KorrekturVorschlagLauf#lauf} (AP-08 IP-14: das System
 * schlägt vor, freigegeben wird von Hand).
 *
 * <p><b>Die Reihenfolge ist Absicht.</b> Erst werden die fälligen Viertelstunden endgültig, dann
 * zieht der Tageslauf nach — so trägt eine Tageszeile, die in diesem Takt entsteht, schon die
 * frisch umgeschalteten Slots. Umgekehrt wäre sie eine Stunde lang hinterher. Dasselbe gilt eine
 * Stufe höher: der Monatslauf findet die Tage, die der Tageslauf gerade in seine Liste schrieb. Und die
 * berechneten Messstellen kommen NACH allen gemessenen Stufen: sie lesen deren Viertelstunden, Tage, Monate
 * und Jahre — vorher gerechnet, schrieben sie eine Zahl, die schon beim Schreiben veraltet ist. Die Kennzahlen kommen
 * NACH den berechneten Messstellen: ein Gesamtwert ist ihr Zähler.
 *
 * <p><b>Eine Stunde, weil §4.6 Nr. 3 es so nennt</b> („ein Lauf je Stunde setzt Intervalle mit
 * Ende + 7 Tage ≤ jetzt auf endgültig"). Genauer muss er nicht sein: die Frist gehört dem
 * Intervall, nicht der Zeile ({@link TagRegeln#geschlossen}) — ob dieser Takt pünktlich war,
 * ändert nie eine Entscheidung.
 *
 * <p><b>⚠ Wie jeder {@code @Scheduled} ist er im TESTLAUF AUS</b> (surefire-Systemeigenschaft) und
 * in PRODUKTION AN ({@code application.yml}, {@code matchIfMissing}) — die dokumentierte Falle mit
 * den zwischengespeicherten Testkontexten und den gestoppten Testcontainern. Wer ihn prüft, ruft
 * {@code EndgueltigkeitLauf.umschalten(...)} und {@code TagVerdichter.lauf(...)} selbst — oder den ganzen Takt
 * über {@link #takt(Instant)}. Dass die
 * AUSGELIEFERTE Vorgabe AN ist, prüft {@code EndgueltigkeitWiringTest} an der echten
 * {@code application.yml}.
 *
 * <p>Er wirft nie: ein Fehlschlag wird protokolliert und beim nächsten Takt erneut versucht — es
 * gibt keinen Zwischenzustand, den er aufräumen müsste (der Stundenlauf ist idempotent, die
 * Arbeitsliste des Tageslaufs rollt mit ihrer Transaktion zurück).
 */
@Component
@ConditionalOnProperty(name = "voltpilot.uems.endgueltigkeit.enabled",
        havingValue = "true", matchIfMissing = true)
public class EndgueltigkeitLaeufer {

    private static final Logger log = LoggerFactory.getLogger(EndgueltigkeitLaeufer.class);

    private final EndgueltigkeitLauf endgueltigkeit;
    private final TagVerdichter tage;
    private final PeriodeVerdichter perioden;
    private final BerechnetePeriodenLauf berechnete;
    private final KennzahlLauf kennzahlen;
    private final KorrekturVorschlagLauf vorschlaege;
    private AblesungLueckenLauf ablesungen;
    private KanalbindungLauf kanalbindungen;

    @Autowired
    void kanalbindungen(KanalbindungLauf lauf) { this.kanalbindungen = lauf; }

    @org.springframework.beans.factory.annotation.Autowired
    void ablesungen(AblesungLueckenLauf lauf) { this.ablesungen = lauf; }

    /** Der Takt OHNE Kennzahl-Schritt — so bauen ihn die Tests der Stufen davor (AP-08, AP-10) weiterhin. */
    public EndgueltigkeitLaeufer(EndgueltigkeitLauf endgueltigkeit, TagVerdichter tage,
            PeriodeVerdichter perioden, BerechnetePeriodenLauf berechnete, KorrekturVorschlagLauf vorschlaege) {
        this(endgueltigkeit, tage, perioden, berechnete, null, vorschlaege);
    }

    @Autowired
    public EndgueltigkeitLaeufer(EndgueltigkeitLauf endgueltigkeit, TagVerdichter tage,
            PeriodeVerdichter perioden, BerechnetePeriodenLauf berechnete, @Nullable KennzahlLauf kennzahlen,
            KorrekturVorschlagLauf vorschlaege) {
        this.endgueltigkeit = endgueltigkeit;
        this.tage = tage;
        this.perioden = perioden;
        this.berechnete = berechnete;
        this.kennzahlen = kennzahlen;
        this.vorschlaege = vorschlaege;
    }

    @Scheduled(fixedDelayString = "${voltpilot.uems.endgueltigkeit.interval-ms:3600000}",
            initialDelayString = "${voltpilot.uems.endgueltigkeit.initial-delay-ms:120000}")
    public void takt() {
        takt(Instant.now());
    }

    /**
     * Derselbe Takt mit der Uhr des Aufrufers — die Tür, durch die ein Test (AP-08 IP-19) GENAU diese Reihenfolge
     * fährt, statt sie nachzubauen.
     */
    void takt(Instant jetzt) {
        try {
            endgueltigkeit.umschalten(jetzt);
        } catch (RuntimeException e) {
            log.warn("UEMS Endgültigkeit übersprungen: {}", e.toString());
        }
        try {
            tage.lauf(jetzt);
        } catch (RuntimeException e) {
            log.warn("UEMS Tageslauf übersprungen: {}", e.toString());
        }
        try {
            perioden.lauf(jetzt);
        } catch (RuntimeException e) {
            log.warn("UEMS Monats-/Jahreslauf übersprungen: {}", e.toString());
        }
        try {
            if (ablesungen != null) ablesungen.lauf(jetzt);
        } catch (RuntimeException e) {
            log.warn("UEMS Ablesungslücken übersprungen: {}", e.toString());
        }
        // Nach ALLEN gemessenen Stufen: die berechneten Messstellen lesen, was gerade gebildet wurde.
        try {
            berechnete.lauf(jetzt);
        } catch (RuntimeException e) {
            log.warn("UEMS berechnete Periodenwerte übersprungen: {}", e.toString());
        }
        try {
            if (kanalbindungen != null) kanalbindungen.lauf(jetzt);
        } catch (RuntimeException e) {
            log.warn("UEMS Kanalbindung übersprungen: {}", e.toString());
        }
        // Nach den berechneten Messstellen: die Kennzahlen lesen gemessene UND berechnete Periodenwerte (AP-11 IP-6).
        if (kennzahlen != null) {
            try {
                kennzahlen.lauf(jetzt);
            } catch (RuntimeException e) {
                log.warn("UEMS Kennzahlen übersprungen: {}", e.toString());
            }
        }
        // Zuletzt: was gerade endgültig wurde, kann eine Nachlieferung nur noch vorschlagen — nie anwenden.
        try {
            vorschlaege.lauf(jetzt);
        } catch (RuntimeException e) {
            log.warn("UEMS Korrektur-Vorschläge übersprungen: {}", e.toString());
        }
    }
}
