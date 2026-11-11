package com.voltpilot.api.ueberwachung;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.erzeuger.AnlagensteuerungRepository;
import com.voltpilot.api.erzeuger.AnlagensteuerungRepository.Jungster;
import com.voltpilot.api.erzeuger.AnlagensteuerungRepository.Steuerung;
import com.voltpilot.api.erzeuger.ErzeugerRegisterbild;
import com.voltpilot.api.erzeuger.Programmstand;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.GeraetRepository.Teil;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Der {@code erzeuger}-Leser (UEMS EZ-11, Konzept vp-erzeuger-wago-konzept §4.8, EW-9 A): die Wertequelle
 * „Erzeuger“ der Überwachung. Er liest die jüngsten Werte der Familie {@value ErzeugerRegisterbild#FAMILIE} einer
 * Anlagensteuerung GENAU SO wie ihre Werte-Fläche ({@code AnlagensteuerungService#werte}: derselbe
 * {@link AnlagensteuerungRepository#juengste}, dieselbe Grenze für „aktuell“) und lässt {@link ErzeugerAlarme}
 * daraus den Zustand einer der Vorlagen bilden. Nie die Tabelle {@code erzeuger_vorgabe} (EZ-7) - nur
 * Messpunkte und ihre Frische.
 *
 * <p>Bezug: die Anlage. „Fernsteuerung nicht bereit“ gilt je Einheit ({@link #jeEinheit}); der Takt fächert die
 * Anlage dafür in {@link WerteLeser.Bezug#einheit} auf ({@link #einheiten}). Eine Anlage ohne Anlagensteuerung
 * liefert UNBEKANNT - eine Vorlage ist dort ohnehin nicht wählbar.
 */
@Component
public class ErzeugerWerteLeser implements WerteLeser {

    static final String FELD_FERNSTEUERUNG = "fernsteuerung";
    static final String FELD_DATENLAGE = "datenlage";
    static final String FELD_FOLGEN = "folgen";
    static final String FELD_ABSCHALTUNG = "abschaltung";
    static final String FELD_FERNWIRK = "fernwirk";
    static final String FELD_PROGRAMMSTAND = "programmstand";

    /** Die Zustände, die bei mehreren Steuerungen an einer Anlage den Ausschlag geben (der Ziel-Zustand der Vorlage). */
    private static final Map<String, String> SCHLECHT = Map.of(FELD_DATENLAGE, "veraltet", FELD_FOLGEN, "folgt_nicht",
            FELD_ABSCHALTUNG, "abgeschaltet", FELD_FERNWIRK, "getrennt", FELD_PROGRAMMSTAND, Programmstand.AELTER);

    static final double VORGABE_TOLERANZ_PROZENT = 5;
    static final double VORGABE_TOLERANZ_KW = 5;

    private final AnlagensteuerungRepository steuerungen;

    public ErzeugerWerteLeser(AnlagensteuerungRepository steuerungen) {
        this.steuerungen = steuerungen;
    }

    /** Ob eine Vorlage je Einheit statt je Anlage ausgewertet wird. */
    public boolean jeEinheit(WerteKatalog.Eintrag eintrag) {
        return FELD_FERNSTEUERUNG.equals(eintrag.leser().feld());
    }

    /** Ob die Anlage eine Anlagensteuerung hat (nur dort sind die Vorlagen wählbar). */
    public boolean hatAnlagensteuerung(UUID anlageId) {
        return !steuerungen.steuerungen(anlageId).isEmpty();
    }

    /** Die Anlage einer Steuerung (für den Bezug {@code einheit}); {@code null}, wenn sie nicht (mehr) sichtbar ist. */
    public UUID anlageDerSteuerung(UUID geraetId) {
        return steuerungen.steuerung(geraetId).map(Steuerung::siteId).orElse(null);
    }

    /** Je Steuerung der Anlage ihre Einheiten 1 … te_anzahl (Fassung, sonst die eingetragenen Einheiten). */
    public List<Bezug> einheiten(UUID anlageId) {
        List<Bezug> out = new ArrayList<>();
        for (Steuerung s : steuerungen.steuerungen(anlageId)) {
            for (int te = 1; te <= teAnzahl(s.geraetId()); te++) {
                out.add(Bezug.einheit(s.geraetId(), te));
            }
        }
        return out;
    }

    @Override
    public Lesung lese(WerteKatalog.Eintrag eintrag, Bezug bezug, Instant jetzt) {
        return lese(eintrag, bezug, null, jetzt);
    }

    /** Liest mit den Schwellen der Bedingung ({@code toleranz_prozent}, {@code toleranz_kw} für „Anlage folgt nicht“). */
    public Lesung lese(WerteKatalog.Eintrag eintrag, Bezug bezug, JsonNode bedingung, Instant jetzt) {
        String feld = eintrag.leser().feld();
        if (FELD_FERNSTEUERUNG.equals(feld)) {
            if (!"einheit".equals(bezug.art())) {
                return Lesung.unbekannt();
            }
            Steuerung s = steuerungen.steuerung(bezug.id()).orElse(null);
            if (s == null) {
                return Lesung.unbekannt();
            }
            int teNr = Integer.parseInt(bezug.parameter());
            return lesung(ErzeugerAlarme.fernsteuerung(bild(s, jetzt), teNr, einheitName(s, teNr)));
        }
        if (!"anlage".equals(bezug.art())) {
            return Lesung.unbekannt();
        }
        List<Steuerung> alle = steuerungen.steuerungen(bezug.id());
        List<ErzeugerAlarme.Urteil> urteile = new ArrayList<>();
        for (Steuerung s : alle) {
            ErzeugerAlarme.Urteil u = FELD_PROGRAMMSTAND.equals(feld)
                    ? ErzeugerAlarme.programmstand(bild(s, jetzt), programmstandSoll(s.geraetId()))
                    : urteil(feld, bild(s, jetzt), bedingung);
            urteile.add(alle.size() > 1 && u.bekannt() ? benannt(s, u) : u);
        }
        return lesung(zusammen(feld, urteile));
    }

    private static ErzeugerAlarme.Urteil urteil(String feld, ErzeugerAlarme.Bild bild, JsonNode bedingung) {
        return switch (feld) {
            case FELD_DATENLAGE -> ErzeugerAlarme.datenlage(bild);
            case FELD_FOLGEN -> ErzeugerAlarme.folgen(bild,
                    schwelle(bedingung, "toleranz_prozent", VORGABE_TOLERANZ_PROZENT),
                    schwelle(bedingung, "toleranz_kw", VORGABE_TOLERANZ_KW));
            case FELD_ABSCHALTUNG -> ErzeugerAlarme.abschaltung(bild);
            case FELD_FERNWIRK -> ErzeugerAlarme.fernwirk(bild);
            default -> throw new IllegalArgumentException("ErzeugerWerteLeser: unbekanntes Feld '" + feld + "'");
        };
    }

    /**
     * Mehrere Steuerungen an einer Anlage: der Ziel-Zustand der Vorlage gewinnt (eine Steuerung, die nicht folgt,
     * reicht), dann Unbekannt (eine unbekannte Steuerung ist nicht „in Ordnung“), sonst die erste.
     */
    static ErzeugerAlarme.Urteil zusammen(String feld, List<ErzeugerAlarme.Urteil> urteile) {
        if (urteile.isEmpty()) {
            return ErzeugerAlarme.Urteil.UNBEKANNT;
        }
        List<ErzeugerAlarme.Urteil> schlecht = urteile.stream().filter(u -> SCHLECHT.get(feld).equals(u.zustand()))
                .toList();
        if (!schlecht.isEmpty()) {
            return new ErzeugerAlarme.Urteil(schlecht.get(0).zustand(),
                    String.join(" ", schlecht.stream().map(ErzeugerAlarme.Urteil::text).toList()),
                    schlecht.get(0).messzeit());
        }
        if (urteile.stream().anyMatch(u -> !u.bekannt())) {
            return ErzeugerAlarme.Urteil.UNBEKANNT;
        }
        return urteile.get(0);
    }

    private static ErzeugerAlarme.Urteil benannt(Steuerung s, ErzeugerAlarme.Urteil u) {
        return new ErzeugerAlarme.Urteil(u.zustand(), steuerungName(s) + ": " + u.text(), u.messzeit());
    }

    private static Lesung lesung(ErzeugerAlarme.Urteil u) {
        return u.bekannt() ? Lesung.zustand(u.zustand(), u.messzeit(), u.text()) : Lesung.unbekannt();
    }

    private ErzeugerAlarme.Bild bild(Steuerung s, Instant jetzt) {
        int teAnzahl = teAnzahl(s.geraetId());
        Map<String, ErzeugerAlarme.Wert> werte = new LinkedHashMap<>();
        for (Jungster j : steuerungen.juengste(TenantContext.get(), s.entityId(), ErzeugerRegisterbild.punkte(teAnzahl))) {
            werte.put(j.pointKey(), new ErzeugerAlarme.Wert(j.zahl(), j.zeit(), j.qualitaet()));
        }
        return new ErzeugerAlarme.Bild(werte, teAnzahl, jetzt);
    }

    /** Der Soll der laufenden Fassung (EZ-16); null = der Stand der Bibliothek. */
    private Integer programmstandSoll(UUID geraetId) {
        return steuerungen.fassung(geraetId).map(AnlagensteuerungRepository.Fassung::programmstandSoll).orElse(null);
    }

    private int teAnzahl(UUID geraetId) {
        return steuerungen.fassung(geraetId).map(AnlagensteuerungRepository.Fassung::teAnzahl)
                .orElseGet(() -> Math.max(1, steuerungen.einheiten(geraetId).size()));
    }

    /** Wie das Portal eine Einheit nennt: ihre Bezeichnung, sonst der Name aus dem Bild, sonst „Einheit n“. */
    private String einheitName(Steuerung s, int teNr) {
        for (Teil t : steuerungen.einheiten(s.geraetId())) {
            if (t.teNr() != null && t.teNr() == teNr) {
                if (t.bezeichnung() != null && !t.bezeichnung().isBlank()) {
                    return t.bezeichnung();
                }
                if (t.typBild() != null && !t.typBild().isBlank()) {
                    return t.typBild();
                }
            }
        }
        return "Einheit " + teNr;
    }

    private static String steuerungName(Steuerung s) {
        return s.bezeichnung() != null && !s.bezeichnung().isBlank() ? s.bezeichnung() : s.kennzeichen();
    }

    private static double schwelle(JsonNode bedingung, String name, double vorgabe) {
        return bedingung != null && bedingung.path(name).isNumber() ? bedingung.path(name).asDouble() : vorgabe;
    }
}
