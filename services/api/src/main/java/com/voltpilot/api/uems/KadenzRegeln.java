package com.voltpilot.api.uems;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Comparator;
import java.util.List;

/**
 * Die ERWARTETE KADENZ einer Quellenbindung (UEMS AP-07 IP-10, Captain-Entscheid E9 vom
 * 10.09.2026, Option A): „Kadenz = Feld der Quellenbindung (AP-04) mit Vorgabe aus Vorlage/Katalog,
 * zeitgültig (Fassung); reist als Soll zur Box ({@code cadence_s}, unverändert)."
 *
 * <p><b>Rein.</b> Kein Spring, keine Datenbank, keine Uhr: was gilt, entscheidet sich hier, wer es
 * liest und schreibt, steht in {@link QuelleKadenzService}.
 *
 * <p><b>Die Vorgabe-Kette</b> ({@link #wirksam}) ist die EINE Stelle, an der die Kadenz entsteht:
 *
 * <ol>
 *   <li>die eingetragene <b>Fassung</b> der Bindung, die zu diesem Zeitpunkt gilt;</li>
 *   <li>sonst die <b>Mess-Selektion</b> des Kanals ({@code device_measurement_selection.cadence_s} —
 *       das ist die Zahl, die die Vorlage bzw. der Anlege-Weg dort hinterlassen hat);</li>
 *   <li>sonst der <b>Katalog</b> ({@code default_cadence_s} des Messpunkts);</li>
 *   <li>sonst {@link #VORGABE_S} — 300 s, der Stand von {@code MeasurementCatalog.Point.view}.</li>
 * </ol>
 *
 * <p>Die Glieder 2–4 sind die Ableitung von VOR diesem Paket, Zeichen für Zeichen. Solange keine
 * abweichende Fassung eingetragen ist, rechnet also jede bestehende Fläche mit derselben Zahl wie
 * bisher — die Beobachtung „liefert Daten" (AP-04 IP-15) eingeschlossen.
 *
 * <p><b>⚠ Eine Fassung gilt AB ihrem Zeitpunkt, nie rückwärts.</b> Wer einen alten Zeitraum
 * auswertet, fragt mit DESSEN Zeitpunkt ({@link #fassungAm}) — nie mit „jetzt". Die Vergangenheit
 * behält ihre alte Erwartung (§4.6 Nr. 2).
 *
 * <p><b>⚠ Die Schranken sind die des Drahtvertrags</b> ({@code mqtt-measurement-config.schema.json}:
 * {@code cadence_s} 1 … 86 400) und der Mess-Selektion. Eine Fassung, die der Box nicht zustellbar
 * wäre, entsteht gar nicht erst — so bleibt die Nachricht an die Box, was sie ist. Eine manuell
 * abgelesene Messstelle (Referenz MS-21 Gas, „monatlich") hat keine Quellenbindung und darum auch
 * keine Fassung; ihre Erwartung ist AP-09.
 *
 * <p>Nicht hier: die Lücke ab 2 × Kadenz ({@link ZustandAbleitung#LUECKE_FAKTOR} und
 * {@link VerbrauchRegeln#LUECKE_FAKTOR} — dieselbe Schwelle, schon gebaut), die Toleranz der
 * Beobachtung ({@link ZustandAbleitung#toleranzS}), die Abdeckung je Periode
 * ({@link VerbrauchRegeln}) und der Verdichtungs-Job (IP-12).
 */
public final class KadenzRegeln {

    private KadenzRegeln() {}

    /** Die Kadenz, wenn weder Fassung noch Selektion noch Katalog eine nennt. */
    public static final int VORGABE_S = 300;

    /** Die Schranken des Drahtvertrags {@code mqtt-measurement-config.schema.json}. */
    public static final int KLEINSTE_S = 1;

    /** Siehe {@link #KLEINSTE_S}. */
    public static final int GROESSTE_S = 86400;

    // ------------------------------------------------------------------ Kette

    /** Woher die wirksame Kadenz kommt — in der Reihenfolge der Kette. */
    public enum Herkunft {
        /** Eine eingetragene Fassung der Bindung. */
        FASSUNG("fassung"),
        /** Die Mess-Selektion des Kanals (Vorlage bzw. Anlege-Weg). */
        AUSWAHL("auswahl"),
        /** {@code default_cadence_s} des Katalogpunkts. */
        KATALOG("katalog"),
        /** Keine von beiden nennt eine — {@link #VORGABE_S}. */
        VORGABE("vorgabe");

        private final String code;

        Herkunft(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /** Die wirksame Kadenz und woher sie kommt. */
    public record Wirksam(int erwartetS, Herkunft herkunft) {}

    /**
     * Die Vorgabe-Kette. {@code fassungS} ist die zum gefragten Zeitpunkt geltende Fassung
     * ({@link #fassungAm}), {@code auswahlS} die Kadenz der Mess-Selektion, {@code katalogS} die
     * Vorgabe des Katalogs — jedes {@code null}, wenn es sie nicht gibt. Eine Zahl außerhalb der
     * Schranken wird ÜBERGANGEN, nie zurechtgebogen (sie kann nur von Hand in die Datenbank
     * gekommen sein).
     */
    public static Wirksam wirksam(Integer fassungS, Integer auswahlS, Integer katalogS) {
        if (imRahmen(fassungS)) {
            return new Wirksam(fassungS, Herkunft.FASSUNG);
        }
        if (auswahlS != null) {
            return new Wirksam(auswahlS, Herkunft.AUSWAHL);
        }
        if (katalogS != null) {
            return new Wirksam(katalogS, Herkunft.KATALOG);
        }
        return new Wirksam(VORGABE_S, Herkunft.VORGABE);
    }

    /** Liegt die Zahl in den Schranken des Drahtvertrags? */
    public static boolean imRahmen(Integer erwartetS) {
        return erwartetS != null && erwartetS >= KLEINSTE_S && erwartetS <= GROESSTE_S;
    }

    // --------------------------------------------------------------- Fassungen

    /** Eine gespeicherte Fassung einer Bindung. */
    public record Fassung(String id, int erwartetS, Instant gueltigAb, Instant gueltigBis) {}

    /**
     * Die Fassung, die zu {@code t} gilt ({@code ab <= t < bis}); {@code null}, wenn keine — dann
     * greift die Vorgabe. ⚠ {@code t} ist der Zeitpunkt der Frage, nie „jetzt".
     */
    public static Fassung fassungAm(List<Fassung> fassungen, Instant t) {
        for (Fassung f : fassungen) {
            if (!f.gueltigAb().isAfter(t) && (f.gueltigBis() == null || t.isBefore(f.gueltigBis()))) {
                return f;
            }
        }
        return null;
    }

    // ----------------------------------------------------------------- Urteil

    /** Das geschlossene Ablehnungs-Vokabular (dieselben Wörter wie die Einstellungs-Fassungen). */
    public enum Fehler {
        /** Keine Zahl, oder außerhalb 1 … 86 400 s. */
        KADENZ_UNGUELTIG("kadenz_ungueltig", 400),
        /** Kein Zeitpunkt, oder nicht auf die volle Minute. */
        ZEITPUNKT_UNGUELTIG("zeitpunkt_ungueltig", 400),
        /** Vor dem Beginn der Quellenbindung. */
        VOR_BEGINN("vor_beginn", 422),
        /** Zum oder nach dem Ende der Quellenbindung. */
        NACH_ENDE("nach_ende", 422),
        /** Genau zu diesem Zeitpunkt beginnt schon eine Fassung. */
        BEGINN_BELEGT("beginn_belegt", 409),
        /** Dieselbe Zahl gilt dort schon. */
        UNVERAENDERT("unveraendert", 400);

        private final String code;
        private final int status;

        Fehler(String code, int status) {
            this.code = code;
            this.status = status;
        }

        public String code() {
            return code;
        }

        public int status() {
            return status;
        }
    }

    /**
     * @param bindungAb Beginn der Quellenbindung
     * @param bindungBis ihr Ende; {@code null} = offen
     * @param bestehende alle Fassungen dieser Bindung
     * @param erwartetS die beantragte Kadenz
     * @param gueltigAb ab wann sie gelten soll
     * @param jetzt die Uhr des Schreibwegs — sie entscheidet nur über „rückwirkend"
     */
    public record Eingang(Instant bindungAb, Instant bindungBis, List<Fassung> bestehende,
            Integer erwartetS, Instant gueltigAb, Instant jetzt) {}

    /** Die Fassung, die die neue beendet, und ab wann. */
    public record Beendet(String id, Instant gueltigBis) {}

    /**
     * Das Urteil: entweder {@code fehler}, oder der Plan — die zu {@code gueltigAb} gültige Fassung
     * endet dort ({@code beendet}), die neue gilt {@code [gueltigAb, gueltigBis)}.
     */
    public record Urteil(Fehler fehler, Beendet beendet, Instant gueltigAb, Instant gueltigBis,
            Boolean rueckwirkend, Fassung vorgaenger) {

        public boolean ok() {
            return fehler == null;
        }

        static Urteil abgelehnt(Fehler f) {
            return new Urteil(f, null, null, null, null, null);
        }
    }

    /**
     * Die neue Fassung in fester Prüfreihenfolge: Zahl → Zeitpunkt → vor dem Beginn → nach dem Ende
     * → Beginn belegt → unverändert. Die neue beendet die zu ihrem Beginn gültige GENAU DORT und
     * gilt bis zum Beginn der nächsten späteren (höchstens bis zum Ende der Bindung). Was davor
     * liegt, bleibt unangetastet — eine Kadenz-Änderung wirkt nie rückwärts.
     */
    public static Urteil neueFassung(Eingang e) {
        if (!imRahmen(e.erwartetS())) {
            return Urteil.abgelehnt(Fehler.KADENZ_UNGUELTIG);
        }
        if (e.gueltigAb() == null || !aufMinute(e.gueltigAb())) {
            return Urteil.abgelehnt(Fehler.ZEITPUNKT_UNGUELTIG);
        }
        if (e.gueltigAb().isBefore(e.bindungAb())) {
            return Urteil.abgelehnt(Fehler.VOR_BEGINN);
        }
        if (e.bindungBis() != null && !e.gueltigAb().isBefore(e.bindungBis())) {
            return Urteil.abgelehnt(Fehler.NACH_ENDE);
        }
        for (Fassung f : e.bestehende()) {
            if (f.gueltigAb().equals(e.gueltigAb())) {
                return Urteil.abgelehnt(Fehler.BEGINN_BELEGT);
            }
        }
        Fassung vorgaenger = fassungAm(e.bestehende(), e.gueltigAb());
        if (vorgaenger != null && vorgaenger.erwartetS() == e.erwartetS()) {
            return Urteil.abgelehnt(Fehler.UNVERAENDERT);
        }
        Instant bis = e.bestehende().stream().map(Fassung::gueltigAb)
                .filter(ab -> ab.isAfter(e.gueltigAb())).min(Comparator.naturalOrder()).orElse(null);
        if (e.bindungBis() != null && (bis == null || bis.isAfter(e.bindungBis()))) {
            bis = e.bindungBis();
        }
        boolean rueckwirkend = e.gueltigAb().isBefore(e.jetzt().truncatedTo(ChronoUnit.MINUTES));
        Beendet beendet = vorgaenger == null ? null : new Beendet(vorgaenger.id(), e.gueltigAb());
        return new Urteil(null, beendet, e.gueltigAb(), bis, rueckwirkend, vorgaenger);
    }

    private static boolean aufMinute(Instant t) {
        return t.equals(t.truncatedTo(ChronoUnit.MINUTES));
    }
}
