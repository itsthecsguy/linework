# README hero

`hero-light.png` and `hero-dark.png` are stills of a [stageshow](https://github.com/benjitaylor/skills) scene. The diagram in them is `hero.yaml`, built with `aiviz` in the `clean` and `dark` styles.

To film them again:

1. Install stageshow: `npx skills add benjitaylor/skills --skill stageshow`, then `npm install` in its folder.
2. Copy `stageshow/` to `examples/aiviz-hero/` in the stageshow folder, with the two diagram PNGs as `diagram-light.png` and `diagram-dark.png` and the IBM Plex woff2 files from `assets/fonts`.
3. Start its playground and run `node scripts/film.mjs "<url>/?capture=aiviz-hero" --still --gate --pad 0 --out hero-light.png`. Add `--dark` for the dark one.
