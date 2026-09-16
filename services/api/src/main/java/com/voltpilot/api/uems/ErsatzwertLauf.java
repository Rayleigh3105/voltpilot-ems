package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.uems.VerbrauchRegeln.Anteil;
import com.voltpilot.api.uems.VerbrauchRegeln.Ergebnis;
import com.voltpilot.api.uems.VerbrauchRegeln.Ersatzwert;
import com.voltpilot.api.uems.VerbrauchRegeln.Geltend;
import com.voltpilot.api.uems.VerbrauchRegeln.Geltende;
import com.voltpilot.api.uems.VerbrauchRegeln.LueckenZuwachs;
import com.voltpilot.api.uems.VerbrauchRegeln.Profilwert;
import java.math.BigDecimal;
import java.sql.Array;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Der ERSATZWERT-LAUF (UEMS AP-08 IP-13): aus den Ersatzwerten einer Reihe ({@code messreihe_ersatzwert},
 * IP-12) wird die Viertelstunde als VERSION neu gebildet ({@code messreihe_viertelstunde_version}).
 *
 * <p><b>Er rechnet nichts.</b> Er lädt, was die Rechenregel braucht — den Bestand (Version 1 in
 * {@code messreihe_viertelstunde}), die geprüfte Lücke samt ihrem gemessenen Zuwachs ({@code data_gap}),
 * das Profil der Vorperiode oder der Vergleichsquelle, bei einem Ablesestand die Rohwerte über
 * {@link ViertelstundeVerdichter#grundlage} — und ruft {@link VerbrauchRegeln#geltende},
 * {@link VerbrauchRegeln#mitErsatzwerten} und {@link VerbrauchRegeln#version} an (Vertrag
 * {@code verbrauch-vectors.json}, Block {@code ersatzwerte}, mit Python-Zwilling). Die Invariante „Summe =
 * gemessener Zuwachs“ hält darum die Regel, nicht dieser Lauf.
 *
 * <p><b>Immer vom Bestand aus.</b> Die gewünschte Version einer Viertelstunde ist eine Funktion von Version 1
 * und den HEUTE geltenden Ersatzwerten — nie von einer früheren Version. Unterscheidet sie sich von der
 * neuesten gespeicherten (oder, ohne eine, von Version 1), entsteht die nächste Version; sonst nichts. Ein
 * Widerruf ergibt so eine Version mit den Zahlen von Version 1 (F21: keine Spur in den Zahlen), und eine
 * bessere Methode rechnet ihren Anteil aus dem Zuwachs, nicht aus Version 2.
 *
 * <p><b>Wiederholbar und abbruchsicher.</b> Arbeit ist jede Fassung eines Ersatzwerts, die weiter ist als
 * ihre Wirkung ({@code messreihe_ersatzwert_wirkung}). Ein Ersatzwert wird in EINER Transaktion gerechnet:
 * Versionen und Wirkung zusammen — bricht er ab, bleibt nichts Halbes, und der nächste Lauf rechnet ihn
 * wieder. Zwei Läufe an derselben Reihe schließt eine Sperre je Reihe aus. Ein zweiter Lauf ohne neue
 * Fassung schreibt nichts.
 *
 * <p><b>Keine automatische Auffüllung:</b> jeder Ersatzwert, den er rechnet, hat ein Mensch mit Begründung
 * erfasst. Grenzen: Tag, Monat, Jahr und berechnete Messstellen bildet die Kaskade (IP-17); keine
 * Vorschläge (IP-14), keine Freigabe (IP-15), keine Route (IP-16).
 */
@Component
public class ErsatzwertLauf {

    private static final Logger log = LoggerFactory.getLogger(ErsatzwertLauf.class);
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Duration VIERTELSTUNDE = Duration.ofMinutes(15);

    static final String GEBILDET = "gebildet";
    static final String OHNE_WIRKUNG = "ohne_wirkung";
    static final String ROHWERTE_FEHLEN = "rohwerte_fehlen";

    /** Wie viele Kandidaten eine Suche nach Arbeit ansieht (gesperrte Reihen werden übersprungen). */
    private static final int KANDIDATEN = 20;

    private final JdbcTemplate adminJdbc;
    private final MeasurementCatalog katalog;
    private final ViertelstundeVerdichter verdichter;
    private final int ersatzwerteJeLauf;

    public ErsatzwertLauf(
            @Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            MeasurementCatalog katalog,
            ViertelstundeVerdichter verdichter,
            @Value("${voltpilot.uems.ersatzwert.je-lauf:200}") int ersatzwerteJeLauf) {
        this.adminJdbc = adminJdbc;
        this.katalog = katalog;
        this.verdichter = verdichter;
        this.ersatzwerteJeLauf = ersatzwerteJeLauf;
    }

    /** Was ein Lauf tat. */
    public record Lauf(int ersatzwerte, int versionen) {}

    /** Ein Takt: Ersatzwert um Ersatzwert, jeder in seiner Transaktion, bis keine Arbeit mehr da ist. */
    public Lauf lauf(Instant jetzt) {
        int ersatzwerte = 0;
        int versionen = 0;
        for (int i = 0; i < ersatzwerteJeLauf; i++) {
            Integer geschrieben = inTransaktion(con -> einen(con, jetzt));
            if (geschrieben == null) {
                break;
            }
            ersatzwerte++;
            versionen += geschrieben;
        }
        if (ersatzwerte > 0) {
            log.info("UEMS Ersatzwert-Lauf: {} Ersatzwerte gerechnet, {} Viertelstunden-Versionen", ersatzwerte,
                    versionen);
        }
        return new Lauf(ersatzwerte, versionen);
    }

    // ------------------------------------------------------------------------------ Für die Kaskade (IP-17)

    /**
     * AP-08 IP-17: die Ersatzwerte einer Reihe, die {@code [von, bis)} berühren, geladen wie im Lauf und ausgewählt von
     * DERSELBEN Regel ({@link VerbrauchRegeln#geltende}) — die Kaskade bildet Tag, Monat und Jahr mit genau den
     * Ersatzwerten, mit denen dieser Lauf die Viertelstunden bildet, und wählt keine eigenen. Ein Ablesestand (d) wird
     * hier nicht erneut an den Rohwerten geprüft: die Kaskade liest seine von IP-13 gerechnete Viertelstunden-Version.
     * Periodenbeträge (e) bleiben ohne Viertelstundenanteile.
     *
     * @param regel das Regelwort der Reihe ({@code zaehlerstand} …), {@code null} = keine Periodenregel
     * @return leer, wenn kein Ersatzwert den Zeitraum berührt
     */
    Geltende geltende(Connection con, UUID tenant, UUID entity, String kanal, Instant von, Instant bis, String regel,
            ReihenKontext kontext) throws SQLException {
        Kandidat k = new Kandidat(tenant, null, entity, kanal);
        List<Ersatzwert> ersatzwerte = new ArrayList<>();
        for (Zeile z : zeilenDerReihe(con, tenant, entity, kanal)) {
            if (z.von().isBefore(bis) && von.isBefore(z.bis())) {
                ersatzwerte.add(ersatzwert(con, k, z));
            }
        }
        if (ersatzwerte.isEmpty()) {
            return new Geltende(List.of(), Map.of());
        }
        return ErsatzwertPerioden.geltende(ersatzwerte, regel == null ? "" : regel, kontext.einheit(), Map.of(), kontext.zeitzone());
    }

    String wertart(Connection con, UUID tenant, UUID entity, String kanal, Instant bis) throws SQLException {
        return wertart(con, new Kandidat(tenant, null, entity, kanal), bis);
    }

    // ------------------------------------------------------------------------------ Ein Ersatzwert

    private record Kandidat(UUID tenant, String kennung, UUID entity, String kanal) {}

    /** Eine Zeile von {@code messreihe_ersatzwert} (Fassung 1) mit Status und höchster Fassung. */
    private record Zeile(String kennung, String methode, Instant von, Instant bis, String status, int fassung,
            UUID lueckeEreignisId, String einheit, Instant vorperiodeVon, UUID vergleichQuelleId, BigDecimal betrag,
            Instant zeitpunkt, BigDecimal endstand, BigDecimal anfangsstand) {}

    /** Version 1 einer Viertelstunde, wie der Verdichtungs-Lauf sie schrieb. */
    private record Bestand(BigDecimal menge, String zustand, List<String> kennzeichen, boolean standAnfang,
            boolean standEnde, int erhalten, int erwartet, Integer abdeckung, Instant berechnetAm, String wertart) {}

    /** Was eine Version einer Viertelstunde sagt — verglichen, um nur Neues zu schreiben. */
    private record Stand(BigDecimal menge, String zustand, List<String> kennzeichen, BigDecimal anteil,
            List<String> ersatzwerte) {

        boolean gleich(Stand o) {
            return zahlGleich(menge, o.menge) && zustand.equals(o.zustand) && kennzeichen.equals(o.kennzeichen)
                    && zahlGleich(anteil, o.anteil) && ersatzwerte.equals(o.ersatzwerte);
        }

        private static boolean zahlGleich(BigDecimal a, BigDecimal b) {
            return a == null ? b == null : b != null && a.compareTo(b) == 0;
        }
    }

    /**
     * Rechnet EINEN Ersatzwert, dessen Fassung weiter ist als seine Wirkung — samt allen Ersatzwerten derselben
     * Reihe, die mit ihm Viertelstunden teilen. {@code null}, wenn es keine Arbeit gibt; sonst die Zahl der
     * geschriebenen Versionen.
     */
    private Integer einen(Connection con, Instant jetzt) throws SQLException {
        for (Kandidat k : kandidaten(con)) {
            if (!sperre(con, k)) {
                continue;
            }
            // Unter der Sperre noch einmal: ein gleichzeitiger Lauf kann ihn eben gerechnet haben.
            List<Zeile> reihe = zeilenDerReihe(con, k.tenant(), k.entity(), k.kanal());
            Zeile diese = reihe.stream().filter(z -> z.kennung().equals(k.kennung())).findFirst().orElseThrow();
            if (wirkungFassung(con, k.tenant(), k.kennung()) >= diese.fassung()) {
                return 0;
            }
            return rechnen(con, k, reihe, diese, jetzt);
        }
        return null;
    }

    private int rechnen(Connection con, Kandidat k, List<Zeile> alle, Zeile diese, Instant jetzt) throws SQLException {
        // Der Umfang: alle Ersatzwerte der Reihe, die mit diesem Viertelstunden teilen — transitiv.
        Instant von = diese.von();
        Instant bis = diese.bis();
        List<Zeile> umfang = new ArrayList<>();
        boolean gewachsen = true;
        while (gewachsen) {
            gewachsen = false;
            for (Zeile z : alle) {
                if (!umfang.contains(z) && z.von().isBefore(bis) && von.isBefore(z.bis())) {
                    umfang.add(z);
                    von = z.von().isBefore(von) ? z.von() : von;
                    bis = z.bis().isAfter(bis) ? z.bis() : bis;
                    gewachsen = true;
                }
            }
        }

        // Eine Viertelstunde davor und danach: der Stand an einer Grenze gehört beiden Nachbarn (Z1), und eine
        // Viertelstunde ohne Rohwert hat keine Zeile, die ihn nennen könnte.
        Map<Instant, Bestand> bestand = bestand(con, k.tenant(), k.entity(), k.kanal(), von.minus(VIERTELSTUNDE),
                bis.plus(VIERTELSTUNDE));
        String regel = ViertelstundeRegeln.regelWort(wertart(con, k, bis));
        ReihenKontext kontext = ReihenKontext.aus(katalog, k.kanal(), ReihenKontext.zeitzonen(con,
                List.of(new ReihenKontext.Frage(k.tenant(), k.entity(), LocalDate.ofInstant(von, ZoneOffset.UTC))))
                .get(0).zone());

        List<Ersatzwert> ersatzwerte = new ArrayList<>();
        for (Zeile z : umfang) {
            ersatzwerte.add(ersatzwert(con, k, z));
        }
        Map<String, String> vorab = new LinkedHashMap<>();
        Map<String, ViertelstundeVerdichter.Grundlage> grundlagen = new HashMap<>();
        for (Ersatzwert ew : ersatzwerte) {
            if (!VerbrauchRegeln.WIRKSAM.equals(ew.status())) {
                continue;
            }
            if (regel == null) {
                vorab.put(ew.kennung(), "wertart_passt_nicht");
            } else if (VerbrauchRegeln.ABLESESTAND_NACHTRAGEN.equals(ew.methode())) {
                ViertelstundeVerdichter.Grundlage g = verdichter.grundlage(con, k.tenant(), k.entity(), k.kanal(), ew.von());
                if (g == null || g.werte().isEmpty()) {
                    vorab.put(ew.kennung(), ROHWERTE_FEHLEN);
                    continue;
                }
                grundlagen.put(ew.kennung(), g);
                try {
                    VerbrauchRegeln.ablesestandPruefen(g.werte(), ew);
                } catch (VerbrauchRegeln.ErsatzwertAbgelehnt x) {
                    vorab.put(ew.kennung(), x.grund());
                }
            }
        }
        Geltende geltende = ErsatzwertPerioden.geltende(ersatzwerte, regel == null ? "" : regel, kontext.einheit(), vorab, kontext.zeitzone());
        Map<Instant, Stand> neueste = neuesteVersionen(con, k, von, bis);

        int geschrieben = 0;
        Map<String, Integer> jeKennung = new HashMap<>();
        for (Instant q : VerbrauchRegeln.viertelstunden(von, bis)) {
            Bestand b = bestand.get(q);
            List<Geltend> hier = new ArrayList<>();
            for (Geltend g : geltende.gelten()) {
                Ersatzwert ew = g.ersatzwert();
                boolean trifft = VerbrauchRegeln.ABLESESTAND_NACHTRAGEN.equals(ew.methode())
                        ? ew.von().equals(q)
                        : g.anteile().stream().anyMatch(a -> a.beginn().equals(q));
                if (trifft) {
                    hier.add(g);
                }
            }
            Bestand davor = bestand.get(q.minus(VIERTELSTUNDE));
            Bestand danach = bestand.get(q.plus(VIERTELSTUNDE));
            boolean standAnfang = (b != null && b.standAnfang()) || (davor != null && davor.standEnde());
            boolean standEnde = (b != null && b.standEnde()) || (danach != null && danach.standAnfang());
            Stand soll = soll(b, standAnfang, standEnde, hier, q, kontext, grundlagen);
            Stand ist = neueste.getOrDefault(q, bestandsStand(b));
            if (soll.gleich(ist)) {
                continue;
            }
            int version = neueste.containsKey(q) ? versionVon(con, k, q) + 1 : 2;
            versionSchreiben(con, k, q, version, soll, diese, b);
            geschrieben++;
            for (Zeile z : umfang) {
                if (!z.von().isAfter(q) && z.bis().isAfter(q)) {
                    jeKennung.merge(z.kennung(), 1, Integer::sum);
                }
            }
        }
        for (Zeile z : umfang) {
            String ergebnis = !VerbrauchRegeln.WIRKSAM.equals(z.status()) ? OHNE_WIRKUNG
                    : geltende.abgelehnt().getOrDefault(z.kennung(), GEBILDET);
            wirkungSchreiben(con, k.tenant(), z, ergebnis, jeKennung.getOrDefault(z.kennung(), 0), jetzt);
        }
        return geschrieben;
    }

    /**
     * Die gewünschte Version einer Viertelstunde — gerechnet NUR von {@link VerbrauchRegeln}: ohne geltenden
     * Ersatzwert der Bestand; mit einem Ablesestand die Regel über die Rohwerte; sonst der Bestand mit den
     * Anteilen darüber.
     */
    private static Stand soll(Bestand b, boolean standAnfang, boolean standEnde, List<Geltend> hier, Instant q,
            ReihenKontext kontext,
            Map<String, ViertelstundeVerdichter.Grundlage> grundlagen) {
        if (hier.isEmpty()) {
            return bestandsStand(b);
        }
        Ergebnis e;
        Geltend ablesestand = hier.stream()
                .filter(g -> VerbrauchRegeln.ABLESESTAND_NACHTRAGEN.equals(g.ersatzwert().methode()))
                .findFirst().orElse(null);
        if (ablesestand != null) {
            ViertelstundeVerdichter.Grundlage g = grundlagen.get(ablesestand.ersatzwert().kennung());
            e = VerbrauchRegeln.version(g.kontext(), g.regel(), g.werte(), q, q.plus(VIERTELSTUNDE), g.kadenz(),
                    g.ereignisse(), ViertelstundeRegeln.FAKTOR_DER_FASSUNG, g.modul(), g.hoechstzuwachs(), false,
                    hier.stream().map(Geltend::ersatzwert).toList()).ergebnis();
        } else {
            Ergebnis basis = b == null
                    ? new Ergebnis(null, null, null, null, null, VerbrauchRegeln.KEINE_WERTE, 0, 0, null, List.of())
                    : new Ergebnis(b.menge(), null, null, null, null, b.zustand(), b.erhalten(), b.erwartet(),
                            b.abdeckung(), b.kennzeichen());
            e = VerbrauchRegeln.mitErsatzwerten(kontext, basis, standAnfang, standEnde, q, q.plus(VIERTELSTUNDE), hier);
        }
        BigDecimal anteil = null;
        for (Geltend g : hier) {
            for (Anteil a : g.anteile()) {
                if (a.beginn().equals(q)) {
                    anteil = anteil == null ? a.menge() : anteil.add(a.menge());
                }
            }
        }
        return new Stand(e.menge(), e.zustand(), e.kennzeichen(), anteil,
                hier.stream().map(g -> g.ersatzwert().kennung()).toList());
    }

    private static Stand bestandsStand(Bestand b) {
        return b == null
                ? new Stand(null, VerbrauchRegeln.KEINE_WERTE, List.of(), null, List.of())
                : new Stand(b.menge(), b.zustand() == null ? VerbrauchRegeln.KEINE_WERTE : b.zustand(), b.kennzeichen(),
                        null, List.of());
    }

    /** Ein Ersatzwert mit allem, worauf er sich stützt — geladen, nie gerechnet. */
    private Ersatzwert ersatzwert(Connection con, Kandidat k, Zeile z) throws SQLException {
        LueckenZuwachs luecke = null;
        Instant lueckeVon = null;
        List<Profilwert> profil = null;
        String profilEinheit = null;
        if (VerbrauchRegeln.VERTEILEN.contains(z.methode()) && z.lueckeEreignisId() != null) {
            try (PreparedStatement ps = con.prepareStatement("""
                    SELECT von, bis, (nutzlast ->> 'stand_vor')::numeric, (nutzlast ->> 'stand_nach')::numeric,
                           (nutzlast ->> 'zuwachs')::numeric
                      FROM messreihe_ereignis
                     WHERE tenant_id = ? AND ereignis_id = ? AND art = 'data_gap' AND entity_id = ? AND messkanal = ?
                       AND bis IS NOT NULL AND jsonb_exists(nutzlast, 'zuwachs')
                     ORDER BY eingang DESC LIMIT 1
                    """)) {
                ps.setObject(1, k.tenant());
                ps.setObject(2, z.lueckeEreignisId());
                ps.setObject(3, k.entity());
                ps.setString(4, k.kanal());
                try (ResultSet rs = ps.executeQuery()) {
                    if (rs.next()) {
                        lueckeVon = rs.getTimestamp(1).toInstant();
                        Instant nach = rs.getTimestamp(2).toInstant();
                        luecke = new LueckenZuwachs(messzeitVor(con, k, lueckeVon), nach, rs.getBigDecimal(3),
                                rs.getBigDecimal(4), rs.getBigDecimal(5));
                    }
                }
            }
        }
        int n = VerbrauchRegeln.viertelstunden(z.von(), z.bis()).size();
        if (z.vorperiodeVon() != null) {
            profil = profil(con, k.tenant(), k.entity(), k.kanal(), z.vorperiodeVon(), n);
        } else if (z.vergleichQuelleId() != null) {
            try (PreparedStatement ps = con.prepareStatement(
                    "SELECT entity_id, kanal FROM messstelle_quelle WHERE tenant_id = ? AND id = ? AND rolle = 'vergleich'")) {
                ps.setObject(1, k.tenant());
                ps.setObject(2, z.vergleichQuelleId());
                try (ResultSet rs = ps.executeQuery()) {
                    if (rs.next()) {
                        String kanal = rs.getString(2);
                        profil = profil(con, k.tenant(), rs.getObject(1, UUID.class), kanal, z.von(), n);
                        profilEinheit = katalog.einheit(kanal);
                    }
                }
            }
        }
        return new Ersatzwert(z.kennung(), z.methode(), z.von(), z.bis(), z.status(), luecke, lueckeVon, profil,
                profilEinheit, z.betrag(), z.einheit(), z.zeitpunkt(), z.endstand(), z.anfangsstand());
    }

    /** Die Mengen der Viertelstunden ab {@code ab} einer Reihe, in Folge; {@code null}-Eintrag = keine Zeile. */
    private static List<Profilwert> profil(Connection con, UUID tenant, UUID entity, String kanal, Instant ab, int n)
            throws SQLException {
        Map<Instant, Profilwert> je = new HashMap<>();
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT intervall_beginn, menge, menge_zustand FROM messreihe_viertelstunde
                 WHERE tenant_id = ? AND entity_id = ? AND messkanal = ? AND intervall_beginn >= ? AND intervall_beginn < ?
                """)) {
            ps.setObject(1, tenant);
            ps.setObject(2, entity);
            ps.setString(3, kanal);
            ps.setTimestamp(4, Timestamp.from(ab));
            ps.setTimestamp(5, Timestamp.from(ab.plus(VIERTELSTUNDE.multipliedBy(n))));
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    je.put(rs.getTimestamp(1).toInstant(), new Profilwert(rs.getBigDecimal(2), rs.getString(3)));
                }
            }
        }
        List<Profilwert> out = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            out.add(je.get(ab.plus(VIERTELSTUNDE.multipliedBy(i))));
        }
        return out;
    }

    /**
     * Die Messzeit des letzten guten Werts vor der Lücke — aus dem Bestand der Viertelstunden (zehn Jahre), nicht
     * aus den Rohwerten (90 Tage). Sie nennt nur die Uhrzeit im Satz „Lücke HH:MM–…“, den ein Ersatzwert ersetzt.
     */
    private static Instant messzeitVor(Connection con, Kandidat k, Instant lueckeVon) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT max(letzter_zeit) FROM messreihe_viertelstunde
                 WHERE tenant_id = ? AND entity_id = ? AND messkanal = ?
                   AND intervall_beginn >= ? AND intervall_beginn <= ? AND letzter_zeit < ?
                """)) {
            ps.setObject(1, k.tenant());
            ps.setObject(2, k.entity());
            ps.setString(3, k.kanal());
            ps.setTimestamp(4, Timestamp.from(lueckeVon.minus(Duration.ofDays(1))));
            ps.setTimestamp(5, Timestamp.from(lueckeVon));
            ps.setTimestamp(6, Timestamp.from(lueckeVon));
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                Timestamp t = rs.getTimestamp(1);
                return t == null ? lueckeVon : t.toInstant();
            }
        }
    }

    // ------------------------------------------------------------------------------ Lesen

    private List<Kandidat> kandidaten(Connection con) throws SQLException {
        List<Kandidat> out = new ArrayList<>();
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT e.tenant_id, e.kennung, a.entity_id, a.messkanal
                  FROM messreihe_ersatzwert e
                  JOIN messreihe_ersatzwert a ON a.tenant_id = e.tenant_id AND a.kennung = e.kennung AND a.fassung = 1
                  LEFT JOIN messreihe_ersatzwert_wirkung w ON w.tenant_id = e.tenant_id AND w.kennung = e.kennung
                 GROUP BY e.tenant_id, e.kennung, a.entity_id, a.messkanal, w.fassung
                HAVING max(e.fassung) > coalesce(w.fassung, 0)
                 ORDER BY max(e.created_at), e.kennung
                 LIMIT ?
                """)) {
            ps.setInt(1, KANDIDATEN);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    out.add(new Kandidat(rs.getObject(1, UUID.class), rs.getString(2), rs.getObject(3, UUID.class),
                            rs.getString(4)));
                }
            }
        }
        return out;
    }

    /** Die Sperre je Reihe bis zum Ende der Transaktion; {@code false}, wenn ein anderer Lauf sie hält. */
    private static boolean sperre(Connection con, Kandidat k) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("SELECT pg_try_advisory_xact_lock(hashtextextended(?, 0))")) {
            ps.setString(1, "uems-ersatzwert:" + k.tenant() + ":" + k.entity() + ":" + k.kanal());
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getBoolean(1);
            }
        }
    }

    private static List<Zeile> zeilenDerReihe(Connection con, UUID tenant, UUID entity, String kanal)
            throws SQLException {
        List<Zeile> out = new ArrayList<>();
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT a.kennung, a.methode, a.von, a.bis, s.status, s.fassung, a.luecke_ereignis_id, a.einheit,
                       a.vorperiode_von, a.vergleich_quelle_id, a.betrag, a.zeitpunkt, a.endstand, a.anfangsstand
                  FROM messreihe_ersatzwert a
                  JOIN LATERAL (SELECT f.status, f.fassung FROM messreihe_ersatzwert f
                                 WHERE f.tenant_id = a.tenant_id AND f.kennung = a.kennung
                                 ORDER BY f.fassung DESC LIMIT 1) s ON true
                 WHERE a.tenant_id = ? AND a.fassung = 1 AND a.entity_id = ? AND a.messkanal = ?
                 ORDER BY a.von, a.kennung
                """)) {
            ps.setObject(1, tenant);
            ps.setObject(2, entity);
            ps.setString(3, kanal);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    out.add(new Zeile(rs.getString(1), rs.getString(2), zeit(rs, 3), zeit(rs, 4), rs.getString(5),
                            rs.getInt(6), rs.getObject(7, UUID.class), rs.getString(8), zeit(rs, 9),
                            rs.getObject(10, UUID.class), rs.getBigDecimal(11), zeit(rs, 12), rs.getBigDecimal(13),
                            rs.getBigDecimal(14)));
                }
            }
        }
        return out;
    }

    private static int wirkungFassung(Connection con, UUID tenant, String kennung) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement(
                "SELECT fassung FROM messreihe_ersatzwert_wirkung WHERE tenant_id = ? AND kennung = ?")) {
            ps.setObject(1, tenant);
            ps.setString(2, kennung);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() ? rs.getInt(1) : 0;
            }
        }
    }

    private static Map<Instant, Bestand> bestand(Connection con, UUID tenant, UUID entity, String kanal, Instant von,
            Instant bis) throws SQLException {
        Map<Instant, Bestand> out = new HashMap<>();
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT intervall_beginn, menge, menge_zustand, kennzeichen::text, stand_anfang IS NOT NULL,
                       stand_ende IS NOT NULL, erhalten, erwartet, abdeckung_prozent, berechnet_am, wertart
                  FROM messreihe_viertelstunde
                 WHERE tenant_id = ? AND entity_id = ? AND messkanal = ? AND intervall_beginn >= ? AND intervall_beginn < ?
                """)) {
            ps.setObject(1, tenant);
            ps.setObject(2, entity);
            ps.setString(3, kanal);
            ps.setTimestamp(4, Timestamp.from(von));
            ps.setTimestamp(5, Timestamp.from(bis));
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    Integer abdeckung = rs.getObject(9) == null ? null : rs.getInt(9);
                    out.put(zeit(rs, 1), new Bestand(rs.getBigDecimal(2), rs.getString(3), saetze(rs.getString(4)),
                            rs.getBoolean(5), rs.getBoolean(6), rs.getInt(7), rs.getInt(8), abdeckung, zeit(rs, 10),
                            rs.getString(11)));
                }
            }
        }
        return out;
    }

    /** Die Wertart der Reihe aus ihrem Bestand — die jüngste Viertelstunde bis {@code bis}, sonst die nächste danach. */
    private static String wertart(Connection con, Kandidat k, Instant bis) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT wertart FROM messreihe_viertelstunde
                 WHERE tenant_id = ? AND entity_id = ? AND messkanal = ? AND wertart IS NOT NULL
                 ORDER BY (intervall_beginn >= ?), abs(extract(epoch FROM intervall_beginn - ?::timestamptz))
                 LIMIT 1
                """)) {
            ps.setObject(1, k.tenant());
            ps.setObject(2, k.entity());
            ps.setString(3, k.kanal());
            ps.setTimestamp(4, Timestamp.from(bis));
            ps.setTimestamp(5, Timestamp.from(bis));
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() ? rs.getString(1) : null;
            }
        }
    }

    private static Map<Instant, Stand> neuesteVersionen(Connection con, Kandidat k, Instant von, Instant bis)
            throws SQLException {
        Map<Instant, Stand> out = new HashMap<>();
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT DISTINCT ON (intervall_beginn) intervall_beginn, menge, menge_zustand, kennzeichen::text, anteil,
                       ersatzwerte
                  FROM messreihe_viertelstunde_version
                 WHERE tenant_id = ? AND entity_id = ? AND messkanal = ? AND intervall_beginn >= ? AND intervall_beginn < ?
                 ORDER BY intervall_beginn, version DESC
                """)) {
            ps.setObject(1, k.tenant());
            ps.setObject(2, k.entity());
            ps.setString(3, k.kanal());
            ps.setTimestamp(4, Timestamp.from(von));
            ps.setTimestamp(5, Timestamp.from(bis));
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    Array a = rs.getArray(6);
                    // Verglichen wird die Aussage, nicht die Nummer: „korrigiert (Version n)“ sagt nur, WO sie steht.
                    List<String> saetze = saetze(rs.getString(4)).stream()
                            .filter(x -> !ErgebnisZustand.istKorrigiert(x)).toList();
                    out.put(zeit(rs, 1), new Stand(rs.getBigDecimal(2), rs.getString(3), saetze,
                            rs.getBigDecimal(5), Arrays.asList((String[]) a.getArray())));
                }
            }
        }
        return out;
    }

    private static int versionVon(Connection con, Kandidat k, Instant q) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("SELECT max(version) FROM messreihe_viertelstunde_version "
                + "WHERE tenant_id = ? AND entity_id = ? AND messkanal = ? AND intervall_beginn = ?")) {
            ps.setObject(1, k.tenant());
            ps.setObject(2, k.entity());
            ps.setString(3, k.kanal());
            ps.setTimestamp(4, Timestamp.from(q));
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getInt(1);
            }
        }
    }

    // ------------------------------------------------------------------------------ Schreiben

    private static void versionSchreiben(Connection con, Kandidat k, Instant q, int version, Stand soll, Zeile anlass,
            Bestand b) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("""
                INSERT INTO messreihe_viertelstunde_version (tenant_id, entity_id, messkanal, intervall_beginn, version,
                    menge, menge_zustand, kennzeichen, anteil, ersatzwerte, anlass_kennung, anlass_fassung,
                    basis_berechnet_am)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?)
                """)) {
            ps.setObject(1, k.tenant());
            ps.setObject(2, k.entity());
            ps.setString(3, k.kanal());
            ps.setTimestamp(4, Timestamp.from(q));
            ps.setInt(5, version);
            ps.setBigDecimal(6, soll.menge());
            ps.setString(7, soll.zustand());
            // E9 (AP-08 IP-17, ergebnis-zustand 1.5): jede Version sagt zuletzt, dass sie eine ist.
            List<String> kennzeichen = new ArrayList<>(soll.kennzeichen());
            kennzeichen.add(ErgebnisZustand.korrigiert(version));
            ps.setString(8, ViertelstundeRegeln.kennzeichenJson(kennzeichen));
            ps.setBigDecimal(9, soll.anteil());
            ps.setArray(10, con.createArrayOf("text", soll.ersatzwerte().toArray()));
            ps.setString(11, anlass.kennung());
            ps.setInt(12, anlass.fassung());
            ps.setTimestamp(13, b == null || b.berechnetAm() == null ? null : Timestamp.from(b.berechnetAm()));
            ps.executeUpdate();
        }
    }

    /** Die Wirkung fortschreiben — nur, wenn Fassung oder Ergebnis sich ändern; sonst bleibt die Zeile stehen. */
    private static void wirkungSchreiben(Connection con, UUID tenant, Zeile z, String ergebnis, int versionen,
            Instant jetzt) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("""
                INSERT INTO messreihe_ersatzwert_wirkung (tenant_id, kennung, fassung, ergebnis, versionen, berechnet_am)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (tenant_id, kennung) DO UPDATE
                   SET fassung = EXCLUDED.fassung, ergebnis = EXCLUDED.ergebnis, versionen = EXCLUDED.versionen,
                       berechnet_am = EXCLUDED.berechnet_am
                 WHERE (messreihe_ersatzwert_wirkung.fassung, messreihe_ersatzwert_wirkung.ergebnis)
                       IS DISTINCT FROM (EXCLUDED.fassung, EXCLUDED.ergebnis)
                """)) {
            ps.setObject(1, tenant);
            ps.setString(2, z.kennung());
            ps.setInt(3, z.fassung());
            ps.setString(4, ergebnis);
            ps.setInt(5, versionen);
            ps.setTimestamp(6, Timestamp.from(jetzt));
            ps.executeUpdate();
        }
    }

    // ------------------------------------------------------------------------------ Hilfen

    private static Instant zeit(ResultSet rs, int spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }

    private static List<String> saetze(String json) {
        if (json == null) {
            return List.of();
        }
        try {
            return List.copyOf(JSON.readValue(json, new TypeReference<List<String>>() {}));
        } catch (Exception e) {
            throw new IllegalStateException("kennzeichen ist kein Array von Sätzen: " + json, e);
        }
    }

    @FunctionalInterface
    private interface Zug<T> {
        T fahren(Connection con) throws SQLException;
    }

    /** EINE Transaktion je Ersatzwert: Versionen und Wirkung gehören zusammen. */
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
                        : new SQLException("UEMS Ersatzwert-Lauf fehlgeschlagen", e);
            } finally {
                con.setAutoCommit(autoCommit);
            }
        });
    }
}
