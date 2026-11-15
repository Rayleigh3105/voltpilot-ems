package com.voltpilot.api.tenant;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Eine Datenbank-Verbindung je HTTP-Anfrage (Lasttest vp-lasttest Rang 13, Kundenpfade B1): vorher lieh jeder
 * Repository-Aufruf einer Anfrage eine eigene Verbindung aus dem Anfrage-Pool und setzte dabei die drei
 * Sitzungs-Variablen der Zeilen-Sicherheit ({@code app.tenant_id}, {@code app.zugriff}, {@code app.standort_ids})
 * und bei der Rückgabe wieder zurück - zwei {@code set_config} je Aufruf, zwei Drittel aller Anweisungen einer
 * Kundenseite.
 *
 * <p><b>Der Rahmen.</b> {@link TenantFilter} öffnet ihn mit {@link #beginn()} und schließt ihn im {@code finally}
 * mit {@link #ende()} - dieselbe Klammer wie {@link AnfrageZeitgrenze}. Darin leiht {@link TenantAwareDataSource}
 * beim ersten Bedarf EINE Verbindung aus dem Anfrage-Pool und gibt sie jedem weiteren Repository-Aufruf derselben
 * Anfrage als eigenen Griff: Der Griff verhält sich wie eine geliehene Verbindung ({@code close()} gibt ihn
 * zurück), die Verbindung selbst bleibt bis {@link #ende()} gebunden.
 *
 * <p><b>Die Variablen.</b> Beim ersten Griff werden sie immer gesetzt (nie dem Pool vertrauen), bei jedem weiteren
 * nur, wenn sich Mandant oder Zugriff seither geändert haben ({@code ZugriffFilter} nach dem Laden des Zugriffs,
 * ein Dienst, der im Anfrage-Faden den {@link TenantContext} umschaltet). {@link #ende()} setzt alle drei zurück
 * und gibt die Verbindung an den Pool; scheitert das Zurücksetzen, wird die physische Verbindung abgebrochen statt
 * zurückgegeben - eine Verbindung mit Mandant geht nie in den Pool.
 *
 * <p><b>Was gleich bleibt.</b> Autocommit wie bisher (keine Transaktion je Anfrage): jede Anweisung außerhalb einer
 * Spring-Transaktion wird sofort festgeschrieben, ein Fehler reißt keine späteren Abfragen der Anfrage mit. Braucht
 * die Anfrage eine ZWEITE Verbindung, während der Griff verliehen ist ({@code REQUIRES_NEW} in einer Transaktion,
 * ein offener Datenstrom), bekommt sie eine eigene - mit Setzen und Zurücksetzen wie zuvor. Andere Threads sehen den
 * Rahmen nie (er ist thread-lokal); sie arbeiten ohne {@link AnfrageZeitgrenze} auf dem Hintergrund-Pool.
 *
 * <p><b>Warten.</b> Wer im Anfrage-Faden auf etwas außerhalb der Datenbank wartet (Antwort einer Box, fremder
 * Dienst), ruft vorher {@link #freigeben()}: die Verbindung geht zurückgesetzt in den Pool, die nächste Abfrage
 * leiht sich wieder eine. Sonst hielte das Warten eine Verbindung des Anfrage-Pools fest.
 */
public final class AnfrageVerbindung {

    private static final Logger log = LoggerFactory.getLogger(AnfrageVerbindung.class);

    private static final ThreadLocal<Bindung> BINDUNG = new ThreadLocal<>();

    /**
     * Zustand, den Hikari bei der Rückgabe zurückstellt, ein Griff aber nicht: wer ihn ändert (oder sich die rohe
     * Verbindung holt), bekommt die Verbindung beim Schließen des Griffs nicht weiter gebunden, sondern über Hikari
     * zurückgestellt - die nächste Abfrage leiht frisch.
     */
    private static final Set<String> EIGENER_ZUSTAND = Set.of("setTransactionIsolation", "setCatalog", "setSchema",
            "setNetworkTimeout", "setHoldability", "setTypeMap", "setClientInfo", "unwrap");

    private AnfrageVerbindung() {
    }

    /** Öffnet den Rahmen einer Anfrage auf diesem Thread - noch ohne Verbindung. */
    static void beginn() {
        Bindung alt = BINDUNG.get();
        if (alt != null) {
            // Ein Rahmen ohne ende() (darf es nicht geben): nie erben, sondern abschließen.
            alt.schliessen();
        }
        BINDUNG.set(new Bindung());
    }

    /** Schließt den Rahmen: Variablen zurücksetzen, Verbindung zurück in den Pool. Wirft nie. */
    static void ende() {
        Bindung b = BINDUNG.get();
        BINDUNG.remove();
        if (b != null) {
            b.schliessen();
        }
    }

    /**
     * Gibt die gebundene Verbindung vorzeitig zurückgesetzt an den Pool, bevor dieser Thread lange auf etwas
     * außerhalb der Datenbank wartet. Ohne Rahmen, ohne Verbindung oder solange ein Griff verliehen ist (eine
     * laufende Transaktion hält ihn) tut es nichts.
     */
    public static void freigeben() {
        Bindung b = BINDUNG.get();
        if (b != null) {
            b.freigeben();
        }
    }

    static Bindung aktuelle() {
        return BINDUNG.get();
    }

    /** Die eine Verbindung einer Anfrage; nur vom eigenen Thread benutzt. */
    static final class Bindung {

        private TenantAwareDataSource eigner;
        private Connection physisch;
        /** Was auf {@link #physisch} gesetzt ist; {@code null} = unbekannt, beim nächsten Griff setzen. */
        private TenantAwareDataSource.Sitzung angewandt;
        private Griff verliehen;

        /**
         * Ein Griff auf die gebundene Verbindung mit den Variablen {@code soll}; {@code null}, wenn diese Bindung
         * gerade nicht dienen kann (ein Griff ist verliehen, eine andere Datenquelle) - dann leiht der Aufrufer
         * selbst.
         */
        Connection ausleihen(TenantAwareDataSource quelle, TenantAwareDataSource.Sitzung soll) throws SQLException {
            if (verliehen != null || eigner != null && eigner != quelle) {
                return null;
            }
            if (physisch != null && physisch.isClosed()) {
                // Hikari hat sie verworfen (abgerissene Verbindung): sie trägt nichts mehr, frisch leihen.
                loesen();
            }
            if (physisch == null) {
                physisch = quelle.zielVerbindung();
                eigner = quelle;
                angewandt = null;
            }
            if (!soll.equals(angewandt)) {
                angewandt = null;
                try {
                    soll.anwenden(physisch);
                } catch (SQLException | RuntimeException e) {
                    TenantAwareDataSource.zuruecksetzenUndSchliessen(loesen());
                    throw e;
                }
                angewandt = soll;
            }
            verliehen = new Griff(this, physisch);
            return verliehen.proxy();
        }

        /** Der Griff kam zurück: Transaktions-Reste abräumen wie Hikari, die Verbindung bleibt gebunden. */
        private void zurueck(Griff griff) {
            if (verliehen != griff) {
                return;
            }
            verliehen = null;
            try {
                if (physisch.isClosed()) {
                    loesen();
                    return;
                }
                if (!physisch.getAutoCommit()) {
                    physisch.rollback();
                    physisch.setAutoCommit(true);
                }
                if (physisch.isReadOnly()) {
                    physisch.setReadOnly(false);
                }
            } catch (SQLException | RuntimeException e) {
                log.warn("Anfrage-Verbindung nach Rückgabe nicht sauber, wird verworfen: {}", e.getMessage());
                TenantAwareDataSource.zuruecksetzenUndSchliessen(loesen());
                return;
            }
            if (griff.eigenerZustand) {
                freigeben();
            }
        }

        void freigeben() {
            if (verliehen == null) {
                TenantAwareDataSource.zuruecksetzenUndSchliessen(loesen());
            }
        }

        /** Ende der Anfrage: auch ein nie geschlossener Griff wird ungültig, die Verbindung geht zurück. */
        void schliessen() {
            try {
                if (verliehen != null) {
                    verliehen.geschlossen = true;
                    verliehen = null;
                }
                TenantAwareDataSource.zuruecksetzenUndSchliessen(loesen());
            } catch (RuntimeException e) {
                log.warn("Anfrage-Verbindung nicht abgeschlossen: {}", e.getMessage());
            }
        }

        private Connection loesen() {
            Connection p = physisch;
            physisch = null;
            angewandt = null;
            eigner = null;
            return p;
        }
    }

    /** Der Griff eines Repository-Aufrufs auf die gebundene Verbindung. */
    private static final class Griff implements InvocationHandler {

        private final Bindung bindung;
        private final Connection physisch;
        private boolean geschlossen;
        private boolean eigenerZustand;

        Griff(Bindung bindung, Connection physisch) {
            this.bindung = bindung;
            this.physisch = physisch;
        }

        Connection proxy() {
            return (Connection) Proxy.newProxyInstance(AnfrageVerbindung.class.getClassLoader(),
                    new Class<?>[] {Connection.class}, this);
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
            switch (method.getName()) {
                case "close":
                    if (!geschlossen) {
                        geschlossen = true;
                        bindung.zurueck(this);
                    }
                    return null;
                case "isClosed":
                    return geschlossen || physisch.isClosed();
                case "equals":
                    return proxy == args[0];
                case "hashCode":
                    return System.identityHashCode(proxy);
                case "toString":
                    return "Anfrage-Verbindung[" + (geschlossen ? "geschlossen" : physisch) + "]";
                default:
                    break;
            }
            if (geschlossen) {
                throw new SQLException("Die Verbindung ist geschlossen.", "08003");
            }
            if (EIGENER_ZUSTAND.contains(method.getName())) {
                eigenerZustand = true;
            }
            try {
                return method.invoke(physisch, args);
            } catch (InvocationTargetException ex) {
                throw ex.getCause();
            }
        }
    }
}
