package com.voltpilot.api.components;

import com.voltpilot.api.components.KomponenteHaengtAnRepository.Komponente;
import com.voltpilot.api.components.KomponenteHaengtAnRepository.Zuordnung;
import com.voltpilot.api.components.ZaehlerbaumRegeln.ElternKandidat;
import com.voltpilot.api.components.ZaehlerbaumRegeln.HaengtAnUrteil;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.uems.MessstelleQuelleRepository;
import com.voltpilot.api.uems.MessstelleQuelleRepository.Quelle;
import com.voltpilot.api.uems.MessstelleZuordnungService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.MessstelleDto;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.web.server.ResponseStatusException;

/**
 * Wo eine Komponente im Zählerbaum einer Anlage hängt (Konzept
 * {@code vp-zaehlerbaum-konzept}, Captain-Entscheide E1-E5 vom 10.11.2026,
 * alle A; Vertrag {@code docs/contracts/v2/zaehlerbaum.md}). Löst Anlage,
 * Rolle/Typ der Eltern-Komponente und den bestehenden Baum aus der Datenbank
 * auf und ruft {@link ZaehlerbaumRegeln#haengtAnPruefen} mit den schon
 * aufgelösten Werten (R6), bevor geschrieben wird.
 *
 * <p>Für eine gerätegebundene Messstelle (Quellenbindung
 * {@code messstelle_quelle}) übernimmt derselbe Schritt ihre elektrische
 * Stellung (§4) - BEST EFFORT, nach dem Commit: ein verlorener Versuch ist
 * eine Abweichung zwischen Gerät und Messstelle, die eine spätere Prüfung
 * meldet, nie ein Grund, die Geräte-Änderung selbst abzulehnen (dasselbe Muster
 * wie {@code TopologyService#pushToDevice}).
 */
@Service
public class ZaehlerbaumService {

    private static final Logger log = LoggerFactory.getLogger(ZaehlerbaumService.class);

    /** Dieselbe Vorgabe-Zeitzone wie der Ortsbaum (AP-02/AP-04): der Kundenbereich ist DACH. */
    private static final ZoneId ZEITZONE = ZoneId.of("Europe/Berlin");

    private final Geltungsbereich geltungsbereich;
    private final KomponenteHaengtAnRepository zuordnungen;
    private final MessstelleQuelleRepository quellen;
    private final MessstelleZuordnungService messstellen;

    private volatile Clock uhr = Clock.systemUTC();

    public ZaehlerbaumService(Geltungsbereich geltungsbereich, KomponenteHaengtAnRepository zuordnungen,
            MessstelleQuelleRepository quellen, MessstelleZuordnungService messstellen) {
        this.geltungsbereich = geltungsbereich;
        this.zuordnungen = zuordnungen;
        this.quellen = quellen;
        this.messstellen = messstellen;
    }

    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    private LocalDate heute() {
        return LocalDate.now(uhr.withZone(ZEITZONE));
    }

    // ------------------------------------------------------------------ Lesen

    /**
     * Woran eine Komponente HEUTE hängt; {@code null} = an der Wurzel.
     *
     * <p><b>Kein {@code requireSite}:</b> {@link #baum} speist das
     * Topologie-Lesemodell ({@code TopologyService#topology}), das für eine
     * fremde Anlage absichtlich leer statt 404 bleibt (ein Leser baut daraus
     * sein eigenes „unbekannt"). Ein direkter Lese-Weg für den Zählerbaum
     * selbst prüft die Sichtbarkeit am Controller, wie {@code WerteController}
     * es mit seinem eigenen {@link Geltungsbereich} tut.
     */
    public UUID haengtAnHeute(UUID siteId, UUID komponenteId) {
        return baum(siteId).get(komponenteId);
    }

    /** Der ganze aktive Baum einer Anlage heute: komponente_id → haengt_an. */
    public Map<UUID, UUID> baum(UUID siteId) {
        return zuordnungen.aktiverBaum(siteId, heute());
    }

    // --------------------------------------------------------------- Anlegen

    /**
     * Die erste Zuordnung einer gerade angelegten Komponente - ohne Vorgänger,
     * deshalb ohne die Frage „seit wann". {@code haengtAn = null} schreibt
     * KEINE Zeile (Vorgabe: hängt an der Wurzel).
     */
    @Transactional
    public void einhaengenBeiAnlegen(UUID siteId, UUID komponenteId, UUID haengtAn, String createdBy) {
        if (haengtAn == null) {
            return;
        }
        UUID tenant = TenantContext.get();
        pruefen(siteId, komponenteId, haengtAn);
        zuordnungen.eintragen(tenant, komponenteId, haengtAn, heute(), null, createdBy);
        syncMessenNachCommit(siteId, komponenteId, haengtAn, heute(), false);
    }

    /** Seit wann ein Umhängen gilt (R5, Gerätemenü „Wo hängt er?"). */
    public enum SeitWann { SCHON_IMMER, AB_TAG }

    /**
     * Hängt eine Komponente um. {@code SCHON_IMMER} ersetzt den laufenden
     * Abschnitt ab seinem eigenen Beginn (frühere Tage rechnen neu);
     * {@code AB_TAG} beendet ihn am Vortag von {@code ab} und beginnt den
     * neuen dort (frühere Tage bleiben, wie sie waren).
     */
    @Transactional
    public void umhaengen(UUID siteId, UUID komponenteId, UUID haengtAn, SeitWann seitWann, LocalDate ab,
            String createdBy) {
        UUID tenant = TenantContext.get();
        List<Zuordnung> eigene = zuordnungen.fuerKomponente(komponenteId).stream()
                .filter(z -> !z.aufgehoben()).toList();
        LocalDate heute = heute();
        Zuordnung laufend = eigene.stream().filter(z -> z.deckt(heute)).findFirst().orElse(null);
        UUID bisherigerEltern = laufend == null ? null : laufend.haengtAn();
        if (java.util.Objects.equals(bisherigerEltern, haengtAn)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Die Komponente hängt bereits dort.");
        }
        pruefen(siteId, komponenteId, haengtAn);
        LocalDate seitWannGilt;
        if (seitWann == SeitWann.SCHON_IMMER) {
            LocalDate seit = laufend == null ? heute : laufend.gueltigAb();
            LocalDate bis = laufend == null ? null : laufend.gueltigBis();
            if (laufend != null) {
                zuordnungen.aufheben(laufend.id(), Instant.now(uhr));
            }
            if (haengtAn != null) {
                zuordnungen.eintragen(tenant, komponenteId, haengtAn, seit, bis, createdBy);
            }
            seitWannGilt = seit;
        } else {
            LocalDate grenze = ab == null ? heute : ab;
            if (laufend != null && !grenze.isAfter(laufend.gueltigAb())) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                        "Die Komponente hängt schon seit " + laufend.gueltigAb()
                                + " an ihrem heutigen Platz. Wählen Sie ein späteres Datum, oder "
                                + "verwenden Sie „schon immer“, um den laufenden Abschnitt zu ersetzen.");
            }
            if (laufend != null) {
                zuordnungen.beenden(laufend.id(), grenze.minusDays(1));
            }
            if (haengtAn != null) {
                zuordnungen.eintragen(tenant, komponenteId, haengtAn, grenze,
                        laufend == null ? null : laufend.gueltigBis(), createdBy);
            }
            seitWannGilt = grenze;
        }
        syncMessenNachCommit(siteId, komponenteId, haengtAn, seitWannGilt, seitWann == SeitWann.SCHON_IMMER);
    }

    // ------------------------------------------------------------------ R6

    private void pruefen(UUID siteId, UUID komponenteId, UUID haengtAn) {
        geltungsbereich.requireSite(siteId);
        if (haengtAn == null) {
            return;
        }
        Komponente eigene = zuordnungen.komponente(komponenteId);
        Komponente elternKomponente = zuordnungen.komponente(haengtAn);
        if (eigene == null || !siteId.equals(eigene.siteId())) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Komponente nicht gefunden.");
        }
        ElternKandidat eltern = elternKomponente == null ? null
                : new ElternKandidat(elternKomponente.id().toString(), elternKomponente.siteId().toString(),
                        elternKomponente.role(), elternKomponente.entityType());
        if (elternKomponente == null) {
            throw ungueltig("eltern_kein_zaehler");
        }
        List<ZaehlerbaumRegeln.Zuordnung> baum = zuordnungen.aktiverBaum(siteId, heute()).entrySet().stream()
                .map(e -> new ZaehlerbaumRegeln.Zuordnung(e.getKey().toString(),
                        e.getValue() == null ? null : e.getValue().toString()))
                .toList();
        HaengtAnUrteil urteil = ZaehlerbaumRegeln.haengtAnPruefen(komponenteId.toString(),
                siteId.toString(), eigene.role(), eltern, baum);
        if (!urteil.gueltig()) {
            throw ungueltig(urteil.grund());
        }
    }

    private static ResponseStatusException ungueltig(String grund) {
        String satz = switch (grund) {
            case "wurzel_haengt_nirgends" -> "Der Netzanschluss hängt nirgends.";
            case "selbst" -> "Eine Komponente kann nicht an sich selbst hängen.";
            case "fremde_anlage" -> "Die Eltern-Komponente gehört zu einer anderen Anlage.";
            case "eltern_kein_zaehler" -> "Dort hängt nichts: die gewählte Komponente ist kein Zähler.";
            case "zyklus" -> "Das würde einen Kreis im Zählerbaum ergeben.";
            default -> "Diese Zuordnung ist nicht gültig.";
        };
        return new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, satz);
    }

    // ----------------------------------------------------------- Messen (§4)

    private void syncMessenNachCommit(UUID siteId, UUID komponenteId, UUID haengtAn, LocalDate seit,
            boolean korrektur) {
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            syncMessenBestEffort(siteId, komponenteId, haengtAn, seit, korrektur);
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                syncMessenBestEffort(siteId, komponenteId, haengtAn, seit, korrektur);
            }
        });
    }

    /**
     * Ist die Komponente über GENAU EINE führende Quelle an eine Messstelle
     * gebunden, ebenso die neue Eltern-Komponente, wird deren elektrische
     * Stellung nachgezogen: „Unterzähler von" = die Messstelle der
     * Eltern-Komponente. Mehrdeutig (keine oder mehr als eine führende
     * Quelle) heißt NICHTS raten - keine Stellung wird geschrieben.
     *
     * <p>Nur für {@code haengtAn != null}: ein Umhängen zurück an die Wurzel
     * entspräche in Messen „Unterzähler von DIESEM Hauptzähler" - welcher das
     * ist, wäre an dieser Stelle geraten, nicht aufgelöst. Dieser Fall bleibt
     * bewusst aus; eine spätere Prüfung meldet die Abweichung.
     *
     * <p>Ein abgelehntes Urteil (z. B. weil die Messstelle berechnet oder
     * archiviert ist) ändert nichts an der Geräte-Zuordnung; es wird nur
     * gewarnt.
     */
    private void syncMessenBestEffort(UUID siteId, UUID komponenteId, UUID haengtAn, LocalDate seit,
            boolean korrektur) {
        if (haengtAn == null) {
            return;
        }
        try {
            Quelle eigene = einzigeFuehrendeQuelle(komponenteId);
            Quelle elternQuelle = einzigeFuehrendeQuelle(haengtAn);
            if (eigene == null || elternQuelle == null) {
                return;
            }
            messstellen.stellungZuordnen(eigene.messstelleId(),
                    new MessstelleDto.StellungAendern(eigene.siteId(), "Unterzähler",
                            elternQuelle.messstelle(), seit, korrektur, "Zählerbaum: Gerät umgehängt"),
                    ProtokollAkteur.zaehlerbaumUebernahme());
        } catch (RuntimeException e) {
            log.warn("Zählerbaum: Stellung der gebundenen Messstelle nicht nachgezogen (Anlage {}, Komponente {}): {}",
                    siteId, komponenteId, e.toString());
        }
    }

    private Quelle einzigeFuehrendeQuelle(UUID komponenteId) {
        List<Quelle> aktuelle = quellen.derKomponenteAm(komponenteId, Instant.now(uhr)).stream()
                .filter(q -> "fuehrend".equals(q.rolle())).toList();
        return aktuelle.size() == 1 ? aktuelle.get(0) : null;
    }
}
