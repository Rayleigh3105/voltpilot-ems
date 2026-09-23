package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.sql.Connection;
import java.sql.Savepoint;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.stereotype.Component;

/**
 * Der Abruf des Wetter-Archivs (UEMS AP-17 E9 = C, IP-12b): je Gradtagzahl mit {@code bezugsgroesse_wetterbezug}
 * holt VoltPilot die Tagesmittel des Standorts über seine Koordinaten und schreibt Gradtage (G20/15 über
 * {@link GradtagRegeln}) mit der Herkunft {@code bezogen} und dem Kennzeichen „Temperatur von VoltPilot bezogen
 * (Quelle, Abrufzeit)“.
 *
 * <ul>
 *   <li><b>Nur Archiv-Tage bis gestern</b> in der Zone des Standorts — nie heute, nie ein Tag danach, nie Vorhersage
 *       (AP-09 E13).</li>
 *   <li><b>Nachholen:</b> jeder Abruf sucht die fehlenden Tage der letzten {@value #NACHHOLEN_TAGE} Tage (Tagesperiode)
 *       bzw. die Monate, deren letzter Tag darin liegt (Monatsperiode). Ein vorhandener Tag wird nie überschrieben, ein
 *       Tag nie doppelt geschrieben; ein unvollständiger Monat bekommt eine neue Fassung, sobald mehr Tage da sind.</li>
 *   <li><b>Ausfall (LA3):</b> der Tag fehlt — nie 0; der Monat trägt „x von y Tagen“ und {@code unvollständig}; fehlt
 *       der ganze Monat, entsteht keine Zeile (die Variable fehlt). Der nächste Abruf holt nach.</li>
 *   <li><b>Ohne Koordinaten</b> kein Abruf und kein Fehler (Grund {@code variable_fehlt}; der Satz kommt mit IP-12c).</li>
 * </ul>
 * Er wirft nie je Bezugsgröße: ein Fehler rollt nur ihren Zusatz zurück.
 */
@Component
public class WetterArchivAbruf {

    static final int NACHHOLEN_TAGE = 60;
    static final String KENNZEICHEN_ANFANG = WetterArchivRegeln.TEMPERATUR_BEZOGEN;
    private static final Logger log = LoggerFactory.getLogger(WetterArchivAbruf.class);

    private final JdbcTemplate admin;
    private final ObjectMapper json;
    private final WetterArchiv archiv;

    public WetterArchivAbruf(@Qualifier("adminJdbcTemplate") JdbcTemplate admin, ObjectMapper json,
            WetterArchiv archiv) {
        this.admin = admin;
        this.json = json;
        this.archiv = archiv;
    }

    /** Ein Takt: wie viele Bezüge, davon abgerufen, ohne Koordinaten, ausgefallen, gescheitert; geschriebene Werte. */
    public record Lauf(int bezuege, int abgerufen, int ohneKoordinaten, int ausfaelle, int fehler, int geschrieben) {}

    record Bezug(UUID id, UUID tenant, UUID bezug, BigDecimal raum, BigDecimal grenze, LocalDate von, String einheit,
            String periode, BigDecimal breite, BigDecimal laenge, ZoneId zone) {}

    /** Das Kennzeichen jeder bezogenen Zahl — über den Regel-Zwilling des Vertrags (IP-12a). */
    static String kennzeichen(String quelle, Instant abgerufen, ZoneId zone) {
        return WetterArchivRegeln.kennzeichen(quelle, abgerufen.atZone(zone).toOffsetDateTime());
    }

    public Lauf lauf(Instant jetzt) {
        return lauf(jetzt, null);
    }

    /** Nur ein Kundenbereich ({@code null} = alle) — für Prüfungen, die neben anderen Kundenbereichen laufen. */
    Lauf lauf(Instant jetzt, UUID nur) {
        List<Bezug> bezuege = admin.query("""
            SELECT w.id, w.tenant_id, w.bezugsgroesse_id, w.raumtemperatur, w.heizgrenze, w.von, b.einheit,
                   b.periode_art, s.lage_breitengrad, s.lage_laengengrad,
                   coalesce(s.zeitzone, u.zeitzone, 'Europe/Berlin') AS zone
              FROM bezugsgroesse_wetterbezug w JOIN bezugsgroesse b
                ON b.id = w.bezugsgroesse_id AND b.tenant_id = w.tenant_id
              LEFT JOIN standort s ON s.id = b.standort_id AND s.tenant_id = b.tenant_id
              LEFT JOIN unternehmen u ON u.tenant_id = b.tenant_id
             WHERE b.archiviert_am IS NULL AND b.art = 'gradtagzahl' AND b.geltung_art = 'standort'
               AND b.periode_art IN ('tag', 'monat') AND (?::uuid IS NULL OR w.tenant_id = ?)
             ORDER BY w.tenant_id, w.id
            """, (r, n) -> new Bezug(r.getObject("id", UUID.class), r.getObject("tenant_id", UUID.class),
                r.getObject("bezugsgroesse_id", UUID.class), r.getBigDecimal("raumtemperatur"),
                r.getBigDecimal("heizgrenze"), r.getObject("von", LocalDate.class), r.getString("einheit"),
                r.getString("periode_art"), r.getBigDecimal("lage_breitengrad"), r.getBigDecimal("lage_laengengrad"),
                ZoneId.of(r.getString("zone"))), nur, nur);
        int abgerufen = 0, ohne = 0, ausfaelle = 0, fehler = 0, geschrieben = 0;
        for (Bezug b : bezuege) {
            if (b.breite() == null || b.laenge() == null) {
                ohne++;
                continue;
            }
            try {
                Integer[] ergebnis = admin.execute((Connection con) -> {
                    boolean auto = con.getAutoCommit();
                    con.setAutoCommit(false);
                    Savepoint punkt = con.setSavepoint();
                    try {
                        JdbcTemplate j = new JdbcTemplate(new SingleConnectionDataSource(con, true));
                        j.execute("SELECT pg_advisory_xact_lock(hashtextextended('bezugswetter:" + b.tenant() + ":"
                                + b.bezug() + "',0))");
                        Integer[] n = bilde(j, b, jetzt);
                        con.releaseSavepoint(punkt);
                        con.commit();
                        return n;
                    } catch (Exception e) {
                        con.rollback(punkt);
                        con.commit();
                        throw new IllegalStateException(e);
                    } finally {
                        con.setAutoCommit(auto);
                    }
                });
                if (ergebnis[0] > 0) abgerufen++;
                if (ergebnis[1] > 0) ausfaelle++;
                geschrieben += ergebnis[2];
            } catch (RuntimeException e) {
                fehler++;
                log.warn("UEMS Wetter-Archiv: Bezug {} fehlgeschlagen, Zusatz zurückgerollt: {}", b.id(),
                        org.springframework.core.NestedExceptionUtils.getMostSpecificCause(e).toString());
            }
        }
        return new Lauf(bezuege.size(), abgerufen, ohne, ausfaelle, fehler, geschrieben);
    }

    /** {abgerufen 0/1, ausgefallen 0/1, geschriebene Werte}. */
    private Integer[] bilde(JdbcTemplate j, Bezug b, Instant jetzt) throws Exception {
        LocalDate gestern = jetzt.atZone(b.zone()).toLocalDate().minusDays(1);
        LocalDate fenster = gestern.minusDays(NACHHOLEN_TAGE - 1);
        Map<LocalDate, Map<String, Object>> vorhanden = new HashMap<>();
        for (Map<String, Object> z : j.queryForList("SELECT DISTINCT ON (periode_von) periode_von, fassung, betrag, "
                + "herkunft_art, bezug_herkunft::text AS bezug FROM bezugsgroesse_wert WHERE tenant_id = ? "
                + "AND bezugsgroesse_id = ? AND periode_von >= ? ORDER BY periode_von, fassung DESC",
                b.tenant(), b.bezug(), fenster.withDayOfMonth(1))) {
            vorhanden.put(((java.sql.Date) z.get("periode_von")).toLocalDate(), z);
        }
        // Welche Perioden fehlen: Tage ab `von`, im Fenster, bis gestern — Monate, die ganz vorbei sind.
        List<LocalDate[]> perioden = new ArrayList<>();
        if ("tag".equals(b.periode())) {
            for (LocalDate t = fenster.isBefore(b.von()) ? b.von() : fenster; !t.isAfter(gestern); t = t.plusDays(1)) {
                if (!vorhanden.containsKey(t)) perioden.add(new LocalDate[] {t, t});
            }
        } else {
            for (LocalDate m = fenster.withDayOfMonth(1); !m.plusMonths(1).minusDays(1).isAfter(gestern);
                    m = m.plusMonths(1)) {
                LocalDate ende = m.plusMonths(1).minusDays(1);
                if (ende.isBefore(fenster) || ende.isBefore(b.von())) continue;
                Map<String, Object> alt = vorhanden.get(m);
                if (alt != null && (!WetterArchivRegeln.HERKUNFT.equals(alt.get("herkunft_art"))
                        || "vollständig".equals(json.readTree((String) alt.get("bezug")).path("zustand").asText()))) {
                    continue;
                }
                perioden.add(new LocalDate[] {m, ende});
            }
        }
        if (perioden.isEmpty()) return new Integer[] {0, 0, 0};
        LocalDate von = perioden.get(0)[0];
        LocalDate bis = perioden.get(perioden.size() - 1)[1];
        WetterArchiv.Abruf abruf = archiv.tagesmittel(b.breite(), b.laenge(), von, bis, b.zone());
        if (abruf == null || abruf.ausfall() != null) {
            log.warn("UEMS Wetter-Archiv: Ausfall für Bezug {} ({} … {}): {}", b.id(), von, bis,
                    abruf == null ? "keine Antwort" : abruf.ausfall());
            return new Integer[] {1, 1, 0};
        }
        String kz = kennzeichen(abruf.quelle(), abruf.abgerufen(), b.zone());
        int geschrieben = 0;
        for (LocalDate[] p : perioden) {
            List<GradtagRegeln.Tag> tage = new ArrayList<>();
            int da = 0, erwartet = 0;
            for (LocalDate t = p[0]; !t.isAfter(p[1]); t = t.plusDays(1)) {
                // Nie ein Tag nach gestern — auch wenn die Quelle ihn mitschickt.
                BigDecimal mittel = t.isAfter(gestern) ? null : abruf.tagesmittel().get(t);
                erwartet++;
                if (mittel != null) da++;
                tage.add(new GradtagRegeln.Tag(mittel,
                        mittel == null ? VerbrauchRegeln.KEINE_WERTE : VerbrauchRegeln.VOLLSTAENDIG));
            }
            if (da == 0) continue; // der Tag / der ganze Monat fehlt: keine Zeile, nie 0
            Map<String, Object> alt = vorhanden.get(p[0]);
            if (alt != null && da <= json.readTree((String) alt.get("bezug")).path("tage").asInt()) continue;
            GradtagRegeln.Ergebnis g = GradtagRegeln.gradtage(tage, b.raum(), b.grenze());
            boolean voll = da == erwartet;
            List<String> kennzeichen = new ArrayList<>(g.kennzeichen());
            kennzeichen.add(kz);
            if (!voll) kennzeichen.add(da + " von " + erwartet + " " + WetterArchivRegeln.WORT_TAGE);
            ObjectNode herkunft = json.createObjectNode().put("breitengrad", b.breite()).put("laengengrad", b.laenge())
                    .put("regel", GradtagRegeln.regel(b.raum(), b.grenze()))
                    .put("zustand", voll ? VerbrauchRegeln.VOLLSTAENDIG : VerbrauchRegeln.UNVOLLSTAENDIG)
                    .put("tage", da).put("tage_erwartet", erwartet);
            if (p[0].equals(p[1])) herkunft.put("tagesmittel", abruf.tagesmittel().get(p[0]));
            int f = alt == null ? 1 : ((Number) alt.get("fassung")).intValue() + 1;
            j.update("INSERT INTO bezugsgroesse_wert (tenant_id,bezugsgroesse_id,wertart,einheit,periode_art,"
                    + "periode_von,periode_bis,zeitzone,fassung,ersetzt_fassung,vorgang,status,betrag,begruendung,"
                    + "herkunft_art,kennzeichen,actor_name,actor_art,bezug_quelle,abgerufen_am,bezug_herkunft) "
                    + "VALUES (?,?,'periodenwert',?,?,?,?,?,?,?,?,'wirksam',?,?,'bezogen',?::jsonb,'Wetter-Archiv',"
                    + "'voltpilot',?,?,?::jsonb)",
                    b.tenant(), b.bezug(), b.einheit(), b.periode(), p[0], p[1], b.zone().getId(), f,
                    f == 1 ? null : f - 1, f == 1 ? "erstwert" : "berichtigung",
                    g.betrag().setScale(6, RoundingMode.HALF_UP),
                    f == 1 ? null : "Wetter-Archiv: fehlende Tage nachgeholt (" + da + " von " + erwartet + " Tagen).",
                    json.writeValueAsString(kennzeichen.stream().distinct().toList()), abruf.quelle(),
                    java.sql.Timestamp.from(abruf.abgerufen()), herkunft.toString());
            geschrieben++;
        }
        return new Integer[] {1, 0, geschrieben};
    }
}
