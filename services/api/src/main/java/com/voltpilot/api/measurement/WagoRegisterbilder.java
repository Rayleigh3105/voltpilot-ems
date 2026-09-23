package com.voltpilot.api.measurement;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Die Parameter je Anlage eines „VoltPilot-Registerbild WAGO v1“ für den Mess-Plan einer Box
 * ({@code registerbilder} in {@code mqtt-measurement-config} 2.0, additiv; Vertrag
 * {@code wago-registerbild.md} §2). Ohne sie lehnt die Box jeden Kartenpunkt als
 * {@code driver_unavailable} ab — es gibt keine Vorgabe-Basisadresse.
 *
 * <p>Gebildet wird nur aus dem Bestand (Entscheid firstmate B, 23.09.2026): Basisadresse,
 * Funktionscode und Wortfolge aus der Verbindung der Karten-Komponenten, Steckplatz und Kartentyp
 * aus der Karte am Controller. <b>Variante und Controller-Kennung speichert die api nicht</b> — sie
 * fehlen im Dokument und die Box prüft sie dann nicht; eine erfundene 0 würde jede 750-495
 * (Variante 25001) stumm schalten. Was nicht eindeutig ist, wird nicht gesendet: dann bleiben die
 * Punkte dieses Controllers abgelehnt, nie an einer geratenen Adresse gelesen.
 */
@Component
public class WagoRegisterbilder {
    /** Ein Kartenpunkt der Palette ({@code wago.pm494.karte[n].…}). */
    static final Pattern KARTENPUNKT = Pattern.compile("^wago\\.pm(494|495)\\.karte\\[");
    /** Der Kartentyp im Freitext der Karte („750-494/000-001 (5 A)“). */
    static final Pattern TYP = Pattern.compile("750-(494|495)(?!\\d)");
    private static final int KOPF = 12;
    private static final int BLOCK = 42;

    /** Eine heute eingebaute Energiekarte eines Controllers, mit der Komponente, die sie speist. */
    public record Karte(UUID geraetId, UUID teilId, Integer steckplatz, String typ, UUID entityId,
            String verbindung) {}

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public WagoRegisterbilder(JdbcTemplate jdbc, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.mapper = mapper;
    }

    /** Die Registerbilder zu einem Plan — leer (und ohne Abfrage), wenn er keinen Kartenpunkt trägt. */
    public List<Map<String, Object>> fuer(UUID siteId, List<MeasurementPlan.Entry> plan) {
        Map<UUID, Integer> familie = familieJeKomponente(plan);
        if (familie.isEmpty()) return List.of();
        String komponenten = String.join(",", familie.keySet().stream().map(UUID::toString).toList());
        // ALLE heute eingebauten Karten der Controller, die eine Karten-Komponente des Plans speisen:
        // die Kartenzahl im Kopf zählt jede Karte des Registerbilds, nicht nur die gemessenen.
        List<Karte> karten = jdbc.query("""
                SELECT t.geraet_id, t.id, t.steckplatz, t.typ, k.entity_id, m.connection_json::text
                  FROM geraet_teil t
                  JOIN geraet g ON g.id = t.geraet_id AND g.tenant_id = t.tenant_id
                  JOIN site s ON s.id = g.site_id
                  LEFT JOIN geraet_komponente k ON k.teil_id = t.id AND k.tenant_id = t.tenant_id
                       AND k.gueltig_ab <= now() AND (k.gueltig_bis IS NULL OR k.gueltig_bis > now())
                  LEFT JOIN measurement_point m ON m.id = k.entity_id AND m.site_id = g.site_id
                 WHERE g.site_id = ? AND t.teilart = 'energiekarte'
                   AND t.eingebaut_am <= now() AND (t.ausgebaut_am IS NULL OR t.ausgebaut_am > now())
                   AND t.geraet_id IN (SELECT k2.geraet_id FROM geraet_komponente k2
                         WHERE k2.entity_id::text = ANY(string_to_array(?, ','))
                           AND k2.gueltig_ab <= now() AND (k2.gueltig_bis IS NULL OR k2.gueltig_bis > now()))
                 ORDER BY t.geraet_id, t.steckplatz, t.id, k.entity_id
                """, (rs, n) -> new Karte((UUID) rs.getObject(1), (UUID) rs.getObject(2),
                        (Integer) rs.getObject(3), rs.getString(4), (UUID) rs.getObject(5), rs.getString(6)),
                siteId, komponenten);
        return bilde(karten, familie, mapper);
    }

    /** Welche Komponente welchen Kartentyp liest — aus den Kartenpunkten des Plans. */
    static Map<UUID, Integer> familieJeKomponente(List<MeasurementPlan.Entry> plan) {
        Map<UUID, Integer> out = new LinkedHashMap<>();
        Set<UUID> widerspruch = new LinkedHashSet<>();
        for (MeasurementPlan.Entry e : plan) {
            Matcher m = KARTENPUNKT.matcher(e.pointKey());
            if (e.entityId() == null || !m.find()) continue;
            Integer typ = Integer.valueOf(m.group(1));
            Integer bisher = out.putIfAbsent(e.entityId(), typ);
            if (bisher != null && !bisher.equals(typ)) widerspruch.add(e.entityId());
        }
        widerspruch.forEach(out::remove);
        return out;
    }

    /**
     * Die reine Bildungsregel: je Controller ein Registerbild, Karten nach Steckplatz (Karte n =
     * n-te im Registerbild), die Verbindung aller Karten-Komponenten muss übereinstimmen. Ein
     * Controller mit einer Lücke oder einem Widerspruch fällt ganz weg.
     */
    static List<Map<String, Object>> bilde(List<Karte> zeilen, Map<UUID, Integer> familie, ObjectMapper mapper) {
        Map<UUID, List<Karte>> jeController = new LinkedHashMap<>();
        for (Karte k : zeilen) jeController.computeIfAbsent(k.geraetId(), g -> new ArrayList<>()).add(k);
        List<Map<String, Object>> out = new ArrayList<>();
        for (List<Karte> controller : jeController.values()) {
            Map<String, Object> bild = registerbild(controller, familie, mapper);
            if (bild != null) out.add(bild);
        }
        return out;
    }

    private static Map<String, Object> registerbild(List<Karte> zeilen, Map<UUID, Integer> familie,
            ObjectMapper mapper) {
        Map<UUID, List<Karte>> jeKarte = new LinkedHashMap<>();
        for (Karte k : zeilen) jeKarte.computeIfAbsent(k.teilId(), t -> new ArrayList<>()).add(k);
        List<Map<String, Object>> karten = new ArrayList<>();
        Set<Integer> steckplaetze = new LinkedHashSet<>();
        Set<List<Object>> verbindungen = new LinkedHashSet<>();
        UUID anker = null;
        for (List<Karte> teil : jeKarte.values()) {
            Integer steckplatz = teil.getFirst().steckplatz();
            if (steckplatz == null || steckplatz < 1 || steckplatz > 65_535 || !steckplaetze.add(steckplatz)) {
                return null;
            }
            Set<Integer> typen = new LinkedHashSet<>();
            Matcher m = TYP.matcher(teil.getFirst().typ() == null ? "" : teil.getFirst().typ());
            if (m.find()) typen.add(Integer.valueOf(m.group(1)));
            for (Karte k : teil) {
                if (k.entityId() == null) continue;
                if (familie.containsKey(k.entityId())) {
                    typen.add(familie.get(k.entityId()));
                    if (anker == null) anker = k.entityId();
                }
                List<Object> v = verbindung(k.verbindung(), mapper);
                if (v == null) return null;
                verbindungen.add(v);
            }
            if (typen.size() != 1) return null; // unbekannt oder widersprüchlich: nie raten
            Map<String, Object> karte = new LinkedHashMap<>();
            karte.put("steckplatz", steckplatz);
            karte.put("kartentyp", typen.iterator().next());
            karten.add(karte);
        }
        if (anker == null || verbindungen.size() != 1) return null;
        List<Object> v = verbindungen.iterator().next();
        int basisadresse = (Integer) v.get(0);
        if (basisadresse + KOPF + karten.size() * BLOCK > 65_536) return null;
        Map<String, Object> bild = new LinkedHashMap<>();
        bild.put("entity_id", anker);
        bild.put("basisadresse", basisadresse);
        bild.put("funktionscode", v.get(1));
        bild.put("wortfolge", v.get(2));
        bild.put("kartenzahl", karten.size());
        bild.put("karten", karten);
        return bild;
    }

    /** [Basisadresse, Funktionscode, Wortfolge] aus der Verbindung — oder null, wenn eins fehlt. */
    private static List<Object> verbindung(String json, ObjectMapper mapper) {
        if (json == null) return null;
        try {
            JsonNode c = mapper.readTree(json);
            Integer basis = ganz(c.get("base_address"));
            Integer fc = ganz(c.get("function_code"));
            String wortfolge = c.path("word_order").asText("");
            if (basis == null || basis < 0 || basis > 65_535 || fc == null || (fc != 3 && fc != 4)
                    || !(wortfolge.equals("big") || wortfolge.equals("little"))) {
                return null;
            }
            return List.of(basis, fc, wortfolge);
        } catch (Exception e) {
            return null;
        }
    }

    /** Eine ganze Zahl — auch als Text, wie das Auswahlfeld der Vorlage sie speichert („3“). */
    private static Integer ganz(JsonNode n) {
        if (n == null || n.isNull()) return null;
        if (n.isIntegralNumber()) return n.intValue();
        if (n.isTextual() && n.asText().matches("\\d{1,5}")) return Integer.valueOf(n.asText());
        return null;
    }
}
