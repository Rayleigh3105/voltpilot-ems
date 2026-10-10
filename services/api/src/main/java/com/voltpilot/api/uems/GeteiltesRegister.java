package com.voltpilot.api.uems;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeSet;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Summen-Wächter des geteilten Punkts (AP-07 IP-18b Einschalten): benennt, wo eine Summe zwei
 * Messstellen enthält, deren führende Quellen denselben Messpunkt ({@code point_key}) DERSELBEN Box
 * über zwei verschiedene Komponenten lesen.
 *
 * <p>Meldet eine Box {@code measurement_config_per_component}, bekommt jede Komponente eines
 * geteilten Punkts ihren eigenen Wert in ihrer Reihe (samples 2.1). Beobachten beide Komponenten
 * dasselbe Register, trägt dann jede Reihe DENSELBEN Wert - eine Summe über beide Messstellen zählt
 * ihn zweimal. Heute steht dort die Lücke.
 *
 * <p><b>Benennen, nicht blockieren</b> (Muster {@link KostenstelleDoppelzaehlung}): der Fund ändert
 * keine Zahl und sperrt keinen Schreibweg. Die Cloud kann nicht entscheiden, ob zwei Komponenten
 * dasselbe Gerät lesen oder zwei Geräte hinter demselben Katalogpunkt (dann sind es zwei Fakten und
 * die Summe stimmt) - ein Port oder eine Adresse beweist keine Gerätegleichheit.
 */
public final class GeteiltesRegister {

    private GeteiltesRegister() {}

    /** Eine führende Quelle der Hauptgröße einer Messstelle, aufgelöst bis zur Box. */
    public record Bindung(UUID messstelleId, UUID deviceId, String pointKey, UUID entityId, Instant ab, Instant bis) {}

    /** Ein Summand: die Messstelle und die Summe (Rolle), in der sie steht. */
    public record Summand(UUID messstelleId, String kennzeichen, String rolle) {}

    /** Ein Fund: in der Summe {@code rolle} lesen {@code messstellen} den Messpunkt {@code register}. */
    public record Fund(String rolle, String register, List<String> messstellen) {}

    /**
     * Die Funde über die Summanden, je Rolle getrennt (nur innerhalb EINER Summe wird doppelt
     * gezählt). Zwei Bindungen zählen nur, wenn sie sich zeitlich überschneiden: eine Messstelle,
     * die von Komponente A zu B umzieht, liest nie beide zugleich. Reihenfolge: Rollen wie die
     * Summanden, darin nach Messpunkt.
     */
    public static List<Fund> finde(List<Summand> summanden, Collection<Bindung> bindungen) {
        Map<String, Map<UUID, String>> jeRolle = new LinkedHashMap<>();
        for (Summand s : summanden) {
            if (s.messstelleId() == null) continue;
            jeRolle.computeIfAbsent(s.rolle(), r -> new LinkedHashMap<>()).put(s.messstelleId(), s.kennzeichen());
        }
        List<Fund> funde = new ArrayList<>();
        for (Map.Entry<String, Map<UUID, String>> rolle : jeRolle.entrySet()) {
            Map<String, TreeSet<String>> jeRegister = new java.util.TreeMap<>();
            List<Bindung> dieser = bindungen.stream()
                    .filter(b -> rolle.getValue().containsKey(b.messstelleId())).toList();
            for (int i = 0; i < dieser.size(); i++) {
                for (int j = i + 1; j < dieser.size(); j++) {
                    Bindung a = dieser.get(i), b = dieser.get(j);
                    if (a.messstelleId().equals(b.messstelleId()) || !a.deviceId().equals(b.deviceId())
                            || !a.pointKey().equals(b.pointKey()) || Objects.equals(a.entityId(), b.entityId())
                            || !ueberschneiden(a, b)) continue;
                    String register = a.deviceId() + "/" + a.pointKey();
                    TreeSet<String> ms = jeRegister.computeIfAbsent(register, k -> new TreeSet<>());
                    ms.add(rolle.getValue().get(a.messstelleId()));
                    ms.add(rolle.getValue().get(b.messstelleId()));
                }
            }
            jeRegister.forEach((register, ms) -> funde.add(new Fund(rolle.getKey(),
                    register.substring(register.indexOf('/') + 1), List.copyOf(ms))));
        }
        return List.copyOf(funde);
    }

    private static boolean ueberschneiden(Bindung a, Bindung b) {
        return (a.bis() == null || b.ab().isBefore(a.bis())) && (b.bis() == null || a.ab().isBefore(b.bis()));
    }

    /**
     * Die führenden Quellen der Hauptgröße dieser Messstellen, die [{@code von}, {@code bis})
     * berühren, mit der Box ihrer Auswahlzeile ({@code device_measurement_selection}: dieselbe
     * Komponente, derselbe Kanal). Eine Quelle ohne Auswahlzeile liest keine Box und fehlt.
     */
    public static List<Bindung> lade(JdbcTemplate jdbc, Collection<UUID> messstellen, Instant von, Instant bis) {
        if (messstellen.isEmpty()) return List.of();
        String ids = String.join(",", messstellen.stream().map(UUID::toString).toList());
        return jdbc.query("""
                SELECT q.messstelle_id, s.device_id, q.kanal, q.entity_id, q.gueltig_ab, q.gueltig_bis
                  FROM messstelle_quelle q
                  JOIN messstelle m ON m.id = q.messstelle_id AND m.groesse = q.groesse
                                   AND m.richtung = q.richtung
                  JOIN device_measurement_selection s ON s.entity_id = q.entity_id AND s.point_key = q.kanal
                  JOIN device d ON d.id = s.device_id
                 WHERE q.messstelle_id = ANY (string_to_array(?, ',')::uuid[])
                   AND q.rolle = 'fuehrend'
                   AND q.gueltig_ab < ? AND (q.gueltig_bis IS NULL OR q.gueltig_bis > ?)
                 ORDER BY q.messstelle_id, q.gueltig_ab
                """, (rs, n) -> new Bindung(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class),
                        rs.getString(3), rs.getObject(4, UUID.class), rs.getTimestamp(5).toInstant(),
                        rs.getTimestamp(6) == null ? null : rs.getTimestamp(6).toInstant()),
                ids, Timestamp.from(bis), Timestamp.from(von));
    }
}
