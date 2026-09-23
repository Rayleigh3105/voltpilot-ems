package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.measurement.SummenwertQuellenService;
import com.voltpilot.api.measurement.MeasurementCatalog.Point;
import com.voltpilot.api.measurement.MeasurementCatalog.Semantik;
import com.voltpilot.api.measurement.MesskanalAbbildung;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.topology.RollenZuordnungService;
import com.voltpilot.api.web.dto.RollenDto;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import com.voltpilot.api.uems.MessstelleAenderungRepository.NeuerEintrag;
import com.voltpilot.api.uems.MessstelleFormelFassungRepository.FassungZeile;
import com.voltpilot.api.uems.MessstelleFormelRegeln.FassungUrteil;
import com.voltpilot.api.uems.MessstelleFormelRegeln.SummeUrteil;
import com.voltpilot.api.uems.MessstelleFormelRegeln.Summand;
import com.voltpilot.api.uems.MessstelleFormelTermRepository.FormelStand;
import com.voltpilot.api.uems.MessstelleFormelTermRepository.TermZeile;
import com.voltpilot.api.uems.MessstelleFormelWerteRepository.Messwert;
import com.voltpilot.api.uems.MessstelleFormelWerteRepository.Quelle;
import com.voltpilot.api.uems.MessstelleRegeln.Groesse;
import com.voltpilot.api.uems.MessstelleRepository.Messstelle;
import com.voltpilot.api.uems.MessstelleRepository.NeueMessstelle;
import com.voltpilot.api.web.dto.MessstelleDto;
import com.voltpilot.api.web.dto.MessstelleFormelDto;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.function.Predicate;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Schnittstelle der berechneten Messstelle (UEMS AP-10, Formel-Typ „gewichtete Summe"):
 * anlegen (mit Ableitung der Hauptgröße aus den Termen), die Formel lesen und Live-Wert sowie
 * Verlauf rechnen. Die REINEN Regeln (Ableitung, Zyklus, Summe) stehen in
 * {@link MessstelleFormelRegeln}; hier steht nur, was Zustand berührt: Persistenz, das Auflösen
 * der Eingänge auf die historisierten Werte und die Transaktion.
 *
 * <p><b>Cloud-Berechnung, on-the-fly.</b> Ein berechneter Wert liest NIE eine Box — er summiert
 * die schon gespeicherten Werte (Samples/15-min-Rollups) anderer Komponenten; der Edge-Vertrag
 * bleibt unangetastet. <b>Ehrlichkeit hart:</b> fehlt/veraltet EIN Pflicht-Term, ist das Ergebnis
 * {@code null} („unvollständig"), nie eine stillschweigend reduzierte Teilsumme.
 *
 * <p><b>Fassungen je Tag (AP-10 IP-3, E5).</b> Die Formel ist tagesgenau zeitgültig: jede Rechnung
 * liest die Terme der Fassung DES TAGES — der Live-Wert die von heute, der Verlauf je 15-min-Bucket
 * die des Tages, an dem der Bucket beginnt (in der Zeitzone des Standorts), ein Baustein die Fassung
 * SEINER Messstelle an demselben Tag. Fassung 1 des Bestands und des Anlegens gilt seit Beginn;
 * darum rechnet eine Messstelle mit einer einzigen Fassung genau wie vor IP-3.
 *
 * <p><b>Anteil eines Terms (AP-10 IP-5).</b> Ob ein Term den ganzen Wert seines Eingangs nimmt, nur
 * den positiven/negativen Teil oder den Anteil einer Kostenstelle DES TAGES, fragen Schreibweg,
 * Live-Wert und Verlauf ausschließlich {@link AnteilLeseweg#lies} — heute lehnt er jeden Anteil
 * benannt ab (422 beim Schreiben, fehlender Term mit dem Code als Grund beim Rechnen).
 *
 * <p>Der Mandant ist die RLS: eine fremde Messstelle/Komponente ist nicht da (404, nie 403).
 */
@Service
public class MessstelleFormelService {

    /** Ab wann ein frischester Messwert als „veraltet" gilt (dann fehlt der Term). */
    static final Duration FRISCHE = Duration.ofMinutes(15);

    private static final String SCHEMA_VERSION = "1.0";
    private static final String MESSKANAL = "messkanal";
    private static final String MESSSTELLE = "messstelle";
    private static final String VERTEILUNG = AnteilLeseweg.VERTEILUNG;
    private static final String FUEHREND = "fuehrend";
    private static final int MAX_TIEFE = 16;
    private static final String HERKUNFT_ANLAGE = "anlage";
    private static final String HERKUNFT_EINTRAG = "eintrag";
    /** Die Art des Protokolleintrags einer eingetragenen Fassung ({@code messstelle_aenderung}). */
    static final String PROTOKOLL_ART = "formel_geaendert";

    private final MessstelleRepository messstellen;
    private final MessstelleAenderungRepository aenderungen;
    private final MessstelleFormelTermRepository terme;
    private final MessstelleFormelFassungRepository fassungen;
    private final MessstelleFormelWerteRepository werte;
    private final MessstelleQuelleRepository quellen;
    private final MessstelleService messstellenDienst;
    private final MeasurementCatalog katalog;
    private final UnternehmenRepository unternehmen;
    private final TransactionTemplate transaktion;
    private final ObjectMapper json;
    private final AnteilLeseweg leseweg;
    private final KostenstelleProzessRepository kostenstellen;
    private final BilanzRestRepository reste;
    private final BilanzStellungen stellungen;
    private final ObjectProvider<RollenZuordnungService> rollen;
    private final RechtPruefung rechte;
    private final SummenwertQuellenService geraete;
    private final com.voltpilot.api.zugriff.Geltungsbereich scope;
    private volatile Clock uhr = Clock.systemUTC();

    public MessstelleFormelService(MessstelleRepository messstellen,
            MessstelleAenderungRepository aenderungen, MessstelleFormelTermRepository terme,
            MessstelleFormelFassungRepository fassungen,
            MessstelleFormelWerteRepository werte, MessstelleQuelleRepository quellen,
            MessstelleService messstellenDienst, MeasurementCatalog katalog, UnternehmenRepository unternehmen,
            PlatformTransactionManager transactionManager, ObjectMapper json, AnteilLeseweg leseweg,
            KostenstelleProzessRepository kostenstellen, BilanzRestRepository reste, BilanzStellungen stellungen,
            ObjectProvider<RollenZuordnungService> rollen,
            RechtPruefung rechte, SummenwertQuellenService geraete,
            com.voltpilot.api.zugriff.Geltungsbereich scope) {
        this.messstellen = messstellen;
        this.aenderungen = aenderungen;
        this.terme = terme;
        this.fassungen = fassungen;
        this.werte = werte;
        this.quellen = quellen;
        this.messstellenDienst = messstellenDienst;
        this.katalog = katalog;
        this.unternehmen = unternehmen;
        this.transaktion = new TransactionTemplate(transactionManager);
        this.json = json;
        this.leseweg = leseweg;
        this.kostenstellen = kostenstellen;
        this.reste = reste;
        this.stellungen = stellungen;
        this.rollen = rollen;
        this.rechte = rechte;
        this.geraete = geraete;
        this.scope = scope;
    }

    /** Nur für Tests: die Uhr, an der „jetzt" (und die Frische-Grenze) hängt. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    // ---------------------------------------------------------------- anlegen

    /**
     * Ein Term auf dem Weg zum Anlegen: die gespeicherte Bindung und die abgeleitete Größe.
     * {@code anteil == null} ist {@code gesamt} (so wird es auch gespeichert).
     */
    private record Bindung(String eingangArt, UUID entityId, String pointKey, UUID quellMessstelleId,
            String vorzeichen, double faktor, boolean giltAlsErzeugung, Groesse groesse, UUID verteilungZiel,
            String anteil) {}

    /**
     * Legt eine berechnete Messstelle mit ihrer Formel an — in EINER Transaktion mit dem
     * Kennzeichen (automatisch, E7) und dem Protokolleintrag „angelegt". Die Hauptgröße wird aus
     * den Termen abgeleitet (nie gewählt); gemischte Größen lehnt {@link MessstelleFormelRegeln} ab.
     * Ohne ersten Tag gilt Fassung 1 (Herkunft {@code anlage}) wie im Bestand seit Beginn.
     * Ein ausdrücklich übergebener Tag begrenzt sie; ohne Typ bleibt sie eine gewichtete Summe.
     */
    @org.springframework.transaction.annotation.Transactional
    public MessstelleDto.Messstelle anlegen(MessstelleFormelDto.Anlegen a, ProtokollAkteur wer) {
        UUID tenant = TenantContext.get();
        if (tenant == null) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Kein Kundenbereich gewählt.");
        }
        if (a == null || a.terme() == null || a.terme().isEmpty()) {
            throw MessstelleFormelAbgelehnt.anfrage("terme", "Eine Formel braucht mindestens einen Term.");
        }
        String typ = schreibbarerTyp(a.formelTyp());
        rechte.rueckwirkend(a.gueltigAb());
        UUID rollenAnlage = null;
        if (a.rolle() != null) {
            if (a.rolle().entityId() == null || a.rolle().role() == null) {
                throw MessstelleFormelAbgelehnt.anfrage("rolle", "Die Rolle braucht ein Gerät und eine Rollenart.");
            }
            rollenAnlage = werte.anlage(a.rolle().entityId()).orElseThrow(() ->
                    new ResponseStatusException(HttpStatus.NOT_FOUND, "Gerät nicht gefunden."));
            rechte.pruefen("geraet.einrichten", RechtZiel.ANLAGE,
                    rollenAnlage, () -> new ResponseStatusException(HttpStatus.NOT_FOUND));
        }
        final UUID zielAnlage = rollenAnlage;
        List<Bindung> bindungen = new ArrayList<>();
        List<MessstelleFormelRegeln.Term> fuerAbleitung = new ArrayList<>();
        // Ohne ausdrücklichen Beginn gilt Fassung 1 seit Beginn, die Verteilung wird heute geprüft.
        LocalDate ab = a.gueltigAb() == null ? heute(zone()) : a.gueltigAb();
        for (int i = 0; i < a.terme().size(); i++) {
            Bindung b = bindung(a.terme().get(i), i, ab);
            bindungen.add(b);
            fuerAbleitung.add(new MessstelleFormelRegeln.Term(b.groesse().groesse(), b.groesse().richtung(),
                    b.groesse().einheit(), b.groesse().wertart(), b.vorzeichen()));
        }
        pruefeKontext(a.kontext(), bindungen);
        pruefeSaldo(typ, bindungen, ab);
        MessstelleFormelRegeln.GroesseUrteil urteil = MessstelleFormelRegeln.hauptgroesse(
                typ, MessstelleRegeln.BERECHNET, "Intervallmenge", fuerAbleitung);
        if (urteil.fehler() != null) {
            throw MessstelleFormelAbgelehnt.regel(urteil.fehler(),
                    "Die Terme tragen nicht dieselbe Messgröße — sie lassen sich nicht summieren.",
                    Map.of("grund", urteil.grund()));
        }
        Groesse haupt = urteil.hauptgroesse();
        String medium = medium(haupt.groesse());
        String name = leerAlsNull(a.name());
        String notiz = leerAlsNull(a.notiz());
        Instant jetzt = minute(uhr.instant());
        UUID id = transaktion.execute(s -> {
            Messstelle m = messstellen.anlegen(new NeueMessstelle(tenant, null, name, "berechnet",
                    medium, haupt, notiz));
            UUID fassung = fassungen.anlegen(m.id(), 1, typ, a.gueltigAb(),
                    HERKUNFT_ANLAGE, a.gueltigAb() != null && ab.isBefore(heute(zone())), null, uhr.instant(), wer);
            termeAnlegen(fassung, m.id(), bindungen);
            protokoll(m.id(), name, medium, haupt, bindungen, notiz, jetzt, wer);
            if (a.rolle() != null) {
                // Mitgliedschaft prüfen; die Anlage ordnet anschließend ALLEN gelesenen Geräten zu.
                if (!rollen.getObject().geleseneGeraete(zielAnlage, m.id()).contains(a.rolle().entityId())) {
                    throw MessstelleFormelAbgelehnt.anfrage("rolle", "Der Summenwert liest dieses Gerät nicht.");
                }
                rollen.getObject().zuordnenAnlage(zielAnlage, a.rolle().role(),
                        new RollenDto.AnlageEingabe("gesamtwert", m.id(),
                                Boolean.TRUE.equals(a.rolle().ersetzen())), wer);
            }
            return m.id();
        });
        return messstellenDienst.eine(id);
    }

    private static String schreibbarerTyp(String typ) {
        if (typ == null) return MessstelleFormelRegeln.GEWICHTETE_SUMME;
        if (!List.of(MessstelleFormelRegeln.GEWICHTETE_SUMME, MessstelleFormelRegeln.SALDO).contains(typ)) {
            throw MessstelleFormelAbgelehnt.anfrage("formel_typ",
                    "Wählen Sie Summe oder Saldo. Der Rest entsteht aus der elektrischen Stellung.");
        }
        return typ;
    }

    /** E1/F9: zwei Hauptzähler-Richtungen derselben Grenze, ohne Gewichtung oder Verteilung. */
    private void pruefeSaldo(String typ, List<Bindung> bindungen, LocalDate tag) {
        if (!MessstelleFormelRegeln.SALDO.equals(typ)) return;
        BilanzStellungen.Stand stand = stellungen.lesen();
        List<BilanzAbleitung.StellungZeile> paar = new ArrayList<>();
        for (Bindung b : bindungen) {
            Messstelle m = stand.nachKennzeichen().values().stream()
                    .filter(q -> q.id().equals(b.quellMessstelleId())).findFirst().orElse(null);
            if (!MESSSTELLE.equals(b.eingangArt()) || b.faktor() != 1 || b.anteil() != null
                    || m == null || m.archiviertAm() != null || !"gemessen".equals(m.art())
                    || !"Wirkenergie".equals(m.hauptgroesse().groesse())) throw saldoPaarFehlt();
            var z = stand.zeilen().stream().filter(s -> s.messstelle().equals(m.kennzeichen())
                    && s.gilt(tag) && "Hauptzähler".equals(s.stellung())).toList();
            if (z.size() != 1 || !("Bezug".equals(z.getFirst().richtung()) && "+".equals(b.vorzeichen())
                    || "Abgabe".equals(z.getFirst().richtung()) && "-".equals(b.vorzeichen()))) throw saldoPaarFehlt();
            paar.add(z.getFirst());
        }
        if (paar.size() != 2 || !paar.get(0).anlage().equals(paar.get(1).anlage())
                || paar.get(0).richtung().equals(paar.get(1).richtung())) throw saldoPaarFehlt();
    }

    private static MessstelleFormelAbgelehnt saldoPaarFehlt() {
        return MessstelleFormelAbgelehnt.regel(MessstelleFormelRegeln.Fehler.GROESSEN_GEMISCHT,
                "Ein Saldo braucht Bezug minus Abgabe der Hauptzähler derselben Anlage, jeweils mit Faktor 1.",
                Map.of("grund", "saldo_braucht_zwei"));
    }

    /** Prüft jede tatsächlich gelesene Komponente, auch hinter verschachtelten Messstellen. */
    private void pruefeKontext(MessstelleFormelDto.Kontext k, List<Bindung> bindungen) {
        if (k == null) return; // additive Schnittstelle für bestehende Anlagen-Aufrufer
        if (!("geraet".equals(k.art()) || "anlage".equals(k.art())) || k.siteId() == null
                || ("anlage".equals(k.art()) && (k.boxId() != null || k.geraetId() != null))) {
            throw MessstelleFormelAbgelehnt.anfrage("kontext", "Der Einstieg braucht Gerät oder Anlage.");
        }
        scope.requireSite(k.siteId());
        rechte.pruefen("messstelle.formel", RechtZiel.ANLAGE,
                k.siteId(), () -> new ResponseStatusException(HttpStatus.NOT_FOUND));
        Set<String> erlaubt = "geraet".equals(k.art())
                ? geraete.geraet(k.siteId(), k.boxId(), k.geraetId()).stream()
                        .map(UUID::toString).collect(java.util.stream.Collectors.toSet()) : null;
        Set<UUID> gelesen = new HashSet<>();
        for (Bindung b : bindungen) {
            if (MESSKANAL.equals(b.eingangArt())) gelesen.add(b.entityId());
            else quellKomponenten(b.quellMessstelleId(), gelesen, new HashSet<>());
        }
        for (UUID entity : gelesen) {
            if (werte.anlage(entity).filter(k.siteId()::equals).isEmpty()) {
                throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Komponente nicht gefunden.");
            }
        }
        String grund = SummenwertKontextRegeln.grund(erlaubt,
                gelesen.stream().map(UUID::toString).toList());
        if (grund != null) throw MessstelleFormelAbgelehnt.kontext(grund);
    }

    private void quellKomponenten(UUID id, Set<UUID> aus, Set<UUID> pfad) {
        if (id == null || !pfad.add(id) || pfad.size() > MAX_TIEFE)
            throw MessstelleFormelAbgelehnt.kontext("quelle_nicht_aufloesbar");
        try {
            var m = messstellen.finde(id).orElseThrow(() ->
                    new ResponseStatusException(HttpStatus.NOT_FOUND, "Messstelle nicht gefunden."));
            if (m.archiviertAm() != null) throw MessstelleFormelAbgelehnt.kontext("quelle_nicht_aufloesbar");
            if (MessstelleRegeln.BERECHNET.equals(m.art())) {
                var ts = termeAm(id, heute(zone()));
                if (ts.isEmpty()) throw MessstelleFormelAbgelehnt.kontext("quelle_nicht_aufloesbar");
                for (var t : ts) {
                    if (MESSKANAL.equals(t.eingangArt()) && t.entityId() != null) aus.add(t.entityId());
                    else if (MESSSTELLE.equals(t.eingangArt()) || VERTEILUNG.equals(t.eingangArt())) quellKomponenten(t.quellMessstelleId(), aus, pfad);
                    else throw MessstelleFormelAbgelehnt.kontext("quelle_nicht_aufloesbar");
                }
            } else {
                Instant jetzt = uhr.instant();
                var bs = quellen.derMessstelle(id).stream().filter(b -> FUEHREND.equals(b.rolle())
                        && m.hauptgroesse().groesse().equals(b.groesse())
                        && m.hauptgroesse().richtung().equals(b.richtung())
                        && !b.gueltigAb().isAfter(jetzt)
                        && (b.gueltigBis() == null || b.gueltigBis().isAfter(jetzt))).toList();
                if (bs.size() != 1 || bs.getFirst().entityId() == null)
                    throw MessstelleFormelAbgelehnt.kontext("quelle_nicht_aufloesbar");
                aus.add(bs.getFirst().entityId());
            }
        } finally { pfad.remove(id); }
    }

    /**
     * Ein Term der Anfrage auf dem Weg zum Speichern: erst die Form (400), dann ob sein Eingang da ist
     * (404, fremd ist nicht da), dann die Vertragsregel des Verteilungs-Terms und zuletzt, ob sein
     * Anteil am Tag {@code ab} lesbar ist ({@link AnteilLeseweg#lies}, 422) — gespeichert wird nur,
     * was die Rechnung auch lesen kann.
     */
    private Bindung bindung(MessstelleFormelDto.TermEingabe t, int index, LocalDate ab) {
        String feld = "terme[" + index + "]";
        if (t == null) {
            throw MessstelleFormelAbgelehnt.anfrage(feld, "Ein Term ist leer.");
        }
        String vorzeichen = t.vorzeichen();
        if (!"+".equals(vorzeichen) && !"-".equals(vorzeichen)) {
            throw MessstelleFormelAbgelehnt.anfrage(feld + ".vorzeichen", "Das Vorzeichen ist „+“ oder „-“.");
        }
        double faktor = t.faktor() == null ? 1.0 : t.faktor();
        if (faktor == 0) {
            throw MessstelleFormelAbgelehnt.anfrage(feld + ".faktor", "Ein Faktor 0 wäre ein Term ohne Wirkung.");
        }
        if (t.anteil() != null && !AnteilLeseweg.ANTEILE.contains(t.anteil())) {
            throw MessstelleFormelAbgelehnt.anfrage(feld + ".anteil",
                    "Der Anteil ist „gesamt“, „positiv“ oder „negativ“.");
        }
        // `gesamt` hat genau eine Schreibweise: keine (V20260913143000).
        String anteil = AnteilLeseweg.GESAMT.equals(t.anteil()) ? null : t.anteil();
        if (t.verteilungZiel() != null && !VERTEILUNG.equals(t.eingangArt())) {
            throw MessstelleFormelAbgelehnt.anfrage(feld + ".verteilung_ziel",
                    "Nur ein Verteilungs-Term nennt eine Kostenstelle.");
        }
        Bindung b = eingang(t, feld, vorzeichen, faktor, anteil);
        Optional<AnteilLeseweg.Ablehnung> regel =
                AnteilLeseweg.vertragsregel(b.eingangArt(), BigDecimal.valueOf(faktor));
        if (regel.isPresent()) {
            throw MessstelleFormelAbgelehnt.leseweg(regel.get(), feld);
        }
        AnteilLeseweg.Lesung lesung =
                leseweg.lies(b.eingangArt(), b.anteil(), b.quellMessstelleId(), b.verteilungZiel(), ab);
        if (lesung.wartet() != null) {
            throw MessstelleFormelAbgelehnt.leseweg(lesung.wartet(), feld);
        }
        // AP-10 IP-8: an der Stelle der eingelösten Ablehnung `verteilung_wartet_auf_ip8` — die Kostenstelle
        // des Terms ist da (fremd ist nicht da: 404, nie der Fremdschlüssel als 500).
        if (VERTEILUNG.equals(b.eingangArt())
                && kostenstellen.finde(KostenstelleProzessRepository.Art.KOSTENSTELLE, b.verteilungZiel()).isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Kostenstelle nicht gefunden.");
        }
        return b;
    }

    /** Der Eingang eines Terms, aufgelöst: Messkanal, Baustein oder Verteilungs-Anteil einer Messstelle. */
    private Bindung eingang(MessstelleFormelDto.TermEingabe t, String feld, String vorzeichen, double faktor,
            String anteil) {
        boolean haken = Boolean.TRUE.equals(t.giltAlsErzeugung());
        if (MESSKANAL.equals(t.eingangArt())) {
            if (t.entityId() == null || leerAlsNull(t.pointKey()) == null) {
                throw MessstelleFormelAbgelehnt.anfrage(feld,
                        "Ein Messkanal-Term braucht die Komponente und den Kanal.");
            }
            if (!werte.komponenteGehoert(t.entityId())) {
                throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Komponente nicht gefunden.");
            }
            // AP-08: der Haken „gilt als Erzeugung" nur auf einem Kanal OHNE Katalog-Richtung —
            // sonst ein wirkungsloser Schalter (die Regel steht in beiden Zwillingen).
            if (haken && !MessstelleFormelRegeln.erzeugungsHakenErlaubt(kanalRichtung(t.pointKey()))) {
                throw MessstelleFormelAbgelehnt.anfrage(feld + ".gilt_als_erzeugung",
                        "„Gilt als Erzeugung“ ist nur für einen Kanal ohne eigene Richtung — "
                                + "dieser Kanal trägt schon eine.");
            }
            Groesse g = kanalGroesse(t.pointKey(), haken, false);
            if (g == null) {
                throw MessstelleFormelAbgelehnt.anfrage(feld,
                        "Dieser Messwert hat keine Vertrags-Messgröße — er kann kein Term sein.");
            }
            return new Bindung(MESSKANAL, t.entityId(), t.pointKey(), null, vorzeichen, faktor, haken, g, null,
                    anteil);
        }
        if (MESSSTELLE.equals(t.eingangArt())) {
            if (haken) {
                throw MessstelleFormelAbgelehnt.anfrage(feld + ".gilt_als_erzeugung",
                        "„Gilt als Erzeugung“ gilt nur für einen Messkanal-Term.");
            }
            if (t.quellMessstelleId() == null) {
                throw MessstelleFormelAbgelehnt.anfrage(feld, "Ein Baustein-Term braucht eine Messstelle.");
            }
            Messstelle quell = messstellen.finde(t.quellMessstelleId()).orElseThrow(() ->
                    new ResponseStatusException(HttpStatus.NOT_FOUND, "Messstelle nicht gefunden."));
            return new Bindung(MESSSTELLE, null, null, quell.id(), vorzeichen, faktor, false, quell.hauptgroesse(),
                    null, anteil);
        }
        if (VERTEILUNG.equals(t.eingangArt())) {
            if (haken) {
                throw MessstelleFormelAbgelehnt.anfrage(feld + ".gilt_als_erzeugung",
                        "„Gilt als Erzeugung“ gilt nur für einen Messkanal-Term.");
            }
            if (t.quellMessstelleId() == null || t.verteilungZiel() == null) {
                throw MessstelleFormelAbgelehnt.anfrage(feld,
                        "Ein Verteilungs-Term braucht die Messstelle und die Kostenstelle.");
            }
            Messstelle quell = messstellen.finde(t.quellMessstelleId()).orElseThrow(() ->
                    new ResponseStatusException(HttpStatus.NOT_FOUND, "Messstelle nicht gefunden."));
            // Größe und Richtung eines Verteilungs-Terms sind die seiner Quell-Messstelle (§1.1).
            return new Bindung(VERTEILUNG, null, null, quell.id(), vorzeichen, faktor, false, quell.hauptgroesse(),
                    t.verteilungZiel(), anteil);
        }
        throw MessstelleFormelAbgelehnt.anfrage(feld + ".eingang_art",
                "Der Eingang ist „messkanal“, „messstelle“ oder „verteilung“.");
    }

    /** Eine Liste pro Komponente, auch ohne Rolle und über verschachtelte Bausteine. */
    public List<MessstelleFormelDto.GeraetSummenwert> summenwerte(UUID site, UUID entity) {
        var zuordnungen = new java.util.HashMap<UUID, String>();
        for (String rolle : List.of("pv", "consumer", "grid")) {
            var z = rollen.getObject().lies(site, entity, rolle).zugeordnet();
            if (z != null && z.quellMessstelleId() != null) zuordnungen.put(z.quellMessstelleId(), rolle);
        }
        List<MessstelleFormelDto.GeraetSummenwert> aus = new ArrayList<>();
        for (UUID id : terme.summenwertKandidaten(entity)) {
            if (liestGeraet(id, entity, new HashSet<>())) {
                aus.add(new MessstelleFormelDto.GeraetSummenwert(messstellenDienst.eine(id),
                        zuordnungen.get(id), wert(id)));
            }
        }
        return aus;
    }

    private boolean liestGeraet(UUID id, UUID entity, Set<UUID> pfad) {
        if (!pfad.add(id) || pfad.size() > MAX_TIEFE) return false;
        try {
            return formel(id, null).terme().stream().anyMatch(t -> entity.equals(t.entityId())
                    || (MESSSTELLE.equals(t.eingangArt()) && t.quellMessstelleId() != null
                        && liestGeraet(t.quellMessstelleId(), entity, pfad)));
        } finally {
            pfad.remove(id);
        }
    }

    // ------------------------------------------------------------------ lesen

    /**
     * Die Formel einer berechneten Messstelle AN EINEM TAG: die Terme der Fassung, die an dem Tag
     * gilt, in Reihenfolge, und ihr Stand. {@code am == null} heißt heute (in der Zeitzone des
     * Standorts) — und die Antwort ist dann Zeichen für Zeichen die von vor AP-10 IP-3: dieselben
     * Felder, dieselben Terme (für den Bestand ist die heutige Fassung Fassung 1 = seine Terme),
     * OHNE den Block {@code fassung_am}. Mit {@code am} kommt {@code fassung_am} dazu: der Tag
     * und die Fassung, die an ihm gilt ({@code null}, wenn an dem Tag keine gilt — dann ohne Terme).
     */
    public MessstelleFormelDto.Formel formel(UUID id, LocalDate am) {
        Messstelle m = berechnete(id);
        ZoneId zone = zone();
        LocalDate tag = am != null ? am : heute(zone);
        Optional<FassungZeile> fassung = fassungAm(fassungen.wirksame(id), tag);
        FormelStand stand = terme.stand(id, tag);
        List<MessstelleFormelDto.Term> aus = new ArrayList<>();
        for (TermZeile t : fassung.map(f -> terme.derFassung(f.id())).orElse(List.of())) {
            aus.add(new MessstelleFormelDto.Term(t.position(), t.eingangArt(), t.entityId(),
                    t.pointKey(), t.quellMessstelleId(), t.vorzeichen(), t.faktor(),
                    t.giltAlsErzeugung(), dtoGroesse(groesse(t)), eingerichtet(t), t.verteilungZiel(),
                    t.anteil()));
        }
        Groesse h = m.hauptgroesse();
        MessstelleFormelDto.FassungAm fassungAm = am == null ? null
                : new MessstelleFormelDto.FassungAm(tag, fassung.map(f -> fassungDto(f, zone)).orElse(null));
        return new MessstelleFormelDto.Formel(id, SCHEMA_VERSION,
                new MessstelleFormelDto.Groesse(h.groesse(), h.richtung(), h.einheit(), h.wertart()),
                aus, stand.vorhanden(), stand.eingerichtet(), fassungAm);
    }

    private MessstelleFormelDto.Fassung fassungDto(FassungZeile f, ZoneId zone) {
        String abzeichen = null;
        if (f.rueckwirkend()) {
            abzeichen = OrtsbaumAbleitung.rueckwirkung(new OrtsbaumAbleitung.RueckwirkungEingang(
                    OffsetDateTime.ofInstant(f.eingetragenAm(), zone), f.gueltigAb(), f.gueltigBis(), zone, null))
                    .abzeichen();
        }
        return new MessstelleFormelDto.Fassung(f.nummer(), f.formelTyp(), f.gueltigAb(), f.gueltigBis(),
                f.herkunft(), f.rueckwirkend(), abzeichen, f.begruendung(), zeit(f.eingetragenAm()));
    }

    // -------------------------------------------------------- Fassung eintragen

    /**
     * Trägt eine neue Fassung der Formel ab einem Tag ein (AP-10 IP-3, Vertrag §6): die Terme
     * werden geprüft wie beim Anlegen (Form, Größe, Zyklus), die abgeleitete Hauptgröße muss die der
     * Messstelle bleiben; das Urteil über die Tage fällt {@link MessstelleFormelRegeln#fassungEintrag}
     * (Vortag beendet, Überlappung 422, rückwirkend gekennzeichnet). In EINER Transaktion unter der
     * Zeilensperre der Messstelle: die laufende Fassung beenden, die neue mit ihren Terme anlegen,
     * GENAU EIN Protokolleintrag {@code formel_geaendert}. Eine Ablehnung schreibt nichts. Antwort:
     * die Formel am ersten Tag der neuen Fassung.
     */
    public MessstelleFormelDto.Formel fassungEintragen(UUID id, MessstelleFormelDto.FassungEintragen a,
            ProtokollAkteur wer) {
        Messstelle m = berechnete(id);
        if (a == null) {
            throw MessstelleFormelAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        if (a.gueltigAb() == null) {
            throw MessstelleFormelAbgelehnt.anfrage("gueltig_ab",
                    "„gültig ab“ fehlt: der Tag (JJJJ-MM-TT), ab dem die neue Formel gilt.");
        }
        rechte.rueckwirkend(a.gueltigAb());
        String typ = schreibbarerTyp(a.formelTyp());
        if (fassungen.wirksame(id).stream().anyMatch(f -> MessstelleFormelRegeln.REST.equals(f.formelTyp()))) {
            // E3: die Terme eines Rests kommen je Tag aus der Stellung — es gibt nichts einzutragen.
            throw MessstelleFormelAbgelehnt.anfrage("formel_typ", m.kennzeichen() + " ist ein Rest: seine Terme "
                    + "kommen je Tag aus der elektrischen Stellung. Ändern Sie die Stellung, nicht die Formel.");
        }
        String begruendung = leerAlsNull(a.begruendung());
        if (begruendung != null && begruendung.length() > 500) {
            throw MessstelleFormelAbgelehnt.anfrage("begruendung", "Die Begründung hat höchstens 500 Zeichen.");
        }
        if (a.terme() == null || a.terme().isEmpty()) {
            throw MessstelleFormelAbgelehnt.anfrage("terme", "Eine Formel braucht mindestens einen Term.");
        }
        if (m.archiviertAm() != null) {
            throw MessstelleAbgelehnt.schnittstelle(MessstelleAbgelehnt.Schnittstelle.ZUSTAND_PASST_NICHT,
                    m.kennzeichen() + " ist archiviert — eine archivierte Messstelle bleibt, wie sie ist.",
                    Map.of("archiviert_am", zeit(m.archiviertAm())));
        }
        List<Bindung> bindungen = new ArrayList<>();
        List<MessstelleFormelRegeln.Term> fuerAbleitung = new ArrayList<>();
        List<String> verweise = new ArrayList<>();
        for (int i = 0; i < a.terme().size(); i++) {
            Bindung b = bindung(a.terme().get(i), i, a.gueltigAb());
            bindungen.add(b);
            fuerAbleitung.add(new MessstelleFormelRegeln.Term(b.groesse().groesse(), b.groesse().richtung(),
                    b.groesse().einheit(), b.groesse().wertart(), b.vorzeichen()));
            if (b.quellMessstelleId() != null) {
                verweise.add(messstellen.finde(b.quellMessstelleId()).map(Messstelle::kennzeichen)
                        .orElse(b.quellMessstelleId().toString()));
            }
        }
        pruefeSaldo(typ, bindungen, a.gueltigAb());
        MessstelleFormelRegeln.GroesseUrteil urteil = MessstelleFormelRegeln.hauptgroesse(
                typ, MessstelleRegeln.BERECHNET, "Intervallmenge", fuerAbleitung);
        if (urteil.fehler() != null) {
            throw MessstelleFormelAbgelehnt.regel(urteil.fehler(),
                    "Die Terme tragen nicht dieselbe Messgröße — sie lassen sich nicht summieren.",
                    Map.of("grund", urteil.grund()));
        }
        String abweichung = MessstelleFormelRegeln.hauptgroesseAbweichung(m.hauptgroesse(), urteil.hauptgroesse());
        if (abweichung != null) {
            throw MessstelleFormelAbgelehnt.regel(MessstelleFormelRegeln.Fehler.GROESSEN_GEMISCHT,
                    "Die neue Formel ergibt eine andere Messgröße als " + m.kennzeichen()
                            + " — eine andere Größe ist eine andere Messstelle.",
                    Map.of("grund", abweichung));
        }
        ZoneId zone = zone();
        Instant jetzt = uhr.instant();
        LocalDate ab = a.gueltigAb();
        try {
            transaktion.executeWithoutResult(tx -> {
                fassungen.sperre(id);
                Map<String, List<String>> bestehende = new LinkedHashMap<>(fassungen.verkettungen(ab));
                bestehende.remove(m.kennzeichen());
                MessstelleFormelRegeln.ZyklusUrteil zyklus =
                        MessstelleFormelRegeln.zyklus(m.kennzeichen(), verweise, bestehende);
                if (zyklus.zyklus()) {
                    throw MessstelleFormelAbgelehnt.regel(MessstelleFormelRegeln.Fehler.FORMEL_ZYKLUS,
                            "Die Formel verkettet sich im Kreis: " + String.join(" → ", zyklus.kette()) + ".",
                            Map.of("kette", zyklus.kette()));
                }
                List<FassungZeile> wirksam = fassungen.wirksame(id);
                FassungUrteil u = MessstelleFormelRegeln.fassungEintrag(
                        wirksam.stream().map(FassungZeile::alsRegel).toList(), ab,
                        OffsetDateTime.ofInstant(jetzt, zone), zone);
                if (u.fehler() != null) {
                    throw ueberlappt(u.satz(), u.konflikt());
                }
                FassungZeile alt = null;
                if (u.beenden() != null) {
                    alt = wirksam.stream().filter(f -> f.nummer() == u.beenden().nummer()).findFirst().orElseThrow();
                    fassungen.beenden(alt.id(), u.beendenAm());
                }
                // Die Nummer wird nie wiederverwendet — auch nicht die einer aufgehobenen Fassung.
                int nummer = Math.max(u.nummer(), fassungen.hoechsteNummer(id) + 1);
                UUID neu = fassungen.anlegen(id, nummer, typ, ab, HERKUNFT_EINTRAG, u.rueckwirkend(),
                        begruendung, jetzt, wer);
                termeAnlegen(neu, id, bindungen);
                fassungProtokoll(id, alt, u, nummer, typ, bindungen, zone, jetzt, begruendung, wer);
            });
        } catch (DataIntegrityViolationException e) {
            // Das eine Rennen, das die Sperre nicht ausschließt (ein Schreiber ohne sie): die
            // Datenbank lehnt die Überlappung ab (23P01) oder die doppelte Nummer (23505) — nie 500.
            String state = sqlState(e);
            if ("23P01".equals(state) || "23505".equals(state)) {
                throw ueberlappt("Für diesen Tag wurde soeben eine andere Fassung eingetragen. "
                        + "Laden Sie die Formel neu.", null);
            }
            throw e;
        }
        return formel(id, ab);
    }

    private static MessstelleFormelAbgelehnt ueberlappt(String satz, MessstelleFormelRegeln.Fassung konflikt) {
        Map<String, Object> fakten = new LinkedHashMap<>();
        if (konflikt != null) {
            fakten.put("fassung", konflikt.nummer());
            fakten.put("gueltig_ab", konflikt.ab() == null ? null : konflikt.ab().toString());
        }
        return MessstelleFormelAbgelehnt.fassung(MessstelleFormelRegeln.FassungFehler.FORMEL_FASSUNG_UEBERLAPPT,
                satz, fakten);
    }

    private void termeAnlegen(UUID fassung, UUID messstelle, List<Bindung> bindungen) {
        for (int i = 0; i < bindungen.size(); i++) {
            Bindung b = bindungen.get(i);
            terme.anlegen(fassung, messstelle, i, b.eingangArt(), b.entityId(), b.pointKey(),
                    b.quellMessstelleId(), b.vorzeichen(), b.faktor(), b.verteilungZiel(), b.anteil(),
                    b.giltAlsErzeugung());
        }
    }

    // ------------------------------------------------------------- Live-Wert

    /** Ein Zwischenergebnis der Rechnung: Wert (oder null), jüngster Messzeitpunkt, fehlende Terme. */
    private record RohWert(Double wert, Instant stand, String einheit,
            List<MessstelleFormelDto.FehlenderTerm> fehlende) {}

    /** Der Live-Wert: gerechnet mit der Fassung von HEUTE (in der Zeitzone des Standorts). */
    public MessstelleFormelDto.Wert wert(UUID id) {
        Messstelle m = berechnete(id);
        Instant cutoff = uhr.instant().minus(FRISCHE);
        LocalDate heute = heute(zone());
        RohWert r = liveWert(m, cutoff, heute, new HashSet<>(List.of(id)), 0);
        return new MessstelleFormelDto.Wert(r.wert(), r.einheit(), r.wert() == null, r.fehlende(),
                r.stand() == null ? null : zeit(r.stand()));
    }

    private RohWert liveWert(Messstelle m, Instant cutoff, LocalDate tag, Set<UUID> besucht, int tiefe) {
        if (fassungAm(fassungen.wirksame(m.id()), tag).isEmpty()) {
            return new RohWert(null, null, m.hauptgroesse().einheit(), List.of());
        }
        // F9: Saldo ist eine Intervallmenge. Einzelne Zählerstände oder Leistungs-Samples
        // sind keine Energiemengen desselben Intervalls. Dafür gilt der gespeicherte AP-08-Leseweg.
        if (MessstelleRegeln.SALDIERT.equals(m.hauptgroesse().richtung())) {
            return new RohWert(null, null, m.hauptgroesse().einheit(), termeAm(m.id(), tag).stream()
                    .map(t -> fehlt(t, "unvollstaendig")).toList());
        }
        Optional<UUID> restVon = restHauptzaehlerAm(m.id(), tag);
        if (restVon.isPresent()) {
            RestLive live = restLive(restVon.get(), cutoff, tag);
            List<MessstelleFormelDto.FehlenderTerm> fehlende = new ArrayList<>();
            for (BilanzAbleitung.Fehlender f : live.urteil().fehlende()) {
                fehlende.add(new MessstelleFormelDto.FehlenderTerm(live.position(f.term()), f.grund()));
            }
            return new RohWert(live.urteil().wert(), live.urteil().wert() == null ? null : live.stand(),
                    RestLive.EINHEIT, fehlende);
        }
        Groesse haupt = m.hauptgroesse();
        String ziel = haupt.einheit();
        List<Summand> summanden = new ArrayList<>();
        List<MessstelleFormelDto.FehlenderTerm> fehlende = new ArrayList<>();
        Instant stand = null;
        for (TermZeile t : termeAm(m.id(), tag)) {
            Double wert = null;
            String einheit = ziel;
            AnteilLeseweg.Lesung lesung = lesung(t, tag);
            if (lesung.wartet() != null) {
                // Der Anteil ist nicht lesbar: der Term fehlt, genannt mit dem Code — nie eine Zahl.
                fehlende.add(fehlt(t, lesung.wartet().code()));
            } else if (MESSKANAL.equals(t.eingangArt())) {
                Optional<Quelle> q = werte.quelle(t.entityId(), t.pointKey());
                if (q.isEmpty()) {
                    fehlende.add(fehlt(t, "kein_geraet"));
                } else {
                    Optional<Messwert> mw = werte.frischester(q.get(), t.pointKey(), t.entityId());
                    if (mw.isEmpty()) {
                        fehlende.add(fehlt(t, "kein_wert"));
                    } else if (mw.get().zeit().isBefore(cutoff)) {
                        fehlende.add(fehlt(t, "veraltet"));
                    } else {
                        wert = mw.get().wert();
                        einheit = kanalEinheit(t.pointKey(), ziel);
                        stand = juenger(stand, mw.get().zeit());
                    }
                }
            } else {
                RohWert sub = bausteinWert(t.quellMessstelleId(), cutoff, tag, besucht, tiefe);
                if (sub == null || sub.wert() == null) {
                    fehlende.add(fehlt(t, "unvollstaendig"));
                } else {
                    wert = sub.wert();
                    einheit = sub.einheit();
                    stand = juenger(stand, sub.stand());
                }
            }
            if (wert != null && !lesung.ganz()) {
                VerteilungRegeln.TermUrteil anteil = lesung.urteil(BigDecimal.valueOf(wert));
                if (anteil.fehler() != null) {
                    fehlende.add(fehlt(t, anteil.fehler()));
                    wert = null;
                } else {
                    wert = anteil.menge().doubleValue();
                }
            }
            summanden.add(new Summand(t.vorzeichen(), t.faktor(), wert, einheit));
        }
        SummeUrteil u = MessstelleFormelRegeln.gewichteteSumme(ziel, summanden);
        return new RohWert(u.wert(), u.wert() == null ? null : stand, ziel, fehlende);
    }

    /** Der Live-Wert eines Baustein-Terms: bei einer berechneten Messstelle rekursiv, bei einer
     * gemessenen aus ihrer führenden Quelle. Ein Kreis (bereits besucht, oder zu tief) fehlt. */
    private RohWert bausteinWert(UUID quellId, Instant cutoff, LocalDate tag, Set<UUID> besucht, int tiefe) {
        if (tiefe >= MAX_TIEFE || !besucht.add(quellId)) {
            return null;
        }
        try {
            Messstelle q = messstellen.finde(quellId).orElse(null);
            if (q == null) {
                return null;
            }
            if (MessstelleRegeln.BERECHNET.equals(q.art())) {
                return liveWert(q, cutoff, tag, besucht, tiefe + 1);
            }
            KanalRef ref = fuehrenderKanal(q);
            if (ref == null) {
                return new RohWert(null, null, q.hauptgroesse().einheit(), List.of());
            }
            Optional<Messwert> mw = werte.frischester(ref.quelle(), ref.pointKey(), ref.entityId());
            if (mw.isEmpty() || mw.get().zeit().isBefore(cutoff)) {
                return new RohWert(null, null, q.hauptgroesse().einheit(), List.of());
            }
            double wert = MessstelleFormelRegeln.normiere(mw.get().wert(), ref.einheit(),
                    q.hauptgroesse().einheit());
            return new RohWert(wert, mw.get().zeit(), q.hauptgroesse().einheit(), List.of());
        } finally {
            besucht.remove(quellId);
        }
    }

    // ------------------------------------------------------ Rest aus der Stellung (AP-10 IP-9)

    /**
     * Der Live-Wert eines Rests — der PR-688-Weg, mit Termen aus der STELLUNG des Tages (E3): je Term die
     * frischeste Wirkleistung seiner Messstelle, Zufluss {@code +}, Abfluss und zugeordnet {@code −},
     * gerechnet von {@link BilanzAbleitung#live} (= {@link MessstelleFormelRegeln#gewichteteSumme}).
     * Ist EIN Term älter als {@link #FRISCHE}, ist der Wert {@code null} und der Term steht mit
     * {@code veraltet} in {@code fehlende} — nie eine Teilsumme, nie der letzte bekannte Wert (F18).
     *
     * @param fehler {@link BilanzAbleitung#REST_OHNE_HAUPTZAEHLER}, wenn der Hauptzähler heute keiner ist
     */
    public record RestLive(String hauptzaehler, List<BilanzAbleitung.RestTerm> terme,
            BilanzAbleitung.LiveUrteil urteil, Instant stand, String fehler) {

        /** Ein Momentanwert: Wirkleistung in kW (die Richtung E1 gilt nur auf der Mengen-Ebene). */
        public static final String EINHEIT = "kW";

        int position(String messstelle) {
            for (int i = 0; i < terme.size(); i++) {
                if (terme.get(i).messstelle().equals(messstelle)) {
                    return i;
                }
            }
            return -1;
        }
    }

    /** Der Live-Wert des Rests eines Hauptzählers JETZT (Tag in der Zeitzone des Kundenbereichs). */
    public RestLive restLive(UUID hauptzaehlerId) {
        return restLive(hauptzaehlerId, uhr.instant().minus(FRISCHE), heute(zone()));
    }

    private RestLive restLive(UUID hauptzaehlerId, Instant cutoff, LocalDate tag) {
        BilanzStellungen.Stand stand = stellungen.lesen();
        Messstelle x = messstellen.finde(hauptzaehlerId).orElse(null);
        BilanzAbleitung.RestFassung f = x == null ? null : stand.rest(x.kennzeichen(), tag);
        if (f == null || f.fehler() != null) {
            return new RestLive(x == null ? null : x.kennzeichen(), List.of(),
                    new BilanzAbleitung.LiveUrteil(null, true, List.of()), null, BilanzAbleitung.REST_OHNE_HAUPTZAEHLER);
        }
        List<BilanzAbleitung.LiveTerm> live = new ArrayList<>();
        Instant juengster = null;
        for (BilanzAbleitung.RestTerm t : f.terme()) {
            Messstelle q = stand.nachKennzeichen().get(t.messstelle());
            Leistung l = q == null ? null : leistungsKanal(q);
            Double wert = null;
            String grund = null;
            if (l == null) {
                grund = "kein_geraet";
            } else {
                Optional<Messwert> mw = werte.frischester(l.quelle(), l.pointKey(), l.entityId());
                if (mw.isEmpty()) {
                    grund = "kein_wert";
                } else if (mw.get().zeit().isBefore(cutoff)) {
                    grund = "veraltet";
                } else {
                    // Der Anteil (Bindung oder Speicher-Rolle) wird JE ROHWERT geteilt — hier ist es einer.
                    BigDecimal w = BigDecimal.valueOf(
                            MessstelleFormelRegeln.normiere(mw.get().wert(), l.einheit(), RestLive.EINHEIT));
                    if (l.anteil() != null) {
                        w = VerbrauchRegeln.anteilDesWerts(w, l.anteil());
                    }
                    if (!GESAMT.equals(t.anteil())) {
                        w = VerbrauchRegeln.anteilDesWerts(w, t.anteil());
                    }
                    wert = w.doubleValue();
                    juengster = juenger(juengster, mw.get().zeit());
                }
            }
            live.add(new BilanzAbleitung.LiveTerm(t.messstelle(), vorzeichen(t), 1.0, wert, RestLive.EINHEIT, grund));
        }
        BilanzAbleitung.LiveUrteil u = BilanzAbleitung.live(RestLive.EINHEIT, live);
        return new RestLive(x.kennzeichen(), f.terme(), u, u.wert() == null ? null : juengster, null);
    }

    private static final String GESAMT = "gesamt";

    private static String vorzeichen(BilanzAbleitung.RestTerm t) {
        return BilanzAbleitung.ZUFLUSS.equals(t.rolle()) ? "+" : "-";
    }

    /**
     * Der Verlauf eines Rests je 15-min-Bucket: die Terme DES TAGES, an dem der Bucket beginnt, aus der
     * Stellung; je Term die mittlere Wirkleistung seiner Messstelle. {@code null}, wenn in einem Bucket
     * nicht ALLE Terme einen Wert haben. Ein Term, der nur einen ANTEIL liest, hat im Verlauf keinen Wert:
     * ein Anteil wird je Rohwert geteilt, nie je Mittelwert (AP-08 IP-7) — der Bucket bleibt {@code null}.
     */
    private Map<Instant, Double> restVerlauf(UUID hauptzaehlerId, Instant von, Instant bis, ZoneId zone) {
        Map<Instant, Double> out = new TreeMap<>();
        Messstelle x = messstellen.finde(hauptzaehlerId).orElse(null);
        if (x == null) {
            return out;
        }
        BilanzStellungen.Stand stand = stellungen.lesen();
        Map<String, Map<Instant, Double>> jeMessstelle = new java.util.HashMap<>();
        for (LocalDate tag = von.atZone(zone).toLocalDate(); tag.atStartOfDay(zone).toInstant().isBefore(bis);
                tag = tag.plusDays(1)) {
            Instant a = spaeter(von, tag.atStartOfDay(zone).toInstant());
            Instant e = frueher(bis, tag.plusDays(1).atStartOfDay(zone).toInstant());
            BilanzAbleitung.RestFassung f = stand.rest(x.kennzeichen(), tag);
            if (f.fehler() != null || !a.isBefore(e)) {
                continue;
            }
            List<Map<Instant, Double>> proTerm = new ArrayList<>();
            for (BilanzAbleitung.RestTerm t : f.terme()) {
                Map<Instant, Double> roh = GESAMT.equals(t.anteil())
                        ? jeMessstelle.computeIfAbsent(t.messstelle(),
                                kz -> leistungsVerlauf(stand.nachKennzeichen().get(kz), von, bis))
                        : Map.of();
                double vz = "+".equals(vorzeichen(t)) ? 1 : -1;
                Map<Instant, Double> gewichtet = new TreeMap<>();
                roh.forEach((b, w) -> {
                    if (!b.isBefore(a) && b.isBefore(e)) {
                        gewichtet.put(b, vz * w);
                    }
                });
                proTerm.add(gewichtet);
            }
            Set<Instant> alle = new java.util.TreeSet<>();
            proTerm.forEach(map -> alle.addAll(map.keySet()));
            for (Instant b : alle) {
                boolean vollstaendig = proTerm.stream().allMatch(map -> map.containsKey(b));
                out.put(b, vollstaendig ? proTerm.stream().mapToDouble(map -> map.get(b)).sum() : null);
            }
        }
        return out;
    }

    private Map<Instant, Double> leistungsVerlauf(Messstelle q, Instant von, Instant bis) {
        Leistung l = q == null ? null : leistungsKanal(q);
        if (l == null || l.anteil() != null) {
            return Map.of();
        }
        Map<Instant, Double> out = new TreeMap<>();
        werte.verlauf15m(l.quelle(), l.pointKey(), "Momentanwert", von, bis).forEach((b, w) ->
                out.put(b, MessstelleFormelRegeln.normiere(w, l.einheit(), RestLive.EINHEIT)));
        return out;
    }

    /** Die führende Wirkleistung einer Messstelle in der Richtung ihrer Hauptgröße, jetzt, samt Box. */
    private record Leistung(Quelle quelle, String pointKey, String einheit, String anteil, UUID entityId) {}

    private static final String WIRKLEISTUNG = "Wirkleistung";

    private Leistung leistungsKanal(Messstelle q) {
        Instant jetzt = uhr.instant();
        for (MessstelleQuelleRepository.Quelle b : quellen.derMessstelle(q.id())) {
            if (!FUEHREND.equals(b.rolle()) || !WIRKLEISTUNG.equals(b.groesse())
                    || !q.hauptgroesse().richtung().equals(b.richtung())) {
                continue;
            }
            if (b.gueltigAb().isAfter(jetzt) || (b.gueltigBis() != null && !b.gueltigBis().isAfter(jetzt))) {
                continue;
            }
            Optional<Quelle> scope = werte.quelle(b.entityId(), b.kanal());
            if (scope.isPresent()) {
                return new Leistung(scope.get(), b.kanal(), kanalEinheit(b.kanal(), RestLive.EINHEIT), b.anteil(),
                        b.entityId());
            }
        }
        return null;
    }

    /** Der Hauptzähler, wenn die Fassung der Messstelle an dem Tag ein Rest ist. */
    private Optional<UUID> restHauptzaehlerAm(UUID messstelleId, LocalDate tag) {
        return fassungAm(fassungen.wirksame(messstelleId), tag)
                .filter(f -> MessstelleFormelRegeln.REST.equals(f.formelTyp()))
                .flatMap(f -> reste.hauptzaehlerDerFassung(f.id()));
    }

    /** Das Ergebnis von „Rest anlegen“: die Rest-Messstelle und ob sie JETZT entstanden ist. */
    public record RestAngelegt(UUID messstelleId, boolean neu) {}

    /** Die Art, unter der das Protokoll die bestätigte Vorschlags-Anlage nennt ({@code neu.herkunft}). */
    static final String HERKUNFT_VORSCHLAG_REST = "vorschlag_rest_anlegen";

    /**
     * E18 — legt die Rest-Messstelle eines Hauptzählers an, auf den Klick eines Menschen: Kennzeichen
     * automatisch ({@link MessstelleRepository#anlegen}), Name wie übergeben (vorbelegt vom Aufrufer),
     * Urheber im Protokoll {@code angelegt}. NIE ZWEIMAL: unter der Sperre je Hauptzähler wird zuerst
     * nachgesehen; hat er schon einen Rest, entsteht nichts und die vorhandene Messstelle kommt zurück.
     * Der eindeutige Index hinter der Sperre macht auch einen dritten Schreiber zu „schon da“.
     *
     * <p>Geprüft, dass {@code hauptzaehler} an diesem Tag Hauptzähler Bezug der Anlage ist, hat der
     * Aufrufer ({@code BilanzService}) — hier wird nur geschrieben.
     */
    public RestAngelegt restAnlegen(Messstelle hauptzaehler, String name, ProtokollAkteur wer) {
        UUID tenant = TenantContext.get();
        if (tenant == null) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Kein Kundenbereich gewählt.");
        }
        Groesse haupt = MessstelleFormelRegeln.hauptgroesse(MessstelleFormelRegeln.REST, MessstelleRegeln.BERECHNET,
                "Intervallmenge", null).hauptgroesse();
        String medium = medium(haupt.groesse());
        Instant jetzt = minute(uhr.instant());
        try {
            return transaktion.execute(s -> {
                reste.sperren(hauptzaehler.id());
                Optional<BilanzRestRepository.Rest> da = reste.vonHauptzaehler(hauptzaehler.id());
                if (da.isPresent()) {
                    return new RestAngelegt(da.get().messstelleId(), false);
                }
                Messstelle m = messstellen.anlegen(new NeueMessstelle(tenant, null, name, MessstelleRegeln.BERECHNET,
                        medium, haupt, null));
                reste.fassungAnlegen(m.id(), hauptzaehler.id(), uhr.instant(), wer);
                Map<String, Object> neu = new LinkedHashMap<>();
                neu.put("name", name);
                neu.put("art", MessstelleRegeln.BERECHNET);
                neu.put("medium", medium);
                neu.put("hauptgroesse", Map.of("groesse", haupt.groesse(), "richtung", haupt.richtung(),
                        "einheit", haupt.einheit(), "wertart", haupt.wertart()));
                neu.put("formel_typ", MessstelleFormelRegeln.REST);
                neu.put("rest_von", Map.of("id", hauptzaehler.id().toString(), "kennzeichen",
                        hauptzaehler.kennzeichen()));
                neu.put("herkunft", HERKUNFT_VORSCHLAG_REST);
                aenderungen.eintragen(new NeuerEintrag(tenant, m.id(), "angelegt", null, alsJson(neu), jetzt, false,
                        null, wer.sub(), wer.name(), wer.rolle(), wer.art()));
                return new RestAngelegt(m.id(), true);
            });
        } catch (DataIntegrityViolationException e) {
            // Der Index hat einen Schreiber außerhalb der Sperre abgewiesen: dann gibt es den Rest schon.
            return reste.vonHauptzaehler(hauptzaehler.id())
                    .map(r -> new RestAngelegt(r.messstelleId(), false))
                    .orElseThrow(() -> e);
        }
    }

    // ------------------------------------------------------- Eingänge (Zaun)

    /**
     * Die Eingänge einer Zahl (AP-03 R-A3): die Messstellen — über berechnete Eingänge hinweg und bei einem Rest über den
     * Hauptzähler und die Terme seiner Stellung (E3) — und die Komponenten der Messkanal-Terme, auch die eines
     * berechneten Eingangs.
     */
    public record Eingaenge(Set<UUID> messstellen, Set<UUID> komponenten) {}

    /**
     * Die Eingänge, aus denen die Zahl der berechneten Messstelle {@code id} an dem Tag entsteht ({@code am}
     * {@code null} = heute) — für den Zaun der Routen (AP-03 R-A3): wer nicht JEDEN sieht, bekommt die Zahl nicht.
     */
    public Eingaenge eingaenge(UUID id, LocalDate am) {
        LocalDate tag = am != null ? am : heute(zone());
        return eingaenge(id, tag, tag);
    }

    /** Dasselbe über den Zeitraum des Verlaufs ({@code range} wie an {@link #verlauf}). */
    public Eingaenge eingaengeDesVerlaufs(UUID id, String range) {
        ZoneId zone = zone();
        Instant bis = viertelstunde(uhr.instant());
        return eingaenge(id, LocalDate.ofInstant(bis.minus(zeitraum(range)), zone), LocalDate.ofInstant(bis, zone));
    }

    /** Jeder Eingang, der in [{@code von}, {@code bis}] (Tage, beide eingeschlossen) in die Zahl eingeht. Rechnet nichts. */
    public Eingaenge eingaenge(UUID id, LocalDate von, LocalDate bis) {
        Eingaenge out = new Eingaenge(new LinkedHashSet<>(), new LinkedHashSet<>());
        sammle(id, von, bis, out, new HashSet<>());
        return out;
    }

    /**
     * Liegt jeder Eingang im Zugriff (AP-03 R-A3)? Die Messstellen fragt die Route ({@code RechtPruefung#alleLesbar}),
     * die Komponenten der Messkanal-Terme ihr Standort-Zaun: {@link #komponenteSichtbar}. Ohne Kontext und mit einer
     * unternehmensweiten Rolle ist jeder Eingang sichtbar.
     */
    public boolean imZugriff(Eingaenge e, Predicate<Collection<UUID>> messstellenLesbar) {
        return messstellenLesbar.test(e.messstellen()) && e.komponenten().stream().allMatch(this::komponenteSichtbar);
    }

    /**
     * Sieht der Leser die Komponente? RLS {@code site_scope} über {@code measurement_point} — dieselbe Sicht, mit der
     * der Live-Wert ihren Kanal liest ({@link MessstelleFormelWerteRepository#quelle}).
     */
    public boolean komponenteSichtbar(UUID entity) {
        return werte.komponenteGehoert(entity);
    }

    private void sammle(UUID id, LocalDate von, LocalDate bis, Eingaenge out, Set<UUID> besucht) {
        if (!besucht.add(id)) {
            return;
        }
        BilanzStellungen.Stand stand = null;
        for (FassungZeile f : fassungen.wirksame(id)) {
            LocalDate ab = f.gueltigAb() == null || f.gueltigAb().isBefore(von) ? von : f.gueltigAb();
            LocalDate ende = f.gueltigBis() == null || f.gueltigBis().isAfter(bis) ? bis : f.gueltigBis();
            if (ab.isAfter(ende)) {
                continue;
            }
            if (!MessstelleFormelRegeln.REST.equals(f.formelTyp())) {
                for (TermZeile t : terme.derFassung(f.id())) {
                    if (t.quellMessstelleId() != null) {
                        out.messstellen().add(t.quellMessstelleId());
                        sammle(t.quellMessstelleId(), von, bis, out, besucht);
                    } else if (t.entityId() != null) {
                        out.komponenten().add(t.entityId());
                    }
                }
                continue;
            }
            Optional<UUID> haupt = reste.hauptzaehlerDerFassung(f.id());
            Messstelle x = haupt.flatMap(messstellen::finde).orElse(null);
            if (x == null) {
                continue;
            }
            out.messstellen().add(x.id());
            stand = stand != null ? stand : stellungen.lesen();
            for (LocalDate tag = ab; !tag.isAfter(ende); tag = tag.plusDays(1)) {
                BilanzAbleitung.RestFassung r = stand.rest(x.kennzeichen(), tag);
                if (r.fehler() == null) {
                    for (BilanzAbleitung.RestTerm t : r.terme()) {
                        Messstelle q = stand.nachKennzeichen().get(t.messstelle());
                        if (q != null) {
                            out.messstellen().add(q.id());
                        }
                    }
                }
            }
        }
    }

    // --------------------------------------------------------------- Verlauf

    /**
     * Der Verlauf: je 15-min-Bucket die Summe der Fassung, die am Tag des Buckets gilt — {@code null},
     * wenn in ihm nicht ALLE Terme dieser Fassung einen Wert haben (nie eine Teilsumme).
     */
    public MessstelleFormelDto.Verlauf verlauf(UUID id, String range) {
        Messstelle m = berechnete(id);
        Instant bis = viertelstunde(uhr.instant());
        Instant von = bis.minus(zeitraum(range));
        List<MessstelleFormelDto.VerlaufPunkt> punkte = new ArrayList<>();
        for (Map.Entry<Instant, Double> e : summenVerlauf(m, von, bis, zone(), new HashSet<>(List.of(id)), 0)
                .entrySet()) {
            punkte.add(new MessstelleFormelDto.VerlaufPunkt(zeit(e.getKey()),
                    e.getValue() == null ? null : runde(e.getValue())));
        }
        String einheit = restHauptzaehlerAm(id, heute(zone())).isPresent() ? RestLive.EINHEIT
                : m.hauptgroesse().einheit();
        return new MessstelleFormelDto.Verlauf(id, einheit, punkte);
    }

    /**
     * Je Bucket in {@code [von, bis)} die Summe der Terme der Fassung DES TAGES, an dem der Bucket
     * beginnt; {@code null}, wenn in ihm nicht alle Terme dieser Fassung einen Wert haben. Nur
     * Buckets, in denen mindestens ein Term einen Wert hat. Jede Fassung liest nur die Buckets
     * IHRER Tage — eine Fassung gilt ab ihrem Tag und nie rückwärts.
     */
    private TreeMap<Instant, Double> summenVerlauf(Messstelle m, Instant von, Instant bis, ZoneId zone,
            Set<UUID> besucht, int tiefe) {
        TreeMap<Instant, Double> out = new TreeMap<>();
        for (FassungZeile f : fassungen.wirksame(m.id())) {
            if (MessstelleFormelRegeln.SALDO.equals(f.formelTyp())) continue; // Mengen nur aus AP-08-Perioden.
            Instant a = f.gueltigAb() == null ? von : spaeter(von, f.gueltigAb().atStartOfDay(zone).toInstant());
            Instant e = f.gueltigBis() == null ? bis
                    : frueher(bis, f.gueltigBis().plusDays(1).atStartOfDay(zone).toInstant());
            if (!a.isBefore(e)) {
                continue;
            }
            Optional<UUID> restVon = MessstelleFormelRegeln.REST.equals(f.formelTyp())
                    ? reste.hauptzaehlerDerFassung(f.id()) : Optional.empty();
            if (restVon.isPresent()) {
                out.putAll(restVerlauf(restVon.get(), a, e, zone));
                continue;
            }
            List<Map<Instant, Double>> proTerm = termVerlaeufe(m, terme.derFassung(f.id()), a, e, zone, besucht,
                    tiefe);
            // Ein Bucket zählt nur, wenn ALLE Terme in ihm einen Wert haben — sonst null (nie Teilsumme).
            Set<Instant> alle = new java.util.TreeSet<>();
            proTerm.forEach(map -> alle.addAll(map.keySet()));
            for (Instant b : alle) {
                boolean vollstaendig = proTerm.stream().allMatch(map -> map.containsKey(b));
                Double summe = null;
                if (vollstaendig) {
                    double s = 0;
                    for (Map<Instant, Double> map : proTerm) {
                        s += map.get(b);
                    }
                    summe = s;
                }
                out.put(b, summe);
            }
        }
        return out;
    }

    /** Je Term eine Bucket→Wert-Karte (Vorzeichen · Faktor · normiert), nur wo es einen Wert gibt. */
    private List<Map<Instant, Double>> termVerlaeufe(Messstelle m, List<TermZeile> zeilen, Instant von,
            Instant bis, ZoneId zone, Set<UUID> besucht, int tiefe) {
        String ziel = m.hauptgroesse().einheit();
        String wertart = m.hauptgroesse().wertart();
        List<Map<Instant, Double>> out = new ArrayList<>();
        for (TermZeile t : zeilen) {
            double vz = ("-".equals(t.vorzeichen()) ? -1 : 1) * t.faktor();
            Map<Instant, Double> roh;
            String von_einheit = ziel;
            // Der Anteil gilt je TAG des Buckets (Zeitzone des Standorts) — nie der von heute.
            Map<LocalDate, AnteilLeseweg.Lesung> jeTag = new java.util.HashMap<>();
            if (MESSKANAL.equals(t.eingangArt())) {
                Optional<Quelle> q = werte.quelle(t.entityId(), t.pointKey());
                roh = q.isEmpty() ? Map.of() : werte.verlauf15m(q.get(), t.pointKey(), wertart, von, bis);
                von_einheit = kanalEinheit(t.pointKey(), ziel);
            } else {
                roh = bausteinVerlauf(t.quellMessstelleId(), wertart, von, bis, zone, besucht, tiefe);
            }
            Map<Instant, Double> gewichtet = new TreeMap<>();
            for (Map.Entry<Instant, Double> e : roh.entrySet()) {
                AnteilLeseweg.Lesung lesung = jeTag.computeIfAbsent(
                        e.getKey().atZone(zone).toLocalDate(), tag -> lesung(t, tag));
                Double wert = e.getValue();
                if (!lesung.ganz()) {
                    // Wartet der Anteil (oder gibt es am Tag keinen), hat der Term im Bucket keinen
                    // Wert — der Bucket wird null, nie eine Teilsumme.
                    BigDecimal menge = lesung.urteil(BigDecimal.valueOf(wert)).menge();
                    if (menge == null) {
                        continue;
                    }
                    wert = menge.doubleValue();
                }
                gewichtet.put(e.getKey(), vz * MessstelleFormelRegeln.normiere(wert, von_einheit, ziel));
            }
            out.add(gewichtet);
        }
        return out;
    }

    /**
     * Der Verlauf eines Baustein-Terms: nur VOLLSTÄNDIGE Buckets (Bucket→Summe), sonst fehlt er.
     * Eine berechnete Quelle rechnet mit IHREN Fassungen je Tag.
     */
    private Map<Instant, Double> bausteinVerlauf(UUID quellId, String wertart, Instant von, Instant bis,
            ZoneId zone, Set<UUID> besucht, int tiefe) {
        if (tiefe >= MAX_TIEFE || !besucht.add(quellId)) {
            return Map.of();
        }
        try {
            Messstelle q = messstellen.finde(quellId).orElse(null);
            if (q == null) {
                return Map.of();
            }
            if (MessstelleRegeln.BERECHNET.equals(q.art())) {
                Map<Instant, Double> out = new TreeMap<>();
                summenVerlauf(q, von, bis, zone, besucht, tiefe + 1).forEach((b, summe) -> {
                    if (summe != null) {
                        out.put(b, summe);
                    }
                });
                return out;
            }
            KanalRef ref = fuehrenderKanal(q);
            if (ref == null) {
                return Map.of();
            }
            Map<Instant, Double> roh = werte.verlauf15m(ref.quelle(), ref.pointKey(),
                    q.hauptgroesse().wertart(), von, bis);
            Map<Instant, Double> out = new TreeMap<>();
            roh.forEach((b, w) -> out.put(b, MessstelleFormelRegeln.normiere(w, ref.einheit(),
                    q.hauptgroesse().einheit())));
            return out;
        } finally {
            besucht.remove(quellId);
        }
    }

    // ----------------------------------------------------------------- Helfer

    /** Ein aufgelöster Messkanal einer gemessenen Messstelle. */
    private record KanalRef(Quelle quelle, String pointKey, String einheit, UUID entityId) {}

    /** Die führende Quelle der Hauptgröße, die jetzt gilt, auf ihre lesende Box aufgelöst. */
    private KanalRef fuehrenderKanal(Messstelle q) {
        Instant jetzt = uhr.instant();
        Groesse h = q.hauptgroesse();
        for (MessstelleQuelleRepository.Quelle b : quellen.derMessstelle(q.id())) {
            if (!FUEHREND.equals(b.rolle()) || !h.groesse().equals(b.groesse())
                    || !h.richtung().equals(b.richtung())) {
                continue;
            }
            if (b.gueltigAb().isAfter(jetzt) || (b.gueltigBis() != null && !b.gueltigBis().isAfter(jetzt))) {
                continue;
            }
            Optional<Quelle> scope = werte.quelle(b.entityId(), b.kanal());
            if (scope.isPresent()) {
                return new KanalRef(scope.get(), b.kanal(), kanalEinheit(b.kanal(), h.einheit()), b.entityId());
            }
        }
        return null;
    }

    private Messstelle berechnete(UUID id) {
        Messstelle m = messstellen.finde(id).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Messstelle nicht gefunden."));
        if (!MessstelleRegeln.BERECHNET.equals(m.art())) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Keine berechnete Messstelle.");
        }
        return m;
    }

    /**
     * Die Vertrags-Größe eines Formel-Eingangs; {@code null}, wenn er nicht zulässig ist
     * (keine Größe/Richtung oder neuer Vorzeichen-Netzterm; Anteile liest nur die Quellenbindung).
     * Die Wertart ist
     * die VERTRAGS-Wertart (Momentanwert · Zählerstand · Intervallmenge), abgeleitet aus der Größe
     * und der Wertart des KANALS ({@code gauge}/{@code counter}) — nicht die des Kanals selbst.
     */
    private Groesse kanalGroesse(String pointKey, boolean giltAlsErzeugung, boolean gespeicherterTerm) {
        Point p = katalog.resolve(pointKey);
        Semantik s = katalog.semantik(pointKey);
        if (p == null || s == null) {
            return null;
        }
        // W1: Anteile von Vorzeichen-Netzkanälen liest nur die Quellenbindung. Ein bereits
        // gespeicherter Term mit Haken behält seine bisherige Erzeugungs-Richtung.
        // Keine Umdeutung beim GET, keine Bestandsmigration; neue Terme bleiben gesperrt.
        boolean vorzeichenNetz = "import_export".equals(s.direction());
        if (vorzeichenNetz && !(gespeicherterTerm && giltAlsErzeugung)) {
            return null;
        }
        String groesse = MesskanalAbbildung.groesse(s.quantity());
        // AP-08: ein richtungsloser Kanal (Katalog ohne Richtung) traegt mit gesetztem Haken die
        // Richtung Erzeugung — sonst bleibt er ohne Richtung und kann kein Term sein.
        String richtung = MessstelleFormelRegeln.richtungMitErzeugungsHaken(
                vorzeichenNetz ? null : MesskanalAbbildung.richtung(s.direction()), giltAlsErzeugung);
        String kanalWertart = MesskanalAbbildung.wertart(p.aggregationKind());
        if (groesse == null || richtung == null || kanalWertart == null || p.unit() == null) {
            return null;
        }
        String wertart = vertragsWertart(groesse, kanalWertart);
        if (wertart == null) {
            return null;
        }
        return new Groesse(groesse, richtung, p.unit(), wertart);
    }

    /** Die Katalog-Richtung eines Messkanals (oder {@code null}, wenn der Katalog keine gibt). */
    private String kanalRichtung(String pointKey) {
        Semantik s = katalog.semantik(pointKey);
        return s == null ? null : MesskanalAbbildung.richtung(s.direction());
    }

    /** Die Vertrags-Wertart: eine Momentan-Größe ist Momentanwert; ein Zähler ist Zählerstand,
     * eine Leistung als Menge Intervallmenge (wie die Herleitung der Quellenbindung, Regel 7). */
    private static String vertragsWertart(String groesse, String kanalWertart) {
        for (MessstelleRegeln.KatalogEintrag e : MessstelleRegeln.GROESSEN_KATALOG) {
            if (!e.groesse().equals(groesse)) {
                continue;
            }
            if (e.wertarten().contains("Momentanwert")) {
                return "Momentanwert";
            }
            return "counter".equals(kanalWertart) ? "Zählerstand" : "Intervallmenge";
        }
        return null;
    }

    private static MessstelleFormelDto.Groesse dtoGroesse(Groesse g) {
        return g == null ? null
                : new MessstelleFormelDto.Groesse(g.groesse(), g.richtung(), g.einheit(), g.wertart());
    }

    private Groesse groesse(TermZeile t) {
        if (MESSKANAL.equals(t.eingangArt())) {
            return kanalGroesse(t.pointKey(), t.giltAlsErzeugung(), true);
        }
        return messstellen.finde(t.quellMessstelleId()).map(Messstelle::hauptgroesse).orElse(null);
    }

    private boolean eingerichtet(TermZeile t) {
        if (MESSKANAL.equals(t.eingangArt())) {
            return werte.quelle(t.entityId(), t.pointKey()).isPresent();
        }
        return messstellen.finde(t.quellMessstelleId())
                .map(q -> q.archiviertAm() == null).orElse(false);
    }

    private String kanalEinheit(String pointKey, String ersatz) {
        Point p = katalog.resolve(pointKey);
        return p == null || p.unit() == null ? ersatz : p.unit();
    }

    private static String medium(String groesse) {
        return MessstelleRegeln.GROESSEN_KATALOG.stream()
                .filter(e -> e.groesse().equals(groesse)).findFirst()
                .map(e -> e.medien().get(0)).orElse("Strom");
    }

    private void protokoll(UUID id, String name, String medium, Groesse haupt, List<Bindung> bindungen,
            String notiz, Instant jetzt, ProtokollAkteur wer) {
        Map<String, Object> neu = new LinkedHashMap<>();
        neu.put("name", name);
        neu.put("art", "berechnet");
        neu.put("medium", medium);
        neu.put("hauptgroesse", Map.of("groesse", haupt.groesse(), "richtung", haupt.richtung(),
                "einheit", haupt.einheit(), "wertart", haupt.wertart()));
        neu.put("formel", termeJson(bindungen));
        neu.put("notiz", notiz);
        aenderungen.eintragen(new NeuerEintrag(TenantContext.get(), id, "angelegt", null, alsJson(neu),
                jetzt, false, null, wer.sub(), wer.name(), wer.rolle(), wer.art()));
    }

    private static List<Map<String, Object>> termeJson(List<Bindung> bindungen) {
        List<Map<String, Object>> formel = new ArrayList<>();
        for (Bindung b : bindungen) {
            Map<String, Object> term = new LinkedHashMap<>();
            term.put("eingang_art", b.eingangArt());
            term.put("entity_id", b.entityId() == null ? null : b.entityId().toString());
            term.put("point_key", b.pointKey());
            term.put("quell_messstelle_id",
                    b.quellMessstelleId() == null ? null : b.quellMessstelleId().toString());
            term.put("vorzeichen", b.vorzeichen());
            term.put("faktor", b.faktor());
            if (b.giltAlsErzeugung()) {
                term.put("gilt_als_erzeugung", true);
            }
            // AP-10 IP-5: nur, wenn der Term sie trägt — ein Term ohne sie protokolliert wie vorher.
            if (b.verteilungZiel() != null) {
                term.put("verteilung_ziel", b.verteilungZiel().toString());
            }
            if (b.anteil() != null) {
                term.put("anteil", b.anteil());
            }
            formel.add(term);
        }
        return formel;
    }

    private String alsJson(Object o) {
        try {
            return json.writeValueAsString(o);
        } catch (Exception e) {
            throw new IllegalStateException("Konnte den Protokolleintrag nicht schreiben", e);
        }
    }

    private static Duration zeitraum(String range) {
        return switch (range == null ? "24h" : range) {
            case "24h" -> Duration.ofHours(24);
            case "7d" -> Duration.ofDays(7);
            case "30d" -> Duration.ofDays(30);
            default -> throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unbekannter Zeitraum.");
        };
    }

    /** Wie der Term an dem Tag seinen Anteil liest — die EINE Stelle ist {@link AnteilLeseweg#lies}. */
    private AnteilLeseweg.Lesung lesung(TermZeile t, LocalDate tag) {
        return leseweg.lies(t.eingangArt(), t.anteil(), t.quellMessstelleId(), t.verteilungZiel(), tag);
    }

    /** Die Terme der Fassung, die an dem Tag gilt — leer, wenn an dem Tag keine gilt. */
    private List<TermZeile> termeAm(UUID messstelleId, LocalDate tag) {
        return fassungAm(fassungen.wirksame(messstelleId), tag).map(f -> terme.derFassung(f.id())).orElse(List.of());
    }

    private static Optional<FassungZeile> fassungAm(List<FassungZeile> wirksam, LocalDate tag) {
        return MessstelleFormelRegeln.fassungAm(wirksam.stream().map(FassungZeile::alsRegel).toList(), tag)
                .flatMap(r -> wirksam.stream().filter(f -> f.nummer() == r.nummer()).findFirst());
    }

    /**
     * Die Zeitzone, in der die Tage zählen: die des Unternehmens (die zulässigen Zeitzonen der
     * Standorte haben dieselben Regeln, {@link MessstelleService#ZEITZONE}) — ohne Unternehmen-Zeile
     * die Vorgabe.
     */
    private ZoneId zone() {
        return unternehmen.desKundenbereichs().map(u -> ZoneId.of(u.zeitzone())).orElse(MessstelleService.ZEITZONE);
    }

    private LocalDate heute(ZoneId zone) {
        return uhr.instant().atZone(zone).toLocalDate();
    }

    private static Instant spaeter(Instant a, Instant b) {
        return b.isAfter(a) ? b : a;
    }

    private static Instant frueher(Instant a, Instant b) {
        return b.isBefore(a) ? b : a;
    }

    private static String sqlState(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof java.sql.SQLException q && q.getSQLState() != null) {
                return q.getSQLState();
            }
        }
        return null;
    }

    /**
     * GENAU EIN Eintrag je eingetragener Fassung: {@code alt} = die beendete Fassung (Nummer, Tage),
     * {@code neu} = die neue mit ihren Termen; {@code gilt_ab} ist Mitternacht ihres ersten Tages,
     * {@code rueckwirkend} das Urteil der Regel.
     */
    private void fassungProtokoll(UUID id, FassungZeile alt, FassungUrteil u, int nummer, String typ,
            List<Bindung> bindungen,
            ZoneId zone, Instant jetzt, String begruendung, ProtokollAkteur wer) {
        Map<String, Object> vorher = null;
        if (alt != null) {
            vorher = new LinkedHashMap<>();
            vorher.put("fassung", alt.nummer());
            vorher.put("gueltig_ab", alt.gueltigAb() == null ? null : alt.gueltigAb().toString());
            vorher.put("gueltig_bis", u.beendenAm().toString());
        }
        Map<String, Object> neu = new LinkedHashMap<>();
        neu.put("fassung", nummer);
        neu.put("formel_typ", typ);
        neu.put("gueltig_ab", u.ab().toString());
        neu.put("formel", termeJson(bindungen));
        aenderungen.eintragen(new NeuerEintrag(TenantContext.get(), id, PROTOKOLL_ART,
                vorher == null ? null : alsJson(vorher), alsJson(neu), u.ab().atStartOfDay(zone).toInstant(),
                u.rueckwirkend(), begruendung, wer.sub(), wer.name(), wer.rolle(), wer.art()));
    }

    private static Instant juenger(Instant a, Instant b) {
        return a == null || (b != null && b.isAfter(a)) ? b : a;
    }

    private static Instant minute(Instant t) {
        return t.truncatedTo(ChronoUnit.MINUTES);
    }

    private static Instant viertelstunde(Instant t) {
        long sekunden = 15 * 60;
        return Instant.ofEpochSecond(t.getEpochSecond() / sekunden * sekunden);
    }

    private static double runde(double wert) {
        double faktor = Math.pow(10, MessstelleFormelRegeln.SUMME_NACHKOMMASTELLEN);
        return Math.round(wert * faktor) / faktor;
    }

    private static OffsetDateTime zeit(Instant t) {
        return OffsetDateTime.ofInstant(t, MessstelleService.ZEITZONE);
    }

    private static String leerAlsNull(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }

    private static MessstelleFormelDto.FehlenderTerm fehlt(TermZeile t, String grund) {
        return new MessstelleFormelDto.FehlenderTerm(t.position(), grund);
    }
}
