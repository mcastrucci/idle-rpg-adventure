# Region 2 authored content checkpoint

> **Provisional content draft.** This records the implementation IDs and first-pass numbers for the Region 2
> proposal. The names, theme, topology, encounter design, rewards, and numeric values need owner/design review.
> Content compilation confirms schema and reference validity; it does not establish balance, playability, or final art.

The content implements `area:region_2`, the six proposed locations, and
`route:sanctuary_to_region_2` with the existing per-character
`requires.areaCompleted: area:region_1` predicate. Four `ordinary` locations form the completion pool with a
70% threshold (three of four) and `enemy:region_2.resonant_warden` as the required victory. The landing and core are
outside the pool; the archive is both safe and ordinary. Its safe tag supports returning through existing navigation;
it does not restore HP. The Warden encounter is excluded from the hunt and survey tables.

Stable combat and activity IDs are:

| Content | IDs |
|---|---|
| Ordinary enemies | `enemy:region_2.glass_echo`, `enemy:region_2.prism_guard` |
| Boss | `enemy:region_2.resonant_warden` |
| Combat skills | `skill:region_2.prism_slam`, `skill:region_2.signal_pulse`; Warden also reuses `skill:bramble_lash` |
| Ordinary location tables | `enc:region_2.shallows`, `enc:region_2.prism_span`, `enc:region_2.resonance_court` |
| Boss / idle tables | `enc:region_2.warden`, `enc:region_2.hunt`, `enc:region_2.survey` |
| Activities | `idle:region_2.gather`, `idle:region_2.hunt` (gather displays as survey and uses the survey encounter table) |
| Rewards | `item:prism_dust`, `item:warden_signal`, `item:choirglass_blade`, `item:resonance_buckler` |

The provisional stats are a playtest hypothesis: Glass Echo 76 HP / 12 power, Prism Guard 116 HP / 15 power, and
Resonant Warden 520 HP / 26 power, with the other defense values in the content files. Warden power 26 is selected
provisionally for the next playtest after the corrected cohort-policy comparison: the seed-24/N=1000 rows show fresh L4
resource/HP pressure and measurable preparation margin in tick duration and remaining HP, but every sampled fresh and
prepared build/mode still wins. This is a playtest hypothesis, not a final balance decision, an acceptance threshold,
or evidence that issue #55 is complete. The Warden alternates its
eight-tick telegraphed `signal_pulse` with basic attacks and the existing `bramble_lash`; the latter applies the DoT
that gives Thornblade's `second_wind` and the carried sap tonic a use. The two R2-only enemy telegraphs use an
eight-tick windup so a hero on the usual six-tick action interval can observe and answer them; this still needs
verification in real encounter traces. Warden loot awards one weighted choice (blade or buckler) and one guaranteed
signal trophy. Repeatable encounter tables can award prism dust and the existing sap tonic; no crafting recipe or
material upgrade is implied.

`item:prism_dust` has an item `value` of 5 as a reference field, but the current POC does not expose an item-sale
command. Do not count dust as gold realized from a sale or promise a sell loop; encounter gold is awarded separately
through the explicit gold ranges on the enemy loot tables.

The balance simulator's R2-only six-rule boss automation keeps guard first, then uses a sap tonic on a harmful effect,
a full healing potion below 55% HP, and a minor potion below 40% HP before attacks. Bulwark uses Mend below 55% HP
in place of the lower-priority shield-bash offense rule, preserving its equipped healing skill while retaining the
basic-attack fallback. This deliberately spends one offense slot on boss sustain; the Region 1 reference rules remain
unchanged. Thornblade's automation uses a tonic on harmful effects while its equipped `second_wind` remains available
to the scripted-live policy. Here “scripted live” means the automation stays enabled while the attentive script adds
guard/cleanse inputs; it is not an estimate of optimal or manual player performance. Common-fight policies use healing
potions when carried but do not spend tonics because the authored ordinary enemies do not apply harmful effects.
Bulwark's common policy trades Mend for the healing-potion rule, and Thornblade's common policy drops Rend to make
room for it. Zero-stock items do not trigger a rule. These are explicit cohort policies, not changes to Region 1
reference rules or player progression decisions.

`pnpm content:validate` succeeds with content hash
`c9531ec6b68c0c6c3213c3d07ce39a68767c92c931a11986b6e1f51a295488f3`. The seed-24/N=1000 authored-baseline
measurements with power 26 and the corrected Bulwark boss policy are recorded in
[`balance/region-2-measurements.md`](balance/region-2-measurements.md). The same power-26 configuration was previously
measured in memory from source hash `e3364b603015cc5b973bdbf007822be4eeed28b3d849c9e9b2a15b629d51fac6`; that
candidate never had a separately compiled hash. Power 26 is a provisional playtest hypothesis, not a final stat,
approved target band, region-clear result, or issue #55 completion. Earlier in-memory power-27/29 probes used a
Bulwark boss policy that omitted Mend; they are superseded.
