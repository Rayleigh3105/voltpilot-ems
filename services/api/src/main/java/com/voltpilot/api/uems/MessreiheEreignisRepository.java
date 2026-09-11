package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.EreignisVokabular.Art;
import com.voltpilot.api.uems.EreignisVokabular.Grund;
import com.voltpilot.api.uems.EreignisVokabular.Urheber;
import com.voltpilot.api.uems.EreignisVokabular.Urteil;
import com.voltpilot.api.uems.EreignisVokabular.Zeitform;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * Der Schreibweg der api in die Ereignis-Tabelle {@code messreihe_ereignis} (UEMS AP-07 IP-8,
 * Migration V20260911260000): EIN Ereignis des Vertrags ({@code events-vocabulary.md}) wird
 * geprüft und angehängt — nie geändert, nie gelöscht.
 *
 * <p>Für die Cloud-Ereignisse, die die api selbst feststellt (Gerätegrenze AP-04, Übergabe
 * AP-06); die Dienste mit Redpanda schreiben über {@code events.raw}, das der Writer mit
 * seinem Zwilling derselben Regeln anhängt. Noch ruft niemand an — dieses Paket baut nur den
 * Weg.
 *
 * <ol>
 *   <li><b>Vertrag:</b> {@link EreignisVokabular#pruefe} — verworfen mit dessen Grund, nie
 *       geraten.
 *   <li><b>Wiederholung:</b> steht dieselbe Meldung schon da (gleich nach {@link
 *       EreignisVokabular#gleich}), passiert nichts.
 *   <li><b>Fortschreibung:</b> gibt es schon Meldungen derselben {@code ereignis_id}, muss die
 *       neue die jüngste nach {@link EreignisVokabular#pruefeFortschreibung} fortschreiben (vom
 *       selben Urheber) — sonst {@code fortschreibung_unzulaessig}. Sie wird eine WEITERE Zeile.
 *   <li><b>Bezug:</b> die Kennungen stehen wörtlich in {@code kennungen}; aufgelöst wird nur,
 *       was eindeutig ist — die UUID-Form wörtlich (das Objekt darf inzwischen gelöscht sein:
 *       Ereignisse überleben es), {@code DQ-n} über {@code data_source.kennzeichen},
 *       {@code MS-n} über {@code messstelle_kennzeichen}; sonst bleibt die Spalte leer.
 * </ol>
 *
 * <p>Die Datenbank hält dieselben Rahmen-Regeln noch einmal (CHECKs aus {@code
 * messreihe_ereignis_vokabular()}) und den Idempotenz-Schlüssel ({@code meldung}); der Zaun ist
 * RLS — der Kundenbereich kommt aus dem Aufrufer und muss der der Sitzung sein.
 */
@Repository
public class MessreiheEreignisRepository {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern UUID_FORM =
            Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
    private static final List<String> KENNUNGEN = List.of("box", "datenquelle", "komponente", "messstelle");
    private static final List<String> KEIN_NUTZFELD = List.of("ereignis_id", "art", "zeitpunkt", "von",
            "bis", "box", "datenquelle", "komponente", "messkanal", "messstelle");

    private final JdbcTemplate jdbc;

    public MessreiheEreignisRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Wie es ausging: angehängt, schon da, oder verworfen mit dem Grund des Vertrags. */
    public enum Ausgang { ANGEHAENGT, WIEDERHOLUNG, VERWORFEN }

    public record Ergebnis(Ausgang ausgang, Grund grund, String hinweis) {
        static final Ergebnis ANGEHAENGT = new Ergebnis(Ausgang.ANGEHAENGT, null, null);
        static final Ergebnis WIEDERHOLUNG = new Ergebnis(Ausgang.WIEDERHOLUNG, null, null);

        static Ergebnis verworfen(Urteil u) {
            return new Ergebnis(Ausgang.VERWORFEN, u.grund(), u.hinweis());
        }
    }

    /**
     * Hängt ein Ereignis an. {@code siteId} (Anlage) und {@code geraetId} (Gerät-Einbau) sind
     * Herkunft und dürfen fehlen; {@code eingang} fehlt, wenn die Eingangszeit der Augenblick
     * des Anhängens ist.
     */
    @Transactional
    public Ergebnis anhaengen(UUID tenantId, UUID siteId, Urheber urheber, JsonNode ereignis,
            UUID geraetId, Instant eingang) {
        Urteil urteil = EreignisVokabular.pruefe(ereignis, urheber);
        if (!urteil.angenommen()) {
            return Ergebnis.verworfen(urteil);
        }
        UUID ereignisId = UUID.fromString(ereignis.get("ereignis_id").asText());
        // Meldungen desselben Ereignisses nacheinander: „schon da?“ und „anhängen“ in einem Zug.
        jdbc.queryForList("SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(?, 0))",
                Integer.class, "messreihe_ereignis:" + tenantId + ":" + ereignisId);
        List<Gespeichert> vorher = meldungen(tenantId, ereignisId);
        for (Gespeichert g : vorher) {
            if (g.urheber().equals(urheber.code()) && EreignisVokabular.gleich(g.ereignis(), ereignis)) {
                return Ergebnis.WIEDERHOLUNG;
            }
        }
        if (!vorher.isEmpty()) {
            Gespeichert juengste = vorher.get(vorher.size() - 1);
            Urteil f = !juengste.urheber().equals(urheber.code())
                    ? new Urteil(false, Grund.FORTSCHREIBUNG_UNZULAESSIG, "anderer Urheber")
                    : EreignisVokabular.pruefeFortschreibung(juengste.ereignis(), ereignis, urheber);
            if (!f.angenommen()) {
                return Ergebnis.verworfen(f);
            }
        }
        return einfuegen(tenantId, siteId, urheber, ereignis, geraetId, eingang) > 0
                ? Ergebnis.ANGEHAENGT : Ergebnis.WIEDERHOLUNG;
    }

    /**
     * Die Meldungen EINES Ereignisses in der Form des Vertrags, erste zuerst — die jüngste ist
     * sein Stand. Zeilen des Bestandswegs haben keine Vertragsform und stehen hier nicht.
     */
    public List<JsonNode> meldungen(UUID ereignisId) {
        return jdbc.query("SELECT " + SPALTEN + " FROM messreihe_ereignis WHERE ereignis_id = ? "
                + "AND NOT aus_bestand ORDER BY eingang, zeit", MessreiheEreignisRepository::map,
                ereignisId).stream().map(Gespeichert::ereignis).toList();
    }

    private List<Gespeichert> meldungen(UUID tenantId, UUID ereignisId) {
        return jdbc.query("SELECT " + SPALTEN + " FROM messreihe_ereignis "
                + "WHERE tenant_id = ? AND ereignis_id = ? AND NOT aus_bestand ORDER BY eingang, zeit",
                MessreiheEreignisRepository::map, tenantId, ereignisId);
    }

    private int einfuegen(UUID tenantId, UUID siteId, Urheber urheber, JsonNode e, UUID geraetId,
            Instant eingang) {
        Art art = Art.vonCode(e.get("art").asText());
        boolean zeitraum = art.zeitform() == Zeitform.ZEITRAUM;
        Instant von = zeitraum ? Instant.parse(e.get("von").asText()) : null;
        Instant bis = zeitraum && e.hasNonNull("bis") ? Instant.parse(e.get("bis").asText()) : null;
        Instant zeit = zeitraum ? von : Instant.parse(e.get("zeitpunkt").asText());
        ObjectNode kennungen = JSON.createObjectNode();
        ObjectNode nutzlast = JSON.createObjectNode();
        e.fields().forEachRemaining(f -> {
            if (KENNUNGEN.contains(f.getKey())) {
                kennungen.set(f.getKey(), f.getValue());
            } else if (!KEIN_NUTZFELD.contains(f.getKey())) {
                nutzlast.set(f.getKey(), f.getValue());
            }
        });
        return jdbc.update("INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, "
                + "von, bis, site_id, kennungen, device_id, data_source_id, entity_id, messkanal, "
                + "messstelle_id, geraet_id, nutzlast, eingang) "
                + "VALUES (?,?,?,?,?,?,?,?,?::jsonb,?,?,?,?,?,?,?::jsonb,COALESCE(?, now())) "
                + "ON CONFLICT DO NOTHING",
                Timestamp.from(zeit), tenantId, UUID.fromString(e.get("ereignis_id").asText()),
                art.code(), urheber.code(), ts(von), ts(bis), siteId, kennungen.toString(),
                uuidForm(e, "box"), datenquelle(e), uuidForm(e, "komponente"),
                e.path("messkanal").asText(null), messstelle(e), geraetId, nutzlast.toString(),
                ts(eingang));
    }

    private UUID datenquelle(JsonNode e) {
        UUID direkt = uuidForm(e, "datenquelle");
        if (direkt != null || !e.has("datenquelle")) {
            return direkt;
        }
        return jdbc.queryForList("SELECT id FROM data_source WHERE kennzeichen = ?", UUID.class,
                e.get("datenquelle").asText()).stream().findFirst().orElse(null);
    }

    private UUID messstelle(JsonNode e) {
        UUID direkt = uuidForm(e, "messstelle");
        if (direkt != null || !e.has("messstelle")) {
            return direkt;
        }
        return jdbc.queryForList("SELECT messstelle_id FROM messstelle_kennzeichen WHERE kennzeichen = ?",
                UUID.class, e.get("messstelle").asText()).stream().findFirst().orElse(null);
    }

    private static UUID uuidForm(JsonNode e, String feld) {
        String w = e.path(feld).asText("");
        return UUID_FORM.matcher(w).matches() ? UUID.fromString(w) : null;
    }

    private static Timestamp ts(Instant t) {
        return t == null ? null : Timestamp.from(t);
    }

    // ---- lesen: eine Zeile zurück in die Form des Vertrags ------------------------------

    private static final String SPALTEN = "ereignis_id, art, urheber, zeit, von, bis, "
            + "kennungen::text AS kennungen, messkanal, nutzlast::text AS nutzlast";

    private record Gespeichert(String urheber, JsonNode ereignis) {}

    private static Gespeichert map(ResultSet rs, int n) throws SQLException {
        ObjectNode e = JSON.createObjectNode();
        e.put("ereignis_id", rs.getObject("ereignis_id", UUID.class).toString());
        String art = rs.getString("art");
        e.put("art", art);
        if (Art.vonCode(art).zeitform() == Zeitform.ZEITRAUM) {
            e.put("von", rs.getTimestamp("von").toInstant().toString());
            Timestamp bis = rs.getTimestamp("bis");
            if (bis == null) {
                e.putNull("bis");
            } else {
                e.put("bis", bis.toInstant().toString());
            }
        } else {
            e.put("zeitpunkt", rs.getTimestamp("zeit").toInstant().toString());
        }
        try {
            e.setAll((ObjectNode) JSON.readTree(rs.getString("kennungen")));
            if (rs.getString("messkanal") != null) {
                e.put("messkanal", rs.getString("messkanal"));
            }
            e.setAll((ObjectNode) JSON.readTree(rs.getString("nutzlast")));
        } catch (JsonProcessingException ex) {
            throw new SQLException("messreihe_ereignis: JSON nicht lesbar", ex);
        }
        return new Gespeichert(rs.getString("urheber"), e);
    }
}
