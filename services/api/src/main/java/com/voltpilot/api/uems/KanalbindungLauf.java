package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.math.BigDecimal;
import java.sql.*;
import java.time.*;
import java.time.temporal.TemporalAdjusters;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.*;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.stereotype.Component;

/** AP-09 K3/K4: eigener Zusatz nach den gemessenen Perioden; niemals Änderungen an AP-08-Zeilen. */
@Component
public class KanalbindungLauf {
    private static final Logger log=LoggerFactory.getLogger(KanalbindungLauf.class);
    private final JdbcTemplate admin;
    private final ObjectMapper json;
    private final AtomicLong fehler=new AtomicLong();
    public KanalbindungLauf(@Qualifier("adminJdbcTemplate") JdbcTemplate admin,ObjectMapper json) {
        this.admin=admin; this.json=json;
    }
    public long fehlerAnzahl() { return fehler.get(); }
    record Bindung(UUID id,UUID tenant,UUID bezug,UUID entity,String kanal,String art,String zustand,
            String einheit,String quellEinheit,String periode,int kadenz,Instant von,Instant bis,ZoneId zone,BigDecimal raumtemperatur,BigDecimal heizgrenze) {}
    record Roh(Instant zeit,BigDecimal zahl,String wort,boolean gut,UUID einbau) {}
    record Ergebnis(BigDecimal betrag,String zustand,BigDecimal abdeckung,List<String> kennzeichen) {}

    public int lauf(Instant jetzt) {
        return lauf(jetzt,null);
    }

    int lauf(Instant jetzt, UUID tenant) {
        List<Bindung> bindungen=admin.query("""
            SELECT k.*, b.einheit AS ziel_einheit,b.periode_art,
                   coalesce(s.zeitzone,u.zeitzone,'Europe/Berlin') AS zone
              FROM bezugsgroesse_kanalbindung k JOIN bezugsgroesse b
                ON b.id=k.bezugsgroesse_id AND b.tenant_id=k.tenant_id
              LEFT JOIN standort s ON s.id=b.standort_id AND s.tenant_id=b.tenant_id
              LEFT JOIN unternehmen u ON u.tenant_id=b.tenant_id
             WHERE b.archiviert_am IS NULL AND k.von < ? AND (?::uuid IS NULL OR k.tenant_id=?) ORDER BY k.tenant_id,k.id
            """,(r,n)->new Bindung(r.getObject("id",UUID.class),r.getObject("tenant_id",UUID.class),
                r.getObject("bezugsgroesse_id",UUID.class),r.getObject("entity_id",UUID.class),r.getString("kanal"),
                r.getString("wertart"),r.getString("zustand"),r.getString("ziel_einheit"),r.getString("einheit"),r.getString("periode_art"),
                r.getInt("kadenz_s"),r.getTimestamp("von").toInstant(),instant(r,"bis"),ZoneId.of(r.getString("zone")),r.getBigDecimal("raumtemperatur"),r.getBigDecimal("heizgrenze")),ts(jetzt),tenant,tenant);
        int anzahl=0;
        for (Bindung b:bindungen) {
            Integer neu=admin.execute((Connection con)->{
                boolean auto=con.getAutoCommit(); con.setAutoCommit(false);
                Savepoint punkt=con.setSavepoint();
                try {
                    JdbcTemplate j=new JdbcTemplate(new SingleConnectionDataSource(con,true));
                    // Zwei Takte serialisieren die Fassungen, ohne UPDATE-Rechte auf die Bezugsgröße.
                    j.execute("SELECT pg_advisory_xact_lock(hashtextextended('bezugskanal:" + b.tenant() + ":" + b.bezug() + "',0))");
                    int n=bilde(j,con,b,jetzt,bindungen.stream().filter(k -> k.bezug().equals(b.bezug())).toList());
                    con.releaseSavepoint(punkt); con.commit(); return n;
                } catch (Exception e) {
                    con.rollback(punkt); con.commit(); fehler.incrementAndGet();
                    io.micrometer.core.instrument.Metrics.counter("voltpilot_bezugskanal_total","ergebnis","fehler").increment();
                    log.warn("UEMS Kanalbindung {} fehlgeschlagen, Zusatz zurückgerollt: {}",b.id(),e.toString());
                    return 0;
                } finally { con.setAutoCommit(auto); }
            });
            anzahl+=neu==null ? 0 : neu;
        }
        return anzahl;
    }

    private int bilde(JdbcTemplate j,Connection con,Bindung b,Instant jetzt,List<Bindung> bindungen) throws Exception {
        LocalDate erster=anfang(b.von().atZone(b.zone()).toLocalDate(),b.periode());
        var stand=j.query("SELECT naechster_tag,eingang FROM bezugsgroesse_kanallauf WHERE tenant_id=? AND bindung_id=?",
                (r,n)->Map.entry(r.getObject(1,LocalDate.class),r.getTimestamp(2).toInstant()),b.tenant(),b.id());
        LocalDate weiter=stand.isEmpty() ? erster : stand.getFirst().getKey();
        Instant eingang=stand.isEmpty() ? b.von() : stand.getFirst().getValue();
        Set<LocalDate> tage=new TreeSet<>(j.queryForList("SELECT periode_von FROM (SELECT DISTINCT ON (periode_von) "
            + "periode_von,kanal_herkunft FROM bezugsgroesse_wert WHERE tenant_id=? AND bezugsgroesse_id=? "
            + "ORDER BY periode_von,fassung DESC) w WHERE kanal_herkunft->>'bindung'=? "
            + "AND (kanal_herkunft->>'vorlaeufig')::boolean=true",LocalDate.class,b.tenant(),b.bezug(),b.id().toString()));
        for (int i=0;i<32;i++) {
            Instant ende=naechste(weiter,b.periode()).atStartOfDay(b.zone()).toInstant();
            if (ende.isAfter(jetzt) || b.bis()!=null && !weiter.atStartOfDay(b.zone()).toInstant().isBefore(b.bis())) break;
            tage.add(weiter); weiter=naechste(weiter,b.periode());
        }
        int geschrieben=0;
        for (LocalDate tag:tage) {
            Instant von=tag.atStartOfDay(b.zone()).toInstant();
            Instant bis=naechste(tag,b.periode()).atStartOfDay(b.zone()).toInstant();
            if (bis.isAfter(jetzt)) continue;
            Instant frist=TagRegeln.endgueltigAb(bis);
            Instant datenBis=jetzt.isBefore(frist) ? jetzt : frist;
            var alt=j.query("SELECT fassung,betrag,kennzeichen,kanal_herkunft FROM bezugsgroesse_wert "
                    + "WHERE tenant_id=? AND bezugsgroesse_id=? AND periode_von=? ORDER BY fassung DESC LIMIT 1",
                    (r,n)->new Object[]{r.getInt(1),r.getBigDecimal(2),r.getString(3),r.getString(4)},b.tenant(),b.bezug(),tag);
            if (!alt.isEmpty() && alt.getFirst()[3]!=null && !json.readTree((String)alt.getFirst()[3]).path("vorlaeufig").asBoolean()) continue;
            List<Bindung> teile=bindungen.stream().filter(k -> k.von().isBefore(bis) && (k.bis()==null || k.bis().isAfter(von)))
                .sorted(Comparator.comparing(Bindung::von)).toList();
            Ergebnis e=periode(j,con,teile,von,bis,datenBis);
            Bindung quelle=teile.getFirst();
            List<String> kennzeichen=new ArrayList<>(e.kennzeichen());
            for (Bindung k:teile) kennzeichen.add("aus Messkanal " + k.kanal() + (" (" + regel(k) + ")"));
            ObjectNode herkunft=json.createObjectNode().put("bindung",quelle.id().toString()).put("entity_id",quelle.entity().toString())
                .put("kanal",quelle.kanal()).put("regel",regel(quelle))
                .put("zustand",e.zustand()).put("abdeckung_prozent",e.abdeckung()).put("endgueltig_ab",frist.toString())
                .put("vorlaeufig",jetzt.isBefore(frist));
            if (teile.size()>1) {
                var quellen=herkunft.putArray("bindungen");
                for (Bindung k:teile) {
                    var teil=quellen.addObject().put("bindung",k.id().toString()).put("entity_id",k.entity().toString())
                        .put("kanal",k.kanal()).put("zustand",k.zustand()).put("von",k.von().toString()).put("bis",k.bis()==null?null:k.bis().toString());
                    if ("gauge".equals(k.art())) teil.put("regel",regel(k));
                }
            }
            String kz=json.writeValueAsString(kennzeichen.stream().distinct().toList());
            if (!alt.isEmpty() && gleich((BigDecimal)alt.getFirst()[1],e.betrag())
                    && json.readTree((String)alt.getFirst()[2]).equals(json.readTree(kz))
                    && json.readTree(herkunft.toString()).equals(json.readTree((String)alt.getFirst()[3]))) continue;
            int f=alt.isEmpty() ? 1 : (int)alt.getFirst()[0]+1;
            j.update("INSERT INTO bezugsgroesse_wert (tenant_id,bezugsgroesse_id,wertart,einheit,periode_art,"
                + "periode_von,periode_bis,zeitzone,fassung,ersetzt_fassung,vorgang,status,betrag,begruendung,"
                + "herkunft_art,kennzeichen,actor_name,actor_art,kanal_herkunft) "
                + "VALUES (?,?,'periodenwert',?,?,?,?,?,?,?,?,'wirksam',?,?,'messkanal',?::jsonb,'Ableitung','voltpilot',?::jsonb)",
                b.tenant(),b.bezug(),b.einheit(),b.periode(),tag,naechste(tag,b.periode()).minusDays(1),b.zone().getId(),
                f,f==1 ? null : f-1,f==1 ? "erstwert" : "berichtigung",e.betrag(),
                f==1 ? null : "Messkanal: Periode nach neuen Messwerten oder Fristablauf neu gebildet.",kz,herkunft.toString());
            geschrieben++;
        }
        // AP-08 meldet echte Spätankünfte idempotent und übergibt sie an IP-14, ohne endgültige Werte zu ändern.
        var spaet=j.query("SELECT DISTINCT time_bucket('15 minutes',time) FROM device_measurement_sample "
            + "WHERE tenant_id=? AND entity_id=? AND point_key=? AND time>=? AND (?::timestamptz IS NULL OR time"
            + ("counter".equals(b.art()) ? "<=" : "<") + "?) "
            + "AND received_at>? AND received_at<=? AND received_at>time_bucket('15 minutes',time)+interval '7 days 15 minutes' "
            + "AND role IS DISTINCT FROM 'spiegel'",(r,n)->r.getTimestamp(1).toInstant(),b.tenant(),b.entity(),b.kanal(),
            ts(b.von()),ts(b.bis()),ts(b.bis()),ts(eingang.minus(Duration.ofMinutes(2))),ts(jetzt));
        SpaetankunftMelder melder=new SpaetankunftMelder();
        for (Instant slot:spaet) melder.melden(con,b.tenant(),b.entity(),b.kanal(),slot);
        j.update("INSERT INTO bezugsgroesse_kanallauf (tenant_id,bindung_id,naechster_tag,eingang) VALUES (?,?,?,?) "
            + "ON CONFLICT (tenant_id,bindung_id) DO UPDATE SET naechster_tag=excluded.naechster_tag,eingang=excluded.eingang",
            b.tenant(),b.id(),weiter,ts(jetzt));
        return geschrieben;
    }

    /** Ein Bindungswechsel innerhalb einer Periode addiert nur disjunkte gemessene Abschnitte. */
    private Ergebnis periode(JdbcTemplate j,Connection con,List<Bindung> teile,Instant von,Instant bis,Instant eingang) throws Exception {
        BigDecimal betrag=null,abgedeckt=BigDecimal.ZERO;
        long gebunden=0,laenge=Duration.between(von,bis).toSeconds();
        boolean voll=true;
        List<String> kennzeichen=new ArrayList<>();
        for (Bindung k:teile) {
            Instant a=k.von().isAfter(von)?k.von():von;
            Instant z=k.bis()!=null && k.bis().isBefore(bis)?k.bis():bis;
            Ergebnis e=rechne(j,con,k,a,z,eingang);
            long dauer=Duration.between(a,z).toSeconds();
            gebunden+=dauer;
            if (e.betrag()!=null) betrag=betrag==null?e.betrag():betrag.add(e.betrag());
            abgedeckt=abgedeckt.add(e.abdeckung().multiply(BigDecimal.valueOf(dauer)));
            voll &= VerbrauchRegeln.VOLLSTAENDIG.equals(e.zustand());
            kennzeichen.addAll(e.kennzeichen());
        }
        if (gebunden<laenge) { voll=false; kennzeichen.add("Kanalbindung gilt nur für einen Teil der Periode"); }
        // Erst NACH der Heizgrenze und Summe auf die bestehende NUMERIC(18,6)-Speicherung runden.
        // Sonst würde ein periodischer Bruch bei jedem Takt scheinbar eine neue Fassung verlangen.
        if (betrag!=null && teile.stream().anyMatch(k->"gauge".equals(k.art())))
            betrag=betrag.setScale(6,java.math.RoundingMode.HALF_UP);
        return new Ergebnis(betrag,betrag==null?VerbrauchRegeln.KEINE_WERTE:voll?VerbrauchRegeln.VOLLSTAENDIG:VerbrauchRegeln.UNVOLLSTAENDIG,
            abgedeckt.divide(BigDecimal.valueOf(laenge),1,java.math.RoundingMode.HALF_UP).min(BigDecimal.valueOf(100)),
            kennzeichen.stream().distinct().toList());
    }

    private Ergebnis rechne(JdbcTemplate j,Connection con,Bindung b,Instant von,Instant bis,Instant eingang) throws Exception {
        Instant a=von.isBefore(b.von()) ? b.von() : von;
        Instant z=b.bis()!=null && b.bis().isBefore(bis) ? b.bis() : bis;
        // Ein Vorgänger ist bei Ereignis-Kanälen der letzte Zustandswechsel, nicht ein künstlicher Messpunkt.
        List<Roh> roh=j.query("""
            SELECT DISTINCT ON (time) time,coalesce(decoded_numeric,raw_numeric),coalesce(decoded_text,raw_text),quality,device_install_id
            FROM device_measurement_sample WHERE tenant_id=? AND entity_id=? AND point_key=?
              AND role IS DISTINCT FROM 'spiegel' AND received_at<=? AND time>=coalesce(
                (SELECT max(time) FROM device_measurement_sample WHERE tenant_id=? AND entity_id=? AND point_key=?
                   AND role IS DISTINCT FROM 'spiegel' AND received_at<=? AND time<=?),?) AND time<=?
            ORDER BY time,received_at DESC
            """,(r,n)->new Roh(r.getTimestamp(1).toInstant(),r.getBigDecimal(2),r.getString(3)!=null ? r.getString(3) : r.getBigDecimal(2)==null ? null : r.getBigDecimal(2).stripTrailingZeros().toPlainString(),
                "good".equals(r.getString(4)),r.getObject(5,UUID.class)),b.tenant(),b.entity(),b.kanal(),ts(eingang),
                b.tenant(),b.entity(),b.kanal(),ts(eingang),ts(a),ts(a),ts(z));
        List<BezugsdatenRegeln.Luecke> luecken=new ArrayList<>();
        if (a.isAfter(von)) luecken.add(new BezugsdatenRegeln.Luecke(von,a,"vor Kanalbindung"));
        if (z.isBefore(bis)) luecken.add(new BezugsdatenRegeln.Luecke(z,bis,"nach Kanalbindung"));
        luecken.addAll(j.query("SELECT greatest(von,?),least(bis,?),coalesce(nutzlast->>'quelle','Kanal ohne Werte') "
            + "FROM (SELECT DISTINCT ON (ereignis_id) * FROM messreihe_ereignis WHERE tenant_id=? AND art='data_gap' AND eingang<=? ORDER BY ereignis_id,eingang DESC) e WHERE von<? AND (bis IS NULL OR bis>?) "
            + "AND ((entity_id=? AND (messkanal IS NULL OR messkanal=?)) OR (entity_id IS NULL AND device_id IN "
            + "(SELECT DISTINCT device_id FROM device_measurement_sample WHERE tenant_id=? AND entity_id=? AND point_key=? AND time>=? AND time<=?)))",
            (r,n)->new BezugsdatenRegeln.Luecke(r.getTimestamp(1).toInstant(),r.getTimestamp(2).toInstant(),r.getString(3)),
            ts(a),ts(z),b.tenant(),ts(eingang),ts(z),ts(a),b.entity(),b.kanal(),b.tenant(),b.entity(),b.kanal(),ts(a),ts(z)));
        if ("gauge".equals(b.art())) {
            List<GradtagRegeln.Tag> tage=new ArrayList<>();
            BigDecimal abgedeckt=BigDecimal.ZERO;
            var werteJeTag=roh.stream().map(r->new VerbrauchRegeln.Rohwert(r.zeit(),r.zahl(),r.gut() && r.zahl()!=null
                && luecken.stream().noneMatch(l->!r.zeit().isBefore(l.von()) && r.zeit().isBefore(l.bis()))))
                .collect(java.util.stream.Collectors.groupingBy(r->r.zeit().atZone(b.zone()).toLocalDate()));
            for (LocalDate tag=a.atZone(b.zone()).toLocalDate(); tag.atStartOfDay(b.zone()).toInstant().isBefore(z); tag=tag.plusDays(1)) {
                Instant start=tag.atStartOfDay(b.zone()).toInstant(), ende=tag.plusDays(1).atStartOfDay(b.zone()).toInstant();
                // Ein angeschnittener Kalendertag ist kein gemessener ganzer Tag.
                if (start.isBefore(a) || ende.isAfter(z)) {
                    tage.add(new GradtagRegeln.Tag(null,VerbrauchRegeln.KEINE_WERTE)); continue;
                }
                var tageswerte=werteJeTag.getOrDefault(tag,List.of());
                var m=VerbrauchRegeln.momentanwerte(tageswerte,start,ende,Duration.ofSeconds(b.kadenz()),false);
                // AP-08 rundet sein Anzeigemittel auf 0,1. Die Heizgrenze darf diese Rundung nicht verschieben.
                var gute=tageswerte.stream().filter(VerbrauchRegeln.Rohwert::gut).map(VerbrauchRegeln.Rohwert::wert).toList();
                BigDecimal mittel=gute.isEmpty()?null:gute.stream().reduce(BigDecimal.ZERO,BigDecimal::add)
                    .divide(BigDecimal.valueOf(gute.size()),new java.math.MathContext(28,java.math.RoundingMode.HALF_EVEN));
                boolean luecke=luecken.stream().anyMatch(l->l.von().isBefore(ende) && l.bis().isAfter(start));
                tage.add(new GradtagRegeln.Tag(mittel,luecke && mittel!=null ? VerbrauchRegeln.UNVOLLSTAENDIG : m.zustand()));
                abgedeckt=abgedeckt.add(BigDecimal.valueOf(m.abdeckungProzent()==null ? 0 : m.abdeckungProzent())
                    .multiply(BigDecimal.valueOf(Duration.between(start,ende).toSeconds())));
            }
            var g=GradtagRegeln.gradtage(tage,b.raumtemperatur(),b.heizgrenze());
            return new Ergebnis(g.betrag(),g.zustand(),abgedeckt.divide(BigDecimal.valueOf(Duration.between(a,z).toSeconds()),1,java.math.RoundingMode.HALF_UP),g.kennzeichen());
        }
        if ("state".equals(b.art())) {
            String anfang=null;
            List<BezugsdatenRegeln.Zustandswechsel> wechsel=new ArrayList<>();
            for (int i=0;i<roh.size();i++) {
                Roh r=roh.get(i);
                if (!r.gut() || r.wort()==null) {
                    luecken.add(new BezugsdatenRegeln.Luecke(r.zeit().isBefore(a)?a:r.zeit(),i+1<roh.size()?roh.get(i+1).zeit():z,"ungültiger Messwert"));
                } else if (!r.zeit().isAfter(von) && !a.isAfter(von)) anfang=r.wort();
                else wechsel.add(new BezugsdatenRegeln.Zustandswechsel(r.zeit().isBefore(a)?a:r.zeit(),r.wort()));
            }
            var k=BezugsdatenRegeln.kanal(von,bis,b.zustand(),anfang,wechsel,luecken,b.zone());
            return new Ergebnis(k.betrag()==null ? null : "min".equals(b.einheit()) ? BigDecimal.valueOf(k.minutenImZustand()) : k.betrag(),k.zustand(),k.abdeckungProzent(),k.kennzeichen());
        }
        var deklaration=ZaehlerDeklaration.lesen(con,b.tenant(),b.entity(),b.kanal(),a);
        List<VerbrauchRegeln.Ereignis> ereignisse=new ArrayList<>(j.query("SELECT art,zeit,nutzlast->>'endstand',nutzlast->>'anfangsstand',nutzlast->>'verlust_s' "
            + "FROM messreihe_ereignis WHERE tenant_id=? AND ((entity_id=? AND (messkanal IS NULL OR messkanal=?)) "
            + "OR (art='device_restart' AND data_source_id=(SELECT data_source_id FROM measurement_point WHERE tenant_id=? AND id=?))) "
            + "AND zeit>? AND zeit<=? AND eingang<=? AND art IN ('device_boundary','device_restart')",
            (r,n)->new VerbrauchRegeln.Ereignis(r.getString(1),r.getTimestamp(2).toInstant(),zahl(r.getString(3)),zahl(r.getString(4)),
                r.getString(5)==null ? deklaration.neustartVerlust() : Long.parseLong(r.getString(5))),b.tenant(),b.entity(),b.kanal(),b.tenant(),b.entity(),ts(a),ts(z),ts(eingang)));
        for (int i=1;i<roh.size();i++) {
            Roh r=roh.get(i),vor=roh.get(i-1);
            if (!Objects.equals(r.einbau(),vor.einbau()) && ereignisse.stream().noneMatch(e->e.zeit().equals(r.zeit())))
                ereignisse.add(new VerbrauchRegeln.Ereignis("device_boundary",r.zeit(),null,null,0));
        }
        var k=VerbrauchRegeln.mengeZaehlerstand(new ReihenKontext(b.quellEinheit(),b.zone()),
            roh.stream().map(r->new VerbrauchRegeln.Rohwert(r.zeit(),r.zahl(),r.gut()&&r.zahl()!=null)).toList(),
            a,z,Duration.ofSeconds(b.kadenz()),ereignisse,BigDecimal.ONE,deklaration.modulFuer(Duration.ofSeconds(b.kadenz())),deklaration.hoechstzuwachsFuer(Duration.ofSeconds(b.kadenz())));
        boolean teil=a.isAfter(von)||z.isBefore(bis);
        List<String> kz=new ArrayList<>(k.kennzeichen());
        if (teil) kz.add("Kanalbindung gilt nur für einen Teil der Periode");
        BigDecimal ab=BigDecimal.valueOf(k.abdeckungProzent()==null ? 0 : k.abdeckungProzent());
        if (teil) ab=ab.multiply(BigDecimal.valueOf(Duration.between(a,z).toSeconds())).divide(BigDecimal.valueOf(Duration.between(von,bis).toSeconds()),1,java.math.RoundingMode.DOWN);
        BigDecimal betrag=k.menge()==null ? null : BezugsEinheit.einheit(k.menge(),b.quellEinheit(),b.einheit(),
            new BezugsgroesseRepository(j).vokabular().einheiten(),BezugsEinheit.UMRECHNUNGEN).betrag();
        return new Ergebnis(betrag,teil && k.menge()!=null ? VerbrauchRegeln.UNVOLLSTAENDIG : k.zustand(),ab,kz);
    }
    private static String regel(Bindung b) {
        return "gauge".equals(b.art()) ? GradtagRegeln.regel(b.raumtemperatur(),b.heizgrenze())
            : "state".equals(b.art()) ? "Zustand = " + b.zustand() : "Zähler";
    }
    static LocalDate anfang(LocalDate tag,String art) {
        return switch(art) { case "woche" -> tag.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY)); case "monat" -> tag.withDayOfMonth(1); case "jahr" -> tag.withDayOfYear(1); default -> tag; };
    }
    static LocalDate naechste(LocalDate tag,String art) {
        return switch(art) { case "woche" -> tag.plusWeeks(1); case "monat" -> tag.plusMonths(1); case "jahr" -> tag.plusYears(1); default -> tag.plusDays(1); };
    }
    private static Timestamp ts(Instant i) { return i==null ? null : Timestamp.from(i); }
    private static Instant instant(ResultSet r,String c) throws SQLException { return r.getTimestamp(c)==null ? null : r.getTimestamp(c).toInstant(); }
    private static BigDecimal zahl(String s) { return s==null ? null : new BigDecimal(s); }
    private static boolean gleich(BigDecimal a,BigDecimal b) { return a==null ? b==null : b!=null && a.compareTo(b)==0; }
}
