# Data sources and limits

## What is real

The NASA IMS bearing dataset is a set of three run-to-failure experiments on four bearings each, recorded by accelerometers at 20 kHz, run at constant speed and load until a bearing failed.

- Authors and citation: J. Lee, H. Qiu, G. Yu, J. Lin, Rexnord Technical Services (2007). IMS, University of Cincinnati. "Bearing Data Set", NASA Prognostics Data Repository, NASA Ames Research Center.
- Used here: the RMS vibration feature per snapshot, from `data/processed/test{1,2,3}_raw.csv` in https://github.com/fatemeh-studio/nasa-bearing-anomaly (MIT licence, Fatemeh Saghian, 2026).
- Failed bearings used: Set 1 bearing 3 (inner race), Set 1 bearing 4 (roller element), Set 2 bearing 1 (outer race), Set 3 bearing 3 (outer race). Trailing records captured after shutdown are trimmed.
- Healthy bearings used for noise: Set 1 bearings 1 and 2, Set 2 bearings 2 to 4, Set 3 bearings 1 and 2, first 60% of each run.

## How it is used

1. Each failed bearing gives the ratio of its RMS to its own healthy baseline over its last 168 hours.
2. In the replay plant, a bearing-wear fault multiplies that asset's vibration by this measured ratio (capped at 6x) across the fault window. Windows of 144 to 216 hours are time-stretched from the 168 hour curve.
3. Every asset's vibration is also multiplied by real healthy-bearing noise from the dataset.

## Reference physics

The agent tool `reference_bearing_frequencies` computes outer race, inner race, roller spin and cage frequencies from the Rexnord ZA-2115 geometry published in Qiu, Lee, Lin and Yu (2006), J. Sound and Vibration 289, at 2,000 rpm (about 236.4, 296.9, 139.9 and 14.8 Hz). The geometry is also recorded in the data repository's configuration. It is a reference for the IMS rig and is not applied to other assets.

## What is still simulated

- The plant: lines, shifts, load, start-ups, ambient heat, planned maintenance windows.
- Temperature, which the IMS data does not include. It follows vibration through a simulated coupling for bearing faults.
- Misalignment, lubrication starvation and rotor imbalance faults.
- Part stock, part numbers, repair hours and steps, the technician roster and CMMS history.
- The numeric failure signatures per mode.

## Knowledge base references

- NASA Kennedy Space Center, Preferred Practices, Technique AT-8, Vibration Analysis of Rotating Ground Support Machinery, pp. AT-47 to AT-50: https://extapps.ksc.nasa.gov/Reliability/Documents/Preferred_Practices/at8.pdf
- M. Woodard and M. Wolka (NSK), Bearing Maintenance Practices to Ensure Maximum Life, 27th International Pump Users Symposium, Texas A&M Turbomachinery Laboratory, 2011, pp. 80 to 96: https://oaktrust.library.tamu.edu/bitstream/1969.1/162611/1/Bearing%20Maintenance%20Practices%20to%20Ensure%20Maximum%20Life.pdf

Excerpts in the app are short paraphrases with page numbers. They support symptoms and remedies only.

## Why this matters for claims

Do not say the product was validated on real plant data. Say that bearing degradation signatures and sensor noise in the replay come from a public NASA run-to-failure dataset, and that the shadow-mode pilot and Alert Audit are how plant data and confirmed outcomes will be collected.
