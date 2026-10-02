package com.voltpilot.api.mispel;

import com.voltpilot.api.mispel.FoerderwegRegeln.Ablehnung;
import com.voltpilot.api.mispel.FoerderwegRegeln.Angaben;
import com.voltpilot.api.mispel.FoerderwegRegeln.Antrag;
import com.voltpilot.api.mispel.FoerderwegRegeln.Foerderweg;
import com.voltpilot.api.mispel.FoerderwegRegeln.Vorher;
import com.voltpilot.api.mispel.FoerderwegRepository.Fassung;
import com.voltpilot.api.mispel.FoerderwegRepository.Schalter;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Der Förderweg je Einspeisestelle (MiSpeL MP-5, Vertrag {@code docs/contracts/v2/mispel-foerderweg.md}): lesen am
 * Tag (Fassung oder Bestand), eine neue Fassung setzen, und der alte Netzlade-Schalter an der Anlage, solange die
 * Portal-Einrichtung (MP-17) ihn noch anbietet. Die Regeln selbst stehen in {@link FoerderwegRegeln}.
 */
@Service
public class FoerderwegService {

    /** Gesetzliche Zeit (A1 S. 33, Abschn. 4.2.1): der Tag einer Fassung beginnt um 00:00 MEZ/MESZ. */
    public static final ZoneId ZEITZONE = ZoneId.of("Europe/Berlin");

    private final FoerderwegRepository wege;
    private final TransactionTemplate transaktion;
    private final LocalDate pauschaloptionAb;
    private volatile Clock uhr = Clock.systemUTC();

    public FoerderwegService(FoerderwegRepository wege, TransactionTemplate transaktion,
            @Value("${voltpilot.mispel.pauschaloption-ab:}") String pauschaloptionAb) {
        this.wege = wege;
        this.transaktion = transaktion;
        this.pauschaloptionAb = pauschaloptionAb == null || pauschaloptionAb.isBlank() ? null
                : LocalDate.parse(pauschaloptionAb.trim());
    }

    /** Nur für Tests: die Uhr, an der „heute“ hängt. */
    public void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /** Ein Antrag, wie er aus der Route kommt (snake_case im JSON). */
    public record Aendern(String foerderweg, String formelsatz, Boolean einverstaendnis, LocalDate gueltigAb,
            Boolean netzladen, Boolean erstmaligeZuordnung, Boolean messkonzeptGeaendert, String awRegel) {}

    public record FassungAnsicht(Fassung fassung, LocalDate gueltigBis) {}

    /**
     * Der Förderweg am Tag {@code am}. {@code fassung} {@code null} = Bestand (aus den heutigen Schaltern);
     * {@code netzladenHeute} ist die Einstellung an der Anlage heute ({@code site.netzladen_erlaubt}).
     */
    public record Ansicht(UUID siteId, LocalDate am, Angaben angaben, Fassung fassung, boolean netzladenHeute,
            List<FassungAnsicht> fassungen) {
        public LocalDate formelsatzGebundenBis() {
            return FoerderwegRegeln.gebundenBis(angaben.formelsatz(), am);
        }
    }

    public LocalDate heute() {
        return LocalDate.now(uhr.withZone(ZEITZONE));
    }

    /** {@code null} für eine fremde oder unbekannte Anlage. */
    public Ansicht ansicht(UUID siteId, LocalDate am) {
        Schalter s = wege.schalter(siteId).orElse(null);
        if (s == null) {
            return null;
        }
        LocalDate tag = am == null ? heute() : am;
        List<Fassung> alle = wege.derAnlage(siteId);
        List<Fassung> wirksam = wirksam(alle);
        Fassung f = amTag(wirksam, tag);
        Angaben a = f != null ? f.angaben() : wirksam.isEmpty()
                ? FoerderwegRegeln.ausBestand(s.netzladenErlaubt(), s.plantKind()) : null;
        List<FassungAnsicht> liste = new ArrayList<>();
        for (Fassung x : alle) {
            LocalDate bis = x.aufgehoben() ? null : wirksam.stream().map(Fassung::gueltigAb)
                    .filter(d -> d.isAfter(x.gueltigAb())).min(Comparator.naturalOrder())
                    .map(d -> d.minusDays(1)).orElse(null);
            liste.add(new FassungAnsicht(x, bis));
        }
        return new Ansicht(siteId, tag, a, f, s.netzladenErlaubt(), List.copyOf(liste));
    }

    /** Eine neue Fassung ab {@code gueltig_ab}; danach stimmen die Spiegel an der Anlage mit ihr überein. */
    public void setzen(UUID siteId, Aendern a, String von) {
        Antrag antrag = lies(a);
        LocalDate heute = heute();
        Instant jetzt = uhr.instant();
        transaktion.executeWithoutResult(tx -> {
            Schalter s = wege.schalterSperren(siteId).orElseThrow(() -> new FoerderwegAbgelehnt("anlage_unbekannt",
                    404, "Anlage nicht gefunden.", Map.of()));
            List<Fassung> wirksam = wirksam(wege.derAnlage(siteId));
            LocalDate ab = antrag.gueltigAb();
            Fassung gleicherTag = wirksam.stream().filter(f -> f.gueltigAb().equals(ab)).findFirst().orElse(null);
            List<Fassung> ohne = wirksam.stream().filter(f -> f != gleicherTag).toList();
            Fassung davor = amTag(ohne, ab.minusDays(1));
            boolean bestand = ohne.isEmpty();
            Angaben alt = davor != null ? davor.angaben()
                    : FoerderwegRegeln.ausBestand(s.netzladenErlaubt(), s.plantKind());
            LocalDate letzte = ohne.stream().map(Fassung::gueltigAb).max(Comparator.naturalOrder()).orElse(null);
            Ablehnung nein = FoerderwegRegeln.pruefen(antrag, new Vorher(alt, bestand, letzte), heute,
                    pauschaloptionAb);
            if (nein != null) {
                throw FoerderwegAbgelehnt.aus(nein);
            }
            if (gleicherTag != null) {
                wege.aufheben(gleicherTag.id(), jetzt);
            }
            Angaben neu = antrag.angaben();
            wege.eintragen(s.tenantId(), siteId, neu, ab, von);
            wege.spiegeln(siteId, FoerderwegRegeln.netzladenNachher(neu.foerderweg(), antrag.netzladen(),
                    s.netzladenErlaubt()), neu.foerderweg().plantKind());
        });
    }

    /**
     * Der alte Netzlade-Schalter an {@code PUT /sites/{id}} (bis MP-17 ihn ersetzt, W2 = B). Ohne Fassung bleibt
     * alles wie heute: die Schalter SIND der Bestand. Mit Fassung bestimmt der Förderweg: Netzladen, wo er es
     * ausschließt, ist 409; {@code plant_kind} folgt dem Förderweg. Antwort: das {@code plant_kind}, das gespeichert
     * werden darf.
     */
    public String alterSchalter(UUID siteId, Boolean netzladenErlaubt, String plantKind) {
        Fassung f = amTag(wirksam(wege.derAnlage(siteId)), heute());
        if (f == null) {
            return plantKind;
        }
        Foerderweg weg = f.angaben().foerderweg();
        if (Boolean.TRUE.equals(netzladenErlaubt) && !weg.netzladenMoeglich()) {
            throw new FoerderwegAbgelehnt("netzladen_ausgeschlossen", 409, weg.begriff() + ": der Speicher darf "
                    + "nicht aus dem Netz laden, sonst entfällt die Förderung. Den Förderweg ändert "
                    + "PUT /api/v1/sites/{id}/foerderweg.", Map.of("foerderweg", weg.wert(),
                            "fundstelle", "§ 19 Abs. 3a EEG; A1 S. 11"));
        }
        return weg.plantKind() != null ? weg.plantKind() : plantKind;
    }

    private static Antrag lies(Aendern a) {
        if (a == null) {
            throw FoerderwegAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        if (a.foerderweg() == null) {
            throw FoerderwegAbgelehnt.anfrage("foerderweg", "„foerderweg“ fehlt.");
        }
        Foerderweg weg = Foerderweg.von(a.foerderweg()).orElseThrow(() -> new FoerderwegAbgelehnt(
                "foerderweg_ungueltig", 400, "„" + a.foerderweg() + "“ ist kein Förderweg.",
                Map.of("foerderweg", a.foerderweg())));
        if (a.gueltigAb() == null) {
            throw FoerderwegAbgelehnt.anfrage("gueltig_ab", "„gültig ab“ fehlt (ein Tag, JJJJ-MM-TT).");
        }
        return new Antrag(new Angaben(weg, a.formelsatz(), Boolean.TRUE.equals(a.einverstaendnis()), a.awRegel()),
                a.gueltigAb(), a.netzladen(), Boolean.TRUE.equals(a.erstmaligeZuordnung()),
                Boolean.TRUE.equals(a.messkonzeptGeaendert()));
    }

    private static List<Fassung> wirksam(List<Fassung> alle) {
        return alle.stream().filter(f -> !f.aufgehoben()).toList();
    }

    /** Die Fassung, die am Tag gilt: die späteste mit {@code gueltig_ab <= tag}; {@code null} = keine. */
    private static Fassung amTag(List<Fassung> wirksam, LocalDate tag) {
        return wirksam.stream().filter(f -> !f.gueltigAb().isAfter(tag))
                .max(Comparator.comparing(Fassung::gueltigAb)).orElse(null);
    }
}
