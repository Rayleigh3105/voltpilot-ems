-- Einstellungen Scheibe 2 (B12, §4.12): "E-Mail-Weg entfernen" braucht ein echtes DELETE fuer die
-- App-Rolle - bisher durfte sie den Zustellweg nur anlegen/aendern (SELECT, INSERT, UPDATE), nie
-- loeschen. Dieselbe Rolle braucht das DELETE auch fuer B13 (eine entfernte Person loescht ihre
-- eigenen Wege mit).
GRANT DELETE ON zustellweg TO ${appDbUser};
