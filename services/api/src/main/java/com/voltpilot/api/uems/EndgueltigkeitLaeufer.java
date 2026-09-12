package com.voltpilot.api.uems;

import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Der TAKT der Endgültigkeit und der Tageswerte (UEMS AP-07 IP-13): einmal je Stunde erst
 * {@link EndgueltigkeitLauf#umschalten}, dann {@link TagVerdichter#lauf}, dann
 * {@link PeriodeVerdichter#lauf} (Monat und Jahr, AP-08 IP-5).
 *
 * <p><b>Die Reihenfolge ist Absicht.</b> Erst werden die fälligen Viertelstunden endgültig, dann
 * zieht der Tageslauf nach — so trägt eine Tageszeile, die in diesem Takt entsteht, schon die
 * frisch umgeschalteten Slots. Umgekehrt wäre sie eine Stunde lang hinterher. Dasselbe gilt eine
 * Stufe höher: der Monatslauf findet die Tage, die der Tageslauf gerade in seine Liste schrieb.
 *
 * <p><b>Eine Stunde, weil §4.6 Nr. 3 es so nennt</b> („ein Lauf je Stunde setzt Intervalle mit
 * Ende + 7 Tage ≤ jetzt auf endgültig"). Genauer muss er nicht sein: die Frist gehört dem
 * Intervall, nicht der Zeile ({@link TagRegeln#geschlossen}) — ob dieser Takt pünktlich war,
 * ändert nie eine Entscheidung.
 *
 * <p><b>⚠ Wie jeder {@code @Scheduled} ist er im TESTLAUF AUS</b> (surefire-Systemeigenschaft) und
 * in PRODUKTION AN ({@code application.yml}, {@code matchIfMissing}) — die dokumentierte Falle mit
 * den zwischengespeicherten Testkontexten und den gestoppten Testcontainern. Wer ihn prüft, ruft
 * {@code EndgueltigkeitLauf.umschalten(...)} und {@code TagVerdichter.lauf(...)} selbst. Dass die
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

    public EndgueltigkeitLaeufer(EndgueltigkeitLauf endgueltigkeit, TagVerdichter tage,
            PeriodeVerdichter perioden) {
        this.endgueltigkeit = endgueltigkeit;
        this.tage = tage;
        this.perioden = perioden;
    }

    @Scheduled(fixedDelayString = "${voltpilot.uems.endgueltigkeit.interval-ms:3600000}",
            initialDelayString = "${voltpilot.uems.endgueltigkeit.initial-delay-ms:120000}")
    public void takt() {
        Instant jetzt = Instant.now();
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
    }
}
