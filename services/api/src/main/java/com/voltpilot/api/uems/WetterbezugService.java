package com.voltpilot.api.uems;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.*;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Der Schreibweg zum Wetter-Archiv (UEMS AP-17 E9 = C, IP-12c): eine Gradtagzahl am Standort wird an das Archiv
 * gebunden ({@code bezugsgroesse_wetterbezug}, G20/15 und {@code von}) oder gelöst — die bezogenen Werte bleiben.
 * Den Abruf macht weiter der tägliche {@link WetterArchivLaeufer}; Binden ruft nichts ab.
 *
 * <ul>
 *   <li>Nur Art {@code gradtagzahl}, Periodenart Tag oder Monat, am Standort mit Koordinaten — sonst 422, ohne
 *       Koordinaten mit dem Satz aus AP-17 §5.8 ({@link WetterArchivRegeln#koordinatenFehlen}).</li>
 *   <li>Eine Bezugsgröße, eine Quelle: mit Kanalbindung oder mit Werten anderer Herkunft 409.</li>
 * </ul>
 * Die Leser: an der Bezugsgröße die Bindung mit letztem Abruf und Stand („x von y Tagen“ des letzten Monats mit
 * bezogenen Tagen), am Standort die Zeile „Wetter“.
 */
@Service
public class WetterbezugService {
    public static final String ART = "gradtagzahl";
    private static final BigDecimal RAUM = new BigDecimal("20");
    private static final BigDecimal GRENZE = new BigDecimal("15");

    private final JdbcTemplate jdbc;
    private final BezugsgroesseRepository bezuege;
    private final ObjectMapper json;
    private final Geltungsbereich geltung;
    private final RechtPruefung rechte;
    private Clock uhr = Clock.systemUTC();

    public WetterbezugService(JdbcTemplate jdbc, BezugsgroesseRepository bezuege, ObjectMapper json,
            Geltungsbereich geltung, RechtPruefung rechte) {
        this.jdbc = jdbc; this.bezuege = bezuege; this.json = json; this.geltung = geltung; this.rechte = rechte;
    }
    void uhrStellen(Clock uhr) { this.uhr = uhr; }

    /** Der Stand des letzten Monats mit bezogenen Tagen: {@code monat} JJJJ-MM, „tage von tage_erwartet Tagen“. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Stand(String monat, int tage, int tageErwartet, String zustand) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bindung(BigDecimal raumtemperatur, BigDecimal heizgrenze, String regel, LocalDate von,
            String gebundenVon, Instant gebundenAm,
            @JsonInclude(JsonInclude.Include.NON_NULL) String quelle,
            @JsonInclude(JsonInclude.Include.NON_NULL) Instant letzterAbruf,
            @JsonInclude(JsonInclude.Include.NON_NULL) Stand stand) {}

    /**
     * Die Wetter-Sicht einer Bezugsgröße: {@code moeglich} (Art, Periode, Standort passen), {@code koordinaten}
     * (der Standort hat welche), {@code satz} (ohne Koordinaten, §5.8), {@code bindung} (oder {@code null}).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Wetterbezug(boolean moeglich, boolean koordinaten,
            @JsonInclude(JsonInclude.Include.NON_NULL) String satz, Bindung bindung) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Gradtagzahl(UUID id, String kennzeichen, String name,
            @JsonInclude(JsonInclude.Include.NON_NULL) String quelle,
            @JsonInclude(JsonInclude.Include.NON_NULL) Instant letzterAbruf) {}

    /** Die Zeile „Wetter“ am Standort: Koordinaten ja/nein, gebundene Gradtagzahlen, letzter Abruf. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record StandortWetter(boolean koordinaten, @JsonInclude(JsonInclude.Include.NON_NULL) String satz,
            List<Gradtagzahl> gradtagzahlen, @JsonInclude(JsonInclude.Include.NON_NULL) String quelle,
            @JsonInclude(JsonInclude.Include.NON_NULL) Instant letzterAbruf) {}

    private record Ort(String name, boolean koordinaten, ZoneId zone) {}

    @Transactional
    public Wetterbezug binden(UUID id, LocalDate von, BigDecimal raumtemperatur, BigDecimal heizgrenze,
            ProtokollAkteur wer) {
        var b = bezuege.sperre(id).orElseThrow(WetterbezugService::nichtGefunden);
        if (!moeglich(b)) throw fehler(422, "art_passt_nicht",
                "Wetter lässt sich nur für eine aktive Gradtagzahl am Standort mit Tages- oder Monatswerten beziehen.");
        Ort ort = ort(b.geltungId()).orElseThrow(WetterbezugService::nichtGefunden);
        if (!ort.koordinaten()) throw fehler(422, "koordinaten_fehlen", WetterArchivRegeln.koordinatenFehlen(ort.name()));
        BigDecimal raum = raumtemperatur == null ? RAUM : raumtemperatur;
        BigDecimal grenze = heizgrenze == null ? GRENZE : heizgrenze;
        if (raum.compareTo(grenze) <= 0) throw fehler(422, "grenzen_ungueltig", "Die Raumtemperatur muss über der Heizgrenze liegen.");
        LocalDate gestern = LocalDate.now(uhr.withZone(ort.zone())).minusDays(1);
        if (von == null || von.isAfter(gestern))
            throw fehler(422, "von_ungueltig", "Der Bezug beginnt spätestens mit dem gestrigen Tag.");
        if ("monat".equals(b.periodeArt()) && von.getDayOfMonth() != 1)
            throw fehler(422, "von_ungueltig", "Bei Monatswerten beginnt der Bezug am Ersten eines Monats.");
        Optional<Bindung> alt = bindung(id, b.periodeArt(), ort.zone());
        if (alt.isPresent()) {
            Bindung a = alt.get();
            if (a.von().equals(von) && a.raumtemperatur().compareTo(raum) == 0 && a.heizgrenze().compareTo(grenze) == 0)
                return new Wetterbezug(true, true, null, a);
            throw fehler(409, "wetterbezug_vorhanden",
                    "Diese Gradtagzahl bezieht bereits Wetter. Lösen Sie den Bezug, um ihn neu anzulegen.");
        }
        if (Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM bezugsgroesse_kanalbindung "
                + "WHERE bezugsgroesse_id=?)", Boolean.class, id)))
            throw fehler(409, "kanalbindung_vorhanden",
                    "Diese Gradtagzahl liest einen Messkanal. Eine Bezugsgröße hat eine Quelle.");
        if (Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM bezugsgroesse_wert "
                + "WHERE bezugsgroesse_id=? AND herkunft_art <> ?)", Boolean.class, id, WetterArchivRegeln.HERKUNFT)))
            throw fehler(409, "werte_vorhanden",
                    "Diese Gradtagzahl hat schon Werte aus einem Import oder Messkanal. Eine Bezugsgröße hat eine Quelle.");
        jdbc.update("INSERT INTO bezugsgroesse_wetterbezug (tenant_id,bezugsgroesse_id,raumtemperatur,heizgrenze,von,"
                + "actor_sub,actor_name,actor_art) VALUES (?,?,?,?,?,?,?,?)", TenantContext.get(), id, raum, grenze, von,
                wer.sub(), wer.name(), wer.art());
        Bindung neu = bindung(id, b.periodeArt(), ort.zone()).orElseThrow();
        protokoll(id, "wetter_gebunden", null, neu, wer);
        return new Wetterbezug(true, true, null, neu);
    }

    /** Löst die Bindung; die bezogenen Werte bleiben. Ohne Bindung ändert sich nichts. */
    @Transactional
    public void loesen(UUID id, ProtokollAkteur wer) {
        var b = bezuege.sperre(id).orElseThrow(WetterbezugService::nichtGefunden);
        ZoneId zone = ort(b.geltungId()).map(Ort::zone).orElse(WetterArchivRegeln.ZONE);
        Optional<Bindung> alt = bindung(id, b.periodeArt(), zone);
        if (alt.isEmpty()) return;
        jdbc.update("DELETE FROM bezugsgroesse_wetterbezug WHERE bezugsgroesse_id=?", id);
        protokoll(id, "wetter_geloest", alt.get(), null, wer);
    }

    /** Die Route: im Geltungsbereich des Aufrufers — außerhalb wie eine unbekannte Kennung (404). */
    public Wetterbezug lesen(UUID id) {
        var b = bezuege.finde(id).orElseThrow(WetterbezugService::nichtGefunden);
        rechte.pruefenLesen(RechtZiel.BEZUGSGROESSE, id, WetterbezugService::nichtGefunden);
        Optional<Ort> ort = "standort".equals(b.geltungArt()) ? ort(b.geltungId()) : Optional.empty();
        boolean koordinaten = ort.map(Ort::koordinaten).orElse(false);
        String satz = ort.filter(o -> !o.koordinaten() && ART.equals(b.art()))
                .map(o -> WetterArchivRegeln.koordinatenFehlen(o.name())).orElse(null);
        Bindung bindung = bindung(id, b.periodeArt(), ort.map(Ort::zone).orElse(WetterArchivRegeln.ZONE)).orElse(null);
        return new Wetterbezug(moeglich(b), koordinaten, satz, bindung);
    }

    /** Die Zeile „Wetter“ am Standort; ein Standort außerhalb des Zugriffs ist 404. */
    public StandortWetter standort(UUID standortId) {
        geltung.requireStandort(standortId);
        Ort ort = ort(standortId).orElseThrow(WetterbezugService::nichtGefunden);
        List<Gradtagzahl> liste = new ArrayList<>();
        for (Gradtagzahl g : jdbc.query("SELECT b.id, b.kennzeichen, b.name, a.bezug_quelle, a.abgerufen_am "
                + "FROM bezugsgroesse b JOIN bezugsgroesse_wetterbezug w ON w.bezugsgroesse_id=b.id AND w.tenant_id=b.tenant_id "
                + "LEFT JOIN LATERAL (SELECT bezug_quelle, abgerufen_am FROM bezugsgroesse_wert v WHERE v.bezugsgroesse_id=b.id "
                + "AND v.tenant_id=b.tenant_id AND v.herkunft_art=? ORDER BY v.abgerufen_am DESC LIMIT 1) a ON true "
                + "WHERE b.art=? AND b.geltung_art='standort' AND b.standort_id=? AND b.archiviert_am IS NULL "
                + "ORDER BY b.kennzeichen",
                (r, n) -> new Gradtagzahl(r.getObject(1, UUID.class), r.getString(2), r.getString(3), r.getString(4),
                        r.getTimestamp(5) == null ? null : r.getTimestamp(5).toInstant()),
                WetterArchivRegeln.HERKUNFT, ART, standortId)) {
            if (rechte.lesbar(RechtZiel.BEZUGSGROESSE, g.id())) liste.add(g);
        }
        Gradtagzahl zuletzt = liste.stream().filter(g -> g.letzterAbruf() != null)
                .max(Comparator.comparing(Gradtagzahl::letzterAbruf)).orElse(null);
        return new StandortWetter(ort.koordinaten(), ort.koordinaten() ? null : WetterArchivRegeln.koordinatenFehlen(ort.name()),
                List.copyOf(liste), zuletzt == null ? null : zuletzt.quelle(), zuletzt == null ? null : zuletzt.letzterAbruf());
    }

    private static boolean moeglich(BezugsgroesseRepository.Zeile b) {
        return ART.equals(b.art()) && b.archiviertAm() == null && "standort".equals(b.geltungArt())
                && ("tag".equals(b.periodeArt()) || "monat".equals(b.periodeArt()));
    }

    private Optional<Ort> ort(UUID standortId) {
        if (standortId == null) return Optional.empty();
        return jdbc.query("SELECT s.name, s.lage_breitengrad IS NOT NULL AND s.lage_laengengrad IS NOT NULL AS lage, "
                + "coalesce(s.zeitzone, u.zeitzone, 'Europe/Berlin') AS zone FROM standort s "
                + "LEFT JOIN unternehmen u ON u.tenant_id = s.tenant_id WHERE s.id=?",
                (r, n) -> new Ort(r.getString(1), r.getBoolean(2), ZoneId.of(r.getString(3))), standortId).stream().findFirst();
    }

    private Optional<Bindung> bindung(UUID id, String periode, ZoneId zone) {
        return jdbc.query("SELECT raumtemperatur, heizgrenze, von, actor_name, created_at FROM bezugsgroesse_wetterbezug "
                + "WHERE bezugsgroesse_id=?", (r, n) -> {
                    BigDecimal raum = r.getBigDecimal(1), grenze = r.getBigDecimal(2);
                    LocalDate von = r.getObject(3, LocalDate.class);
                    return new Bindung(raum, grenze, GradtagRegeln.regel(raum, grenze), von, r.getString(4),
                            r.getTimestamp(5).toInstant(), null, null, null);
                }, id).stream().findFirst().map(b -> mitStand(id, b, periode, zone));
    }

    /** Letzter Abruf und Stand: „x von y Tagen“ des letzten Monats mit bezogenen Tagen (y bis gestern, ab {@code von}). */
    private Bindung mitStand(UUID id, Bindung b, String periode, ZoneId zone) {
        var letzte = jdbc.query("SELECT bezug_quelle, abgerufen_am FROM bezugsgroesse_wert WHERE bezugsgroesse_id=? "
                + "AND herkunft_art=? ORDER BY abgerufen_am DESC LIMIT 1",
                (r, n) -> Map.entry(r.getString(1), r.getTimestamp(2).toInstant()), id, WetterArchivRegeln.HERKUNFT);
        if (letzte.isEmpty()) return b;
        Stand stand;
        if ("monat".equals(periode)) {
            stand = jdbc.query("SELECT periode_von, bezug_herkunft::text FROM bezugsgroesse_wert WHERE bezugsgroesse_id=? "
                    + "AND herkunft_art=? ORDER BY periode_von DESC, fassung DESC LIMIT 1", (r, n) -> {
                        JsonNode h = lies(r.getString(2));
                        return new Stand(YearMonth.from(r.getObject(1, LocalDate.class)).toString(), h.path("tage").asInt(),
                                h.path("tage_erwartet").asInt(), h.path("zustand").asText());
                    }, id, WetterArchivRegeln.HERKUNFT).stream().findFirst().orElse(null);
        } else {
            LocalDate gestern = LocalDate.now(uhr.withZone(zone)).minusDays(1);
            LocalDate jungster = jdbc.queryForObject("SELECT max(periode_von) FROM bezugsgroesse_wert WHERE "
                    + "bezugsgroesse_id=? AND herkunft_art=?", LocalDate.class, id, WetterArchivRegeln.HERKUNFT);
            YearMonth monat = YearMonth.from(jungster);
            LocalDate anfang = monat.atDay(1).isBefore(b.von()) ? b.von() : monat.atDay(1);
            LocalDate ende = monat.atEndOfMonth().isAfter(gestern) ? gestern : monat.atEndOfMonth();
            int erwartet = (int) Math.max(0, java.time.temporal.ChronoUnit.DAYS.between(anfang, ende) + 1);
            Integer tage = jdbc.queryForObject("SELECT count(DISTINCT periode_von) FROM bezugsgroesse_wert WHERE "
                    + "bezugsgroesse_id=? AND herkunft_art=? AND periode_von BETWEEN ? AND ?", Integer.class, id,
                    WetterArchivRegeln.HERKUNFT, anfang, ende);
            int da = tage == null ? 0 : tage;
            stand = new Stand(monat.toString(), da, erwartet,
                    da >= erwartet ? VerbrauchRegeln.VOLLSTAENDIG : VerbrauchRegeln.UNVOLLSTAENDIG);
        }
        return new Bindung(b.raumtemperatur(), b.heizgrenze(), b.regel(), b.von(), b.gebundenVon(), b.gebundenAm(),
                letzte.getFirst().getKey(), letzte.getFirst().getValue(), stand);
    }

    private JsonNode lies(String text) {
        try { return text == null ? json.createObjectNode() : json.readTree(text); }
        catch (com.fasterxml.jackson.core.JsonProcessingException e) { throw new IllegalStateException(e); }
    }

    private void protokoll(UUID id, String art, Bindung alt, Bindung neu, ProtokollAkteur wer) {
        try {
            bezuege.protokoll(TenantContext.get(), id, art, alt == null ? null : json.writeValueAsString(alt),
                    neu == null ? null : json.writeValueAsString(neu), wer);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) { throw new IllegalStateException(e); }
    }

    private static KanalbindungFehler nichtGefunden() {
        return new KanalbindungFehler(404, "nicht_gefunden", "Die Bezugsgröße oder der Standort wurde nicht gefunden.");
    }
    private static KanalbindungFehler fehler(int status, String code, String satz) { return new KanalbindungFehler(status, code, satz); }
}
