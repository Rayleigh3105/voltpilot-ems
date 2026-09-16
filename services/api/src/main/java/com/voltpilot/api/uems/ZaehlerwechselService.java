package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.components.ComponentActivationOutboxService;
import com.voltpilot.api.components.ComponentDefinitionRepository;
import com.voltpilot.api.measurement.MesskanalService;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.GeraetRepository.Einbau;
import com.voltpilot.api.uems.GeraetRepository.NeuerEinbau;
import com.voltpilot.api.uems.GeraetRepository.Speisung;
import com.voltpilot.api.uems.MessstelleAbgelehnt.Schnittstelle;
import com.voltpilot.api.uems.MessstelleAenderungRepository.NeuerEintrag;
import com.voltpilot.api.uems.MessstelleQuelleRepository.NeueQuelle;
import com.voltpilot.api.uems.MessstelleQuelleRepository.Quelle;
import com.voltpilot.api.uems.MessstelleRegeln.BeendenEingang;
import com.voltpilot.api.uems.MessstelleRegeln.BeendenUrteil;
import com.voltpilot.api.uems.MessstelleRegeln.Bindung;
import com.voltpilot.api.uems.MessstelleRegeln.BindungEingang;
import com.voltpilot.api.uems.MessstelleRegeln.BindungUrteil;
import com.voltpilot.api.uems.MessstelleRegeln.EinbauStand;
import com.voltpilot.api.uems.MessstelleRegeln.Fehler;
import com.voltpilot.api.uems.MessstelleRegeln.FremdeFuehrung;
import com.voltpilot.api.uems.MessstelleRegeln.Groesse;
import com.voltpilot.api.uems.MessstelleRegeln.NeueBindung;
import com.voltpilot.api.uems.MessstelleRegeln.Stand;
import com.voltpilot.api.uems.MessstelleRegeln.WechselEingang;
import com.voltpilot.api.uems.MessstelleRegeln.WechselUrteil;
import com.voltpilot.api.uems.MessstelleRepository.Messstelle;
import com.voltpilot.api.uems.MessstelleRepository.Nebengroesse;
import com.voltpilot.api.uems.QuelleEinstellungRegeln.Bestehende;
import com.voltpilot.api.uems.QuelleEinstellungRegeln.Eingang;
import com.voltpilot.api.uems.QuelleEinstellungRegeln.Neu;
import com.voltpilot.api.uems.QuelleEinstellungRegeln.Urteil;
import com.voltpilot.api.uems.QuelleEinstellungRepository.Fassung;
import com.voltpilot.api.uems.QuelleEinstellungRepository.NeueFassung;
import com.voltpilot.api.web.dto.MesskanalDto;
import com.voltpilot.api.web.dto.MessstelleQuelleDto;
import com.voltpilot.api.web.dto.ZaehlerwechselDto;
import java.time.Clock;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

/**
 * Der Zählerwechsel als EIN Vorgang (UEMS AP-04 IP-17, Konzept §5.5): das alte Gerät wird
 * ausgebaut, das neue eingebaut, die laufenden Quellenbindungen enden genau zum Wechselzeitpunkt
 * und beginnen dort neu am neuen Einbau, die Ablesestände landen als Endstand des Vorgängers und
 * Anfangsstand des Nachfolgers, die Einstellungen werden übernommen, und je betroffener Messstelle
 * hält EIN Protokolleintrag {@code zaehler_gewechselt} den Vorgang mit Urheber und
 * Rückwirkend-Marker fest.
 *
 * <p><b>Entweder alles oder nichts.</b> Der ganze Vorgang läuft in EINER Transaktion, und alles,
 * was ihn ablehnen kann, ist geprüft, BEVOR die erste Zeile geschrieben wird. Eine Ablehnung
 * hinterlässt keine halbe Wirkung — das ist der Grund, aus dem es diesen Dienst überhaupt gibt:
 * bis hierher musste ein Wechsel aus mehreren Einzelaufrufen zusammengestückelt werden, von denen
 * jeder für sich gelingen konnte.
 *
 * <p><b>Zwei Einstiege, ein Vorgang.</b> {@link #anMessstelle} kommt von der Quelle-Karte
 * („Zähler wechseln") und schlägt das Gerät aus den laufenden Bindungen der Messstelle nach;
 * {@link #amGeraet} kommt von der Geräteseite („Gerät austauschen") und kennt es schon. Danach
 * läuft beides durch dieselbe Methode.
 *
 * <p><b>Keine zweite Fassung einer Regel.</b> Ob zum Zeitpunkt gewechselt werden darf, urteilt
 * {@link MessstelleRegeln#wechselPruefen}; ob eine Bindung enden darf,
 * {@link MessstelleRegeln#beendenPruefen}; ob die neue beginnen darf,
 * {@link MessstelleRegeln#bindungPruefen} mit dem Vorgang {@code wechsel}; welche
 * Einstellungs-Fassung zum Zeitpunkt gilt und ob eine neue entstehen darf,
 * {@link QuelleEinstellungRegeln}. Hier steht nur, was der Vertrag der Schnittstelle lässt: die
 * Form der Anfrage, das Nachschlagen der Fakten und der gespeicherte Zustand.
 *
 * <p><b>Nicht dieser Vorgang:</b> der Controllerwechsel (IP-19) — ein Einbau mit Energiekarten
 * wird hier abgelehnt, weil die Entscheidung je Karte („übernommen" oder „ebenfalls neu") dort
 * fällt und dieser Schnitt sie nicht vorwegnehmen darf.
 */
@Service
public class ZaehlerwechselService {

    private static final Logger log = LoggerFactory.getLogger(ZaehlerwechselService.class);

    private static final ZoneId ZEITZONE = MessstelleService.ZEITZONE;
    private static final DateTimeFormatter ANZEIGE = DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm");
    private static final String FUEHREND = "fuehrend";
    private static final String ZAEHLERSTAND = "zaehlerstand";

    /** Die Art des Eintrags im Protokoll der Messstelle (CHECK in V20260912120000). */
    static final String PROTOKOLL_ART = "zaehler_gewechselt";

    private final MessstelleRepository messstellen;
    private final MessstelleQuelleRepository quellen;
    private final MessstelleAenderungRepository aenderungen;
    private final MessstelleZuordnungRepository zuordnungen;
    private final GeraetRepository geraete;
    private final QuelleEinstellungRepository fassungen;
    private final MesskanalService messkanaele;
    private final ComponentDefinitionRepository definitionen;
    private final ComponentActivationOutboxService outbox;
    private final ZaehlerwechselMarke marke;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaktion;
    private final ObjectMapper json;
    private volatile Clock uhr = Clock.systemUTC();
    private volatile Runnable letzterSchritt = () -> { };

    public ZaehlerwechselService(MessstelleRepository messstellen, MessstelleQuelleRepository quellen,
            MessstelleAenderungRepository aenderungen, MessstelleZuordnungRepository zuordnungen,
            GeraetRepository geraete, QuelleEinstellungRepository fassungen, MesskanalService messkanaele,
            ComponentDefinitionRepository definitionen, ComponentActivationOutboxService outbox,
            ZaehlerwechselMarke marke, JdbcTemplate jdbc, PlatformTransactionManager transactionManager,
            ObjectMapper json) {
        this.messstellen = messstellen;
        this.quellen = quellen;
        this.aenderungen = aenderungen;
        this.zuordnungen = zuordnungen;
        this.geraete = geraete;
        this.fassungen = fassungen;
        this.messkanaele = messkanaele;
        this.definitionen = definitionen;
        this.outbox = outbox;
        this.marke = marke;
        this.jdbc = jdbc;
        this.transaktion = new TransactionTemplate(transactionManager);
        this.json = json;
    }

    /** Nur für Tests: die Uhr, an der „jetzt“ und „rückwirkend“ hängen (A1: „eingetragen um 11:05“). */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /**
     * Nur für Tests: läuft als LETZTER Schritt INNERHALB der Transaktion. Wirft er, muss der ganze
     * Vorgang zurückgerollt sein — so wird „alles oder nichts“ nachgewiesen statt behauptet.
     */
    void letzterSchritt(Runnable r) {
        this.letzterSchritt = r;
    }

    // ----------------------------------------------------------- die zwei Einstiege

    /**
     * „Zähler wechseln“ an der Quelle-Karte der Messstelle. Das Gerät ist das, aus dem die
     * Messstelle zum Wechselzeitpunkt liest — es wird nachgeschlagen, nie gewählt.
     */
    public ZaehlerwechselDto.Vorgang anMessstelle(UUID messstelleId, ZaehlerwechselDto.Wechsel w,
            ProtokollAkteur wer) {
        Anfrage a = anfrage(w);
        return transaktion.execute(s -> {
            Messstelle m = messstellen.finde(messstelleId).orElseThrow(() ->
                    new ResponseStatusException(HttpStatus.NOT_FOUND, "Messstelle nicht gefunden."));
            nichtArchiviert(m);
            List<Quelle> laufend = quellen.derMessstelle(m.id()).stream()
                    .filter(q -> gilt(q, a.zeitpunkt())).toList();
            Set<UUID> einbauten = new LinkedHashSet<>();
            laufend.forEach(q -> einbauten.add(q.geraetId()));
            if (einbauten.isEmpty()) {
                throw MessstelleAbgelehnt.schnittstelle(Schnittstelle.ZUSTAND_PASST_NICHT, m.kennzeichen()
                        + " liest am " + anzeige(a.zeitpunkt()) + " aus keiner Quelle — es gibt kein Gerät zu "
                        + "wechseln. Binden Sie erst eine Quelle.", Map.of("zeitpunkt", zeit(a.zeitpunkt())));
            }
            if (einbauten.size() > 1) {
                Map<String, Object> fakten = new LinkedHashMap<>();
                fakten.put("geraete", laufend.stream().map(Quelle::einbau).distinct().toList());
                throw MessstelleAbgelehnt.schnittstelle(Schnittstelle.ZUSTAND_PASST_NICHT, m.kennzeichen()
                        + " liest am " + anzeige(a.zeitpunkt()) + " aus mehreren Geräten ("
                        + String.join(", ", laufend.stream().map(Quelle::einbau).distinct().toList())
                        + "). Wechseln Sie das Gerät auf seiner eigenen Seite.", fakten);
            }
            return wechseln(einbauten.iterator().next(), a, wer);
        });
    }

    /** „Gerät austauschen“ auf der Geräteseite. */
    public ZaehlerwechselDto.Vorgang amGeraet(UUID geraetId, ZaehlerwechselDto.Wechsel w, ProtokollAkteur wer) {
        Anfrage a = anfrage(w);
        return transaktion.execute(s -> wechseln(geraetId, a, wer));
    }

    /** Nur lesen: alle betroffenen Bindungen zum gewählten Zeitpunkt, einschließlich Vergleichsquellen. */
    public ZaehlerwechselDto.Vorschau vorschau(UUID id, OffsetDateTime zeitpunkt) {
        return transaktion.execute(status -> {
            if (geraete.eines(id).isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Gerät nicht gefunden.");
            Instant am = aufDieMinute(zeitpunkt, uhr.instant().truncatedTo(ChronoUnit.MINUTES));
            List<Speisung> speisungen = geraete.laufendeSpeisungenAm(id, am);
            List<ZaehlerwechselDto.Folge> folgen = quellen.desEinbausAb(id, am).stream()
                    .filter(q -> gilt(q, am)).map(q -> {
                        UUID karte = speisungen.stream().filter(s -> s.entityId().equals(q.entityId()))
                                .map(Speisung::teilId).filter(Objects::nonNull).findFirst().orElse(null);
                        String einheit = messkanaele.kanal(q.entityId(), q.kanal()).map(MesskanalDto.Messkanal::einheit).orElse(null);
                        return new ZaehlerwechselDto.Folge(q.id(), karte, q.entityId(), q.messstelleId(),
                                q.messstelle(), q.groesse(), q.richtung(), q.rolle(), einheit,
                                ZAEHLERSTAND.equals(q.herleitung()));
                    }).toList();
            return new ZaehlerwechselDto.Vorschau(zeit(am), geraete.teileAm(id, am).stream()
                    .map(k -> new ZaehlerwechselDto.Karte(k.id(), k.steckplatz(), k.bezeichnung(), k.typ(), k.seriennummer())).toList(), folgen);
        });
    }

    // ----------------------------------------------------------- der eine Vorgang

    /** Die geprüfte Form der Anfrage — alles, was ohne einen Blick in die Datenbank feststeht. */
    private record Anfrage(Instant jetzt, Instant zeitpunkt, ZaehlerwechselDto.NeuesGeraet geraet,
            ZaehlerwechselDto.Verbindung verbindung, boolean verbindungGesetzt, Stand endstand,
            Stand anfangsstand, boolean einstellungenUebernehmen, String grund,
            List<UUID> kartenUebernommen, List<ZaehlerwechselDto.Ablesestand> ablesestaende,
            List<UUID> bestaetigteBindungen) {}

    private Anfrage anfrage(ZaehlerwechselDto.Wechsel w) {
        if (w == null) {
            throw MessstelleAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        Instant jetzt = uhr.instant();
        Instant zeitpunkt = aufDieMinute(w.zeitpunkt(), jetzt.truncatedTo(ChronoUnit.MINUTES));
        ZaehlerwechselDto.NeuesGeraet g = w.neuesGeraet() == null
                ? new ZaehlerwechselDto.NeuesGeraet(null, null, null, null, null) : w.neuesGeraet();
        String kennzeichen = text(g.einbauKennzeichen());
        if (kennzeichen != null && !kennzeichen.matches("^[A-Za-z0-9][A-Za-z0-9._/′-]{0,31}$")) {
            throw MessstelleAbgelehnt.anfrage("neues_geraet.einbau_kennzeichen",
                    "Erlaubt sind 1–32 Zeichen: Buchstaben, Ziffern, „-“, „.“, „/“ und „′“.");
        }
        ZaehlerwechselDto.Verbindung v = w.verbindung();
        if (v != null && v.geraeteId() != null && v.geraeteId() < 0) {
            throw MessstelleAbgelehnt.anfrage("verbindung.geraete_id", "Die Geräte-ID ist nicht negativ.");
        }
        return new Anfrage(jetzt, zeitpunkt,
                new ZaehlerwechselDto.NeuesGeraet(kennzeichen, text(g.hersteller()), text(g.typ()),
                        text(g.seriennummer()), text(g.bezeichnung())),
                v, v != null, stand(w.endstandVorgaenger(), "endstand_vorgaenger"),
                stand(w.anfangsstand(), "anfangsstand"),
                w.einstellungenUebernehmen() == null || w.einstellungenUebernehmen(), text(w.grund()),
                w.kartenUebernommen(), w.ablesestaende() == null ? List.of() : w.ablesestaende(),
                w.bestaetigteBindungen());
    }

    /** Eine Bindung, die mitzieht: was endet, was beginnt, und mit welchem Urteil. */
    private record Umzug(Quelle alt, Messstelle messstelle, Groesse ziel, BindungUrteil urteil,
            Stand endstand, Stand anfangsstand, MesskanalDto.Messkanal kanal) {}

    /**
     * Der Vorgang selbst — läuft in der Transaktion des Einstiegs. Zuerst wird ALLES geprüft
     * (Gerät, Karten, Bindungen, Kennzeichen), dann wird geschrieben.
     */
    private ZaehlerwechselDto.Vorgang wechseln(UUID geraetId, Anfrage a, ProtokollAkteur wer) {
        UUID tenant = TenantContext.get();
        if (!geraete.sperre(geraetId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Gerät nicht gefunden.");
        }
        Einbau alt = geraete.eines(geraetId).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Gerät nicht gefunden."));

        // 1. Darf zum Zeitpunkt gewechselt werden? (MessstelleRegeln, Regel 5)
        WechselUrteil u = MessstelleRegeln.wechselPruefen(new WechselEingang(zeit(a.jetzt()),
                new EinbauStand(alt.kennzeichen(), alt.einbauKennzeichen(), zeit(alt.eingebautAm()),
                        zeit(alt.ausgebautAm())), zeit(a.zeitpunkt())));
        if (u.fehler() != null) {
            throw wechselAbgelehnt(u, alt);
        }

        // 2. Karten brauchen die ausdrückliche Entscheidung des Controllerwechsels (IP-19).
        List<GeraetRepository.Teil> karten = geraete.teileAm(geraetId, a.zeitpunkt());
        if (!karten.isEmpty() && a.kartenUebernommen() == null) {
            Map<String, Object> fakten = new LinkedHashMap<>();
            fakten.put("karten", karten.size());
            throw MessstelleAbgelehnt.schnittstelle(Schnittstelle.ZUSTAND_PASST_NICHT, alt.einbauKennzeichen()
                    + " ist ein Gerät mit " + karten.size() + (karten.size() == 1 ? " Energiekarte" : " Energiekarten")
                    + ". Ob die Karten übernommen werden oder ebenfalls neu sind, entscheidet der "
                    + "Controllerwechsel — er ist ein eigener Vorgang.", fakten);
        }

        // 3. Welche Komponenten speist er zum Zeitpunkt? Ohne eine gibt es nichts zu wechseln.
        List<Speisung> speisungen = geraete.laufendeSpeisungenAm(geraetId, a.zeitpunkt());
        // Ohne Kartenentscheidung darf die Zuordnung zu einer Energiekarte nie verloren gehen.
        if (a.kartenUebernommen() == null && speisungen.stream().anyMatch(x -> x.teilId() != null)) {
            throw MessstelleAbgelehnt.schnittstelle(Schnittstelle.ZUSTAND_PASST_NICHT, alt.einbauKennzeichen()
                    + " speist über eine Energiekarte. Ob die Karten übernommen werden oder ebenfalls neu "
                    + "sind, entscheidet der Controllerwechsel — er ist ein eigener Vorgang.",
                    Map.of("karten", speisungen.stream().filter(x -> x.teilId() != null).count()));
        }
        if (speisungen.stream().anyMatch(s -> s.teilId() != null
                && karten.stream().noneMatch(k -> k.id().equals(s.teilId())))) {
            throw MessstelleAbgelehnt.schnittstelle(Schnittstelle.ZUSTAND_PASST_NICHT,
                    "Eine Komponente verweist auf eine zu diesem Zeitpunkt nicht eingebaute Karte.", Map.of());
        }
        if (speisungen.isEmpty()) {
            Map<String, Object> fakten = new LinkedHashMap<>();
            fakten.put("zeitpunkt", zeit(a.zeitpunkt()));
            throw MessstelleAbgelehnt.regel(Fehler.KEIN_GERAET_ZUM_ZEITPUNKT, alt.einbauKennzeichen()
                    + " speist am " + anzeige(a.zeitpunkt()) + " keine Komponente — es gibt nichts zu "
                    + "wechseln.", fakten);
        }

        // 4. Eine angekündigte Bindung auf dem alten Einbau würde ins Leere zeigen.
        List<Quelle> angekuendigt = quellen.desEinbausNach(geraetId, a.zeitpunkt());
        if (!angekuendigt.isEmpty()) {
            Quelle q = angekuendigt.get(0);
            Map<String, Object> fakten = new LinkedHashMap<>();
            fakten.put("messstelle", q.messstelle());
            fakten.put("gueltig_ab", zeit(q.gueltigAb()));
            throw MessstelleAbgelehnt.schnittstelle(Schnittstelle.ZUSTAND_PASST_NICHT, q.messstelle()
                    + " hat eine angekündigte Quelle an " + alt.einbauKennzeichen() + " ab "
                    + anzeige(q.gueltigAb()) + ". Nehmen Sie sie zurück oder wechseln Sie später — nach dem "
                    + "Wechsel steckt dort ein anderes Gerät.", fakten);
        }

        // 5. Die Bindungen, die mitziehen — und die, die schon beendet sind (beendenPruefen urteilt).
        List<Quelle> kandidaten = quellen.desEinbausAb(geraetId, a.zeitpunkt());
        for (Quelle q : kandidaten) {
            if (q.gueltigBis() != null && !q.gueltigBis().isBefore(a.zeitpunkt())) {
                BeendenUrteil b = MessstelleRegeln.beendenPruefen(new BeendenEingang(zeit(a.jetzt()),
                        bindung(q), zeit(a.zeitpunkt()), null));
                throw beendenAbgelehnt(b.fehler() == null ? Fehler.BINDUNG_BEREITS_BEENDET : b.fehler(), q);
            }
        }
        List<Quelle> laufende = kandidaten.stream().filter(q -> q.gueltigBis() == null).toList();

        if (a.kartenUebernommen() != null || !a.ablesestaende().isEmpty()) {
            String feld = MessstelleRegeln.kartenWechselPruefen(
                    karten.stream().map(k -> k.id().toString()).toList(),
                    a.kartenUebernommen() == null ? List.of() : a.kartenUebernommen().stream()
                            .map(k -> k == null ? null : k.toString()).toList(),
                    laufende.stream().filter(q -> FUEHREND.equals(q.rolle()) && ZAEHLERSTAND.equals(q.herleitung()))
                            .map(q -> q.id().toString()).toList(),
                    a.ablesestaende().stream().map(x -> x == null || x.bindung() == null ? null : x.bindung().toString()).toList());
            if (feld != null) throw MessstelleAbgelehnt.anfrage(feld,
                    "Die Auswahl muss bekannte Karten bzw. führende Zählwerke genau einmal nennen.");
            if (!a.ablesestaende().isEmpty() && (a.endstand() != null || a.anfangsstand() != null)) {
                throw MessstelleAbgelehnt.anfrage("ablesestaende", "Geben Sie die Ablesestände je Zählwerk an.");
            }
        }
        if (a.kartenUebernommen() != null && (a.bestaetigteBindungen() == null
                || !new java.util.HashSet<>(a.bestaetigteBindungen()).equals(
                        laufende.stream().map(Quelle::id).collect(java.util.stream.Collectors.toSet()))
                || a.bestaetigteBindungen().size() != laufende.size())) {
            throw MessstelleAbgelehnt.schnittstelle(Schnittstelle.ZUSTAND_PASST_NICHT,
                    "Die betroffenen Messstellen haben sich geändert. Prüfen Sie die Folgen erneut.", Map.of());
        }
        for (GeraetRepository.Teil karte : karten) {
            if (karte.ausgebautAm() != null || !a.zeitpunkt().isAfter(karte.eingebautAm())) {
                throw MessstelleAbgelehnt.anfrage("zeitpunkt", "Der Wechsel muss nach dem Einbau aller Karten liegen.");
            }
        }

        // 6. Das Kennzeichen des neuen Einbaus: gewählt oder vergeben, in jedem Fall frei.
        String neuesKennzeichen = einbauKennzeichen(alt, a.geraet().einbauKennzeichen());

        // 7. Die Ablesestände gehören zu GENAU EINER führenden Zählerstand-Bindung — sonst ist nicht
        //    klar, zu welchem Zählwerk sie gehören. Eine Vergleichsquelle liest denselben Zähler
        //    ein zweites Mal; der abgelesene Stand gehört der führenden.
        List<Quelle> zaehlerstaende = laufende.stream()
                .filter(q -> FUEHREND.equals(q.rolle()) && ZAEHLERSTAND.equals(q.herleitung())).toList();
        if ((a.endstand() != null || a.anfangsstand() != null) && zaehlerstaende.size() != 1) {
            Map<String, Object> fakten = new LinkedHashMap<>();
            fakten.put("zaehlerstaende", zaehlerstaende.stream().map(Quelle::messstelle).distinct().toList());
            throw MessstelleAbgelehnt.anfrage("endstand_vorgaenger", zaehlerstaende.isEmpty()
                    ? "Ein Ablesestand gehört zu einem führenden Zählerstand; " + alt.einbauKennzeichen()
                            + " speist am " + anzeige(a.zeitpunkt()) + " keinen."
                    : "Dieser Wechsel betrifft " + zaehlerstaende.size() + " führende Zählerstände ("
                            + String.join(", ", zaehlerstaende.stream().map(Quelle::messstelle).distinct().toList())
                            + "). Geben Sie die Ablesestände je führender Bindung an.");
        }
        UUID standBindung = zaehlerstaende.size() == 1 ? zaehlerstaende.get(0).id() : null;

        // 8. Je Bindung: darf sie enden, und darf die neue am neuen Einbau beginnen?
        List<Umzug> umzuege = new ArrayList<>();
        List<String> hinweise = new ArrayList<>();
        for (Quelle q : laufende) {
            umzuege.add(pruefe(q, a, alt, neuesKennzeichen, standBindung, hinweise));
        }

        // ---- ab hier wird geschrieben; jede Ablehnung oben hat nichts hinterlassen ----
        if (!geraete.ausbauen(geraetId, a.zeitpunkt())) {
            throw soebenVeraendert(alt);
        }
        Integer geraeteId = a.verbindungGesetzt() && a.verbindung().geraeteId() != null
                ? a.verbindung().geraeteId() : alt.geraeteId();
        UUID datenquelle = a.verbindungGesetzt() && a.verbindung().datenquelle() != null
                ? a.verbindung().datenquelle() : alt.dataSourceId();
        boolean verbindungNeu = !Objects.equals(geraeteId, alt.geraeteId())
                || !Objects.equals(datenquelle, alt.dataSourceId());
        UUID neuId = geraete.einbauen(new NeuerEinbau(tenant, alt.siteId(), alt.kennzeichen(), neuesKennzeichen,
                alt.geraeteart(), oder(a.geraet().hersteller(), alt.hersteller()),
                oder(a.geraet().typ(), alt.typ()), a.geraet().seriennummer(),
                oder(a.geraet().bezeichnung(), alt.bezeichnung()), datenquelle, geraeteId, a.zeitpunkt(),
                wer.sub()));

        Map<UUID, UUID> neueKarten = new LinkedHashMap<>();
        for (GeraetRepository.Teil karte : karten) {
            neueKarten.put(karte.id(), geraete.karteWechseln(tenant, karte, neuId, a.zeitpunkt(),
                    a.kartenUebernommen().contains(karte.id())));
        }
        List<UUID> komponenten = new ArrayList<>();
        for (Speisung s : speisungen) {
            if (!geraete.speisungBeenden(geraetId, s.entityId(), a.zeitpunkt())) {
                throw soebenVeraendert(alt);
            }
            geraete.speisungAnlegen(tenant, neuId, s.entityId(), neueKarten.get(s.teilId()), a.zeitpunkt());
            komponenten.add(s.entityId());
        }

        List<ZaehlerwechselDto.Bindung> bindungen = new ArrayList<>();
        Map<UUID, List<Umzug>> jeMessstelle = new LinkedHashMap<>();
        for (Umzug z : umzuege) {
            if (!quellen.beenden(z.alt().id(), a.zeitpunkt(), repoStand(z.endstand()))) {
                throw soebenVeraendert(alt);
            }
            UUID neueQuelle = quellen.anlegen(new NeueQuelle(tenant, z.messstelle().id(), z.ziel().groesse(),
                    z.ziel().richtung(), z.alt().entityId(), neuId, z.alt().kanal(), z.kanal().wertart(),
                    z.urteil().herleitung(), z.alt().rolle(), z.alt().zweck(), a.zeitpunkt(), null,
                    repoStand(z.anfangsstand()), z.urteil().rueckwirkend(), null, a.jetzt(), wer,
                    z.alt().anteil()));
            bindungen.add(new ZaehlerwechselDto.Bindung(z.messstelle().id(), z.messstelle().kennzeichen(),
                    z.ziel().groesse(), z.ziel().richtung(), z.alt().rolle(),
                    darstellung(quellen.eine(z.messstelle().id(), z.alt().id()).orElseThrow(), a.jetzt()),
                    darstellung(quellen.eine(z.messstelle().id(), neueQuelle).orElseThrow(), a.jetzt())));
            jeMessstelle.computeIfAbsent(z.messstelle().id(), k -> new ArrayList<>()).add(z);
        }

        List<ZaehlerwechselDto.Einstellung> einstellungen = a.einstellungenUebernehmen()
                ? einstellungenUebernehmen(tenant, alt, neuId, a, wer) : List.of();

        if (verbindungNeu) {
            komponentenFassung(tenant, alt.siteId(), komponenten, geraeteId, wer);
        }

        for (Map.Entry<UUID, List<Umzug>> e : jeMessstelle.entrySet()) {
            protokoll(e.getKey(), e.getValue(), alt, neuesKennzeichen, a, einstellungen, verbindungNeu, wer);
        }

        int marken = marke(tenant, alt, neuesKennzeichen, komponenten, a, wer);

        letzterSchritt.run();

        Einbau gespeichertAlt = geraete.eines(geraetId).orElseThrow();
        Einbau gespeichertNeu = geraete.eines(neuId).orElseThrow();
        return new ZaehlerwechselDto.Vorgang(
                new ZaehlerwechselDto.GeraetWechsel(einbauDto(gespeichertAlt), einbauDto(gespeichertNeu),
                        verbindungNeu),
                komponenten, bindungen, einstellungen, marken,
                rueckwirkung(a.jetzt(), a.zeitpunkt()), List.copyOf(new LinkedHashSet<>(hinweise)));
    }

    // ----------------------------------------------------------- Prüfung je Bindung

    private Umzug pruefe(Quelle q, Anfrage a, Einbau alt, String neuesKennzeichen, UUID standBindung,
            List<String> hinweise) {
        Messstelle m = messstellen.finde(q.messstelleId()).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Messstelle nicht gefunden."));
        nichtArchiviert(m);
        List<Nebengroesse> neben = messstellen.nebengroessen(m.id());
        Groesse ziel = ziel(m, neben, q);
        MesskanalDto.Messkanal kanal = messkanaele.kanal(q.entityId(), q.kanal()).orElseThrow(() -> {
            Map<String, Object> fakten = new LinkedHashMap<>();
            fakten.put("komponente", q.entityId().toString());
            fakten.put("kanal", q.kanal());
            return MessstelleAbgelehnt.schnittstelle(Schnittstelle.ZUSTAND_PASST_NICHT, "Den Messwert „"
                    + q.kanal() + "“, aus dem " + m.kennzeichen() + " liest, gibt es an „"
                    + (q.komponenteName() == null ? "der Komponente" : q.komponenteName())
                    + "“ nicht mehr. Wählen Sie ihn wieder aus, dann lässt sich das Gerät wechseln.", fakten);
        });
        Stand endstand = q.id().equals(standBindung) ? a.endstand() : null;
        Stand anfangsstand = q.id().equals(standBindung) ? a.anfangsstand() : null;
        for (ZaehlerwechselDto.Ablesestand lesung : a.ablesestaende()) {
            if (q.id().equals(lesung.bindung())) {
                endstand = stand(lesung.endstand(), "ablesestaende.endstand");
                anfangsstand = stand(lesung.anfangsstand(), "ablesestaende.anfangsstand");
            }
        }
        BindungUrteil u = MessstelleRegeln.bindungPruefen(new BindungEingang("wechsel", zeit(a.jetzt()),
                m.medium(), zeit(beginn(m)), ziel,
                quellen.derMessstelle(m.id()).stream().map(ZaehlerwechselService::bindung).toList(),
                new NeueBindung(q.rolle(), q.zweck(), q.entityId().toString(), q.kanal(), alt.kennzeichen(),
                        neuesKennzeichen, kanal.groesse(), kanal.richtung(), kanal.einheit(), kanal.wertart(),
                        zeit(a.zeitpunkt()), null, endstand, anfangsstand, null, kanal.direction(), q.anteil()),
                quellen.fuehrendAnderswo(q.entityId(), q.kanal(), m.id()).stream()
                        .map(f -> new FremdeFuehrung(f.messstelle(), zeit(f.gueltigAb()), zeit(f.gueltigBis()),
                                f.anteil()))
                        .toList()));
        if (u.fehler() != null) {
            throw bindungAbgelehnt(u, m, ziel, q, alt, a);
        }
        hinweise.addAll(u.hinweise());
        return new Umzug(q, m, ziel, u, endstand, anfangsstand, kanal);
    }

    // ----------------------------------------------------------- Einstellungen

    /**
     * „Einstellungen übernommen" (§5.5): jede Fassung, die am alten Einbau zum Wechselzeitpunkt
     * gilt, steht danach auch am neuen — ab dem Wechselzeitpunkt, mit demselben Wert und derselben
     * Anwendung. Welche Fassung gilt und ob eine neue entstehen darf, sagt
     * {@link QuelleEinstellungRegeln}; der neue Einbau hat noch keine, also endet keine.
     */
    private List<ZaehlerwechselDto.Einstellung> einstellungenUebernehmen(UUID tenant, Einbau alt, UUID neuId,
            Anfrage a, ProtokollAkteur wer) {
        List<ZaehlerwechselDto.Einstellung> out = new ArrayList<>();
        Map<String, List<Bestehende>> jeQuelle = new LinkedHashMap<>();
        for (Fassung f : fassungen.desEinbaus(alt.id())) {
            jeQuelle.computeIfAbsent(f.entityId() + "|" + f.kanal() + "|" + f.art(),
                    k -> new ArrayList<>()).add(bestehende(f));
        }
        for (Map.Entry<String, List<Bestehende>> e : jeQuelle.entrySet()) {
            Bestehende b = QuelleEinstellungRegeln.gueltigZu(e.getValue(), a.zeitpunkt());
            if (b == null) {
                continue;
            }
            Fassung vorlage = fassungen.eine(UUID.fromString(b.id())).orElseThrow();
            Urteil u = QuelleEinstellungRegeln.neueFassung(new Eingang(a.zeitpunkt(), null, List.of(),
                    new Neu(vorlage.art(), vorlage.wert(), vorlage.anwendung(), a.zeitpunkt(), null), a.jetzt()));
            if (!u.ok()) {
                log.info("Einstellung {} von {} nicht übernommen: {}", vorlage.art(), alt.einbauKennzeichen(),
                        u.fehler().code());
                continue;
            }
            UUID id = fassungen.anlegen(new NeueFassung(tenant, neuId, vorlage.entityId(), vorlage.kanal(),
                    vorlage.art(), vorlage.wert(), vorlage.anwendung(), QuelleEinstellungRegeln.EINTRAG,
                    a.zeitpunkt(), null, null, Boolean.TRUE.equals(u.rueckwirkend()),
                    "Beim Zählerwechsel von " + alt.einbauKennzeichen() + " übernommen", wer, a.jetzt()));
            out.add(new ZaehlerwechselDto.Einstellung(id, vorlage.art(), vorlage.entityId(), vorlage.kanal(),
                    vorlage.anwendung()));
        }
        return out;
    }

    // ----------------------------------------------------------- Komponenten-Fassung

    /**
     * Eine neue Komponenten-Fassung entsteht NUR, wenn die Verbindung wirklich neu ist (§5.5:
     * „gleiche Datenquelle und Geräte-ID“ → keine). Geschrieben wird dabei genau das eine Feld, das
     * am Gerät hängt: seine Geräte-ID — unter dem Schlüssel, den auch die Geräte-Ableitung liest
     * ({@code mb_slave_id} bei {@code solarman_v5}, sonst {@code unit_id}). Die Adresse bleibt die
     * der Komponente: sie gehört der Datenquelle (AP-06), nicht diesem Vorgang.
     */
    private void komponentenFassung(UUID tenant, UUID siteId, List<UUID> komponenten, Integer geraeteId,
            ProtokollAkteur wer) {
        if (geraeteId == null) {
            return;
        }
        for (UUID entityId : komponenten) {
            Map<String, Object> zeile = jdbc.queryForList("SELECT communication, connection_json::text AS verbindung, "
                    + "definition_version FROM measurement_point WHERE id = ? AND site_id = ?", entityId, siteId)
                    .stream().findFirst().orElse(null);
            if (zeile == null) {
                continue;
            }
            String schluessel = "solarman_v5".equals(zeile.get("communication")) ? "mb_slave_id" : "unit_id";
            ObjectNode verbindung = verbindungsObjekt((String) zeile.get("verbindung"));
            if (verbindung.has(schluessel) && verbindung.get(schluessel).asText().equals(String.valueOf(geraeteId))) {
                continue;
            }
            verbindung.put(schluessel, geraeteId.intValue());
            int revision = (Integer) zeile.get("definition_version");
            ComponentDefinitionRepository.Applied angewendet =
                    definitionen.applyConnection(siteId, entityId, revision, verbindung.toString());
            if (angewendet == null) {
                throw MessstelleAbgelehnt.schnittstelle(Schnittstelle.ZUSTAND_PASST_NICHT,
                        "Die Komponente wurde soeben verändert. Laden Sie neu und prüfen Sie Ihre Eingabe.",
                        Map.of());
            }
            definitionen.recordStoredVersion(tenant, siteId, entityId, angewendet.version(), wer.sub(),
                    "Zählerwechsel: neue Geräte-ID " + geraeteId);
            outbox.enqueue(tenant, siteId, entityId, angewendet.version(), "component_edit");
        }
    }

    private ObjectNode verbindungsObjekt(String text) {
        try {
            JsonNode n = text == null || text.isBlank() ? null : json.readTree(text);
            return n != null && n.isObject() ? (ObjectNode) n : json.createObjectNode();
        } catch (JsonProcessingException e) {
            return json.createObjectNode();
        }
    }

    // ----------------------------------------------------------- Protokoll und Marke

    /** EIN Eintrag je betroffener Messstelle, mit Urheber und Rückwirkend-Marker (§5.14). */
    private void protokoll(UUID messstelleId, List<Umzug> umzuege, Einbau alt, String neuesKennzeichen,
            Anfrage a, List<ZaehlerwechselDto.Einstellung> einstellungen, boolean verbindungNeu,
            ProtokollAkteur wer) {
        Map<String, Object> vorher = new LinkedHashMap<>();
        vorher.put("einbau", alt.einbauKennzeichen());
        vorher.put("seriennummer", alt.seriennummer());
        vorher.put("ausgebaut_am", null);
        List<Map<String, Object>> alteQuellen = new ArrayList<>();
        for (Umzug z : umzuege) {
            Map<String, Object> q = new LinkedHashMap<>();
            q.put("quelle_id", z.alt().id().toString());
            q.put("groesse", z.ziel().groesse());
            q.put("richtung", z.ziel().richtung());
            q.put("rolle", z.alt().rolle());
            q.put("gueltig_bis", null);
            alteQuellen.add(q);
        }
        vorher.put("quellen", alteQuellen);

        Map<String, Object> neu = new LinkedHashMap<>();
        neu.put("vorgaenger", alt.einbauKennzeichen());
        neu.put("vorgaenger_seriennummer", alt.seriennummer());
        neu.put("einbau", neuesKennzeichen);
        neu.put("seriennummer", a.geraet().seriennummer());
        neu.put("geraet", alt.kennzeichen());
        neu.put("zeitpunkt", iso(a.zeitpunkt()));
        neu.put("verbindung_neu", verbindungNeu);
        neu.put("einstellungen_uebernommen", einstellungen.size());
        List<Map<String, Object>> neueQuellen = new ArrayList<>();
        for (Umzug z : umzuege) {
            Map<String, Object> q = new LinkedHashMap<>();
            q.put("groesse", z.ziel().groesse());
            q.put("richtung", z.ziel().richtung());
            q.put("rolle", z.alt().rolle());
            q.put("kanal", z.alt().kanal());
            q.put("gueltig_ab", iso(a.zeitpunkt()));
            q.put("endstand", standAlsMap(z.endstand()));
            q.put("anfangsstand", standAlsMap(z.anfangsstand()));
            neueQuellen.add(q);
        }
        neu.put("quellen", neueQuellen);
        if (a.kartenUebernommen() != null) {
            neu.put("anlass", "controllerwechsel");
            neu.put("karten_uebernommen", a.kartenUebernommen());
        }

        boolean rueckwirkend = a.zeitpunkt().isBefore(a.jetzt().truncatedTo(ChronoUnit.MINUTES));
        aenderungen.eintragen(new NeuerEintrag(TenantContext.get(), messstelleId, PROTOKOLL_ART,
                alsJson(vorher), alsJson(neu), a.zeitpunkt(), rueckwirkend, a.grund(), wer.sub(), wer.name(),
                wer.rolle(), wer.art()), a.jetzt());
    }

    /**
     * Die MARKE im Komponenten-Verlauf (§5.5: „Verlauf der Komponente mit Marke ‚Zähler
     * gewechselt'"). Ein ZUSATZ, nie eine Bedingung: {@link ZaehlerwechselMarke} schreibt sie in
     * einem EIGENEN Savepoint; scheitert sie, wird sie dort gemeldet (Log + Zähler) und der Wechsel
     * steht trotzdem.
     *
     * @return in wie vielen Komponenten-Verläufen die Marke steht
     */
    private int marke(UUID tenant, Einbau alt, String neuesKennzeichen, List<UUID> komponenten, Anfrage a,
            ProtokollAkteur wer) {
        int gesetzt = 0;
        for (UUID entityId : komponenten) {
            try {
                marke.schreiben(tenant, alt.siteId(), entityId, alt.einbauKennzeichen(), neuesKennzeichen,
                        a.zeitpunkt(), wer.sub());
                gesetzt++;
            } catch (RuntimeException e) {
                marke.fehlgeschlagen(entityId, alt.einbauKennzeichen(), neuesKennzeichen, e);
            }
        }
        return gesetzt;
    }

    // ----------------------------------------------------------- Ablehnungen

    private static MessstelleAbgelehnt wechselAbgelehnt(WechselUrteil u, Einbau alt) {
        Map<String, Object> fakten = new LinkedHashMap<>();
        if (u.fehler() == Fehler.ZEITPUNKT_VOR_VORGAENGER) {
            fakten.put("einbau", alt.einbauKennzeichen());
            fakten.put("eingebaut_am", zeit(alt.eingebautAm()));
            return MessstelleAbgelehnt.regel(u.fehler(), "Der Zeitpunkt liegt vor dem Einbau von "
                    + alt.einbauKennzeichen() + " (" + anzeige(alt.eingebautAm())
                    + "). Wählen Sie einen späteren Zeitpunkt.", fakten);
        }
        fakten.put("zeitpunkt", u.ohneGeraetAb());
        fakten.put("einbau", alt.einbauKennzeichen());
        return MessstelleAbgelehnt.regel(u.fehler(), alt.einbauKennzeichen() + " ist seit "
                + ANZEIGE.format(u.ohneGeraetAb()) + " ausgebaut und steckt nicht mehr. Ein abgeschlossener "
                + "Einbau wird nie ein zweites Mal getauscht — tauschen Sie das Gerät aus, das jetzt steckt.",
                fakten);
    }

    private static MessstelleAbgelehnt beendenAbgelehnt(Fehler f, Quelle q) {
        Map<String, Object> fakten = new LinkedHashMap<>();
        fakten.put("messstelle", q.messstelle());
        fakten.put("quelle_id", q.id().toString());
        fakten.put("gueltig_ab", zeit(q.gueltigAb()));
        fakten.put("gueltig_bis", zeit(q.gueltigBis()));
        return MessstelleAbgelehnt.regel(f, "Die Quelle von " + q.messstelle() + " an " + q.einbau()
                + " ist seit " + anzeige(q.gueltigBis()) + " beendet. Eine Quelle wird nur einmal beendet — "
                + "der Wechsel würde sie ein zweites Mal beenden.", fakten);
    }

    private static MessstelleAbgelehnt bindungAbgelehnt(BindungUrteil u, Messstelle m, Groesse ziel, Quelle q,
            Einbau alt, Anfrage a) {
        Map<String, Object> fakten = new LinkedHashMap<>();
        fakten.put("messstelle", m.kennzeichen());
        fakten.put("groesse", ziel.groesse());
        fakten.put("richtung", ziel.richtung());
        String satz;
        switch (u.fehler()) {
            case ZEITPUNKT_VOR_VORGAENGER -> {
                fakten.put("gueltig_ab", zeit(q.gueltigAb()));
                satz = "Der Zeitpunkt liegt vor dem Beginn der Quelle von " + m.kennzeichen() + " an "
                        + alt.einbauKennzeichen() + " (" + anzeige(q.gueltigAb())
                        + "). Wählen Sie einen späteren Zeitpunkt.";
            }
            case BINDUNG_UEBERLAPPT -> satz = m.kennzeichen() + " hat ab " + anzeige(a.zeitpunkt())
                    + " bereits eine Quelle für „" + ziel.groesse() + " · " + ziel.richtung()
                    + "“. Beenden Sie diese oder wählen Sie einen anderen Zeitpunkt.";
            case KANAL_BEREITS_FUEHREND -> {
                fakten.put("bestehende_messstelle", u.messstelle());
                satz = "Dieser Messwert speist ab " + anzeige(a.zeitpunkt()) + " bereits " + u.messstelle()
                        + " (führend). Ein Messwert kann nur eine Messstelle führend speisen.";
            }
            case QUELLE_PASST_NICHT -> {
                fakten.put("grund", u.grund());
                satz = "Der Messwert „" + q.kanal() + "“ passt nicht mehr zur Größe „" + ziel.groesse()
                        + " · " + ziel.richtung() + "“ von " + m.kennzeichen() + ".";
            }
            default -> satz = "Die Quelle von " + m.kennzeichen() + " lässt sich so nicht auf das neue Gerät "
                    + "umbinden.";
        }
        return MessstelleAbgelehnt.regel(u.fehler(), satz, fakten);
    }

    private static MessstelleAbgelehnt soebenVeraendert(Einbau alt) {
        return MessstelleAbgelehnt.schnittstelle(Schnittstelle.ZUSTAND_PASST_NICHT, alt.einbauKennzeichen()
                + " wurde soeben verändert. Laden Sie neu und prüfen Sie Ihre Eingabe.", Map.of());
    }

    private static void nichtArchiviert(Messstelle m) {
        if (m.archiviertAm() != null) {
            Map<String, Object> fakten = new LinkedHashMap<>();
            fakten.put("archiviert_am", zeit(m.archiviertAm()));
            throw MessstelleAbgelehnt.schnittstelle(Schnittstelle.ZUSTAND_PASST_NICHT, m.kennzeichen()
                    + " ist seit " + anzeige(m.archiviertAm()) + " archiviert — an einer archivierten "
                    + "Messstelle wird kein Zähler gewechselt.", fakten);
        }
    }

    // ----------------------------------------------------------- Gerüst

    /**
     * Das Kennzeichen des neuen Einbaus: das gewählte, sonst {@code GR-4.2}, {@code GR-4.3} … —
     * die erste freie Nummer am Gerät. Ein schon belegtes wird abgelehnt, nie überschrieben.
     */
    private String einbauKennzeichen(Einbau alt, String gewaehlt) {
        Set<String> belegt = new LinkedHashSet<>(geraete.einbauKennzeichen());
        if (gewaehlt != null) {
            if (belegt.contains(gewaehlt)) {
                Map<String, Object> fakten = new LinkedHashMap<>();
                fakten.put("einbau_kennzeichen", gewaehlt);
                throw MessstelleAbgelehnt.regel(Fehler.KENNZEICHEN_BELEGT, "„" + gewaehlt
                        + "“ ist bereits an ein Gerät vergeben. Kennzeichen sind je Unternehmen eindeutig — "
                        + "auch ausgebaute bleiben belegt.", fakten);
            }
            return gewaehlt;
        }
        for (int n = 2; n < 1000; n++) {
            String kandidat = alt.kennzeichen() + "." + n;
            if (!belegt.contains(kandidat)) {
                return kandidat;
            }
        }
        throw new IllegalStateException("kein freies Einbau-Kennzeichen für " + alt.kennzeichen());
    }

    private Instant beginn(Messstelle m) {
        return MessstelleService.beginn(zuordnungen.orte(m.id()));
    }

    private static Groesse ziel(Messstelle m, List<Nebengroesse> neben, Quelle q) {
        if (m.hauptgroesse().groesse().equals(q.groesse()) && m.hauptgroesse().richtung().equals(q.richtung())) {
            return m.hauptgroesse();
        }
        return neben.stream().map(Nebengroesse::groesse)
                .filter(g -> g.groesse().equals(q.groesse()) && g.richtung().equals(q.richtung()))
                .findFirst().orElseThrow(() -> new IllegalStateException(
                        "Quelle ohne Größe an " + m.kennzeichen()));
    }

    private static boolean gilt(Quelle q, Instant t) {
        return MessstelleQuelleService.gilt(q, t);
    }

    private static Bindung bindung(Quelle q) {
        return new Bindung(q.rolle(), q.groesse(), q.richtung(), q.entityId().toString(), q.kanal(), q.geraet(),
                q.einbau(), q.kanalWertart(), q.zweck(), zeit(q.gueltigAb()), zeit(q.gueltigBis()));
    }

    private static Bestehende bestehende(Fassung f) {
        return new Bestehende(f.id().toString(), f.wert(), f.anwendung(), f.gueltigAb(), f.gueltigBis());
    }

    private static ZaehlerwechselDto.Einbau einbauDto(Einbau e) {
        return new ZaehlerwechselDto.Einbau(e.id(), e.kennzeichen(), e.einbauKennzeichen(), e.seriennummer(),
                zeit(e.eingebautAm()), zeit(e.ausgebautAm()));
    }

    private static MessstelleQuelleDto.Quelle darstellung(Quelle q, Instant jetzt) {
        Instant minute = jetzt.truncatedTo(ChronoUnit.MINUTES);
        String status = q.gueltigAb().isAfter(minute) ? "geplant"
                : q.gueltigBis() == null || q.gueltigBis().isAfter(minute) ? "gilt" : "beendet";
        return new MessstelleQuelleDto.Quelle(q.id(), q.messstelleId(), q.groesse(), q.richtung(), q.rolle(),
                q.zweck(), q.entityId(), q.komponenteName(), q.siteId(), q.kanal(), q.kanalWertart(),
                q.herleitung(), new MessstelleQuelleDto.Geraet(q.geraetId(), q.geraet(), q.einbau()),
                zeit(q.gueltigAb()), zeit(q.gueltigBis()), status, dtoStand(q.anfangsstand()),
                dtoStand(q.endstand()), q.rueckwirkend(), q.herkunft(), zeit(q.eingetragenAm()),
                q.eingetragenVon(), q.anteil());
    }

    private static MessstelleQuelleDto.Stand dtoStand(MessstelleQuelleRepository.Stand s) {
        return s == null ? null : new MessstelleQuelleDto.Stand(s.wert(), s.einheit());
    }

    private static MessstelleQuelleDto.Rueckwirkung rueckwirkung(Instant jetzt, Instant zeitpunkt) {
        MessstelleRegeln.Rueckwirkung r = MessstelleRegeln.rueckwirkung(zeit(jetzt), zeit(zeitpunkt));
        return new MessstelleQuelleDto.Rueckwirkung(r.art(), r.minuten(), r.abzeichen());
    }

    private static Instant aufDieMinute(OffsetDateTime z, Instant vorgabe) {
        if (z == null) {
            return vorgabe;
        }
        if (z.getSecond() != 0 || z.getNano() != 0) {
            throw MessstelleAbgelehnt.anfrage("zeitpunkt", "Der Zeitpunkt gilt auf die Minute — ohne Sekunden.");
        }
        return z.toInstant();
    }

    private static Stand stand(MessstelleQuelleDto.Stand s, String feld) {
        if (s == null) {
            return null;
        }
        if (s.wert() == null || s.wert().isNaN() || s.wert().isInfinite()) {
            throw MessstelleAbgelehnt.anfrage(feld + ".wert", "Ein Ablesestand braucht einen Wert.");
        }
        return new Stand(s.wert(), s.einheit() == null || s.einheit().isBlank() ? null : s.einheit().strip());
    }

    private static MessstelleQuelleRepository.Stand repoStand(Stand s) {
        return s == null ? null : new MessstelleQuelleRepository.Stand(s.wert(), s.einheit());
    }

    private static Map<String, Object> standAlsMap(Stand s) {
        if (s == null) {
            return null;
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("wert", s.wert());
        m.put("einheit", s.einheit());
        return m;
    }

    private String alsJson(Map<String, Object> werte) {
        try {
            return json.writeValueAsString(werte);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Protokolleintrag nicht darstellbar", e);
        }
    }

    private static String text(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }

    private static String oder(String a, String b) {
        return a != null ? a : b;
    }

    private static OffsetDateTime zeit(Instant t) {
        return t == null ? null : OffsetDateTime.ofInstant(t, ZEITZONE);
    }

    private static String iso(Instant t) {
        return t == null ? null : DateTimeFormatter.ISO_OFFSET_DATE_TIME.format(zeit(t));
    }

    private static String anzeige(Instant t) {
        return t == null ? "—" : ANZEIGE.format(zeit(t));
    }
}
