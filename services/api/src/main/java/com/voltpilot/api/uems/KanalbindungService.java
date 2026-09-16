package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MesskanalService;
import com.voltpilot.api.tenant.TenantContext;
import java.sql.Timestamp;
import java.time.*;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** K1/K2/K6: Kanal und Zeitraum werden einmal festgehalten, danach nur beendet. */
@Service
public class KanalbindungService {
    private final JdbcTemplate jdbc;
    private final BezugsgroesseRepository bezuege;
    private final MesskanalService kanaele;
    private final ObjectMapper json;
    private final com.voltpilot.api.zugriff.Geltungsbereich geltung;
    private Clock uhr = Clock.systemUTC();

    public KanalbindungService(JdbcTemplate jdbc, BezugsgroesseRepository bezuege, MesskanalService kanaele,
            ObjectMapper json, com.voltpilot.api.zugriff.Geltungsbereich geltung) {
        this.jdbc=jdbc; this.bezuege=bezuege; this.kanaele=kanaele; this.json=json; this.geltung=geltung;
    }
    void uhrStellen(Clock uhr) { this.uhr=uhr; }

    @com.fasterxml.jackson.databind.annotation.JsonNaming(com.fasterxml.jackson.databind.PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bindung(UUID id, UUID entityId, String kanal, String wertart, String zustand,
            Instant von, Instant bis) {}

    @Transactional
    public Bindung binden(UUID id, UUID entity, String kanal, String zustand, Instant von, ProtokollAkteur wer) {
        var b = bezuege.sperre(id).orElseThrow(KanalbindungService::nichtGefunden);
        minute(von);
        if (entity == null || kanal == null) throw fehler("anfrage_ungueltig", "Komponente und Kanal fehlen.");
        List<UUID> anlagen=jdbc.query("SELECT site_id FROM measurement_point WHERE id=?",(r,n)->r.getObject(1,UUID.class),entity);
        if (anlagen.isEmpty() || !geltung.siteVisible(anlagen.getFirst())) throw nichtGefunden();
        var k = kanaele.kanal(entity, kanal).orElseThrow(KanalbindungService::nichtGefunden);
        if (b.archiviertAm()!=null || !"periodenwert".equals(b.wertart()))
            throw fehler("wertart_passt_nicht", "Nur eine aktive Bezugsgröße mit Periodenwerten kann einen Kanal lesen.");
        if (!List.of("counter","state").contains(k.wertart()==null ? "" : k.wertart()))
            throw fehler("kanal_nicht_ableitbar", "Aus diesem Kanal lässt sich keine Menge oder Dauer bilden.");
        if ("state".equals(k.wertart()) && (zustand==null || zustand.isBlank() || !List.of("h","min").contains(b.einheit()))
                || "counter".equals(k.wertart()) && (zustand!=null || !einheitPasst(k.einheit(),b.einheit())))
            throw fehler("kanal_passt_nicht", "Einheit oder gewählter Zustand passen nicht zum Kanal.");
        int kadenz = kanaele.kadenzS(kanal,k.kadenzS());
        var roh=jdbc.query("SELECT min(time), max(time) FILTER (WHERE quality='good') FROM device_measurement_sample WHERE tenant_id=? "
                + "AND entity_id=? AND point_key=? AND role IS DISTINCT FROM 'spiegel'",
                (rs,n) -> new Instant[]{rs.getTimestamp(1)==null ? null : rs.getTimestamp(1).toInstant(),
                    rs.getTimestamp(2)==null ? null : rs.getTimestamp(2).toInstant()}, TenantContext.get(),entity,kanal).getFirst();
        if (!k.aktiv() || roh[1]==null || roh[1].isBefore(uhr.instant().minusSeconds(ZustandAbleitung.toleranzS(kadenz))))
            throw fehler("kanal_liefert_nicht", "Der Kanal liefert zurzeit keine Daten.");
        if (von.isBefore(roh[0])) throw fehler("vor_erster_messung", "Die Bindung beginnt frühestens mit dem ersten gespeicherten Messwert.");
        if (ueberlappt(id,von,null)) throw fehler("bindung_ueberlappt", "In diesem Zeitraum ist bereits ein Kanal gebunden.");
        if (Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM bezugsgroesse_wert w "
                + "WHERE bezugsgroesse_id=? AND tstzrange(w.periode_von::timestamp AT TIME ZONE w.zeitzone, "
                + "(w.periode_bis+1)::timestamp AT TIME ZONE w.zeitzone,'[)') && tstzrange(?,NULL,'[)'))",
                Boolean.class,id,Timestamp.from(von))))
            throw fehler("zeitraum_hat_werte", "Für diesen Zeitraum sind bereits Werte eingetragen.");
        UUID neu=jdbc.queryForObject("INSERT INTO bezugsgroesse_kanalbindung "
                + "(tenant_id,bezugsgroesse_id,entity_id,kanal,wertart,einheit,zustand,kadenz_s,von,"
                + "actor_sub,actor_name,actor_rolle,actor_art) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
                UUID.class,TenantContext.get(),id,entity,kanal,k.wertart(),k.einheit()==null ? b.einheit() : k.einheit(),
                zustand,kadenz,Timestamp.from(von),wer.sub(),wer.name(),wer.rolle(),wer.art());
        Bindung aus=new Bindung(neu,entity,kanal,k.wertart(),zustand,von,null);
        protokoll(id,"kanal_gebunden",aus,von,wer);
        return aus;
    }

    @Transactional
    public Bindung beenden(UUID id, UUID bindung, Instant bis, ProtokollAkteur wer) {
        bezuege.sperre(id).orElseThrow(KanalbindungService::nichtGefunden);
        minute(bis);
        Bindung alt=liste(id).stream().filter(k -> k.id().equals(bindung)).findFirst().orElseThrow(KanalbindungService::nichtGefunden);
        if (alt.bis()!=null || !bis.isAfter(alt.von()) || bis.isBefore(uhr.instant().truncatedTo(java.time.temporal.ChronoUnit.MINUTES)))
            throw fehler("ende_ungueltig", "Die Bindung kann nur ab jetzt und nach ihrem Beginn beendet werden.");
        jdbc.update("UPDATE bezugsgroesse_kanalbindung SET bis=? WHERE id=?",Timestamp.from(bis),bindung);
        Bindung aus=new Bindung(alt.id(),alt.entityId(),alt.kanal(),alt.wertart(),alt.zustand(),alt.von(),bis);
        protokoll(id,"kanal_beendet",aus,bis,wer);
        return aus;
    }

    public List<Bindung> liste(UUID id) {
        bezuege.finde(id).orElseThrow(KanalbindungService::nichtGefunden);
        return jdbc.query("SELECT * FROM bezugsgroesse_kanalbindung WHERE bezugsgroesse_id=? ORDER BY von",
            (rs,n) -> new Bindung(rs.getObject("id",UUID.class),rs.getObject("entity_id",UUID.class),
                rs.getString("kanal"),rs.getString("wertart"),rs.getString("zustand"),rs.getTimestamp("von").toInstant(),
                rs.getTimestamp("bis")==null ? null : rs.getTimestamp("bis").toInstant()),id);
    }

    public boolean hatBindungen(UUID id) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM bezugsgroesse_kanalbindung WHERE bezugsgroesse_id=?)",Boolean.class,id));
    }

    public void eingabePruefen(UUID id, LocalDate von, LocalDate bis, ZoneId zone) {
        if (von!=null && ueberlappt(id,von.atStartOfDay(zone).toInstant(),bis.plusDays(1).atStartOfDay(zone).toInstant()))
            throw fehler("kanal_gebunden", "Für diesen Zeitraum liefert ein Messkanal die Werte. Eine Eingabe oder ein Import ist hier nicht möglich.");
    }
    private boolean einheitPasst(String von, String bis) {
        return von != null && !BezugsEinheit.einheit(java.math.BigDecimal.ONE,von,bis,
            bezuege.vokabular().einheiten(),BezugsEinheit.UMRECHNUNGEN).befunde().contains(BezugsEinheit.EINHEIT_UNBEKANNT);
    }
    private boolean ueberlappt(UUID id, Instant von, Instant bis) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM bezugsgroesse_kanalbindung "
            + "WHERE bezugsgroesse_id=? AND tstzrange(von,bis,'[)') && tstzrange(?,?,'[)'))",Boolean.class,id,
            Timestamp.from(von),bis==null ? null : Timestamp.from(bis)));
    }
    private void protokoll(UUID id,String art,Bindung b,Instant ab,ProtokollAkteur wer) {
        try { bezuege.protokoll(TenantContext.get(),id,art,null,json.writeValueAsString(b),ab,ab.isBefore(uhr.instant()),wer); }
        catch (com.fasterxml.jackson.core.JsonProcessingException e) { throw new IllegalStateException(e); }
    }
    private static void minute(Instant t) {
        if (t==null || t.getNano()!=0 || t.getEpochSecond()%60!=0) throw fehler("zeit_ungueltig", "Bitte einen Zeitpunkt auf die volle Minute angeben.");
    }
    private static KanalbindungFehler nichtGefunden() { return new KanalbindungFehler(404,"nicht_gefunden","Die Bezugsgröße oder der Kanal wurde nicht gefunden."); }
    private static KanalbindungFehler fehler(String code,String satz) { return new KanalbindungFehler(422,code,satz); }
}
