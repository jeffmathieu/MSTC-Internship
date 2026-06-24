# Assen Race Simulator

This folder contains a small local timing server based on the Assen Belcar race
PDFs in `tests/race assen`.

It only simulates the Club Challenge class:

- car `38` BMW TEAM Van Der Horst
- car `33` MSTC, our car
- car `56` Offenga Racing
- car `36` BMW TEAM Van Der Horst
- car `4` 4OUR Racing by Roos Motorsport

## Run

```bash
node "tests/race-assen-simulator/server.js"
```

Open this URL in the app setup:

```text
http://localhost:5177
```

To make the race run slower or faster, pass the number of real seconds that
should represent one average lap of our car:

```bash
node "tests/race-assen-simulator/server.js" --lap-seconds 10
```

Useful options:

```bash
node "tests/race-assen-simulator/server.js" --port 5180 --lap-seconds 5
node "tests/race-assen-simulator/server.js" --paused
```

The web page also has buttons to pause, play, reset, and change the speed while
the server is running.

## How It Works

The simulator uses the real lap times from
`Belcar Endurance Championship - Race - laptimes.pdf`.

Each car gets an initial start offset from the start grid. The simulator assumes
the gap between grid positions is `0.5s` just after the start. After that, every
car's race position is calculated from cumulative lap time:

```text
start offset + lap 1 + lap 2 + lap 3 + ...
```

This matters because a car that is one lap behind must show `-- 1 lap --`,
instead of a misleading seconds gap to a car on a different lap.

The laptimes PDF does not say which driver drove each lap. Driver names are
therefore split evenly across the car's listed entrant names. Change
`driverNames` in `assen-club-challenge-data.json` if you later know the real
stints.

Sector times are simulated from each lap time with fixed split percentages in
`server.js`:

```js
const SECTOR_SPLITS = [0.34, 0.37, 0.29];
```

Change these percentages if you want the sector timing to look more realistic.
