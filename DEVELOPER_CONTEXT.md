# Developer Context & Architectural Guide

## 1. High-Level Architecture & Intent

*   **Core Purpose:** This project is a **transistor-level simulator** of the MOS 6502 (and 6800) microprocessor. It visualizes the physical state of the chip during operation by modeling the electrical behavior of the actual netlist extracted from die photography. It is designed to run in a web browser.
*   **Tech Stack:**
    *   **Languages:** JavaScript (ES5/ES6 hybrid), HTML5, CSS.
    *   **Rendering:** HTML5 Canvas API (primary), WebGPU (experimental/modern renderer).
    *   **Build System:** Node.js environment using `esbuild` for bundling and minification.
    *   **Dependencies:** Minimal runtime dependencies. Uses jQuery (older version) for UI splitting.
*   **Design Patterns:**
    *   **Simulation Loop:** A cyclic executive loop (`step`, `halfStep`) driven by `setTimeout` or user interaction.
    *   **Global State:** Heavy reliance on global variables (`nodes`, `transistors`) reflecting the hardware state, typical of older JS applications and performance-critical simulations.
    *   **Data-Driven:** Chip topology is defined in large static data arrays (`segdefs.js`, `transdefs.js`, `nodenames.js`) which are loaded at runtime.
    *   **Event-Driven:** UI interactions trigger state changes directly in the simulation engine.

## 2. Feature Map (The "General Points")

*   **Core Simulation Engine:**
    *   **Entry Point:** `chipsim.js` -> `recalcNodeList()`
    *   **Description:** Simulates the electrical state of nodes and transistors. It resolves pull-ups, pull-downs, and pass transistors iteratively.
*   **Chip Visualization:**
    *   **Entry Point:** `expert.html` (UI), `expert-allinone.js` / `expertWires.js`.
    *   **Description:** Renders the chip layers (metal, polysilicon, diffusion) and overlays active signals on an HTML5 Canvas.
*   **Simulation Control:**
    *   **Entry Point:** `macros.js` -> `go()`, `step()`, `stopChip()`.
    *   **Description:** Controls the clock cycles, handles breakpoints, and manages the run loop.
*   **Program Loading & Memory:**
    *   **Entry Point:** `macros.js` -> `loadProgram()`, `memtable.js`.
    *   **Description:** Simulates the system RAM connected to the CPU and allows users to load binary code.
*   **Tracing & Inspection:**
    *   **Entry Point:** `macros.js` -> `chipStatus()`, `updateLogBox()`.
    *   **Description:** Logs the state of busses (Address, Data) and internal registers per cycle.

## 3. Complexity Hotspots (The "Complex Parts")

*   **Node State Propagation (`recalcNodeList` in `chipsim.js`):**
    *   **Why:** This function iteratively resolves the electrical state of thousands of connected nodes. It handles the bi-directional nature of pass transistors and resolves conflicts between pull-ups/downs. It has a loop limiter to prevent infinite oscillations in the simulated circuit.
    *   **Agent Note:** **Do not modify the physics logic here** unless you deeply understand transistor-level modeling. Changing how `recalclist` or `group` are processed can break the simulation's accuracy against the real hardware. Watch out for infinite loops if logic gates form ring oscillators.
*   **Data Loading & Indexing (`segdefs.js`, `transdefs.js`, `nodenames.js`):**
    *   **Why:** The simulation relies on massive arrays defining the chip. These files are generated from physical reverse engineering. Node numbers are keys, and their mapping to human-readable names (`nodenames.js`) is critical.
    *   **Agent Note:** Ensure that any changes to signal names in logic are reflected in `nodenames.js`. Mismatches here will cause "undefined node" errors during simulation.
*   **Global State Management:**
    *   **Why:** Variables like `nodes`, `transistors`, `ngnd`, `npwr` are global.
    *   **Agent Note:** Be extremely wary of variable shadowing. Assume the global namespace is crowded. Do not reuse common names like `nodes` or `ctx` in global scope.

## 4. Inherent Limitations & "Here be Dragons"

*   **Performance:** The simulation operates at the transistor level in JavaScript. It is computationally expensive. Running "fast" (`goFor()`) blocks the UI thread in chunks.
*   **Legacy Codebase:** The project uses older JavaScript conventions (var, heavy globals, no modules).
    *   **Dragon:** Attempting to "modernize" the code by wrapping it all in modules/classes without understanding the global dependency chain will likely break the application.
*   **Browser Compatibility:** `detectOldBrowser` checks for IE, indicating legacy support requirements.
*   **Hard Constraints:**
    *   **Node Numbers:** The integer IDs for nodes are tied to the physical layout extraction. They cannot be renumbered without regenerating all data files (`segdefs`, `transdefs`, `nodenames`).
    *   **Simulation Step:** `halfStep()` represents one clock phase (Phi1 or Phi2). A full CPU cycle requires two calls.

## 5. Dependency Graph & Key Flows

**Critical User Action: Running a Simulation**

1.  **Initialization:**
    *   `expert.html` loads -> `setup()`
    *   `setupNodes()` (parses `segdefs`) -> `setupTransistors()` (parses `transdefs`)
    *   `initChip()` (resets state, sets power/ground)
    *   `loadProgram()` (loads binary into `memory` array)

2.  **Simulation Loop:**
    *   `go()` (starts loop) -> `step()`
    *   `step()` calls `halfStep()` twice (Phi1, Phi2)
    *   `halfStep()` -> `setLow('clk0')` / `setHigh('clk0')` -> `recalcNodeList()` (Physics Engine)
    *   `recalcNodeList()` iterates until stable state.

3.  **Visualization Update:**
    *   `step()` -> `refresh()`
    *   `refresh()` -> Clears Canvas -> Iterates `nodes` -> `overlayNode()` (Draws active nodes).
    *   `chipStatus()` -> Updates DOM elements (register values, trace log).
