package com.voltpilot.writer;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Die Überlauf-Erkennung des Writers (UEMS AP-08 IP-4, Z6/E4): fällt ein Zählerstand einer Reihe,
 * die Wertebereich UND Höchstzuwachs deklariert hat, und ist der Zuwachs plausibel, meldet der
 * Writer {@code counter_overflow} — mit der Rechnung als Nutzlast.
 *
 * <p><b>Ein Fehler hier kostet NIE einen Messwert.</b> Die Erkennung ist eine Nebenwirkung des
 * Schreibens: sie läuft NACH dem Einfügen des Werts in derselben Transaktion, aber in ihrem EIGENEN
 * SAVEPOINT, und wirft nie. Scheitert sie (Deklaration nicht lesbar, Abfrage abgewiesen, was auch
 * immer), wird auf den Savepoint zurückgerollt, geloggt und in {@code
 * voltpilot_writer_ueberlauf_erkennung_total&#123;ergebnis="fehler",grund&#125;} gezählt — der Wert
 * ist geschrieben wie ohne Erkennung, der Bestand meldet {@code counter_reset} wie bisher, und es
 * entsteht KEINE Überlauf-Meldung. Das ist die richtige Seite des Fehlers: ein Wert ohne erkannten
 * Überlauf ist richtig (die Menge bildet der Verdichtungs-Lauf ohnehin aus den Werten und der
 * Deklaration, nie aus dieser Meldung), ein verlorener Wert wäre Datenverlust beim Kunden.
 *
 * <p><b>Was sie liest.</b> Zuerst die Deklaration zur Messzeit aus {@code
 * messreihe_zaehler_deklaration()} — dieselbe Funktion, aus der die Verdichtung liest. Die ist bis
 * AP-08 IP-7 leer: dann endet die Erkennung nach dieser einen Abfrage mit {@code nicht_deklariert},
 * und jeder fallende Stand bleibt eine Rücksetzung. Nur mit Deklaration liest sie den vorigen
 * GUTEN Wert derselben Reihe (Komponente + Messkanal, nie die Spiegel-Spur, höchstens
 * {@link #RUECKBLICK} zurück) und fragt {@link UeberlaufRegel} — nie eine eigene Rechnung.
 *
 * <p><b>Was sie nicht kann.</b> Ein Wert, der VOR einem schon gespeicherten eintrifft
 * (Nachlieferung), wird nur gegen seinen Vorgänger geprüft, nicht gegen den Nachfolger; eine
 * Gerätegrenze, die der Kunde später einträgt, kennt sie nicht. Beides ändert keine Menge — die
 * bildet der Lauf aus den Werten, der Deklaration und den Ereignissen.
 */
@Component
public class UeberlaufErkennung {

    private static final Logger log = LoggerFactory.getLogger(UeberlaufErkennung.class);

    static final String METRIK = "voltpilot.writer.ueberlauf.erkennung";

    /** So weit zurück sucht sie den vorigen guten Wert (Chunk-Ausschluss auf der Messzeit). */
    static final Duration RUECKBLICK = Duration.ofDays(1);

    /** Was sie fand: der vorige gute Stand und die Deklaration, mit der entschieden wurde. */
    record Ueberlauf(BigDecimal standAlt, Instant messzeitAlt, BigDecimal wertebereichModul,
            BigDecimal hoechstzuwachsJeKadenz, int kadenzS) {}

    private record Deklaration(BigDecimal modul, BigDecimal hoechstzuwachs, Integer kadenzS) {}

    private record Vorher(Instant zeit, BigDecimal stand) {}

    private final JdbcTemplate jdbc;
    private final TransactionTemplate savepoint;
    private final MeterRegistry meters;

    public UeberlaufErkennung(JdbcTemplate jdbc, PlatformTransactionManager transactions,
            MeterRegistry meters) {
        this.jdbc = jdbc;
        this.meters = meters;
        // NESTED = ein JDBC-Savepoint in der Transaktion des Aufrufers; zurückgerollt bleibt die
        // Transaktion des Aufrufers intakt und NICHT rollback-only.
        this.savepoint = new TransactionTemplate(transactions);
        this.savepoint.setPropagationBehavior(TransactionDefinition.PROPAGATION_NESTED);
    }

    /**
     * Prüft EINEN gerade geschriebenen Wert. Wirft nie; {@code null} heißt „kein Überlauf zu
     * melden“ — auch nach einem Fehler.
     */
    Ueberlauf pruefen(UUID tenant, UUID entity, String messkanal, Instant messzeit, BigDecimal stand) {
        if (entity == null || stand == null) {
            return null;
        }
        try {
            return savepoint.execute(status -> erkennen(tenant, entity, messkanal, messzeit, stand));
        } catch (RuntimeException ex) {
            String grund = MessreiheEreignisRepository.grund(ex);
            log.error("Überlauf-Erkennung für Komponente {} / {} bei {} fehlgeschlagen ({}); auf den "
                    + "Savepoint zurückgerollt, der Messwert ist geschrieben und es wird kein "
                    + "counter_overflow gemeldet", entity, messkanal, messzeit, grund, ex);
            zaehlen("fehler", grund);
            return null;
        }
    }

    private Ueberlauf erkennen(UUID tenant, UUID entity, String messkanal, Instant messzeit, BigDecimal stand) {
        List<Deklaration> deklaration = jdbc.query("SELECT wertebereich_modul, hoechstzuwachs_je_kadenz, "
                        + "kadenz_s FROM messreihe_zaehler_deklaration(?, ?, ?, ?)",
                (rs, n) -> new Deklaration(rs.getBigDecimal(1), rs.getBigDecimal(2),
                        (Integer) rs.getObject(3)),
                tenant, entity, messkanal, Timestamp.from(messzeit));
        Deklaration d = deklaration.isEmpty() ? null : deklaration.get(0);
        if (d == null || d.modul() == null || d.hoechstzuwachs() == null || d.kadenzS() == null
                || d.kadenzS() < 1) {
            zaehlen("nicht_deklariert", "");
            return null;
        }
        List<Vorher> vorher = jdbc.query("SELECT time, coalesce(decoded_numeric, raw_numeric) "
                        + "FROM device_measurement_sample "
                        + "WHERE tenant_id = ? AND entity_id = ? AND point_key = ? AND quality = 'good' "
                        + "AND role IS DISTINCT FROM 'spiegel' AND time < ? AND time >= ? "
                        + "AND coalesce(decoded_numeric, raw_numeric) IS NOT NULL "
                        + "ORDER BY time DESC LIMIT 1",
                (rs, n) -> new Vorher(rs.getTimestamp(1).toInstant(), rs.getBigDecimal(2)),
                tenant, entity, messkanal, Timestamp.from(messzeit),
                Timestamp.from(messzeit.minus(RUECKBLICK)));
        if (vorher.isEmpty()) {
            zaehlen("kein_ueberlauf", "");
            return null;
        }
        Vorher v = vorher.get(0);
        BigDecimal modul = new BigDecimal(d.modul().stripTrailingZeros().toPlainString());
        BigDecimal ueber = UeberlaufRegel.ueberlauf(v.stand(), v.zeit(), stand, messzeit,
                Duration.ofSeconds(d.kadenzS()), modul, d.hoechstzuwachs());
        if (ueber == null) {
            zaehlen("kein_ueberlauf", "");
            return null;
        }
        zaehlen("ueberlauf", "");
        return new Ueberlauf(v.stand(), v.zeit(), modul, d.hoechstzuwachs(), d.kadenzS());
    }

    private void zaehlen(String ergebnis, String grund) {
        Counter.builder(METRIK)
                .description("Überlauf-Erkennung des Writers je geschriebenem Zählerstand, nach Ergebnis")
                .tag("ergebnis", ergebnis)
                .tag("grund", grund)
                .register(meters)
                .increment();
    }
}
