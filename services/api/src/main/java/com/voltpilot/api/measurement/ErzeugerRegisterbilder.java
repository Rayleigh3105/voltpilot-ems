package com.voltpilot.api.measurement;

import com.voltpilot.api.erzeuger.ErzeugerRegisterbild;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * UEMS EZ-6: die Parameter je Anlagensteuerung für {@code mqtt-measurement-config} (Feld
 * {@code erzeuger_registerbilder}, {@code x-erzeuger-registerbilder-rule}) — das Gegenstück zu
 * {@link WagoRegisterbilder} für das VoltPilot-Registerbild Erzeuger v1.
 *
 * <p>Ein Eintrag je Komponente vom Typ {@code anlagensteuerung}, die im Plan einen Punkt {@code erzeuger.*}
 * trägt, aus der LAUFENDEN Registerbild-Fassung ihres Geräts: Basisadresse, Funktionscode, Wortfolge, Zahl der
 * Einheiten, Anlagenart, Schwelle „veraltet“ für den Netzpunkt und — nur wenn vergeben — die Steuerung-Kennung
 * (fehlt = wird nicht geprüft, nie 0). Ein Plan ohne Erzeuger-Punkt fragt die Datenbank nicht einmal; eine
 * Komponente ohne laufende Fassung bekommt keinen Eintrag (ihre Punkte bleiben dann ungelesen, nie an Adresse 0).
 */
@Component
public class ErzeugerRegisterbilder {

    /** Eine Zeile der Abfrage: Komponente und die laufende Fassung ihres Geräts. */
    record Fassung(UUID entityId, int basisadresse, int funktionscode, String wortfolge, int teAnzahl,
            String anlagenart, Long steuerungKennung, int veraltetNetzpunktS) {}

    private final JdbcTemplate jdbc;

    public ErzeugerRegisterbilder(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Die Bilder für diesen Plan — leer (ohne Abfrage), wenn der Plan keinen Erzeuger-Punkt trägt. */
    public List<Map<String, Object>> fuer(UUID siteId, List<MeasurementPlan.Entry> plan) {
        Set<UUID> komponenten = komponenten(plan);
        if (komponenten.isEmpty()) {
            return List.of();
        }
        return bilde(laden(siteId, komponenten));
    }

    /** Die laufenden Fassungen der Anlagensteuerungen dieser Komponenten an der Anlage (unter RLS). */
    List<Fassung> laden(UUID siteId, Set<UUID> komponenten) {
        return jdbc.query("SELECT v.entity_id, f.basisadresse, f.funktionscode, f.wortfolge, "
                + "f.te_anzahl, f.anlagenart, f.steuerung_kennung, f.veraltet_netzpunkt_s "
                + "FROM geraet_komponente v "
                + "JOIN geraet g ON g.id = v.geraet_id AND g.ausgebaut_am IS NULL "
                + "JOIN registerbild_fassung f ON f.geraet_id = g.id AND f.bildart = '"
                + ErzeugerRegisterbild.BILDART + "' AND f.gueltig_ab <= now() "
                + "AND (f.gueltig_bis IS NULL OR f.gueltig_bis > now()) "
                + "WHERE g.site_id = ? AND v.entity_id = ANY (?::uuid[]) AND v.gueltig_ab <= now() "
                + "AND (v.gueltig_bis IS NULL OR v.gueltig_bis > now())",
                (rs, n) -> new Fassung(rs.getObject("entity_id", UUID.class), rs.getInt("basisadresse"),
                        rs.getInt("funktionscode"), rs.getString("wortfolge"), rs.getInt("te_anzahl"),
                        rs.getString("anlagenart"), (Long) rs.getObject("steuerung_kennung"),
                        rs.getInt("veraltet_netzpunkt_s")),
                siteId, komponenten.stream().map(UUID::toString).toArray(String[]::new));
    }

    /** Die Komponenten des Plans, die einen Erzeuger-Punkt tragen — in Planreihenfolge. */
    static Set<UUID> komponenten(List<MeasurementPlan.Entry> plan) {
        Set<UUID> out = new LinkedHashSet<>();
        for (MeasurementPlan.Entry e : plan) {
            if (e.entityId() != null && ErzeugerRegisterbild.feld(e.pointKey()).isPresent()) {
                out.add(e.entityId());
            }
        }
        return out;
    }

    /** Rein: je Komponente ein Bild, nach {@code entity_id} sortiert (deterministisch für den Vergleich). */
    static List<Map<String, Object>> bilde(List<Fassung> zeilen) {
        List<Map<String, Object>> out = new ArrayList<>();
        zeilen.stream().sorted(java.util.Comparator.comparing(f -> f.entityId().toString())).forEach(f -> {
            Map<String, Object> bild = new LinkedHashMap<>();
            bild.put("entity_id", f.entityId());
            bild.put("basisadresse", f.basisadresse());
            bild.put("funktionscode", f.funktionscode());
            bild.put("wortfolge", f.wortfolge());
            bild.put("te_anzahl", f.teAnzahl());
            bild.put("anlagenart", f.anlagenart());
            if (f.steuerungKennung() != null) bild.put("steuerung_kennung", f.steuerungKennung());
            bild.put("veraltet_netzpunkt_s", f.veraltetNetzpunktS());
            out.add(bild);
        });
        return out;
    }
}
