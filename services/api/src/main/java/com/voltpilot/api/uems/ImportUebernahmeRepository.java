package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.BezugsdatenImportDto;
import com.voltpilot.api.web.dto.BezugsdatenVorlageDto;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** Append-only Schreibweg für C6/C7. Jeder Aufruf gehört zur Transaktion des Dienstes. */
@Repository
public class ImportUebernahmeRepository {
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    private final BezugsgroesseRepository zones;

    public ImportUebernahmeRepository(JdbcTemplate jdbc, ObjectMapper json, BezugsgroesseRepository zones) {
        this.jdbc = jdbc;
        this.json = json;
        this.zones = zones;
    }

    /** Ein normalisierter Auftrag mit dem erwarteten Stand; keine gelieferte Datei. */
    public record Aenderung(UUID id, LocalDate von, LocalDate bis, Instant zeitpunkt, String zone,
            int vorher, BigDecimal betrag, String vorgang, int zeile, String geliefert, String einheit,
            List<String> kennzeichen) {}
    public record Freigabe(int fassung, String status, String grund, boolean ruecknahme,
            List<Aenderung> auftrag, ProtokollAkteur wer) {}

    public String kennung(UUID tenant) {
        return MessreiheFassungen.naechsteKennung(jdbc, "bezugsdaten_import", "I", tenant, ZoneId.of("Europe/Berlin"));
    }

    public void importSchreiben(UUID tenant, String kennung, BezugsdatenImportDto.Vorschau v,
            BezugsdatenRegeln.Importergebnis e, String grund, ProtokollAkteur wer, List<String> urteile, List<CsvLeser.Zeile> roh) {
        var d = v.datei();
        var z = e.zaehler();
        jdbc.update("INSERT INTO bezugsdaten_import (tenant_id,kennung,fassung,status,datei_name,datei_bytes,"
                + "datei_sha256,kodierung,trennzeichen,kopfzeile,zeilen,neu,wiederholung,konflikt,berichtigung,"
                + "uebersprungen,abgelehnt,mit_hinweis,aenderungen,befunde,begruendung,actor_sub,actor_name,actor_rolle,actor_art,vorlage_id,vorlage_fassung) "
                + "VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?,?,?,?,?,?,?)",
                tenant, kennung, e.status(), d.name() == null || d.name().isBlank() ? "Import.csv" : d.name(), d.bytes(), d.sha256(),
                d.kodierung(), d.trennzeichen(), d.kopfzeile(), z.zeilen(), z.neu(), z.wiederholung(), z.konflikt(),
                z.berichtigung(), z.uebersprungen(), z.abgelehnt(), z.mitHinweis(), e.aenderungen(),
                json(e.befunde()), grund, wer.sub(), wer.name(), wer.rolle(), wer.art(),
                v.vorlage()==null ? null : v.vorlage().vorlageId(), v.vorlage()==null ? null : v.vorlage().fassung());
        Map<Integer,String> zeilentexte=roh.stream().collect(java.util.stream.Collectors.toMap(CsvLeser.Zeile::nr,CsvLeser.Zeile::text));
        for (int i = 0; i < v.zeilen().size(); i++) {
            var r = v.zeilen().get(i);
            jdbc.update("INSERT INTO bezugsdaten_import_zeile (tenant_id,import_kennung,nr,text,urteil,befunde,"
                    + "bezugsgroesse_id,bezugsgroesse_kennzeichen,periode_von,periode_bis,zeitpunkt,zeitzone,betrag,"
                    + "einheit,geliefert_wert,geliefert_einheit,fingerabdruck) VALUES (?,?,?,?,?,?::jsonb,?,?,?,?,?,?,?,?,?,?,?)",
                    tenant, kennung, r.nr(), zeilentexte.get(r.nr()), urteile.get(i),
                    json(r.befunde().stream().map(BezugsdatenImportDto.Befund::befund).toList()),
                    r.bezugsgroesseId(), r.bezugsgroesse(), r.periodeVon(), r.periodeBis(),
                    r.zeitpunkt() == null ? null : Timestamp.from(r.zeitpunkt().toInstant()),
                    r.fingerabdruck() == null ? null : zone(r.bezugsgroesseId()),
                    r.betrag() == null ? null : new BigDecimal(r.betrag()), r.einheit(),
                    r.geliefert() == null ? null : r.geliefert().wert(),
                    r.geliefert() == null ? null : r.geliefert().einheit(), r.fingerabdruck());
        }
    }

    private String zone(UUID id) {
        // The caller supplies the actual zone for values. This archive column also uses the authoritative resolver.
        return zones.zeitzone(id);
    }

    public void wert(UUID tenant, String kennung, Aenderung a, String grund, ProtokollAkteur wer,
            ProtokollAkteur freigeber, BezugsgroesseRepository.Zeile b) {
        jdbc.update("INSERT INTO bezugsgroesse_wert (tenant_id,bezugsgroesse_id,wertart,einheit,periode_art,periode_von,"
                + "periode_bis,zeitpunkt,zeitzone,fassung,ersetzt_fassung,vorgang,status,betrag,begruendung,herkunft_art,"
                + "import_kennung,import_zeile,geliefert_text,geliefert_einheit,kennzeichen,actor_sub,actor_name,actor_rolle,"
                + "actor_art,freigeber_sub,freigeber_name,freigeber_rolle,freigeber_art) "
                + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'import',?,?,?,?,?::jsonb,?,?,?,?,?,?,?,?)",
                tenant,b.id(),b.wertart(),b.einheit(),b.periodeArt(),a.von(),a.bis(),
                a.zeitpunkt() == null ? null : Timestamp.from(a.zeitpunkt()),a.zone(),a.vorher()+1,
                a.vorher() == 0 ? null : a.vorher(),a.vorgang(),a.betrag() == null ? "zurueckgenommen" : "wirksam",
                a.betrag(),grund,kennung,a.zeile(),a.geliefert(),a.einheit(),json(a.kennzeichen()),
                wer.sub(),wer.name(),wer.rolle(),wer.art(),freigeber == null ? null : freigeber.sub(),
                freigeber == null ? null : freigeber.name(),freigeber == null ? null : freigeber.rolle(),
                freigeber == null ? null : freigeber.art());
    }

    public BezugsdatenVorlageDto.Verweis vorlage(String kennung) {
        return jdbc.query("SELECT i.vorlage_id,i.vorlage_fassung,v.name FROM bezugsdaten_import i "
                + "JOIN bezugsdaten_vorlage v ON v.tenant_id=i.tenant_id AND v.vorlage_id=i.vorlage_id "
                + "AND v.fassung=i.vorlage_fassung WHERE i.kennung=? AND i.fassung=1",
                (r,n) -> new BezugsdatenVorlageDto.Verweis(r.getObject(1,UUID.class),r.getInt(2),r.getString(3)),kennung)
                .stream().findFirst().orElse(null);
    }

    public List<Map<String,Object>> importFassungen(String kennung) {
        return jdbc.queryForList("SELECT * FROM bezugsdaten_import WHERE kennung=? ORDER BY fassung", kennung);
    }

    /** Erstfassung mit Dateibeleg und jüngster Statusfassung, mandantenweit für das Import-Protokoll. */
    public List<Map<String,Object>> importe(UUID tenant) {
        return jdbc.queryForList("SELECT e.*,l.status AS aktueller_status,l.begruendung AS aktuelle_begruendung,"+
                "l.actor_name AS aktueller_actor_name,l.created_at AS geaendert_am FROM bezugsdaten_import e " +
                "JOIN LATERAL (SELECT status,begruendung,actor_name,created_at FROM bezugsdaten_import l " +
                "WHERE l.tenant_id=e.tenant_id AND l.kennung=e.kennung ORDER BY fassung DESC LIMIT 1) l ON true " +
                "WHERE e.tenant_id=? AND e.fassung=1 ORDER BY e.created_at DESC,e.kennung DESC", tenant);
    }

    /** Die unveränderlichen Urteile und Befunde der Datenzeilen eines Imports. */
    public List<Map<String,Object>> importZeilen(String kennung) {
        return jdbc.queryForList("SELECT * FROM bezugsdaten_import_zeile WHERE import_kennung=? ORDER BY nr", kennung);
    }

    public void zurueckgenommen(UUID tenant, String kennung, String grund, ProtokollAkteur wer) {
        jdbc.update("INSERT INTO bezugsdaten_import (tenant_id,kennung,fassung,status,begruendung,actor_sub,actor_name,actor_rolle,actor_art) "
                + "VALUES (?,?,(SELECT max(fassung)+1 FROM bezugsdaten_import WHERE kennung=?),'zurueckgenommen',?,?,?,?,?)",
                tenant,kennung,kennung,grund,wer.sub(),wer.name(),wer.rolle(),wer.art());
    }

    public List<UUID> importZiele(String kennung) {
        return jdbc.queryForList("SELECT DISTINCT bezugsgroesse_id FROM bezugsdaten_import_zeile WHERE import_kennung=? AND bezugsgroesse_id IS NOT NULL",UUID.class,kennung);
    }

    public List<UUID> ziele(String kennung) {
        return jdbc.queryForList("SELECT DISTINCT bezugsgroesse_id FROM bezugsgroesse_wert WHERE import_kennung=?", UUID.class, kennung);
    }

    public Freigabe freigabe(String kennung) {
        return jdbc.query("SELECT * FROM bezugsdaten_import_freigabe WHERE kennung=? ORDER BY fassung DESC LIMIT 1",
                (r,n) -> new Freigabe(r.getInt("fassung"), r.getString("status"), r.getString("grund"), r.getBoolean("ruecknahme"),
                    lesen(r.getString("auftrag")),new ProtokollAkteur(r.getString("actor_sub"),r.getString("actor_name"),
                    r.getString("actor_rolle"),r.getString("actor_art"))),kennung).stream().findFirst().orElse(null);
    }

    public void vorschlag(UUID tenant, String kennung, String grund, boolean ruecknahme, List<Aenderung> a, ProtokollAkteur wer) {
        Freigabe alt = freigabe(kennung);
        entscheidung(tenant,kennung,alt == null ? 1 : alt.fassung()+1,"vorschlag",grund,ruecknahme,a,wer);
    }

    public void entscheidung(UUID tenant,String kennung,int fassung,String status,String grund,boolean ruecknahme,
            List<Aenderung> a,ProtokollAkteur wer) {
        jdbc.update("INSERT INTO bezugsdaten_import_freigabe (tenant_id,kennung,fassung,status,grund,ruecknahme,auftrag,actor_sub,actor_name,actor_rolle,actor_art) "
                + "VALUES (?,?,?,?,?,?,?::jsonb,?,?,?,?)",tenant,kennung,fassung,status,grund,ruecknahme,json(a),wer.sub(),wer.name(),wer.rolle(),wer.art());
    }

    public boolean offen(UUID id, LocalDate von, Instant zeitpunkt) {
        return jdbc.queryForList("SELECT f.auftrag::text FROM bezugsdaten_import_freigabe f WHERE f.status='vorschlag' "
                + "AND NOT EXISTS (SELECT 1 FROM bezugsdaten_import_freigabe n WHERE n.tenant_id=f.tenant_id "
                + "AND n.kennung=f.kennung AND n.fassung>f.fassung)",String.class).stream().flatMap(s -> lesen(s).stream())
                .anyMatch(a -> a.id().equals(id) && java.util.Objects.equals(a.von(),von) && java.util.Objects.equals(a.zeitpunkt(),zeitpunkt));
    }

    public List<MessreiheFassungen.Fassung> fassungen(UUID tenant, String kennung) {
        return MessreiheFassungen.fassungen(jdbc,"bezugsdaten_import_freigabe",tenant,kennung);
    }
    private List<Aenderung> lesen(String text) {
        try { return json.readValue(text,new TypeReference<List<Aenderung>>() {}); }
        catch (Exception e) { throw new IllegalStateException(e); }
    }
    private String json(Object value) {
        try { return json.writeValueAsString(value); }
        catch (Exception e) { throw new IllegalStateException(e); }
    }
}
