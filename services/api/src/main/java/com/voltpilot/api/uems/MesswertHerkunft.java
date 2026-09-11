package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Die REINE Ableitung des HERKUNFTSVERTRAGS je Messwert (UEMS AP-07 IP-1, Prosa in
 * {@code docs/contracts/v2/messwert-herkunft.md}): aus dem, was die Box liefert, und dem, was
 * die Cloud ZUR MESSZEIT weiß, wird GENAU EIN Urteil (gespeichert · Wiederholung · abgewiesen ·
 * kein Wert), die Ereignisse, die dabei entstehen, und — für einen gespeicherten Wert — die
 * fünfzehn Angaben, die er bis in den Viertelstundenwert trägt.
 *
 * <p>Ohne Spring, ohne Repository, ohne Uhr (das {@link ZustandAbleitung}-Muster): jeder
 * Nachschlag (Gerät-Historie, Zuständigkeit, Quellenbindung, Katalog, schon gespeicherte Werte)
 * kommt als FAKT herein. Die Vektoren {@code docs/contracts/v2/messwert-herkunft-vectors.json}
 * pinnen die Regel; der TS-Zwilling folgt mit der Rohtabelle (AP-07 IP-6).
 * <b>Wer die Regel ändert, ändert diese Klasse und die Vektor-Datei.</b>
 *
 * <h2>⚠ Noch ruft niemand an</h2>
 *
 * Datenannahme und Writer sind unverändert: heute gilt noch {@code ON CONFLICT DO NOTHING} auf
 * {@code (device_id, point_key, time, edge_sequence)} und kein Wert trägt Komponente, Gerät oder
 * Fassung. Diese Klasse ist der Vertrag, gegen den AP-07 IP-5 (Datenannahme), IP-6 (Rohtabelle)
 * und IP-7 (Writer) gebaut werden.
 *
 * <h2>Die Reihenfolge der Prüfungen</h2>
 *
 * <ol>
 *   <li><b>Zeit (E13, Datenannahme):</b> Messzeit mehr als 5 Minuten nach der Cloud-Uhr →
 *       abgewiesen, {@code clock_ahead}; älter als 90 Tage (90 × 24 h) → abgewiesen, {@code
 *       too_old}. Ein abgewiesener Wert erzeugt GENAU sein Abweisungs-Ereignis.
 *   <li><b>Sequenz der Box (E3/E13):</b> gegen den zuletzt gesehenen Umschlag derselben Box —
 *       Sprung nach oben {@code sequence_gap} (mit Anzahl), nach unten {@code sequence_reset};
 *       bei aufeinanderfolgenden Sequenzen mehr als 5 Minuten Messzeit-Abstand {@code
 *       clock_jump}. Der Wert bleibt.
 *   <li><b>Herkunft vollständig (Invariante 1):</b> ohne Komponente, Gerät-Einbau oder Fassung ist
 *       er kein Messwert des Unternehmens-Energiemanagements → abgewiesen, {@code rejected}.
 *       Nichts wird geraten.
 *   <li><b>Rolle (E4):</b> liest die Box NICHT die zur Messzeit zuständige → {@code spiegel} und
 *       {@code unassigned_reader} (höchstens einmal je Stunde je Box und Datenquelle); sonst
 *       entscheidet die Quellenbindung zur Messzeit: {@code fuehrend} · {@code vergleich} ·
 *       {@code beobachtung}.
 *   <li><b>Idempotenz (E3):</b> Schlüssel = Reihe + Messzeit, in der Spur der Rolle — ein Spiegel
 *       berührt die zuständige Spur nie. Gleicher Wert → Wiederholung (gezählt, kein Ereignis);
 *       abweichender Wert → abgewiesen, {@code duplicate_conflict}; der erste bleibt.
 *   <li><b>Zustellart:</b> Eingang später als {@code max(300 s, 3 × Kadenz)} nach der Messzeit →
 *       {@code nachgeliefert}, sonst {@code direkt}; die Verzögerung reist ungeschönt mit (auch
 *       negativ, wenn die Uhr der Box innerhalb der Toleranz vorgeht).
 * </ol>
 */
public final class MesswertHerkunft {

    /** Wie weit eine Messzeit in der Zukunft liegen darf (E13): 5 Minuten. */
    public static final long ZUKUNFT_HOECHSTENS_S = 300L;

    /** Wie alt eine Messzeit sein darf (E13, Aufbewahrung der Rohwerte): 90 × 24 h. */
    public static final long VERGANGENHEIT_HOECHSTENS_S = 90L * 86_400L;

    /** Ab MEHR als diesem Abstand zweier aufeinanderfolgender Umschläge springt die Uhr (E13). */
    public static final long ZEITSPRUNG_AB_S = 300L;

    /** Boden der Nachlieferungs-Schwelle: 5 Minuten. */
    public static final long NACHGELIEFERT_MINDESTENS_S = 300L;

    /** Vielfaches der Kadenz in der Nachlieferungs-Schwelle. */
    public static final int NACHGELIEFERT_FAKTOR = 3;

    /** {@code unassigned_reader} höchstens einmal in diesem Abstand je Box und Datenquelle (E4). */
    public static final long UNASSIGNED_READER_HOECHSTENS_JE_S = 3_600L;

    private MesswertHerkunft() {}

    // ---------------------------------------------------------------- Vokabular

    /** Was mit einem gelieferten Wert geschieht. */
    public enum Urteil {
        GESPEICHERT("gespeichert"),
        /** Derselbe Wert zum zweiten Mal: nicht gespeichert, nur gezählt. */
        WIEDERHOLUNG("wiederholung"),
        ABGEWIESEN("abgewiesen"),
        /** Zur Messzeit kam nichts an — eine Lücke, nie eine 0. */
        KEIN_WERT("kein_wert");

        private final String code;

        Urteil(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /** Warum ein Wert abgewiesen wurde. */
    public enum Grund {
        CLOCK_AHEAD("clock_ahead"),
        TOO_OLD("too_old"),
        HERKUNFT_UNVOLLSTAENDIG("herkunft_unvollstaendig"),
        DUPLICATE_CONFLICT("duplicate_conflict");

        private final String code;

        Grund(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /** Die Rolle eines Werts zur Messzeit. Nur {@link #FUEHREND} fließt in Verbrauch und Bilanz. */
    public enum Rolle {
        FUEHREND("fuehrend"),
        VERGLEICH("vergleich"),
        SPIEGEL("spiegel"),
        BEOBACHTUNG("beobachtung");

        private final String code;

        Rolle(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }

        public static Rolle vonCode(String code) {
            for (Rolle r : values()) {
                if (r.code.equals(code)) {
                    return r;
                }
            }
            throw new IllegalArgumentException("unbekannte Rolle: " + code);
        }
    }

    /** Wie die Quellenbindung (AP-04) den Messkanal einer Komponente zur Messzeit führt. */
    public enum Bindung {
        /** Führende Quelle einer Messstelle. */
        FUEHREND("fuehrend"),
        /** Gekennzeichnete, bestätigte Vergleichsquelle (AP-04 E3, AP-06 E10). */
        VERGLEICH("vergleich"),
        /** An keine Messstelle gebunden. */
        KEINE("keine");

        private final String code;

        Bindung(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }

        public static Bindung vonCode(String code) {
            for (Bindung b : values()) {
                if (b.code.equals(code)) {
                    return b;
                }
            }
            throw new IllegalArgumentException("unbekannte Bindung: " + code);
        }
    }

    public enum Zustellart {
        DIREKT("direkt"),
        NACHGELIEFERT("nachgeliefert");

        private final String code;

        Zustellart(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /** Woher die Einstellungs-Fassung eines Werts stammt. */
    public enum FassungQuelle {
        /** Die Box meldet die angewendete Fassung ({@code applied_revision}, Vertrag 2.1). */
        BOX("box"),
        /** Ältere Box: die Cloud schlägt die zur Messzeit angewendete Fassung nach. */
        ZUSTELLUNG("zustellung");

        private final String code;

        FassungQuelle(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /** Die Ereignisarten, die diese Ableitung auslösen kann (Ausschnitt aus AP-07 §4.8). */
    public enum EreignisArt {
        CLOCK_AHEAD("clock_ahead"),
        TOO_OLD("too_old"),
        CLOCK_JUMP("clock_jump"),
        SEQUENCE_GAP("sequence_gap"),
        SEQUENCE_RESET("sequence_reset"),
        REJECTED("rejected"),
        UNASSIGNED_READER("unassigned_reader"),
        DUPLICATE_CONFLICT("duplicate_conflict");

        private final String code;

        EreignisArt(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    // ----------------------------------------------------------------- Eingang

    /** Die lesende Box: Kennzeichen und Seriennummer aus ihrer Anmeldung. */
    public record Box(String kennzeichen, String seriennummer) {}

    /**
     * Die Hülle, in der der Wert reiste.
     *
     * @param angewendeteFassung {@code null} bei einer älteren Box (Vertrag 2.0)
     */
    public record Umschlag(
            long sequenz, Instant messzeit, String katalogstand, Integer angewendeteFassung) {}

    /**
     * Ein gemessener Wert. {@code raw} und {@code decoded} sind Zahl ({@link BigDecimal}), Text
     * oder Wahrheitswert — so, wie sie am Draht stehen.
     *
     * @param komponente {@code null} bei einer älteren Box (Vertrag 2.0)
     */
    public record Messung(
            String komponente,
            String messkanal,
            Instant messzeit,
            Object raw,
            Object decoded,
            String qualitaet) {}

    /** Was ankommt. {@code eingangszeit} stempelt die Datenannahme (Cloud-Uhr). */
    public record Lieferung(
            String kundenbereich, Box box, Umschlag umschlag, Messung wert, Instant eingangszeit) {}

    /** Ein Einbau eines Geräts an der Komponente (AP-04 Gerät-Historie). */
    public record Einbau(String geraet, String einbau, String seriennummer) {}

    /** Die Bindung des Messkanals zur Messzeit; {@code messstelle} ist bei KEINE {@code null}. */
    public record Quellenbindung(Bindung art, String messstelle) {}

    /** Ein Wert, der für dieselbe Reihe und Messzeit schon gespeichert ist. */
    public record Gespeichert(
            String box, Rolle rolle, Object raw, Object decoded, String qualitaet, long sequenz) {}

    /** Der zuletzt gesehene Umschlag derselben Box. */
    public record VorherigerUmschlag(long sequenz, Instant messzeit) {}

    /**
     * Was die Cloud beim Schreiben ZUR MESSZEIT nachschlägt.
     *
     * @param komponenteAusAuswahl nur für eine ältere Box: die Komponente aus der Auswahl
     * @param einbau {@code null}, wenn zur Messzeit kein Einbau gilt
     * @param fassungAusZustellung nur für eine ältere Box
     * @param zustaendigeBox Kennzeichen der zur Messzeit zuständigen Box, {@code null} wenn keine
     * @param gespeichertZurMesszeit alle Werte der Reihe mit derselben Messzeit, jede Spur
     * @param vorherigerUmschlag {@code null}: dieser Fall prüft die Sequenz nicht
     * @param unassignedReaderZuletzt letzter {@code unassigned_reader} derselben Box und
     *     Datenquelle (Eingangszeit), {@code null} wenn keiner
     */
    public record Fakten(
            String komponenteAusAuswahl,
            String einheit,
            String wertart,
            long kadenzS,
            Einbau einbau,
            Integer fassungAusZustellung,
            String datenquelle,
            String zustaendigeBox,
            Quellenbindung bindung,
            List<Gespeichert> gespeichertZurMesszeit,
            VorherigerUmschlag vorherigerUmschlag,
            Instant unassignedReaderZuletzt) {}

    /** {@code lieferung == null}: zur Messzeit kam nichts an. */
    public record Eingang(Lieferung lieferung, Fakten fakten) {}

    // ---------------------------------------------------------------- Ergebnis

    public record Wert(Object raw, Object decoded, String einheit) {}

    public record Fassung(int fassung, FassungQuelle quelle) {}

    public record Zustellung(Zustellart art, long verzoegerungS) {}

    /** Die fünfzehn Angaben je gespeichertem Wert (AP-07 §4.2). */
    public record Herkunft(
            String kundenbereich,
            String komponente,
            String messkanal,
            Instant messzeit,
            Instant eingangszeit,
            Wert wert,
            String qualitaet,
            String wertart,
            Box lesendeBox,
            Einbau geraetEinbau,
            Fassung einstellungsFassung,
            String katalogstand,
            long sequenz,
            Zustellung zustellart,
            Rolle rolle) {}

    /** Ein Ereignis mit den Feldern, die diese Ableitung kennt (Reihenfolge = Einfügefolge). */
    public record Ereignis(EreignisArt art, Map<String, Object> felder) {}

    /**
     * @param grund nur bei {@link Urteil#ABGEWIESEN}
     * @param zaehler {@code "wiederholt"} bei {@link Urteil#WIEDERHOLUNG}, sonst {@code null}
     * @param herkunft nur bei {@link Urteil#GESPEICHERT}
     */
    public record Ergebnis(
            Urteil urteil,
            Grund grund,
            List<Ereignis> ereignisse,
            String zaehler,
            Herkunft herkunft) {}

    // ---------------------------------------------------------------- Regeln

    /** Die Schwelle, ab der ein Eingang „nachgeliefert“ ist: {@code max(300 s, 3 × Kadenz)}. */
    public static long nachgeliefertSchwelleS(long kadenzS) {
        return Math.max(NACHGELIEFERT_MINDESTENS_S, NACHGELIEFERT_FAKTOR * kadenzS);
    }

    /** Direkt oder nachgeliefert — „später als“ die Schwelle; die Kante ist noch direkt. */
    public static Zustellung zustellung(Instant messzeit, Instant eingangszeit, long kadenzS) {
        long verzoegerung = eingangszeit.getEpochSecond() - messzeit.getEpochSecond();
        return new Zustellung(
                verzoegerung > nachgeliefertSchwelleS(kadenzS)
                        ? Zustellart.NACHGELIEFERT
                        : Zustellart.DIREKT,
                verzoegerung);
    }

    /**
     * Gleich heißt: roher Wert, skalierter Wert und Qualität gleich (Zahlen nach Betrag, nicht
     * nach Schreibweise). Katalogstand, Fassung und Sequenz entscheiden nicht.
     */
    private static boolean gleicherWert(Gespeichert g, Messung m) {
        return gleich(g.raw(), m.raw())
                && gleich(g.decoded(), m.decoded())
                && g.qualitaet().equals(m.qualitaet());
    }

    private static boolean gleich(Object a, Object b) {
        if (a instanceof BigDecimal x && b instanceof BigDecimal y) {
            return x.compareTo(y) == 0;
        }
        return a == null ? b == null : a.equals(b);
    }

    // ---------------------------------------------------------------- Ableitung

    /** Das Urteil über EINEN Wert. */
    public static Ergebnis stelleFest(Eingang e) {
        Lieferung l = e.lieferung();
        Fakten f = e.fakten();
        List<Ereignis> ereignisse = new ArrayList<>();
        if (l == null) {
            return new Ergebnis(Urteil.KEIN_WERT, null, ereignisse, null, null);
        }
        Messung m = l.wert();
        String box = l.box().kennzeichen();

        // 1. Zeit (E13) — ein abgewiesener Wert erzeugt genau sein Abweisungs-Ereignis.
        long vorS = m.messzeit().getEpochSecond() - l.eingangszeit().getEpochSecond();
        if (vorS > ZUKUNFT_HOECHSTENS_S) {
            ereignisse.add(ereignis(EreignisArt.CLOCK_AHEAD, "box", box, "vor_s", vorS));
            return new Ergebnis(Urteil.ABGEWIESEN, Grund.CLOCK_AHEAD, ereignisse, null, null);
        }
        if (-vorS > VERGANGENHEIT_HOECHSTENS_S) {
            ereignisse.add(ereignis(EreignisArt.TOO_OLD, "box", box, "alter_s", -vorS));
            return new Ergebnis(Urteil.ABGEWIESEN, Grund.TOO_OLD, ereignisse, null, null);
        }

        // 2. Sequenz der Box (E3/E13) — der Wert bleibt.
        VorherigerUmschlag vorher = f.vorherigerUmschlag();
        long sequenz = l.umschlag().sequenz();
        if (vorher != null) {
            if (sequenz == vorher.sequenz() + 1) {
                long sprung = l.umschlag().messzeit().getEpochSecond()
                        - vorher.messzeit().getEpochSecond();
                if (Math.abs(sprung) > ZEITSPRUNG_AB_S) {
                    ereignisse.add(ereignis(EreignisArt.CLOCK_JUMP,
                            "box", box, "sequenz", sequenz, "sprung_s", sprung));
                }
            } else if (sequenz > vorher.sequenz() + 1) {
                ereignisse.add(ereignis(EreignisArt.SEQUENCE_GAP,
                        "box", box,
                        "sequenz_erwartet", vorher.sequenz() + 1,
                        "sequenz_erhalten", sequenz,
                        "anzahl", sequenz - vorher.sequenz() - 1));
            } else if (sequenz < vorher.sequenz()) {
                ereignisse.add(ereignis(EreignisArt.SEQUENCE_RESET,
                        "box", box,
                        "sequenz_erwartet", vorher.sequenz() + 1,
                        "sequenz_erhalten", sequenz));
            }
        }

        // 3. Herkunft vollständig (Invariante 1) — nie geraten.
        String komponente = m.komponente() != null ? m.komponente() : f.komponenteAusAuswahl();
        Fassung fassung = l.umschlag().angewendeteFassung() != null
                ? new Fassung(l.umschlag().angewendeteFassung(), FassungQuelle.BOX)
                : f.fassungAusZustellung() != null
                        ? new Fassung(f.fassungAusZustellung(), FassungQuelle.ZUSTELLUNG)
                        : null;
        if (komponente == null || f.einbau() == null || fassung == null) {
            ereignisse.add(ereignis(EreignisArt.REJECTED,
                    "box", box, "grund", Grund.HERKUNFT_UNVOLLSTAENDIG.code()));
            return new Ergebnis(
                    Urteil.ABGEWIESEN, Grund.HERKUNFT_UNVOLLSTAENDIG, ereignisse, null, null);
        }

        // 4. Rolle zur Messzeit (E4).
        Rolle rolle;
        if (!box.equals(f.zustaendigeBox())) {
            rolle = Rolle.SPIEGEL;
            Instant zuletzt = f.unassignedReaderZuletzt();
            if (zuletzt == null
                    || l.eingangszeit().getEpochSecond() - zuletzt.getEpochSecond()
                            >= UNASSIGNED_READER_HOECHSTENS_JE_S) {
                ereignisse.add(ereignis(EreignisArt.UNASSIGNED_READER,
                        "box", box, "datenquelle", f.datenquelle(), "komponente", komponente));
            }
        } else {
            rolle = switch (f.bindung().art()) {
                case FUEHREND -> Rolle.FUEHREND;
                case VERGLEICH -> Rolle.VERGLEICH;
                case KEINE -> Rolle.BEOBACHTUNG;
            };
        }

        // 5. Idempotenz (E3) — Reihe + Messzeit, in der Spur der Rolle.
        Gespeichert frueher = null;
        for (Gespeichert g : f.gespeichertZurMesszeit()) {
            boolean spiegelSpur = g.rolle() == Rolle.SPIEGEL;
            if (rolle == Rolle.SPIEGEL ? spiegelSpur && g.box().equals(box) : !spiegelSpur) {
                frueher = g;
            }
        }
        if (frueher != null) {
            if (gleicherWert(frueher, m)) {
                return new Ergebnis(Urteil.WIEDERHOLUNG, null, ereignisse, "wiederholt", null);
            }
            ereignisse.add(ereignis(EreignisArt.DUPLICATE_CONFLICT,
                    "box", box,
                    "komponente", komponente,
                    "messkanal", m.messkanal(),
                    "messzeit", m.messzeit(),
                    "gespeicherter_wert",
                    wertFelder(frueher.raw(), frueher.decoded(), frueher.qualitaet()),
                    "abgewiesener_wert", wertFelder(m.raw(), m.decoded(), m.qualitaet()),
                    "sequenzen", List.of(frueher.sequenz(), sequenz)));
            return new Ergebnis(
                    Urteil.ABGEWIESEN, Grund.DUPLICATE_CONFLICT, ereignisse, null, null);
        }

        // 6. Zustellart — und die fünfzehn Angaben.
        Herkunft herkunft = new Herkunft(
                l.kundenbereich(),
                komponente,
                m.messkanal(),
                m.messzeit(),
                l.eingangszeit(),
                new Wert(m.raw(), m.decoded(), f.einheit()),
                m.qualitaet(),
                f.wertart(),
                l.box(),
                f.einbau(),
                fassung,
                l.umschlag().katalogstand(),
                sequenz,
                zustellung(m.messzeit(), l.eingangszeit(), f.kadenzS()),
                rolle);
        return new Ergebnis(Urteil.GESPEICHERT, null, ereignisse, null, herkunft);
    }

    private static Ereignis ereignis(EreignisArt art, Object... paare) {
        Map<String, Object> felder = new LinkedHashMap<>();
        for (int i = 0; i < paare.length; i += 2) {
            felder.put((String) paare[i], paare[i + 1]);
        }
        return new Ereignis(art, felder);
    }

    private static Map<String, Object> wertFelder(Object raw, Object decoded, String qualitaet) {
        Map<String, Object> w = new LinkedHashMap<>();
        w.put("raw", raw);
        w.put("decoded", decoded);
        w.put("qualitaet", qualitaet);
        return w;
    }
}
