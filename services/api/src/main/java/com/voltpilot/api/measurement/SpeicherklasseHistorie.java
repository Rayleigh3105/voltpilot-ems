package com.voltpilot.api.measurement;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.LesepfadQuelle;
import com.voltpilot.api.uems.LesepfadQuelle.Quelle;
import com.voltpilot.api.uems.ZeitraumMenge;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Der RÜCKFALL des Lesepfads (UEMS AP-07 IP-14): er liest die Speicherklassen
 * {@code messreihe_viertelstunde} (IP-12/AP-08 IP-2) und {@code messreihe_tag} (IP-13) und
 * macht daraus dieselbe Kurve, die der bestehende Weg aus Rohwerten macht — samt der Herkunft,
 * die dort je Intervall gespeichert ist.
 *
 * <p><b>Wann er gefragt wird:</b> NUR wenn der angefragte Zeitraum über die Rohdaten-Frist
 * hinausreicht UND der bestehende Weg für ihn nichts hergibt ({@link LesepfadQuelle}). Er
 * ERSETZT nichts, was heute schon antwortet.
 *
 * <p><b>Die Reihe ist Mandant + Komponente + Messkanal</b> (AP-07 E2) — Gerät und Box sind
 * Herkunft je Wert, nie Schlüssel. Der Verlauf wird über Gerät + Messwert angefragt; die
 * Komponente kommt aus der Anfrage oder aus der Mess-Selektion und wird nie geraten: ohne sie
 * gibt es keinen Rückfall (und die Antwort bleibt die des bestehenden Wegs).
 *
 * <p><b>Was hier NICHT gerechnet wird:</b> die Menge steht gespeichert da — je Viertelstunde in
 * {@code messreihe_viertelstunde.menge} (AP-08 IP-2), je Tag in {@code messreihe_tag.menge} aus den
 * Periodenständen (AP-08 IP-5) — und wird GELESEN, mit {@code menge_zustand} und {@code kennzeichen}.
 * Ein Raster GRÖBER als die Viertelstunde ist dagegen ein freier Zeitraum je Schritt und wird von
 * {@link ZeitraumMenge#raster} nach der Regel des Vertrags gebildet, NIE als Summe der
 * Viertelstunden: die Summe verlöre den gemessenen Zuwachs über jede Lücke im Schritt (eine
 * Viertelstunde ohne Rohwert hat gar keine Zeile) und wäre schon ohne Lücke eine Summe gerundeter
 * Teilmengen. Ein Tag, der vor IP-5 gebildet wurde, hat keine Menge und bleibt ohne Kurvenwert.
 *
 * <p><b>Die Energie aus Leistung</b> (AP-08 IP-3) reist nur MIT ihrem Kennzeichen „aus Leistung
 * integriert" ({@link MeasurementHistoryService.EnergieAusLeistung}) — sie ist interpoliert und darf
 * nie wie eine gemessene Menge aussehen. Die Datenbank hält das per Prüfregel, dieser Leser genauso.
 */
@Component
public class SpeicherklasseHistorie {

    /** Dieselbe Zeilenbremse wie im bestehenden Verlauf — eine Antwort bleibt zeichenbar. */
    public static final int HOECHSTENS_ZEILEN = 2200;

    /**
     * Die Ereignisarten, die als Marker in den Verlauf gehören (Auftrag IP-14: Lücke,
     * Rücksetzung, Gerätegrenze, Übergabe, Doppelzustellung, Spätankunft; AP-08 IP-4: Überlauf).
     * Alles andere des Vokabulars (§4.8) bleibt draußen — ein Verlauf mit 24 Markerarten erklärt
     * nichts mehr.
     */
    private static final String MARKER_ARTEN =
            "'data_gap','counter_reset','counter_overflow','device_boundary','handover',"
                    + "'duplicate_conflict','late_arrival'";

    /**
     * Die Rücksetzung, die in Wahrheit ein ÜBERLAUF war (AP-08 IP-4): der Bestand kennt das Wort
     * {@code counter_overflow} nicht und schreibt für denselben Sprung weiter {@code counter_reset};
     * der Writer meldet daneben den Überlauf — an derselben Komponente, demselben Messkanal und
     * derselben Messzeit. Gezeigt wird die Writer-Meldung, sonst stünden für EINEN Vorgang zwei
     * widersprüchliche Marken da. Ein Prädikat über {@code device_measurement_event} (Bestand) mit
     * genau einem Parameter: die Komponente der Reihe.
     */
    public static final String RUECKSETZUNG_OHNE_UEBERLAUF = "NOT (event_kind='counter_reset' AND EXISTS ("
            + "SELECT 1 FROM messreihe_ereignis u WHERE u.tenant_id=device_measurement_event.tenant_id "
            + "AND u.entity_id=? AND u.messkanal=device_measurement_event.point_key "
            + "AND u.art='counter_overflow' AND u.zeit=device_measurement_event.occurred_at))";

    private static final ObjectMapper JSON = new ObjectMapper();

    private final JdbcTemplate jdbc;
    private final ZeitraumMenge zeitraum;

    public SpeicherklasseHistorie(JdbcTemplate jdbc, MeasurementCatalog katalog) {
        this.jdbc = jdbc;
        this.zeitraum = new ZeitraumMenge(jdbc, katalog);
    }

    /**
     * Die Komponente der Reihe — aus der Anfrage, sonst aus der Mess-Selektion des Geräts, und
     * nur wenn sie EINDEUTIG ist. Mehrdeutig heißt keine Reihe, nicht „irgendeine".
     */
    public UUID komponente(UUID tenantId, UUID deviceId, String pointKey, UUID ausDerAnfrage) {
        if (ausDerAnfrage != null) {
            return ausDerAnfrage;
        }
        // ⚠ KEIN `SELECT DISTINCT` und kein `GROUP BY`: TimescaleDBs SkipScan bricht darauf
        // mit „unsupported subplan type for SkipScan: Result" ab (2.17.2-pg16, im Test
        // reproduziert). Die Auswahl ist je Gerät und Messwert ohnehin winzig — die
        // Entdopplung gehört hierher, nicht in den Planer.
        List<UUID> gefunden = jdbc.query(
                "SELECT entity_id FROM device_measurement_selection WHERE tenant_id=? "
                        + "AND device_id=? AND " + praedikat("point_key", pointKey)
                        + " AND entity_id IS NOT NULL LIMIT 50",
                (rs, n) -> rs.getObject("entity_id", UUID.class), tenantId, deviceId,
                wert(pointKey));
        List<UUID> eindeutig = gefunden.stream().distinct().toList();
        return eindeutig.size() == 1 ? eindeutig.get(0) : null;
    }

    /**
     * Eine Zeile je Raster-Schritt aus {@code messreihe_viertelstunde}. Das Raster ist nie
     * feiner als die Viertelstunde selbst und nie so fein, dass die Zeilenbremse schneidet.
     *
     * <p>Im Viertelstunden-Raster ist der Schritt die gespeicherte Viertelstunde (Menge, Zustand,
     * Kennzeichen, Energie wie gespeichert). Gröber bildet {@link ZeitraumMenge#raster} je Schritt
     * Menge bzw. Energie mit Zustand und Kennzeichen aus den Periodenständen — je Messkanal; ein
     * Platzhalter über mehrere Kanäle summiert deren Mengen nur, wenn JEDER eine hat, und nennt
     * Zustand, Kennzeichen und Energie nur für genau einen.
     */
    public List<Zeile> viertelstunden(UUID tenantId, UUID entityId, String messkanal, Instant von,
            Instant bis, int rasterS) {
        String sql = "WITH v AS (SELECT * FROM messreihe_viertelstunde WHERE tenant_id=? "
                + "AND entity_id=? AND " + praedikat("messkanal", messkanal)
                + " AND intervall_beginn>=? AND intervall_beginn<=?),"
                + "b AS (SELECT time_bucket(CAST(? AS interval),intervall_beginn) bucket,"
                + "wertart aggregation_kind,"
                // Eine zu kleine Summe wäre eine Behauptung: fehlt EINE Menge, fehlt die Summe. Nur
                // im Viertelstunden-Raster gelesen (EINE Zeile je Kanal) — gröber gilt der Zeitraum.
                + "CASE WHEN count(*)=count(menge) THEN sum(menge) END menge_summe,"
                + "sum(mittel*erhalten)/NULLIF(sum(erhalten),0) avg_value,"
                + "min(min_wert) min_value,max(max_wert) max_value,"
                + "last(letzter_wert,intervall_beginn) last_numeric,"
                + "last(letzter_text,intervall_beginn) last_text,"
                + "sum(erhalten)::bigint samples,bool_or(erhalten<erwartet) has_gap,"
                + "sum(erhalten)::int h_erhalten,sum(erwartet)::int h_erwartet,"
                + "sum(n_good)::int h_good,sum(n_uncertain)::int h_uncertain,"
                + "sum(n_invalid)::int h_invalid,sum(n_stale)::int h_stale,"
                + "sum(n_device_error)::int h_device_error,"
                // Ein Raster-Schritt steht erst fest, wenn JEDE seiner Viertelstunden feststeht.
                + "CASE WHEN bool_and(zustand='endgueltig') THEN 'endgueltig' ELSE 'vorlaeufig' END "
                + "h_zustand,max(endgueltig_ab) h_endgueltig_ab,max(version)::int h_version,"
                + "sum(n_nachgeliefert)::int h_nachgeliefert,"
                + "CASE WHEN count(DISTINCT zustellart)=1 THEN max(zustellart) END h_zustellart,"
                + "max(letzte_eingangszeit) h_eingang,"
                + anker()
                + "(array_agg(stand_anfang ORDER BY intervall_beginn))[1] h_stand_anfang,"
                + "last(stand_ende,intervall_beginn) h_stand_ende,"
                + "CASE WHEN count(*)=1 THEN max(menge_zustand) END h_menge_zustand,"
                + "CASE WHEN count(*)=1 THEN max(kennzeichen::text) END h_kennzeichen,"
                + "CASE WHEN count(*)=1 THEN max(energie) END h_energie,"
                + "array_agg(DISTINCT messkanal) h_kanaele FROM v GROUP BY 1,2) "
                + "SELECT *,CASE WHEN aggregation_kind='counter' THEN menge_summe "
                + "WHEN aggregation_kind='gauge' THEN avg_value ELSE last_numeric END chart_value "
                + "FROM b ORDER BY bucket LIMIT " + HOECHSTENS_ZEILEN;
        List<Map.Entry<Zeile, List<String>>> gelesen = jdbc.query(sql,
                (rs, n) -> Map.entry(zeile(rs, Quelle.VIERTELSTUNDE),
                        List.of((String[]) rs.getArray("h_kanaele").getArray())),
                tenantId, entityId, wert(messkanal), Timestamp.from(von), Timestamp.from(bis),
                rasterS + " seconds");
        if (rasterS <= 900) {
            return gelesen.stream().map(Map.Entry::getKey).toList();
        }
        return ausDemZeitraum(tenantId, entityId, rasterS, gelesen);
    }

    /**
     * Das grobe Raster: Menge bzw. Energie mit Zustand und Kennzeichen je Schritt aus der Regel des
     * Vertrags ({@link ZeitraumMenge#raster}) — alles andere der Zeile (Mittel, Min/Max, Abdeckung,
     * Qualität, Anker) bleibt, wie die Viertelstunden es tragen.
     */
    private List<Zeile> ausDemZeitraum(UUID tenantId, UUID entityId, int rasterS,
            List<Map.Entry<Zeile, List<String>>> gelesen) {
        Map<String, List<Instant>> beginneJeKanal = new LinkedHashMap<>();
        for (Map.Entry<Zeile, List<String>> g : gelesen) {
            if ("counter".equals(g.getKey().wertart()) || "gauge".equals(g.getKey().wertart())) {
                g.getValue().forEach(k -> beginneJeKanal.computeIfAbsent(k, x -> new ArrayList<>())
                        .add(g.getKey().zeit()));
            }
        }
        Map<String, Map<Instant, ZeitraumMenge.Schritt>> schritte = new LinkedHashMap<>();
        beginneJeKanal.forEach((kanal, beginne) ->
                schritte.put(kanal, zeitraum.raster(tenantId, entityId, kanal, beginne, rasterS)));

        List<Zeile> out = new ArrayList<>();
        for (Map.Entry<Zeile, List<String>> g : gelesen) {
            Zeile z = g.getKey();
            if (!"counter".equals(z.wertart()) && !"gauge".equals(z.wertart())) {
                out.add(z);
                continue;
            }
            List<ZeitraumMenge.Schritt> jeKanal = g.getValue().stream()
                    .map(k -> schritte.get(k).get(z.zeit())).toList();
            BigDecimal wert = z.wert();
            if ("counter".equals(z.wertart())) {
                wert = jeKanal.stream().anyMatch(s -> s == null || s.menge() == null) ? null
                        : jeKanal.stream().map(ZeitraumMenge.Schritt::menge)
                                .reduce(BigDecimal.ZERO, BigDecimal::add);
            }
            ZeitraumMenge.Schritt einer = jeKanal.size() == 1 ? jeKanal.get(0) : null;
            out.add(z.mitMenge(wert, einer == null ? null : einer.mengeZustand(),
                    einer == null ? null : einer.kennzeichen(),
                    einer == null ? null : MeasurementHistoryService.EnergieAusLeistung.aus(
                            einer.energie(), einer.kennzeichen())));
        }
        return List.copyOf(out);
    }

    /**
     * Eine Zeile je TAG aus {@code messreihe_tag} — ohne Raster. Ein Tageswert trägt die
     * Zeitzone seines Standorts (23/24/25 Stunden); ihn in ein UTC-Raster zu zwingen, würde
     * Tage zusammenziehen oder zerschneiden. Ein Jahr sind 366 Zeilen, die Bremse greift nie.
     */
    public List<Zeile> tage(UUID tenantId, UUID entityId, String messkanal, Instant von,
            Instant bis) {
        String sql = "SELECT beginn bucket,wertart aggregation_kind,"
                // Die Tagesmenge aus den Periodenständen (AP-08 IP-5), NIE die Summe der
                // Viertelstunden. Ein Tag, der vor IP-5 gebildet wurde, hat keine — und keine Kurve.
                + "menge menge_summe,mittel avg_value,min_wert min_value,"
                + "max_wert max_value,letzter_wert last_numeric,letzter_text last_text,"
                + "erhalten::bigint samples,(erhalten<erwartet) has_gap,"
                + "erhalten h_erhalten,erwartet h_erwartet,n_good h_good,n_uncertain h_uncertain,"
                + "n_invalid h_invalid,n_stale h_stale,n_device_error h_device_error,"
                + "zustand h_zustand,endgueltig_ab h_endgueltig_ab,version h_version,"
                + "n_nachgeliefert h_nachgeliefert,zustellart h_zustellart,"
                + "letzte_eingangszeit h_eingang,geraet_einbau h_geraet,"
                + "geraet_einbau_2 h_geraet_2,box h_box,box_2 h_box_2,fassung h_fassung,"
                + "katalog h_katalog,rolle h_rolle,stand_anfang h_stand_anfang,"
                + "stand_ende h_stand_ende,menge_zustand h_menge_zustand,"
                + "kennzeichen::text h_kennzeichen,energie h_energie,"
                + "CASE WHEN wertart='gauge' THEN mittel "
                + "WHEN wertart='counter' THEN menge ELSE letzter_wert END chart_value "
                + "FROM messreihe_tag WHERE tenant_id=? AND entity_id=? AND "
                + praedikat("messkanal", messkanal) + " AND beginn>=? AND beginn<=? "
                + "ORDER BY beginn LIMIT " + HOECHSTENS_ZEILEN;
        return jdbc.query(sql, (rs, n) -> zeile(rs, Quelle.TAG), tenantId, entityId,
                wert(messkanal), Timestamp.from(von), Timestamp.from(bis));
    }

    /**
     * Eine Zeile je MONAT oder JAHR aus {@code messreihe_periode} (AP-08 IP-5) — für das Lese-Modell
     * je Messstelle (AP-08 IP-9); der Verlauf fragt sie nicht. Die Menge ist die aus den
     * Periodenständen (Monat aus Viertelstunden, Jahr aus Monaten), NIE eine Summe der Tage. Die
     * Periode trägt keine Anker, keine Qualitätszähler und keinen Text — die bleiben leer, nie geraten.
     *
     * @param art {@code monat} oder {@code jahr}
     */
    public List<Zeile> perioden(UUID tenantId, UUID entityId, String messkanal, String art, Instant von,
            Instant bis) {
        if (!"monat".equals(art) && !"jahr".equals(art)) {
            throw new IllegalArgumentException("eine Periode ist ein Monat oder ein Jahr: " + art);
        }
        String sql = "SELECT beginn bucket,wertart aggregation_kind,"
                + "min_wert min_value,max_wert max_value,NULL::text last_text,"
                + "erhalten::bigint samples,(erhalten<erwartet) has_gap,"
                + "erhalten h_erhalten,erwartet h_erwartet,NULL::int h_good,NULL::int h_uncertain,"
                + "NULL::int h_invalid,NULL::int h_stale,NULL::int h_device_error,"
                + "zustand h_zustand,endgueltig_ab h_endgueltig_ab,version h_version,"
                + "n_nachgeliefert h_nachgeliefert,NULL::text h_zustellart,NULL::timestamptz h_eingang,"
                + "NULL::uuid h_geraet,NULL::uuid h_geraet_2,NULL::uuid h_box,NULL::uuid h_box_2,"
                + "NULL::bigint h_fassung,NULL::text h_katalog,NULL::text h_rolle,"
                + "stand_anfang h_stand_anfang,stand_ende h_stand_ende,menge_zustand h_menge_zustand,"
                + "kennzeichen::text h_kennzeichen,energie h_energie,"
                + "CASE WHEN wertart='gauge' THEN mittel WHEN wertart='counter' THEN menge END chart_value "
                + "FROM messreihe_periode WHERE tenant_id=? AND entity_id=? AND messkanal=? AND art=? "
                + "AND beginn>=? AND beginn<? ORDER BY beginn LIMIT " + HOECHSTENS_ZEILEN;
        // `quelle` bleibt leer: sie ist ein Wort der Quellenwahl des Verlaufs (LesepfadQuelle), und
        // die wählt Monat und Jahr nie.
        return jdbc.query(sql, (rs, n) -> zeile(rs, null), tenantId, entityId, messkanal, art,
                Timestamp.from(von), Timestamp.from(bis));
    }

    /**
     * Die Ereignisse der Reihe als VERWEISE (AP-08 IP-9): je Ereignis seine Kennung, Art und Zeit —
     * ungebündelt, damit ein Wert sagen kann, WELCHE Meldung ihn erklärt; der Inhalt bleibt im
     * Ereignis-Vertrag. Dieselben Arten und dieselben drei Fallen wie {@link #ereignisse}
     * ({@code aus_bestand} draußen, eine Fortschreibung ist kein zweites Ereignis, die Rücksetzung
     * eines Überlaufs ist dieser Überlauf) und derselbe zweite Zweig für die Übergabe an der Datenquelle.
     */
    public List<Verweis> ereignisVerweise(UUID tenantId, UUID entityId, String messkanal, Instant von,
            Instant bis) {
        String sql = "WITH e AS (SELECT DISTINCT ON (ereignis_id) ereignis_id,art,"
                + "zeit beginn,bis,entity_id,messkanal FROM messreihe_ereignis WHERE tenant_id=? "
                + "AND NOT aus_bestand AND art IN (" + MARKER_ARTEN + ") AND ("
                + "(entity_id=? AND (messkanal IS NULL OR messkanal=?)) OR (entity_id IS NULL AND "
                + "data_source_id=(SELECT data_source_id FROM measurement_point WHERE tenant_id=? AND id=?))) "
                + "AND zeit<=? AND COALESCE(bis,zeit)>=? "
                + "ORDER BY ereignis_id,eingang DESC) "
                + "SELECT ereignis_id,art,beginn,bis FROM e WHERE NOT (e.art='counter_reset' AND EXISTS ("
                + "SELECT 1 FROM messreihe_ereignis u WHERE u.tenant_id=? AND u.entity_id=e.entity_id "
                + "AND u.messkanal=e.messkanal AND u.art='counter_overflow' AND u.zeit=e.beginn)) "
                + "ORDER BY beginn,ereignis_id LIMIT " + HOECHSTENS_ZEILEN;
        return jdbc.query(sql, (rs, n) -> new Verweis(rs.getObject("ereignis_id", UUID.class), rs.getString("art"),
                        rs.getTimestamp("beginn").toInstant(), instant(rs, "bis")),
                tenantId, entityId, messkanal, tenantId, entityId, Timestamp.from(bis), Timestamp.from(von), tenantId);
    }

    /** Der Verweis auf ein Ereignis: Kennung, Art, Beginn und — bei einem Zeitraum — Ende. */
    public record Verweis(UUID ereignisId, String art, Instant von, Instant bis) {}

    /**
     * Welche dieser Spannen schon Rohwerte oder Viertelstunden der Reihe tragen (AP-08 IP-9): eine
     * Periode OHNE gespeicherte Zeile ist nur dann „keine Werte“, wenn auch darunter nichts liegt —
     * sonst ist sie noch nicht gebildet (der nächste Lauf kommt). Ein Spiegel-Rohwert zählt nicht
     * (der Viertelstunden-Lauf liest ihn auch nicht). Eine Abfrage für alle Spannen.
     *
     * @return die Beginne der Spannen, unter denen etwas liegt
     */
    public List<Instant> mitDaten(UUID tenantId, UUID entityId, String messkanal, List<Instant> beginne,
            List<Instant> enden) {
        if (beginne.isEmpty()) {
            return List.of();
        }
        return jdbc.query(con -> {
            var ps = con.prepareStatement("SELECT s.von FROM unnest(?::timestamptz[], ?::timestamptz[]) AS s(von, bis) "
                    + "WHERE EXISTS (SELECT 1 FROM messreihe_viertelstunde v WHERE v.tenant_id=? AND v.entity_id=? "
                    + "AND v.messkanal=? AND v.intervall_beginn>=s.von AND v.intervall_beginn<s.bis) "
                    + "OR EXISTS (SELECT 1 FROM device_measurement_sample r WHERE r.tenant_id=? AND r.entity_id=? "
                    + "AND r.point_key=? AND r.time>=s.von AND r.time<s.bis AND r.role IS DISTINCT FROM 'spiegel') "
                    + "ORDER BY s.von");
            ps.setArray(1, con.createArrayOf("timestamptz", beginne.stream().map(Timestamp::from).toArray()));
            ps.setArray(2, con.createArrayOf("timestamptz", enden.stream().map(Timestamp::from).toArray()));
            ps.setObject(3, tenantId);
            ps.setObject(4, entityId);
            ps.setString(5, messkanal);
            ps.setObject(6, tenantId);
            ps.setObject(7, entityId);
            ps.setString(8, messkanal);
            return ps;
        }, (rs, n) -> rs.getTimestamp(1).toInstant());
    }

    /**
     * Die Ereignisse der Reihe als GEBÜNDELTE Marken: je Art und Raster-Schritt eine Marke mit
     * ihrer Anzahl — damit ein Sprung in der Kurve erklärbar ist, ohne dass eine Flut von
     * Einzelmarken die Kurve zudeckt.
     *
     * <p>Drei Fallen sind hier eingebaut: {@code aus_bestand} bleibt draußen (das sind die
     * gespiegelten Zeilen aus {@code device_measurement_event}, die der bestehende Marker-Weg
     * schon zeigt — sonst stünde jede Lücke doppelt), eine Fortschreibung ist KEIN zweites
     * Ereignis (append-only, gleiche {@code ereignis_id}, jüngste Zeile gewinnt), und eine
     * Rücksetzung, für die an derselben Messzeit ein Überlauf gemeldet ist, IST dieser Überlauf
     * (dieselbe Regel wie {@link #RUECKSETZUNG_OHNE_UEBERLAUF} im Bestands-Weg).
     */
    public List<Ereignis> ereignisse(UUID tenantId, UUID entityId, String messkanal, Instant von,
            Instant bis, int rasterS) {
        // Die Übergabe (`handover`) hängt am Vertrag ausdrücklich an der DATENQUELLE und darf
        // gar keine Komponente nennen (§4.8) — sie käme über `entity_id` nie an. Darum der
        // zweite Zweig: Ereignisse ohne Reihen-Bezug, die an der Datenquelle DIESER Komponente
        // hängen. Ohne Datenquelle an der Komponente trifft er nichts (NULL ist nie wahr).
        // `zeit` IST der Beginn: der Vertrag verlangt `zeit = von`, wo es ein `von` gibt
        // (messreihe_ereignis_zeit_erlaubt). Darum kein COALESCE in der Bedingung — sonst
        // liefe die Abfrage an den Indizes `idx_messreihe_ereignis_reihe` und
        // `…_quelle` vorbei, die IP-8 genau für diesen Leser gebaut hat.
        String sql = "WITH e AS (SELECT DISTINCT ON (ereignis_id) ereignis_id,art,"
                + "zeit beginn,bis,entity_id,messkanal,nutzlast FROM messreihe_ereignis WHERE tenant_id=? "
                + "AND NOT aus_bestand AND art IN (" + MARKER_ARTEN + ") AND ("
                + "(entity_id=? AND (messkanal IS NULL OR " + praedikat("messkanal", messkanal)
                + ")) OR (entity_id IS NULL AND data_source_id=(SELECT data_source_id "
                + "FROM measurement_point WHERE tenant_id=? AND id=?))) "
                + "AND zeit<=? AND COALESCE(bis,zeit)>=? "
                + "ORDER BY ereignis_id,eingang DESC) "
                + "SELECT art,min(beginn) beginn,max(COALESCE(bis,beginn)) ende,count(*) anzahl,"
                + "CASE WHEN count(*)=1 THEN (array_agg(nutzlast))[1] END nutzlast "
                + "FROM e WHERE NOT (e.art='counter_reset' AND EXISTS (SELECT 1 FROM messreihe_ereignis u "
                + "WHERE u.tenant_id=? AND u.entity_id=e.entity_id AND u.messkanal=e.messkanal "
                + "AND u.art='counter_overflow' AND u.zeit=e.beginn)) "
                + "GROUP BY art,time_bucket(CAST(? AS interval),beginn) "
                + "ORDER BY 2 LIMIT 200";
        return jdbc.query(sql, (rs, n) -> new Ereignis(rs.getString("art"),
                        rs.getTimestamp("beginn").toInstant(),
                        rs.getTimestamp("ende") == null ? null : rs.getTimestamp("ende").toInstant(),
                        rs.getInt("anzahl"), zuwachs(rs.getString("art"), rs.getString("nutzlast"))),
                tenantId, entityId, wert(messkanal), tenantId, entityId, Timestamp.from(bis),
                Timestamp.from(von), tenantId, rasterS + " seconds");
    }

    /** Die je Wert GESPEICHERTEN Katalogfassungen des Zeitraums — nie die heutige. */
    public List<String> katalogfassungen(List<Zeile> zeilen) {
        List<String> out = new ArrayList<>();
        for (Zeile z : zeilen) {
            if (z.katalogVersion() != null && !out.contains(z.katalogVersion())) {
                out.add(z.katalogVersion());
            }
        }
        return List.copyOf(out);
    }

    // ====================================================================== innere Hilfen

    /** Herkunfts-Anker: EIN Wert, wenn alle Intervalle denselben nennen — sonst leer, nie geraten. */
    private static String anker() {
        return "(CASE WHEN count(DISTINCT geraet_einbau)=1 THEN max(geraet_einbau::text) END)::uuid "
                + "h_geraet,(CASE WHEN count(DISTINCT geraet_einbau_2)=1 "
                + "THEN max(geraet_einbau_2::text) END)::uuid h_geraet_2,"
                + "(CASE WHEN count(DISTINCT box)=1 THEN max(box::text) END)::uuid h_box,"
                + "(CASE WHEN count(DISTINCT box_2)=1 THEN max(box_2::text) END)::uuid h_box_2,"
                + "CASE WHEN count(DISTINCT fassung)=1 THEN max(fassung) END h_fassung,"
                + "CASE WHEN count(DISTINCT katalog)=1 THEN max(katalog) END h_katalog,"
                + "CASE WHEN count(DISTINCT rolle)=1 THEN max(rolle) END h_rolle,";
    }

    private static Zeile zeile(ResultSet rs, Quelle quelle) throws SQLException {
        List<String> kennzeichen = kennzeichen(rs.getString("h_kennzeichen"));
        Integer erhalten = nullableInt(rs, "h_erhalten");
        Integer erwartet = nullableInt(rs, "h_erwartet");
        return new Zeile(rs.getTimestamp("bucket").toInstant(), rs.getBigDecimal("chart_value"),
                rs.getBigDecimal("min_value"), rs.getBigDecimal("max_value"),
                rs.getString("last_text"), rs.getLong("samples"), rs.getBoolean("has_gap"),
                quelle, rs.getString("aggregation_kind"), abdeckung(erhalten, erwartet), erhalten,
                erwartet, nullableInt(rs, "h_good"), nullableInt(rs, "h_uncertain"),
                nullableInt(rs, "h_invalid"), nullableInt(rs, "h_stale"),
                nullableInt(rs, "h_device_error"), rs.getString("h_zustand"),
                instant(rs, "h_endgueltig_ab"), nullableInt(rs, "h_version"),
                nullableInt(rs, "h_nachgeliefert"), rs.getString("h_zustellart"),
                instant(rs, "h_eingang"), rs.getObject("h_geraet", UUID.class),
                rs.getObject("h_geraet_2", UUID.class), rs.getObject("h_box", UUID.class),
                rs.getObject("h_box_2", UUID.class), nullableLong(rs, "h_fassung"),
                rs.getString("h_katalog"), rs.getString("h_rolle"),
                rs.getBigDecimal("h_stand_anfang"), rs.getBigDecimal("h_stand_ende"),
                rs.getString("h_menge_zustand"), kennzeichen, MeasurementHistoryService.EnergieAusLeistung
                        .aus(rs.getBigDecimal("h_energie"), kennzeichen));
    }

    /** Die gespeicherten Kennzeichen (jsonb-Array von Sätzen) — {@code null}, wo keine gelesen sind. */
    private static List<String> kennzeichen(String json) {
        if (json == null) {
            return null;
        }
        try {
            List<String> aus = new ArrayList<>();
            JSON.readTree(json).forEach(n -> aus.add(n.asText()));
            return List.copyOf(aus);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Kennzeichen sind kein JSON-Array: " + json, e);
        }
    }

    /**
     * Abdeckung in Prozent — und NIE auf 100 gerundet (§4.9 Nr. 6). 100 steht nur da, wo
     * wirklich jeder erwartete Wert angekommen ist.
     */
    public static Integer abdeckung(Integer erhalten, Integer erwartet) {
        if (erhalten == null || erwartet == null || erwartet <= 0) {
            return null;
        }
        if (erhalten >= erwartet) {
            return 100;
        }
        return Math.min(99, (int) Math.floor(100.0 * erhalten / erwartet));
    }

    private static Integer nullableInt(ResultSet rs, String name) throws SQLException {
        int wert = rs.getInt(name);
        return rs.wasNull() ? null : wert;
    }

    private static Long nullableLong(ResultSet rs, String name) throws SQLException {
        long wert = rs.getLong(name);
        return rs.wasNull() ? null : wert;
    }

    private static Instant instant(ResultSet rs, String name) throws SQLException {
        Timestamp t = rs.getTimestamp(name);
        return t == null ? null : t.toInstant();
    }

    /** Dieselbe Behandlung des Platzhalters {@code [*]} wie im bestehenden Verlauf. */
    private static String praedikat(String spalte, String messkanal) {
        return messkanal != null && messkanal.contains("[*]")
                ? spalte + " LIKE ? ESCAPE '\\'" : spalte + "=?";
    }

    private static String wert(String messkanal) {
        if (messkanal == null || !messkanal.contains("[*]")) {
            return messkanal;
        }
        return messkanal.replace("\\", "\\\\").replace("%", "\\%")
                .replace("_", "\\_").replace("[*]", "[%]");
    }

    /** Eine gelesene Zeile einer Speicherklasse — Kurvenwert UND Herkunft in einem. */
    public record Zeile(Instant zeit, BigDecimal wert, BigDecimal minimum, BigDecimal maximum,
            String text, long anzahl, boolean luecke, Quelle quelle, String wertart,
            Integer abdeckungProzent, Integer erhalten, Integer erwartet, Integer nGood,
            Integer nUncertain, Integer nInvalid, Integer nStale, Integer nDeviceError,
            String zustand, Instant endgueltigAb, Integer version, Integer nachgeliefert,
            String zustellart, Instant letzteEingangszeit, UUID geraetEinbau,
            UUID geraetEinbauZwei, UUID box, UUID boxZwei, Long fassung, String katalogVersion,
            String rolle, BigDecimal standAnfang, BigDecimal standEnde, String mengeZustand,
            List<String> kennzeichen, MeasurementHistoryService.EnergieAusLeistung energie) {

        /** Dieselbe Zeile mit Kurvenwert, Zustand, Kennzeichen und Energie aus dem Zeitraum. */
        Zeile mitMenge(BigDecimal neuerWert, String neuerZustand, List<String> neueKennzeichen,
                MeasurementHistoryService.EnergieAusLeistung neueEnergie) {
            return new Zeile(zeit, neuerWert, minimum, maximum, text, anzahl, luecke, quelle, wertart,
                    abdeckungProzent, erhalten, erwartet, nGood, nUncertain, nInvalid, nStale,
                    nDeviceError, zustand, endgueltigAb, version, nachgeliefert, zustellart,
                    letzteEingangszeit, geraetEinbau, geraetEinbauZwei, box, boxZwei, fassung,
                    katalogVersion, rolle, standAnfang, standEnde, neuerZustand, neueKennzeichen,
                    neueEnergie);
        }
    }

    /**
     * AP-08 IP-6 — der gemessene Zuwachs einer EINZELNEN Lücke, wie ihre Meldung ihn trägt; sonst
     * {@code null}. Eine Lücke, in die nach dem Schließen nachgeliefert wurde, zeigt ihn nicht: dort
     * sind Teile verteilbar geworden, und was noch Lücke ist, sagt das Kennzeichen der Periode.
     */
    private static Zuwachs zuwachs(String art, String nutzlast) {
        if (!"data_gap".equals(art) || nutzlast == null) {
            return null;
        }
        try {
            JsonNode n = JSON.readTree(nutzlast);
            if (!n.hasNonNull("zuwachs") || !n.hasNonNull("einheit") || n.hasNonNull("nachgeliefert_am")) {
                return null;
            }
            return new Zuwachs(n.get("zuwachs").decimalValue(), n.get("einheit").asText());
        } catch (JsonProcessingException e) {
            return null;
        }
    }

    /** Der gemessene, nicht verteilbare Zuwachs über eine Lücke (AP-08 IP-6). */
    public record Zuwachs(BigDecimal menge, String einheit) {}

    /** Ein gebündeltes Ereignis des Zeitraums; {@code zuwachs} nur an einer einzelnen Lücke. */
    public record Ereignis(String art, Instant von, Instant bis, int anzahl, Zuwachs zuwachs) {
        /** Die Form von VOR AP-08 IP-6. */
        public Ereignis(String art, Instant von, Instant bis, int anzahl) {
            this(art, von, bis, anzahl, null);
        }
    }
}
