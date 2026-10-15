package com.voltpilot.api.ueberwachung;

import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.web.dto.DeviceDto;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Der {@code ereignis}-Leser (Alerting Scheibe 1, Konzept §6.3): liest das jüngste passende
 * Ereignis aus {@code messreihe_ereignis} - die Lücken des Lücken-Melders ({@code data_gap}) und
 * Box-Ereignisse wie Neustarts ({@code box_restart}), §6.3 Beispiel.
 *
 * <p>Scheibe 1 bezieht sich nur auf Box-Ereignisse ({@code leser.bezugsfeld = "box"}): die Box der
 * Anlage, wie {@link ZustandWerteLeser} sie findet. {@code zustandswort} ist die Art des jüngsten
 * Ereignisses im Rückschau-Fenster, {@code messzeit} seine Zeit; kein Ereignis im Fenster ist
 * UNBEKANNT (§6.1 Nr. 4), nicht "keins". Zählende Bedingungen ("mehr als 3 Neustarts an einem
 * Tag", §6.4) baut die spätere Scheibe, die freie Bedingungen am Wert einführt (§7 "Ausdrücklich
 * NICHT" in dieser Scheibe) - der Leser selbst ist bereits dafür bereit.
 */
@Component
public class EreignisWerteLeser implements WerteLeser {

    /** Wie weit zurück "das jüngste Ereignis" sucht, solange keine Bedingung ein eigenes Fenster nennt. */
    static final Duration RUECKSCHAU = Duration.ofDays(1);

    private final JdbcTemplate jdbc;
    private final DeviceRepository geraete;

    public EreignisWerteLeser(JdbcTemplate jdbc, DeviceRepository geraete) {
        this.jdbc = jdbc;
        this.geraete = geraete;
    }

    @Override
    public Lesung lese(WerteKatalog.Eintrag eintrag, Bezug bezug, Instant jetzt) {
        if (!"anlage".equals(bezug.art()) || !"box".equals(eintrag.leser().bezugsfeld())) {
            return Lesung.unbekannt();
        }
        List<DeviceDto> devices = geraete.findAll().stream()
                .filter(d -> bezug.id().equals(d.siteId()) && "claimed".equals(d.status())).toList();
        if (devices.isEmpty()) {
            return Lesung.unbekannt();
        }
        List<String> arten = eintrag.leser().arten();
        if (arten == null || arten.isEmpty()) {
            return Lesung.unbekannt();
        }
        List<UUID> deviceIds = devices.stream().map(DeviceDto::id).toList();
        // IN-Listen statt = ANY(?): Treiber-unabhängig, ohne java.sql.Array - beide Listen sind klein
        // (Boxen einer Anlage, Arten eines Katalog-Eintrags).
        String deviceIn = platzhalter(deviceIds.size());
        String artIn = platzhalter(arten.size());
        List<Object> args = new java.util.ArrayList<>(deviceIds);
        args.addAll(arten);
        args.add(Timestamp.from(jetzt.minus(RUECKSCHAU)));
        args.add(Timestamp.from(jetzt));
        List<Object[]> treffer = jdbc.query(
                "SELECT art, zeit FROM messreihe_ereignis "
                        + "WHERE device_id IN (" + deviceIn + ") AND art IN (" + artIn + ") "
                        + "AND zeit >= ? AND zeit <= ? ORDER BY zeit DESC LIMIT 1",
                (rs, n) -> new Object[] {rs.getString("art"), rs.getTimestamp("zeit").toInstant()},
                args.toArray());
        if (treffer.isEmpty()) {
            return Lesung.unbekannt();
        }
        Object[] zeile = treffer.get(0);
        return new Lesung(true, (String) zeile[0], (Instant) zeile[1]);
    }

    private static String platzhalter(int anzahl) {
        return String.join(",", java.util.Collections.nCopies(anzahl, "?"));
    }
}
