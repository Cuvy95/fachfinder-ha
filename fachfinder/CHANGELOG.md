# Changelog

## 1.2.0
- **2D-Draufsicht**: Mit dem Knopf „2D“ oben rechts wechselst du zwischen 3D und einer flachen Draufsicht. Bestücken, Trenner, Mehrfachauswahl und Suche funktionieren dort genauso. Die Wahl wird gemerkt
- **Beschriftungsschild oben oder unten** pro Kasten einstellbar (Standard: unten/vorne), in 2D und 3D einheitlich
- **📐 Exakt anpassen**: Optionaler Wand-Editor für Kästen mit unterschiedlich großen Fächern. Wände ziehen (ganze Linie oder nur ein Stück), Fächer teilen, Wände entfernen, Aussparungen setzen, Lage in mm eingeben, Rückgängig
- **Foto als Vorlage** im Wand-Editor, um die Wände direkt auf dem echten Kasten nachzuziehen
- Spalten und Zeilen können unterschiedlich breit bzw. hoch sein, die 3D-Ansicht zeigt die echten Proportionen
- Fachnamen bei exakt angepassten Kästen werden pro Reihe fortlaufend nummeriert
- Einfache Kästen funktionieren wie bisher über Zeilen und Spalten

- **Aussparungen**: Zellen als „kein Fach“ markieren (z. B. Griffmulde, abgeschrägte Ecke). Sie werden in 3D ohne Boden und Wände gezeigt und tauchen in der Suche nicht auf
- **Fachname nur noch für Sammelfächer**: Bei einem Fach mit einem Teil reicht der Inhalt, das Namensfeld ist eingeklappt
- **Aufräumen**: Fächer mit Name, aber ohne Inhalt bekommen den Namen als Inhalt; doppelte Namen (Fach = Teil) werden entfernt
- **Import-Button** öffnet die Dateiauswahl in allen Browsern; Oberflächen-Dateien werden nach Updates nicht mehr aus dem Browser-Cache gemischt
- **Suche ohne Doppeltreffer**: Ein Fach erscheint nur einmal, auch wenn Fachname und Inhalt passen. Fächer, die nur über ihren Namen passen, leuchten jetzt auch in der 3D-Trefferansicht

## 1.1.0
- **Labels** mit Oberbegriffen und Synonymen, z. B. findet „Spannungsversorgung“ auch alles mit „Step-Down“
- **3D-Trefferansicht**: Alle Kästen mit Treffern nebeneinander, Treffer leuchten, der Rest ist abgedunkelt
- **Import** einer Exportdatei, vorher wird automatisch eine Sicherung angelegt
- Suche ignoriert Sonderzeichen („dcdc“ findet „DC/DC“)
- Hinweis, wenn Oberfläche und Server nicht zur selben Version gehören

## 1.0.0
- Erste Version: Bereiche und Kästen als Baum, 3D-Ansicht, verbindbare Fächer
- Trenner pro Fach, Beschriftungsschild vorne am Fach
- Links (Datenblatt, Shop, Konfiguration) und technische Daten pro Teil
- Such-API für die Sprachsuche mit Assist
