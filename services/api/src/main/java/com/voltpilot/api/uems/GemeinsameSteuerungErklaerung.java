package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.command.CommandLogReader;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.measurement.SummenwertQuellenService;
import com.voltpilot.api.uems.SteuerungsverbundAnteilRepository.GeraetZeile;
import com.voltpilot.api.uems.SteuerungsverbundRepository.MitgliedZeile;
import com.voltpilot.api.uems.SteuerungsverbundRepository.VerbundZeile;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import com.voltpilot.api.web.dto.GemeinsameSteuerungEinrichtenDto;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Die ERKLÄRUNG der Gemeinsamen Steuerung über die Kundenroute (UEMS AP-15, Konzept §5.2 „Einrichten in sechs
 * Fragen“, B3/B4, G3, I1; Vertrag {@code docs/contracts/v2/steuerungsverbund.md} §6a) — und was der Bestand dafür
 * vorschlägt. {@link GemeinsameSteuerungService#einrichten} ruft {@link #erklaeren} in seiner Transaktion; jede
 * Änderung ist eine Strukturänderung (I3: Stufe zurück, Protokoll).
 *
 * <p><b>Geräte je Box</b> ({@code steuerungsverbund_geraet}, IP-7): der Kunde erklärt Komponente, Richtung und
 * Nennleistung; die Schreibfreigabe kommt aus dem Bestand — die Box, die die Komponente liest
 * ({@link SummenwertQuellenService#sources}, dieselbe Regel wie der Push je Box), schreibt an sie
 * ({@link CommandLogReader#writesTo}). Vollständig heißt: jede Komponente mit Schreibfreigabe an einer Mitglieds-Box
 * steht in der Erklärung dieser Box — sonst 422 mit ihrer Kennung (eine unvollständige Gerätetabelle hieße sonst still
 * „keine steuerbaren Verbraucher“, G6). Eine erklärte Komponente ohne Schreibfreigabe zählt als ungeregelt mit
 * Nennleistung (I1). Aufheben statt ändern.
 *
 * <p><b>Ungesteuerte Erzeuger</b> (Frage 4): Pflichtangabe „keine“ oder Liste; ihre Summe ist der Vorbehalt der
 * Einspeiseseite. <b>Vorbehalt der Bezugsseite</b> (B4): der Kunde ERKLÄRT ihn. Trägt eine Messung den geltenden Wert
 * (Herkunft {@code gemessen}, IP-13), gewinnt sie: ein kleinerer erklärter Wert ist 409 {@code vorbehalt_gemessen} —
 * senken bleibt Vorschlag mit Freigabe des Betreibers; ein größerer gilt ab sofort als erklärt (verengen geht immer).
 */
@Service
public class GemeinsameSteuerungErklaerung {

    public static final String KEINE = "keine";
    static final String ART_GERAETE = "geraete";
    static final String ART_ERZEUGER = "erzeuger";

    /** Die Hinweis-Wörter von {@code GET …/einrichten}. */
    public static final String NENNLEISTUNG_WEICHT_AB = "nennleistung_weicht_ab";
    public static final String OHNE_SCHREIBFREIGABE = "ohne_schreibfreigabe";
    public static final String GERAETE_NICHT_ERKLAERT = "geraete_nicht_erklaert";
    public static final String GERAET_NICHT_ERKLAERT = "geraet_nicht_erklaert";
    public static final String ERZEUGER_NICHT_ERKLAERT = "erzeuger_nicht_erklaert";
    public static final String VORBEHALT_NICHT_ERKLAERT = "vorbehalt_nicht_erklaert";
    public static final String NETZZAEHLER_NICHT_GELESEN = "netzzaehler_nicht_gelesen";
    public static final List<String> HINWEISE = List.of(NENNLEISTUNG_WEICHT_AB, OHNE_SCHREIBFREIGABE,
            GERAETE_NICHT_ERKLAERT, GERAET_NICHT_ERKLAERT, ERZEUGER_NICHT_ERKLAERT, VORBEHALT_NICHT_ERKLAERT,
            NETZZAEHLER_NICHT_GELESEN);

    /** Die Lücken-Wörter von 422 {@code erklaerung_unvollstaendig}. */
    public static final String LUECKE_GERAETE = "geraete";
    public static final String LUECKE_KOMPONENTE = "komponente";
    public static final String LUECKE_ERZEUGER = "ungesteuerte_erzeuger";
    public static final List<String> LUECKEN = List.of(LUECKE_GERAETE, LUECKE_KOMPONENTE, LUECKE_ERZEUGER);

    private static final String GRID_METER = "grid-meter";
    private static final Set<String> ERZEUGER_TYPEN = Set.of("producer");
    private static final Set<String> SPEICHER_TYPEN = Set.of("battery-hybrid", "user-defined-battery");
    private static final Set<String> VERBRAUCHER_TYPEN = Set.of("wallbox", "ev-charger", "heating-rod",
            "heat-pump-sgready", "pump", "generic-load", "modbus-load");
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Ein erklärtes Gerät: Komponente, Richtung, Nennleistung (> 0). */
    public record Geraet(UUID komponente, Grenzart richtung, BigDecimal nennKw) {}

    /** Das Ungeregelte hinter dem Abgang einer Box (B3) in einer Richtung. */
    public record Ungeregelt(Grenzart richtung, BigDecimal hoechstwertKw) {}

    /** Die Erklärung einer Box: ihre Geräte (vollständig) und wahlfrei das Ungeregelte hinter ihrem Abgang. */
    public record BoxErklaerung(List<Geraet> geraete, List<Ungeregelt> ungeregelt) {}

    /** Ein ungesteuerter Erzeuger (Frage 4). */
    public record Erzeuger(String bezeichnung, BigDecimal nennKw) {}

    /**
     * Die Erklärung aus {@code PUT}: je Box ({@code null} = für die Box nichts erklärt), die Erzeuger ({@code null} =
     * fehlt, leer = „keine“) und wahlfrei der Vorbehalt der Bezugsseite ({@code null} = unverändert).
     */
    public record Wunsch(Map<UUID, BoxErklaerung> jeBox, List<Erzeuger> erzeuger, BigDecimal vorbehaltBezugKw) {}

    /** Eine Komponente im Bestand: welche Box sie liest, ob die Box an sie schreibt, die Richtungen nach Typ. */
    record BestandKomponente(UUID id, String name, String typ, UUID box, boolean schreibfreigabe,
            List<Grenzart> richtungen, BigDecimal nennKw) {}

    private final SteuerungsverbundRepository verbuende;
    private final SteuerungsverbundAnteilRepository anteile;
    private final SteuerungsverbundErklaerungRepository erklaerungen;
    private final SteuerungsverbundAnteilDienst ableitung;
    private final GeraeteRueckfallDienst rueckfaelle;
    private final VorbehaltRepository vorbehaltZeilen;
    private final EntityRegistryRepository registry;
    private final SummenwertQuellenService quellen;
    private final AnlageGrenzen grenzen;
    private Clock uhr = Clock.systemUTC();

    public GemeinsameSteuerungErklaerung(SteuerungsverbundRepository verbuende,
            SteuerungsverbundAnteilRepository anteile, SteuerungsverbundErklaerungRepository erklaerungen,
            SteuerungsverbundAnteilDienst ableitung, GeraeteRueckfallDienst rueckfaelle,
            VorbehaltRepository vorbehaltZeilen, EntityRegistryRepository registry, SummenwertQuellenService quellen,
            AnlageGrenzen grenzen) {
        this.verbuende = verbuende;
        this.anteile = anteile;
        this.erklaerungen = erklaerungen;
        this.ableitung = ableitung;
        this.rueckfaelle = rueckfaelle;
        this.vorbehaltZeilen = vorbehaltZeilen;
        this.registry = registry;
        this.quellen = quellen;
        this.grenzen = grenzen;
    }

    void uhrStellen(Clock clock) {
        uhr = clock;
    }

    // ------------------------------------------------------------------ erklären (in der Transaktion von PUT)

    /**
     * Prüft und schreibt die Erklärung für die wirksamen Mitglieder {@code boxen}. Wirft, bevor etwas geschrieben ist:
     * 422 {@code erklaerung_unvollstaendig} (je Lücke die Kennung), 400 für eine Angabe, die es so nicht gibt, 409
     * {@code vorbehalt_gemessen}. Liefert, ob sich etwas geändert hat (dann je Teil ein Protokoll-Eintrag).
     */
    boolean erklaeren(UUID tenant, UUID verbundId, UUID siteId, List<UUID> boxen, Wunsch w, Instant jetzt,
            ProtokollAkteur wer) {
        Map<UUID, BestandKomponente> bestand = bestand(siteId);
        pruefen(siteId, boxen, w, bestand);
        BigDecimal bezugNeu = w.vorbehaltBezugKw();
        SteuerungsverbundAnteilRepository.Vorbehalt vb = anteile.vorbehalt(verbundId);
        BigDecimal bezugAlt = vb.kw().get(Grenzart.BEZUG);
        boolean bezugAendert = bezugNeu != null && (bezugAlt == null || bezugNeu.compareTo(bezugAlt) != 0);
        String herkunftAlt = bezugAlt != null && vorbehaltZeilen.herkunftGemessen(verbundId).isPresent()
                ? GemeinsameSteuerungService.HERKUNFT_GEMESSEN : GemeinsameSteuerungService.HERKUNFT_ERKLAERT;
        if (bezugAendert && bezugAlt != null && bezugNeu.compareTo(bezugAlt) < 0
                && GemeinsameSteuerungService.HERKUNFT_GEMESSEN.equals(herkunftAlt)) {
            throw GemeinsameSteuerungAbgelehnt.uebergang(GemeinsameSteuerungAbgelehnt.VORBEHALT_GEMESSEN,
                    "Der Vorbehalt ist aus Messwerten bestimmt (" + bezugAlt.stripTrailingZeros().toPlainString()
                            + " kW). Senken ist ein Vorschlag, den VoltPilot prüft und freigibt.");
        }
        boolean geaendert = false;
        Map<UUID, List<GeraetZeile>> ist = jeBox(anteile.geraete(verbundId));
        for (UUID box : boxen) {
            BoxErklaerung soll = w.jeBox().get(box);
            if (soll != null && geraeteSchreiben(tenant, verbundId, siteId, box, soll, ist.getOrDefault(box, List.of()),
                    bestand, jetzt, wer)) {
                geaendert = true;
            }
        }
        if (erzeugerSchreiben(tenant, verbundId, siteId, w.erzeuger(), vb.kw().get(Grenzart.EINSPEISUNG), jetzt,
                wer)) {
            geaendert = true;
        }
        if (bezugAendert) {
            BigDecimal einspeisung = anteile.vorbehalt(verbundId).kw().get(Grenzart.EINSPEISUNG);
            anteile.vorbehaltSetzen(verbundId, einspeisung, bezugNeu, wer.name());
            verbuende.protokoll(tenant, verbundId, siteId, VorbehaltDienst.ART, vorbehaltJson(bezugAlt, herkunftAlt),
                    vorbehaltJson(bezugNeu, GemeinsameSteuerungService.HERKUNFT_ERKLAERT), jetzt, false, null, wer);
            geaendert = true;
        }
        return geaendert;
    }

    private void pruefen(UUID siteId, List<UUID> boxen, Wunsch w, Map<UUID, BestandKomponente> bestand) {
        for (UUID box : w.jeBox().keySet()) {
            if (!boxen.contains(box)) {
                throw GemeinsameSteuerungAbgelehnt.anfrage("Geräte werden nur für ein Mitglied erklärt.");
            }
        }
        List<GemeinsameSteuerungEinrichtenDto.Luecke> luecken = new ArrayList<>();
        for (UUID box : boxen) {
            BoxErklaerung e = w.jeBox().get(box);
            if (e == null) {
                luecken.add(new GemeinsameSteuerungEinrichtenDto.Luecke(LUECKE_GERAETE, box, null));
                continue;
            }
            Set<String> doppelt = new HashSet<>();
            Set<UUID> erklaert = new HashSet<>();
            for (Geraet g : e.geraete()) {
                BestandKomponente k = bestand.get(g.komponente());
                if (k == null) {
                    throw GemeinsameSteuerungAbgelehnt.anfrage("Die Komponente " + g.komponente()
                            + " gehört nicht zu dieser Anlage.");
                }
                if (g.nennKw() == null || g.nennKw().signum() <= 0) {
                    throw GemeinsameSteuerungAbgelehnt.anfrage("Die Nennleistung ist größer als 0 kW.");
                }
                if (!doppelt.add(g.komponente() + "|" + g.richtung().code())) {
                    throw GemeinsameSteuerungAbgelehnt.anfrage("Eine Komponente steht je Richtung einmal.");
                }
                erklaert.add(g.komponente());
            }
            Set<Grenzart> ungeregelt = new HashSet<>();
            for (Ungeregelt u : e.ungeregelt()) {
                if (u.hoechstwertKw() == null || u.hoechstwertKw().signum() <= 0) {
                    throw GemeinsameSteuerungAbgelehnt.anfrage("Der Höchstwert des Ungeregelten ist größer als 0 kW.");
                }
                if (!ungeregelt.add(u.richtung())) {
                    throw GemeinsameSteuerungAbgelehnt.anfrage("Das Ungeregelte steht je Richtung einmal.");
                }
            }
            bestand.values().stream()
                    .filter(k -> k.schreibfreigabe() && box.equals(k.box()) && !erklaert.contains(k.id()))
                    .forEach(k -> luecken.add(new GemeinsameSteuerungEinrichtenDto.Luecke(LUECKE_KOMPONENTE, box,
                            k.id())));
        }
        if (w.erzeuger() == null) {
            luecken.add(new GemeinsameSteuerungEinrichtenDto.Luecke(LUECKE_ERZEUGER, null, null));
        } else {
            for (Erzeuger e : w.erzeuger()) {
                if (e.bezeichnung() == null || e.bezeichnung().isBlank()) {
                    throw GemeinsameSteuerungAbgelehnt.anfrage("Jeder Erzeuger braucht eine Bezeichnung.");
                }
                if (e.nennKw() == null || e.nennKw().signum() <= 0) {
                    throw GemeinsameSteuerungAbgelehnt.anfrage("Die Nennleistung ist größer als 0 kW.");
                }
            }
        }
        if (w.vorbehaltBezugKw() != null && w.vorbehaltBezugKw().signum() < 0) {
            throw GemeinsameSteuerungAbgelehnt.anfrage("Der Vorbehalt ist nie negativ.");
        }
        if (!luecken.isEmpty()) {
            throw GemeinsameSteuerungAbgelehnt.unvollstaendig("Die Erklärung ist unvollständig: jede Box braucht alle "
                    + "Geräte, die sie steuern darf, und die ungesteuerten Erzeuger sind „keine“ oder eine Liste.",
                    luecken);
        }
    }

    /** Schreibt die Geräte einer Box neu, wenn sie sich ändern (aufheben statt ändern). */
    private boolean geraeteSchreiben(UUID tenant, UUID verbundId, UUID siteId, UUID box, BoxErklaerung soll,
            List<GeraetZeile> ist, Map<UUID, BestandKomponente> bestand, Instant jetzt, ProtokollAkteur wer) {
        List<Map<String, Object>> neu = new ArrayList<>();
        for (Geraet g : soll.geraete()) {
            BestandKomponente k = bestand.get(g.komponente());
            neu.add(zeile(g.komponente(), g.richtung(), g.nennKw(), k.schreibfreigabe() && box.equals(k.box())));
        }
        for (Ungeregelt u : soll.ungeregelt()) {
            neu.add(zeile(null, u.richtung(), u.hoechstwertKw(), false));
        }
        List<Map<String, Object>> alt = ist.stream()
                .map(z -> zeile(z.entityId(), z.richtung(), z.nennKw(), z.schreibfreigabe())).toList();
        if (sortiert(alt).equals(sortiert(neu))) {
            return false;
        }
        ist.forEach(z -> anteile.geraetAufheben(z.id()));
        for (Map<String, Object> z : neu) {
            anteile.geraetEintragen(tenant, verbundId, box, (UUID) z.get("komponente_id"),
                    Grenzart.valueOf(((String) z.get("richtung")).toUpperCase(java.util.Locale.ROOT)),
                    (BigDecimal) z.get("nenn_kw"), (Boolean) z.get("schreibfreigabe"), null, wer.name());
        }
        verbuende.protokoll(tenant, verbundId, siteId, ART_GERAETE, geraeteJson(box, alt), geraeteJson(box, neu),
                jetzt, false, null, wer);
        return true;
    }

    /** Schreibt die ungesteuerten Erzeuger und ihre Summe als Vorbehalt der Einspeiseseite, wenn sie sich ändern. */
    private boolean erzeugerSchreiben(UUID tenant, UUID verbundId, UUID siteId, List<Erzeuger> soll,
            BigDecimal einspeisungAlt, Instant jetzt, ProtokollAkteur wer) {
        List<SteuerungsverbundErklaerungRepository.ErzeugerZeile> ist = erklaerungen.erzeuger(verbundId, siteId);
        List<Erzeuger> alt = ist.stream().map(z -> new Erzeuger(z.bezeichnung(), z.nennKw())).toList();
        BigDecimal summe = soll.stream().map(Erzeuger::nennKw).reduce(BigDecimal.ZERO, BigDecimal::add);
        boolean gleich = einspeisungAlt != null && einspeisungAlt.compareTo(summe) == 0 && alt.size() == soll.size()
                && java.util.stream.IntStream.range(0, alt.size()).allMatch(i -> alt.get(i).bezeichnung()
                        .equals(soll.get(i).bezeichnung().strip())
                        && alt.get(i).nennKw().compareTo(soll.get(i).nennKw()) == 0);
        if (gleich) {
            return false;
        }
        erklaerungen.erzeugerAufheben(verbundId, siteId);
        soll.forEach(e -> erklaerungen.erzeugerEintragen(tenant, verbundId, e.bezeichnung().strip(), e.nennKw(),
                wer.name()));
        erklaerungen.vorbehaltEinspeisungSetzen(verbundId, summe, wer.name());
        verbuende.protokoll(tenant, verbundId, siteId, ART_ERZEUGER,
                einspeisungAlt == null ? null : erzeugerJson(alt), erzeugerJson(soll), jetzt, false, null, wer);
        return true;
    }

    // ------------------------------------------------------------------ lesen: GET …/einrichten

    /**
     * Der Vorschlag aus dem Bestand (Fragen 1–5), die Erklärung und das Ergebnis (Frage 6). Ohne Gemeinsame Steuerung
     * nur der Vorschlag — gelesen wird, geschrieben nie (I6). Die Anlage ist sichtbar (der Aufrufer prüft den Zaun).
     */
    @Transactional(readOnly = true)
    public GemeinsameSteuerungEinrichtenDto.Einrichten lesen(UUID siteId) {
        if (!verbuende.anlageSichtbar(siteId)) {
            throw GemeinsameSteuerungAbgelehnt.nichtGefunden();
        }
        Instant jetzt = uhr.instant();
        LocalDate heute = GemeinsameSteuerungService.tag(jetzt);
        Map<UUID, BestandKomponente> bestand = bestand(siteId);
        UUID netzzaehler = registry.pointIdByRole(siteId, GRID_METER);
        UUID netzBox = netzzaehler == null || bestand.get(netzzaehler) == null ? null : bestand.get(netzzaehler).box();
        GrenzeAufloesung.Grenzen anlage = verbuende.grenzenDerAnlage(siteId);
        GrenzeAufloesung.Wirksam wirksam = grenzen.wirksam(siteId, heute, anlage.einspeisungKw(), anlage.bezugKw());
        GemeinsameSteuerungEinrichtenDto.Grenzen g = new GemeinsameSteuerungEinrichtenDto.Grenzen(
                wirksam.einspeisungKw(), wirksam.bezugKw());
        List<GemeinsameSteuerungEinrichtenDto.Hinweis> hinweise = new ArrayList<>();
        if (netzBox == null) {
            hinweise.add(hinweis(NETZZAEHLER_NICHT_GELESEN, null, null, null, null, null));
        }
        Optional<VerbundZeile> verbund = verbuende.derAnlage(siteId);
        Map<UUID, MitgliedZeile> mitglieder = new LinkedHashMap<>();
        Map<UUID, List<GeraetZeile>> geraete = new HashMap<>();
        verbund.ifPresent(v -> {
            verbuende.mitglieder(v.id(), jetzt).forEach(m -> mitglieder.put(m.deviceId(), m));
            geraete.putAll(jeBox(anteile.geraete(v.id())));
        });
        List<GemeinsameSteuerungEinrichtenDto.Box> boxen = new ArrayList<>();
        erklaerungen.boxen(siteId).forEach((box, name) -> {
            MitgliedZeile m = mitglieder.get(box);
            List<GeraetZeile> erklaert = m == null ? List.of() : geraete.getOrDefault(box, List.of());
            List<GemeinsameSteuerungEinrichtenDto.Komponente> komponenten = bestand.values().stream()
                    .filter(k -> box.equals(k.box())).map(k -> new GemeinsameSteuerungEinrichtenDto.Komponente(k.id(),
                            k.name(), k.typ(), k.schreibfreigabe(), k.richtungen().stream().map(Grenzart::code).toList(),
                            k.nennKw()))
                    .toList();
            boxen.add(new GemeinsameSteuerungEinrichtenDto.Box(box, name, m == null ? null : m.rolle().code(),
                    m == null ? null : m.dataSourceId(), box.equals(netzBox), komponenten, !erklaert.isEmpty(),
                    erklaert.stream().filter(z -> z.entityId() != null).map(this::geraet).toList(),
                    erklaert.stream().filter(z -> z.entityId() == null).map(z ->
                            new GemeinsameSteuerungEinrichtenDto.Ungeregelt(z.richtung().code(), z.nennKw())).toList()));
            if (m != null) {
                hinweiseDerBox(box, erklaert, bestand, hinweise);
            }
        });
        if (verbund.isEmpty()) {
            return new GemeinsameSteuerungEinrichtenDto.Einrichten(false, netzBox, g, boxen, null, null, null,
                    hinweise);
        }
        VerbundZeile v = verbund.get();
        SteuerungsverbundAnteilRepository.Vorbehalt vb = anteile.vorbehalt(v.id());
        Object erzeuger = null;
        if (vb.kw().get(Grenzart.EINSPEISUNG) != null) {
            List<GemeinsameSteuerungEinrichtenDto.Erzeuger> liste = erklaerungen.erzeuger(v.id(), siteId).stream()
                    .map(z -> new GemeinsameSteuerungEinrichtenDto.Erzeuger(z.bezeichnung(), z.nennKw())).toList();
            erzeuger = liste.isEmpty() ? KEINE : liste;
        } else {
            hinweise.add(hinweis(ERZEUGER_NICHT_ERKLAERT, null, null, null, null, null));
        }
        if (vb.kw().get(Grenzart.BEZUG) == null) {
            hinweise.add(hinweis(VORBEHALT_NICHT_ERKLAERT, null, null, Grenzart.BEZUG.code(), null, null));
        }
        VorbehaltRegel.Urteil messung = VorbehaltRegel.pruefen(null,
                vorbehaltZeilen.tage(v.id(), VorbehaltRegel.zeitraumVon(heute), heute.minusDays(1)), heute);
        GemeinsameSteuerungEinrichtenDto.AusMesswerten aus = messung.neuKw() == null ? null
                : new GemeinsameSteuerungEinrichtenDto.AusMesswerten(messung.neuKw(), messung.hoechstwertKw(),
                        messung.hoechstwertVon() == null ? null : messung.hoechstwertVon().atOffset(ZoneOffset.UTC),
                        messung.messtage(), messung.zeitraumVon(), messung.zeitraumBis());
        GemeinsameSteuerungEinrichtenDto.Vorbehalt vorbehalt = new GemeinsameSteuerungEinrichtenDto.Vorbehalt(
                vb.kw().get(Grenzart.EINSPEISUNG), vb.kw().get(Grenzart.BEZUG),
                vb.kw().get(Grenzart.BEZUG) == null ? null
                        : vorbehaltZeilen.herkunftGemessen(v.id()).isPresent()
                                ? GemeinsameSteuerungService.HERKUNFT_GEMESSEN
                                : GemeinsameSteuerungService.HERKUNFT_ERKLAERT,
                vb.von(), vb.am() == null ? null : vb.am().atOffset(ZoneOffset.UTC), aus);
        return new GemeinsameSteuerungEinrichtenDto.Einrichten(true, netzBox, g, boxen, erzeuger, vorbehalt,
                ergebnis(siteId), hinweise);
    }

    /** Frage 6: die Auslegung je Richtung aus {@link SteuerungsverbundAnteilDienst#ableiten} (NW-1). */
    private GemeinsameSteuerungEinrichtenDto.Ergebnis ergebnis(UUID siteId) {
        return ableitung.ableiten(siteId).map(a -> new GemeinsameSteuerungEinrichtenDto.Ergebnis(
                auslegung(a, Grenzart.EINSPEISUNG), auslegung(a, Grenzart.BEZUG))).orElse(null);
    }

    private static GemeinsameSteuerungEinrichtenDto.Auslegung auslegung(SteuerungsverbundAnteilDienst.Ableitung a,
            Grenzart richtung) {
        SteuerungsverbundAnteile.Auslegung x = a.auslegung().get(richtung);
        SteuerungsverbundRegeln.Richtung e = a.eingaenge().get(richtung);
        if (x == null || e == null) {
            return null;
        }
        List<GemeinsameSteuerungEinrichtenDto.Anteil> anteile = new ArrayList<>();
        x.anteile().forEach((box, kw) -> anteile.add(new GemeinsameSteuerungEinrichtenDto.Anteil(UUID.fromString(box),
                kw)));
        return new GemeinsameSteuerungEinrichtenDto.Auslegung(x.urteil().code(), e.grenzeKw(), e.vorbehaltKw(),
                x.verteilbarKw(), x.summeRueckfallKw(), anteile, x.ungenutztKw());
    }

    private GemeinsameSteuerungEinrichtenDto.Geraet geraet(GeraetZeile z) {
        if (!z.schreibfreigabe()) {
            return new GemeinsameSteuerungEinrichtenDto.Geraet(z.entityId(), z.richtung().code(), z.nennKw(), false,
                    null, null, null);
        }
        GeraeteRueckfallRegel.Rueckfall r = rueckfaelle.rueckfall(z.entityId(), z.richtung(), z.nennKw());
        return new GemeinsameSteuerungEinrichtenDto.Geraet(z.entityId(), z.richtung().code(), z.nennKw(), true,
                r.rueckfall().code(), r.kw(), r.herkunft().code());
    }

    private static void hinweiseDerBox(UUID box, List<GeraetZeile> erklaert, Map<UUID, BestandKomponente> bestand,
            List<GemeinsameSteuerungEinrichtenDto.Hinweis> hinweise) {
        if (erklaert.isEmpty()) {
            hinweise.add(hinweis(GERAETE_NICHT_ERKLAERT, box, null, null, null, null));
            return;
        }
        Set<UUID> da = new HashSet<>();
        for (GeraetZeile z : erklaert) {
            if (z.entityId() == null) {
                continue;
            }
            da.add(z.entityId());
            BestandKomponente k = bestand.get(z.entityId());
            if (!z.schreibfreigabe()) {
                hinweise.add(hinweis(OHNE_SCHREIBFREIGABE, box, z.entityId(), z.richtung().code(), null, z.nennKw()));
            }
            if (k != null && k.nennKw() != null && k.richtungen().size() == 1 && k.richtungen().get(0) == z.richtung()
                    && k.nennKw().compareTo(z.nennKw()) != 0) {
                hinweise.add(hinweis(NENNLEISTUNG_WEICHT_AB, box, z.entityId(), z.richtung().code(), k.nennKw(),
                        z.nennKw()));
            }
        }
        bestand.values().stream().filter(k -> k.schreibfreigabe() && box.equals(k.box()) && !da.contains(k.id()))
                .forEach(k -> hinweise.add(hinweis(GERAET_NICHT_ERKLAERT, box, k.id(), null, null, null)));
    }

    // ------------------------------------------------------------------ Rückfall am Gerät (IP-6, Folgepunkt PR 1026)

    /** Der Verlauf der Rückfall-Angaben einer Komponente der Anlage, neueste zuerst; eine fremde ist 404. */
    @Transactional(readOnly = true)
    public List<GemeinsameSteuerungEinrichtenDto.RueckfallAngabe> rueckfallVerlauf(UUID siteId, UUID komponente) {
        komponenteDerAnlage(siteId, komponente);
        return rueckfaelle.verlauf(komponente).stream().map(GemeinsameSteuerungErklaerung::angabe).toList();
    }

    /**
     * Hinterlegt, was am Gerät eingestellt ist (wer/wann, aufheben statt ändern; dieselbe Angabe noch einmal schreibt
     * nichts) und liefert den Verlauf. 400 für eine Angabe, die es so nicht gibt ({@code faellt_auf_wert} ohne kW, kW
     * bei einem anderen Wort, negativ).
     */
    @Transactional
    public List<GemeinsameSteuerungEinrichtenDto.RueckfallAngabe> rueckfallHinterlegen(UUID siteId, UUID komponente,
            Grenzart richtung, SteuerungsverbundVokabular.GeraeteRueckfall rueckfall, BigDecimal kw, Integer nachS,
            String hinweis, ProtokollAkteur wer) {
        komponenteDerAnlage(siteId, komponente);
        GeraeteRueckfallRegel.Angabe angabe;
        try {
            angabe = new GeraeteRueckfallRegel.Angabe(rueckfall, kw, nachS);
        } catch (IllegalArgumentException e) {
            throw GemeinsameSteuerungAbgelehnt.anfrage("Eine Zahl in kW gibt es nur bei „faellt_auf_wert“, nie "
                    + "negativ; nach_s ist nie negativ.");
        }
        if (rueckfall == SteuerungsverbundVokabular.GeraeteRueckfall.FAELLT_AUF_WERT && kw == null) {
            throw GemeinsameSteuerungAbgelehnt.anfrage("„faellt_auf_wert“ braucht den Wert in kW.");
        }
        rueckfaelle.hinterlegen(komponente, richtung, angabe, hinweis, wer.name());
        return rueckfaelle.verlauf(komponente).stream().map(GemeinsameSteuerungErklaerung::angabe).toList();
    }

    private void komponenteDerAnlage(UUID siteId, UUID komponente) {
        if (!verbuende.anlageSichtbar(siteId) || !erklaerungen.komponenteDerAnlage(siteId, komponente)) {
            throw GemeinsameSteuerungAbgelehnt.nichtGefunden();
        }
    }

    private static GemeinsameSteuerungEinrichtenDto.RueckfallAngabe angabe(GeraeteRueckfallRepository.Zeile z) {
        return new GemeinsameSteuerungEinrichtenDto.RueckfallAngabe(z.id(), z.richtung(), z.rueckfall().code(),
                z.rueckfallKw(), z.nachS(), z.hinweis(), z.eingetragenVon(),
                z.eingetragenAm() == null ? null : z.eingetragenAm().atOffset(ZoneOffset.UTC),
                z.aufgehobenAm() == null ? null : z.aufgehobenAm().atOffset(ZoneOffset.UTC));
    }

    // ------------------------------------------------------------------ Bestand

    /**
     * Die Komponenten der Anlage: welche Box sie liest (Regel des Push je Box), ob die Box an sie schreibt (die EINE
     * Regel {@link CommandLogReader#writesTo}), die Richtungen nach Typ und die Nennleistung, soweit bekannt — PV
     * über {@code capacity_kwp}, Verbraucher über ihr Profil; ein Speicher hat keine (IP-7).
     */
    Map<UUID, BestandKomponente> bestand(UUID siteId) {
        Map<UUID, UUID> boxDerKomponente = new HashMap<>();
        quellen.sources(siteId).forEach(q -> {
            if (q.deviceId() != null) {
                boxDerKomponente.put(q.entityId(), q.deviceId());
            }
        });
        Map<UUID, BigDecimal> verbraucher = erklaerungen.nennleistungVerbraucher(siteId);
        Map<UUID, BestandKomponente> out = new LinkedHashMap<>();
        for (EntityRegistryRepository.EntityRow r : registry.entitiesForSite(siteId)) {
            List<Grenzart> richtungen = richtungen(r.entityType());
            BigDecimal nenn = richtungen.contains(Grenzart.BEZUG) && !richtungen.contains(Grenzart.EINSPEISUNG)
                    ? verbraucher.get(r.id()) : r.capacityKwp();
            out.put(r.id(), new BestandKomponente(r.id(), r.label(), r.entityType(), boxDerKomponente.get(r.id()),
                    CommandLogReader.writesTo(r.control(), r.capabilitiesJson()), richtungen, nenn));
        }
        return out;
    }

    static List<Grenzart> richtungen(String typ) {
        if (typ == null) {
            return List.of();
        }
        if (ERZEUGER_TYPEN.contains(typ)) {
            return List.of(Grenzart.EINSPEISUNG);
        }
        if (SPEICHER_TYPEN.contains(typ)) {
            return List.of(Grenzart.EINSPEISUNG, Grenzart.BEZUG);
        }
        if (VERBRAUCHER_TYPEN.contains(typ)) {
            return List.of(Grenzart.BEZUG);
        }
        return List.of();
    }

    // ------------------------------------------------------------------ Gerüst

    private static Map<UUID, List<GeraetZeile>> jeBox(List<GeraetZeile> zeilen) {
        Map<UUID, List<GeraetZeile>> out = new LinkedHashMap<>();
        zeilen.forEach(z -> out.computeIfAbsent(z.deviceId(), k -> new ArrayList<>()).add(z));
        return out;
    }

    private static Map<String, Object> zeile(UUID komponente, Grenzart richtung, BigDecimal nennKw,
            boolean schreibfreigabe) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("komponente_id", komponente);
        m.put("richtung", richtung.code());
        m.put("nenn_kw", nennKw.stripTrailingZeros());
        m.put("schreibfreigabe", schreibfreigabe);
        return m;
    }

    private static List<Map<String, Object>> sortiert(List<Map<String, Object>> zeilen) {
        return zeilen.stream().sorted(Comparator.comparing((Map<String, Object> m) -> String.valueOf(
                m.get("komponente_id"))).thenComparing(m -> (String) m.get("richtung"))).toList();
    }

    private static GemeinsameSteuerungEinrichtenDto.Hinweis hinweis(String wort, UUID box, UUID komponente,
            String richtung, BigDecimal bestandKw, BigDecimal erklaertKw) {
        return new GemeinsameSteuerungEinrichtenDto.Hinweis(wort, box, komponente, richtung, bestandKw, erklaertKw);
    }

    private static String geraeteJson(UUID box, List<Map<String, Object>> zeilen) {
        if (zeilen.isEmpty()) {
            return null;
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("box_id", box);
        m.put("geraete", sortiert(zeilen));
        return json(m);
    }

    private static String erzeugerJson(List<Erzeuger> erzeuger) {
        if (erzeuger.isEmpty()) {
            return json(KEINE);
        }
        return json(erzeuger.stream().map(e -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("bezeichnung", e.bezeichnung().strip());
            m.put("nenn_kw", e.nennKw().stripTrailingZeros());
            return m;
        }).toList());
    }

    private static String vorbehaltJson(BigDecimal bezugKw, String herkunft) {
        if (bezugKw == null) {
            return null;
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("richtung", Grenzart.BEZUG.code());
        m.put("kw", bezugKw.stripTrailingZeros());
        m.put("herkunft", herkunft);
        return json(m);
    }

    private static String json(Object o) {
        try {
            return JSON.writeValueAsString(o);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

}
