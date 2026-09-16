package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Ablesezeiträume nach Z6 in der vorhandenen Perioden-/Versionsklasse, nie in Tagesrastern. */
@Component
public class AblesungPerioden {
    private final JdbcTemplate jdbc;
    private static final ObjectMapper JSON = new ObjectMapper();
    public AblesungPerioden(JdbcTemplate jdbc) { this.jdbc = jdbc; }
    record Summe(BigDecimal menge, List<String> kennzeichen) {}

    public void bilden(UUID tenant, MessstelleRepository.Messstelle m, AblesungRepository.Zone zone,
            List<AblesungRepository.Wert> werte, String korrektur, int korrekturFassung, Instant jetzt) {
        Map<LocalDate, Summe> monate = new TreeMap<>();
        for (int i = 1; i < werte.size(); i++) {
            var a = werte.get(i - 1);
            var b = werte.get(i);
            if (b.monat() == null) continue;
            var z = AblesungRegeln.zeitraum(a.zeitpunkt(), a.stand(), b.zeitpunkt(), b.stand(),
                    m.hauptgroesse().einheit(), zone.id());
            Summe alt = monate.get(b.monat());
            List<String> hinweise = new ArrayList<>(alt == null ? List.of() : alt.kennzeichen());
            hinweise.add(z.kennzeichen());
            monate.put(b.monat(), new Summe((alt == null ? BigDecimal.ZERO : alt.menge()).add(z.menge()), hinweise));
        }
        // Eine entfernte Zuordnung bekommt eine weitere Version „keine Werte“; Version 1 bleibt.
        jdbc.queryForList("SELECT tag FROM messreihe_periode WHERE tenant_id = ? AND messstelle_id = ? "
                + "AND ablesung = true AND art = 'monat'", LocalDate.class, tenant, m.id())
                .forEach(tag -> monate.putIfAbsent(tag, new Summe(null, List.of("Ablesezeitraum ohne Monatszuordnung"))));
        Map<LocalDate, Summe> jahre = new TreeMap<>();
        Map<LocalDate, Integer> anzahl = new LinkedHashMap<>();
        for (var e : monate.entrySet()) {
            speichern(tenant, m.id(), "monat", e.getKey(), zone, e.getValue(), e.getValue().menge() == null
                    ? "keine Werte" : "vollständig", korrektur, korrekturFassung, jetzt);
            LocalDate jahr = e.getKey().withDayOfYear(1);
            jahre.putIfAbsent(jahr, new Summe(null, new ArrayList<>()));
            if (e.getValue().menge() != null) {
                Summe a = jahre.get(jahr);
                List<String> k = new ArrayList<>(a.kennzeichen());
                k.addAll(e.getValue().kennzeichen());
                jahre.put(jahr, new Summe((a.menge() == null ? BigDecimal.ZERO : a.menge()).add(e.getValue().menge()), k));
                anzahl.merge(jahr, 1, Integer::sum);
            }
        }
        jahre.forEach((tag, s) -> speichern(tenant, m.id(), "jahr", tag, zone, s,
                s.menge() == null ? "keine Werte" : anzahl.getOrDefault(tag, 0) == 12 ? "vollständig" : "unvollständig",
                korrektur, korrekturFassung, jetzt));
    }

    private void speichern(UUID tenant, UUID m, String art, LocalDate tag, AblesungRepository.Zone zone,
            Summe s, String zustand, String korrektur, int korrekturFassung, Instant jetzt) {
        Instant von = tag.atStartOfDay(zone.id()).toInstant();
        Instant bis = (art.equals("monat") ? tag.plusMonths(1) : tag.plusYears(1)).atStartOfDay(zone.id()).toInstant();
        List<Map<String, Object>> bisher = jdbc.queryForList("SELECT menge,menge_zustand,kennzeichen::text,version "
                + "FROM (SELECT menge,menge_zustand,kennzeichen,version FROM messreihe_periode "
                + "WHERE tenant_id = ? AND messstelle_id = ? AND art = ? AND tag = ? "
                + "UNION ALL SELECT menge,menge_zustand,kennzeichen,version FROM messreihe_periode_version "
                + "WHERE tenant_id = ? AND messstelle_id = ? AND ebene = ? AND tag = ?) v ORDER BY version DESC LIMIT 1",
                tenant, m, art, tag, tenant, m, art, tag);
        String k = JSON.valueToTree(s.kennzeichen()).toString();
        if (bisher.isEmpty()) {
            jdbc.update("INSERT INTO messreihe_periode (tenant_id,messstelle_id,art,tag,zeitzone,zeitzone_herkunft,"
                    + "beginn,ende,stunden,wertart,menge,menge_zustand,kennzeichen,zustand,endgueltig_ab,ablesung) "
                    + "VALUES (?,?,?,?,?,?,?,?,?,'counter',?,?,?::jsonb,'endgueltig',?,true)",
                    tenant,m,art,tag,zone.id().getId(),zone.herkunft(),Timestamp.from(von),Timestamp.from(bis),
                    Duration.between(von,bis).toHours(),s.menge(),zustand,k,Timestamp.from(TagRegeln.endgueltigAb(bis)));
            return;
        }
        var alt = bisher.get(0);
        BigDecimal menge = (BigDecimal) alt.get("menge");
        if ((menge == null ? s.menge() == null : s.menge() != null && menge.compareTo(s.menge()) == 0)
                && Objects.equals(alt.get("menge_zustand"), zustand)
                && AblesungRepository.json(alt.get("kennzeichen").toString()).equals(AblesungRepository.json(k))) return;
        if (korrektur == null) throw new IllegalStateException("Eine bestehende Ablesungsperiode braucht eine Korrektur");
        jdbc.update("INSERT INTO messreihe_periode_version (tenant_id,messstelle_id,ebene,tag,periode_beginn,"
                + "periode_ende,zeitzone,version,wertart,menge,menge_zustand,kennzeichen,zustand,korrekturen,ersatzwerte,"
                + "anlass_kennung,anlass_fassung) VALUES (?,?,?,?,?,?,?,?,'counter',?,?,?::jsonb,'endgueltig',"
                + "ARRAY[?]::text[],'{}'::text[],?,?)",tenant,m,art,tag,Timestamp.from(von),Timestamp.from(bis),
                zone.id().getId(),((Number) alt.get("version")).intValue()+1,s.menge(),zustand,k,korrektur,korrektur,korrekturFassung);
    }
}
