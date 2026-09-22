package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.MessstelleWerteDto;
import com.voltpilot.api.web.dto.VergleichToleranzDto;
import com.voltpilot.api.web.dto.VergleichToleranzDto.Befund;
import com.voltpilot.api.web.dto.VergleichToleranzDto.Monat;
import com.voltpilot.api.web.dto.VergleichToleranzDto.Toleranz;
import com.voltpilot.api.web.dto.VergleichToleranzDto.Vergleich;
import com.voltpilot.api.web.dto.VergleichToleranzDto.Vergleichsquelle;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.YearMonth;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * AP-16 IP-17 (G5, E10 = A): die Toleranz je Vergleichsquelle als Fassung und der Monatsvergleich führend ↔ Vergleich
 * als reines Lesemodell.
 *
 * <p><b>Was hier nie geschieht:</b> keine Ursache, kein Ersatz, keine Änderung eines Werts (AP-04 E3, AP-08 E7). Beide
 * Monatsmengen werden GELESEN — die führende über {@link MessstelleWerteService} (dieselbe Zahl wie an
 * {@code …/werte}), die Vergleichsmenge aus der gespeicherten Monatszeile ihres Messkanals; die Regel
 * {@link BewertungRegeln#monatsvergleich} entscheidet nur „passt“, „abweichung“ oder „nicht vergleichbar“. Eine Lücke
 * oder ein Ersatzwert ist nie ein Befund. Der Befund ist kein Kriterium und ändert keine Einstufung.
 *
 * <p><b>Fassungen:</b> Fassung 1 ist der Startwert des Vertrags (2 % je Monat) und wird nie gespeichert. Jede weitere
 * gilt ab dem Monat ihres Eintrags in der Zeitzone der Messstelle — ein abgeschlossener Monat wird nie nachträglich
 * anders beurteilt.
 */
@Service
public class VergleichToleranzService {

    /** Startwert je Vergleichsquelle (bewertung.md §3/§13: 2 % pro Monat). */
    public static final String STARTWERT_PROZENT = "2";
    public static final String BEFUND = "abweichung_vergleichsquelle";
    public static final String MIT_MONATSVERGLEICH = "ja", OHNE_MONATSMENGE = "ohne_monatsmenge";
    /** Herleitungen, aus denen eine Monatsmenge entsteht (messstelle.md §5); ein Momentanwert hat keine. */
    private static final Set<String> MENGE = Set.of("zaehlerstand", "differenzen", "integration");
    private static final Pattern PROZENT = Pattern.compile("^[0-9]{1,3}(\\.[0-9]{1,2})?$");
    private static final int HOECHSTENS_MONATE = 24;

    private final MessstelleRepository messstellen;
    private final MessstelleQuelleRepository quellen;
    private final MessstelleWerteService werte;
    private final VergleichToleranzRepository toleranzen;
    private final AblesungRepository zonen;
    private final RechtPruefung rechte;
    private volatile Clock uhr = Clock.systemUTC();

    public VergleichToleranzService(MessstelleRepository messstellen, MessstelleQuelleRepository quellen,
            MessstelleWerteService werte, VergleichToleranzRepository toleranzen, AblesungRepository zonen,
            RechtPruefung rechte) {
        this.messstellen = messstellen;
        this.quellen = quellen;
        this.werte = werte;
        this.toleranzen = toleranzen;
        this.zonen = zonen;
        this.rechte = rechte;
    }

    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /**
     * Der Monatsvergleich {@code von}–{@code bis} (JJJJ-MM, beide eingeschlossen; ohne Angabe der letzte volle Monat
     * in der Zeitzone der Messstelle). Außerhalb des Zugriffs 404 wie an jeder Messstellen-Route.
     */
    public Vergleich lesen(String kennzeichen, String von, String bis) {
        MessstelleRepository.Messstelle m = messstellen.findeNachKennzeichen(kennzeichen)
                .orElseThrow(VergleichToleranzService::messstelleFehlt);
        rechte.pruefenLesen(RechtZiel.MESSSTELLE, m.id(), VergleichToleranzService::messstelleFehlt);
        Instant jetzt = uhr.instant();
        ZoneId zone = zonen.zone(TenantContext.get(), m.id(), jetzt).id();
        YearMonth erster = monat("von", von, YearMonth.now(uhr.withZone(zone)).minusMonths(1));
        YearMonth letzter = monat("bis", bis, von == null ? erster : null);
        if (letzter.isBefore(erster) || erster.plusMonths(HOECHSTENS_MONATE - 1).isBefore(letzter)) {
            throw MessmittelAbgelehnt.anfrage("bis", "Bitte wählen Sie höchstens " + HOECHSTENS_MONATE
                    + " ganze Monate, „bis“ nicht vor „von“.");
        }
        MessstelleRegeln.Groesse haupt = m.hauptgroesse();
        List<MessstelleQuelleRepository.Quelle> vergleiche = quellen.derMessstelle(m.id()).stream()
                .filter(q -> "vergleich".equals(q.rolle())).toList();
        List<Vergleichsquelle> aus = new ArrayList<>();
        List<Befund> befunde = new ArrayList<>();
        // Ohne Vergleichsquelle wird nichts gelesen: Bestandskunden merken nichts.
        List<MessstelleWerteDto.Wert> monate = vergleiche.isEmpty() ? List.of()
                : werte.werte(kennzeichen, "monat", erster.atDay(1).toString(), letzter.atEndOfMonth().toString(), null)
                        .werte();
        for (var q : vergleiche) {
            List<Toleranz> fassungen = fassungen(q, zone);
            boolean mitMenge = q.groesse().equals(haupt.groesse()) && q.richtung().equals(haupt.richtung())
                    && MENGE.contains(q.herleitung()) && q.anteil() == null;
            List<Monat> zeilen = new ArrayList<>();
            for (var w : mitMenge ? monate : List.<MessstelleWerteDto.Wert>of()) {
                Instant beginn = OffsetDateTime.parse(w.von()).toInstant();
                Instant ende = OffsetDateTime.parse(w.bis()).toInstant();
                if (!q.gueltigAb().isBefore(ende) || (q.gueltigBis() != null && !q.gueltigBis().isAfter(beginn))) {
                    continue; // die Vergleichsquelle berührt diesen Monat nicht
                }
                YearMonth monat = YearMonth.from(OffsetDateTime.parse(w.von()).toLocalDate());
                boolean ganz = !q.gueltigAb().isAfter(beginn) && (q.gueltigBis() == null || !q.gueltigBis().isBefore(ende));
                var gelesen = toleranzen.monat(TenantContext.get(), q.entityId(), q.kanal(), monat.atDay(1));
                String vergleich = gelesen.map(z -> text("integration".equals(q.herleitung()) ? z.energie() : z.menge()))
                        .orElse(null);
                String vergleichZustand = gelesen.map(VergleichToleranzRepository.Monat::mengeZustand).orElse(null);
                Toleranz t = wirksam(fassungen, monat);
                Map<String, Object> r = BewertungRegeln.monatsvergleich(
                        new BewertungRegeln.MonatsSeite(text(w.menge()), w.zustand()),
                        new BewertungRegeln.MonatsSeite(vergleich, vergleichZustand), ganz, t.prozent());
                Boolean befund = (Boolean) r.get("befund");
                zeilen.add(new Monat(monat.toString(), text(w.menge()), w.zustand(), vergleich, vergleichZustand,
                        (String) r.get("zustand"), (String) r.get("grund"), (String) r.get("abweichung_prozent"),
                        t.prozent(), t.fassung(), befund));
                if (Boolean.TRUE.equals(befund)) {
                    befunde.add(new Befund(BEFUND, q.id(), monat.toString(), (String) r.get("abweichung_prozent"),
                            t.prozent(), t.fassung()));
                }
            }
            aus.add(new Vergleichsquelle(q.id(), q.entityId(), q.komponenteName(), q.kanal(), q.zweck(), q.groesse(),
                    q.richtung(), q.herleitung(), q.gueltigAb(), q.gueltigBis(),
                    mitMenge ? MIT_MONATSVERGLEICH : OHNE_MONATSMENGE,
                    wirksam(fassungen, YearMonth.now(uhr.withZone(zone))), fassungen, List.copyOf(zeilen)));
        }
        return new Vergleich(m.id(), m.kennzeichen(), erster.toString(), letzter.toString(), haupt.einheit(),
                List.copyOf(aus), List.copyOf(befunde));
    }

    /**
     * Eine neue Fassung n + 1 mit Begründung (E10: „änderbar mit Begründung“), gültig ab dem laufenden Monat — nie
     * rückwirkend. Dieselbe Toleranz wie die wirksame schreibt nichts.
     */
    /** Das Ergebnis eines Eintrags: die wirksame Fassung und ob sie neu geschrieben wurde. */
    public record Ergebnis(Toleranz toleranz, boolean geschrieben) {}

    @Transactional
    public Ergebnis eintragen(UUID messstelleId, UUID quelleId, VergleichToleranzDto.Eintrag in,
            ProtokollAkteur akteur) {
        if (in == null) {
            throw MessmittelAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        MessstelleQuelleRepository.Quelle q = quellen.derMessstelle(messstelleId).stream()
                .filter(x -> x.id().equals(quelleId)).findFirst()
                .orElseThrow(() -> new MessmittelAbgelehnt(404, "nicht_gefunden", "quelle_id",
                        "Vergleichsquelle nicht gefunden."));
        if (!"vergleich".equals(q.rolle())) {
            throw MessmittelAbgelehnt.angabe("keine_vergleichsquelle", "quelle_id",
                    "Eine Toleranz steht nur an einer Vergleichsquelle.");
        }
        BigDecimal prozent = prozent(in.prozent());
        String begruendung = in.begruendung() == null ? "" : in.begruendung().strip();
        if (begruendung.isEmpty()) {
            throw MessmittelAbgelehnt.angabe("begruendung_fehlt", "begruendung",
                    "Bitte begründen Sie die neue Toleranz.");
        }
        if (begruendung.length() > 500) {
            throw MessmittelAbgelehnt.angabe("text_zu_lang", "begruendung", "Höchstens 500 Zeichen.");
        }
        Instant jetzt = uhr.instant();
        ZoneId zone = zonen.zone(TenantContext.get(), messstelleId, jetzt).id();
        YearMonth ab = YearMonth.now(uhr.withZone(zone));
        YearMonth beginn = YearMonth.from(q.gueltigAb().atZone(zone));
        if (beginn.isAfter(ab)) {
            ab = beginn;
        }
        List<Toleranz> fassungen = fassungen(q, zone);
        Toleranz wirksam = wirksam(fassungen, ab);
        if (new BigDecimal(wirksam.prozent()).compareTo(prozent) == 0) {
            return new Ergebnis(wirksam, false);
        }
        var f = toleranzen.eintragen(TenantContext.get(), q.id(), toleranzen.naechsteFassung(q.id()), prozent,
                ab.atDay(1), begruendung, akteur, jetzt);
        return new Ergebnis(toleranz(f), true);
    }

    /** Fassung 1 (Startwert, ab dem Monat des Beginns) und alle gespeicherten, älteste zuerst. */
    private List<Toleranz> fassungen(MessstelleQuelleRepository.Quelle q, ZoneId zone) {
        List<Toleranz> aus = new ArrayList<>();
        aus.add(new Toleranz(1, STARTWERT_PROZENT, true, YearMonth.from(q.gueltigAb().atZone(zone)).atDay(1),
                null, null, null));
        toleranzen.derQuelle(q.id()).forEach(f -> aus.add(toleranz(f)));
        return List.copyOf(aus);
    }

    /** Die Fassung eines Monats: die höchste, die ab ihm oder früher gilt — sonst der Startwert. */
    static Toleranz wirksam(List<Toleranz> fassungen, YearMonth monat) {
        Toleranz aus = fassungen.get(0);
        for (Toleranz t : fassungen) {
            if (t.fassung() > aus.fassung() && !YearMonth.from(t.giltAbMonat()).isAfter(monat)) {
                aus = t;
            }
        }
        return aus;
    }

    private static Toleranz toleranz(VergleichToleranzRepository.Fassung f) {
        return new Toleranz(f.fassung(), text(f.prozent()), false, f.giltAbMonat(), f.begruendung(), f.akteur(),
                f.eingetragenAm());
    }

    private static BigDecimal prozent(String text) {
        if (text == null || !PROZENT.matcher(text).matches()) {
            throw MessmittelAbgelehnt.angabe("toleranz_ungueltig", "prozent",
                    "Die Toleranz ist eine Zahl in Prozent mit höchstens zwei Nachkommastellen, etwa „2“ oder „0.5“.");
        }
        BigDecimal p = new BigDecimal(text);
        if (p.signum() <= 0 || p.compareTo(BigDecimal.valueOf(100)) > 0) {
            throw MessmittelAbgelehnt.angabe("toleranz_ungueltig", "prozent",
                    "Die Toleranz liegt über 0 und höchstens bei 100 %.");
        }
        return p;
    }

    private static YearMonth monat(String feld, String text, YearMonth vorgabe) {
        if (text == null) {
            if (vorgabe == null) {
                throw MessmittelAbgelehnt.anfrage(feld, "„von“ und „bis“ gehören zusammen (JJJJ-MM).");
            }
            return vorgabe;
        }
        try {
            return YearMonth.parse(text);
        } catch (DateTimeParseException e) {
            throw MessmittelAbgelehnt.anfrage(feld, "Ein Monat ist JJJJ-MM.");
        }
    }

    private static String text(BigDecimal n) {
        return n == null ? null : n.stripTrailingZeros().toPlainString();
    }

    static MessmittelAbgelehnt messstelleFehlt() {
        return new MessmittelAbgelehnt(404, "nicht_gefunden", "", "Messstelle nicht gefunden.");
    }
}
