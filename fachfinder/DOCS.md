# Fachfinder

Virtuelle Sortierkästen mit 3D-Ansicht. Nach dem Start erscheint **Fachfinder** in der Seitenleiste. Login und HTTPS übernimmt Home Assistant.

## Erste Schritte
1. Links mit **+ Bereich** einen Raum anlegen, z. B. „Werkstatt“, und darunter z. B. „Wand links“.
2. Mit **+ Kasten** einen Sortierkasten anlegen: Name, Bauform (liegend/stehend), Zeilen, Spalten und Maße.
3. Ein Fach anklicken und eintragen, was drin liegt. Über den Pfeil ▸ am Teil vergibst du Labels, Links und technische Daten.
4. Oben suchen. Mit „Alle Treffer zeigen“ leuchten alle passenden Fächer in 3D.

Zum Ausprobieren gibt es bei leerer Datenbank rechts den Button **Beispieldaten laden**.

## Daten
- Die Daten liegen in `/data/fachfinder.db` und sind **automatisch Teil der HA-Backups**.
- Oben rechts gibt es **Export** und **Import** (JSON). Vor jedem Import wird eine Sicherung angelegt (die 5 neuesten bleiben erhalten).

## Sprachsuche
Den internen Hostnamen der App findest du oben auf der Info-Seite der App (z. B. `xxxxxxxx-fachfinder`). Die Vorlage für `rest_command` und Automation steht in der README des Repositories.

## Direktzugriff
Optional kannst du unter *Netzwerk* Port 8099 freigeben, z. B. für QR-Code-Links wie `#box=3&cell=12` oder `#tag=5`. Dann ist Fachfinder **ohne Login** erreichbar, also nur im Heimnetz nutzen.
