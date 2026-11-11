package com.voltpilot.api;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.UUID;

/**
 * Ein künstlich versionierter Fahrplan-Bestand für die Tests der
 * Verdichtung (Migration {@code V20261104133000}): alle 15 Minuten ein Lauf
 * über 192 Slots ab dem Slot, in dem er ausgelöst wurde, gestempelt 867 µs
 * nach der Slotgrenze (die Herzogau-Marke aus
 * {@code ScheduleRepository.dayAsPlanned}); jeder fünfzigste Lauf bekommt eine
 * Neuplanung sieben Minuten später über denselben Horizont. Die Werte hängen
 * von Lauf UND Slot ab, damit "welche Version" in jedem Leser zählbar ist.
 */
public final class FahrplanVersionenBestand {

    public static final int HORIZONT_SLOTS = 192;

    private FahrplanVersionenBestand() {
    }

    /** Läufe alle 15 Minuten von {@code von} bis {@code bis} (beide auf dem Raster), siehe Klassen-Javadoc. */
    public static void laeufe(Connection c, UUID tenant, UUID site, Instant von, Instant bis) throws Exception {
        String sql = """
                INSERT INTO schedule (time, tenant_id, site_id, plan_id, generated_at,
                                      battery_kw, grid_kw, soc_pct, load_kw, pv_kw, price_eur_mwh,
                                      cost_eur, baseline_cost_eur, stur_cost_eur, curtail_kw, slot_role)
                SELECT r + i * interval '15 minutes', ?, ?, md5(r::text || ? || n::text)::uuid,
                       r + interval '867 microseconds' + n * interval '7 minutes',
                       ((ri + i) % 11) - 5,
                       ((ri * 3 + i) % 13) - 6,
                       (ri + i) % 100,
                       1 + (i % 8) / 10.0 + (ri % 3) / 100.0,
                       (i % 6) + (ri % 2) / 10.0,
                       50 + (i % 20) + (ri % 4),
                       ((ri % 97) + i) / 10000.0,
                       ((ri % 97) + i) / 10000.0 + ((ri % 5) + 1) / 1000.0,
                       CASE WHEN ri % 9 = 0 THEN NULL ELSE ((ri % 97) + i) / 10000.0 - (ri % 3) / 1000.0 END,
                       CASE WHEN (ri + i) % 7 = 0 THEN 0.3 + (ri % 3) / 10.0 ELSE 0 END,
                       CASE WHEN (ri + i) % 4 = 0 THEN 'verkaufen' ELSE 'warten' END
                FROM generate_series(?::timestamptz, ?::timestamptz, interval '15 minutes') r
                CROSS JOIN LATERAL (SELECT (extract(epoch FROM r)::bigint / 900) AS ri) x
                CROSS JOIN generate_series(0, 191) i
                CROSS JOIN LATERAL (SELECT n FROM generate_series(0, 1) n WHERE n = 0 OR ri % 50 = 0) nn
                """;
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setObject(1, tenant);
            ps.setObject(2, site);
            ps.setString(3, site.toString());
            ps.setTimestamp(4, Timestamp.from(von));
            ps.setTimestamp(5, Timestamp.from(bis));
            ps.executeUpdate();
        }
    }

    /** Der erste Slot ab {@code von}, dessen Lauf eine Neuplanung trägt (Laufindex durch 50 teilbar). */
    public static Instant ersterNeuplanungsSlot(Instant von) {
        long ri = von.getEpochSecond() / 900;
        while (ri % 50 != 0) {
            ri++;
        }
        return Instant.ofEpochSecond(ri * 900);
    }

    /**
     * Der erste Slot ab {@code von} ohne Neuplanung im eigenen Lauf und im Lauf
     * davor - ein Slot, der nach der Verdichtung genau zwei Zeilen hält: den bei
     * Beginn gültigen Lauf und den an seiner Slotgrenze ausgelösten.
     */
    public static Instant ersterRegulaererSlot(Instant von) {
        long ri = von.getEpochSecond() / 900;
        while (ri % 50 == 0 || (ri - 1) % 50 == 0) {
            ri++;
        }
        return Instant.ofEpochSecond(ri * 900);
    }

    public static void stammdaten(Connection c, UUID tenant, UUID site, String name) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO tenant (id, name) VALUES (?, ?) ON CONFLICT DO NOTHING")) {
            ps.setObject(1, tenant);
            ps.setString(2, "Mandant " + name);
            ps.execute();
        }
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, ?, 'DE-LU')")) {
            ps.setObject(1, site);
            ps.setObject(2, tenant);
            ps.setString(3, "Anlage " + name);
            ps.execute();
        }
    }
}
