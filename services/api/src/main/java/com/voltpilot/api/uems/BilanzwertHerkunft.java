package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.YearMonth;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Die HERKUNFT eines berechneten oder verteilten Werts (UEMS AP-10 §4.7, E13).
 *
 * <p>Ein EIGENER, additiver Vertrag: der Messwert-Herkunftsvertrag (AP-07,
 * {@code messwert-herkunft.md}, {@link MesswertHerkunft}) beschreibt einen GEMESSENEN Wert und
 * bleibt unberührt. Dieser hier beschreibt den Satz, der an einem BERECHNETEN oder VERTEILTEN Wert
 * hängt: Formel-Typ und -Fassung, jeder Eingang mit Menge, Zustand, Abdeckung und VERSION, bei
 * einer Verteilung deren Fassung und Anteil, dazu Rechenzeitpunkt, Version, Zustand, Kennzeichen
 * und — ab Version 2 — der Auslöser.
 *
 * <p>Die Form steht in {@code docs/contracts/v2/bilanzwert-herkunft.schema.json}, die Fälle in
 * {@code bilanz-vectors.json} und {@code verteilung-vectors.json} (Regel {@code herkunft}).
 *
 * <p>Der Satz ist eine Karte in Vertragsschreibweise (snake_case, Beträge als Dezimaltext) — genau
 * so, wie er die Schnittstelle verlässt. Beträge sind deshalb TEXT: {@code null} ist nie 0, und ein
 * Dezimaltext wird nie umformatiert.
 *
 * <p>Rein: ohne Spring, ohne DB, ohne Uhr.
 */
public final class BilanzwertHerkunft {

    private BilanzwertHerkunft() {}

    public static final String BERECHNET = "berechnet";
    public static final String VERTEILT = "verteilt";

    /** Der Formel-Typ {@code rest} leitet seine Fassung je Tag aus der Stellung ab. */
    public static final String TYP_REST = "rest";

    /** Ein Eingang der Rechnung, so wie die Herkunft ihn nennt. */
    public record Eingangswert(
            String messstelle,
            String bilanzRolle,
            String anteil,
            String menge,
            String zustand,
            Integer abdeckungProzent,
            int version,
            List<String> kennzeichen) {}

    /** Der Bezug auf die Verteilung, aus der ein verteilter Wert entstanden ist. */
    public record Verteilungsbezug(int fassung, String ziel, String anteilProzent) {}

    /** Die Formel-Fassung: eine Nummer ODER der Satz, mit dem `rest` sie je Tag ableitet. */
    public record Fassung(Integer nummer, String text) {
        public static Fassung nummer(int n) {
            return new Fassung(n, null);
        }

        public static Fassung text(String t) {
            return new Fassung(null, t);
        }

        Object wert() {
            return nummer != null ? nummer : text;
        }
    }

    /** Das Ergebnis, dessen Herkunft der Satz beschreibt. */
    public record Ergebnis(String menge, String zustand, Integer abdeckungProzent, List<String> kennzeichen) {}

    /** Alles, was die Herkunft braucht — sie erfindet nichts dazu. */
    public record Eingang(
            String art,
            String messstelle,
            String periodeArt,
            String periodeSchluessel,
            String formelTyp,
            Fassung formelFassung,
            String periodeEnde,
            String berechnetAm,
            int version,
            String ausloeser,
            Verteilungsbezug verteilung,
            List<Eingangswert> eingaenge,
            Ergebnis ergebnis) {}

    /**
     * {@code satz == null} heißt: die Herkunft ist unvollständig — {@code fehlt} nennt jede
     * fehlende Pflichtangabe. Eine halbe Herkunft wird nie ausgeliefert.
     */
    public record Urteil(Map<String, Object> satz, List<String> fehlt) {}

    /**
     * Baut den Herkunfts-Satz und prüft ihn in fester Reihenfolge. Die Regeln:
     *
     * <ul>
     *   <li>{@code art} ist {@code berechnet} oder {@code verteilt} — nichts sonst.
     *   <li>{@code verteilt} braucht die Verteilung (Fassung, Ziel, Anteil) und genau EINEN Eingang;
     *       einen Formel-Typ hat es nie.
     *   <li>{@code berechnet} braucht den Formel-Typ und mindestens einen Eingang.
     *   <li>Beim Typ {@code rest} trägt jeder Eingang seine Bilanz-Rolle — ohne sie wäre nicht
     *       erkennbar, ob er zugeflossen, abgeflossen oder zugeordnet war.
     *   <li>Ab Version 2 ist der Auslöser Pflicht: eine Neuberechnung, die ihre Ursache verschweigt,
     *       ist keine Herkunft.
     *   <li>Das Ergebnis nennt Zustand und Kennzeichen; die Kennzeichen des Ergebnisses reisen
     *       unverändert in den Satz.
     * </ul>
     */
    public static Urteil herkunft(Eingang e) {
        List<String> fehlt = new ArrayList<>();
        if (!BERECHNET.equals(e.art()) && !VERTEILT.equals(e.art())) {
            fehlt.add("art");
        }
        if (e.messstelle() == null || e.messstelle().isBlank()) {
            fehlt.add("messstelle");
        }
        if (e.periodeArt() == null || e.periodeSchluessel() == null) {
            fehlt.add("periode");
        }
        if (VERTEILT.equals(e.art())) {
            if (e.verteilung() == null) {
                fehlt.add("verteilung");
            }
            if (e.eingaenge().size() != 1) {
                fehlt.add("eingaenge");
            }
        } else if (BERECHNET.equals(e.art())) {
            if (e.formelTyp() == null) {
                fehlt.add("formel_typ");
            }
            if (e.eingaenge().isEmpty()) {
                fehlt.add("eingaenge");
            }
            if (TYP_REST.equals(e.formelTyp())
                    && e.eingaenge().stream().anyMatch(w -> w.bilanzRolle() == null)) {
                fehlt.add("bilanz_rolle");
            }
        }
        if (e.berechnetAm() == null || e.berechnetAm().isBlank()) {
            fehlt.add("berechnet_am");
        }
        if (e.version() > 1 && (e.ausloeser() == null || e.ausloeser().isBlank())) {
            fehlt.add("ausloeser");
        }
        if (e.ergebnis() == null || e.ergebnis().zustand() == null || e.ergebnis().kennzeichen() == null) {
            fehlt.add("ergebnis");
        }
        if (!fehlt.isEmpty()) {
            return new Urteil(null, List.copyOf(fehlt));
        }

        Map<String, Object> periode = new LinkedHashMap<>();
        periode.put("art", e.periodeArt());
        periode.put("schluessel", e.periodeSchluessel());

        List<Map<String, Object>> eingaenge = new ArrayList<>();
        for (Eingangswert w : e.eingaenge()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("messstelle", w.messstelle());
            m.put("bilanz_rolle", w.bilanzRolle());
            m.put("anteil", w.anteil());
            m.put("menge", w.menge());
            m.put("zustand", w.zustand());
            m.put("abdeckung_prozent", w.abdeckungProzent());
            m.put("version", w.version());
            m.put("kennzeichen", List.copyOf(w.kennzeichen()));
            eingaenge.add(m);
        }

        Map<String, Object> verteilung = null;
        if (e.verteilung() != null) {
            verteilung = new LinkedHashMap<>();
            verteilung.put("fassung", e.verteilung().fassung());
            verteilung.put("ziel", e.verteilung().ziel());
            verteilung.put("anteil_prozent", e.verteilung().anteilProzent());
        }

        Map<String, Object> satz = new LinkedHashMap<>();
        satz.put("art", e.art());
        satz.put("messstelle", e.messstelle());
        satz.put("periode", periode);
        satz.put("formel_typ", BERECHNET.equals(e.art()) ? e.formelTyp() : null);
        satz.put("formel_fassung",
                BERECHNET.equals(e.art()) && e.formelFassung() != null ? e.formelFassung().wert() : null);
        satz.put("periode_ende", e.periodeEnde());
        satz.put("berechnet_am", e.berechnetAm());
        satz.put("version", e.version());
        satz.put("ausloeser", e.ausloeser());
        satz.put("verteilung", verteilung);
        satz.put("eingaenge", eingaenge);
        satz.put("kennzeichen", List.copyOf(e.ergebnis().kennzeichen()));
        satz.put("menge", e.ergebnis().menge());
        satz.put("zustand", e.ergebnis().zustand());
        satz.put("abdeckung_prozent", e.ergebnis().abdeckungProzent());
        return new Urteil(satz, List.of());
    }

    // ------------------------------------------------------------------ Die Routen (AP-10 IP-12)

    /**
     * Die Hülle, in der jede Route den Satz ausliefert: {@code {"satz": …, "fehlt": […]}}. Eine Zahl, die NICHT
     * berechnet ist (gemessen, oder ein Schritt ohne Zahl), trägt statt der Hülle {@code null} — nie eine leere.
     */
    public static Map<String, Object> umschlag(Urteil u) {
        Map<String, Object> raus = new LinkedHashMap<>();
        raus.put("satz", u.satz());
        raus.put("fehlt", u.fehlt());
        return raus;
    }

    /** Ein Betrag als Dezimaltext: ohne nachgestellte Nullen, ohne Exponent; {@code null} bleibt {@code null}. */
    public static String betrag(BigDecimal zahl) {
        return zahl == null ? null : zahl.stripTrailingZeros().toPlainString();
    }

    /** Der Schlüssel einer Periode, deren Beginn {@code beginn} ist, in der Zone des Standorts. */
    public static String schluessel(String periodeArt, Instant beginn, ZoneId zone) {
        ZonedDateTime b = beginn.atZone(zone);
        return switch (periodeArt) {
            case "viertelstunde" -> SEKUNDE.format(b);
            case "tag" -> b.toLocalDate().toString();
            case "monat" -> YearMonth.from(b).toString();
            case "jahr" -> String.valueOf(b.getYear());
            default -> throw new IllegalArgumentException("unbekannte Periode " + periodeArt);
        };
    }

    /**
     * Das Ende der Periode: ihre LETZTE Sekunde in der Zone des Standorts ({@code 2026-10-18T23:59:59+02:00}) — die
     * Form, in der die Vorlage es an F1 und F5 nennt. Abgeleitet, nie geraten: jede Route nennt es für jeden Wert.
     */
    public static String periodeEnde(String periodeArt, String schluessel, ZoneId zone) {
        ZonedDateTime naechste = switch (periodeArt) {
            case "viertelstunde" -> OffsetDateTime.parse(schluessel).toInstant().plusSeconds(900).atZone(zone);
            case "tag" -> LocalDate.parse(schluessel).plusDays(1).atStartOfDay(zone);
            case "monat" -> YearMonth.parse(schluessel).plusMonths(1).atDay(1).atStartOfDay(zone);
            case "jahr" -> LocalDate.of(Integer.parseInt(schluessel) + 1, 1, 1).atStartOfDay(zone);
            default -> throw new IllegalArgumentException("unbekannte Periode " + periodeArt);
        };
        return SEKUNDE.format(naechste.minusSeconds(1));
    }

    /**
     * Der Auslöser einer Version ≥ 2 ({@code correction MS-17 2026-10-18 Version 2}, F14): die Art des Anlasses
     * ({@code substitute} bei einem Ersatzwert {@code EW-…}, sonst {@code correction}), die Eingänge in neuerer Version
     * — ohne sie die Kennung des Anlasses —, die Periode und die Version. Ohne Anlass {@code null}: dann nennt der
     * Satz {@code ausloeser} als fehlend, statt eine Ursache zu erfinden.
     */
    public static String ausloeser(String anlass, List<String> messstellen, String schluessel, int version) {
        if (anlass == null || anlass.isBlank()) {
            return null;
        }
        String bezug = messstellen.isEmpty() ? anlass : String.join(", ", messstellen);
        return (anlass.startsWith("EW-") ? "substitute " : "correction ") + bezug + " " + schluessel + " Version "
                + version;
    }

    /** Ein Tag-Satz einer Verteilung der Messstelle (Tage, der letzte gehört dazu; {@code gueltigBis} null = offen). */
    public record VerteilungZeile(String ziel, BigDecimal anteilProzent, int fassung, LocalDate gueltigAb,
            LocalDate gueltigBis) {}

    /**
     * Die Verteilung eines BERECHNETEN Werts (F3: MS-15 zu 100 % an 4300): nur, wenn an JEDEM Tag der Periode genau
     * EINE Zeile gilt und alle dasselbe Ziel, denselben Anteil und dieselbe Fassung tragen — sonst {@code null}. Eine
     * Aufteilung auf mehrere Ziele beschreibt der verteilte Satz jeder Kostenstelle, nicht dieser.
     */
    public static Verteilungsbezug verteilungDerPeriode(List<VerteilungZeile> zeilen, LocalDate von, LocalDate bis) {
        VerteilungZeile erste = null;
        for (LocalDate t = von; !t.isAfter(bis); t = t.plusDays(1)) {
            LocalDate tag = t;
            List<VerteilungZeile> gelten = zeilen.stream()
                    .filter(z -> !z.gueltigAb().isAfter(tag) && (z.gueltigBis() == null || !z.gueltigBis().isBefore(tag)))
                    .toList();
            if (gelten.size() != 1) {
                return null;
            }
            VerteilungZeile z = gelten.get(0);
            if (erste == null) {
                erste = z;
            } else if (!erste.ziel().equals(z.ziel()) || erste.fassung() != z.fassung()
                    || erste.anteilProzent().compareTo(z.anteilProzent()) != 0) {
                return null;
            }
        }
        return erste == null ? null
                : new Verteilungsbezug(erste.fassung(), erste.ziel(), betrag(erste.anteilProzent()));
    }

    /** Ein gespeicherter Eingang ({@code bilanzwert_eingang}); {@code messstelle} null = ein Messkanal-Term. */
    public record GespeicherterEingang(String messstelle, String rolle, String anteil, BigDecimal menge,
            String zustand, Integer abdeckungProzent, Integer version, List<String> kennzeichen) {}

    /**
     * Ein gespeicherter berechneter Wert, wie ihn eine Route liest: die Zeile der Spur {@code berechnet} (AP-10 IP-10)
     * bzw. ihre Version aus der Kaskade, die Nummer ihrer Formel-Fassung, die Eingänge IN DIESER Version und — ab
     * Version 2 — die Kennung des Anlasses. {@code ergebnis} ist die Zahl, die die Route daneben zeigt.
     */
    public record Gespeichert(String messstelle, String periodeArt, Instant beginn, ZoneId zone, String formelTyp,
            Integer formelFassung, Instant berechnetAm, int version, String anlass,
            List<VerteilungZeile> verteilungen, List<GespeicherterEingang> eingaenge, Ergebnis ergebnis) {}

    /**
     * Der Satz eines gespeicherten berechneten Werts. Die Routen rechnen nichts nach: Schlüssel und Ende der Periode,
     * Rechenzeitpunkt in der Zone des Standorts, Beträge als {@link #betrag}, ein Eingang ohne Zahl mit Zustand „keine
     * Werte“ und Version 1, ohne Anteil „gesamt“, der Auslöser über {@link #ausloeser}, die Verteilung über
     * {@link #verteilungDerPeriode} an den Tagen der Periode. Zusätzlich zu den Regeln von
     * {@link #herkunft}: ohne Nummer der Formel-Fassung fehlt {@code formel_fassung}, ein Eingang ohne Messstelle
     * (Messkanal-Term) {@code eingang_messstelle} — beides wäre eine Herkunft, mit der sich die Zahl nicht nachrechnen
     * ließe.
     */
    public static Urteil ausGespeichert(Gespeichert g) {
        String schluessel = schluessel(g.periodeArt(), g.beginn(), g.zone());
        List<Eingangswert> werte = new ArrayList<>();
        List<String> neuer = new ArrayList<>();
        boolean ohneMessstelle = false;
        for (GespeicherterEingang e : g.eingaenge()) {
            int version = e.version() == null ? 1 : e.version();
            ohneMessstelle |= e.messstelle() == null;
            if (version > 1 && e.messstelle() != null && !neuer.contains(e.messstelle())) {
                neuer.add(e.messstelle());
            }
            werte.add(new Eingangswert(e.messstelle(), e.rolle(), e.anteil() == null ? "gesamt" : e.anteil(),
                    betrag(e.menge()), e.zustand() == null ? ErgebnisZustand.KEINE_WERTE : e.zustand(),
                    e.abdeckungProzent(), version, e.kennzeichen() == null ? List.of() : e.kennzeichen()));
        }
        Urteil u = herkunft(new Eingang(BERECHNET, g.messstelle(), g.periodeArt(), schluessel, g.formelTyp(),
                g.formelFassung() == null ? null : Fassung.nummer(g.formelFassung()),
                periodeEnde(g.periodeArt(), schluessel, g.zone()),
                g.berechnetAm() == null ? null : SEKUNDE.format(g.berechnetAm().atZone(g.zone())), g.version(),
                g.version() > 1 ? ausloeser(g.anlass(), neuer, schluessel, g.version()) : null,
                verteilungDerPeriode(g.verteilungen(), ersterTag(g.periodeArt(), schluessel, g.zone()),
                        letzterTag(g.periodeArt(), schluessel, g.zone())),
                List.copyOf(werte), g.ergebnis()));
        List<String> fehlt = new ArrayList<>(u.fehlt());
        if (g.formelFassung() == null) {
            fehlt.add("formel_fassung");
        }
        if (ohneMessstelle) {
            fehlt.add("eingang_messstelle");
        }
        return fehlt.isEmpty() ? u : new Urteil(null, List.copyOf(fehlt));
    }

    /** Der erste Tag der Periode (die Viertelstunde: ihr Tag in der Zone des Standorts). */
    static LocalDate ersterTag(String periodeArt, String schluessel, ZoneId zone) {
        return switch (periodeArt) {
            case "viertelstunde" -> OffsetDateTime.parse(schluessel).atZoneSameInstant(zone).toLocalDate();
            case "tag" -> LocalDate.parse(schluessel);
            case "monat" -> YearMonth.parse(schluessel).atDay(1);
            default -> LocalDate.of(Integer.parseInt(schluessel), 1, 1);
        };
    }

    /** Der letzte Tag der Periode — er gehört dazu. */
    static LocalDate letzterTag(String periodeArt, String schluessel, ZoneId zone) {
        return switch (periodeArt) {
            case "monat" -> YearMonth.parse(schluessel).atEndOfMonth();
            case "jahr" -> LocalDate.of(Integer.parseInt(schluessel), 12, 31);
            default -> ersterTag(periodeArt, schluessel, zone);
        };
    }

    private static final DateTimeFormatter SEKUNDE =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ssxxx", Locale.ROOT);
}
