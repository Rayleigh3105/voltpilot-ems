package com.voltpilot.api.uems;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;

/**
 * Die reinen Regeln des Lücken-Melders (UEMS AP-07 IP-9) — ohne Datenbank, ohne Uhr.
 *
 * <p><b>⚠ Die Lücke ist eine ANDERE Aussage als „liefert Daten“</b> (Zustandsvertrag, AP-07 E9):
 * die Beobachtung toleriert {@code min(max(3 × Kadenz, 300 s), 86 400 s)} und zeigt ein
 * Abzeichen; die Lücke beginnt ÜBER {@code 2 × Kadenz} ohne guten Wert, OHNE Boden und OHNE
 * Deckel, und zählt fehlende Werte. Eine Reihe darf „liefert Daten“ tragen und zugleich eine
 * offene Lücke haben. Darum steht hier KEINE eigene Schwelle: die Kadenz-Lücke fragt
 * {@link ZustandAbleitung#liefertDaten} und nimmt dessen {@code lueckeOffen} — der Faktor ist
 * {@link ZustandAbleitung#LUECKE_FAKTOR} (Vertrag {@code uems-zustand-vectors.json},
 * {@code toleranz.luecke_faktor}), nie eine zweite Zahl.
 *
 * <p><b>Die Kadenz kommt zum Zeitpunkt</b> (E9, {@code quelle_kadenz}): gemessen wird gegen die
 * Erwartung, die zur Messzeit des letzten guten Werts galt — eine Lücke im März gegen die des
 * März. Welche das ist, sagt {@link KadenzRegeln#wirksam}; hier kommt sie als Zahl an.
 *
 * <p><b>Die Box-Lücke</b> beginnt beim letzten Eingang, wenn danach länger als die
 * Herzschlag-Toleranz nichts kam (AP-06 §4 „kein Herzschlag seit &gt; Toleranz (2 × Kadenz,
 * mindestens 5 min)“, Beispiel 14:00 → erkannt 14:05).
 */
public final class LueckenRegeln {

    /** Der Takt, in dem eine Box sich meldet (AP-06 IP-15: „2 × 15 s, mindestens 5 min“). */
    public static final long HERZSCHLAG_TAKT_S = 15L;

    /**
     * Wie lange eine Box schweigen darf, bevor sie „sich nicht meldet“ — {@code max(2 × 15 s,
     * 300 s)} = 300 s, dieselben Konstanten wie der Zustandsvertrag (Faktor der Lücke, Boden der
     * Toleranz). Die Kante gehört zu „meldet sich“ (strikt größer).
     */
    public static final long HERZSCHLAG_TOLERANZ_S = Math.max(
            ZustandAbleitung.LUECKE_FAKTOR * HERZSCHLAG_TAKT_S, ZustandAbleitung.TOLERANZ_MINDESTENS_S);

    /**
     * Wie lange nach dem letzten nachgelieferten Eingang gewartet wird, bevor die Nachlieferung
     * als {@code backfill} gemeldet wird — die Meldung ist unveränderlich, sie darf die Welle nicht
     * mittendrin zählen. Dieselben 300 s, ab denen ein Wert überhaupt „nachgeliefert“ heißt
     * ({@code MesswertHerkunft}: Verzögerung &gt; max(300 s, 3 × Kadenz)).
     */
    public static final long NACHLIEFERUNG_RUHE_S = ZustandAbleitung.TOLERANZ_MINDESTENS_S;

    /** Die Fehlerklasse, die NUR eine Herzschlag-Lücke trägt (Vertrag §6). */
    public static final String BOX_MELDET_SICH_NICHT = "box_meldet_sich_nicht";

    private LueckenRegeln() {}

    // ------------------------------------------------------------------ Reihe (Kadenz)

    /**
     * Ist die Lücke der Reihe zum Zeitpunkt {@code jetzt} offen? Die Antwort des Zustandsvertrags,
     * nicht eine eigene Rechnung: {@code jetzt − letzterGuterWert > LUECKE_FAKTOR × Kadenz}.
     */
    public static boolean reiheOffen(Instant letzterGuterWert, long kadenzS, Instant jetzt) {
        return ZustandAbleitung.liefertDaten(new ZustandAbleitung.LiefertDatenEingang(
                true, letzterGuterWert, false, kadenzS, jetzt, ZustandAbleitung.VORGABE_ZEITZONE))
                .lueckeOffen();
    }

    /** Liegt zwischen zwei aufeinanderfolgenden guten Werten ein Loch? Dieselbe Frage, später gestellt. */
    public static boolean loch(Instant vorher, Instant nachher, long kadenzS) {
        return reiheOffen(vorher, kadenzS, nachher);
    }

    /** Der erste Zeitpunkt, zu dem die Lücke offen ist — die nächste Prüfung einer ruhigen Reihe. */
    public static Instant reiheFaelligAb(Instant letzterGuterWert, long kadenzS) {
        return Instant.ofEpochSecond(
                letzterGuterWert.getEpochSecond() + ZustandAbleitung.LUECKE_FAKTOR * kadenzS + 1);
    }

    /**
     * {@code von} der Lücke: der erste erwartete, aber fehlende Wert — der letzte gute plus EINE
     * Kadenz (Vertrag: „der erste Zeitpunkt ohne erwarteten Wert“; MS-06: letzter Wert 10:39,
     * Lücke ab 10:40).
     */
    public static Instant lueckeBeginn(Instant letzterGuterWert, long kadenzS) {
        return letzterGuterWert.plusSeconds(kadenzS);
    }

    /**
     * Wie viele erwartete Werte in {@code [von, bis)} fehlen — gezählt aus der Kadenz, nie
     * geschätzt: je angefangene Kadenz einer. {@code [10:40, 10:47)} bei 60 s = 7.
     */
    public static long erwartetFehlend(Instant von, Instant bis, long kadenzS) {
        long ms = Duration.between(von, bis).toMillis();
        if (ms <= 0) {
            return 0;
        }
        long k = kadenzS * 1000L;
        return (ms + k - 1) / k;
    }

    // -------------------------------------------------------------------- Box (Herzschlag)

    /** Schweigt die Box? Strikt länger als die Herzschlag-Toleranz kein Eingang. */
    public static boolean boxSchweigt(Instant letzterEingang, Instant jetzt) {
        return jetzt.getEpochSecond() - letzterEingang.getEpochSecond() > HERZSCHLAG_TOLERANZ_S;
    }

    /** Der erste Zeitpunkt, zu dem die Box schweigt. */
    public static Instant boxFaelligAb(Instant letzterEingang) {
        return Instant.ofEpochSecond(letzterEingang.getEpochSecond() + HERZSCHLAG_TOLERANZ_S + 1);
    }

    /** Ist die Nachlieferung zur Ruhe gekommen und darf gezählt werden? */
    public static boolean nachlieferungRuht(Instant letzterNachgelieferterEingang, Instant jetzt) {
        return jetzt.getEpochSecond() - letzterNachgelieferterEingang.getEpochSecond()
                > NACHLIEFERUNG_RUHE_S;
    }

    /** Der erste Zeitpunkt, zu dem die Nachlieferung ruht. */
    public static Instant nachlieferungFaelligAb(Instant letzterNachgelieferterEingang) {
        return Instant.ofEpochSecond(
                letzterNachgelieferterEingang.getEpochSecond() + NACHLIEFERUNG_RUHE_S + 1);
    }

    // ---------------------------------------------------------------- Zeiten der Meldung

    /** Der Vertrag trägt ganze Sekunden: {@code von}, {@code bis} und Eingangszeiten abgerundet. */
    public static Instant sekunde(Instant t) {
        return Instant.ofEpochSecond(t.getEpochSecond());
    }

    /** Das eingeschlossene Ende eines geschlossenen Zeitraums aufgerundet ({@code backfill}). */
    public static Instant sekundeAuf(Instant t) {
        return t.getNano() == 0 ? t : Instant.ofEpochSecond(t.getEpochSecond() + 1);
    }

    /**
     * Das Ende einer halboffenen Lücke auf die Sekunde: abgerundet — fällt es dabei in die
     * Sekunde von {@code von}, reicht die Lücke genau eine Sekunde weit, die kleinste Dauer, die
     * der Vertrag darstellen kann ({@code bis} muss nach {@code von} liegen).
     */
    public static Instant lueckeEnde(Instant von, Instant bis) {
        Instant v = sekunde(von);
        Instant b = sekunde(bis);
        return b.isAfter(v) ? b : v.plusSeconds(1);
    }

    // ---------------------------------------------------------------- Ereignis-Kennungen

    /*
     * Die Kennungen werden ABGELEITET, nicht gewürfelt (das Muster von SpaetankunftMelder): dieselbe
     * Lücke ergibt dieselbe Kennung, auch im zweiten Lauf, nach einem Abbruch oder in einem
     * zweiten Melder. `von` gehört dazu — eine spätere Lücke derselben Reihe ist ein anderes
     * Ereignis; `bis` gehört NICHT dazu, denn das Schließen ist eine Fortschreibung desselben.
     */

    /** Die Kadenz-Lücke einer Reihe. */
    public static UUID reiheKennung(UUID tenantId, UUID entityId, String messkanal, Instant von) {
        return kennung("data_gap:kadenz", tenantId, entityId, messkanal, sekunden(von));
    }

    /** Die Herzschlag-Lücke einer Box (der Kern-Pfad). */
    public static UUID boxKennung(UUID tenantId, UUID deviceId, Instant von) {
        return kennung("data_gap:herzschlag", tenantId, deviceId, sekunden(von));
    }

    /** Die Herzschlag-Lücke einer Datenquelle dieser Box (der UEMS-Pfad). */
    public static UUID quelleKennung(UUID tenantId, UUID deviceId, UUID dataSourceId, Instant von) {
        return kennung("data_gap:herzschlag", tenantId, deviceId, dataSourceId, sekunden(von));
    }

    /** Die Nachlieferung einer Welle je Box und Quelle — eine neue Welle ist ein neues Ereignis. */
    public static UUID backfillKennung(UUID tenantId, UUID deviceId, UUID dataSourceId,
            Instant eingangVon) {
        return kennung("backfill", tenantId, deviceId, dataSourceId, sekunden(eingangVon));
    }

    /** Auf die Sekunde — die Auflösung, in der der Vertrag Zeiten trägt ({@code ZEIT_UTC}). */
    private static String sekunden(Instant t) {
        return Long.toString(t.getEpochSecond());
    }

    private static UUID kennung(Object... teile) {
        StringBuilder saat = new StringBuilder();
        for (Object t : teile) {
            if (saat.length() > 0) {
                saat.append(':');
            }
            saat.append(t);
        }
        return UUID.nameUUIDFromBytes(saat.toString().getBytes(StandardCharsets.UTF_8));
    }
}
