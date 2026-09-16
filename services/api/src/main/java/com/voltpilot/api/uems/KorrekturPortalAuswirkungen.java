package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Lesender Weg zu den betroffenen Objekten; Kennzahlen und Berichte verwenden ihre Kaskaden-Auswahl. */
@Component
public class KorrekturPortalAuswirkungen {
    private final JdbcTemplate jdbc;
    private final KennzahlService kennzahlen;
    private final BerichteNaht berichte;
    private final BerichtService berichtSicht;

    public KorrekturPortalAuswirkungen(JdbcTemplate jdbc, KennzahlService kennzahlen,
            BerichteNaht berichte, BerichtService berichtSicht) {
        this.jdbc = jdbc; this.kennzahlen = kennzahlen; this.berichte = berichte; this.berichtSicht = berichtSicht;
    }

    KorrekturPortalService.Auswirkungen lesen(List<MessreiheKorrekturRepository.Reihe> reihen,
            Instant von, Instant bis, ZoneId zone, ProtokollAkteur wer) {
        UUID tenant = TenantContext.get();
        Set<UUID> messstellen = new LinkedHashSet<>();
        Set<UUID> komponenten = new LinkedHashSet<>();
        for (var r : reihen) {
            if (r.messstelleId() != null) messstellen.add(r.messstelleId());
            else {
                komponenten.add(r.entityId());
                messstellen.addAll(jdbc.queryForList("SELECT messstelle_id FROM messstelle_quelle WHERE tenant_id = ? "
                        + "AND entity_id = ? AND kanal = ? AND rolle = 'fuehrend' AND gueltig_ab < ? "
                        + "AND (gueltig_bis IS NULL OR gueltig_bis > ?)", UUID.class,
                        tenant, r.entityId(), r.messkanal(), Timestamp.from(bis), Timestamp.from(von)));
            }
        }
        record Term(UUID ziel, UUID messstelle, UUID entity, String kanal, String name, String kennzeichen) {}
        List<Term> terme = jdbc.query("SELECT m.id, t.quell_messstelle_id, t.entity_id, t.point_key, m.name, m.kennzeichen "
                + "FROM messstelle_formel_term t JOIN messstelle m ON m.id = t.messstelle_id "
                + "JOIN messstelle_formel_fassung f ON f.id = t.fassung_id WHERE t.tenant_id = ? "
                + "AND f.aufgehoben_am IS NULL AND (f.gueltig_ab IS NULL OR f.gueltig_ab <= ?::date) "
                + "AND (f.gueltig_bis IS NULL OR f.gueltig_bis >= ?::date)",
                (rs, n) -> new Term(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getObject(3, UUID.class),
                        rs.getString(4), rs.getString(5), rs.getString(6)), tenant,
                bis.minusNanos(1).atZone(zone).toLocalDate(), von.atZone(zone).toLocalDate());
        Set<String> berechnet = new LinkedHashSet<>();
        Set<String> berechnetKennzeichen = new LinkedHashSet<>();
        boolean mehr;
        do {
            mehr = false;
            for (Term t : terme) {
                if (messstellen.contains(t.messstelle()) || komponenten.contains(t.entity())
                        && reihen.stream().anyMatch(r -> t.entity().equals(r.entityId()) && t.kanal().equals(r.messkanal()))) {
                    mehr |= messstellen.add(t.ziel());
                    berechnet.add(t.kennzeichen() + " · " + t.name());
                    berechnetKennzeichen.add(t.kennzeichen());
                }
            }
        } while (mehr);
        var katalog = kennzahlen.katalog();
        var kz = KennzahlLauf.betroffene(katalog, KennzahlLauf.kanten(katalog), messstellen);
        List<String> sichtbareKennzahlen = kennzahlen.liste().kennzahlen().stream()
                .filter(k -> kz.contains(k.kennzeichen())).map(k -> k.kennzeichen() + " · " + k.name()).toList();
        var betroffen = new KorrekturKaskade.Betroffen(tenant, "Vorschau", 1, "freigegeben",
                reihen.stream().filter(r -> r.entityId() != null).map(r -> new KorrekturKaskade.Reihe(r.entityId(), r.messkanal())).toList(),
                von, bis, zone, von.atZone(zone).toLocalDate(), bis.minusNanos(1).atZone(zone).toLocalDate(),
                List.copyOf(berechnetKennzeichen), List.of(), 0, Instant.now());
        Set<String> sichtbareBerichte = new LinkedHashSet<>();
        try { berichtSicht.liste(wer).forEach(b -> sichtbareBerichte.add(b.kopf().kennung())); }
        catch (BerichtAbgelehnt x) { if (x.status() != 403) throw x; }
        var berichtListe = jdbc.execute((ConnectionCallback<List<BerichteNaht.Bericht>>) con -> berichte.betroffene(con, betroffen));
        List<String> entwuerfe = new ArrayList<>(), staende = new ArrayList<>();
        for (var b : berichtListe) if (sichtbareBerichte.contains(b.kennung())) {
            (b.stand() == BerichteNaht.Stand.ENTWURF ? entwuerfe : staende).add(b.kennung());
        }
        return new KorrekturPortalService.Auswirkungen(List.of("Tag", "Monat", "Jahr"),
                berechnet.isEmpty() ? "Keine abhängige berechnete Messstelle im sichtbaren Bereich."
                        : "Neu berechnet: " + String.join(", ", berechnet) + ".",
                sichtbareKennzahlen.isEmpty() ? "Keine abhängige Kennzahl im sichtbaren Bereich."
                        : "Neu berechnet: " + String.join(", ", sichtbareKennzahlen) + ".",
                "Bericht-Entwürfe werden aktualisiert" + namen(entwuerfe) + ". Freigegebene Berichte bleiben erhalten und erhalten einen Revisionshinweis" + namen(staende) + ".");
    }
    private static String namen(List<String> namen) { return namen.isEmpty() ? "" : ": " + String.join(", ", namen); }
}
