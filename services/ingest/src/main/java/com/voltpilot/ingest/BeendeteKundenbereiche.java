package com.voltpilot.ingest;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HashSet;
import java.util.Properties;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Die beendeten Kundenbereiche (UEMS AP-20 IP-16, E10 = A, §5.5): „Boxen liefern weiter nichts in einen beendeten
 * Bereich — der Eingang verwirft mit Zählung". Jeder Strom fragt {@link #beendet(String)} mit dem MQTT-Topic
 * ({@code ems/{tenant}/…}) VOR der Prüfung; ein Treffer wird als {@code verworfen{grund="kundenbereich_beendet"}}
 * gezählt und quittiert — kein {@code rejected}-Ereignis, denn auch das wäre ein Schreibweg in den beendeten Bereich.
 *
 * <p>Der Stand kommt aus {@code tenant.beendet_am} (Migration {@code V20260925170000} der API) und wird höchstens alle
 * {@link #ALTER} neu gelesen — auf dem MQTT-Faden, mit kurzer Verbindungs- und Lesefrist. Scheitert das Lesen, bleibt
 * der letzte Stand (anfangs: keiner beendet) und die WARN-Zeile nennt es: die Datenannahme hält nie an, weil die
 * Datenbank kurz fehlt (dieselbe Abwägung wie {@code JdbcDeviceDirectory}). Die Sperre wirkt darum spätestens eine
 * Minute nach dem Beenden; die API sperrt sofort.
 */
public class BeendeteKundenbereiche {

    /** Wie lange ein gelesener Stand gilt. */
    public static final Duration ALTER = Duration.ofSeconds(60);

    private static final Logger log = LoggerFactory.getLogger(BeendeteKundenbereiche.class);

    /** Die Quelle des Standes — im Betrieb JDBC, in Tests ein Stand von Hand. */
    @FunctionalInterface
    public interface Quelle {
        Set<UUID> laden() throws Exception;
    }

    private final Quelle quelle;
    private final Clock clock;
    private volatile Set<UUID> stand = Set.of();
    private Instant gelesen;

    public BeendeteKundenbereiche(Quelle quelle, Clock clock) {
        this.quelle = quelle;
        this.clock = clock;
    }

    /** Liegt das Topic in einem beendeten Kundenbereich? Ein Topic ohne lesbare Kennung gehört keinem. */
    public boolean beendet(String mqttTopic) {
        UUID kundenbereich = kundenbereich(mqttTopic);
        if (kundenbereich == null) {
            return false;
        }
        auffrischen();
        return stand.contains(kundenbereich);
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

    private synchronized void auffrischen() {
        Instant jetzt = clock.instant();
        if (gelesen != null && jetzt.isBefore(gelesen.plus(ALTER))) {
            return;
        }
        gelesen = jetzt;
        try {
            stand = Set.copyOf(quelle.laden());
        } catch (Exception e) {
            log.warn("beendete Kundenbereiche nicht lesbar, es gilt der letzte Stand ({}): {}", stand.size(),
                    e.getMessage());
        }
    }

    /** Die Betriebs-Quelle: eine kurze Verbindung mit den Zugangsdaten der Datenannahme (wie die Box-Auskunft). */
    public static Quelle jdbc(String jdbcUrl, String username, String password) {
        return () -> {
            Properties p = new Properties();
            p.setProperty("user", username);
            p.setProperty("password", password);
            p.setProperty("connectTimeout", "2");
            p.setProperty("socketTimeout", "5");
            Set<UUID> aus = new HashSet<>();
            try (Connection c = DriverManager.getConnection(jdbcUrl, p);
                    Statement s = c.createStatement();
                    ResultSet rs = s.executeQuery("SELECT id FROM tenant WHERE beendet_am IS NOT NULL")) {
                while (rs.next()) {
                    aus.add(rs.getObject(1, UUID.class));
                }
            }
            return aus;
        };
    }
}
