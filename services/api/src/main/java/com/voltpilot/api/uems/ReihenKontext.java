package com.voltpilot.api.uems;

import com.voltpilot.api.measurement.MeasurementCatalog;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/**
 * Was die Rechenregel über EINE Reihe wissen muss, um von ihr zu sprechen — der EINE Träger, den die
 * Verdichtung von der Stelle, an der beide Quellen bekannt sind, bis {@link VerbrauchRegeln} reicht.
 * Gebildet wird er in {@code ViertelstundeVerdichter}, {@code TagVerdichter}, {@code PeriodeVerdichter}
 * und {@code ZeitraumMenge}; die Rechenregel liest daraus die Einheit des Zuwachs-Satzes und die Zone
 * jeder Uhrzeit in einem Kennzeichen. Eine weitere Angabe, die denselben Weg braucht, gehört hierher —
 * nicht in eine zweite Parameterkette.
 *
 * @param einheit die GESPEICHERTE Einheit der Reihe, wie der Zähler sie liefert (Katalog-Messkanal:
 *     Wh, kWh, MWh, varh, kvarh, m³ …); {@code null} = unbekannt, nie geraten. Angezeigt wird sie über
 *     {@link ErgebnisZustand#menge} (kWh · kvarh · kVAh · m³).
 * @param zeitzone die Zeitzone des STANDORTS (E10), in der ein Kennzeichen seine Uhrzeiten nennt
 */
public record ReihenKontext(String einheit, ZoneId zeitzone) {

    public ReihenKontext {
        Objects.requireNonNull(zeitzone, "eine Reihe spricht in der Zeitzone ihres Standorts");
    }

    /**
     * Der Träger einer Reihe: die Einheit ihres Messkanals aus dem Katalog ({@code null}, wenn er keine
     * nennt), die Zone ihres Standorts wie nachgeschlagen ({@link #zeitzonen}).
     */
    static ReihenKontext aus(MeasurementCatalog katalog, String kanal, ZoneId zeitzone) {
        return new ReihenKontext(katalog.einheit(kanal), zeitzone);
    }

    /**
     * Die Zeitzone einer Reihe zu einem Tag, wie sie nachgeschlagen wurde.
     *
     * @param siteId die Anlage der Komponente, {@code null} ohne Komponente
     * @param name eine der {@link TagRegeln#ZONEN}
     * @param herkunft {@link TagRegeln#AUS_STANDORT}, {@link TagRegeln#AUS_UNTERNEHMEN} oder
     *     {@link TagRegeln#AUS_VORGABE} — eine Zeitzone ohne Herkunft wäre eine Behauptung
     */
    record Zeitzone(UUID siteId, String name, String herkunft) {

        ZoneId zone() {
            return TagRegeln.zone(name);
        }
    }

    /** Eine Frage nach der Zeitzone: die Reihe (Mandant + Komponente) zu einem Tag. */
    record Frage(UUID tenant, UUID entity, LocalDate tag) {}

    /**
     * Die Zeitzonen zu diesen Fragen in EINER Abfrage — die eine Kette STANDORT → UNTERNEHMEN → VORGABE,
     * die Tageslauf, Viertelstundenlauf und freier Zeitraum gleich nachschlagen. Der Standort wird ZUM
     * TAG gesucht (die Zuordnung Anlage → Standort ist zeitgültig, AP-02).
     *
     * @return je Index der Frage ihre Zeitzone; fehlt nie ein Index
     */
    static Map<Integer, Zeitzone> zeitzonen(Connection con, List<Frage> fragen) throws SQLException {
        Map<Integer, Zeitzone> aus = new HashMap<>();
        if (fragen.isEmpty()) {
            return aus;
        }
        StringBuilder werte = new StringBuilder();
        for (int i = 0; i < fragen.size(); i++) {
            werte.append(i == 0 ? "" : ", ")
                    .append(i == 0 ? "(?::int, ?::uuid, ?::uuid, ?::date)" : "(?, ?, ?, ?)");
        }
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT v.i, mp.site_id,
                       (SELECT st.zeitzone
                          FROM anlage_standort a
                          JOIN standort st ON st.id = a.standort_id AND st.tenant_id = a.tenant_id
                         WHERE a.tenant_id = v.tenant_id AND a.site_id = mp.site_id
                           AND a.aufgehoben_am IS NULL
                           AND a.gueltig_ab <= v.tag
                           AND (a.gueltig_bis IS NULL OR a.gueltig_bis >= v.tag)
                         ORDER BY a.gueltig_ab DESC
                         LIMIT 1),
                       (SELECT un.zeitzone FROM unternehmen un
                         WHERE un.tenant_id = v.tenant_id
                         ORDER BY un.created_at, un.id LIMIT 1)
                  FROM (VALUES """ + werte + """
                       ) AS v(i, tenant_id, entity_id, tag)
                  LEFT JOIN measurement_point mp
                         ON mp.id = v.entity_id AND mp.tenant_id = v.tenant_id
                """)) {
            int p = 1;
            for (int i = 0; i < fragen.size(); i++) {
                Frage f = fragen.get(i);
                ps.setInt(p++, i);
                ps.setObject(p++, f.tenant(), Types.OTHER);
                ps.setObject(p++, f.entity(), Types.OTHER);
                ps.setObject(p++, f.tag());
            }
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    UUID site = rs.getObject(2, UUID.class);
                    String ausStandort = rs.getString(3);
                    String ausUnternehmen = rs.getString(4);
                    Zeitzone z;
                    if (ausStandort != null && TagRegeln.ZONEN.contains(ausStandort)) {
                        z = new Zeitzone(site, ausStandort, TagRegeln.AUS_STANDORT);
                    } else if (ausUnternehmen != null && TagRegeln.ZONEN.contains(ausUnternehmen)) {
                        z = new Zeitzone(site, ausUnternehmen, TagRegeln.AUS_UNTERNEHMEN);
                    } else {
                        z = new Zeitzone(site, TagRegeln.VORGABE_ZONE, TagRegeln.AUS_VORGABE);
                    }
                    aus.put(rs.getInt(1), z);
                }
            }
        }
        for (int i = 0; i < fragen.size(); i++) {
            aus.putIfAbsent(i, new Zeitzone(null, TagRegeln.VORGABE_ZONE, TagRegeln.AUS_VORGABE));
        }
        return aus;
    }
}
