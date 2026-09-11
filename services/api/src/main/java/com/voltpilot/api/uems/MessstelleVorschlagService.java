package com.voltpilot.api.uems;

import com.voltpilot.api.entities.EntityTypeCatalog;
import com.voltpilot.api.measurement.MesskanalService;
import com.voltpilot.api.topology.TopologyDeriver;
import com.voltpilot.api.topology.TopologyService;
import com.voltpilot.api.uems.MessstelleRegeln.VorschlagAnlage;
import com.voltpilot.api.uems.MessstelleRegeln.VorschlagEingang;
import com.voltpilot.api.uems.MessstelleRegeln.VorschlagHauptzaehler;
import com.voltpilot.api.uems.MessstelleRegeln.VorschlagKanal;
import com.voltpilot.api.uems.MessstelleRegeln.VorschlagKomponente;
import com.voltpilot.api.uems.MessstelleRegeln.VorschlagStandort;
import com.voltpilot.api.uems.MessstelleRegeln.VorschlagZeile;
import com.voltpilot.api.uems.MessstelleRegeln.Vorschlagsliste;
import com.voltpilot.api.uems.MessstelleZuordnungRepository.StellungZeile;
import com.voltpilot.api.web.dto.MessstelleDto;
import com.voltpilot.api.web.dto.MessstelleQuelleDto;
import com.voltpilot.api.web.dto.MessstelleVorschlagDto;
import com.voltpilot.api.web.dto.MesskanalDto;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Vorschlagsliste der BESTANDSÜBERNAHME je Standort (UEMS AP-04 IP-16, Konzept §5.10/§5.15,
 * Entscheid E6, Abnahme A9): aus den Komponenten der Anlagen eines Standorts und ihren
 * Messkanälen wird je Komponente und Fluss höchstens EIN Vorschlag — und erst die Bestätigung
 * legt Messstellen an.
 *
 * <p><b>Keine zweite Regel.</b> Was vorgeschlagen wird, entscheidet allein
 * {@link MessstelleRegeln#vorschlagsliste} (Vektoren: Familie {@code vorschlag}, Zwilling
 * {@code frontend/portal/src/uemsMessstelle.ts}). Dieser Dienst sammelt die Eingänge — den
 * Standort und seine Anlagen ({@link StandortLesemodellService}), die Komponenten mit ihren
 * Messkanälen ({@link MesskanalService}), das Gerät, das sie speist ({@link GeraetRepository}),
 * die Topologie-Rolle „Netzmessung“ ({@link TopologyService}) und die schon gebundenen Messwerte
 * ({@link MessstelleQuelleRepository}) — und schreibt mit den vorhandenen Bausteinen:
 * {@link MessstelleService#anlegen}, {@link MessstelleZuordnungService#ortZuordnen} und
 * {@code stellungZuordnen}, {@link MessstelleQuelleService#binden}. Jede Regel dieser Wege
 * (Kennzeichen, Passung, Gerät zum Zeitpunkt, Regel 8) gilt unverändert.
 *
 * <p><b>Die Übernahme läuft in EINER Transaktion</b> (Zeile für Zeile in der Reihenfolge der
 * Liste, Hauptzähler zuerst): Messstelle, Ort ab dem Verlaufsbeginn, führende Quelle ab dem
 * Verlaufsbeginn (rückwirkend, Herkunft {@code bestandsuebernahme}), die Nebengrößen und zuletzt
 * die Stellung. Scheitert eine Zeile, entsteht keine.
 *
 * <p><b>Bestätigt wird nur, was gezeigt wurde:</b> eine Zeile, die es so nicht mehr gibt, ist 409
 * {@code vorschlag_geaendert}; ein Messwert, der inzwischen dieselbe Messstelle speist, zählt als
 * unverändert — ein zweiter Aufruf legt nichts an (A9).
 *
 * <p><b>An der Anlage ändert sich nichts:</b> gelesen werden Komponenten, Mess-Selektion, Geräte
 * und Topologie; geschrieben wird ausschließlich in die {@code messstelle*}-Tabellen. Kein Push,
 * kein Flow, kein Fahrplan liest eine ihrer Spalten.
 *
 * <p><b>Rechte:</b> bis AP-03 durchsetzt {@code authenticated()} plus die Mandanten-RLS — ein
 * fremder Standort ist 404, nie 403. Die Freischaltung „nur mit Messen &amp; Auswerten“ (E6)
 * hängt an den Funktions-Objekten aus AP-01 IP-2 und kommt mit ihnen.
 */
@Service
public class MessstelleVorschlagService {

    private static final String GEMESSEN = "gemessen";
    private static final String STROM = "Strom";
    private static final String HAUPTZAEHLER = "Hauptzähler";
    private static final String FUEHREND = "fuehrend";
    private static final String HAUS = "house-load";
    private static final String ZAEHLER_KATEGORIE = "meter";

    private final StandortLesemodellService standorte;
    private final StandortService standortDienst;
    private final MessstelleRepository messstellen;
    private final MessstelleQuelleRepository quellenRepo;
    private final MessstelleZuordnungRepository zuordnungenRepo;
    private final MessstelleService messstellenDienst;
    private final MessstelleZuordnungService zuordnungen;
    private final MessstelleQuelleService quellen;
    private final MesskanalService messkanaele;
    private final GeraetRepository geraete;
    private final TopologyService topologie;
    private final EntityTypeCatalog typen;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaktion;

    public MessstelleVorschlagService(StandortLesemodellService standorte, StandortService standortDienst,
            MessstelleRepository messstellen, MessstelleQuelleRepository quellenRepo,
            MessstelleZuordnungRepository zuordnungenRepo, MessstelleService messstellenDienst,
            MessstelleZuordnungService zuordnungen, MessstelleQuelleService quellen,
            MesskanalService messkanaele, GeraetRepository geraete, TopologyService topologie,
            EntityTypeCatalog typen, JdbcTemplate jdbc, PlatformTransactionManager transaktionen) {
        this.standorte = standorte;
        this.standortDienst = standortDienst;
        this.messstellen = messstellen;
        this.quellenRepo = quellenRepo;
        this.zuordnungenRepo = zuordnungenRepo;
        this.messstellenDienst = messstellenDienst;
        this.zuordnungen = zuordnungen;
        this.quellen = quellen;
        this.messkanaele = messkanaele;
        this.geraete = geraete;
        this.topologie = topologie;
        this.typen = typen;
        this.jdbc = jdbc;
        this.transaktion = new TransactionTemplate(transaktionen);
    }

    // ------------------------------------------------------------------ lesen

    /** Die Vorschlagsliste des Standorts — schreibt nichts. */
    public MessstelleVorschlagDto.Liste vorschlag(UUID standortId) {
        return darstellung(lage(standortId));
    }

    // ------------------------------------------------------------- übernehmen

    /**
     * Schreibt die bestätigten Zeilen. Je Zeile in DERSELBEN Transaktion: Messstelle (Kennzeichen
     * vom Server), Ort = Standort ab dem Verlaufsbeginn, führende Quelle ab dem Verlaufsbeginn
     * (rückwirkend, Herkunft „Bestandsübernahme“), die Nebengrößen und zuletzt die Stellung.
     */
    public MessstelleVorschlagDto.Uebernommen uebernehmen(UUID standortId,
            MessstelleVorschlagDto.Uebernehmen u, ProtokollAkteur wer) {
        List<MessstelleVorschlagDto.Bestaetigt> bestaetigt = gepruefteAnfrage(u);
        Ergebnis e;
        try {
            e = transaktion.execute(s -> inDerTransaktion(standortId, bestaetigt, wer));
        } catch (MessstelleAbgelehnt | ResponseStatusException ex) {
            throw ex;
        } catch (DataAccessException ex) {
            // Ein gleichzeitiger Schreiber hat die Lage verändert (Kennzeichen, Quelle, Stellung):
            // nichts ist geschrieben, die Liste ist neu zu laden.
            throw MessstelleAbgelehnt.schnittstelle(MessstelleAbgelehnt.Schnittstelle.VORSCHLAG_GEAENDERT,
                    "Die Vorschlagsliste hat sich soeben geändert — bitte neu laden.", Map.of());
        }
        return new MessstelleVorschlagDto.Uebernommen(e.neu(), e.unveraendert(),
                e.messstellen().stream().map(messstellenDienst::eine).toList());
    }

    private record Ergebnis(int neu, int unveraendert, List<UUID> messstellen) {}

    private Ergebnis inDerTransaktion(UUID standortId, List<MessstelleVorschlagDto.Bestaetigt> bestaetigt,
            ProtokollAkteur wer) {
        sperre(standortId);
        Lage lage = lage(standortId);
        Map<String, UUID> schon = new LinkedHashMap<>();
        Map<String, MessstelleVorschlagDto.Bestaetigt> neu = new LinkedHashMap<>();
        for (MessstelleVorschlagDto.Bestaetigt b : bestaetigt) {
            Optional<UUID> uebernommen = schonUebernommen(b);
            if (uebernommen.isPresent()) {
                schon.put(schluessel(b.komponente().toString(), b.kanal()), uebernommen.get());
                continue;
            }
            VorschlagZeile z = lage.liste().vorschlaege().stream()
                    .filter(x -> x.komponente().equals(b.komponente().toString())
                            && x.quelle().kanal().equals(b.kanal()))
                    .findFirst()
                    .orElseThrow(() -> geaendert(b));
            if (!wieGezeigt(z, b)) {
                throw geaendert(b);
            }
            neu.put(schluessel(z.komponente(), z.quelle().kanal()), b);
        }

        // Geschrieben wird in der Reihenfolge der Liste: so vergibt der Zähler die Kennzeichen,
        // die das GET gezeigt hat, und ein Unterzähler findet seinen Hauptzähler schon vor.
        Map<String, UUID> angelegt = new LinkedHashMap<>();
        for (VorschlagZeile z : lage.liste().vorschlaege()) {
            String schluessel = schluessel(z.komponente(), z.quelle().kanal());
            if (neu.containsKey(schluessel)) {
                angelegt.put(schluessel, schreibe(lage, z, neu.get(schluessel), angelegt, wer));
            }
        }
        List<UUID> ergebnis = bestaetigt.stream()
                .map(b -> schluessel(b.komponente().toString(), b.kanal()))
                .map(s -> schon.containsKey(s) ? schon.get(s) : angelegt.get(s))
                .toList();
        return new Ergebnis(angelegt.size(), schon.size(), ergebnis);
    }

    /** Eine Zeile: Messstelle, Ort, führende Quelle, Nebengrößen, Stellung — in dieser Reihenfolge. */
    private UUID schreibe(Lage lage, VorschlagZeile z, MessstelleVorschlagDto.Bestaetigt b,
            Map<String, UUID> angelegt, ProtokollAkteur wer) {
        String name = b.name() == null || b.name().isBlank() ? z.name() : b.name().strip();
        MessstelleDto.Messstelle m = messstellenDienst.anlegen(new MessstelleDto.Anlegen(null, name, GEMESSEN,
                STROM, dtoGroesse(z.hauptgroesse()),
                z.nebengroessen().stream().map(n -> dtoGroesse(n.groesse())).toList(), null),
                wer, MessstelleService.HERKUNFT_BESTAND);
        LocalDate ab = z.ab().atZoneSameInstant(lage.zone()).toLocalDate();
        zuordnungen.ortZuordnen(m.id(), new MessstelleDto.OrtAendern(lage.standortKennzeichen(), ab, false,
                MessstelleService.HERKUNFT_GRUND), wer);
        binde(m.id(), z.hauptgroesse(), z.quelle().kanal(), z.komponente(), z.ab(), wer);
        for (MessstelleRegeln.VorschlagNebengroesse n : z.nebengroessen()) {
            binde(m.id(), n.groesse(), n.quelle().kanal(), z.komponente(), z.ab(), wer);
        }
        if (z.stellung() != null) {
            String bezug = bezug(z, angelegt);
            zuordnungen.stellungZuordnen(m.id(), new MessstelleDto.StellungAendern(UUID.fromString(z.anlage()),
                    z.stellung(), bezug, z.stellungAb(), false, MessstelleService.HERKUNFT_GRUND), wer);
        }
        return m.id();
    }

    private void binde(UUID messstelle, MessstelleRegeln.Groesse g, String kanal, String komponente,
            OffsetDateTime ab, ProtokollAkteur wer) {
        quellen.binden(messstelle, new MessstelleQuelleDto.Binden(
                new MessstelleQuelleDto.GroesseWahl(g.groesse(), g.richtung()), UUID.fromString(komponente),
                kanal, FUEHREND, null, ab, null, null, null, MessstelleService.HERKUNFT_GRUND),
                wer, MessstelleService.HERKUNFT_BESTAND);
    }

    /** Das Kennzeichen des Hauptzählers, auf den „Unterzähler von“ zeigt — bestehend oder eben angelegt. */
    private String bezug(VorschlagZeile z, Map<String, UUID> angelegt) {
        MessstelleRegeln.VorschlagBezug b = z.unterzaehlerVon();
        if (b == null) {
            return null;
        }
        if (b.bestehend()) {
            return b.messstelle();
        }
        UUID id = angelegt.get(schluessel(b.komponente(), b.kanal()));
        if (id != null) {
            return messstellen.finde(id).map(MessstelleRepository.Messstelle::kennzeichen).orElseThrow();
        }
        throw MessstelleAbgelehnt.regel(MessstelleRegeln.Fehler.STELLUNG_UNGUELTIG,
                "„" + z.name() + "“ ist als Unterzähler von " + b.messstelle()
                        + " vorgeschlagen — übernehmen Sie diesen Hauptzähler mit.",
                Map.of("grund", "bezug_fehlt", "komponente", z.komponente(), "kanal", z.quelle().kanal(),
                        "hauptzaehler", b.messstelle()));
    }

    /**
     * Speist dieser Messwert schon GENAU diese Messstelle (führend, Hauptgröße wie gezeigt)? Dann
     * ist die Zeile längst übernommen und zählt als unverändert; speist er eine ANDERE, hat sich
     * der Vorschlag geändert.
     */
    private Optional<UUID> schonUebernommen(MessstelleVorschlagDto.Bestaetigt b) {
        Instant jetzt = Instant.now();
        for (MessstelleQuelleRepository.Quelle q : quellenRepo.alle()) {
            if (!q.entityId().equals(b.komponente()) || !q.kanal().equals(b.kanal())
                    || !FUEHREND.equals(q.rolle()) || (q.gueltigBis() != null && !q.gueltigBis().isAfter(jetzt))) {
                continue;
            }
            MessstelleRepository.Messstelle m = messstellen.finde(q.messstelleId()).orElse(null);
            if (m != null && b.hauptgroesse() != null
                    && m.hauptgroesse().groesse().equals(b.hauptgroesse().groesse())
                    && m.hauptgroesse().richtung().equals(b.hauptgroesse().richtung())) {
                return Optional.of(m.id());
            }
            throw geaendert(b);
        }
        return Optional.empty();
    }

    /** Ist die Zeile noch die gezeigte? Größe, Nebengrößen, Stellung und Beginn müssen stimmen. */
    private static String schluessel(String komponente, String kanal) {
        return komponente + "|" + kanal;
    }

    private static boolean wieGezeigt(VorschlagZeile z, MessstelleVorschlagDto.Bestaetigt b) {
        if (!gleich(z.hauptgroesse(), b.hauptgroesse()) || !Objects.equals(z.stellung(), b.stellung())) {
            return false;
        }
        if (b.ab() == null || !b.ab().toInstant().equals(z.ab().toInstant())) {
            return false;
        }
        List<MessstelleVorschlagDto.Nebengroesse> neben =
                b.nebengroessen() == null ? List.of() : b.nebengroessen();
        if (neben.size() != z.nebengroessen().size()) {
            return false;
        }
        for (int i = 0; i < neben.size(); i++) {
            MessstelleRegeln.VorschlagNebengroesse n = z.nebengroessen().get(i);
            if (!gleich(n.groesse(), neben.get(i).groesse())
                    || neben.get(i).quelle() == null
                    || !n.quelle().kanal().equals(neben.get(i).quelle().kanal())) {
                return false;
            }
        }
        return true;
    }

    private static boolean gleich(MessstelleRegeln.Groesse g, MessstelleDto.Groesse d) {
        return d != null && g.groesse().equals(d.groesse()) && g.richtung().equals(d.richtung())
                && g.einheit().equals(d.einheit()) && g.wertart().equals(d.wertart());
    }

    private static MessstelleAbgelehnt geaendert(MessstelleVorschlagDto.Bestaetigt b) {
        Map<String, Object> fakten = new LinkedHashMap<>();
        fakten.put("komponente", b.komponente() == null ? null : b.komponente().toString());
        fakten.put("kanal", b.kanal());
        return MessstelleAbgelehnt.schnittstelle(MessstelleAbgelehnt.Schnittstelle.VORSCHLAG_GEAENDERT,
                "Dieser Vorschlag hat sich inzwischen geändert — bitte die Vorschlagsliste neu laden.", fakten);
    }

    /** Zwei Übernahmen desselben Standorts warten aufeinander; die zweite sieht, was die erste schrieb. */
    private void sperre(UUID standortId) {
        long schluessel = standortId.getMostSignificantBits() ^ standortId.getLeastSignificantBits()
                ^ 0x49502d3136L;
        jdbc.query("SELECT pg_advisory_xact_lock(?)", rs -> null, schluessel);
    }

    // ---------------------------------------------------------------- die Lage

    /** Alles, woraus die Liste entsteht — einmal gelesen, unter RLS. */
    private record Lage(UUID standortId, String standortKennzeichen, String standortName, ZoneId zone,
            Vorschlagsliste liste, Map<String, String> anlagenNamen, Map<String, String> komponentenNamen) {}

    private Lage lage(UUID standortId) {
        StandortLesemodell.StandortAmStichtag st = standorte.standort(standortId, null)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Standort nicht gefunden."));
        ZoneId zone = ZoneId.of(st.zeitzone());
        LocalDate heute = LocalDate.now(zone);
        LocalDate beginn = standortBeginn(st.kurzzeichen(), heute);

        Map<UUID, MessstelleRepository.Messstelle> messstellenJeId = new LinkedHashMap<>();
        messstellen.alle().forEach(m -> messstellenJeId.put(m.id(), m));
        Instant jetzt = Instant.now();
        Map<String, String> gespeist = new LinkedHashMap<>();
        Map<UUID, MessstelleQuelleRepository.Quelle> fuehrendJeMessstelle = new LinkedHashMap<>();
        for (MessstelleQuelleRepository.Quelle q : quellenRepo.alle()) {
            if (q.gueltigBis() == null || q.gueltigBis().isAfter(jetzt)) {
                MessstelleRepository.Messstelle m = messstellenJeId.get(q.messstelleId());
                gespeist.putIfAbsent(q.entityId() + "|" + q.kanal(), m == null ? q.messstelle() : m.kennzeichen());
                if (FUEHREND.equals(q.rolle()) && m != null && q.groesse().equals(m.hauptgroesse().groesse())
                        && q.richtung().equals(m.hauptgroesse().richtung())
                        && !q.gueltigAb().isAfter(jetzt)) {
                    fuehrendJeMessstelle.putIfAbsent(q.messstelleId(), q);
                }
            }
        }
        List<StellungZeile> stellungen = zuordnungenRepo.stellungenAlle().stream()
                .filter(s -> !s.aufgehoben() && s.deckt(heute) && HAUPTZAEHLER.equals(s.stellung()))
                .toList();

        List<VorschlagAnlage> anlagen = new ArrayList<>();
        List<VorschlagKomponente> komponenten = new ArrayList<>();
        Map<String, String> anlagenNamen = new LinkedHashMap<>();
        Map<String, String> komponentenNamen = new LinkedHashMap<>();
        for (StandortLesemodell.ZugeordneteAnlage a : st.anlagen()) {
            anlagenNamen.put(a.id().toString(), a.name());
            UUID netzmessung = netzmessung(a.id());
            List<VorschlagHauptzaehler> hauptzaehler = new ArrayList<>();
            for (StellungZeile s : stellungen) {
                if (!s.siteId().equals(a.id())) {
                    continue;
                }
                MessstelleRepository.Messstelle m = messstellenJeId.get(s.messstelleId());
                MessstelleQuelleRepository.Quelle q = fuehrendJeMessstelle.get(s.messstelleId());
                if (m != null) {
                    hauptzaehler.add(new VorschlagHauptzaehler(m.kennzeichen(), m.hauptgroesse().richtung(),
                            q == null ? null : q.entityId().toString(), s.gueltigAb()));
                }
            }
            anlagen.add(new VorschlagAnlage(a.id().toString(), a.name(), netzmessung != null, hauptzaehler));

            Map<UUID, Instant> verlauf = new LinkedHashMap<>();
            Map<UUID, Instant> laufend = new LinkedHashMap<>();
            for (GeraetRepository.Speisung sp : geraete.speisungenDerAnlage(a.id())) {
                verlauf.merge(sp.entityId(), sp.gueltigAb(), (x, y) -> x.isBefore(y) ? x : y);
                if (!sp.gueltigAb().isAfter(jetzt) && (sp.gueltigBis() == null || sp.gueltigBis().isAfter(jetzt))) {
                    laufend.putIfAbsent(sp.entityId(), sp.gueltigAb());
                }
            }
            for (Komponente k : komponentenDerAnlage(a.id())) {
                komponentenNamen.put(k.id().toString(), anzeigename(k));
                Instant verlaufsbeginn = verlauf.getOrDefault(k.id(),
                        k.createdAt().truncatedTo(ChronoUnit.MINUTES));
                komponenten.add(new VorschlagKomponente(k.id().toString(), a.id().toString(), anzeigename(k),
                        rolle(k, netzmessung), zeit(verlaufsbeginn, zone), zeit(laufend.get(k.id()), zone),
                        kanaele(a.id(), k.id(), gespeist)));
            }
        }

        MessstelleRepository.Kennzeichenstand stand = messstellen.kennzeichenstand();
        Vorschlagsliste liste = MessstelleRegeln.vorschlagsliste(new VorschlagEingang(
                new VorschlagStandort(st.kurzzeichen(), st.name(), beginn, zone), anlagen, komponenten,
                stand.zaehler(), stand.belegt()));
        return new Lage(standortId, st.kurzzeichen(), st.name(), zone, liste, anlagenNamen, komponentenNamen);
    }

    /** Der erste Tag des heutigen Bestehens des Standorts (AP-02): keine Messstelle beginnt davor. */
    private LocalDate standortBeginn(String kurzzeichen, LocalDate heute) {
        OrtsbaumAbleitung.Ort ort = standortDienst.baum(List.of()).baum().ort(kurzzeichen).orElse(null);
        if (ort == null) {
            return null;
        }
        LocalDate beginn = null;
        for (OrtsbaumAbleitung.Intervall i : ort.intervalle()) {
            if (!i.aufgehoben() && (beginn == null || i.ab().isAfter(beginn)) && !i.ab().isAfter(heute)) {
                beginn = i.ab();
            }
        }
        return beginn == null && !ort.intervalle().isEmpty() ? ort.intervalle().get(0).ab() : beginn;
    }

    /** Die maßgebliche Netzmessung der Anlage: der Messwert mit der Topologie-Rolle {@code grid}. */
    private UUID netzmessung(UUID siteId) {
        for (TopologyService.EntityTopologyDto e : topologie.topology(siteId).entities()) {
            for (TopologyService.CapabilityDto c : e.capabilities()) {
                if (TopologyDeriver.ROLE_GRID.equals(c.role()) && c.primary()) {
                    return e.id();
                }
            }
        }
        return null;
    }

    /** Eine Komponente der Anlage, wie die Liste sie braucht. */
    private record Komponente(UUID id, String label, String art, Instant createdAt) {}

    private List<Komponente> komponentenDerAnlage(UUID siteId) {
        return jdbc.query("""
                SELECT id, label, coalesce(entity_type, role) AS art, created_at
                  FROM measurement_point
                 WHERE site_id = ?
                 ORDER BY created_at, id
                """, (rs, n) -> new Komponente(rs.getObject("id", UUID.class), rs.getString("label"),
                        rs.getString("art"), rs.getTimestamp("created_at").toInstant()), siteId);
    }

    /**
     * Der Name, unter dem der Kunde die Komponente kennt: ihr Alias („getippt gewinnt“,
     * {@code measurement_point.label}); fehlt er, das Katalogwort ihres Typs ohne seinen Zusatz
     * („Batteriespeicher (Hybrid)“ → „Batteriespeicher“) — nie ein erfundener Name.
     */
    private String anzeigename(Komponente k) {
        if (k.label() != null && !k.label().isBlank()) {
            return k.label().strip();
        }
        String label = typen.labelFor(k.art());
        if (label == null || label.isBlank()) {
            return k.art();
        }
        int klammer = label.indexOf(" (");
        return klammer > 0 ? label.substring(0, klammer) : label;
    }

    private String rolle(Komponente k, UUID netzmessung) {
        if (HAUS.equals(k.art())) {
            return "abgeleitet";
        }
        if (k.id().equals(netzmessung)) {
            return "netzmessung";
        }
        EntityTypeCatalog.EntityType typ = typen.find(k.art());
        return typ != null && ZAEHLER_KATEGORIE.equals(typ.category()) ? "zaehler" : "geraet";
    }

    /** Die Messkanäle der Komponente (IP-9), je Kanalname einmal — mit dem, was sie schon speisen. */
    private List<VorschlagKanal> kanaele(UUID siteId, UUID komponente, Map<String, String> gespeist) {
        List<VorschlagKanal> out = new ArrayList<>();
        Set<String> gesehen = new LinkedHashSet<>();
        for (MesskanalDto.Messkanal c : messkanaele.messkanaele(siteId, komponente).messkanaele()) {
            if (!gesehen.add(c.kanal())) {
                continue;
            }
            out.add(new VorschlagKanal(c.kanal(), c.anzeigename(), c.groesse(), c.richtung(), c.einheit(),
                    c.wertart(), c.direction(), gespeist.get(komponente + "|" + c.kanal())));
        }
        return out;
    }

    private static OffsetDateTime zeit(Instant t, ZoneId zone) {
        return t == null ? null : OffsetDateTime.ofInstant(t, zone);
    }

    // ------------------------------------------------------------ Darstellung

    private MessstelleVorschlagDto.Liste darstellung(Lage lage) {
        List<MessstelleVorschlagDto.Vorschlag> zeilen = new ArrayList<>();
        for (VorschlagZeile z : lage.liste().vorschlaege()) {
            zeilen.add(new MessstelleVorschlagDto.Vorschlag(z.kennzeichen(), z.name(),
                    UUID.fromString(z.anlage()), lage.anlagenNamen().get(z.anlage()),
                    UUID.fromString(z.komponente()), lage.komponentenNamen().get(z.komponente()),
                    dtoGroesse(z.hauptgroesse()), dtoQuelle(z.quelle()),
                    z.nebengroessen().stream().map(n -> new MessstelleVorschlagDto.Nebengroesse(
                            dtoGroesse(n.groesse()), dtoQuelle(n.quelle()))).toList(),
                    z.stellung(),
                    z.unterzaehlerVon() == null ? null : new MessstelleVorschlagDto.Bezug(
                            z.unterzaehlerVon().messstelle(), z.unterzaehlerVon().bestehend(),
                            z.unterzaehlerVon().komponente() == null ? null
                                    : UUID.fromString(z.unterzaehlerVon().komponente()),
                            z.unterzaehlerVon().kanal()),
                    z.ort(), z.ab(), z.stellungAb(),
                    z.hinweise().stream()
                            .map(h -> new MessstelleVorschlagDto.Hinweis(h.code(), h.text())).toList()));
        }
        List<MessstelleVorschlagDto.Ausgelassen> ohne = lage.liste().ausgelassen().stream()
                .map(a -> new MessstelleVorschlagDto.Ausgelassen(UUID.fromString(a.anlage()),
                        UUID.fromString(a.komponente()), lage.komponentenNamen().get(a.komponente()),
                        a.kanal(), a.grund(), a.zu(), a.text()))
                .toList();
        return new MessstelleVorschlagDto.Liste(lage.standortId(), lage.standortKennzeichen(),
                lage.standortName(), List.copyOf(zeilen), ohne, lage.liste().leer(), lage.liste().text());
    }

    private static MessstelleDto.Groesse dtoGroesse(MessstelleRegeln.Groesse g) {
        return new MessstelleDto.Groesse(g.groesse(), g.richtung(), g.einheit(), g.wertart());
    }

    private static MessstelleVorschlagDto.Quelle dtoQuelle(MessstelleRegeln.VorschlagQuelle q) {
        return new MessstelleVorschlagDto.Quelle(q.kanal(), q.anzeigename(), q.kanalWertart(), q.herleitung());
    }

    // ------------------------------------------------------------ die Anfrage

    /** Die Form der Anfrage: mindestens eine Zeile, je Zeile Komponente und Messwert — keine doppelt. */
    private static List<MessstelleVorschlagDto.Bestaetigt> gepruefteAnfrage(
            MessstelleVorschlagDto.Uebernehmen u) {
        if (u == null || u.vorschlaege() == null || u.vorschlaege().isEmpty()) {
            throw MessstelleAbgelehnt.anfrage("vorschlaege", "Welche Vorschläge sollen übernommen werden?");
        }
        Set<String> gesehen = new HashSet<>();
        for (int i = 0; i < u.vorschlaege().size(); i++) {
            MessstelleVorschlagDto.Bestaetigt b = u.vorschlaege().get(i);
            String feld = "vorschlaege[" + i + "]";
            if (b == null) {
                throw MessstelleAbgelehnt.anfrage(feld, "Ein Vorschlag fehlt.");
            }
            if (b.komponente() == null) {
                throw MessstelleAbgelehnt.anfrage(feld + ".komponente", "Die Komponente fehlt.");
            }
            if (b.kanal() == null || b.kanal().isBlank()) {
                throw MessstelleAbgelehnt.anfrage(feld + ".kanal", "Der Messwert (Kanal) fehlt.");
            }
            if (b.hauptgroesse() == null) {
                throw MessstelleAbgelehnt.anfrage(feld + ".hauptgroesse", "Die Hauptgröße fehlt.");
            }
            if (b.ab() == null) {
                throw MessstelleAbgelehnt.anfrage(feld + ".ab", "Der Beginn fehlt — er steht in der Liste.");
            }
            if (b.name() != null && b.name().isBlank()) {
                throw MessstelleAbgelehnt.anfrage(feld + ".name",
                        "Der Name ist leer — lassen Sie ihn weg, dann gilt der vorgeschlagene.");
            }
            if (!gesehen.add(b.komponente() + "|" + b.kanal())) {
                throw MessstelleAbgelehnt.anfrage(feld, "Ein Messwert steht in genau einem Vorschlag.");
            }
        }
        return List.copyOf(u.vorschlaege());
    }
}
