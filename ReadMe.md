# Visual6502 JavaScript Simulator

The source in this repository powers the transistor-level 6502/6800 simulation from http://visual6502.org/JSSim. The code now ships as an npm-aware project that produces a single `<dist>/visual6502.js` suitable for embedding in a browser.

## Production build

1. `npm install`  # installs `esbuild` which is used for bundling
1. `npm run build` # concatenates every simulator file and minifies it into `dist/visual6502.js`
1. Serve an HTML page that loads `dist/visual6502.js` and provides the expected DOM Canvas/hooks.

> Only the production `dist/visual6502.js` bundle is published; individual script files are used only during the build step.

## Development notes

- The runtime exposes new `performanceMonitor` helpers that track swept nodes, transistor switches, and throughput for `bytes processed`. The bundle still depends on the legacy globals (`nodenames`, `nodes`, etc.) to stay compatible with `expert.html`.
- `macros.js` now aggregates log presets, the performance monitor, and byte counting. `chipsim.js` records node sweeps and transistor switches so the monitor can report workload without changing the main loop.
- Use `npm run lint` once ESLint is configured (not bundled yet) to keep the workspace clean.

This is the JavaScript simulator from the visual6502.org project:
www.visual6502.org/JSSim

It includes a general purpose transistor-level simulator, layout browser,
and the data from a 6502 revD chip. 

It also includes a similar simulator for the 6800 chip.

Note the various licenses and Copyright associated with each file.

Enjoy!
- The Visual 6502 Team
