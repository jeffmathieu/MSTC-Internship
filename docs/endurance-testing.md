# 24h-optimalisatie en offline testen

## Wat is veranderd?

- Het volledige JSONL-archief blijft behouden, ook boven 20.000 records en na een herstart. CSV is een afgeleide export; een CSV-fout veroorzaakt geen dubbele JSONL-ronde.
- Rondegegevens en statistieken worden per auto geïndexeerd en gecachet. Een nieuwe ronde maakt alleen de gegevens van de betrokken auto opnieuw ongeldig. Conditiefilters hergebruiken die indexen.
- Dashboardvensters ontvangen alleen hun eigen rondegegevens en relevante samenvattingen. Grafiekvensters ontvangen de relevante klasse. Volgende updates bevatten gewijzigde ronde-/highlight-suffixen, geen volledige historie.
- De lapbalk tekent alleen zichtbare regels plus een kleine buffer. Grafieken tekenen het zichtbare bereik met een begrensd aantal punten, met behoud van minima/maxima. Zoomen onthult de onderliggende details; het archief wordt niet uitgedund.
- PDF-berekeningen en Python-rendering lopen in één aparte worker tegelijk. Afgeleide snapshots worden asynchroon samengevoegd en atomair vervangen; kritieke ronde- en pit-eventlogs worden vóór publicatie weggeschreven. Ook PDF-bestanden worden pas na succesvolle generatie vervangen.
- Een stabiele `lapId` maakt handmatige correcties onafhankelijk van ontbrekende rondetellers. Identieke opeenvolgende rondetijden met verschillende expliciete rondetellers blijven bewaard.

## Timingherkenning en pitstops

De Zolder-kopie bevat een onbenoemde statuskolom, `PIT TIME`, `#PIT` en een wisselende `GAP`. De GAP-cellen kunnen onafhankelijk wisselen: één tabel kan tegelijk `-- 581 laps --` en `16.427` bevatten. De leider blijft rondes tonen.

De adapter herkent deze combinatie op basis van schema én inhoud, onthoudt tellers afzonderlijk en behandelt bevestigde tijdwaarden als intervallen naar de auto erboven. Rondetellers worden nooit tot gap-seconden omgerekend. Bij twijfel blijft een waarde onbekend. Tabellen met aparte LAPS/INT/DIFF blijven op hun bestaande route; gewone lapachterstanden zoals `1L` blijven behouden.

Fuel (`F` of ETA `Fuel`) en pit (`P` of `In pit`) krijgen afzonderlijke timers plus een totaal. Geen waargenomen fuel bij een volledig gevolgde stop betekent fuel `0:00`. Een gemiste observatie/restart tijdens een stop kan de tijd onbekend maken. Timers hebben de precisie van het ingestelde pollinterval, geen officiële meetlusprecisie.

`PIT TIME` is tijdens de stop een lopende klok. Alleen de waarneming na vertrek geldt als definitieve providerduur. Late duur-/counterupdates worden aan hetzelfde event gekoppeld. Driver change heeft drie waarden: yes, no, unknown.

Oude archieven worden alleen bij het lezen geïnterpreteerd: `raw.PIT TIME` kan alsnog worden benut. Ontbrekende exacte fueltijden zijn niet betrouwbaar te reconstrueren uit een log met uitsluitend rondepassages. Ontbrekende officiële rondegetallen worden als **waargenomen rondevolgorde** weergegeven (`~` / “observed laps”), niet als verzonnen officiële racelaps. Bestaande, verkeerd berekende cumulatieve gaps uit de bewezen wisselkolom worden uit nieuwe rapporten geweerd.

## Zelf testen met de racekopie

Voer vanuit de projectmap uit, met de projectafhankelijkheden geïnstalleerd:

```sh
npm run replay -- "race kopie"
```

Dit opent het echte dashboard met alle 12.568 records uit de kopie. De bronmap, normale appinstellingen en bestaande PDF's blijven ongewijzigd. Er wordt geen timingwebsite geopend. Afgeleide bestanden/proefrapporten gaan naar een nieuwe tijdelijke map, waarvan het pad in de terminal staat.

- Scroll direct naar oude rondes, ook terwijl het dashboard iedere 5 seconden ververst.
- Open de grafieken; zoom, verschuif het bereik en wissel grafiektype en conditiefilter.
- Stop pauzeert de herhaalde updates; Start hervat ze. Deze teststand verzint geen extra historische rondes en reconstrueert geen fuel-overgangen tussen ontbrekende polls.
- De exportknop in de bovenbalk maakt een proef-PDF in de tijdelijke map. Handmatige rondewijzigingen zijn in deze alleen-lezen teststand uitgeschakeld.
- Test dit op de teamlaptop met dezelfde vensters, schermgrootte en overige programma's die tijdens de race gebruikt worden. Laat dit bijvoorbeeld een uur draaien; let op responsiviteit én oplopend geheugen.

## Geautomatiseerde controles

```sh
npm test
npm run test:24h
npm run test:ui
npm run replay -- "race kopie" --smoke
```

`test:24h` simuleert 45 auto's, 17.281 pollmomenten en 31.095 opgeslagen rondes. Opslag en timers lopen op alle pollmomenten; de eerste fase controleert afgeleide analytics elk uur. Vervolgens worden 120 opeenvolgende volledige live updates uitgevoerd tegen het volle archief, met twee nieuwe autorondes per poll. Herstart, historische correcties, IPC-patches en grafiekdatasets worden eveneens getest. Dit is een versnelde data-/belastingtest, **geen 24 uur durende wall-clock- of hardwaregarantie**.

Gemeten op deze ontwikkelmachine (september/oktober 2026; indicatief):

| Controle | Resultaat |
| --- | --- |
| Echte racekopie | 12.568 records, 38 auto's met opgeslagen rondes; wisselkolom herkend |
| Echte kopie: herhaalde berekening / scroll | circa 20 ms / 2,5–18 ms over meerdere runs; 20 getekende regels onderaan |
| Synthetische 24h-UI: scroll / zoom | circa 5 ms / 8 ms |
| Dashboardupdate zonder nieuwe ronde | maximaal circa 67 kB per venster |
| Vol archief + nieuwe rondes, 120 updates | mediaan 208 ms; 95e percentiel 280 ms; maximum 1,61 s inclusief koude herstart |
| Vertraagde LAST-correctie in volledig 24h-archief | 712 ms; dezelfde passage behouden en correct herladen |
| Proef-PDF uit echte kopie | 16 pagina's, 8 driverstints, 18 geregistreerde stopnummers; ontbrekende gegevens expliciet onbekend |

De laatste bugcontrole was gericht op deze datastroom: wisselkolommen, ontbrekende/late pitgegevens, driverwissels, herstart/deduplicatie, handmatige correcties, IPC en grafiekresponsiviteit. Dit is geen claim dat alle mogelijke bugs in de gehele app zijn uitgesloten.

## Fuel estimates and net driver time

Fuel estimation, calibration and refuel advice are temporarily disabled. Their
UI markup is commented out, and saved configuration is retained for future
reimplementation. Observed fuel/pit service timers and report columns remain
active; a stop's observed total is fuel time plus pit time.

Live driver stint time and driver totals now use net driving time: observed fuel
and pit/garage intervals are excluded, including long stops without a driver
change. PDF driver metrics use the same calculation. Older lap-only archives use
approximate service windows and are labelled estimated; they cannot recover an
unrecorded exact pit entry/exit or certify regulatory driving-time compliance.

Regression coverage: `fuelAndDriving.test.js`, `fuelStorage.test.js`, and the
offline replay `--smoke` check (real Electron pit setup and top-bar export UI).

## TODO implementation verification (October 2026)

The top bar now exposes session export beside compact Start/Stop controls.
CSV text that could be interpreted as a spreadsheet formula is prefixed with an
apostrophe, including leading whitespace/control characters. Numeric time and
counter fields retain their numeric representation.

All dashboard windows use sandboxed preloads; remote timing pages cannot open
popups, request permissions or navigate away from their timing origin (an HTTP
to HTTPS upgrade on the same host is allowed). Privileged IPC requires a known
local dashboard/graph window's main frame. Live-provider redirect compatibility
still needs checking on the supported sites.

`test:ui` exercises the extraction script in actual Chromium, replacing header
rows between polls and distinguishing empty, hidden obsolete and populated tables.
It also generates PDFs with both ReportLab and the built-in Electron renderer.
Installed applications select the Electron engine, so PDF export needs no Python
installation. Both reports include timing caveats, team/class comparisons,
engineering insights and analysis graph appendices. Packaged Windows/macOS
installation verification remains a separate follow-up.

Race-control transitions are journalled independently of lap passages. Counts
and durations reflect observed transitions at polling precision; outages cannot
supply flag changes that were never observed. The finish countdown is advisory:
automatic stopping waits for every followed class, including slower classes.

`test:24h` now also times a delayed-LAST correction that replaces the passage
without adding a lap and confirms it survives reloading the complete archive.
