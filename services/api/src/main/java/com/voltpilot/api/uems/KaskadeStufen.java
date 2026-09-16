package com.voltpilot.api.uems;

import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.uems.VerbrauchRegeln.Ergebnis;
import com.voltpilot.api.uems.VerbrauchRegeln.Geltende;
import com.voltpilot.api.uems.VerbrauchRegeln.Rohwert;
import com.voltpilot.api.uems.VerbrauchRegeln.Teilperiode;
import com.voltpilot.api.uems.VerbrauchRegeln.Werteteil;
import java.math.BigDecimal;
import java.sql.Array;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;

/**
 * Die STUFEN einer gemessenen Reihe in der Korrektur-Kaskade (AP-08 IP-17): Tag, Monat und Jahr aus der NEUESTEN
 * Fassung ihrer Teile — gebildet mit genau den Regeln, mit denen die Verdichtung Version 1 bildet
 * ({@link ViertelstundenTeile#zaehlerstand}, {@link VerbrauchRegeln#erwartetAusTeilperioden},
 * {@link ViertelstundenTeile#werte}, bei Ersatzwerten {@link VerbrauchRegeln#mitErsatzwerten} über
 * {@link ErsatzwertLauf#geltende}). Hier wird nichts Eigenes gerechnet: geladen, überlagert, angerufen, verglichen,
 * geschrieben.
 *
 * <p><b>Die Überlagerung.</b> Eine Viertelstunde, deren neueste Version die Kaskade schrieb
 * ({@code messreihe_viertelstunde_version.korrekturen} gesetzt), geht mit den Rohwert-Fakten und dem Ergebnis DIESER
 * Version in Tag und Monat ein — ohne das Kennzeichen „korrigiert (Version n)“, das nur sagt, wo sie steht. Eine
 * Version des Ersatzwert-Laufs ändert die Fakten nie; ihre Anteile legt die Regel der Periode darüber
 * ({@code mitErsatzwerten}). Das Jahr entsteht, wie in {@link PeriodeVerdichter}, aus seinen Monaten: ein Monat mit einer
 * Viertelstunden-Version geht mit seiner neu gebildeten GRUNDLAGE ein (ohne Ersatzwerte — die bekommt das Jahr selbst),
 * jeder andere mit seiner Zeile von Version 1.
 */
final class KaskadeStufen {

    static final Duration VIERTELSTUNDE = Duration.ofMinutes(15);
    static final Duration RUECKBLICK = Duration.ofDays(1);

    static final String TAG = "tag";
    static final String MONAT = "monat";
    static final String JAHR = "jahr";

    /** Eine benannte Ablehnung — die Kaskade rollt zurück und schreibt nur ihre Wirkung. */
    static final class Abgelehnt extends RuntimeException {

        private final String grund;

        Abgelehnt(String grund, String warum) {
            super(grund + ": " + warum, null, false, false);
            this.grund = grund;
        }

        String grund() {
            return grund;
        }
    }

    record Reihe(UUID tenant, UUID entity, String kanal) {}

    /**
     * Was eine Periode sagt: Zahl, Zustand, Kennzeichen, Abdeckung, Stände und die Momentanwert-Teile — und
     * vorläufig/endgültig. Verglichen OHNE „korrigiert (Version n)“.
     */
    record Inhalt(String wertart, BigDecimal menge, String mengeZustand, List<String> kennzeichen, Integer erhalten,
            Integer erwartet, Integer abdeckung, Rohwert standAnfang, Rohwert standEnde, Rohwert erster, Rohwert letzter,
            BigDecimal summe, BigDecimal mittel, BigDecimal min, BigDecimal max, BigDecimal energie, Integer gemessenS,
            Boolean lueckeInnen, String zustand) {

        Inhalt {
            kennzeichen = kennzeichen == null ? List.of() : List.copyOf(kennzeichen);
        }

        List<String> aussage() {
            return kennzeichen.stream().filter(k -> !ErgebnisZustand.istKorrigiert(k)).toList();
        }

        Inhalt mitKennzeichen(List<String> k) {
            return new Inhalt(wertart, menge, mengeZustand, k, erhalten, erwartet, abdeckung, standAnfang, standEnde,
                    erster, letzter, summe, mittel, min, max, energie, gemessenS, lueckeInnen, zustand);
        }

        Inhalt mitZustand(String z) {
            return new Inhalt(wertart, menge, mengeZustand, kennzeichen, erhalten, erwartet, abdeckung, standAnfang,
                    standEnde, erster, letzter, summe, mittel, min, max, energie, gemessenS, lueckeInnen, z);
        }

        /** Die Kennzeichen dieser Aussage mit der Version {@code version} ganz zuletzt (Rang 80). */
        List<String> kennzeichenMitVersion(int version) {
            List<String> k = new ArrayList<>(aussage());
            k.add(ErgebnisZustand.korrigiert(version));
            return List.copyOf(k);
        }

        boolean gleich(Inhalt o) {
            return o != null && zahl(menge, o.menge) && Objects.equals(mengeZustand, o.mengeZustand)
                    && aussage().equals(o.aussage()) && Objects.equals(erhalten, o.erhalten)
                    && Objects.equals(erwartet, o.erwartet) && Objects.equals(abdeckung, o.abdeckung)
                    && stand(standAnfang, o.standAnfang) && stand(standEnde, o.standEnde) && zahl(summe, o.summe)
                    && zahl(mittel, o.mittel) && zahl(min, o.min) && zahl(max, o.max) && zahl(energie, o.energie)
                    && Objects.equals(gemessenS, o.gemessenS) && Objects.equals(lueckeInnen, o.lueckeInnen)
                    && Objects.equals(zustand, o.zustand);
        }

        /** Eine Periode ohne Zahl und ohne Fakten — „keine Werte“, nie 0. */
        boolean leer() {
            return menge == null && erster == null && letzter == null && standAnfang == null && standEnde == null
                    && (erhalten == null || erhalten == 0) && mittel == null && summe == null;
        }

        private static boolean zahl(BigDecimal a, BigDecimal b) {
            return a == null ? b == null : b != null && a.compareTo(b) == 0;
        }

        private static boolean stand(Rohwert a, Rohwert b) {
            return a == null ? b == null
                    : b != null && a.zeit().equals(b.zeit()) && a.wert().compareTo(b.wert()) == 0;
        }
    }

    /** Die neueste gespeicherte Fassung einer Periode: eine Version ≥ 2 — oder Version 1 ({@code version} = 1). */
    record Gespeichert(int version, Inhalt inhalt, List<String> korrekturen, List<String> ersatzwerte,
            String anlassKennung, Instant basisBerechnetAm) {}

    /** Eine Stufe, wie die Kaskade sie bildet: ihr Inhalt und was darin wirkt. */
    record Gebildet(Inhalt inhalt, List<String> korrekturen, List<String> ersatzwerte) {}

    /** Die neueste Viertelstunden-Version einer Reihe. */
    record ViertelVersion(Instant beginn, int version, Inhalt inhalt, BigDecimal anteil, List<String> ersatzwerte,
            List<String> korrekturen, String anlassKennung, int anlassFassung) {}

    private final MeasurementCatalog katalog;
    private final ErsatzwertLauf ersatzwerte;

    KaskadeStufen(MeasurementCatalog katalog, ErsatzwertLauf ersatzwerte) {
        this.katalog = katalog;
        this.ersatzwerte = ersatzwerte;
    }

    // ============================================================================ Viertelstunden

    private static final String VIERTEL_SPALTEN = "intervall_beginn, version, menge, menge_zustand, kennzeichen::text, "
            + "anteil, ersatzwerte, korrekturen, anlass_kennung, anlass_fassung, wertart, erhalten, erwartet, "
            + "abdeckung_prozent, stand_anfang, stand_anfang_zeit, stand_ende, stand_ende_zeit, erster_wert, erster_zeit, "
            + "letzter_wert, letzter_zeit, summe, mittel, min_wert, max_wert, energie, gemessen_s, luecke_innen";

    /** Alle Versionen je Viertelstunde in {@code [von, bis)}, älteste zuerst. */
    static Map<Instant, List<ViertelVersion>> viertelVersionen(Connection con, Reihe r, Instant von, Instant bis)
            throws SQLException {
        Map<Instant, List<ViertelVersion>> aus = new TreeMap<>();
        try (PreparedStatement ps = con.prepareStatement("SELECT " + VIERTEL_SPALTEN
                + " FROM messreihe_viertelstunde_version WHERE tenant_id = ? AND entity_id = ? AND messkanal = ?"
                + " AND intervall_beginn >= ? AND intervall_beginn < ? ORDER BY intervall_beginn, version")) {
            ps.setObject(1, r.tenant());
            ps.setObject(2, r.entity());
            ps.setString(3, r.kanal());
            ps.setTimestamp(4, Timestamp.from(von));
            ps.setTimestamp(5, Timestamp.from(bis));
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    Instant q = ViertelstundenTeile.zeit(rs, 1);
                    List<String> korrekturen = texte(rs.getArray(8));
                    Inhalt i = new Inhalt(rs.getString(11), rs.getBigDecimal(3), rs.getString(4),
                            ViertelstundenTeile.kennzeichen(rs.getString(5)), ganz(rs, 12), ganz(rs, 13), ganz(rs, 14),
                            ViertelstundenTeile.wert(rs, 15, 16), ViertelstundenTeile.wert(rs, 17, 18),
                            ViertelstundenTeile.wert(rs, 19, 20), ViertelstundenTeile.wert(rs, 21, 22),
                            rs.getBigDecimal(23), rs.getBigDecimal(24), rs.getBigDecimal(25), rs.getBigDecimal(26),
                            rs.getBigDecimal(27), ganz(rs, 28), (Boolean) rs.getObject(29), null);
                    aus.computeIfAbsent(q, x -> new ArrayList<>()).add(new ViertelVersion(q, rs.getInt(2), i,
                            rs.getBigDecimal(6), texte(rs.getArray(7)), korrekturen, rs.getString(9), rs.getInt(10)));
                }
            }
        }
        return aus;
    }

    /** Version 1 einer Viertelstunde als Inhalt — {@code null}, wenn die Verdichtung keine Zeile schrieb. */
    static Map<Instant, Inhalt> viertelBestand(Connection con, Reihe r, Instant von, Instant bis) throws SQLException {
        Map<Instant, Inhalt> aus = new TreeMap<>();
        try (PreparedStatement ps = con.prepareStatement("SELECT intervall_beginn, wertart, menge, menge_zustand, "
                + "kennzeichen::text, erhalten, erwartet, abdeckung_prozent, stand_anfang, stand_anfang_zeit, stand_ende, "
                + "stand_ende_zeit, erster_wert, erster_zeit, letzter_wert, letzter_zeit, summe, mittel, min_wert, "
                + "max_wert, energie, gemessen_s, luecke_innen, zustand FROM messreihe_viertelstunde "
                + "WHERE tenant_id = ? AND entity_id = ? AND messkanal = ? AND intervall_beginn >= ? AND intervall_beginn < ?")) {
            ps.setObject(1, r.tenant());
            ps.setObject(2, r.entity());
            ps.setString(3, r.kanal());
            ps.setTimestamp(4, Timestamp.from(von));
            ps.setTimestamp(5, Timestamp.from(bis));
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    aus.put(ViertelstundenTeile.zeit(rs, 1), new Inhalt(rs.getString(2), rs.getBigDecimal(3),
                            rs.getString(4) == null ? VerbrauchRegeln.KEINE_WERTE : rs.getString(4),
                            ViertelstundenTeile.kennzeichen(rs.getString(5)), ganz(rs, 6), ganz(rs, 7), ganz(rs, 8),
                            ViertelstundenTeile.wert(rs, 9, 10), ViertelstundenTeile.wert(rs, 11, 12),
                            ViertelstundenTeile.wert(rs, 13, 14), ViertelstundenTeile.wert(rs, 15, 16),
                            rs.getBigDecimal(17), rs.getBigDecimal(18), rs.getBigDecimal(19), rs.getBigDecimal(20),
                            rs.getBigDecimal(21), ganz(rs, 22), (Boolean) rs.getObject(23), rs.getString(24)));
                }
            }
        }
        return aus;
    }

    /** Schreibt die nächste Viertelstunden-Version einer KORREKTUR — mit ihren Rohwert-Fakten. */
    static void viertelSchreiben(Connection con, Reihe r, Instant q, int version, Inhalt inhalt, BigDecimal anteil,
            List<String> ersatzwerte, List<String> korrekturen, String anlassKennung, int anlassFassung,
            Instant basisBerechnetAm) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("""
                INSERT INTO messreihe_viertelstunde_version (tenant_id, entity_id, messkanal, intervall_beginn, version,
                    menge, menge_zustand, kennzeichen, anteil, ersatzwerte, anlass_kennung, anlass_fassung,
                    basis_berechnet_am, korrekturen, wertart, stand_anfang, stand_anfang_zeit, stand_ende,
                    stand_ende_zeit, erster_wert, erster_zeit, letzter_wert, letzter_zeit, erhalten, erwartet,
                    abdeckung_prozent, summe, mittel, min_wert, max_wert, energie, gemessen_s, luecke_innen)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?)
                """)) {
            int p = 1;
            ps.setObject(p++, r.tenant());
            ps.setObject(p++, r.entity());
            ps.setString(p++, r.kanal());
            ps.setTimestamp(p++, Timestamp.from(q));
            ps.setInt(p++, version);
            ps.setBigDecimal(p++, inhalt.menge());
            ps.setString(p++, inhalt.mengeZustand());
            ps.setString(p++, ViertelstundeRegeln.kennzeichenJson(inhalt.kennzeichenMitVersion(version)));
            ps.setBigDecimal(p++, anteil);
            ps.setArray(p++, con.createArrayOf("text", ersatzwerte.toArray()));
            ps.setString(p++, anlassKennung);
            ps.setInt(p++, anlassFassung);
            ps.setTimestamp(p++, basisBerechnetAm == null ? null : Timestamp.from(basisBerechnetAm));
            ps.setArray(p++, con.createArrayOf("text", korrekturen.toArray()));
            ps.setString(p++, inhalt.wertart());
            p = fakten(ps, p, inhalt);
        }
    }

    /** Die Fakten-Spalten ab {@code stand_anfang} in der Reihenfolge beider Versionstabellen; führt das INSERT aus. */
    private static int fakten(PreparedStatement ps, int p, Inhalt i) throws SQLException {
        wert(ps, p, i.standAnfang());
        p += 2;
        wert(ps, p, i.standEnde());
        p += 2;
        wert(ps, p, i.erster());
        p += 2;
        wert(ps, p, i.letzter());
        p += 2;
        ganz(ps, p++, i.erhalten());
        ganz(ps, p++, i.erwartet());
        ganz(ps, p++, i.abdeckung());
        ps.setBigDecimal(p++, i.summe());
        ps.setBigDecimal(p++, i.mittel());
        ps.setBigDecimal(p++, i.min());
        ps.setBigDecimal(p++, i.max());
        ps.setBigDecimal(p++, i.energie());
        ganz(ps, p++, i.gemessenS());
        ps.setObject(p++, i.lueckeInnen(), Types.BOOLEAN);
        ps.executeUpdate();
        return p;
    }

    // ============================================================================ Teile mit Überlagerung

    /** Die Teile einer Periode — Version 1 mit den Viertelstunden-Versionen der Kaskade darüber. */
    record Teile(ViertelstundenTeile.Geladen geladen, List<Teilperiode> teile, List<Werteteil> werteteile,
            Set<String> korrekturen, boolean mitVersion) {

        List<Teilperiode> innen(Instant von, Instant bis) {
            return teile.stream().filter(t -> !t.von().isBefore(von) && !t.bis().isAfter(bis)).toList();
        }
    }

    /**
     * Die Viertelstunden von {@code [von, bis)} in ihrer neuesten Fassung: {@link ViertelstundenTeile#laden} (Version 1,
     * die Nachbarn an den Grenzen, Ereignisse, Deklaration), darüber je Viertelstunde die neueste Version der Kaskade.
     */
    static Teile teile(Connection con, Reihe r, Instant von, Instant bis) throws SQLException {
        ViertelstundenTeile.Geladen g = ViertelstundenTeile.laden(con, r.tenant(), r.entity(), r.kanal(), von, bis);
        TreeMap<Instant, Teilperiode> tp = new TreeMap<>();
        TreeMap<Instant, Werteteil> wt = new TreeMap<>();
        g.teile().forEach(t -> tp.put(t.von(), t));
        g.werteteile().forEach(w -> wt.put(w.teil().von(), w));
        Set<String> korrekturen = new LinkedHashSet<>();
        boolean mitVersion = false;
        for (List<ViertelVersion> vs : viertelVersionen(con, r, von.minus(RUECKBLICK), bis.plus(RUECKBLICK)).values()) {
            ViertelVersion v = vs.get(vs.size() - 1);
            boolean innen = !v.beginn().isBefore(von) && v.beginn().isBefore(bis);
            mitVersion |= innen;
            if (v.korrekturen() == null) {
                // Eine Version des Ersatzwert-Laufs: die Fakten sind die von Version 1, die Anteile legt die Regel der
                // Periode darüber.
                continue;
            }
            if (innen) {
                korrekturen.addAll(v.korrekturen());
            }
            Inhalt i = v.inhalt();
            if (i.leer()) {
                continue;
            }
            Teilperiode t = new Teilperiode(v.beginn(), v.beginn().plus(VIERTELSTUNDE), i.standAnfang(), i.standEnde(),
                    i.erster(), i.letzter(), new Ergebnis(i.menge(), null, null, null, null, i.mengeZustand(),
                            nullAlsNull(i.erhalten()), nullAlsNull(i.erwartet()), null, i.aussage()));
            tp.put(v.beginn(), t);
            wt.put(v.beginn(), new Werteteil(new Teilperiode(t.von(), t.bis(), null, null, t.erster(), t.letzter(),
                    new Ergebnis(i.menge(), i.mittel(), i.min(), i.max(), null, i.mengeZustand(),
                            nullAlsNull(i.erhalten()), nullAlsNull(i.erwartet()), null, i.aussage())),
                    i.summe(), i.energie(), i.gemessenS() == null ? 0 : i.gemessenS(),
                    i.lueckeInnen() != null && i.lueckeInnen()));
        }
        return new Teile(g, List.copyOf(tp.values()), List.copyOf(wt.values()), korrekturen, mitVersion);
    }

    // ============================================================================ Die Grundlage einer Periode

    /**
     * Die GRUNDLAGE einer Periode {@code [beginn, ende)} aus Teilperioden — dieselben Anrufe wie
     * {@link TagVerdichter} bzw. {@link PeriodeVerdichter}: Zählerstand aus den Periodenständen, Momentanwert und
     * Intervallmenge aus ihren Teilen, Abdeckung aus erhalten ÷ erwartet (abgeschnitten). Ohne Ersatzwerte.
     */
    Inhalt grundlage(Reihe r, ZoneId zone, List<Teilperiode> alle, List<Teilperiode> innen, List<Werteteil> werteteile,
            List<VerbrauchRegeln.Ereignis> ereignisse, ZaehlerDeklaration deklaration, String wertart, Integer kadenzS,
            Instant beginn, Instant ende, String zustand) {
        ReihenKontext reihe = ReihenKontext.aus(katalog, r.kanal(), zone);
        Teilperiode menge = ViertelstundenTeile.zaehlerstand(reihe, alle, ereignisse, deklaration, wertart, kadenzS,
                beginn, ende);
        int erhalten = innen.stream().mapToInt(t -> t.ergebnis().erhalten()).sum();
        int erwartet = kadenzS == null
                ? innen.stream().mapToInt(t -> t.ergebnis().erwartet()).sum()
                : VerbrauchRegeln.erwartetAusTeilperioden(innen, beginn, ende, Duration.ofSeconds(kadenzS));
        Integer abdeckung = erwartet == 0 ? null : Math.min(100, (int) (100L * erhalten / erwartet));
        Werteteil w = ViertelstundenTeile.werte(werteteile, wertart, kadenzS, beginn, ende);
        Ergebnis we = w == null ? null : w.teil().ergebnis();
        Ergebnis e = menge != null ? menge.ergebnis() : we;
        boolean momentan = "momentanwert".equals(ViertelstundeRegeln.regelWort(wertart));
        Rohwert erster = innen.stream().map(Teilperiode::erster).filter(Objects::nonNull).findFirst().orElse(null);
        Rohwert letzter = innen.stream().map(Teilperiode::letzter).filter(Objects::nonNull).reduce((a, b) -> b)
                .orElse(null);
        return new Inhalt(wertart, e == null ? null : e.menge(),
                e == null ? VerbrauchRegeln.KEINE_WERTE : e.zustand(), e == null ? List.of() : e.kennzeichen(),
                erhalten, erwartet, abdeckung, menge == null ? null : menge.standAnfang(),
                menge == null ? null : menge.standEnde(), erster, letzter, w == null ? null : w.summe(),
                we == null ? null : we.mittel(), we == null ? null : we.min(), we == null ? null : we.max(),
                w == null ? null : w.energie(), momentan && w != null ? (int) w.gemessenS() : null,
                momentan && w != null ? w.lueckeInnen() : null, zustand);
    }

    /**
     * Die Ersatzwerte über der Grundlage — {@link VerbrauchRegeln#mitErsatzwerten}, die Regel von F11/F21. Über einer
     * gröberen Periode bleiben a–c unverändert; d–g ersetzen den Beitrag ihres Zeitraums über
     * {@link ErsatzwertPerioden}. Ein Periodenbetrag wirkt erst, wenn sein ganzer Zeitraum enthalten ist.
     */
    Gebildet mitErsatzwerten(Connection con, Reihe r, ZoneId zone, Inhalt basis, Instant beginn, Instant ende,
            Set<String> korrekturen) throws SQLException {
        String wertart = basis.wertart() != null ? basis.wertart()
                : ersatzwerte.wertart(con, r.tenant(), r.entity(), r.kanal(), ende);
        String regel = ViertelstundeRegeln.regelWort(wertart);
        ReihenKontext reihe = ReihenKontext.aus(katalog, r.kanal(), zone);
        Geltende g = ersatzwerte.geltende(con, r.tenant(), r.entity(), r.kanal(), beginn, ende, regel, reihe);
        List<VerbrauchRegeln.Geltend> hier = g.gelten().stream()
                .filter(x -> x.anteile().stream().anyMatch(a -> !a.beginn().isBefore(beginn) && a.beginn().isBefore(ende))
                        || (ErsatzwertPerioden.periodenBetrag(x.ersatzwert(), zone)
                            && !x.ersatzwert().von().isBefore(beginn) && !x.ersatzwert().bis().isAfter(ende))
                        || (VerbrauchRegeln.ABLESESTAND_NACHTRAGEN.equals(x.ersatzwert().methode())
                            && x.ersatzwert().zeitpunkt().isAfter(beginn) && !x.ersatzwert().zeitpunkt().isAfter(ende)))
                .toList();
        if (hier.isEmpty()) {
            return new Gebildet(basis, List.copyOf(korrekturen), List.of());
        }
        boolean zaehler = "zaehlerstand".equals(regel);
        Ergebnis e = VerbrauchRegeln.mitErsatzwerten(reihe,
                new Ergebnis(basis.menge(), basis.mittel(), basis.min(), basis.max(), null, basis.mengeZustand(),
                        nullAlsNull(basis.erhalten()), nullAlsNull(basis.erwartet()), basis.abdeckung(),
                        basis.kennzeichen()),
                !zaehler || basis.standAnfang() != null, !zaehler || basis.standEnde() != null, beginn, ende,
                hier.stream().filter(x -> VerbrauchRegeln.VERTEILEN.contains(x.ersatzwert().methode())).toList());
        List<ErsatzwertPerioden.Beitrag> beitraege = new ArrayList<>();
        for (VerbrauchRegeln.Geltend x : hier) {
            VerbrauchRegeln.Ersatzwert ew = x.ersatzwert();
            if (VerbrauchRegeln.VERTEILEN.contains(ew.methode())) continue;
            if (VerbrauchRegeln.ABLESESTAND_NACHTRAGEN.equals(ew.methode())) {
                // Der IP-13-Lauf hat Z4 bereits geprüft und gerechnet; keine zweite Rechnung aus einem Delta-Raten.
                List<ViertelVersion> vs = viertelVersionen(con, r, ew.von(), ew.bis()).getOrDefault(ew.von(), List.of());
                ViertelVersion v = vs.isEmpty() ? null : vs.get(vs.size() - 1);
                if (v == null || !v.ersatzwerte().contains(ew.kennung())) {
                    throw new Abgelehnt(KorrekturKaskade.ROHWERTE_FEHLEN, ew.kennung());
                }
                beitraege.add(beitrag(con, r, zone, ew, ew.von(), ew.bis(), v.inhalt().menge(),
                        v.inhalt().aussage()));
            } else if (ErsatzwertPerioden.periodenBetrag(ew, zone)) {
                beitraege.add(beitrag(con, r, zone, ew, ew.von(), ew.bis(), ew.betrag(), List.of()));
            } else {
                // Ein Profil lädt seine Grundlage einmal, nicht mit einer SQL-Abfrage je Viertelstunde.
                Map<Instant, Teilperiode> vorher = new TreeMap<>();
                teile(con, r, ew.von(), ew.bis()).teile().forEach(t -> vorher.put(t.von(), t));
                for (VerbrauchRegeln.Anteil anteil : x.anteile()) {
                    if (anteil.beginn().isBefore(beginn) || !anteil.beginn().isBefore(ende)) continue;
                    Teilperiode alt = vorher.get(anteil.beginn());
                    beitraege.add(beitrag(ew, anteil.beginn(), anteil.beginn().plus(VIERTELSTUNDE),
                            alt == null ? null : alt.ergebnis().menge(),
                            alt == null ? List.of() : alt.ergebnis().kennzeichen(), anteil.menge(), List.of()));
                }
            }
        }
        e = ErsatzwertPerioden.anwenden(e, beginn, ende, beitraege);
        Inhalt i = new Inhalt(wertart, e.menge(), e.zustand(), e.kennzeichen(), basis.erhalten(),
                basis.erwartet(), basis.abdeckung(), basis.standAnfang(), basis.standEnde(), basis.erster(),
                basis.letzter(), basis.summe(), basis.mittel(), basis.min(), basis.max(), basis.energie(),
                basis.gemessenS(), basis.lueckeInnen(), basis.zustand());
        return new Gebildet(i, List.copyOf(korrekturen), hier.stream().map(x -> x.ersatzwert().kennung()).toList());
    }

    // ============================================================================ Tag, Monat, Jahr

    private ErsatzwertPerioden.Beitrag beitrag(Connection con, Reihe r, ZoneId zone,
            VerbrauchRegeln.Ersatzwert ew, Instant von, Instant bis, BigDecimal neu, List<String> kennzeichen)
            throws SQLException {
        Teile t = teile(con, r, von, bis);
        ViertelstundenTeile.Geladen g = t.geladen();
        Inhalt alt = grundlage(r, zone, t.teile(), t.innen(von, bis), t.werteteile(), g.ereignisse(),
                g.deklaration(), g.wertart(), g.kadenzS(), von, bis, ViertelstundeRegeln.VORLAEUFIG);
        return beitrag(ew, von, bis, alt.menge(), alt.aussage(), neu, kennzeichen);
    }

    private static ErsatzwertPerioden.Beitrag beitrag(VerbrauchRegeln.Ersatzwert ew, Instant von, Instant bis,
            BigDecimal alt, List<String> alteKennzeichen, BigDecimal neu, List<String> kennzeichen) {
        // Randhinweise eines inneren Teils beschreiben nicht den Rand der gröberen Periode.
        List<String> neuInnen = kennzeichen.stream().filter(k -> !k.equals(VerbrauchRegeln.ANFANG_NICHT_GEMESSEN)
                && !k.equals(VerbrauchRegeln.ENDE_NICHT_GEMESSEN)).toList();
        List<String> altInnen = alteKennzeichen.stream().filter(k -> !k.equals(VerbrauchRegeln.ANFANG_NICHT_GEMESSEN)
                && !k.equals(VerbrauchRegeln.ENDE_NICHT_GEMESSEN)).toList();
        return new ErsatzwertPerioden.Beitrag(von, bis, alt, neu, altInnen, neuInnen,
                ew.kennung(), ew.methode());
    }

    /** Der TAG in der Standort-Zone; auch eine Periode ohne Messwerte kann einen belegten Betrag tragen. */
    Gebildet tag(Connection con, Reihe r, LocalDate tag, ZoneId zone, Gespeichert v1, Instant jetzt)
            throws SQLException {
        Instant beginn = TagRegeln.beginn(tag, zone);
        Instant ende = TagRegeln.ende(tag, zone);
        Teile t = teile(con, r, beginn, ende);
        List<Teilperiode> innen = t.innen(beginn, ende);
        ViertelstundenTeile.Geladen g = t.geladen();
        String zustand = v1 != null ? v1.inhalt().zustand()
                : TagRegeln.zustand(g.vorhanden(), g.endgueltig(), TagRegeln.endgueltigAb(ende), jetzt);
        String wertart = g.wertart();
        Inhalt basis = grundlage(r, zone, t.teile(), innen, t.werteteile(), g.ereignisse(), g.deklaration(), wertart,
                g.kadenzS(), beginn, ende, zustand);
        return mitErsatzwerten(con, r, zone, basis, beginn, ende, t.korrekturen());
    }

    /** Die GRUNDLAGE eines Monats aus seinen Viertelstunden (neueste Fassung, ohne Ersatzwerte) samt ihren Teilen. */
    private record Monatsgrundlage(Inhalt inhalt, Teile teile) {}

    private Monatsgrundlage monatsgrundlage(Connection con, Reihe r, LocalDate erster, ZoneId zone, String zustand)
            throws SQLException {
        Instant beginn = TagRegeln.beginn(erster, zone);
        Instant ende = TagRegeln.beginn(erster.plusMonths(1), zone);
        Teile t = teile(con, r, beginn, ende);
        List<Teilperiode> innen = t.innen(beginn, ende);
        ViertelstundenTeile.Geladen g = t.geladen();
        return new Monatsgrundlage(grundlage(r, zone, t.teile(), innen, t.werteteile(), g.ereignisse(),
                g.deklaration(), g.wertart(), g.kadenzS(), beginn, ende, zustand), t);
    }

    /** Der MONAT ab {@code erster} — aus seinen Viertelstunden wie {@link PeriodeVerdichter}. */
    Gebildet monat(Connection con, Reihe r, LocalDate erster, ZoneId zone, Gespeichert v1) throws SQLException {
        Monatsgrundlage m = monatsgrundlage(con, r, erster, zone,
                v1 != null ? v1.inhalt().zustand() : ViertelstundeRegeln.VORLAEUFIG);
        if (m == null) {
            return null;
        }
        return mitErsatzwerten(con, r, zone, m.inhalt(), TagRegeln.beginn(erster, zone),
                TagRegeln.beginn(erster.plusMonths(1), zone), m.teile().korrekturen());
    }

    /**
     * Das JAHR ab {@code erster} — aus seinen Monaten wie {@link PeriodeVerdichter}: ein Monat mit Viertelstunden-Versionen
     * geht mit seiner neu gebildeten Grundlage ein, jeder andere mit seiner Zeile von Version 1; die Ersatzwerte legt die
     * Regel über das ganze Jahr.
     */
    Gebildet jahr(Connection con, Reihe r, LocalDate erster, ZoneId zone, Gespeichert v1) throws SQLException {
        Instant beginn = TagRegeln.beginn(erster, zone);
        Instant ende = TagRegeln.beginn(erster.plusYears(1), zone);
        Set<LocalDate> mitVersion = monateMitViertelVersion(con, r, erster.minusMonths(1), erster.plusYears(1)
                .plusMonths(1), zone);
        Map<LocalDate, Teilperiode> teile = new TreeMap<>();
        Map<LocalDate, Werteteil> werteteile = new TreeMap<>();
        Set<String> korrekturen = new LinkedHashSet<>();
        String wertart = null;
        Integer kadenzS = null;
        for (Map.Entry<LocalDate, MonatsZeile> e : monatsZeilen(con, r, erster.minusMonths(1), erster.plusYears(1))
                .entrySet()) {
            MonatsZeile z = e.getValue();
            teile.put(e.getKey(), z.teil());
            werteteile.put(e.getKey(), z.werteteil());
            if (!e.getKey().isBefore(erster) && e.getKey().isBefore(erster.plusYears(1))) {
                wertart = z.wertart() != null ? z.wertart() : wertart;
                kadenzS = z.kadenzS();
            }
        }
        for (LocalDate monat : mitVersion) {
            Monatsgrundlage m = monatsgrundlage(con, r, monat, zone, ViertelstundeRegeln.VORLAEUFIG);
            if (m == null) {
                teile.remove(monat);
                werteteile.remove(monat);
                continue;
            }
            Inhalt i = m.inhalt();
            Instant mb = TagRegeln.beginn(monat, zone);
            Instant me = TagRegeln.beginn(monat.plusMonths(1), zone);
            Teilperiode t = new Teilperiode(mb, me, i.standAnfang(), i.standEnde(), i.erster(), i.letzter(),
                    new Ergebnis(i.menge(), null, null, null, null, i.mengeZustand(), nullAlsNull(i.erhalten()),
                            nullAlsNull(i.erwartet()), null, i.kennzeichen()));
            teile.put(monat, t);
            werteteile.put(monat, new Werteteil(new Teilperiode(mb, me, null, null, i.erster(), i.letzter(),
                    new Ergebnis(i.menge(), i.mittel(), i.min(), i.max(), null, i.mengeZustand(),
                            nullAlsNull(i.erhalten()), nullAlsNull(i.erwartet()), null, i.kennzeichen())),
                    i.summe(), i.energie(), i.gemessenS() == null ? 0 : i.gemessenS(),
                    i.lueckeInnen() != null && i.lueckeInnen()));
            if (!monat.isBefore(erster) && monat.isBefore(erster.plusYears(1))) {
                korrekturen.addAll(m.teile().korrekturen());
                wertart = i.wertart() != null ? i.wertart() : wertart;
                kadenzS = m.teile().geladen().kadenzS() != null ? m.teile().geladen().kadenzS() : kadenzS;
            }
        }
        List<Teilperiode> alle = List.copyOf(teile.values());
        List<Teilperiode> innen = alle.stream().filter(t -> !t.von().isBefore(beginn) && !t.bis().isAfter(ende))
                .toList();
        ZaehlerDeklaration deklaration = ZaehlerDeklaration.lesen(con, r.tenant(), r.entity(), r.kanal(), beginn);
        List<VerbrauchRegeln.Ereignis> ereignisse = ViertelstundenTeile.ereignisse(con, r.tenant(), r.entity(),
                r.kanal(), beginn, ende, deklaration);
        Inhalt basis = grundlage(r, zone, alle, innen, List.copyOf(werteteile.values()), ereignisse, deklaration,
                wertart, kadenzS, beginn, ende, v1 != null ? v1.inhalt().zustand() : ViertelstundeRegeln.VORLAEUFIG);
        return mitErsatzwerten(con, r, zone, basis, beginn, ende, korrekturen);
    }

    private record MonatsZeile(Teilperiode teil, Werteteil werteteil, String wertart, Integer kadenzS) {}

    /** Die Monatszeilen von Version 1 in {@code [von, bis]} — wie {@link PeriodeVerdichter} sie ins Jahr gibt. */
    private static Map<LocalDate, MonatsZeile> monatsZeilen(Connection con, Reihe r, LocalDate von, LocalDate bis)
            throws SQLException {
        Map<LocalDate, MonatsZeile> aus = new TreeMap<>();
        try (PreparedStatement ps = con.prepareStatement(
                "SELECT tag, beginn, ende, stand_anfang, stand_anfang_zeit, stand_ende, stand_ende_zeit, "
                        + "erster_wert, erster_zeit, letzter_wert, letzter_zeit, menge, menge_zustand, "
                        + "erhalten, erwartet, kennzeichen::text, kadenz_s, wertart, "
                        + "summe, mittel, min_wert, max_wert, energie, gemessen_s, luecke_innen "
                        + "FROM messreihe_periode WHERE tenant_id = ? AND entity_id = ? AND messkanal = ? "
                        + "AND art = 'monat' AND tag >= ? AND tag <= ? ORDER BY tag")) {
            ps.setObject(1, r.tenant());
            ps.setObject(2, r.entity());
            ps.setString(3, r.kanal());
            ps.setObject(4, von);
            ps.setObject(5, bis);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    Teilperiode t = new Teilperiode(ViertelstundenTeile.zeit(rs, 2), ViertelstundenTeile.zeit(rs, 3),
                            ViertelstundenTeile.wert(rs, 4, 5), ViertelstundenTeile.wert(rs, 6, 7),
                            ViertelstundenTeile.wert(rs, 8, 9), ViertelstundenTeile.wert(rs, 10, 11),
                            new Ergebnis(rs.getBigDecimal(12), null, null, null, null, rs.getString(13),
                                    rs.getInt(14), rs.getInt(15), null,
                                    ViertelstundenTeile.kennzeichen(rs.getString(16))));
                    Integer gemessen = (Integer) rs.getObject(24);
                    Boolean luecke = (Boolean) rs.getObject(25);
                    Werteteil w = new Werteteil(new Teilperiode(t.von(), t.bis(), null, null, t.erster(), t.letzter(),
                            new Ergebnis(t.ergebnis().menge(), rs.getBigDecimal(20), rs.getBigDecimal(21),
                                    rs.getBigDecimal(22), null, t.ergebnis().zustand(), t.ergebnis().erhalten(),
                                    t.ergebnis().erwartet(), null, t.ergebnis().kennzeichen())),
                            rs.getBigDecimal(19), rs.getBigDecimal(23), gemessen == null ? 0 : gemessen,
                            luecke != null && luecke);
                    aus.put(rs.getDate(1).toLocalDate(), new MonatsZeile(t, w, rs.getString(18), ganz(rs, 17)));
                }
            }
        }
        return aus;
    }

    /** Die ersten Tage der Monate in {@code [von, bis)}, in denen eine Viertelstunde eine Version hat. */
    private static Set<LocalDate> monateMitViertelVersion(Connection con, Reihe r, LocalDate von, LocalDate bis,
            ZoneId zone) throws SQLException {
        Set<LocalDate> aus = new java.util.TreeSet<>();
        try (PreparedStatement ps = con.prepareStatement("SELECT DISTINCT intervall_beginn "
                + "FROM messreihe_viertelstunde_version WHERE tenant_id = ? AND entity_id = ? AND messkanal = ? "
                + "AND intervall_beginn >= ? AND intervall_beginn < ?")) {
            ps.setObject(1, r.tenant());
            ps.setObject(2, r.entity());
            ps.setString(3, r.kanal());
            ps.setTimestamp(4, Timestamp.from(TagRegeln.beginn(von, zone)));
            ps.setTimestamp(5, Timestamp.from(TagRegeln.beginn(bis, zone)));
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    aus.add(TagRegeln.tag(ViertelstundenTeile.zeit(rs, 1), zone).withDayOfMonth(1));
                }
            }
        }
        return aus;
    }

    // ============================================================================ Gespeichert: Version 1 und Versionen

    /** Version 1 eines Tages, Monats oder Jahres der Reihe — {@code null} ohne Zeile. */
    static Gespeichert bestand(Connection con, Reihe r, String ebene, LocalDate tag) throws SQLException {
        String sql = "SELECT wertart, menge, menge_zustand, kennzeichen::text, erhalten, erwartet, abdeckung_prozent, "
                + "stand_anfang, stand_anfang_zeit, stand_ende, stand_ende_zeit, erster_wert, erster_zeit, letzter_wert, "
                + "letzter_zeit, summe, mittel, min_wert, max_wert, energie, gemessen_s, luecke_innen, zustand, "
                + "berechnet_am, zeitzone FROM "
                + (TAG.equals(ebene) ? "messreihe_tag WHERE " : "messreihe_periode WHERE art = '" + ebene + "' AND ")
                + "tenant_id = ? AND entity_id = ? AND messkanal = ? AND tag = ?";
        try (PreparedStatement ps = con.prepareStatement(sql)) {
            ps.setObject(1, r.tenant());
            ps.setObject(2, r.entity());
            ps.setString(3, r.kanal());
            ps.setObject(4, tag);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    return null;
                }
                Inhalt i = new Inhalt(rs.getString(1), rs.getBigDecimal(2),
                        rs.getString(3) == null ? VerbrauchRegeln.KEINE_WERTE : rs.getString(3),
                        ViertelstundenTeile.kennzeichen(rs.getString(4)), ganz(rs, 5), ganz(rs, 6), ganz(rs, 7),
                        ViertelstundenTeile.wert(rs, 8, 9), ViertelstundenTeile.wert(rs, 10, 11),
                        ViertelstundenTeile.wert(rs, 12, 13), ViertelstundenTeile.wert(rs, 14, 15),
                        rs.getBigDecimal(16), rs.getBigDecimal(17), rs.getBigDecimal(18), rs.getBigDecimal(19),
                        rs.getBigDecimal(20), ganz(rs, 21), (Boolean) rs.getObject(22), rs.getString(23));
                return new Gespeichert(1, i, List.of(), List.of(), null, ViertelstundenTeile.zeit(rs, 24));
            }
        }
    }

    /** Die Zone einer gespeicherten Tages-/Monats-/Jahreszeile der Reihe — {@code null} ohne Zeile. */
    static ZoneId zoneDerZeile(Connection con, Reihe r, String ebene, LocalDate tag) throws SQLException {
        String sql = "SELECT zeitzone FROM "
                + (TAG.equals(ebene) ? "messreihe_tag WHERE " : "messreihe_periode WHERE art = '" + ebene + "' AND ")
                + "tenant_id = ? AND entity_id = ? AND messkanal = ? AND tag = ?";
        try (PreparedStatement ps = con.prepareStatement(sql)) {
            ps.setObject(1, r.tenant());
            ps.setObject(2, r.entity());
            ps.setString(3, r.kanal());
            ps.setObject(4, tag);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() && rs.getString(1) != null ? TagRegeln.zone(rs.getString(1)) : null;
            }
        }
    }

    private static final String PERIODE_SPALTEN = "version, wertart, menge, menge_zustand, kennzeichen::text, erhalten, "
            + "erwartet, abdeckung_prozent, stand_anfang, stand_anfang_zeit, stand_ende, stand_ende_zeit, erster_wert, "
            + "erster_zeit, letzter_wert, letzter_zeit, summe, mittel, min_wert, max_wert, energie, gemessen_s, "
            + "luecke_innen, zustand, korrekturen, ersatzwerte, anlass_kennung, basis_berechnet_am";

    /**
     * Die neueste Version einer Periode — der Reihe ({@code messstelle} {@code null}) oder einer berechneten Messstelle;
     * {@code null} ohne Version.
     */
    static Gespeichert neuesteVersion(Connection con, UUID tenant, UUID entity, String kanal, UUID messstelle,
            String ebene, Instant beginn) throws SQLException {
        String spur = messstelle == null
                ? "messstelle_id IS NULL AND entity_id = ? AND messkanal = ?"
                : "messstelle_id = ?";
        try (PreparedStatement ps = con.prepareStatement("SELECT " + PERIODE_SPALTEN + " FROM messreihe_periode_version "
                + "WHERE tenant_id = ? AND " + spur + " AND ebene = ? AND periode_beginn = ? ORDER BY version DESC LIMIT 1")) {
            int p = 1;
            ps.setObject(p++, tenant);
            if (messstelle == null) {
                ps.setObject(p++, entity);
                ps.setString(p++, kanal);
            } else {
                ps.setObject(p++, messstelle);
            }
            ps.setString(p++, ebene);
            ps.setTimestamp(p, Timestamp.from(beginn));
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    return null;
                }
                Inhalt i = new Inhalt(rs.getString(2), rs.getBigDecimal(3), rs.getString(4),
                        ViertelstundenTeile.kennzeichen(rs.getString(5)), ganz(rs, 6), ganz(rs, 7), ganz(rs, 8),
                        ViertelstundenTeile.wert(rs, 9, 10), ViertelstundenTeile.wert(rs, 11, 12),
                        ViertelstundenTeile.wert(rs, 13, 14), ViertelstundenTeile.wert(rs, 15, 16),
                        rs.getBigDecimal(17), rs.getBigDecimal(18), rs.getBigDecimal(19), rs.getBigDecimal(20),
                        rs.getBigDecimal(21), ganz(rs, 22), (Boolean) rs.getObject(23), rs.getString(24));
                return new Gespeichert(rs.getInt(1), i, texte(rs.getArray(25)), texte(rs.getArray(26)),
                        rs.getString(27), ViertelstundenTeile.zeit(rs, 28));
            }
        }
    }

    /** Eine Periode, deren Version geschrieben oder nachgezogen wird. */
    record Periode(UUID tenant, String ebene, UUID entity, String kanal, UUID messstelle, Instant beginn, Instant ende,
            LocalDate tag, ZoneId zone) {}

    /** Schreibt Version {@code version} einer Periode. */
    static void periodeSchreiben(Connection con, Periode p, int version, Inhalt inhalt, List<String> korrekturen,
            List<String> ersatzwerte, String anlassKennung, int anlassFassung, Instant basisBerechnetAm)
            throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("""
                INSERT INTO messreihe_periode_version (tenant_id, ebene, entity_id, messkanal, messstelle_id,
                    periode_beginn, periode_ende, tag, zeitzone, version, wertart, menge, menge_zustand, kennzeichen,
                    zustand, korrekturen, ersatzwerte, anlass_kennung, anlass_fassung, basis_berechnet_am,
                    stand_anfang, stand_anfang_zeit, stand_ende, stand_ende_zeit, erster_wert, erster_zeit, letzter_wert,
                    letzter_zeit, erhalten, erwartet, abdeckung_prozent, summe, mittel, min_wert, max_wert, energie,
                    gemessen_s, luecke_innen)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?)
                """)) {
            int i = 1;
            ps.setObject(i++, p.tenant());
            ps.setString(i++, p.ebene());
            ps.setObject(i++, p.entity(), Types.OTHER);
            ps.setString(i++, p.kanal());
            ps.setObject(i++, p.messstelle(), Types.OTHER);
            ps.setTimestamp(i++, Timestamp.from(p.beginn()));
            ps.setTimestamp(i++, Timestamp.from(p.ende()));
            ps.setObject(i++, p.tag(), Types.DATE);
            ps.setString(i++, p.zone().getId());
            ps.setInt(i++, version);
            ps.setString(i++, inhalt.wertart());
            ps.setBigDecimal(i++, inhalt.menge());
            ps.setString(i++, inhalt.mengeZustand());
            ps.setString(i++, ViertelstundeRegeln.kennzeichenJson(inhalt.kennzeichenMitVersion(version)));
            ps.setString(i++, inhalt.zustand());
            ps.setArray(i++, con.createArrayOf("text", korrekturen.toArray()));
            ps.setArray(i++, con.createArrayOf("text", ersatzwerte.toArray()));
            ps.setString(i++, anlassKennung);
            ps.setInt(i++, anlassFassung);
            ps.setTimestamp(i++, basisBerechnetAm == null ? null : Timestamp.from(basisBerechnetAm));
            fakten(ps, i, inhalt);
        }
    }

    /**
     * Zieht die NEUESTE, noch VORLÄUFIGE Version einer Periode nach (dieselbe Nummer): ihre Grundlage — Version 1 — hat
     * sich weiterentwickelt, und eine vorläufige Zahl darf das, bis sie endgültig ist. Die Datenbank lässt das nur für
     * die neueste vorläufige Version zu ({@code messreihe_periode_version_nachzug}).
     */
    static void periodeNachziehen(Connection con, Periode p, int version, Inhalt inhalt, List<String> korrekturen,
            List<String> ersatzwerte, Instant basisBerechnetAm) throws SQLException {
        String spur = p.messstelle() == null
                ? "messstelle_id IS NULL AND entity_id = ? AND messkanal = ?"
                : "messstelle_id = ?";
        try (PreparedStatement ps = con.prepareStatement("UPDATE messreihe_periode_version SET wertart = ?, menge = ?, "
                + "menge_zustand = ?, kennzeichen = ?::jsonb, zustand = ?, korrekturen = ?, ersatzwerte = ?, "
                + "basis_berechnet_am = ?, stand_anfang = ?, stand_anfang_zeit = ?, stand_ende = ?, stand_ende_zeit = ?, "
                + "erster_wert = ?, erster_zeit = ?, letzter_wert = ?, letzter_zeit = ?, erhalten = ?, erwartet = ?, "
                + "abdeckung_prozent = ?, summe = ?, mittel = ?, min_wert = ?, max_wert = ?, energie = ?, gemessen_s = ?, "
                + "luecke_innen = ?, nachgezogen_am = now() WHERE tenant_id = ? AND " + spur
                + " AND ebene = ? AND periode_beginn = ? AND version = ?")) {
            int i = 1;
            ps.setString(i++, inhalt.wertart());
            ps.setBigDecimal(i++, inhalt.menge());
            ps.setString(i++, inhalt.mengeZustand());
            ps.setString(i++, ViertelstundeRegeln.kennzeichenJson(inhalt.kennzeichenMitVersion(version)));
            ps.setString(i++, inhalt.zustand());
            ps.setArray(i++, con.createArrayOf("text", korrekturen.toArray()));
            ps.setArray(i++, con.createArrayOf("text", ersatzwerte.toArray()));
            ps.setTimestamp(i++, basisBerechnetAm == null ? null : Timestamp.from(basisBerechnetAm));
            wert(ps, i, inhalt.standAnfang());
            i += 2;
            wert(ps, i, inhalt.standEnde());
            i += 2;
            wert(ps, i, inhalt.erster());
            i += 2;
            wert(ps, i, inhalt.letzter());
            i += 2;
            ganz(ps, i++, inhalt.erhalten());
            ganz(ps, i++, inhalt.erwartet());
            ganz(ps, i++, inhalt.abdeckung());
            ps.setBigDecimal(i++, inhalt.summe());
            ps.setBigDecimal(i++, inhalt.mittel());
            ps.setBigDecimal(i++, inhalt.min());
            ps.setBigDecimal(i++, inhalt.max());
            ps.setBigDecimal(i++, inhalt.energie());
            ganz(ps, i++, inhalt.gemessenS());
            ps.setObject(i++, inhalt.lueckeInnen(), Types.BOOLEAN);
            ps.setObject(i++, p.tenant());
            if (p.messstelle() == null) {
                ps.setObject(i++, p.entity());
                ps.setString(i++, p.kanal());
            } else {
                ps.setObject(i++, p.messstelle());
            }
            ps.setString(i++, p.ebene());
            ps.setTimestamp(i++, Timestamp.from(p.beginn()));
            ps.setInt(i, version);
            ps.executeUpdate();
        }
    }

    // ============================================================================ Hilfen

    static List<String> texte(Array a) throws SQLException {
        return a == null ? null : Arrays.asList((String[]) a.getArray());
    }

    static Integer ganz(ResultSet rs, int spalte) throws SQLException {
        Object o = rs.getObject(spalte);
        return o == null ? null : ((Number) o).intValue();
    }

    private static void ganz(PreparedStatement ps, int p, Integer wert) throws SQLException {
        if (wert == null) {
            ps.setNull(p, Types.INTEGER);
        } else {
            ps.setInt(p, wert);
        }
    }

    private static void wert(PreparedStatement ps, int p, Rohwert r) throws SQLException {
        ps.setBigDecimal(p, r == null ? null : r.wert());
        ps.setTimestamp(p + 1, r == null ? null : Timestamp.from(r.zeit()));
    }

    private static int nullAlsNull(Integer i) {
        return i == null ? 0 : i;
    }

    /** Kennzeichen-Listen ohne „korrigiert (Version n)“ — was ein Teil an eine gröbere Periode weitergibt. */
    static List<String> ohneVersion(List<String> kennzeichen) {
        return kennzeichen == null ? List.of()
                : kennzeichen.stream().filter(k -> !ErgebnisZustand.istKorrigiert(k)).toList();
    }
}
