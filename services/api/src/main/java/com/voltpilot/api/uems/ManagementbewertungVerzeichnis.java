package com.voltpilot.api.uems;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * UEMS AP-19 IP-23 (VZ1, VZ2, MG7): die Verzeichnis-Quelle „Managementbewertung“ — je Stand einer Managementbewertung
 * bis zum Stichtag eine Zeile der Gruppe {@code managementbewertung}: Art {@code berichtsstand}, Kennung BR-…, Nr.,
 * entschieden von (die Leitung der Sitzung, wie der Abzug sie festhält), eingetragen von (das Konto, das freigegeben
 * hat), Tag der Freigabe, Prüfsumme, Ort „in VoltPilot“. Gelesen aus dem Stand selbst — kopiert wird nichts; die
 * Managementbewertung gilt für das Unternehmen, darum sieht sie nur, wer unternehmensweit liest (keine Zeile in der
 * Teilansicht). Die übrigen Berichtsstände liest
 * {@link VerzeichnisBestand}.
 */
@Component
@Order(110)
public class ManagementbewertungVerzeichnis implements VerzeichnisQuelle {

    static final String GRUPPE = "managementbewertung";

    private final JdbcTemplate jdbc;

    public ManagementbewertungVerzeichnis(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public List<Map<String, Object>> zeilen(LocalDate stichtag) {
        var aus = new ArrayList<Map<String, Object>>();
        jdbc.query("""
                SELECT b.kennung, b.zeitraum_schluessel, b.zeitzone, s.nr, s.freigegeben_am, s.freigeber_name,
                       s.pruefsumme, s.abzug::jsonb #>> '{sitzung,leitung}' AS leitung
                  FROM bericht b
                  JOIN bericht_stand s ON s.tenant_id = b.tenant_id AND s.bericht_id = b.id
                 WHERE b.vorlage = 'managementbewertung' AND uems_zugriff_unternehmensweit()
                 ORDER BY b.zeitraum_schluessel, s.nr
                """, rs -> {
                    LocalDate tag = LocalDate.ofInstant(rs.getTimestamp("freigegeben_am").toInstant(),
                            ZoneId.of(rs.getString("zeitzone")));
                    if (tag.isAfter(stichtag)) return;
                    String leitung = rs.getString("leitung");
                    String freigeber = rs.getString("freigeber_name");
                    Map<String, Object> zeile = EnergiemanagementRegeln.verzeichnisZeile(
                            new EnergiemanagementRegeln.VerzeichnisEingang(GRUPPE, "berichtsstand", rs.getString("kennung"),
                                    "Managementbewertung " + rs.getString("zeitraum_schluessel"), rs.getInt("nr"),
                                    leitung != null && !leitung.equals(freigeber) ? leitung : null, freigeber,
                                    tag.toString(), rs.getString("pruefsumme"), "in_voltpilot", null));
                    if (zeile.containsKey("fehler")) {
                        throw new IllegalStateException("Verzeichnis-Zeile von " + rs.getString("kennung") + ": "
                                + zeile.get("fehler"));
                    }
                    aus.add(zeile);
                });
        return aus;
    }
}
