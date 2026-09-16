package com.voltpilot.api.unterstuetzung;

import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakAdminException;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakUser;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.RechteAbleitung;
import com.voltpilot.api.uems.RechteAbleitung.Antrag;
import com.voltpilot.api.uems.RechteAbleitung.Art;
import com.voltpilot.api.uems.RechteAbleitung.GewaehrenErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.Konto;
import com.voltpilot.api.uems.RechteAbleitung.KontoZustand;
import com.voltpilot.api.uems.RechteAbleitung.Kundenbereich;
import com.voltpilot.api.uems.RechteAbleitung.Person;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.RechteAbleitung.Umfang;
import com.voltpilot.api.uems.RechteAbleitung.UnterstuetzungErgebnis;
import com.voltpilot.api.unterstuetzung.UnterstuetzungAbgelehnt.Ablehnung;
import com.voltpilot.api.unterstuetzung.UnterstuetzungRepository.Anfrage;
import com.voltpilot.api.unterstuetzung.UnterstuetzungRepository.Anlass;
import com.voltpilot.api.unterstuetzung.UnterstuetzungRepository.NeueAnfrage;
import com.voltpilot.api.zugriff.ZugriffRepository;
import com.voltpilot.api.zugriff.ZugriffRepository.BenutzerSpiegel;
import com.voltpilot.api.zugriff.ZugriffRepository.MitName;
import com.voltpilot.api.zugriff.ZugriffRepository.NeueZuweisung;
import com.voltpilot.api.zugriff.ZugriffRepository.StandortEintrag;
import com.voltpilot.api.zugriff.ZugriffRepository.Zeile;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Die Unterstützung (UEMS AP-03 IP-8, Konzept §4.6, E6–E9, A4/A5/A14): gewähren, verlängern, beenden, die
 * Anfrage von VoltPilot und der Notfall-Zugriff — samt dem Hinweis, den die Kundenadministratoren darüber
 * bekommen.
 *
 * <p><b>Eine Unterstützung ist eine Zuweisung, nichts daneben.</b> Sie entsteht als eine Zeile {@code zugriff}
 * je Standort (Rolle {@code unterstuetzer}, Art, Umfang, Ende) und wirkt allein dadurch: {@code ZugriffKontextLader}
 * (IP-4) nimmt {@code X-Kundenbereich} nur gegen eine zu DIESEM Zeitpunkt wirksame Zeile an. Daraus folgt dreierlei,
 * und das ist der Kern dieses Pakets:
 * <ol>
 *   <li><b>Sie endet von selbst.</b> {@code zugriff_zeitraum(gueltig_ab, endet_am, beendet_am)} schließt die Zeile
 *       mit ihrem {@code endet_am} — ohne Läufer, ohne Job, in derselben Abfrage, die jede Anfrage stellt. Der
 *       {@link AblaufLaeufer} beendet also NICHTS; er trägt nach, was die Uhr getan hat (Protokoll {@code ablaufen},
 *       Hinweis), und erinnert 7 Tage vorher. Fällt er aus, bleibt der Zugang trotzdem zu.</li>
 *   <li><b>Der Notfall-Zugriff ist eng und laut.</b> Genau 24 h ({@link RechteAbleitung#NOTFALL}), Grund Pflicht
 *       (422 {@code grund_fehlt}, bevor irgendetwas geschrieben wird), und JEDER Kundenadministrator bekommt
 *       einen Hinweis — heute die Karte im Portal, mit SMTP dieselbe Zeile als E-Mail.</li>
 *   <li><b>Ein Entzug wirkt sofort.</b> {@link #beenden} setzt {@code beendet_am} auf JETZT; die nächste Anfrage
 *       des Unterstützers liest die Zeile neu (IP-4 lädt je Anfrage) und findet sie unwirksam — kein Abwarten
 *       eines Token-Ablaufs.</li>
 * </ol>
 *
 * <p>Die Regeln über Dauer, Standort, Umfang und Grund spricht der Vertrag ({@link RechteAbleitung#gewaehren}),
 * nie dieser Dienst. Das Recht {@code unterstuetzung.verwalten} setzt {@code @Recht} vor dem Handler durch.
 */
@Service
public class UnterstuetzungService {

    private static final Logger log = LoggerFactory.getLogger(UnterstuetzungService.class);

    /**
     * Die zwei Sätze, für die der Rechte-Vertrag (noch) keinen Text führt — die übrigen Hinweise sprechen
     * wörtlich mit seinen Vorlagen ({@code banner_*}, {@code endete_zeitablauf}, {@code beendet_von}). Die
     * endgültige Karte im Portal baut IP-15 (AP-13); hier stehen sie, weil ein Hinweis ohne Text kein Hinweis ist.
     */
    static final String ANFRAGE_SATZ = "VoltPilot-Support bittet um Zugriff auf {standorte} bis {ende} — {umfang}.";
    static final String ERINNERUNG_SATZ = "{banner} — sie endet in {tage} Tagen.";

    /** Zeichen des Startpassworts: keine Verwechslungspaare (0/O, 1/l/I), damit es am Telefon ankommt. */
    private static final String PASSWORT_ZEICHEN = "abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789";
    private static final int PASSWORT_LAENGE = 14;

    private final ZugriffRepository zugriffe;
    private final UnterstuetzungRepository unterstuetzungen;
    private final KeycloakAdminClient keycloak;
    private final SecureRandom zufall = new SecureRandom();
    private volatile Clock uhr = Clock.systemUTC();

    public UnterstuetzungService(ZugriffRepository zugriffe, UnterstuetzungRepository unterstuetzungen,
            KeycloakAdminClient keycloak) {
        this.zugriffe = zugriffe;
        this.unterstuetzungen = unterstuetzungen;
        this.keycloak = keycloak;
    }

    /** Nur für Tests: die Uhr, nach der „wirksam", „läuft ab" und „erinnern" gelten. */
    public void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    public Instant jetzt() {
        return uhr.instant();
    }

    // ================================================================= Gewähren

    /** Der Antrag eines Kundenadministrators (oder die Bestätigung einer Anfrage). */
    public record Gewaehrung(Art art, String email, List<UUID> standorte, Umfang umfang, Instant gueltigAb,
            LocalDate gueltigBis, String grund, UUID anfrageId) {}

    /**
     * Eine gewährte Unterstützung, wie die Route sie antwortet. {@code startpasswort} steht GENAU EINMAL hier
     * und nie in einem Protokoll, einem Hinweis oder einer E-Mail (E14) — es entsteht nur, wenn für die
     * E-Mail-Adresse ein neues Partner-Konto angelegt wurde.
     */
    public record Gewaehrt(UUID id, String startpasswort) {}

    /**
     * Gewähren (§4.6, E5/E6/E9) — eine Zeile je Standort, EINE Transaktion. Bei unbekannter E-Mail entsteht
     * ein Partner-Konto mit Startpasswort (E7, E14); ist die Adresse bekannt, bekommt dieses Konto die
     * Unterstützung, und es wird keine zweite Identität für dieselbe Person erfunden.
     *
     * <p>Eine Unterstützung für VoltPilot gewährt der Kundenadministrator NUR auf eine Anfrage hin (E8):
     * ohne {@code anfrageId} gibt es keinen VoltPilot-Zugang, den nicht jemand angefragt hat.
     */
    @Transactional
    public Gewaehrt gewaehren(Gewaehrung g, ProtokollAkteur akteur) {
        Instant jetzt = jetzt();
        Welt welt = welt(jetzt);
        Anfrage anfrage = g.anfrageId() == null ? null : offeneAnfrage(g.anfrageId());
        Art art = anfrage != null ? Art.VOLTPILOT : g.art();
        if (art == null) {
            throw UnterstuetzungAbgelehnt.anfrage("art");
        }
        if (art == Art.NOTFALL) {
            // Den Notfall nimmt sich VoltPilot selbst (E8) - der Kundenadministrator gewährt ihn nie.
            throw UnterstuetzungAbgelehnt.anfrage("art");
        }
        if (art == Art.VOLTPILOT && anfrage == null) {
            throw UnterstuetzungAbgelehnt.anfrage("anfrage_id");
        }

        List<UUID> standorte = standorte(g.standorte() != null && !g.standorte().isEmpty()
                ? g.standorte() : anfrage != null ? anfrage.standorte() : List.of(), welt);
        Umfang umfang = g.umfang() != null ? g.umfang() : anfrage != null ? anfrage.umfang() : null;
        Instant ab = g.gueltigAb() != null ? g.gueltigAb() : jetzt;
        LocalDate bis = g.gueltigBis() != null ? g.gueltigBis()
                : anfrage != null ? anfrage.gueltigBis()
                : LocalDate.ofInstant(ab, welt.zone()).plusDays(RechteAbleitung.VORGABE_TAGE);
        String grund = g.grund() != null ? g.grund() : anfrage != null ? anfrage.grund() : null;

        GewaehrenErgebnis urteil = RechteAbleitung.gewaehren(
                new Antrag(art, umfang, welt.kennzeichen(standorte), ab, bis.toString(), grund), welt.zone());
        if (!urteil.gueltig()) {
            throw UnterstuetzungAbgelehnt.ausGrund(urteil.grund(), urteil.text());
        }

        Konto konto = art == Art.INSTALLATEUR ? Konto.PARTNER : Konto.PLATTFORM;
        Empfaenger e = art == Art.INSTALLATEUR ? partnerKonto(g.email()) : voltpilotKonto(anfrage);
        zugriffe.benutzerSpiegeln(new BenutzerSpiegel(e.sub(), konto, e.name(), e.email(), KontoZustand.AKTIV));

        UUID griff = eintragen(standorte, e, art, urteil.umfang(), ab, bis, endeAm(bis, welt.zone()), welt.zone(),
                akteur, grund);
        if (anfrage != null && !unterstuetzungen.entscheiden(anfrage.id(), jetzt, akteur.sub(), griff)) {
            throw UnterstuetzungAbgelehnt.von(Ablehnung.ANFRAGE_ENTSCHIEDEN);
        }
        hinweisen(Anlass.GEWAEHRT, welt, griff, null,
                banner(welt, e.name(), art, urteil.umfang(), standorte, ab, bis, grund, jetzt));
        return new Gewaehrt(griff, e.startpasswort());
    }

    /**
     * Verlängern (§4.6: „ein neues Enddatum") unter AP-00 Invariante 4: eine Zeile wird nie umgeschrieben. Die
     * laufende Gewährung wird JETZT beendet und lückenlos durch eine neue mit dem späteren Ende ersetzt —
     * derselbe Unterstützer, dieselben Standorte, derselbe Umfang. Das Protokoll nennt beides {@code verlaengern},
     * damit später niemand einen Entzug liest, wo verlängert wurde.
     */
    @Transactional
    public UUID verlaengern(UUID griff, LocalDate neuesEnde, ProtokollAkteur akteur) {
        Instant jetzt = jetzt();
        Welt welt = welt(jetzt);
        List<Zeile> alt = wirksameGewaehrung(griff, jetzt);
        Zeile erste = alt.get(0);
        if (erste.art() == Art.NOTFALL) {
            throw UnterstuetzungAbgelehnt.von(Ablehnung.NOTFALL_NICHT_VERLAENGERBAR);
        }
        if (neuesEnde == null) {
            throw UnterstuetzungAbgelehnt.anfrage("gueltig_bis");
        }
        Instant neuEndetAm = endeAm(neuesEnde, welt.zone());
        if (erste.endetAm() != null && !neuEndetAm.isAfter(erste.endetAm())) {
            throw UnterstuetzungAbgelehnt.von(Ablehnung.ENDE_NICHT_SPAETER);
        }
        List<UUID> standorte = alt.stream().map(Zeile::standortId).toList();
        GewaehrenErgebnis urteil = RechteAbleitung.gewaehren(new Antrag(erste.art(), erste.umfang(),
                welt.kennzeichen(standorte), jetzt, neuesEnde.toString(), null), welt.zone());
        if (!urteil.gueltig()) {
            throw UnterstuetzungAbgelehnt.ausGrund(urteil.grund(), urteil.text());
        }
        String grund = "verlängert bis " + RechteAbleitung.datum(neuEndetAm.minusMillis(1), welt.zone());
        for (Zeile z : alt) {
            zugriffe.beenden(z.id(), jetzt, akteur, grund, RechteAbleitung.AenderungsArt.VERLAENGERN.code());
        }
        Empfaenger e = new Empfaenger(erste.benutzerSub(), zugriffe.anzeigename(erste.benutzerSub()), null, null);
        UUID griffNeu = eintragen(standorte, e, erste.art(), erste.umfang(), jetzt, neuesEnde, neuEndetAm,
                welt.zone(), akteur, grund);
        hinweisen(Anlass.GEWAEHRT, welt, griffNeu, null, banner(welt, e.name(), erste.art(), erste.umfang(),
                standorte, jetzt, neuesEnde, null, jetzt));
        return griffNeu;
    }

    /**
     * Beenden — SOFORT (§4.7). Jede Zeile der Gewährung bekommt {@code beendet_am = jetzt}; die nächste Anfrage
     * des Unterstützers findet keine wirksame Zeile mehr und bekommt 404 auf jeder Kundenroute. Eine schon
     * beendete Gewährung ist 409, nie ein zweites Ende.
     */
    @Transactional
    public void beenden(UUID griff, String grund, ProtokollAkteur akteur) {
        grund = grund == null || grund.isBlank() ? null : grund.trim();
        Instant jetzt = jetzt();
        Welt welt = welt(jetzt);
        List<Zeile> zeilen = wirksameGewaehrung(griff, jetzt);
        Zeile erste = zeilen.get(0);
        for (Zeile z : zeilen) {
            zugriffe.beenden(z.id(), jetzt, akteur, grund);
        }
        hinweisen(Anlass.BEENDET, welt, griff, null, RechteAbleitung.TEXTE.get("beendet_von")
                .replace("{datum}", RechteAbleitung.datum(jetzt, welt.zone()))
                .replace("{name}", akteur.name()) + " · "
                + zugriffe.anzeigename(erste.benutzerSub()));
    }

    // ================================================================= Anfrage und Notfall (Plattform)

    /** Der Wunsch von VoltPilot: Umfang, Standorte, Dauer, Grund (A5). */
    public record PlattformAntrag(Umfang umfang, List<UUID> standorte, Instant gueltigAb, LocalDate gueltigBis,
            String grund) {}

    /**
     * VoltPilot fragt eine Unterstützung an (E8, A5) — ein Wunsch, kein Zugriff: die Anfrage gewährt NICHTS,
     * bis ein Kundenadministrator sie bestätigt. Jeder von ihnen bekommt den Hinweis.
     */
    @Transactional
    public UUID anfragen(PlattformAntrag a, ProtokollAkteur akteur) {
        Instant jetzt = jetzt();
        Welt welt = welt(jetzt);
        List<UUID> standorte = standorte(a.standorte(), welt);
        Umfang umfang = a.umfang() != null ? a.umfang() : RechteAbleitung.vorgabeUmfang(Art.VOLTPILOT);
        Instant ab = a.gueltigAb() != null ? a.gueltigAb() : jetzt;
        LocalDate bis = a.gueltigBis() != null ? a.gueltigBis()
                : LocalDate.ofInstant(ab, welt.zone()).plusDays(RechteAbleitung.VORGABE_TAGE);
        GewaehrenErgebnis urteil = RechteAbleitung.gewaehren(
                new Antrag(Art.VOLTPILOT, umfang, welt.kennzeichen(standorte), ab, bis.toString(), a.grund()),
                welt.zone());
        if (!urteil.gueltig()) {
            throw UnterstuetzungAbgelehnt.ausGrund(urteil.grund(), urteil.text());
        }
        UUID id = unterstuetzungen.anfragen(new NeueAnfrage(urteil.umfang(), standorte, akteur.sub(), akteur.name(),
                null, ab, bis, welt.zone(), a.grund()));
        String satz = ANFRAGE_SATZ
                .replace("{standorte}", welt.namen(standorte))
                .replace("{ende}", RechteAbleitung.datum(endeAm(bis, welt.zone()).minusMillis(1), welt.zone()))
                .replace("{umfang}", urteil.umfang().kundenwort());
        hinweisen(Anlass.ANFRAGE, welt, null, id, a.grund() == null ? satz : satz + " Grund: " + a.grund());
        return id;
    }

    /**
     * Notfall-Zugriff (E8, A14): VoltPilot gewährt ihn sich selbst — <b>genau 24 Stunden, Grund Pflicht, und
     * jeder Kundenadministrator erfährt davon.</b> Ohne Grund wird nichts angelegt (422 {@code grund_fehlt},
     * gesprochen vom Vertrag). Der Kundenadministrator kann ihn jederzeit beenden wie jede Unterstützung.
     */
    @Transactional
    public UUID notfall(PlattformAntrag a, ProtokollAkteur akteur) {
        Instant jetzt = jetzt();
        Welt welt = welt(jetzt);
        List<UUID> standorte = standorte(a.standorte(), welt);
        Umfang umfang = a.umfang() != null ? a.umfang() : RechteAbleitung.vorgabeUmfang(Art.NOTFALL);
        GewaehrenErgebnis urteil = RechteAbleitung.gewaehren(
                new Antrag(Art.NOTFALL, umfang, welt.kennzeichen(standorte), jetzt, null, a.grund()), welt.zone());
        if (!urteil.gueltig()) {
            throw UnterstuetzungAbgelehnt.ausGrund(urteil.grund(), urteil.text());
        }
        zugriffe.benutzerSpiegeln(new BenutzerSpiegel(akteur.sub(), Konto.PLATTFORM, akteur.name(), null,
                KontoZustand.AKTIV));
        // Der Notfall trägt KEIN Enddatum, nur den Zeitpunkt: 24 h ab jetzt (zugriff_ende_chk).
        UUID griff = eintragen(standorte, new Empfaenger(akteur.sub(), akteur.name(), null, null), Art.NOTFALL,
                urteil.umfang(), jetzt, null, urteil.endet(), welt.zone(), akteur, a.grund());
        hinweisen(Anlass.NOTFALL, welt, griff, null,
                banner(welt, akteur.name(), Art.NOTFALL, urteil.umfang(), standorte, jetzt, null, a.grund(), jetzt));
        log.warn("UEMS-Notfall-Zugriff im Kundenbereich {} durch {} bis {} — Grund: {}", welt.k().name(),
                akteur.name(), urteil.endet(), a.grund());
        return griff;
    }

    // ================================================================= Ablauf und Erinnerung

    /** Was ein Takt getan hat. */
    public record Lauf(int abgelaufen, int erinnert) {

        public boolean geaendert() {
            return abgelaufen > 0 || erinnert > 0;
        }
    }

    /**
     * Der Takt im Kundenbereich des {@code TenantContext} (der {@link AblaufLaeufer} bringt ihn mit): trägt für
     * jede abgelaufene Gewährung {@code ablaufen} ins Protokoll und meldet sie, und erinnert an jede, die
     * innerhalb von {@link RechteAbleitung#ERINNERUNG} endet.
     *
     * <p><b>Er beendet nichts.</b> Der Zugang war mit {@code endet_am} zu — dieser Takt macht ihn nur sichtbar.
     * Deshalb ist ein ausgefallener Läufer ein fehlender Protokolleintrag, nie ein offener Zugang.
     */
    @Transactional
    public Lauf lauf(Instant jetzt) {
        // Ohne Zugriff-Kontext bleiben app.zugriff und app.standort_ids leer - die Policy site_scope (IP-5)
        // filtert dann nicht, und der Takt sieht jeden Standort seines Kundenbereichs.
        Welt welt = welt(jetzt);
        int abgelaufen = 0;
        for (List<Zeile> gruppe : gruppiert(zugriffe.abgelaufeneUnterstuetzungen(jetzt))) {
            Zeile erste = gruppe.get(0);
            String name = zugriffe.anzeigename(erste.benutzerSub());
            for (Zeile z : gruppe) {
                zugriffe.protokollieren(RechteAbleitung.AenderungsArt.ABLAUFEN.code(), z, ZEITABLAUF, null);
            }
            hinweisen(Anlass.ABGELAUFEN, welt, erste.id(), null, RechteAbleitung.TEXTE.get("endete_zeitablauf")
                    .replace("{datum}", RechteAbleitung.datum(erste.endetAm(), welt.zone())) + " · " + name);
            abgelaufen++;
        }
        int erinnert = 0;
        Instant grenze = jetzt.plus(RechteAbleitung.ERINNERUNG);
        for (List<Zeile> gruppe : gruppiert(zugriffe.baldEndendeUnterstuetzungen(jetzt, grenze))) {
            Zeile erste = gruppe.get(0);
            String name = zugriffe.anzeigename(erste.benutzerSub());
            List<UUID> standorte = gruppe.stream().map(Zeile::standortId).toList();
            long tage = Math.max(1, Duration.between(jetzt, erste.endetAm()).toDays());
            String satz = ERINNERUNG_SATZ
                    .replace("{banner}", banner(welt, name, erste.art(), erste.umfang(), standorte,
                            erste.gueltigAb(), erste.gueltigBis(), null, jetzt))
                    .replace("{tage}", String.valueOf(tage));
            if (hinweisen(Anlass.ERINNERUNG, welt, erste.id(), null, satz)) {
                erinnert++;
            }
        }
        return new Lauf(abgelaufen, erinnert);
    }

    // ================================================================= Lesen

    /** Eine Gewährung, wie die Route sie antwortet — die Zeilen einer Gewährung zusammengefasst. */
    public record Sicht(UUID id, Art art, Umfang umfang, List<UUID> standorte, List<String> kennzeichen,
            Person unterstuetzer, Instant gueltigAb, LocalDate gueltigBis, Instant endet, String zustand,
            boolean erinnerung, String grund, String banner, String text) {}

    @Transactional(readOnly = true)
    public List<Sicht> liste() {
        Instant jetzt = jetzt();
        Welt welt = welt(jetzt);
        Map<UUID, String> namen = new LinkedHashMap<>();
        List<Zeile> zeilen = new ArrayList<>();
        for (MitName m : zugriffe.alleUnterstuetzungen()) {
            zeilen.add(m.zeile());
            namen.put(m.zeile().id(), m.name());
        }
        List<Sicht> aus = new ArrayList<>();
        for (List<Zeile> gruppe : gruppiert(zeilen)) {
            Zeile z = gruppe.get(0);
            List<UUID> standorte = gruppe.stream().map(Zeile::standortId).toList();
            String name = namen.getOrDefault(z.id(), z.benutzerSub());
            String grund = zugriffe.grundDerZuweisung(z.id());
            UnterstuetzungErgebnis e = ergebnis(welt, name, z.art(), z.umfang(), standorte, z.gueltigAb(),
                    z.gueltigBis(), z.beendetAm(), z.beendetVon(), grund, jetzt);
            aus.add(new Sicht(z.id(), z.art(), z.umfang(), standorte, welt.kennzeichen(standorte),
                    new Person(z.benutzerSub(), name), z.gueltigAb(), z.gueltigBis(), e.endet(),
                    e.zustand().code(), e.erinnerung(), grund, e.bannerKunde(), e.text()));
        }
        return aus;
    }

    @Transactional(readOnly = true)
    public List<Anfrage> anfragen(boolean nurOffene) {
        return unterstuetzungen.anfragen(nurOffene);
    }

    /** Lehnt eine offene Anfrage ab — sie bleibt sichtbar, gewährt aber nie etwas. */
    @Transactional
    public void ablehnen(UUID anfrageId, ProtokollAkteur akteur) {
        offeneAnfrage(anfrageId);
        if (!unterstuetzungen.entscheiden(anfrageId, jetzt(), akteur.sub(), null)) {
            throw UnterstuetzungAbgelehnt.von(Ablehnung.ANFRAGE_ENTSCHIEDEN);
        }
    }

    @Transactional(readOnly = true)
    public List<UnterstuetzungRepository.Hinweis> hinweise(String empfaengerSub, boolean nurOffene) {
        return unterstuetzungen.hinweise(empfaengerSub, nurOffene);
    }

    @Transactional
    public void hinweisGelesen(UUID id, String empfaengerSub) {
        if (!unterstuetzungen.gelesen(id, empfaengerSub, jetzt())) {
            throw UnterstuetzungAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN);
        }
    }

    // ================================================================= intern

    /** VoltPilot selbst, ohne Person: der Takt trägt nach, was die Uhr getan hat (A4 „durch Zeitablauf"). */
    private static final ProtokollAkteur ZEITABLAUF =
            new ProtokollAkteur(null, "Zeitablauf", Rolle.VOLTPILOT_BETRIEB.code(), "voltpilot");

    /** Das Konto, das die Unterstützung bekommt — mit Startpasswort, wenn es soeben entstanden ist. */
    private record Empfaenger(String sub, String name, String email, String startpasswort) {}

    /** Der Kundenbereich als Eingang des Vertrags, dazu die Kennzeichen-Übersetzung. */
    private record Welt(Kundenbereich k, ZoneId zone, Map<UUID, StandortEintrag> standorte) {

        List<String> kennzeichen(List<UUID> ids) {
            return ids.stream().map(id -> standorte.get(id)).filter(s -> s != null)
                    .map(StandortEintrag::kurzzeichen).toList();
        }

        String namen(List<UUID> ids) {
            return aufzaehlung(ids.stream().map(id -> standorte.get(id)).filter(s -> s != null)
                    .map(StandortEintrag::name).toList());
        }
    }

    /** „Werk Ahrenberg, Werk Lindach und Werk Ahrenberg Nord“ — wie der Vertrag Standorte aufzählt. */
    static String aufzaehlung(List<String> worte) {
        if (worte.isEmpty()) {
            return "";
        }
        if (worte.size() == 1) {
            return worte.get(0);
        }
        return String.join(", ", worte.subList(0, worte.size() - 1)) + " und " + worte.get(worte.size() - 1);
    }

    private Welt welt(Instant jetzt) {
        ZugriffRepository.KundenbereichKopf kopf = zugriffe.kundenbereichKopf();
        List<StandortEintrag> liste = zugriffe.standorte();
        Map<UUID, StandortEintrag> ids = new LinkedHashMap<>();
        liste.forEach(s -> ids.put(s.id(), s));
        List<Person> kundenadministratoren = zugriffe.wirksamImKundenbereich(Rolle.KUNDENADMINISTRATOR, jetzt)
                .stream().map(a -> new Person(a.zeile().benutzerSub(), a.name())).distinct().toList();
        Kundenbereich k = new Kundenbereich(kopf.name(),
                liste.stream().map(s -> new RechteAbleitung.Standort(s.kurzzeichen(), s.name())).toList(),
                kundenadministratoren);
        return new Welt(k, kopf.zeitzone(), ids);
    }

    /**
     * Die Standorte des Antrags, in der Folge des Kundenbereichs. Leer ist {@code standort_fehlt} (E5: eine
     * Unterstützung gilt nie für das ganze Unternehmen), ein fremder oder archivierter ist
     * {@code standort_unbekannt} — beides, bevor irgendetwas geschrieben wird.
     */
    private List<UUID> standorte(List<UUID> gewuenscht, Welt welt) {
        if (gewuenscht == null || gewuenscht.isEmpty()) {
            throw UnterstuetzungAbgelehnt.von(Ablehnung.STANDORT_FEHLT);
        }
        for (UUID id : gewuenscht) {
            if (!welt.standorte().containsKey(id)) {
                throw new UnterstuetzungAbgelehnt(Ablehnung.STANDORT_UNBEKANNT, Map.of("standort_id", id.toString()));
            }
        }
        return welt.standorte().keySet().stream().filter(gewuenscht::contains).toList();
    }

    /** Das Ende eines Enddatums als Zeitpunkt in der Zeitzone des Kundenbereichs ({@code zugriff_ende_chk}). */
    private static Instant endeAm(LocalDate gueltigBis, ZoneId zone) {
        return gueltigBis.plusDays(1).atStartOfDay(zone).toInstant();
    }

    private UUID eintragen(List<UUID> standorte, Empfaenger e, Art art, Umfang umfang, Instant ab, LocalDate bis,
            Instant endetAm, ZoneId zone, ProtokollAkteur akteur, String grund) {
        UUID griff = null;
        for (UUID standort : standorte) {
            UUID id = zugriffe.zuweisen(new NeueZuweisung(e.sub(), Rolle.UNTERSTUETZER, standort, art, umfang, ab,
                    bis, endetAm, zone, akteur.sub()), e.name(), akteur, grund);
            if (griff == null || id.compareTo(griff) < 0) {
                griff = id;
            }
        }
        return griff;
    }

    private List<Zeile> wirksameGewaehrung(UUID griff, Instant jetzt) {
        List<Zeile> zeilen = zugriffe.gewaehrung(griff);
        if (zeilen.isEmpty()) {
            throw UnterstuetzungAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN);
        }
        Zeile erste = zeilen.get(0);
        if (erste.beendetAm() != null || (erste.endetAm() != null && !jetzt.isBefore(erste.endetAm()))) {
            throw UnterstuetzungAbgelehnt.von(Ablehnung.BEREITS_BEENDET);
        }
        return zeilen;
    }

    private Anfrage offeneAnfrage(UUID id) {
        Anfrage a = unterstuetzungen.anfrage(id)
                .orElseThrow(() -> UnterstuetzungAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
        if (!a.offen()) {
            throw UnterstuetzungAbgelehnt.von(Ablehnung.ANFRAGE_ENTSCHIEDEN);
        }
        return a;
    }

    /** Die Zeilen einer Gewährung zusammenfassen — dieselbe Gruppierung wie {@code Selbstauskunft}. */
    private static List<List<Zeile>> gruppiert(List<Zeile> zeilen) {
        Map<List<Object>, List<Zeile>> gruppen = new LinkedHashMap<>();
        for (Zeile z : zeilen) {
            gruppen.computeIfAbsent(Arrays.asList(z.benutzerSub(), z.art(), z.umfang(), z.gueltigAb(),
                    z.gueltigBis(), z.endetAm(), z.beendetAm()), g -> new ArrayList<>()).add(z);
        }
        // Der GRIFF einer Gewährung ist die kleinste id ihrer Zeilen - also steht sie in jeder Gruppe vorn,
        // gleich in welcher Folge die Abfrage sie gelesen hat.
        return gruppen.values().stream()
                .map(g -> g.stream().sorted(java.util.Comparator.comparing(Zeile::id)).toList()).toList();
    }

    private UnterstuetzungErgebnis ergebnis(Welt welt, String name, Art art, Umfang umfang, List<UUID> standorte,
            Instant ab, LocalDate bis, Instant beendetAm, String beendetVon, String grund, Instant jetzt) {
        return RechteAbleitung.unterstuetzung(new RechteAbleitung.Unterstuetzung(art, umfang,
                welt.kennzeichen(standorte), ab, ab, bis == null ? notfallEnde(ab, art) : bis.toString(), beendetAm,
                beendetVon == null ? null : zugriffe.anzeigename(beendetVon),
                new RechteAbleitung.Unterstuetzer(name, null, name), grund), welt.k(), jetzt, welt.zone());
    }

    /** Der Notfall-Zugriff trägt keinen Tag, sondern seinen Zeitpunkt (24 h ab Beginn). */
    private static String notfallEnde(Instant ab, Art art) {
        return art == Art.NOTFALL ? ab.plus(RechteAbleitung.NOTFALL).toString() : null;
    }

    private String banner(Welt welt, String name, Art art, Umfang umfang, List<UUID> standorte, Instant ab,
            LocalDate bis, String grund, Instant jetzt) {
        UnterstuetzungErgebnis e = ergebnis(welt, name, art, umfang, standorte, ab, bis, null, null, grund, jetzt);
        // Eine Gewährung, die erst künftig wirkt, hat noch keinen Banner - dann sagt der Hinweis „wirkt ab …".
        return e.bannerKunde() != null ? e.bannerKunde() : e.text();
    }

    /** Ein Hinweis an JEDEN wirksamen Kundenadministrator; {@code true}, sobald mindestens einer neu war. */
    private boolean hinweisen(Anlass anlass, Welt welt, UUID griff, UUID anfrageId, String text) {
        boolean neu = false;
        for (Person p : welt.k().kundenadministratoren()) {
            neu |= unterstuetzungen.hinweisen(anlass, p.kennung(), null, griff, anfrageId, text);
        }
        return neu;
    }

    /**
     * Das Partner-Konto zur E-Mail-Adresse (E7): bekannt → dasselbe Konto, unbekannt → ein neues mit
     * Startpasswort und Pflichtwechsel bei der ersten Anmeldung (E14 = B).
     *
     * <p><b>Der Spiegel trägt {@code aktiv}, nicht {@code angelegt}</b>, obwohl das Konto noch nie angemeldet
     * war: {@code RechteAbleitung.darf} antwortet für jeden anderen Zustand 401 {@code konto_nicht_aktiv}, und
     * den Übergang {@code angelegt → aktiv} bei der ersten Anmeldung baut erst IP-14. Bis dahin wäre ein frisch
     * angelegtes Partner-Konto sonst von seiner eigenen Unterstützung ausgesperrt.
     */
    private Empfaenger partnerKonto(String email) {
        if (email == null || email.isBlank()) {
            throw UnterstuetzungAbgelehnt.anfrage("email");
        }
        String adresse = email.trim();
        Optional<KeycloakUser> bekannt;
        try {
            bekannt = keycloak.findByEmail(adresse);
        } catch (KeycloakAdminException e) {
            throw UnterstuetzungAbgelehnt.von(Ablehnung.KONTO_NICHT_ERREICHBAR);
        } catch (RuntimeException e) {
            log.warn("UEMS-Unterstützung: Keycloak nicht erreichbar: {}", e.toString());
            throw UnterstuetzungAbgelehnt.von(Ablehnung.KONTO_NICHT_ERREICHBAR);
        }
        if (bekannt.isPresent()) {
            KeycloakUser u = bekannt.get();
            return new Empfaenger(u.id(), anzeige(u, adresse), u.email(), null);
        }
        String startpasswort = startpasswort();
        KeycloakUser neu;
        try {
            neu = keycloak.createPartnerUser(adresse, adresse, null, null, startpasswort, true);
        } catch (KeycloakAdminException e) {
            throw UnterstuetzungAbgelehnt.von(Ablehnung.KONTO_NICHT_ERREICHBAR);
        }
        return new Empfaenger(neu.id(), anzeige(neu, adresse), adresse, startpasswort);
    }

    /** Das VoltPilot-Konto, das angefragt hat — nie ein anderes: VoltPilot gewährt sich nichts selbst (E8). */
    private Empfaenger voltpilotKonto(Anfrage a) {
        return new Empfaenger(a.angefragtVon(), a.angefragtName(), a.angefragtEmail(), null);
    }

    private static String anzeige(KeycloakUser u, String fallback) {
        String voll = ((u.firstName() == null ? "" : u.firstName()) + " "
                + (u.lastName() == null ? "" : u.lastName())).trim();
        if (!voll.isEmpty()) {
            return voll;
        }
        return u.username() != null && !u.username().isBlank() ? u.username() : fallback;
    }

    private String startpasswort() {
        StringBuilder sb = new StringBuilder(PASSWORT_LAENGE);
        for (int i = 0; i < PASSWORT_LAENGE; i++) {
            sb.append(PASSWORT_ZEICHEN.charAt(zufall.nextInt(PASSWORT_ZEICHEN.length())));
        }
        return sb.toString();
    }

    /** Ein Wort des Vertrags aus einem Anfragekörper; unbekannt ist {@code anfrage_ungueltig}. */
    public static <T extends Enum<T>> T wort(Class<T> typ, String feld, String code) {
        if (code == null || code.isBlank()) {
            return null;
        }
        for (T t : typ.getEnumConstants()) {
            if (((RechteAbleitung.Code) t).code().equals(code.trim().toLowerCase(Locale.ROOT))) {
                return t;
            }
        }
        throw UnterstuetzungAbgelehnt.anfrage(feld);
    }
}
