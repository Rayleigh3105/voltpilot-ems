package com.voltpilot.api.kundenbereich;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Die beendeten Kundenbereiche für die Wege der API, die NICHT über eine Route kommen (UEMS AP-20, Folgepaket zu
 * IP-16, E10 = A „alles gesperrt"): die MQTT-Rückmeldewege ({@link Rueckmeldeweg}), die Läufer und den
 * Flotten-Rollout. Die Routen sperrt {@link KundenbereichEndeFilter} je Anfrage; diese Wege fragen HIER.
 *
 * <p>Wie {@code BeendeteKundenbereiche} im ingest: der Stand kommt aus {@code tenant.beendet_am} und wird höchstens
 * alle {@link #ALTER} neu gelesen — kein Weg fragt je Nachricht die Datenbank. Scheitert das Lesen, bleibt der letzte
 * Stand (anfangs: keiner beendet) und die WARN-Zeile nennt es: eine Rückmeldung oder ein Läufer hält nie an, weil die
 * Datenbank kurz fehlt. Beenden und Wiederaufnehmen in DIESER Instanz wirken sofort ({@link #vergessen()}); eine
 * zweite Instanz sperrt spätestens nach einer Minute.
 */
@Component
public class BeendeteKundenbereiche {

    /** Wie lange ein gelesener Stand gilt. */
    public static final Duration ALTER = Duration.ofSeconds(60);
    /** Rückmeldungen, die nichts geschrieben haben: {@code weg} = der Rückmeldeweg, {@code grund} geschlossen. */
    public static final String VERWORFEN = "voltpilot_rueckmeldung_verworfen_total";
    public static final String GRUND = KundenbereichEnde.CODE;

    /** Der Stand, der nie etwas sperrt — für Wege, die ohne Spring gebaut werden (Tests mit {@code new …}). */
    public static final BeendeteKundenbereiche KEINE = new BeendeteKundenbereiche(Set::of, Clock.systemUTC(), null);

    private static final Logger log = LoggerFactory.getLogger(BeendeteKundenbereiche.class);

    /** Die Quelle des Standes — im Betrieb die Admin-Verbindung, in Tests ein Stand von Hand. */
    @FunctionalInterface
    public interface Quelle {
        Set<UUID> laden() throws Exception;
    }

    private final Quelle quelle;
    private final Clock clock;
    private final MeterRegistry metriken;
    private volatile Set<UUID> stand = Set.of();
    private Instant gelesen;

    @Autowired
    public BeendeteKundenbereiche(KundenbereichEndeRepository repository, MeterRegistry metriken) {
        this(repository::alleBeendeten, Clock.systemUTC(), metriken);
    }

    public BeendeteKundenbereiche(Quelle quelle, Clock clock, MeterRegistry metriken) {
        this.quelle = quelle;
        this.clock = clock;
        this.metriken = metriken;
    }

    /** Ist der Kundenbereich beendet? {@code null} gehört keinem. */
    public boolean beendet(UUID kundenbereich) {
        if (kundenbereich == null) {
            return false;
        }
        auffrischen();
        return stand.contains(kundenbereich);
    }

    /** Alle beendeten Kundenbereiche — für Läufer, die ihre Arbeit in einem Zug wählen. */
    public Set<UUID> alle() {
        auffrischen();
        return stand;
    }

    /**
     * Die beendeten Kundenbereiche als Parameter für {@code NOT (tenant_id = ANY (?::uuid[]))}: ein Läufer mit einer
     * Warteschlange ({@code ORDER BY … LIMIT}) filtert IM SQL — liesse er die Zeilen erst in Java aus, stünden sie vorn
     * und hielten jeden anderen Kundenbereich auf. Die Zeilen bleiben liegen und laufen nach einer Wiederaufnahme.
     */
    public String[] sqlFeld() {
        return alle().stream().map(UUID::toString).sorted().toArray(String[]::new);
    }

    /**
     * Der Rückmeldeweg fragt, BEVOR er liest, prüft oder schreibt: liegt das Topic ({@code ems/{tenant}/…}) in einem
     * beendeten Kundenbereich, wird die Nachricht verworfen und gezählt. Kein Antwort-Ereignis, keine Protokollzeile —
     * auch das wäre ein Schreibweg in den beendeten Bereich.
     */
    public boolean verwirft(String weg, String mqttTopic) {
        if (!beendet(kundenbereich(mqttTopic))) {
            return false;
        }
        zaehler(weg).increment();
        log.debug("Rückmeldung auf {} verworfen ({}): Kundenbereich beendet", mqttTopic, weg);
        return true;
    }

    /** Die Reihe eines Weges steht ab dem Start mit 0 bereit (wie die geschlossenen Reihen des ingest). */
    public void anmelden(String weg) {
        if (metriken != null) {
            zaehler(weg);
        }
    }

    /** Die nächste Frage liest neu — nach Beenden oder Wiederaufnehmen in dieser Instanz. */
    public synchronized void vergessen() {
        gelesen = null;
    }

    static UUID kundenbereich(String mqttTopic) {
        if (mqttTopic == null || !mqttTopic.startsWith("ems/")) {
            return null;
        }
        int ende = mqttTopic.indexOf('/', 4);
        try {
            return UUID.fromString(ende < 0 ? mqttTopic.substring(4) : mqttTopic.substring(4, ende));
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private Counter zaehler(String weg) {
        return Counter.builder(VERWORFEN).tag("weg", weg).tag("grund", GRUND)
                .description("MQTT-Rückmeldungen der Boxen, die die API verworfen hat, ohne etwas zu schreiben")
                .register(metriken);
    }

    private synchronized void auffrischen() {
        Instant jetzt = clock.instant();
        if (gelesen != null && jetzt.isBefore(gelesen.plus(ALTER))) {
            return;
        }
        gelesen = jetzt;
        try {
            Set<UUID> neu = Set.copyOf(quelle.laden());
            if (!neu.equals(stand)) {
                log.info("beendete Kundenbereiche: {} (vorher {})", neu.size(), stand.size());
            }
            stand = neu;
        } catch (Exception e) {
            log.warn("beendete Kundenbereiche nicht lesbar, es gilt der letzte Stand ({}): {}", stand.size(),
                    e.getMessage());
        }
    }
}
