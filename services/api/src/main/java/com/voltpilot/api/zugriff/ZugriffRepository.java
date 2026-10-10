package com.voltpilot.api.zugriff;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.RechteAbleitung;
import com.voltpilot.api.uems.RechteAbleitung.Art;
import com.voltpilot.api.uems.RechteAbleitung.Konto;
import com.voltpilot.api.uems.RechteAbleitung.KontoZustand;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.RechteAbleitung.Umfang;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Tabellen des Rechte-Fundaments ({@code V20260915030000}, UEMS AP-03 IP-2): der Benutzer-Spiegel,
 * die Zuweisung und das Zugriffsprotokoll — über die RLS-Verbindung, IMMER im Kundenbereich des
 * {@link TenantContext} (nie aus einem Anfragekörper).
 *
 * <p><b>Noch setzt niemand durch.</b> Die Lesewege sind das, was IP-4 ({@code ZugriffContext}, {@code /me})
 * je Anfrage lädt; heute ruft sie nur die Bestandsübernahme ({@link ZugriffBestand}) und der Test.
 *
 * <p>Die Zeit sagt der Vertrag ({@link RechteAbleitung.Zuweisung}): {@code gueltig_ab} ist ein Zeitpunkt,
 * {@code gueltig_bis} das Enddatum (einschließlich), {@code endet_am} dasselbe Ende als Zeitpunkt
 * ({@link RechteAbleitung#bisZeitpunkt}) — nur der Notfall-Zugriff trägt allein ihn. Wirksam heißt
 * {@code zugriff_zeitraum(…) @> t}, dieselbe Funktion, über die die Exklusion das Überlappungsverbot hält.
 * Ein Zugriff wird nie umgeschrieben: {@link #beenden} ist die EINE Änderung, und sie gelingt einmal.
 */
@Repository
public class ZugriffRepository {

    private final JdbcTemplate jdbc;

    public ZugriffRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Ein Konto, wie es im Kundenbereich gespiegelt wird. */
    public record BenutzerSpiegel(String sub, Konto konto, String anzeigename, String email, KontoZustand zustand) {}

    /** Eine Zuweisung, wie ein Schreibweg sie einträgt. {@code standortId == null} heißt mandantenweit. */
    public record NeueZuweisung(String benutzerSub, Rolle rolle, UUID standortId, Art art, Umfang umfang,
            Instant gueltigAb, LocalDate gueltigBis, Instant endetAm, ZoneId zeitzone, String gewaehrtVon) {

        /** Eine mandantenweite, unbefristete Zuweisung (Kundenadministrator, Energiemanager). */
        public static NeueZuweisung unternehmensweit(String benutzerSub, Rolle rolle, Instant gueltigAb,
                ZoneId zeitzone, String gewaehrtVon) {
            return new NeueZuweisung(benutzerSub, rolle, null, null, null, gueltigAb, null, null, zeitzone,
                    gewaehrtVon);
        }
    }

    /**
     * Eine gespeicherte Zuweisung; {@code standortKurzzeichen} ist das Kennzeichen des Vertrags (ST-1 …),
     * {@code standortName} der Kundenname desselben Standorts.
     *
     * <p>⚠ Beide kommen aus einem Unterabfrage-Join auf {@code standort} und tragen damit den Standort-Zaun
     * (IP-5): wer den Standort NICHT (mehr) sieht, liest hier {@code null}. Der {@link ZugriffKontextLader}
     * liest sie darum, BEVOR der Zaun der Anfrage steht — nur so trägt eine beendete Zuweisung den Namen, den
     * der Satz „Ihr Zugriff auf … wurde beendet." braucht (IP-9).
     */
    public record Zeile(UUID id, String benutzerSub, Rolle rolle, UUID standortId, String standortKurzzeichen,
            String standortName, Art art, Umfang umfang, Instant gueltigAb, LocalDate gueltigBis, Instant endetAm,
            ZoneId zeitzone, String gewaehrtVon, Instant beendetAm, String beendetVon, String beendetGrund) {

        /** Dieselbe Zuweisung als Eingang des Vertrags — eine Zeile, ein Standort (oder das Unternehmen). */
        public RechteAbleitung.Zuweisung alsZuweisung() {
            String bis = gueltigBis != null
                    ? gueltigBis.toString()
                    : endetAm != null ? OffsetDateTime.ofInstant(endetAm, zeitzone).toString() : null;
            return new RechteAbleitung.Zuweisung(rolle, standortId == null ? null : List.of(standortKurzzeichen),
                    umfang, art, gueltigAb, bis, beendetAm);
        }
    }

    // ------------------------------------------------------------------ Benutzer

    /** Legt den Spiegel an, wenn es ihn im Kundenbereich noch nicht gibt; {@code true} = neu. Ändert nie. */
    public boolean benutzerSpiegeln(BenutzerSpiegel b) {
        return jdbc.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, email, zustand) "
                + "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (tenant_id, sub) DO NOTHING",
                kundenbereich(), b.sub(), b.konto().code(), b.anzeigename(), b.email(), b.zustand().code()) == 1;
    }

    /** Der Spiegel des Kontos in diesem Kundenbereich, sonst leer. */
    public Optional<BenutzerSpiegel> spiegel(String sub) {
        return jdbc.query("SELECT sub, konto, anzeigename, email, zustand FROM benutzer WHERE tenant_id = ? AND sub = ?",
                (rs, n) -> new BenutzerSpiegel(rs.getString("sub"), Konto.vonCode(rs.getString("konto")),
                        rs.getString("anzeigename"), rs.getString("email"),
                        KontoZustand.vonCode(rs.getString("zustand"))),
                kundenbereich(), sub).stream().findFirst();
    }

    /** Token nur nach abgeschlossener Keycloak-Anmeldung; das bedingte UPDATE macht den Übergang einmalig. */
    public void ersteAnmeldung(String sub, Instant jetzt, ProtokollAkteur akteur) {
        List<String> namen = jdbc.queryForList("UPDATE benutzer SET zustand = 'aktiv', angenommen_am = ?, "
                + "zuletzt_angemeldet = ? WHERE tenant_id = ? AND sub = ? AND zustand = 'angelegt' "
                + "RETURNING anzeigename", String.class, utc(jetzt), utc(jetzt), kundenbereich(), sub);
        for (String name : namen) {
            kontoProtokoll("erste_anmeldung", sub, name, akteur);
        }
    }

    public void kontoProtokoll(String aktion, String sub, String name, ProtokollAkteur akteur) {
        protokoll(kundenbereich(), aktion, sub, name, null, null, null, null, null, null, null, null, null, akteur);
    }

    /** Kontozustand im selben Vorgang wie Entzugsprüfung und Protokoll ändern. */
    public void kontoZustandSetzen(String sub, KontoZustand zustand) {
        jdbc.update("UPDATE benutzer SET zustand = ? WHERE tenant_id = ? AND sub = ?",
                zustand.code(), kundenbereich(), sub);
    }

    /** Eine unveränderte Zuweisung pausiert oder wirkt wieder; ihre Identität und Zeit bleiben erhalten. */
    public void kontoZuweisungProtokoll(String aktion, Zeile z, ProtokollAkteur akteur, String grund) {
        protokoll(kundenbereich(), aktion, z.benutzerSub(), anzeigename(z.benutzerSub()), z.id(), z.rolle(),
                z.standortId(), z.art(), z.umfang(), z.gueltigAb(), z.gueltigBis(), z.endetAm(), grund, akteur);
    }

    // ------------------------------------------------------------------ Kundenbereich (Selbstauskunft, IP-4)

    /** Name und Zeitzone des Kundenbereichs: das Unternehmen, sonst der Mandant und Europe/Berlin. */
    public record KundenbereichKopf(String name, ZoneId zeitzone) {}

    /** Ein Standort des Kundenbereichs; {@code kurzzeichen} ist das Kennzeichen des Vertrags (ST-1 …). */
    public record StandortEintrag(UUID id, String kurzzeichen, String name) {}

    /** Eine Zuweisung mit dem Anzeigenamen ihres Kontos (ohne Spiegel: das Subject). */
    public record MitName(Zeile zeile, String name) {}

    /** Ein entferntes Unternehmen darf nicht über die E12-Rückfallregel als aktives Konto erscheinen. */
    public boolean kundenbereichVorhanden() {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM tenant WHERE id = ?)",
                Boolean.class, kundenbereich()));
    }

    public KundenbereichKopf kundenbereichKopf() {
        UUID tenant = kundenbereich();
        return jdbc.query("SELECT coalesce(u.name, t.name) AS name, coalesce(u.zeitzone, 'Europe/Berlin') AS zeitzone "
                + "FROM tenant t LEFT JOIN unternehmen u ON u.tenant_id = t.id WHERE t.id = ?",
                (rs, n) -> new KundenbereichKopf(rs.getString("name"), ZoneId.of(rs.getString("zeitzone"))), tenant)
                .stream().findFirst().orElse(new KundenbereichKopf("", ZoneId.of("Europe/Berlin")));
    }

    /** Die Standorte des Kundenbereichs ohne archivierte, in der Folge der Standort-Liste. */
    public List<StandortEintrag> standorte() {
        return jdbc.query("SELECT id, kurzzeichen, name FROM standort WHERE tenant_id = ? AND zustand <> 'archiviert' "
                + "ORDER BY created_at, id",
                (rs, n) -> new StandortEintrag(rs.getObject("id", UUID.class), rs.getString("kurzzeichen"),
                        rs.getString("name")), kundenbereich());
    }

    /**
     * Die zu {@code jetzt} wirksamen Zuweisungen EINER Rolle im ganzen Kundenbereich, die älteste zuerst — die Folge,
     * in der der Vertrag die Kundenadministratoren im Weg nennt („Jonas Wendlinger und Ines Kaltenbach“).
     */
    public List<MitName> wirksamImKundenbereich(Rolle rolle, Instant jetzt) {
        return jdbc.query(SELECT_MIT_NAME + " WHERE z.tenant_id = ? AND z.rolle = ? "
                + "AND public.zugriff_zeitraum(z.gueltig_ab, z.endet_am, z.beendet_am) @> ? "
                + "ORDER BY z.gueltig_ab, z.created_at, z.id",
                (rs, n) -> new MitName(zeile(rs, n), rs.getString("name")), kundenbereich(), rolle.code(), utc(jetzt));
    }

    /**
     * Der Grund, mit dem eine Zuweisung eingetragen wurde (der Notfall-Zugriff trägt ihn), sonst {@code null}.
     *
     * <p>⚠ Es GIBT die Protokollzeile fast immer, nur ihr {@code grund} ist meist leer — {@code findFirst} auf
     * einer Liste mit {@code null} darin wirft ({@code Optional.of}). Bis IP-8 fiel das nicht auf, weil die
     * Selbstauskunft nur für den Notfall-Zugriff fragte und der seinen Grund immer trägt.
     */
    public String grundDerZuweisung(UUID zugriffId) {
        List<String> gruende = jdbc.query("SELECT grund FROM zugriff_protokoll WHERE tenant_id = ? "
                + "AND zugriff_id = ? AND aktion = 'zuweisen' ORDER BY id LIMIT 1",
                (rs, n) -> rs.getString("grund"), kundenbereich(), zugriffId);
        return gruende.isEmpty() ? null : gruende.get(0);
    }

    // ------------------------------------------------------------------ Zuweisungen

    /** Hatte das Konto in diesem Kundenbereich je eine Zuweisung — auch eine beendete oder künftige? */
    public boolean hatJeEineZuweisung(String sub) {
        return Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT EXISTS (SELECT 1 FROM zugriff WHERE tenant_id = ? AND benutzer_sub = ?)", Boolean.class,
                kundenbereich(), sub));
    }

    // ------------------------------------------------------------------ Stichtag der Bestandsregel (E12)

    /** Der Stichtag eines Kundenbereichs ({@code V20260916060000}); {@code herkunft} ist Betriebsauskunft. */
    public record Stichtag(Instant stichtag, String herkunft, int konten) {}

    /** Der Stichtag, ab dem die Bestandsregel E12 in diesem Kundenbereich nicht mehr gilt — sonst leer. */
    public Optional<Stichtag> stichtag() {
        return jdbc.query("SELECT stichtag, herkunft, konten FROM zugriff_bestand WHERE tenant_id = ?",
                (rs, n) -> new Stichtag(instant(rs, "stichtag"), rs.getString("herkunft"), rs.getInt("konten")),
                kundenbereich()).stream().findFirst();
    }

    /**
     * Setzt den Stichtag EINMAL; {@code true} = geschrieben, {@code false} = es gab ihn schon (ein zweiter Lauf,
     * ein Neustart). Er wird nie verschoben — die Tabelle gibt kein {@code UPDATE}-Recht.
     */
    public boolean stichtagSetzen(Instant stichtag, String herkunft, int konten) {
        return jdbc.update("INSERT INTO zugriff_bestand (tenant_id, stichtag, herkunft, konten) VALUES (?, ?, ?, ?) "
                + "ON CONFLICT (tenant_id) DO NOTHING", kundenbereich(), utc(stichtag), herkunft, konten) == 1;
    }

    /**
     * Gilt die Bestandsregel E12 für dieses Kundenkonto — ist es also ein BESTANDSKONTO? Genau dann, wenn der
     * Kundenbereich noch keinen Stichtag hat UND das Konto hier nie eine Zuweisung hatte.
     *
     * <p>Beide Hälften in EINER Anweisung: der Lesepfad je Anfrage fragt nur, wenn keine Zuweisung wirksam ist.
     * Ohne Stichtag bleibt es bei der Regel von IP-2/IP-4 — eine Störung des Start-Laufs sperrt keinen Kunden aus.
     * Mit Stichtag trägt jedes Bestandskonto eine Zeile in {@code zugriff}, „nie zugewiesen" heißt dann: nach dem
     * Stichtag entstanden.
     */
    public boolean bestandskonto(String sub) {
        return Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT NOT EXISTS (SELECT 1 FROM zugriff_bestand WHERE tenant_id = ?) "
                        + "AND NOT EXISTS (SELECT 1 FROM zugriff WHERE tenant_id = ? AND benutzer_sub = ?)",
                Boolean.class, kundenbereich(), kundenbereich(), sub));
    }

    /** EINE Zuweisung des Kundenbereichs — leer, wenn es sie hier nicht gibt (die Route antwortet 404). */
    public Optional<Zeile> zeile(UUID zugriffId) {
        return jdbc.query(SELECT + " WHERE z.tenant_id = ? AND z.id = ?", ZugriffRepository::zeile,
                kundenbereich(), zugriffId).stream().findFirst();
    }

    /** Jede Zuweisung des Kontos (wirksame, künftige, beendete), älteste zuerst. */
    public List<Zeile> zuweisungen(String sub) {
        return jdbc.query(SELECT + " WHERE z.tenant_id = ? AND z.benutzer_sub = ? ORDER BY z.gueltig_ab, z.created_at, z.id",
                ZugriffRepository::zeile, kundenbereich(), sub);
    }

    /**
     * Was eine Anfrage über den Aufrufer wissen muss (IP-9): seine WIRKSAMEN Zuweisungen und die, die VORBEI
     * sind — beendet oder abgelaufen. In EINER Abfrage, weil jede Anfrage sie braucht; künftige Zuweisungen
     * (Sabine ab 01.03.2027) fallen aus beiden Listen, denn nichts an ihnen ist beendet.
     *
     * <p>„Vorbei" ist die obere Grenze desselben {@code zugriff_zeitraum}, mit dem „wirksam" gefragt wird — nie
     * eine zweite Rechnung in Java. Ein Zeitraum ohne Ende ({@code upper} = unendlich) ist nie vorbei.
     */
    public record Stand(List<Zeile> wirksam, List<Zeile> vorbei) {}

    /** Wirksame und vorbeie Zuweisungen des Kontos zu {@code jetzt} — die Abfrage je Anfrage (IP-4/IP-9). */
    public Stand stand(String sub, Instant jetzt) {
        String zeitraum = "public.zugriff_zeitraum(z.gueltig_ab, z.endet_am, z.beendet_am)";
        List<Object[]> zeilen = jdbc.query(SELECT.replace(" FROM zugriff z",
                        ", " + zeitraum + " @> ?::timestamptz AS ist_wirksam FROM zugriff z")
                        + " WHERE z.tenant_id = ? AND z.benutzer_sub = ? AND (" + zeitraum + " @> ?::timestamptz "
                        + "OR upper(" + zeitraum + ") <= ?::timestamptz) "
                        + "ORDER BY z.gueltig_ab, z.created_at, z.id",
                (rs, n) -> new Object[] {zeile(rs, n), rs.getBoolean("ist_wirksam")},
                utc(jetzt), kundenbereich(), sub, utc(jetzt), utc(jetzt));
        List<Zeile> wirksam = new ArrayList<>();
        List<Zeile> vorbei = new ArrayList<>();
        for (Object[] z : zeilen) {
            (((Boolean) z[1]) ? wirksam : vorbei).add((Zeile) z[0]);
        }
        return new Stand(List.copyOf(wirksam), List.copyOf(vorbei));
    }

    /** Die zu {@code jetzt} wirksamen Zuweisungen des Kontos. */
    public List<Zeile> wirksam(String sub, Instant jetzt) {
        return jdbc.query(SELECT + " WHERE z.tenant_id = ? AND z.benutzer_sub = ? "
                + "AND public.zugriff_zeitraum(z.gueltig_ab, z.endet_am, z.beendet_am) @> ? "
                + "ORDER BY z.gueltig_ab, z.created_at, z.id",
                ZugriffRepository::zeile, kundenbereich(), sub, utc(jetzt));
    }

    /**
     * Trägt eine Zuweisung ein und protokolliert {@code zuweisen} — in der Transaktion des Aufrufers. Die
     * Datenbank lehnt ab, was der Vertrag nicht kennt (Rolle, Geltungsbereich, Ende, Überlappung).
     */
    public UUID zuweisen(NeueZuweisung z, String betroffenerName, ProtokollAkteur akteur, String grund) {
        UUID tenant = kundenbereich();
        UUID id = jdbc.queryForObject("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, art, umfang, "
                + "gueltig_ab, gueltig_bis, endet_am, zeitzone, gewaehrt_von) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                + "RETURNING id", UUID.class, tenant, z.benutzerSub(), z.rolle().code(), z.standortId(), code(z.art()),
                code(z.umfang()), utc(z.gueltigAb()), z.gueltigBis(), utc(z.endetAm()), z.zeitzone().getId(),
                z.gewaehrtVon());
        protokoll(tenant, "zuweisen", z.benutzerSub(), betroffenerName, id, z.rolle(), z.standortId(), z.art(),
                z.umfang(), z.gueltigAb(), z.gueltigBis(), z.endetAm(), grund, akteur);
        return id;
    }

    /**
     * Beendet eine wirksame oder künftige Zuweisung EINMAL und protokolliert {@code entziehen}. {@code false},
     * wenn es sie im Kundenbereich nicht gibt oder sie schon beendet ist. Die handelnde Person trägt ein Subject.
     */
    public boolean beenden(UUID zugriffId, Instant am, ProtokollAkteur von, String grund) {
        return beenden(zugriffId, am, von, grund, "entziehen");
    }

    /**
     * Dasselbe Ende mit einem anderen Protokollwort — {@code verlaengern}, wenn dieselbe Gewährung im selben
     * Zug mit einem späteren Ende neu beginnt (AP-03 IP-8, §4.6). Es steht dann EIN Wort im Protokoll, und
     * niemand liest später einen Entzug, wo verlängert wurde.
     */
    public boolean beenden(UUID zugriffId, Instant am, ProtokollAkteur von, String grund, String aktion) {
        if (von.sub() == null) {
            throw new IllegalArgumentException("Ein Zugriff wird von einer Person beendet");
        }
        UUID tenant = kundenbereich();
        List<Zeile> beendet = jdbc.query("WITH b AS (UPDATE zugriff SET beendet_am = ?, beendet_von = ?, beendet_grund = ? "
                + "WHERE id = ? AND tenant_id = ? AND beendet_am IS NULL RETURNING *) "
                + SELECT.replace("FROM zugriff z", "FROM b z"),
                ZugriffRepository::zeile, utc(am), von.sub(), grund, zugriffId, tenant);
        if (beendet.isEmpty()) {
            return false;
        }
        Zeile z = beendet.get(0);
        String name = anzeigename(z.benutzerSub());
        protokoll(tenant, aktion, z.benutzerSub(), name, z.id(), z.rolle(), z.standortId(), z.art(), z.umfang(),
                z.gueltigAb(), z.gueltigBis(), z.endetAm(), grund, von);
        return true;
    }

    // ------------------------------------------------------------------ Unterstützung (IP-8)

    /**
     * Die Zeilen EINER Gewährung (UEMS AP-03 IP-8). Eine Unterstützung wird je Standort als eigene Zeile
     * eingetragen; zusammen gehören die Zeilen, die Person, Art, Umfang und Zeit teilen — dieselbe Gruppierung,
     * mit der {@link Selbstauskunft} seit IP-4 ihre Banner baut. Ihr GRIFF ist die kleinste {@code id} der Gruppe;
     * weil eine Zeile nie umgeschrieben wird, ist er stabil, auch nachdem die Gewährung beendet wurde.
     *
     * <p>Leer, wenn es {@code griff} im Kundenbereich nicht gibt oder er keine Unterstützung ist — die Route
     * antwortet dann 404, genau wie für eine Kennung, die es nicht gibt.
     */
    public List<Zeile> gewaehrung(UUID griff) {
        return jdbc.query(SELECT + " JOIN zugriff g ON g.tenant_id = z.tenant_id AND g.id = ? "
                + "WHERE z.tenant_id = ? AND z.rolle = 'unterstuetzer' AND g.rolle = 'unterstuetzer' "
                + "AND z.benutzer_sub = g.benutzer_sub AND z.art = g.art AND z.umfang = g.umfang "
                + "AND z.gueltig_ab = g.gueltig_ab AND z.endet_am = g.endet_am "
                + "AND z.gueltig_bis IS NOT DISTINCT FROM g.gueltig_bis "
                + "AND z.beendet_am IS NOT DISTINCT FROM g.beendet_am ORDER BY z.id",
                ZugriffRepository::zeile, griff, kundenbereich());
    }

    /** Jede Gewährung des Kundenbereichs, jüngste zuerst — je Zeile eine (der Aufrufer fasst sie zusammen). */
    public List<MitName> alleUnterstuetzungen() {
        return jdbc.query(SELECT_MIT_NAME + " WHERE z.tenant_id = ? AND z.rolle = 'unterstuetzer' "
                + "ORDER BY z.gueltig_ab DESC, z.created_at DESC, z.id",
                (rs, n) -> new MitName(zeile(rs, n), rs.getString("name")), kundenbereich());
    }

    /**
     * Die Gewährungen, deren Ende {@code endet_am} erreicht ist und für die noch kein {@code ablaufen} im
     * Protokoll steht — was der Ablauf-Läufer nachzutragen hat. <b>Sie sind zu diesem Zeitpunkt längst
     * unwirksam:</b> {@code zugriff_zeitraum} schließt sie mit ihrem {@code endet_am}, ohne dass jemand läuft.
     * Vorzeitig Beendete lässt die Abfrage aus — deren Ende steht schon als {@code entziehen} im Protokoll.
     */
    public List<Zeile> abgelaufeneUnterstuetzungen(Instant jetzt) {
        return jdbc.query(SELECT + " WHERE z.tenant_id = ? AND z.rolle = 'unterstuetzer' AND z.beendet_am IS NULL "
                + "AND z.endet_am IS NOT NULL AND z.endet_am <= ? "
                + "AND NOT EXISTS (SELECT 1 FROM zugriff_protokoll p WHERE p.tenant_id = z.tenant_id "
                + "AND p.zugriff_id = z.id AND p.aktion = 'ablaufen') ORDER BY z.endet_am, z.id",
                ZugriffRepository::zeile, kundenbereich(), utc(jetzt));
    }

    /**
     * Die wirksamen Gewährungen, deren Ende innerhalb von {@code frist} liegt — die Erinnerung 7 Tage vorher
     * (E6). Der Notfall-Zugriff bleibt außen vor: 24 h sind kürzer als die Frist, eine Erinnerung wäre nur
     * Lärm (dieselbe Regel wie {@code RechteAbleitung.unterstuetzung}).
     */
    public List<Zeile> baldEndendeUnterstuetzungen(Instant jetzt, Instant grenze) {
        return jdbc.query(SELECT + " WHERE z.tenant_id = ? AND z.rolle = 'unterstuetzer' AND z.beendet_am IS NULL "
                + "AND z.art <> 'notfall' AND z.gueltig_ab <= ? AND z.endet_am > ? AND z.endet_am <= ? "
                + "ORDER BY z.endet_am, z.id",
                ZugriffRepository::zeile, kundenbereich(), utc(jetzt), utc(jetzt), utc(grenze));
    }

    /**
     * Schreibt EINEN Protokolleintrag zu einer bestehenden Zeile — für die Wörter, die keine Spalte ändern:
     * {@code verlaengern} (das neue Enddatum steht an der neuen Zeile) und {@code ablaufen} (das Ende kam von
     * der Uhr, nicht von einer Person). {@code zuweisen} und {@code entziehen} schreiben ihre Einträge selbst.
     */
    public void protokollieren(String aktion, Zeile z, ProtokollAkteur akteur, String grund) {
        protokoll(kundenbereich(), aktion, z.benutzerSub(), anzeigename(z.benutzerSub()), z.id(), z.rolle(),
                z.standortId(), z.art(), z.umfang(), z.gueltigAb(), z.gueltigBis(), z.endetAm(), grund, akteur);
    }

    /** Der Anzeigename des Kontos im Spiegel; ohne Spiegel das Subject (ein Eintrag trägt immer einen Namen). */
    public String anzeigename(String sub) {
        return jdbc.queryForObject("SELECT coalesce((SELECT anzeigename FROM benutzer WHERE tenant_id = ? "
                + "AND sub = ?), ?)", String.class, kundenbereich(), sub, sub);
    }

    // ------------------------------------------------------------------ intern

    private static final String SELECT = "SELECT z.id, z.benutzer_sub, z.rolle, z.standort_id, "
            + "(SELECT s.kurzzeichen FROM standort s WHERE s.id = z.standort_id AND s.tenant_id = z.tenant_id) "
            + "AS standort_kurzzeichen, "
            + "(SELECT s.name FROM standort s WHERE s.id = z.standort_id AND s.tenant_id = z.tenant_id) "
            + "AS standort_name, z.art, z.umfang, z.gueltig_ab, z.gueltig_bis, z.endet_am, z.zeitzone, "
            + "z.gewaehrt_von, z.beendet_am, z.beendet_von, z.beendet_grund FROM zugriff z";

    private static final String SELECT_MIT_NAME = SELECT.replace(" FROM zugriff z", ", coalesce((SELECT b.anzeigename "
            + "FROM benutzer b WHERE b.tenant_id = z.tenant_id AND b.sub = z.benutzer_sub), z.benutzer_sub) AS name "
            + "FROM zugriff z");

    private void protokoll(UUID tenant, String aktion, String betroffenerSub, String betroffenerName, UUID zugriffId,
            Rolle rolle, UUID standortId, Art art, Umfang umfang, Instant gueltigAb, LocalDate gueltigBis,
            Instant endetAm, String grund, ProtokollAkteur akteur) {
        jdbc.update("INSERT INTO zugriff_protokoll (tenant_id, aktion, betroffener_sub, betroffener_name, zugriff_id, "
                + "rolle, standort_id, art, umfang, gueltig_ab, gueltig_bis, endet_am, grund, actor_sub, actor_name, "
                + "actor_rolle, actor_art) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                tenant, aktion, betroffenerSub, betroffenerName, zugriffId, code(rolle), standortId, code(art),
                code(umfang), utc(gueltigAb), gueltigBis, utc(endetAm), grund, akteur.sub(), akteur.name(),
                akteur.rolle(), akteur.art());
    }

    private static Zeile zeile(ResultSet rs, int n) throws SQLException {
        String art = rs.getString("art");
        String umfang = rs.getString("umfang");
        return new Zeile(rs.getObject("id", UUID.class), rs.getString("benutzer_sub"),
                Rolle.vonCode(rs.getString("rolle")), rs.getObject("standort_id", UUID.class),
                rs.getString("standort_kurzzeichen"), rs.getString("standort_name"),
                art == null ? null : Art.vonCode(art),
                umfang == null ? null : Umfang.vonCode(umfang), instant(rs, "gueltig_ab"),
                rs.getObject("gueltig_bis", LocalDate.class), instant(rs, "endet_am"),
                ZoneId.of(rs.getString("zeitzone")), rs.getString("gewaehrt_von"), instant(rs, "beendet_am"),
                rs.getString("beendet_von"), rs.getString("beendet_grund"));
    }

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        OffsetDateTime t = rs.getObject(spalte, OffsetDateTime.class);
        return t == null ? null : t.toInstant();
    }

    private static OffsetDateTime utc(Instant t) {
        return t == null ? null : t.atOffset(ZoneOffset.UTC);
    }

    private static String code(RechteAbleitung.Code c) {
        return c == null ? null : c.code();
    }

    private static UUID kundenbereich() {
        UUID tenant = TenantContext.get();
        if (tenant == null) {
            throw new IllegalStateException("Zugriffe gibt es nur im Kundenbereich (TenantContext fehlt)");
        }
        return tenant;
    }
}
