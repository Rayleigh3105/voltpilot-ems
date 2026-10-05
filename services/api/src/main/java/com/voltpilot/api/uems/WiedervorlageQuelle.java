package com.voltpilot.api.uems;

import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * UEMS AP-19 WV1/WV2: eine Quelle der Wiedervorlage. Jede Quelle liest ihre Fristen über den Dienst, dem sie gehören —
 * im Zaun und mit den Rechten des Aufrufers — und gibt sie FERTIG aus der Regel ihres Objekts weiter; sie rechnet keine
 * Frist nach. Lage, Vorschau-Fenster und Reihenfolge macht danach die Operation {@code wiedervorlage} des Vertrags
 * ({@link EnergiemanagementRegeln#wiedervorlage}) im Leser {@code GET …/wiedervorlage} (IP-21).
 *
 * <p>Heute: {@link DokumentWiedervorlage} (DK5), {@link AuditWiedervorlage} (IA4), {@link FeststellungWiedervorlage}
 * (FS1) und {@link WiedervorlageBestand} (AP-16 S5, AP-17 F5, AP-12 E7, AP-18 F1–F3 über den Übersichts-Leser, Messbedarf).
 * Die Managementbewertung (MG7) seit IP-23: {@link ManagementbewertungWiedervorlage} in {@code @Order(40)}.
 */
public interface WiedervorlageQuelle {

    /**
     * Eine Frist, wie ihr Objekt sie festlegt. {@code art} aus {@code wiedervorlage_art}; {@code id} und
     * {@code kennzahlId} tragen den Sprung auf eine bestehende Seite (WV3), beide dürfen {@code null} sein.
     * {@code herkunft} (Konzept Wiedervorlage w1, additiv) sagt, woraus die Frist folgt: dieselben Werte, aus denen die
     * Quelle {@code faelligAm} schon hat; {@code null}, wo eine Quelle sie (noch) nicht nennt.
     */
    record Frist(String art, String kennzeichen, String titel, LocalDate faelligAm, String verantwortlich, UUID id,
            UUID kennzahlId, Herkunft herkunft) {

        public Frist(String art, String kennzeichen, String titel, LocalDate faelligAm, String verantwortlich, UUID id,
                UUID kennzahlId) {
            this(art, kennzeichen, titel, faelligAm, verantwortlich, id, kennzahlId, null);
        }
    }

    /**
     * Woraus eine Frist folgt (Konzept Wiedervorlage w1, §5.5 „Grund“), als Angaben statt als Satz; die Wörter bildet
     * das Portal. {@code basis} aus {@code wiedervorlage_basis} ({@link #BASEN}); {@code am} der Tag, an dem die Regel
     * ansetzt (Freigabe, „geprüft, bleibt“, Durchführung, Sitzung, erkannt, festgestellt, Termin, Ende der Zielperiode);
     * {@code fassung} die Fassung bzw. der Stand Nr., {@code monate} der Rhythmus, {@code kennung} das Objekt, an dem die
     * Regel ansetzt (letztes Audit, letzte Managementbewertung, erste Korrektur) oder aus dem der Gegenstand stammt
     * ({@code quelleArt}: die Herkunft einer Maßnahme aus {@code massnahme_herkunft}, die Quelle einer Feststellung aus
     * {@code feststellung_quelle}), {@code anzahl} wie viele Anlässe der Eintrag trägt (Korrekturen an einem Bericht).
     * {@code bezug} ist der Gegenstand in Kundenwörtern, wo die Zeile ihn nicht schon im Titel trägt (die Kennzahl einer
     * Bezugsbasis, der Bericht, der Wortlaut einer Feststellung oder eines Messbedarfs). {@code verantwortlichSub} ist
     * das Konto der verantwortlichen Person, wo das Objekt eines kennt; {@code einsatzId} der Energieeinsatz eines
     * Messbedarfs (dort richtet man die Messstelle ein).
     */
    record Herkunft(String basis, LocalDate am, Integer fassung, Integer monate, String kennung, String quelleArt,
            Integer anzahl, String bezug, String verantwortlichSub, UUID einsatzId) {

        public static Herkunft von(String basis, LocalDate am) {
            return new Herkunft(basis, am, null, null, null, null, null, null, null, null);
        }

        public Herkunft mitFassung(Integer f) {
            return new Herkunft(basis, am, f, monate, kennung, quelleArt, anzahl, bezug, verantwortlichSub, einsatzId);
        }

        public Herkunft mitMonaten(Integer m) {
            return new Herkunft(basis, am, fassung, m, kennung, quelleArt, anzahl, bezug, verantwortlichSub, einsatzId);
        }

        public Herkunft mitKennung(String k) {
            return new Herkunft(basis, am, fassung, monate, k, quelleArt, anzahl, bezug, verantwortlichSub, einsatzId);
        }

        public Herkunft mitQuelle(String art, String k) {
            return new Herkunft(basis, am, fassung, monate, k, art, anzahl, bezug, verantwortlichSub, einsatzId);
        }

        public Herkunft mitAnzahl(Integer n) {
            return new Herkunft(basis, am, fassung, monate, kennung, quelleArt, n, bezug, verantwortlichSub, einsatzId);
        }

        public Herkunft mitBezug(String b) {
            return new Herkunft(basis, am, fassung, monate, kennung, quelleArt, anzahl, b, verantwortlichSub, einsatzId);
        }

        public Herkunft mitKonto(String sub) {
            return new Herkunft(basis, am, fassung, monate, kennung, quelleArt, anzahl, bezug, sub, einsatzId);
        }

        public Herkunft mitEinsatz(UUID e) {
            return new Herkunft(basis, am, fassung, monate, kennung, quelleArt, anzahl, bezug, verantwortlichSub, e);
        }
    }

    /** Das geschlossene Vokabular {@code wiedervorlage_basis}: woran eine Frist ansetzt. */
    List<String> BASEN = List.of("freigabe", "geprueft_bleibt", "durchgefuehrt", "sitzung", "erkannt", "festgestellt",
            "termin", "zielperiode");

    /** Die Fristen am Tag {@code abruf} — jede Frist genau einmal, auch eine weit in der Zukunft. */
    List<Frist> fristen(LocalDate abruf);
}
