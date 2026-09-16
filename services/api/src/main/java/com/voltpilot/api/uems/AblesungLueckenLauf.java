package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.sql.Connection;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.stereotype.Component;

/** Z7: monatliches Soll, Lücke erst strikt nach zwei Kalendermonaten; kein erfundener Messwert. */
@Component
public class AblesungLueckenLauf {
    private static final ObjectMapper JSON=new ObjectMapper();
    private final JdbcTemplate admin;
    public AblesungLueckenLauf(@Qualifier("adminJdbcTemplate") JdbcTemplate admin) { this.admin=admin; }
    record Quelle(UUID tenant,UUID id,UUID messstelle,String kennzeichen) {}

    public int lauf(Instant jetzt) {
        List<Quelle> quellen=admin.query("SELECT q.tenant_id,q.id,q.messstelle_id,m.kennzeichen FROM messstelle_quelle q "
                + "JOIN messstelle m ON m.id=q.messstelle_id AND m.tenant_id=q.tenant_id "
                + "WHERE q.art='ablesung' AND q.gueltig_bis IS NULL AND m.archiviert_am IS NULL",
                (rs,n)->new Quelle(rs.getObject(1,UUID.class),rs.getObject(2,UUID.class),rs.getObject(3,UUID.class),rs.getString(4)));
        int zahl=0;
        for (Quelle q:quellen) zahl+=admin.execute((Connection con)->{
            boolean auto=con.getAutoCommit(); con.setAutoCommit(false);
            try {
                JdbcTemplate db=new JdbcTemplate(new SingleConnectionDataSource(con,true));
                AblesungRepository r=new AblesungRepository(db);
                r.sperren(q.tenant(),q.messstelle());
                var werte=r.werte(q.tenant(),q.id());
                MessreiheEreignisRepository events=new MessreiheEreignisRepository(db);
                int anzahl=0;
                for (int i=0;i<werte.size();i++) {
                    Instant letzte=werte.get(i).zeitpunkt();
                    Instant faellig=AblesungRegeln.ueberfaelligAb(letzte,r.zone(q.tenant(),q.messstelle(),letzte).id());
                    Instant ende=i+1<werte.size()?werte.get(i+1).zeitpunkt():null;
                    if (!jetzt.isAfter(faellig) || (ende!=null && !ende.isAfter(faellig))) continue;
                    UUID id=UUID.nameUUIDFromBytes(("ablesung-luecke:"+q.tenant()+":"+q.id()+":"+letzte)
                            .getBytes(java.nio.charset.StandardCharsets.UTF_8));
                    ObjectNode e=JSON.createObjectNode().put("ereignis_id",id.toString()).put("art","data_gap")
                            .put("von",faellig.toString()).put("messstelle",q.messstelle().toString()).put("erkannt_aus","kadenz");
                    if (ende==null) e.putNull("bis"); else e.put("bis",ende.toString());
                    var aus=events.anhaengen(q.tenant(),null,EreignisVokabular.Urheber.CLOUD,e,null,jetzt);
                    if (aus.ausgang()==MessreiheEreignisRepository.Ausgang.VERWORFEN)
                        throw new IllegalStateException("Ablesungs-Lücke: "+aus);
                    if (aus.ausgang()==MessreiheEreignisRepository.Ausgang.ANGEHAENGT) anzahl++;
                }
                con.commit(); return anzahl;
            } catch (Exception e) { con.rollback(); throw e; }
            finally { con.setAutoCommit(auto); }
        });
        return zahl;
    }
}
