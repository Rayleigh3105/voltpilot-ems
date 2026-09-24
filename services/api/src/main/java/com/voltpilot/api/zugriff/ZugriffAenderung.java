package com.voltpilot.api.zugriff;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.OrtProtokoll;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.RechteAbleitung;
import com.voltpilot.api.uems.RechteAbleitung.Aenderung;
import com.voltpilot.api.uems.RechteAbleitung.AenderungErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.AenderungsArt;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.Kundenbereich;
import com.voltpilot.api.uems.RechteAbleitung.Konto;
import com.voltpilot.api.uems.RechteAbleitung.KontoZustand;
import java.util.ArrayList;
import com.voltpilot.api.uems.RechteAbleitung.Person;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.RechteAbleitung.Standort;
import com.voltpilot.api.zugriff.ZugriffContext.Zugriff;
import com.voltpilot.api.zugriff.ZugriffContext.Zugang;
import com.voltpilot.api.zugriff.ZugriffRepository.NeueZuweisung;
import com.voltpilot.api.zugriff.ZugriffRepository.StandortEintrag;
import com.voltpilot.api.zugriff.ZugriffRepository.Zeile;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;

/**
 * Der EINE Prüfpunkt für jede Änderung an einer Zuweisung (UEMS AP-03 IP-9, §4.7, A8).
 *
 * <p><b>Warum genau eine Stelle.</b> Zwei Regeln sind nur dann Regeln, wenn kein Weg an ihnen vorbeiführt:
 * <ul>
 *   <li><b>Der letzte Kundenadministrator ist geschützt</b> (409 {@code letzter_kundenadministrator}). Ein
 *       Kundenbereich ohne Kundenadministrator wäre ein Kunde, der sich selbst ausgesperrt hat — und niemand
 *       außer VoltPilot könnte ihn wieder hineinlassen.</li>
 *   <li><b>Die eigene Zuweisung ist unveränderlich</b> (409 {@code eigene_zuweisung}, W12). Niemand entzieht
 *       sich selbst und niemand erweitert sich selbst; dafür braucht es eine zweite Person.</li>
 * </ul>
 * Das URTEIL fällt der Vertrag ({@link RechteAbleitung#zuweisungAendern}) — hier steht nur, WOMIT gefragt wird
 * und was danach geschrieben wird. {@code ZugriffAenderungArchitekturTest} hält fest, dass
 * {@link ZugriffRepository#zuweisen} und {@link ZugriffRepository#beenden} außerhalb dieser Klasse nur dort
 * gerufen werden, wo der Vertrag einen EIGENEN Prüfpunkt führt (die Unterstützung, IP-8) oder noch niemand da
 * ist, den man schützen könnte (die Bestandsübernahme, IP-2).
 *
 * <p><b>Der Entzug wirkt sofort und schaltet nie.</b> Zuweisungsentzug schreibt {@code beendet_am},
 * Kontosperren ändern den Spiegel; ein gesetzter
 * Handeingriff bleibt unverändert in {@code device_override} und läuft bis zu seinem Ende (E15) — er bekommt nur
 * ein Etikett ({@code SiteInterventionController}). Die nächste Anfrage des Betroffenen liest die Zuweisung neu
 * ({@link ZugriffKontextLader}) und bekommt {@code zugriff_beendet}; es gibt keinen Zwischenspeicher dazwischen.
 *
 * <p><b>Zwei Protokolle, ein Vorgang.</b> {@code zugriff_protokoll} trägt den Entzug für den Kundenbereich
 * (IP-2); zusätzlich bekommt der STANDORT eine Zeile in seinem Änderungsprotokoll ({@code ort_aenderung},
 * AP-02 §4.4) — damit AP-12 später erklären kann, wer im Berichtszeitraum handeln durfte. Eine
 * unternehmensweite Zuweisung schreibt diese Zeile am Unternehmen.
 */
@Service
public class ZugriffAenderung {

    /** Der Eintrag im Änderungsprotokoll des Standorts (AP-02 §4.4) — Wort des CHECKs von V20260916150000. */
    public static final String ART_ENTZOGEN = "zugriff_entzogen";

    /** Dasselbe für eine neue Zuweisung: der Standort hält fest, wer an ihm handeln darf. */
    public static final String ART_ZUGEWIESEN = "zugriff_zugewiesen";

    private final ZugriffRepository zugriffe;
    private final OrtProtokoll ortProtokoll;
    private final JdbcTemplate jdbc;

    public ZugriffAenderung(ZugriffRepository zugriffe, OrtProtokoll ortProtokoll, JdbcTemplate jdbc) {
        this.zugriffe = zugriffe;
        this.ortProtokoll = ortProtokoll;
        this.jdbc = jdbc;
    }

    /**
     * Entzieht EINE Zuweisung — sofort, einmal, mit beiden Protokollzeilen.
     *
     * @throws ResponseStatusException 404, wenn es die Zuweisung im Kundenbereich nicht gibt, sie schon beendet
     *     ist oder sie eine UNTERSTÜTZUNG ist (die hat ihren eigenen Weg, IP-8)
     * @throws ZugriffAbgelehnt 409 nach {@link RechteAbleitung#zuweisungAendern}
     */
    @Transactional
    public void entziehen(UUID zugriffId, String grund, ProtokollAkteur akteur) {
        sperreKundenbereich();
        Instant jetzt = Instant.now();
        Zeile z = kundenZuweisung(zugriffId);
        pruefen(AenderungsArt.ENTZIEHEN, z.benutzerSub(), z.rolle(), standorte(z), jetzt);
        String bereinigt = grund == null || grund.isBlank() ? null : grund.trim();
        if (!zugriffe.beenden(zugriffId, jetzt, akteur, bereinigt)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Zuweisung nicht gefunden.");
        }
        protokollieren(ART_ENTZOGEN, z, bereinigt, jetzt, akteur);
    }

    /**
     * Trägt eine Zuweisung ein (Rolle × Geltungsbereich, ab jetzt). Das Konto muss im Kundenbereich schon
     * gespiegelt sein — Konten legt der Kundenadministrator an (IP-13/IP-14), nicht dieser Weg.
     */
    @Transactional
    public UUID zuweisen(String benutzerSub, Rolle rolle, UUID standortId, String grund, ProtokollAkteur akteur) {
        return zuweisen(benutzerSub, rolle, standortId, null, grund, akteur);
    }

    /**
     * Wie {@link #zuweisen(String, Rolle, UUID, String, ProtokollAkteur)}, mit einem ENDDATUM {@code bis} (letzter
     * Tag, einschließlich; {@code null} = unbefristet). Befristen lässt sich allein die Rolle Einsicht (AP-19 IP-12,
     * RE3: „befristbar“) — ein befristeter Kundenadministrator könnte still als letzter ablaufen; ein Ende in der
     * Vergangenheit (Zeitzone des Kundenbereichs) ist 400.
     */
    @Transactional
    public UUID zuweisen(String benutzerSub, Rolle rolle, UUID standortId, LocalDate bis, String grund,
            ProtokollAkteur akteur) {
        sperreKundenbereich();
        Instant jetzt = Instant.now();
        if (rolle == null || rolle == Rolle.UNTERSTUETZER || rolle == Rolle.VOLTPILOT_BETRIEB) {
            // Der Unterstützer entsteht allein über POST /api/v1/unterstuetzung (IP-8, mit Art, Umfang und Ende).
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Rolle nicht zuweisbar.");
        }
        if (bis != null && rolle != Rolle.EINSICHT) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Befristen lässt sich nur die Rolle Einsicht.");
        }
        String name = zugriffe.spiegel(benutzerSub).filter(b -> b.konto() == Konto.BENUTZER
                && b.zustand() != KontoZustand.GESPERRT && b.zustand() != KontoZustand.ENTFERNT)
                .map(ZugriffRepository.BenutzerSpiegel::anzeigename)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Benutzer nicht gefunden."));
        List<String> standorte = standortId == null ? List.of()
                : List.of(kennzeichen(standortId).orElseThrow(
                        () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Standort nicht gefunden.")));
        pruefen(AenderungsArt.ZUWEISEN, benutzerSub, rolle, standorte, jetzt);
        String bereinigt = grund == null || grund.isBlank() ? null : grund.trim();
        ZoneId zone = zugriffe.kundenbereichKopf().zeitzone();
        if (bis != null && bis.isBefore(LocalDate.ofInstant(jetzt, zone))) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Das Enddatum liegt in der Vergangenheit.");
        }
        Instant endetAm = bis == null ? null : bis.plusDays(1).atStartOfDay(zone).toInstant();
        UUID id = zugriffe.zuweisen(new NeueZuweisung(benutzerSub, rolle, standortId, null, null, jetzt, bis, endetAm,
                zone, akteur.sub()), name, akteur, bereinigt);
        protokollieren(ART_ZUGEWIESEN, zugriffe.zeile(id).orElseThrow(), bereinigt, jetzt, akteur);
        return id;
    }

    /** Ein Konto sperren oder entfernen: derselbe Vertragsentscheid wie beim Zuweisungsentzug. */
    @Transactional
    public void kontoBeenden(String sub, boolean entfernen, ProtokollAkteur akteur) {
        kontoBeenden(sub, entfernen, akteur, false);
    }

    /**
     * Ausschließlich vollständiges Plattform-Offboarding: der Kundenbereich endet, deshalb bleibt kein
     * letzter Administrator zurück. Schreibt dieselbe Sperre und dieselben Protokolle wie der Einzelweg.
     * Die vollständige Kontenliste kommt aus AdminBenutzerService, niemals aus einem Kunden-Request.
     */
    @Transactional
    @org.springframework.security.access.prepost.PreAuthorize("hasRole('platform-admin')")
    public void kundenbereichSperren(List<String> konten, ProtokollAkteur akteur) {
        Zugriff kontext = ZugriffContext.get();
        if (kontext == null || kontext.konto() != Konto.PLATTFORM || kontext.zugang() != Zugang.UMSCHALTER) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN);
        }
        sperreKundenbereich();
        for (String sub : konten) kontoBeenden(sub, false, akteur, true);
    }

    private void kontoBeenden(String sub, boolean entfernen, ProtokollAkteur akteur, boolean offboarding) {
        AenderungsArt art = entfernen ? AenderungsArt.ENTFERNEN : AenderungsArt.SPERREN;
        sperreKundenbereich();
        Instant jetzt = Instant.now();
        var konto = zugriffe.spiegel(sub).filter(b -> b.konto() == Konto.BENUTZER
                && (offboarding || b.zustand() != KontoZustand.ENTFERNT)).orElseThrow(
                        () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Benutzer nicht gefunden."));
        if (!offboarding) pruefen(art, sub, null, List.of(), jetzt);
        KontoZustand zustand = art == AenderungsArt.SPERREN ? KontoZustand.GESPERRT : KontoZustand.ENTFERNT;
        if (konto.zustand() == zustand) return;
        var zeilen = zugriffe.zuweisungen(sub).stream().filter(z -> z.beendetAm() == null).toList();
        for (Zeile z : zeilen) {
            if (art == AenderungsArt.ENTFERNEN) zugriffe.beenden(z.id(), jetzt, akteur, null, art.code());
            else zugriffe.kontoZuweisungProtokoll(art.code(), z, akteur, null);
            protokollieren(ART_ENTZOGEN, z, null, jetzt, akteur);
        }
        if (zeilen.isEmpty()) {
            zugriffe.kontoProtokoll(art.code(), sub, konto.anzeigename(), akteur);
            protokollieren(ART_ENTZOGEN, sub, null, null, null, null, jetzt, akteur);
        }
        zugriffe.kontoZustandSetzen(sub, zustand);
    }

    /** Plattform-Gegenweg zum Sperren: vorhandene Zuweisungen wirken wieder, entzogene bleiben beendet. */
    @Transactional
    public void kontoAktivieren(String sub, ProtokollAkteur akteur) {
        sperreKundenbereich();
        Zugriff kontext = ZugriffContext.get();
        if (kontext == null || kontext.konto() != Konto.PLATTFORM || kontext.zugang() != Zugang.UMSCHALTER) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN);
        }
        var konto = zugriffe.spiegel(sub).filter(b -> b.konto() == Konto.BENUTZER
                && b.zustand() != KontoZustand.ENTFERNT).orElseThrow(
                        () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Benutzer nicht gefunden."));
        if (konto.zustand() != KontoZustand.GESPERRT) return;
        Instant jetzt = Instant.now();
        zugriffe.kontoZustandSetzen(sub, KontoZustand.AKTIV);
        for (Zeile z : zugriffe.zuweisungen(sub)) {
            if (z.beendetAm() != null) continue;
            zugriffe.kontoZuweisungProtokoll("zuweisen", z, akteur, "Konto entsperrt.");
            protokollieren(ART_ZUGEWIESEN, z, "Konto entsperrt.", jetzt, akteur);
        }
    }

    /** Serialisiert auch parallele Entzüge verschiedener Administratoren im selben Kundenbereich. */
    @Transactional(propagation = Propagation.MANDATORY)
    public void sperreKundenbereich() {
        jdbc.queryForObject("SELECT pg_advisory_xact_lock(hashtext(?))", Object.class,
                "uems-benutzerverwaltung:" + TenantContext.get());
    }

    /** Ersetzt die angegebenen Zuweisungen atomar; andere Rollen und künftige Zuweisungen bleiben erhalten. */
    @Transactional
    public void ersetzen(String sub, List<UUID> bisher, Rolle rolle, List<UUID> standorte, ProtokollAkteur akteur) {
        sperreKundenbereich();
        zugriffe.spiegel(sub).filter(b -> b.konto() == RechteAbleitung.Konto.BENUTZER
                && b.zustand() != RechteAbleitung.KontoZustand.GESPERRT
                && b.zustand() != RechteAbleitung.KontoZustand.ENTFERNT)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
        pruefen(AenderungsArt.ZUWEISEN, sub, rolle, standorte.stream().map(UUID::toString).toList(), Instant.now());
        for (UUID id : bisher) {
            if (!kundenZuweisung(id).benutzerSub().equals(sub)) throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        }
        var verbleibend = zugriffe.zuweisungen(sub).stream().filter(z -> z.beendetAm() == null
                && !bisher.contains(z.id()) && z.rolle() == rolle
                && (z.endetAm() == null || z.endetAm().isAfter(Instant.now()))).toList();
        if (verbleibend.stream().anyMatch(z -> rolle.jeStandort() ? standorte.contains(z.standortId()) : z.standortId() == null)) {
            throw new com.voltpilot.api.benutzer.BenutzerFehler(409, "zuweisung_vorhanden",
                    "Diese Rolle ist für den gewählten Geltungsbereich bereits zugewiesen. Ändern Sie den vorhandenen Eintrag.");
        }
        // Erst entziehen, dann zuweisen; jede Ablehnung rollt den gesamten Wechsel zurück.
        for (UUID id : bisher) entziehen(id, null, akteur);
        if (rolle.jeStandort()) {
            if (standorte.isEmpty()) throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Wählen Sie mindestens einen Standort.");
            for (UUID id : standorte.stream().distinct().toList()) zuweisen(sub, rolle, id, null, akteur);
        } else {
            if (!standorte.isEmpty()) throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
            zuweisen(sub, rolle, null, null, akteur);
        }
    }

    // ------------------------------------------------------------------ das Urteil

    /**
     * Die Frage an den Vertrag. Der Aufrufer kommt aus dem {@link ZugriffContext} der Anfrage, nie aus einem
     * Anfragekörper; die Kundenadministratoren sind die zu {@code jetzt} WIRKSAMEN.
     *
     * <p>Ein betroffenes BESTANDSKONTO (E12) wird als Kundenadministrator mitgezählt. Weitere unbekannte
     * Bestandskonten zählen konservativ nicht als Ersatz; gesperrte und entfernte Konten ebenso wenig.
     * Der Start-Lauf übernimmt die übrigen Konten ({@code ZugriffBestandLaeufer}).
     */
    private void pruefen(AenderungsArt art, String betroffenerSub, Rolle rolle, List<String> standorte,
            Instant jetzt) {
        Zugriff z = ZugriffContext.get();
        if (z == null) {
            // Ohne Zugriff-Kontext gibt es keinen Handelnden, dessen eigene Zuweisung man schützen könnte.
            throw new IllegalStateException("Eine Zuweisung ändert nur eine angemeldete Person");
        }
        Benutzer handelnder = RechtPruefung.benutzer(z);
        List<Person> admins = new ArrayList<>(zugriffe.wirksamImKundenbereich(Rolle.KUNDENADMINISTRATOR, jetzt).stream()
                .filter(a -> zugriffe.spiegel(a.zeile().benutzerSub()).map(b -> b.zustand() != KontoZustand.GESPERRT
                        && b.zustand() != KontoZustand.ENTFERNT).orElse(false))
                .map(a -> new Person(a.zeile().benutzerSub(), a.name())).distinct().toList());
        // E12: ein noch nicht übernommenes Konto ist ebenfalls Kundenadministrator.
        // Unbekannte weitere Bestandskonten zählen konservativ nicht als Ersatz.
        if (zugriffe.bestandskonto(betroffenerSub)) {
            admins.add(new Person(betroffenerSub, zugriffe.anzeigename(betroffenerSub)));
        }
        Kundenbereich k = new Kundenbereich(zugriffe.kundenbereichKopf().name(),
                zugriffe.standorte().stream().map(s -> new Standort(s.kurzzeichen(), s.name())).toList(), admins);
        AenderungErgebnis u = RechteAbleitung.zuweisungAendern(RechteMatrixDatei.matrix(), handelnder,
                new Person(betroffenerSub, zugriffe.anzeigename(betroffenerSub)),
                new Aenderung(art, rolle, standorte), k, jetzt);
        if (!u.erlaubt()) {
            throw new ZugriffAbgelehnt(u.http(), u.grund(), u.text());
        }
    }

    // ------------------------------------------------------------------ Protokoll des Standorts

    /**
     * Die Zeile im Änderungsprotokoll (AP-02 §4.4): am STANDORT, wenn die Zuweisung einen trägt, sonst am
     * Unternehmen. Sie gilt ab heute in der Zeitzone des Kundenbereichs und ist nie rückwirkend — ein Entzug
     * wirkt jetzt, nicht in der Vergangenheit.
     *
     * <p>Fehlt das Unternehmen (ein Kundenbereich vor der Bestandsübernahme von AP-02), bleibt es bei der Zeile
     * im Zugriffsprotokoll: ein fehlender Ort ist kein Grund, einen Entzug scheitern zu lassen.
     */
    private void protokollieren(String art, Zeile z, String grund, Instant jetzt, ProtokollAkteur akteur) {
        protokollieren(art, z.benutzerSub(), z.rolle(), z.standortId(), z.zeitzone(), grund, jetzt, akteur);
    }

    private void protokollieren(String art, String sub, Rolle rolle, UUID standort, ZoneId zeitzone,
            String grund, Instant jetzt, ProtokollAkteur akteur) {
        ZoneId zone = zeitzone == null ? zugriffe.kundenbereichKopf().zeitzone() : zeitzone;
        UUID tenant = TenantContext.get();
        String objektArt = standort != null ? "standort" : "unternehmen";
        UUID objektId = standort != null ? standort : unternehmen(tenant);
        if (objektId == null) {
            return;
        }
        Map<String, Object> neu = new LinkedHashMap<>();
        neu.put("benutzer_sub", sub);
        neu.put("benutzer_name", zugriffe.anzeigename(sub));
        if (rolle != null) neu.put("rolle", rolle.code());
        if (grund != null) {
            neu.put("begruendung", grund);
        }
        ortProtokoll.eintragen(tenant, objektArt, objektId, art, null, neu,
                LocalDate.ofInstant(jetzt, zone), zone, jetzt, akteur);
    }

    private UUID unternehmen(UUID tenant) {
        return jdbc.query("SELECT id FROM unternehmen WHERE tenant_id = ?", (rs, n) -> rs.getObject("id", UUID.class),
                tenant).stream().findFirst().orElse(null);
    }

    private Zeile kundenZuweisung(UUID zugriffId) {
        Zeile z = zugriffe.zeile(zugriffId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Zuweisung nicht gefunden."));
        if (z.rolle() == Rolle.UNTERSTUETZER) {
            // Eine Unterstützung endet über DELETE /api/v1/unterstuetzung/{griff} — dort mit ihrem Griff,
            // ihren Hinweisen und ihrem eigenen Vertrags-Urteil (IP-8).
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Zuweisung nicht gefunden.");
        }
        return z;
    }

    private List<String> standorte(Zeile z) {
        return z.standortId() == null ? List.of()
                : kennzeichen(z.standortId()).map(List::of).orElseGet(List::of);
    }

    private Optional<String> kennzeichen(UUID standortId) {
        return zugriffe.standorte().stream().filter(s -> s.id().equals(standortId))
                .map(StandortEintrag::kurzzeichen).findFirst();
    }
}
