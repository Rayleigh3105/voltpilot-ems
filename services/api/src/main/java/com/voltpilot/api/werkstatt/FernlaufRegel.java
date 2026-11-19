package com.voltpilot.api.werkstatt;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Die Regeln des Fernlaufs durch den Wartungstunnel (Konzept vp-update-vor-zuordnung, S1, §4.1/§4.2), rein und
 * ohne Datenbank: die Vorprüfung beim Klick, der Zustand eines Auftrags und die geschlossenen Vokabulare
 * ({@code docs/contracts/werkstatt-fernlauf.json}, Zwillinge im Werkstatt-Dienst und im Portal).
 *
 * <p>Unbekannt ist nie „ja“: fehlt eine Rückmeldung, eine gemeldete Fassung oder die Meldung des Dienstes, gibt es
 * keinen Knopf, sondern den Grund.
 */
public final class FernlaufRegel {

    private FernlaufRegel() {
    }

    /** Die einzige Art in S1; S2 („Alle aufspielen“) und S4 (nachts) legen denselben Auftrag an. */
    public static final String AUFSPIELEN = "aufspielen";

    /** Schritte des Dienstes, in ihrer Reihenfolge (Vektor {@code schritte}). */
    public static final List<String> SCHRITTE = List.of("anmelden", "bestand", "fassungen", "sichern", "aufspielen",
            "neustart", "meldet_sich", "tunnel", "zurueck", "fenster_zu");
    public static final Set<String> SCHRITT_ZUSTAENDE = Set.of("laeuft", "belegt", "gescheitert");
    public static final List<String> ERGEBNISSE = List.of("fertig", "zurueck", "unveraendert", "offen");
    public static final List<String> ZUSTAENDE = List.of("erteilt", "laeuft", "fertig", "zurueck", "unveraendert",
            "offen", "nicht_abgeholt");

    /** So lange wartet ein Auftrag darauf, dass der Dienst ihn annimmt (wie {@link LaufSeiteService#AUFTRAG_FRIST}). */
    public static final Duration ABHOLFRIST = LaufSeiteService.AUFTRAG_FRIST;
    /** Das Fenster des Dienstes (§4.1). */
    public static final Duration FENSTER = Duration.ofMinutes(30);
    /** So alt darf die Rückmeldung des Tunnel-Dienstes sein, und so frisch die letzte Schlüsselfrage (§4.2). */
    public static final Duration RUECKMELDUNG = Duration.ofMinutes(3);

    /** {@code deviceInfo} der Zertifikatsanfrage ist {@code "vp-edge-core " + Fassung} ({@code agent.go}). */
    public static final String DEVICE_INFO_PRAEFIX = "vp-edge-core ";
    public static final String EDGE_LIGHT_PRAEFIX = "edge-light-";

    /** Die laufende Fassung aus der letzten Zertifikatsanfrage, {@code null} wenn keine genannt ist. */
    public static String laeuft(String deviceInfo) {
        if (deviceInfo == null) {
            return null;
        }
        String s = deviceInfo.trim();
        if (s.equals(DEVICE_INFO_PRAEFIX.trim())) {
            return null;
        }
        if (s.startsWith(DEVICE_INFO_PRAEFIX)) {
            s = s.substring(DEVICE_INFO_PRAEFIX.length()).trim();
        }
        return s.isEmpty() || s.contains(" ") ? null : s;
    }

    /** Ein Grund gegen den Knopf: fester Code für das Portal, Satz für den Admin (du). */
    public record Grund(String code, String text) {
    }

    /** Die drei Haken der Karte (§4.5), jeder nur bei einer Tatsache wahr. */
    public record Haken(boolean tunnelVerbunden, boolean fragtNachSchluesseln, boolean keinKundenkonto) {
    }

    /** Das Urteil der Vorprüfung: {@code moeglich} nur ohne einen Grund. */
    public record Urteil(boolean moeglich, List<Grund> gruende, Haken haken) {
    }

    /**
     * Was die Vorprüfung weiß. Ein Feld {@code null} heißt unbekannt.
     *
     * @param gekoppelt        eine Gerätezeile gibt es (die Box hat ein Kundenkonto)
     * @param zertifikat       für die Referenz ist ein Zertifikat ausgestellt
     * @param werkstattLight   im Werkstatt-Register als Edge Light
     * @param laeuft           die zuletzt gemeldete Fassung (aus {@code deviceInfo})
     * @param laeuftSeq        ihr Stand im Register, {@code null} wenn sie dort nicht steht
     * @param neueste          die neueste zuweisbare Fassung der Linie mit Skriptstand, {@code null} wenn keine passt
     * @param neuesteSeq       ihr Stand
     * @param neuesteGrund     warum es keine passende neueste gibt (Satz der Werkstatt-Regel)
     * @param tunnelZugang     die Box hat einen Tunnel-Zugang
     * @param tunnelAktiv      der Zugang ist nicht gesperrt
     * @param rueckmeldungAm   wann die API die letzte Meldung des Tunnel-Dienstes zu dieser Box annahm
     * @param verbundenSeit    laut dieser Meldung verbunden seit ({@code null} = nicht verbunden)
     * @param gefragtUm        laut dieser Meldung zuletzt nach Schlüsseln gefragt
     * @param technikerZugang  der Techniker-Zugang des Dienstes ist eingerichtet und aktiv
     * @param dienstGemeldetAm wann der Werkstatt-Dienst zuletzt seine Ansicht meldete
     * @param dienstFernlauf   was er zum Fernlauf meldet: {@code null} = das Feld fehlt (älteres Bild)
     * @param dienstGrund      warum er keinen Fernlauf kann, wenn er das meldet
     * @param hostSchluessel   der Host-Schlüssel aus Abnahme oder Einlösung ist bekannt
     * @param offen            für die Referenz ist ein Auftrag offen
     */
    public record Eingabe(boolean gekoppelt, boolean zertifikat, boolean werkstattLight, String laeuft, Long laeuftSeq,
            String neueste, Long neuesteSeq, String neuesteGrund, boolean tunnelZugang, boolean tunnelAktiv,
            Instant rueckmeldungAm, Instant verbundenSeit, Instant gefragtUm, boolean technikerZugang,
            Instant dienstGemeldetAm, Boolean dienstFernlauf, String dienstGrund, boolean hostSchluessel,
            boolean offen) {
    }

    /** Die Vorprüfung aus §4.2, Schritt {@code vorpruefen}. */
    public static Urteil vorpruefen(Eingabe e, Instant jetzt) {
        List<Grund> g = new ArrayList<>();
        boolean frisch = e.rueckmeldungAm() != null && !e.rueckmeldungAm().isBefore(jetzt.minus(RUECKMELDUNG));
        boolean verbunden = frisch && e.verbundenSeit() != null;
        boolean fragt = verbunden && e.gefragtUm() != null && !e.gefragtUm().isBefore(jetzt.minus(RUECKMELDUNG));
        boolean ohneKonto = !e.gekoppelt() && !e.zertifikat();

        if (e.gekoppelt()) {
            g.add(new Grund("kundenkonto", "Die Box hat ein Kundenkonto; ihre Updates kommen über die Updates im Portal."));
        } else if (e.zertifikat()) {
            g.add(new Grund("zertifikat", "Für die Box ist schon ein Zertifikat ausgestellt; sie holt Updates über das "
                    + "erste Verbinden."));
        }
        boolean light = e.werkstattLight() || (e.laeuft() != null && e.laeuft().startsWith(EDGE_LIGHT_PRAEFIX));
        if (!light) {
            g.add(new Grund("keine_edge_light", "Nur eine Edge-Light-Box hat den Wartungstunnel; diese ist keine "
                    + "oder meldet ihre Bauart nicht."));
        }
        if (e.laeuft() == null) {
            g.add(new Grund("fassung_unbekannt", "Die Box hat noch keine Fassung gemeldet (keine Zertifikatsanfrage)."));
        } else if (e.neueste() != null && e.laeuftSeq() == null) {
            g.add(new Grund("fassung_fremd", "Die Box meldet " + e.laeuft() + "; diese Fassung steht nicht im Register, "
                    + "ein Vergleich mit der neuesten geht nicht."));
        }
        if (e.neueste() == null) {
            g.add(new Grund("keine_neueste", e.neuesteGrund() == null || e.neuesteGrund().isBlank()
                    ? "Es gibt keine neueste zuweisbare Edge-Light-Fassung mit Skriptstand."
                    : e.neuesteGrund()));
        } else if (e.laeuftSeq() != null && e.neuesteSeq() != null && e.laeuftSeq() >= e.neuesteSeq()) {
            g.add(new Grund("schon_neueste", "Die Box läuft schon " + e.laeuft() + "; neuer ist nichts."));
        }
        if (!e.tunnelZugang()) {
            g.add(new Grund("kein_tunnel", "Die Box hat keinen Tunnel-Zugang in der Fernwartung."));
        } else if (!e.tunnelAktiv()) {
            g.add(new Grund("tunnel_gesperrt", "Der Tunnel-Zugang der Box ist gesperrt."));
        } else if (!frisch) {
            g.add(new Grund("keine_rueckmeldung", "Der Tunnel-Dienst hat zu dieser Box seit mehr als 3 Minuten nichts "
                    + "gemeldet; ob sie verbunden ist, ist nicht bekannt."));
        } else if (!verbunden) {
            g.add(new Grund("nicht_verbunden", "Die Box ist gerade nicht im Tunnel (kein Handshake in den letzten "
                    + "3 Minuten)."));
        } else if (!fragt) {
            g.add(new Grund("fragt_nicht", e.gefragtUm() == null
                    ? "Die Box fragt nicht nach Schlüsseln (Tunnel ohne Schlüsselabholung); einmal von Hand nachrüsten."
                    : "Die Box hat seit mehr als 3 Minuten nicht nach Schlüsseln gefragt."));
        }
        if (!e.technikerZugang()) {
            g.add(new Grund("kein_techniker_zugang", "Für den Werkstatt-Dienst ist kein aktiver Techniker-Zugang "
                    + "eingerichtet."));
        }
        if (e.dienstGemeldetAm() == null
                || e.dienstGemeldetAm().isBefore(jetzt.minus(DienstAnsichtService.AKTUELL))) {
            g.add(new Grund("dienst_stumm", "Der Werkstatt-Dienst meldet sich nicht."));
        } else if (e.dienstFernlauf() == null) {
            g.add(new Grund("dienst_alt", "Der Werkstatt-Dienst kennt den Fernlauf noch nicht (älteres Bild)."));
        } else if (!e.dienstFernlauf()) {
            g.add(new Grund("dienst_nicht_bereit", "Der Werkstatt-Dienst kann gerade keinen Fernlauf"
                    + (e.dienstGrund() == null || e.dienstGrund().isBlank() ? "." : ": " + e.dienstGrund())));
        }
        if (!e.hostSchluessel()) {
            g.add(new Grund("kein_host_schluessel", "Aus der Werkstatt ist kein Host-Schlüssel der Box bekannt; ohne "
                    + "ihn meldet sich der Dienst nicht an."));
        }
        if (e.offen()) {
            g.add(new Grund("laeuft_schon", "Für diese Box läuft schon ein Fernlauf."));
        }
        return new Urteil(g.isEmpty(), List.copyOf(g), new Haken(verbunden, fragt, ohneKonto));
    }

    /**
     * Der Zustand eines Auftrags: mit Ergebnis dessen Wort; sonst {@code erteilt} bis zur Abholfrist, danach
     * {@code nicht_abgeholt}; angenommen {@code laeuft}, bis das Fenster endet, danach {@code offen} (der Dienst hat
     * kein Ende gemeldet, und ohne Fenster kommt er nicht mehr an die Box).
     */
    public static String zustand(Instant erteiltAm, Instant begonnenAm, Instant fensterEnde, String ergebnis,
            Instant jetzt) {
        if (ergebnis != null) {
            return ergebnis;
        }
        if (begonnenAm == null) {
            return erteiltAm.plus(ABHOLFRIST).isAfter(jetzt) ? "erteilt" : "nicht_abgeholt";
        }
        return fensterEnde != null && fensterEnde.isAfter(jetzt) ? "laeuft" : "offen";
    }

    /** Offen ist ein Auftrag, solange er erteilt ist oder läuft: dann gibt es keinen zweiten für dieselbe Box. */
    public static boolean offen(String zustand) {
        return "erteilt".equals(zustand) || "laeuft".equals(zustand);
    }
}
