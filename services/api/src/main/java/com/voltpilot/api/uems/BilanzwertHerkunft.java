package com.voltpilot.api.uems;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
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
}
