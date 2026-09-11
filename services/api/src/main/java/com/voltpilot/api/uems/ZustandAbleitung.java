package com.voltpilot.api.uems;

import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.List;

/**
 * Die REINE Ableitung der zwei BEOBACHTETEN Zustände des
 * Unternehmens-Energiemanagements: <b>liefert Daten</b> und <b>steuert</b>
 * (UEMS AP-00 §4.3, Prosa in {@code docs/fachmodell/zustaende.md}).
 *
 * <p>Beide werden NIE von Hand gesetzt — sie entstehen bei jedem Lesen neu aus
 * Fakten. Diese Klasse ist der Ort, an dem das genau einmal steht: ohne Spring,
 * ohne Repository, ohne Uhr (das {@code EigeneAuswertung}/{@code
 * SelfBuildDefinition}-Muster) — jeder Zustand ist ohne einen einzigen Container
 * prüfbar.
 *
 * <p>Der Zwilling im Portal ist {@code frontend/portal/src/uemsZustand.ts};
 * beide fahren dieselben Vektoren
 * ({@code docs/contracts/v2/uems-zustand-vectors.json}).
 * <b>Wer die Regel ändert, ändert beide Seiten und die Vektor-Datei.</b>
 *
 * <h2>⚠ Noch ruft niemand an</h2>
 *
 * Keine Fläche, kein Endpunkt und kein Repository ist umgestellt: in
 * {@code OverviewRepository}/{@code AdminFleetRepository} und im Portal
 * ({@code api.ts ONLINE_WINDOW_MS}) lebt weiterhin das harte 5-Minuten-Fenster,
 * und die Komponentenkarte behält ihre heutigen Wörter. Diese Klasse ist der
 * Vertrag, gegen den die Umstellung später gebaut wird.
 *
 * <h2>Familie 1 — liefert Daten</h2>
 *
 * <pre>
 *   toleranz_s = min( max( 3 × kadenz_s , 300 ) , 86400 )
 * </pre>
 *
 * Faktor 3 auf die erwartete Häufigkeit (AP-07 E9; die Kadenz ist ein
 * zeitgültiger Fakt der Quellenbindung, kein fester Deckel), MINDESTENS 5
 * Minuten (das heutige Fenster bleibt der Boden — eine 10-s-Reihe hätte sonst
 * 30 s Toleranz und ihr Abzeichen blinkte im Sekundentakt) und HÖCHSTENS 1 Tag
 * (AP-00 §4.3, Übergänge). Die Kante gehört zu „liefert“ ({@code <=}, wie
 * {@code api.ts deviceLiveStatus} heute).
 *
 * <p><b>Der Fall, den man falsch erwartet:</b> bei 60 s Kadenz und 190 s Alter
 * wäre 3 × Kadenz = 180 s überschritten — es gilt trotzdem „Liefert Daten“,
 * weil das Mindestfenster größer ist. Der Vektor
 * {@code mindestfenster-schlaegt-drei-kadenzen} pinnt ihn.
 *
 * <p>Die <b>Lücke</b> ist eine ANDERE Aussage (AP-07 E9/IP-9): ab 2 × Kadenz
 * ohne guten Wert ist eine Lücke der Reihe offen — ohne Boden und ohne Deckel,
 * denn sie zählt fehlende WERTE, sie zeigt kein Abzeichen. Eine Reihe darf
 * „Liefert Daten“ tragen und trotzdem eine offene Lücke haben.
 *
 * <h2>Familie 2 — steuert</h2>
 *
 * „steuert“ = Freigabe erteilt UND ein Betriebsmodell oder eine Regel läuft UND
 * die Box bestätigt die Ausführung. Fehlt eines, steht GENAU EIN Grund aus dem
 * geschlossenen Vokabular da — nie zwei, nie ein geratener. Die Reihenfolge
 * (IP-3) führt von der eigenen Entscheidung des Kunden nach außen zur Maschine:
 *
 * <ol>
 *   <li>{@code angehalten} — der Kunde hat selbst angehalten (AP-01 E7/E8). Wer
 *       das nicht zuerst liest, sucht einen Fehler, den er selbst gesetzt hat.
 *   <li>{@code nicht_freigegeben} — ohne Freigabe ist alles Weitere gar nicht
 *       gefragt; für einen Messkunden der Normalfall.
 *   <li>{@code funktion_nicht_gestartet} — freigegeben ≠ gestartet (AP-01 E6/E8).
 *   <li>{@code kein_betriebsmodell} — gestartet, aber nichts gewählt.
 *   <li>{@code box_meldet_sich_nicht} — alles bestellt, die Box schweigt.
 *   <li>{@code box_bestaetigt_nicht} — die Box ist da und schweigt zur
 *       AUSFÜHRUNG. Der engste Grund steht zuletzt: eine abwesende Box erklärt
 *       die fehlende Bestätigung, die fehlende Bestätigung erklärt nichts.
 * </ol>
 */
public final class ZustandAbleitung {

    /** Vielfaches der Kadenz, das ein guter Wert gilt (AP-07 E9). */
    public static final int TOLERANZ_FAKTOR = 3;

    /** Der Boden der Toleranz — das heutige 5-Minuten-Fenster. */
    public static final long TOLERANZ_MINDESTENS_S = 300L;

    /** Der Deckel der Toleranz — ein Tag (AP-00 §4.3, Übergänge). */
    public static final long TOLERANZ_HOECHSTENS_S = 86_400L;

    /** Ab diesem Vielfachen der Kadenz ohne guten Wert ist eine Lücke offen. */
    public static final int LUECKE_FAKTOR = 2;

    /** Die Zeitzone, in der ein Kundensatz seine Uhrzeit nennt, wenn keine am Standort steht. */
    public static final ZoneId VORGABE_ZEITZONE = ZoneId.of("Europe/Berlin");

    private ZustandAbleitung() {}

    // ---------------------------------------------------------------- Vokabular

    /** Das geschlossene Vokabular der Familie „liefert Daten“. */
    public enum LiefertDaten {
        /** Ein guter Wert kam innerhalb der Toleranz an. */
        LIEFERT("liefert"),
        /** Seit dem genannten Zeitpunkt kam keiner mehr. */
        LIEFERT_NICHT_SEIT("liefert_nicht_seit"),
        /** Noch nie ein Wert mit Qualität „gut“. */
        WARTET_AUF_ERSTE_DATEN("wartet_auf_erste_daten"),
        /** Gar keine Quelle gebunden — eingerichtet und aktiv, aber nie eine 0 (AP-04 E8). */
        KEINE_DATENQUELLE("keine_datenquelle");

        private final String code;

        LiefertDaten(String code) {
            this.code = code;
        }

        /** Das Wort des Vertrags. */
        public String code() {
            return code;
        }

        /** Das Wort des Vertrags zurück in den Zustand. */
        public static LiefertDaten vonCode(String code) {
            for (LiefertDaten z : values()) {
                if (z.code.equals(code)) {
                    return z;
                }
            }
            throw new IllegalArgumentException("unbekannter Zustand: " + code);
        }
    }

    /** Warum eine Anlage keine Daten liefert — in der Reihenfolge, in der die Gründe gelten. */
    public enum AnlageGrund {
        KEINE_BOX("keine_box"),
        BOX_MELDET_SICH_NICHT("box_meldet_sich_nicht"),
        KEIN_HAUPTZAEHLER("kein_hauptzaehler"),
        KEINE_DATENQUELLE("keine_datenquelle"),
        WARTET_AUF_ERSTE_DATEN("wartet_auf_erste_daten"),
        HAUPTZAEHLER_LIEFERT_NICHT("hauptzaehler_liefert_nicht");

        private final String code;

        AnlageGrund(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /** Warum nicht gesteuert wird — genau einer, in der Reihenfolge oben. */
    public enum SteuertGrund {
        ANGEHALTEN("angehalten", "Steuert nicht — angehalten"),
        NICHT_FREIGEGEBEN("nicht_freigegeben", "Steuert nicht — nicht freigegeben"),
        FUNKTION_NICHT_GESTARTET("funktion_nicht_gestartet", "Steuert nicht — noch nicht gestartet"),
        KEIN_BETRIEBSMODELL("kein_betriebsmodell", "Steuert nicht — kein Betriebsmodell gewählt"),
        BOX_MELDET_SICH_NICHT("box_meldet_sich_nicht", "Steuert nicht — Box meldet sich nicht"),
        BOX_BESTAETIGT_NICHT(
                "box_bestaetigt_nicht", "Steuert nicht — Box bestätigt die Ausführung nicht");

        private final String code;
        private final String text;

        SteuertGrund(String code, String text) {
            this.code = code;
            this.text = text;
        }

        public String code() {
            return code;
        }

        /** Der Satz, den der Kunde liest. */
        public String text() {
            return text;
        }
    }

    /**
     * Was ein Aggregat zählt, je mit Ein- und Mehrzahl. Dieselbe Tabelle steht im
     * Zwilling und in der Vektor-Datei (`einheiten`); die Tests prüfen das,
     * statt es zu glauben.
     */
    public enum Einheit {
        MESSSTELLE("messstelle", "Messstelle", "Messstellen"),
        ANLAGE("anlage", "Anlage", "Anlagen"),
        KOMPONENTE("komponente", "Komponente", "Komponenten"),
        BOX("box", "Box", "Boxen");

        private final String code;
        private final String singular;
        private final String plural;

        Einheit(String code, String singular, String plural) {
            this.code = code;
            this.singular = singular;
            this.plural = plural;
        }

        public String code() {
            return code;
        }

        public String singular() {
            return singular;
        }

        public String plural() {
            return plural;
        }

        public static Einheit vonCode(String code) {
            for (Einheit e : values()) {
                if (e.code.equals(code)) {
                    return e;
                }
            }
            throw new IllegalArgumentException("unbekannte Einheit: " + code);
        }
    }

    // ------------------------------------------------------------- liefert Daten

    /**
     * Was über EINE Reihe bekannt ist.
     *
     * @param quelleVorhanden ob überhaupt eine Datenquelle gebunden ist
     * @param letzterGuterWert Eingangszeit des letzten Wertes mit Qualität „gut“; {@code null},
     *     wenn nie einer ankam
     * @param jeEinWert ob je ein Wert ankam — auch ein schlechter. Ändert das Ergebnis NICHT:
     *     gezählt werden nur GUTE Werte (E9), also bleibt es bis zum ersten guten Wert bei
     *     „Wartet auf erste Daten“. Ein eigenes Wort dafür zu erfinden wäre ein geratener Zustand.
     * @param kadenzS die erwartete Häufigkeit in Sekunden
     * @param jetzt der Zeitpunkt der Frage
     * @param zeitzone die Zeitzone des Standorts für den Kundensatz
     */
    public record LiefertDatenEingang(
            boolean quelleVorhanden,
            Instant letzterGuterWert,
            boolean jeEinWert,
            long kadenzS,
            Instant jetzt,
            ZoneId zeitzone) {}

    /**
     * @param seit nur bei {@link LiefertDaten#LIEFERT_NICHT_SEIT} gesetzt — ein Text ohne
     *     Zeitpunkt wäre eine halbe Aussage
     * @param toleranzS das tatsächlich angewandte Fenster, zur Nachvollziehbarkeit mitgeführt
     * @param lueckeOffen ob die REIHE gerade eine Lücke hat; darf zugleich mit „liefert“ wahr sein
     */
    public record LiefertDatenErgebnis(
            LiefertDaten zustand, Instant seit, long toleranzS, boolean lueckeOffen, String text) {}

    /** Das Fenster, in dem ein guter Wert zählt. */
    public static long toleranzS(long kadenzS) {
        return Math.min(
                Math.max(TOLERANZ_FAKTOR * kadenzS, TOLERANZ_MINDESTENS_S), TOLERANZ_HOECHSTENS_S);
    }

    /** Der Zustand EINER Reihe (Messstelle, Datenquelle, Komponente, Box). */
    public static LiefertDatenErgebnis liefertDaten(LiefertDatenEingang e) {
        long toleranz = toleranzS(e.kadenzS());
        if (!e.quelleVorhanden()) {
            return new LiefertDatenErgebnis(
                    LiefertDaten.KEINE_DATENQUELLE, null, toleranz, false, "Keine Datenquelle");
        }
        if (e.letzterGuterWert() == null) {
            return new LiefertDatenErgebnis(
                    LiefertDaten.WARTET_AUF_ERSTE_DATEN,
                    null,
                    toleranz,
                    false,
                    "Wartet auf erste Daten");
        }
        long alterS = e.jetzt().getEpochSecond() - e.letzterGuterWert().getEpochSecond();
        boolean luecke = alterS > (long) LUECKE_FAKTOR * e.kadenzS();
        if (alterS <= toleranz) {
            return new LiefertDatenErgebnis(
                    LiefertDaten.LIEFERT, null, toleranz, luecke, "Liefert Daten");
        }
        return new LiefertDatenErgebnis(
                LiefertDaten.LIEFERT_NICHT_SEIT,
                e.letzterGuterWert(),
                toleranz,
                luecke,
                "Liefert keine Daten seit "
                        + zeitpunktText(e.letzterGuterWert(), e.jetzt(), e.zeitzone()));
    }

    // -------------------------------------------------------------------- Anlage

    /** Eine Box und ob ihr Herzschlag in ihrer Kadenz ankommt. */
    public record BoxZustand(String name, boolean verbunden) {}

    /** Ein bereits abgeleiteter Reihen-Zustand, so wie ihn ein Objekt darüber weiterreicht. */
    public record Quellzustand(LiefertDaten zustand, Instant seit) {}

    /**
     * @param hauptzaehler {@code null}, wenn keiner gebunden ist
     */
    public record AnlageEingang(
            List<BoxZustand> boxen, Quellzustand hauptzaehler, Instant jetzt, ZoneId zeitzone) {}

    public record AnlageErgebnis(boolean liefert, AnlageGrund grund, Instant seit, String text) {}

    /**
     * Die Regel der Objekt-Tabelle: eine Anlage liefert Daten, wenn ALLE ihre
     * Boxen verbunden sind UND der Hauptzähler liefert.
     *
     * <p>Reihenfolge der Gründe: keine Box → stumme Box → kein Hauptzähler → der
     * Zustand des Hauptzählers. Eine stumme Box erklärt den stillen Zähler; den
     * engeren Grund zuerst zu nennen, wäre geraten.
     */
    public static AnlageErgebnis liefertDatenAnlage(AnlageEingang e) {
        if (e.boxen().isEmpty()) {
            return new AnlageErgebnis(
                    false,
                    AnlageGrund.KEINE_BOX,
                    null,
                    "Liefert keine Daten — keine Box angemeldet");
        }
        List<String> stumm = new ArrayList<>();
        for (BoxZustand b : e.boxen()) {
            if (!b.verbunden()) {
                stumm.add(b.name());
            }
        }
        if (!stumm.isEmpty()) {
            String verb = stumm.size() == 1 ? "meldet sich nicht" : "melden sich nicht";
            return new AnlageErgebnis(
                    false,
                    AnlageGrund.BOX_MELDET_SICH_NICHT,
                    null,
                    "Liefert keine Daten — " + aufzaehlung(stumm) + " " + verb);
        }
        Quellzustand hz = e.hauptzaehler();
        if (hz == null) {
            return new AnlageErgebnis(
                    false,
                    AnlageGrund.KEIN_HAUPTZAEHLER,
                    null,
                    "Liefert keine Daten — kein Hauptzähler");
        }
        return switch (hz.zustand()) {
            case KEINE_DATENQUELLE ->
                    new AnlageErgebnis(
                            false, AnlageGrund.KEINE_DATENQUELLE, null, "Keine Datenquelle");
            case WARTET_AUF_ERSTE_DATEN ->
                    new AnlageErgebnis(
                            false,
                            AnlageGrund.WARTET_AUF_ERSTE_DATEN,
                            null,
                            "Wartet auf erste Daten");
            case LIEFERT_NICHT_SEIT ->
                    new AnlageErgebnis(
                            false,
                            AnlageGrund.HAUPTZAEHLER_LIEFERT_NICHT,
                            hz.seit(),
                            // Ohne Zeitpunkt bleibt der Satz kurz, statt „jetzt“ zu behaupten.
                            hz.seit() == null
                                    ? "Liefert keine Daten"
                                    : "Liefert keine Daten seit "
                                            + zeitpunktText(hz.seit(), e.jetzt(), e.zeitzone()));
            case LIEFERT -> new AnlageErgebnis(true, null, null, "Liefert Daten");
        };
    }

    // ------------------------------------------------------------------ Aggregat

    /**
     * „x von y“ für Standort und Unternehmen.
     *
     * @param erfuellt wie viele liefern beziehungsweise steuern
     */
    public record AggregatErgebnis(int erfuellt, int gesamt, String text) {}

    /**
     * „14 von 14 Messstellen liefern Daten“. Nur {@link LiefertDaten#LIEFERT}
     * zählt im Zähler; „keine Datenquelle“ steht im Nenner, nie im Zähler — sie
     * ist kein Liefern und auch kein Ausfall.
     */
    public static AggregatErgebnis aggregatLiefertDaten(List<LiefertDaten> einzel, Einheit einheit) {
        int gesamt = einzel.size();
        int liefernd = 0;
        for (LiefertDaten z : einzel) {
            if (z == LiefertDaten.LIEFERT) {
                liefernd++;
            }
        }
        if (gesamt == 0) {
            return new AggregatErgebnis(0, 0, "Noch keine " + einheit.plural());
        }
        String nomen = gesamt == 1 ? einheit.singular() : einheit.plural();
        String verb = liefernd == 1 ? "liefert" : "liefern";
        return new AggregatErgebnis(
                liefernd, gesamt, liefernd + " von " + gesamt + " " + nomen + " " + verb + " Daten");
    }

    /** „1 von 2 Anlagen steuert“. */
    public static AggregatErgebnis aggregatSteuert(List<Boolean> einzel, Einheit einheit) {
        int gesamt = einzel.size();
        int steuernd = 0;
        for (Boolean b : einzel) {
            if (Boolean.TRUE.equals(b)) {
                steuernd++;
            }
        }
        if (gesamt == 0) {
            return new AggregatErgebnis(0, 0, "Noch keine " + einheit.plural());
        }
        String nomen = gesamt == 1 ? einheit.singular() : einheit.plural();
        String verb = steuernd == 1 ? "steuert" : "steuern";
        return new AggregatErgebnis(
                steuernd, gesamt, steuernd + " von " + gesamt + " " + nomen + " " + verb);
    }

    // -------------------------------------------------- berechnete Messstelle

    /** Ein Eingang einer berechneten Messstelle, mit dem Kennzeichen, das der Kunde kennt. */
    public record BerechnetEingang(String kennzeichen, LiefertDaten zustand, Instant seit) {}

    public record BerechnetErgebnis(
            boolean vollstaendig, List<String> fehlend, Instant seit, String text) {}

    /**
     * „Vollständig“ nur, wenn ALLE Eingänge liefern; sonst „Unvollständig seit
     * 14:00 Uhr (fehlt: MS-12)“ mit dem FRÜHESTEN Zeitpunkt der fehlenden
     * Eingänge — seit da ist die Rechnung unvollständig, nicht erst seit dem
     * zweiten Ausfall. Hat keiner der fehlenden Eingänge einen Zeitpunkt, steht
     * auch keiner im Satz: ein erfundenes „seit“ wäre eine Behauptung.
     */
    public static BerechnetErgebnis berechnet(
            List<BerechnetEingang> eingaenge, Instant jetzt, ZoneId zeitzone) {
        List<String> fehlend = new ArrayList<>();
        Instant frueheste = null;
        for (BerechnetEingang e : eingaenge) {
            if (e.zustand() == LiefertDaten.LIEFERT) {
                continue;
            }
            fehlend.add(e.kennzeichen());
            if (e.seit() != null && (frueheste == null || e.seit().isBefore(frueheste))) {
                frueheste = e.seit();
            }
        }
        if (fehlend.isEmpty()) {
            return new BerechnetErgebnis(true, List.of(), null, "Vollständig");
        }
        String kopf = "Unvollständig";
        if (frueheste != null) {
            kopf += " seit " + zeitpunktText(frueheste, jetzt, zeitzone);
        }
        return new BerechnetErgebnis(
                false,
                List.copyOf(fehlend),
                frueheste,
                kopf + " (fehlt: " + String.join(", ", fehlend) + ")");
    }

    // ------------------------------------------------------------------- steuert

    /**
     * @param laeuftArt {@code "betriebsmodell"} oder {@code "regel"}; {@code null}, wenn nichts läuft
     * @param laeuftName sein Name, wie der Kunde ihn kennt; {@code null} heißt „kein Name bekannt“ —
     *     dann steht auch keiner im Satz
     * @param boxBestaetigt ob die Box die AUSFÜHRUNG bestätigt; Antwort ist nicht Wirkung
     * @param ruheEintrag Ruhe-Eintrag ohne Enddatum (AP-01 E7/E8)
     */
    public record SteuertEingang(
            boolean freigabeErteilt,
            boolean funktionGestartet,
            boolean laeuft,
            String laeuftArt,
            String laeuftName,
            boolean boxVerbunden,
            boolean boxBestaetigt,
            boolean ruheEintrag) {}

    public record SteuertErgebnis(boolean steuert, SteuertGrund grund, String text) {}

    /** Steuert dieses Objekt gerade — und wenn nicht, aus genau welchem Grund? */
    public static SteuertErgebnis steuert(SteuertEingang e) {
        SteuertGrund grund = grundFuer(e);
        if (grund != null) {
            return new SteuertErgebnis(false, grund, grund.text());
        }
        String text = "Wird von VoltPilot gesteuert";
        if (e.laeuftName() != null && !e.laeuftName().isBlank()) {
            text +=
                    "regel".equals(e.laeuftArt())
                            ? " · Regel „" + e.laeuftName() + "“"
                            : " · " + e.laeuftName();
        }
        return new SteuertErgebnis(true, null, text);
    }

    /** Die EINE Reihenfolge der Gründe; {@code null} heißt „es steuert“. */
    private static SteuertGrund grundFuer(SteuertEingang e) {
        if (e.ruheEintrag()) {
            return SteuertGrund.ANGEHALTEN;
        }
        if (!e.freigabeErteilt()) {
            return SteuertGrund.NICHT_FREIGEGEBEN;
        }
        if (!e.funktionGestartet()) {
            return SteuertGrund.FUNKTION_NICHT_GESTARTET;
        }
        if (!e.laeuft()) {
            return SteuertGrund.KEIN_BETRIEBSMODELL;
        }
        if (!e.boxVerbunden()) {
            return SteuertGrund.BOX_MELDET_SICH_NICHT;
        }
        if (!e.boxBestaetigt()) {
            return SteuertGrund.BOX_BESTAETIGT_NICHT;
        }
        return null;
    }

    // --------------------------------------------------------------------- Text

    /**
     * „14:00 Uhr“ — und sobald der Zeitpunkt nicht mehr am heutigen Tag des
     * Standorts liegt, „09.09.2026 23:50 Uhr“. Sekunden sind Lärm; die Zeitzone
     * ist die des Standorts, nie ein fester Versatz (Sommer- und Winterzeit).
     */
    public static String zeitpunktText(Instant seit, Instant jetzt, ZoneId zeitzone) {
        ZoneId zone = zeitzone == null ? VORGABE_ZEITZONE : zeitzone;
        ZonedDateTime s = seit.atZone(zone);
        ZonedDateTime j = jetzt.atZone(zone);
        String uhr = String.format("%02d:%02d Uhr", s.getHour(), s.getMinute());
        if (s.toLocalDate().equals(j.toLocalDate())) {
            return uhr;
        }
        return String.format(
                "%02d.%02d.%04d %s", s.getDayOfMonth(), s.getMonthValue(), s.getYear(), uhr);
    }

    /**
     * „a“ · „a und b“ · „a, b und c“ — eine deutsche Aufzählung. Paket-sichtbar, damit
     * {@link FunktionZustandAbleitung} dieselbe benutzt.
     */
    static String aufzaehlung(List<String> worte) {
        if (worte.size() == 1) {
            return worte.get(0);
        }
        return String.join(", ", worte.subList(0, worte.size() - 1))
                + " und "
                + worte.get(worte.size() - 1);
    }
}
