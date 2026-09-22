package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MesskanalService;
import com.voltpilot.api.tenant.TenantContext;
import java.sql.Timestamp;
import java.math.BigDecimal;
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
    private final com.voltpilot.api.zugriff.RechtPruefung rechte;
    private Clock uhr = Clock.systemUTC();

    public KanalbindungService(JdbcTemplate jdbc, BezugsgroesseRepository bezuege, MesskanalService kanaele,
            ObjectMapper json, com.voltpilot.api.zugriff.Geltungsbereich geltung,
            com.voltpilot.api.zugriff.RechtPruefung rechte) {
        this.jdbc=jdbc; this.bezuege=bezuege; this.kanaele=kanaele; this.json=json; this.geltung=geltung; this.rechte=rechte;
    }
    void uhrStellen(Clock uhr) { this.uhr=uhr; }

    @com.fasterxml.jackson.databind.annotation.JsonNaming(com.fasterxml.jackson.databind.PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bindung(UUID id, UUID entityId, String kanal, String wertart, String zustand,
            Instant von, Instant bis, BigDecimal raumtemperatur, BigDecimal heizgrenze,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL) UUID messstelleId,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL) BigDecimal schwelleKw,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL) String begruendung,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL) Integer fassung,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL) UUID ersetztBindungId) {
        @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
        public String getRegel() { return schwelleKw==null ? null : BetriebszeitRegeln.kennzeichen(schwelleKw); }
    }

    @Transactional
    public Bindung binden(UUID id, UUID entity, String kanal, String zustand, Instant von, ProtokollAkteur wer) {
        return binden(id,entity,kanal,zustand,von,null,null,wer);
    }

    @Transactional
    public Bindung binden(UUID id, UUID entity, String kanal, String zustand, Instant von,
            BigDecimal raumtemperatur, BigDecimal heizgrenze, ProtokollAkteur wer) {
        return binden(id,entity,kanal,zustand,von,raumtemperatur,heizgrenze,null,null,null,wer);
    }

    @Transactional
    public Bindung binden(UUID id, UUID entity, String kanal, String zustand, Instant von,
            BigDecimal raumtemperatur, BigDecimal heizgrenze, UUID messstelle, BigDecimal schwelle,
            String begruendung, ProtokollAkteur wer) {
        var b = bezuege.sperre(id).orElseThrow(KanalbindungService::nichtGefunden);
        minute(von);
        boolean leistung="betriebszeit_aus_leistung".equals(b.art());
        if (leistung) {
            if (messstelle==null || schwelle==null || schwelle.signum()<0 || begruendung==null
                    || begruendung.strip().length()<10 || begruendung.strip().length()>2000)
                throw fehler("schwelle_ungueltig", "Messstelle, nicht negative Schwelle und Begründung mit 10 bis 2000 Zeichen sind erforderlich.");
            rechte.pruefenLesen(com.voltpilot.api.zugriff.RechtZiel.MESSSTELLE,messstelle,KanalbindungService::nichtGefunden);
            var quellen=jdbc.query("SELECT entity_id,kanal FROM messstelle_quelle WHERE messstelle_id=? "
                    + "AND rolle='fuehrend' AND kanal_wertart='gauge' AND groesse='Wirkleistung' "
                    + "AND gueltig_ab<=? AND (gueltig_bis IS NULL OR gueltig_bis>?)",
                    (r,n)->Map.entry(r.getObject(1,UUID.class),r.getString(2)),messstelle,Timestamp.from(von),Timestamp.from(von));
            if (quellen.size()!=1) throw fehler("kanal_passt_nicht", "Die Messstelle benötigt genau einen führenden Leistungskanal.");
            var q=quellen.getFirst();
            if (entity!=null && !entity.equals(q.getKey()) || kanal!=null && !kanal.equals(q.getValue()))
                throw fehler("kanal_passt_nicht", "Der Kanal gehört nicht zur Messstelle.");
            entity=q.getKey(); kanal=q.getValue();
            begruendung=begruendung.strip();
        } else if (schwelle!=null || messstelle!=null || begruendung!=null) {
            throw fehler("kanal_passt_nicht", "Eine Leistungsschwelle gehört zur Betriebszeit aus Leistung.");
        }
        if (entity == null || kanal == null) throw fehler("anfrage_ungueltig", "Komponente und Kanal fehlen.");
        List<UUID> anlagen=jdbc.query("SELECT site_id FROM measurement_point WHERE id=?",(r,n)->r.getObject(1,UUID.class),entity);
        if (anlagen.isEmpty() || !geltung.siteVisible(anlagen.getFirst())) throw nichtGefunden();
        var k = kanaele.kanal(entity, kanal).orElseThrow(KanalbindungService::nichtGefunden);
        if (b.archiviertAm()!=null || !"periodenwert".equals(b.wertart()))
            throw fehler("wertart_passt_nicht", "Nur eine aktive Bezugsgröße mit Periodenwerten kann einen Kanal lesen.");
        if (!List.of("counter","state","gauge").contains(k.wertart()==null ? "" : k.wertart()))
            throw fehler("kanal_nicht_ableitbar", "Aus diesem Kanal lässt sich keine Menge oder Dauer bilden.");
        if ("state".equals(k.wertart()) && (zustand==null || zustand.isBlank() || !List.of("h","min").contains(b.einheit()))
                || "counter".equals(k.wertart()) && (zustand!=null || !einheitPasst(k.einheit(),b.einheit())))
            throw fehler("kanal_passt_nicht", "Einheit oder gewählter Zustand passen nicht zum Kanal.");
        if (leistung) {
            if (!"gauge".equals(k.wertart()) || !"active_power".equals(k.quantity())
                    || !List.of("W","kW").contains(k.einheit()==null ? "" : k.einheit())
                    || !List.of("h","min").contains(b.einheit()) || zustand!=null || raumtemperatur!=null || heizgrenze!=null)
                throw fehler("kanal_passt_nicht", "Betriebszeit benötigt einen Leistungskanal in W oder kW und eine Dauer in Stunden oder Minuten.");
        } else if ("gauge".equals(k.wertart())) {
            if (!"temperature".equals(k.quantity()) || !"°C".equals(k.einheit()) || !"Kd".equals(b.einheit())
                    || !"standort".equals(b.geltungArt()) || zustand!=null)
                throw fehler("kanal_passt_nicht", "Gradtage benötigen einen gemessenen Temperaturkanal in °C am Standort.");
            if (!Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM anlage_standort a JOIN standort s ON s.id=a.standort_id "
                    + "WHERE a.site_id=? AND a.standort_id=? AND a.aufgehoben_am IS NULL AND a.gueltig_ab<=(?::timestamptz AT TIME ZONE s.zeitzone)::date "
                    + "AND (a.gueltig_bis IS NULL OR a.gueltig_bis>=(?::timestamptz AT TIME ZONE s.zeitzone)::date))",
                    Boolean.class,anlagen.getFirst(),b.geltungId(),Timestamp.from(von),Timestamp.from(von))))
                throw fehler("kanal_passt_nicht", "Der Temperaturkanal muss am Standort der Bezugsgröße gemessen werden.");
            raumtemperatur=raumtemperatur==null ? new BigDecimal("20") : raumtemperatur;
            heizgrenze=heizgrenze==null ? new BigDecimal("15") : heizgrenze;
            if (raumtemperatur.compareTo(heizgrenze)<=0)
                throw fehler("grenzen_ungueltig", "Die Raumtemperatur muss über der Heizgrenze liegen.");
        } else if (raumtemperatur!=null || heizgrenze!=null) {
            throw fehler("kanal_passt_nicht", "Temperaturgrenzen gelten nur für Gradtage.");
        }
        int kadenz = kanaele.kadenzS(kanal,k.kadenzS());
        var roh=jdbc.query("SELECT min(time), max(time) FILTER (WHERE quality='good') FROM device_measurement_sample WHERE tenant_id=? "
                + "AND entity_id=? AND point_key=? AND role IS DISTINCT FROM 'spiegel'",
                (rs,n) -> new Instant[]{rs.getTimestamp(1)==null ? null : rs.getTimestamp(1).toInstant(),
                    rs.getTimestamp(2)==null ? null : rs.getTimestamp(2).toInstant()}, TenantContext.get(),entity,kanal).getFirst();
        if (!k.aktiv() || roh[1]==null || roh[1].isBefore(uhr.instant().minusSeconds(ZustandAbleitung.toleranzS(kadenz))))
            throw fehler("kanal_liefert_nicht", "Der Kanal liefert zurzeit keine Daten.");
        if (von.isBefore(roh[0])) throw fehler("vor_erster_messung", "Die Bindung beginnt frühestens mit dem ersten gespeicherten Messwert.");
        Bindung vorgaenger=null;
        Integer fassung=null;
        if (leistung) {
            var bisher=liste(id);
            vorgaenger=bisher.isEmpty()?null:bisher.getLast();
            fassung=vorgaenger==null?1:vorgaenger.fassung()+1;
            if (vorgaenger!=null) {
                if (!von.isAfter(vorgaenger.von()) || vorgaenger.bis()!=null && von.isBefore(vorgaenger.bis()))
                    throw fehler("bindung_ueberlappt", "Die neue Fassung muss nach der vorherigen beginnen.");
                if (vorgaenger.bis()==null) {
                    jdbc.update("UPDATE bezugsgroesse_kanalbindung SET bis=? WHERE id=?",Timestamp.from(von),vorgaenger.id());
                    protokoll(id,"kanal_beendet",new Bindung(vorgaenger.id(),vorgaenger.entityId(),vorgaenger.kanal(),
                            vorgaenger.wertart(),vorgaenger.zustand(),vorgaenger.von(),von,vorgaenger.raumtemperatur(),
                            vorgaenger.heizgrenze(),vorgaenger.messstelleId(),vorgaenger.schwelleKw(),vorgaenger.begruendung(),
                            vorgaenger.fassung(),vorgaenger.ersetztBindungId()),von,wer);
                }
            }
        }
        if (ueberlappt(id,von,null)) throw fehler("bindung_ueberlappt", "In diesem Zeitraum ist bereits ein Kanal gebunden.");
        if (Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM bezugsgroesse_wert w "
                + "WHERE bezugsgroesse_id=? AND tstzrange(w.periode_von::timestamp AT TIME ZONE w.zeitzone, "
                + "(w.periode_bis+1)::timestamp AT TIME ZONE w.zeitzone,'[)') && tstzrange(?,NULL,'[)'))",
                Boolean.class,id,Timestamp.from(von))))
            throw fehler("zeitraum_hat_werte", "Für diesen Zeitraum sind bereits Werte eingetragen.");
        UUID neu=jdbc.queryForObject("INSERT INTO bezugsgroesse_kanalbindung "
                + "(tenant_id,bezugsgroesse_id,entity_id,kanal,wertart,einheit,zustand,kadenz_s,von,"
                + "actor_sub,actor_name,actor_rolle,actor_art,raumtemperatur,heizgrenze,messstelle_id,schwelle_kw,begruendung,fassung,ersetzt_bindung_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
                UUID.class,TenantContext.get(),id,entity,kanal,k.wertart(),k.einheit()==null ? b.einheit() : k.einheit(),
                zustand,kadenz,Timestamp.from(von),wer.sub(),wer.name(),wer.rolle(),wer.art(),raumtemperatur,heizgrenze,messstelle,schwelle,begruendung,fassung,vorgaenger==null?null:vorgaenger.id());
        Bindung aus=new Bindung(neu,entity,kanal,k.wertart(),zustand,von,null,raumtemperatur,heizgrenze,messstelle,schwelle,begruendung,fassung,vorgaenger==null?null:vorgaenger.id());
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
        Bindung aus=new Bindung(alt.id(),alt.entityId(),alt.kanal(),alt.wertart(),alt.zustand(),alt.von(),bis,alt.raumtemperatur(),alt.heizgrenze(),alt.messstelleId(),alt.schwelleKw(),alt.begruendung(),alt.fassung(),alt.ersetztBindungId());
        protokoll(id,"kanal_beendet",aus,bis,wer);
        return aus;
    }

    /** Die Route: die Bindungen nur im Geltungsbereich des Aufrufers (AP-03 R-A1) — außerhalb wie eine unbekannte Kennung. */
    public List<Bindung> listeImGeltungsbereich(UUID id) {
        sichtbar(id);
        return liste(id);
    }

    /** Ungezäunt — für {@link #beenden}, dessen Route {@code @Recht} schon am Objekt geprüft hat. */
    public List<Bindung> liste(UUID id) {
        bezuege.finde(id).orElseThrow(KanalbindungService::nichtGefunden);
        return jdbc.query("SELECT * FROM bezugsgroesse_kanalbindung WHERE bezugsgroesse_id=? ORDER BY von",
            (rs,n) -> new Bindung(rs.getObject("id",UUID.class),rs.getObject("entity_id",UUID.class),
                rs.getString("kanal"),rs.getString("wertart"),rs.getString("zustand"),rs.getTimestamp("von").toInstant(),
                rs.getTimestamp("bis")==null ? null : rs.getTimestamp("bis").toInstant(),rs.getBigDecimal("raumtemperatur"),rs.getBigDecimal("heizgrenze"),rs.getObject("messstelle_id",UUID.class),rs.getBigDecimal("schwelle_kw"),rs.getString("begruendung"),rs.getObject("fassung",Integer.class),rs.getObject("ersetzt_bindung_id",UUID.class)),id);
    }

    @com.fasterxml.jackson.databind.annotation.JsonNaming(com.fasterxml.jackson.databind.PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Auswahl(UUID entityId, String komponente, String kanal, String name, String wertart,
            String einheit, Instant ersteMessung, boolean liefert, List<String> zustaende,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL) UUID messstelleId) {}

    /** Dieselbe Mess-Selektion wie beim Binden; fremde Standorte erscheinen nie im Picker. */
    public List<Auswahl> auswahl(UUID id) {
        var b=sichtbar(id);
        boolean leistung="betriebszeit_aus_leistung".equals(b.art());
        List<Auswahl> aus=new ArrayList<>();
        var reihen=jdbc.query("SELECT DISTINCT p.id,p.site_id,p.label,s.point_key FROM measurement_point p "
            + "JOIN device_measurement_selection s ON s.entity_id=p.id AND s.tenant_id=p.tenant_id ORDER BY p.label,s.point_key",
            (r,n)->new Object[]{r.getObject(1,UUID.class),r.getObject(2,UUID.class),r.getString(3),r.getString(4)});
        for (var r:reihen) {
            UUID entity=(UUID)r[0],site=(UUID)r[1]; String key=(String)r[3];
            if (!geltung.siteVisible(site)) continue;
            var k=kanaele.kanal(entity,key).orElse(null);
            if (k==null || k.wertart()==null) continue;
            boolean passt=leistung ? "gauge".equals(k.wertart()) && "active_power".equals(k.quantity())
                    && List.of("W","kW").contains(k.einheit()==null?"":k.einheit()) : switch(k.wertart()) {
                case "counter" -> einheitPasst(k.einheit(),b.einheit());
                case "state" -> List.of("h","min").contains(b.einheit());
                case "gauge" -> "Kd".equals(b.einheit()) && "standort".equals(b.geltungArt())
                    && "temperature".equals(k.quantity()) && "°C".equals(k.einheit());
                default -> false;
            };
            if (!passt) continue;
            UUID messstelle=null;
            if (leistung) {
                var quellen=jdbc.queryForList("SELECT messstelle_id FROM messstelle_quelle WHERE entity_id=? AND kanal=? "
                        + "AND rolle='fuehrend' AND groesse='Wirkleistung' AND gueltig_ab<=? AND (gueltig_bis IS NULL OR gueltig_bis>?)",
                        UUID.class,entity,key,Timestamp.from(uhr.instant()),Timestamp.from(uhr.instant()));
                if (quellen.size()!=1 || !rechte.lesbar(com.voltpilot.api.zugriff.RechtZiel.MESSSTELLE,quellen.getFirst())) continue;
                messstelle=quellen.getFirst();
            }
            if (!leistung && "gauge".equals(k.wertart()) && !Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT EXISTS (SELECT 1 FROM anlage_standort WHERE site_id=? AND standort_id=? AND aufgehoben_am IS NULL)",Boolean.class,site,b.geltungId()))) continue;
            var zeit=jdbc.query("SELECT min(time),max(time) FILTER (WHERE quality='good') FROM device_measurement_sample "
                + "WHERE entity_id=? AND point_key=? AND role IS DISTINCT FROM 'spiegel'",
                (rs,n)->new Instant[]{rs.getTimestamp(1)==null?null:rs.getTimestamp(1).toInstant(),rs.getTimestamp(2)==null?null:rs.getTimestamp(2).toInstant()},entity,key).getFirst();
            List<String> zustaende="state".equals(k.wertart()) ? jdbc.queryForList("SELECT DISTINCT coalesce(decoded_text,raw_text,decoded_numeric::text,raw_numeric::text) AS wort "
                + "FROM device_measurement_sample WHERE entity_id=? AND point_key=? AND quality='good' AND role IS DISTINCT FROM 'spiegel' "
                + "AND coalesce(decoded_text,raw_text,decoded_numeric::text,raw_numeric::text) IS NOT NULL ORDER BY wort LIMIT 100",String.class,entity,key) : List.of();
            boolean liefert=k.aktiv() && zeit[1]!=null && !zeit[1].isBefore(uhr.instant().minusSeconds(ZustandAbleitung.toleranzS(kanaele.kadenzS(key,k.kadenzS()))));
            aus.add(new Auswahl(entity,(String)r[2],key,k.anzeigename(),k.wertart(),k.einheit(),zeit[0],liefert,zustaende,messstelle));
        }
        return aus;
    }

    public boolean hatBindungen(UUID id) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM bezugsgroesse_kanalbindung WHERE bezugsgroesse_id=?)",Boolean.class,id));
    }

    public void eingabePruefen(UUID id, LocalDate von, LocalDate bis, ZoneId zone) {
        if ("betriebszeit_aus_leistung".equals(bezuege.finde(id).orElseThrow(KanalbindungService::nichtGefunden).art()))
            throw fehler("kanal_gebunden", "Betriebszeit aus Leistung wird ausschließlich aus dem begründeten Messkanal gebildet.");
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
    /** Die Bezugsgröße, wie eine Route sie liest: unbekannt und außerhalb des Geltungsbereichs sind dieselbe 404. */
    private BezugsgroesseRepository.Zeile sichtbar(UUID id) {
        var b=bezuege.finde(id).orElseThrow(KanalbindungService::nichtGefunden);
        rechte.pruefenLesen(com.voltpilot.api.zugriff.RechtZiel.BEZUGSGROESSE,id,KanalbindungService::nichtGefunden);
        return b;
    }
    private static KanalbindungFehler nichtGefunden() { return new KanalbindungFehler(404,"nicht_gefunden","Die Bezugsgröße oder der Kanal wurde nicht gefunden."); }
    private static KanalbindungFehler fehler(String code,String satz) { return new KanalbindungFehler(422,code,satz); }
}
