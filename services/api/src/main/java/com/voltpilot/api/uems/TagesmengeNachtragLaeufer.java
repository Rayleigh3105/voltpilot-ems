package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.metrics.UemsLaeuferMelder;
import com.voltpilot.api.uems.KaskadeStufen.Gebildet;
import com.voltpilot.api.uems.KaskadeStufen.Gespeichert;
import com.voltpilot.api.uems.KaskadeStufen.Inhalt;
import com.voltpilot.api.uems.KorrekturVorschlagRegeln.Stand;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Der START-LÄUFER für den Nachtrag der Tagesmenge (Captain 15.09.2026, Empfehlung B): ein Tag, der vor AP-08 IP-5
 * schon endgültig war, trägt in {@code messreihe_tag} keine Menge — und eine endgültige Zeile wird nach E5 nie still
 * geändert. Darum schlägt das System je solchem Tag eine Korrektur der Art {@code menge_nachgetragen} vor (Fassung 1,
 * Ersteller VoltPilot, Marker {@code correction}); freigegeben wird von Hand nach den Regeln des Unternehmens (Rechte
 * {@code korrektur.freigeben}, Vier-Augen-Einstellung, {@code KorrekturFreigabeService}), und erst die Freigabe lässt
 * die Kaskade Version 2 des Tages schreiben. Version 1 bleibt, wie sie ist.
 *
 * <p><b>Welche Tage:</b> endgültig, ohne {@code menge}, {@code menge_zustand} und {@code kadenz_s} (so steht jede Zeile
 * von vor V20260912205000; seither schreibt der Tageslauf wenigstens die Kadenz) und ohne Version ≥ 2 (die trägt schon
 * eine Menge nach der Regel von heute). „Neu“ ist der Tag aus seinen Viertelstunden in ihrer neuesten Fassung —
 * dieselbe Rechnung, die die Kaskade bei der Freigabe anwendet ({@link KaskadeStufen#tag}).
 *
 * <p><b>Die Wächter:</b> idempotent (ein Tag mit Version ≥ 2 fällt heraus, ein offener oder entschiedener Vorschlag
 * sperrt über die Doppelvorschlag-Sperre von IP-14), abbruchsicher (EINE Transaktion je Tag: Vorschlag und Marker
 * zusammen oder gar nicht), fehlertolerant (ein scheiternder Kundenbereich hält weder die anderen noch den Start auf),
 * abschaltbar ({@code voltpilot.uems.tagesmenge-nachtrag.enabled}: in Produktion AN, im Testlauf AUS). Ein Tag ohne
 * bildbare Menge bekommt KEINEN Vorschlag — er wird gezählt und im Log benannt.
 */
@Component
public class TagesmengeNachtragLaeufer {

    private static final Logger log = LoggerFactory.getLogger(TagesmengeNachtragLaeufer.class);

    /**
     * Was ein Lauf tat. {@code ohneMenge} benennt jeden Tag ohne bildbare Menge als
     * {@code <entity_id>/<messkanal> <tag>}; {@code gesperrt} zählt Tage, die schon einen Vorschlag haben.
     */
    public record Lauf(int kundenbereiche, int vorschlaege, int gesperrt, List<String> ohneMenge, int fehler) {}

    private final JdbcTemplate adminJdbc;
    private final KaskadeStufen stufen;
    private final boolean enabled;

    private UemsLaeuferMelder melder = UemsLaeuferMelder.STUMM;

    @Autowired(required = false)
    void melder(UemsLaeuferMelder melder) {
        this.melder = melder;
    }

    /** Beendete Kundenbereiche lässt der Läufer aus (AP-20, E10 = A); ohne Spring gilt KEINE. */
    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

    public TagesmengeNachtragLaeufer(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            MeasurementCatalog katalog, ErsatzwertLauf ersatzwerte,
            @Value("${voltpilot.uems.tagesmenge-nachtrag.enabled:true}") boolean enabled) {
        this.adminJdbc = adminJdbc;
        this.stufen = new KaskadeStufen(katalog, ersatzwerte);
        this.enabled = enabled;
    }

    @EventListener(ApplicationReadyEvent.class)
    @Order(BestandsuebernahmeLaeufer.ORDER + 3)
    public void beimStart() {
        if (!enabled) {
            log.info("UEMS-Nachtrag der Tagesmenge abgeschaltet (voltpilot.uems.tagesmenge-nachtrag.enabled=false)");
            return;
        }
        try {
            Lauf l = lauf();
            melder.bestandGelaufen(UemsLaeuferMelder.BESTAND_TAGESMENGE, l.kundenbereiche(), l.fehler());
            if (l.vorschlaege() > 0 || !l.ohneMenge().isEmpty() || l.fehler() > 0) {
                log.info("UEMS-Nachtrag der Tagesmenge: {} Kundenbereich(e), {} Vorschlag/Vorschläge angelegt, {} schon "
                        + "vorgeschlagen, {} Tag(e) ohne bildbare Menge {}, {} Fehler — freigegeben wird von Hand",
                        l.kundenbereiche(), l.vorschlaege(), l.gesperrt(), l.ohneMenge().size(), l.ohneMenge(),
                        l.fehler());
            }
        } catch (RuntimeException e) {
            melder.fehler(UemsLaeuferMelder.BESTAND_TAGESMENGE);
            log.error("UEMS-Nachtrag der Tagesmenge gescheitert, nichts vorgeschlagen: {}", e.toString(), e);
        }
    }

    /** Ein Lauf über alle Kundenbereiche mit der Uhr von jetzt. */
    public Lauf lauf() {
        return lauf(Instant.now());
    }

    /** Ein Lauf über alle Kundenbereiche, ältester zuerst. Wirft nie je Kundenbereich. */
    public Lauf lauf(Instant jetzt) {
        List<UUID> kundenbereiche = adminJdbc.queryForList("SELECT id FROM tenant ORDER BY created_at, id", UUID.class);
        int vorschlaege = 0;
        int gesperrt = 0;
        int fehler = 0;
        List<String> ohneMenge = new ArrayList<>();
        for (UUID tenant : kundenbereiche) {
            if (beendete.beendet(tenant)) continue; // Kundenbereich beendet: der Läufer lässt ihn aus
            try {
                for (Kandidat k : kandidaten(tenant)) {
                    String ergebnis = inTransaktion(con -> vorschlagen(con, k, jetzt));
                    switch (ergebnis) {
                        case "vorschlag" -> vorschlaege++;
                        case "gesperrt" -> gesperrt++;
                        case "ohne_menge" -> ohneMenge.add(k.reihe().entity() + "/" + k.reihe().kanal() + " " + k.tag());
                        default -> { }
                    }
                }
            } catch (RuntimeException e) {
                fehler++;
                log.warn("UEMS-Nachtrag der Tagesmenge: Kundenbereich {} übersprungen: {}", tenant, e.toString());
            }
        }
        return new Lauf(kundenbereiche.size(), vorschlaege, gesperrt, List.copyOf(ohneMenge), fehler);
    }

    private record Kandidat(KorrekturVorschlagLauf.Reihe reihe, LocalDate tag) {}

    /** Endgültige Tage von vor AP-08 IP-5: ohne Menge, ohne Mengenzustand, ohne Kadenz. */
    private List<Kandidat> kandidaten(UUID tenant) {
        return adminJdbc.query("""
                SELECT entity_id, messkanal, tag FROM messreihe_tag
                 WHERE tenant_id = ? AND entity_id IS NOT NULL AND zustand = 'endgueltig'
                   AND menge IS NULL AND menge_zustand IS NULL AND kadenz_s IS NULL
                 ORDER BY entity_id, messkanal, tag
                """, (rs, n) -> new Kandidat(new KorrekturVorschlagLauf.Reihe(tenant, rs.getObject(1, UUID.class),
                rs.getString(2)), rs.getDate(3).toLocalDate()), tenant);
    }

    /** Ein Tag, eine Transaktion: {@code vorschlag}, {@code gesperrt}, {@code ohne_menge} oder {@code nichts}. */
    private String vorschlagen(Connection con, Kandidat k, Instant jetzt) throws SQLException {
        KorrekturVorschlagLauf.Reihe r = k.reihe();
        if (!KorrekturVorschlagLauf.sperreReihe(con, r, false)) {
            return "gesperrt";
        }
        KaskadeStufen.Reihe kr = new KaskadeStufen.Reihe(r.tenant(), r.entity(), r.kanal());
        Gespeichert v1 = KaskadeStufen.bestand(con, kr, KaskadeStufen.TAG, k.tag());
        ZoneId vorgabe = ReihenKontext.zeitzonen(con, List.of(new ReihenKontext.Frage(r.tenant(), r.entity(),
                k.tag()))).get(0).zone();
        ZoneId zone = Objects.requireNonNullElse(KaskadeStufen.zoneDerZeile(con, kr, KaskadeStufen.TAG, k.tag()),
                vorgabe);
        Instant beginn = TagRegeln.beginn(k.tag(), zone);
        Instant ende = TagRegeln.ende(k.tag(), zone);
        if (v1 == null || KaskadeStufen.neuesteVersion(con, r.tenant(), r.entity(), r.kanal(), null,
                KaskadeStufen.TAG, beginn) != null) {
            return "nichts";
        }
        Gebildet soll = stufen.tag(con, kr, k.tag(), zone, v1, jetzt);
        if (soll == null || soll.inhalt().menge() == null) {
            return "ohne_menge";
        }
        ArrayNode vorschau = KorrekturVorschlagRegeln.vorschauTag(beginn, ende, stand(1, v1.inhalt()),
                stand(null, soll.inhalt()));
        if (KorrekturVorschlagRegeln.sperre(KorrekturVorschlagLauf.bestehende(con, r,
                KorrekturVorschlagRegeln.MENGE_NACHGETRAGEN), beginn, ende, vorschau) != null) {
            return "gesperrt";
        }
        KorrekturVorschlagLauf.anlegen(con, r, KorrekturVorschlagRegeln.MENGE_NACHGETRAGEN, beginn, ende,
                KorrekturVorschlagRegeln.mengeNachgetragen(k.tag(), TagRegeln.endgueltigAb(ende), zone), vorschau,
                KorrekturVorschlagLauf.SYSTEM, zone, jetzt);
        return "vorschlag";
    }

    private static Stand stand(Integer version, Inhalt i) {
        return new Stand(version, i.menge(), i.mengeZustand(), i.aussage(), i.erhalten(), i.erwartet(), i.abdeckung(),
                i.mittel(), i.energie());
    }

    private interface Zug<T> {
        T fahren(Connection con) throws SQLException;
    }

    private <T> T inTransaktion(Zug<T> zug) {
        return adminJdbc.execute((Connection con) -> {
            boolean autoCommit = con.getAutoCommit();
            con.setAutoCommit(false);
            try {
                T ergebnis = zug.fahren(con);
                con.commit();
                return ergebnis;
            } catch (Exception e) {
                con.rollback();
                throw e instanceof SQLException sql ? sql
                        : new SQLException("UEMS-Nachtrag der Tagesmenge fehlgeschlagen", e);
            } finally {
                con.setAutoCommit(autoCommit);
            }
        });
    }
}
